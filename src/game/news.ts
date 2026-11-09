/**
 * История событий — уведомления партии, которые стоит перечитать: стройка закончена, завод вырос, город растёт,
 * задание выполнено, экономическое событие. Всплывающие плашки живут 6 секунд, а в конце месяца их приходит
 * сразу много — здесь они остаются на NEWS_MONTHS месяцев (окно «События» по кнопке с колокольчиком).
 *
 * Пишутся только уведомления с видом (kind): подсказки на действия игрока («Не хватает денег», «Игра сохранена»)
 * в историю не попадают. Ссылки (refs) — на что перейти из записи: предприятие, город, станция, маршрут,
 * проект стройки, база; at — место на карте, если объекта уже нет (достроенный проект).
 * Хранится в сохранении вместе с отметкой «прочитано до».
 */
import type { Vec } from '../core/vec';

/** Вид записи — значок и фильтр в окне. */
export type NewsKind =
  /** Стройка дорог: проект готов, встал без денег, бригада уступила место. */
  | 'build'
  /** Предприятия: построено, восстановлено, выросло, пристройка, открылось в городе. */
  | 'industry'
  /** Города растут. */
  | 'town'
  /** Транспорт: новые модели, авто-парк обновил маршрут, станция стала грузовой. */
  | 'fleet'
  /** Деньги: грань банкротства, не хватило на замену. */
  | 'money'
  /** Задания и этапы сценария. */
  | 'goal'
  /** Экономические события сценария. */
  | 'event';

export const NEWS_KINDS: readonly NewsKind[] = ['goal', 'event', 'industry', 'town', 'build', 'fleet', 'money'];

/** На что ведёт запись. */
export interface NewsRef {
  type: 'industry' | 'town' | 'station' | 'line' | 'project' | 'base';
  id: number;
}

export interface NewsEntry {
  /** Порядковый номер — по нему считается непрочитанное. */
  n: number;
  /** Номер месяца партии (Game.monthIndex). */
  month: number;
  kind: NewsKind;
  text: string;
  color?: string;
  refs?: NewsRef[];
  at?: { pos: Vec; r: number };
}

export interface NewsSave {
  entries: NewsEntry[];
  /** Номер первой непрочитанной записи. */
  seen: number;
}

/** Сколько месяцев хранить: текущий и пять прошлых. */
export const NEWS_MONTHS = 6;
/** Предел записей: в долгой партии с десятками городов месяц может дать сотню записей. */
export const NEWS_LIMIT = 500;

export class News {
  readonly entries: NewsEntry[];
  /** Номер первой непрочитанной записи. */
  seen: number;

  constructor(saved?: NewsSave) {
    this.entries = saved?.entries ? saved.entries.map((e) => ({ ...e })) : [];
    this.seen = saved?.seen ?? 0;
  }

  /** Номер следующей записи. */
  private get next(): number {
    return this.entries.length ? this.entries[this.entries.length - 1].n + 1 : this.seen;
  }

  add(month: number, e: Omit<NewsEntry, 'n' | 'month'>): NewsEntry {
    const entry: NewsEntry = { n: this.next, month, kind: e.kind, text: e.text };
    if (e.color) entry.color = e.color;
    if (e.refs?.length) entry.refs = e.refs.map((r) => ({ type: r.type, id: r.id }));
    if (e.at) entry.at = { pos: { x: Math.round(e.at.pos.x), y: Math.round(e.at.pos.y) }, r: Math.round(e.at.r) };
    this.entries.push(entry);
    this.trim(month);
    return entry;
  }

  /** Убирает записи старше NEWS_MONTHS месяцев и сверх предела — самые старые. */
  trim(month: number): void {
    const from = month - NEWS_MONTHS + 1;
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop].month < from) drop++;
    drop = Math.max(drop, this.entries.length - NEWS_LIMIT);
    if (drop > 0) this.entries.splice(0, drop);
  }

  /** Сколько записей ещё не видели в окне. */
  get unread(): number {
    let n = 0;
    for (let i = this.entries.length - 1; i >= 0 && this.entries[i].n >= this.seen; i--) n++;
    return n;
  }

  /** Окно открыто — всё прочитано. */
  markRead(): void {
    this.seen = this.next;
  }

  /** По месяцам, свежие сверху; kinds — только эти виды (нет — все). */
  byMonth(kinds?: ReadonlySet<NewsKind>): { month: number; entries: NewsEntry[] }[] {
    const out: { month: number; entries: NewsEntry[] }[] = [];
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (kinds?.size && !kinds.has(e.kind)) continue;
      const last = out[out.length - 1];
      if (last && last.month === e.month) last.entries.push(e);
      else out.push({ month: e.month, entries: [e] });
    }
    return out;
  }

  /** Сколько записей каждого вида — для фильтров. */
  counts(): Map<NewsKind, number> {
    const out = new Map<NewsKind, number>();
    for (const e of this.entries) out.set(e.kind, (out.get(e.kind) ?? 0) + 1);
    return out;
  }

  toSave(): NewsSave | undefined {
    if (!this.entries.length && !this.seen) return undefined;
    return { entries: this.entries, seen: this.seen };
  }
}
