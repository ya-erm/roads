import { describe, expect, it } from 'vitest';
import type { Task, TaskStatus } from './board';
import { idleStatus } from './presence';

const QUEUE: TaskStatus[] = ['revision', 'todo'];
const task = (id: string, status: TaskStatus): Task => ({ id, status, revision: 1 });

describe('статус свободного монитора', () => {
  it('нечего делать — следит за доской', () => {
    expect(idleStatus([task('a', 'review')], [], [], QUEUE)).toEqual({ status: 'monitoring' });
  });

  it('ждёт ответа по задаче, пока она в «Нужно проверить»', () => {
    expect(idleStatus([task('a', 'review')], ['a'], [], QUEUE)).toEqual({ status: 'blocked', taskId: 'a' });
    // Человек вернул её в работу, проверил или удалил — ответа агент уже не ждёт.
    expect(idleStatus([task('a', 'revision')], ['a'], [], QUEUE)).toEqual({ status: 'monitoring' });
    expect(idleStatus([task('a', 'verified')], ['a'], [], QUEUE)).toEqual({ status: 'monitoring' });
    expect(idleStatus([], ['a'], [], QUEUE)).toEqual({ status: 'monitoring' });
  });

  it('ждёт повторной попытки по задаче, которая снова в очереди', () => {
    expect(idleStatus([task('b', 'todo')], [], ['b'], QUEUE)).toEqual({ status: 'waiting', taskId: 'b' });
    expect(idleStatus([task('b', 'draft')], [], ['b'], QUEUE)).toEqual({ status: 'monitoring' });
  });

  it('нужен ответ человека — важнее повторной попытки', () => {
    expect(idleStatus([task('a', 'review'), task('b', 'todo')], ['a'], ['b'], QUEUE)).toEqual({ status: 'blocked', taskId: 'a' });
  });
});
