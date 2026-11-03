/**
 * Статус агента на доске — значок у имени токена: следит за доской, работает над задачей, ждёт или нужна помощь.
 * Явный статус живёт на доске 5 минут, поэтому подтверждаем его раньше. Сбои отметки работе не мешают.
 */
import { BoardError, type AgentStatus, type Board, type Task, type TaskStatus } from './board';

/** Подтверждать статус раньше, чем он истечёт на доске. */
const HEARTBEAT_MS = 4 * 60_000;

export class Presence {
  private readonly board: Board;
  private readonly log: (line: string) => void;
  private current?: AgentStatus;
  private timer?: NodeJS.Timeout;
  private failing = false;

  constructor(board: Board, log: (line: string) => void) {
    this.board = board;
    this.log = log;
  }

  /** Новый статус уходит на доску сразу (если поменялся) и дальше подтверждается сам. */
  async set(s: AgentStatus): Promise<void> {
    if (this.current && same(this.current, s) && !this.failing) return;
    this.current = s;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.send(), HEARTBEAT_MS);
    await this.send();
  }

  /** Монитор остановлен — убрать значок с доски. */
  async clear(): Promise<void> {
    clearInterval(this.timer);
    this.current = undefined;
    await this.board.clearAgentStatus().catch((e) => this.log(`Не удалось убрать статус агента с доски: ${text(e)}`));
  }

  private async send(): Promise<void> {
    const s = this.current;
    if (!s) return;
    try {
      try {
        await this.board.setAgentStatus(s);
      } catch (e) {
        // Задачу удалили или перенесли на другую доску — статус без неё (working без задачи не бывает).
        if (!(e instanceof BoardError && e.status === 404 && s.taskId)) throw e;
        this.current = { status: s.status === 'working' ? 'monitoring' : s.status };
        await this.board.setAgentStatus(this.current);
      }
      if (this.failing) this.log('Статус агента на доске снова обновляется.');
      this.failing = false;
    } catch (e) {
      if (!this.failing) this.log(`Не удалось обновить статус агента на доске: ${text(e)}`);
      this.failing = true;
    }
  }
}

/**
 * Статус свободного монитора. Важнее всего задача, где агенту нужен ответ человека (задал вопросы или не справился,
 * а задача так и ждёт в «Нужно проверить»), потом — задача, ждущая повторной попытки; иначе он просто следит за доской.
 */
export function idleStatus(tasks: Task[], attention: string[], retrying: string[], queue: TaskStatus[]): AgentStatus {
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  const asked = attention.find((id) => status.get(id) === 'review');
  if (asked) return { status: 'blocked', taskId: asked };
  const retry = retrying.find((id) => queue.some((s) => s === status.get(id)));
  if (retry) return { status: 'waiting', taskId: retry };
  return { status: 'monitoring' };
}

function same(a: AgentStatus, b: AgentStatus): boolean {
  return a.status === b.status && a.taskId === b.taskId;
}

function text(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
