import { describe, expect, it } from 'vitest';
import { staleRevision, type Task, type TaskComment } from './board';

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
