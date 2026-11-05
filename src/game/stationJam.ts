/**
 * «Нет мест» у станции: все посты (платформы) заняты, а машины (поезда) линий стоят и ждут въезда.
 * Короткое заполнение постов — норма (одна уезжает, другая заезжает), поэтому предупреждаем, только если
 * очередь держится JAM_DELAY секунд подряд.
 */

/** Сколько секунд очередь должна держаться, прежде чем о ней предупредить. */
export const JAM_DELAY = 15;
/** Докуда от въезда станции считаем стоящие машины очередью к ней (≈ 100 м). */
export const JAM_REACH = 200;

/** Машина (поезд) линии line по дороге к станции station. */
export interface Approach {
  station: number;
  line: number;
  /** Доехала до въезда, а поста не дали (поезду — свободной платформы). */
  blocked: boolean;
  /** Стоит (в очереди за ней). */
  stopped: boolean;
  /** Сколько до въезда станции. */
  dist: number;
}

/** Кто ждёт въезда на станцию: те, кому не дали поста, и стоящие за ними на подъезде ближе reach. Никому не отказали — никто. */
export function queuedAt(list: Approach[], station: number, reach = JAM_REACH): Approach[] {
  const here = list.filter((a) => a.station === station);
  if (!here.some((a) => a.blocked)) return [];
  return here.filter((a) => a.blocked || (a.stopped && a.dist <= reach));
}

/** Очередь у станции: с какого времени держится, сколько в ней сейчас и чьи это машины (id линий). */
export interface Jam {
  since: number;
  waiting: number;
  lines: number[];
}

/** Очередь после нового замера: full — все посты заняты; посты освободились или ждать некому — очереди нет. */
export function nextJam(prev: Jam | undefined, full: boolean, queued: Approach[], time: number): Jam | undefined {
  if (!full || !queued.length) return undefined;
  return { since: prev?.since ?? time, waiting: queued.length, lines: [...new Set(queued.map((a) => a.line))] };
}

/** Пора ли предупреждать: очередь держится не меньше delay секунд. */
export function jamShown(jam: Jam | undefined, time: number, delay = JAM_DELAY): jam is Jam {
  return !!jam && time - jam.since >= delay;
}
