import { describe, expect, it } from 'vitest';
import { awaitsOwner, staleRevision, type Task, type TaskComment, type TaskStatus } from './board';

const mine = (c: TaskComment) => !!c.sourceKey?.startsWith('task-agent:');
const report = (at: string): TaskComment => ({ documentId: `d-${at}`, sourceKey: `task-agent:t:result:${at}`, createdAt: at });
const human = (at: string): TaskComment => ({ documentId: `h-${at}`, author: 'Человек', createdAt: at });
const card = (comments: TaskComment[], revisionAt: string[]): Task => ({
  id: 't',
  status: 'revision',
  revision: 7,
  comments,
  history: revisionAt.map((at) => ({ at, from: 'review', to: 'revision' })),
});

describe('доработка, по которой нового нет', () => {
  it('вернули в «Доработать», пока агент работал, и после отчёта ничего не написали — не брать', () => {
    expect(staleRevision(card([human('2026-11-04T17:44:00Z'), report('2026-11-04T18:24:55Z')], ['2026-11-04T17:46:12Z']), mine)).toBe(true);
  });

  it('замечание после отчёта или новый возврат после отчёта — брать', () => {
    expect(staleRevision(card([report('2026-11-04T18:24:55Z'), human('2026-11-04T18:30:00Z')], ['2026-11-04T17:46:12Z']), mine)).toBe(false);
    expect(staleRevision(card([report('2026-11-04T18:24:55Z')], ['2026-11-04T17:46:12Z', '2026-11-04T18:40:00Z']), mine)).toBe(false);
  });

  it('отчётов агента ещё не было — брать', () => {
    expect(staleRevision(card([human('2026-11-04T17:44:00Z')], ['2026-11-04T17:46:12Z']), mine)).toBe(false);
  });
});

describe('публичный баг-репорт ждёт владельца', () => {
  const QUEUE: TaskStatus[] = ['revision', 'todo'];
  const AGENT = 'Claude Code';
  const pub = (history: Task['history']): Task => ({ id: 'p', status: 'todo', revision: 1, publicSubmission: true, history });

  it('гость прислал — в работу не берём', () => {
    expect(awaitsOwner(pub([{ at: '1', actor: 'Гость: Вася', to: 'todo' }]), QUEUE, AGENT)).toBe(true);
    expect(awaitsOwner(pub([{ at: '1', actor: 'Гость', to: 'todo' }]), QUEUE, AGENT)).toBe(true);
    expect(awaitsOwner(pub([{ at: '1', to: 'todo' }]), QUEUE, AGENT)).toBe(true);
    expect(awaitsOwner(pub(undefined), QUEUE, AGENT)).toBe(true);
  });

  it('сам агент вернул в очередь — это не одобрение', () => {
    const h = [
      { at: '1', actor: 'Гость', to: 'todo' as const },
      { at: '2', actor: AGENT, from: 'todo' as const, to: 'in_progress' as const },
      { at: '3', actor: AGENT, from: 'in_progress' as const, to: 'todo' as const },
    ];
    expect(awaitsOwner(pub(h), QUEUE, AGENT)).toBe(true);
  });

  it('участник доски перевёл в очередь — берём', () => {
    const h = [
      { at: '1', actor: 'Гость: Вася', to: 'todo' as const },
      { at: '2', actor: 'Владелец', from: 'todo' as const, to: 'draft' as const },
      { at: '3', actor: 'Владелец', from: 'draft' as const, to: 'todo' as const },
    ];
    expect(awaitsOwner(pub(h), QUEUE, AGENT)).toBe(false);
    // Имя участника, начинающееся на «Гость…» другим словом, гостем не считается.
    expect(awaitsOwner(pub([{ at: '1', actor: 'Гостомысл', to: 'todo' }]), QUEUE, AGENT)).toBe(false);
  });

  it('обычные задачи — как раньше', () => {
    expect(awaitsOwner({ id: 'n', status: 'todo', revision: 1, history: [{ at: '1', to: 'todo' }] }, QUEUE, AGENT)).toBe(false);
  });
});
