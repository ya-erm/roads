import { dist, type Vec } from '../core/vec';

/**
 * Покупку из карточки маршрута тянут на карту (Hud.bindBuyDrag): остановки маршрута — кружками с номерами, отпустили
 * на остановке — машина начинает работу с неё. Здесь чистые правила: где стоят кружки и на какую остановку упадёт.
 */

/** Радиус кружка с номером остановки на карте — экранных пикселей. */
export const BUY_DOT_PX = 11;

/** Кружок с номером остановки маршрута: i — номер в маршруте (с 0), id — станция, at — где кружок. */
export interface DropSpot {
  i: number;
  id: number;
  at: Vec;
}

/**
 * Кружки остановок маршрута stops — в центрах станций; станция в маршруте не раз (конечная «туда и обратно» через
 * неё же) — её кружки рядом в ряд через gap, чтобы каждый было видно и в каждый можно было попасть.
 */
export function dropSpots(stops: readonly number[], center: (id: number) => Vec | undefined, gap: number): DropSpot[] {
  const total = new Map<number, number>();
  for (const id of stops) total.set(id, (total.get(id) ?? 0) + 1);
  const seen = new Map<number, number>();
  const out: DropSpot[] = [];
  stops.forEach((id, i) => {
    const c = center(id);
    if (!c) return;
    const k = seen.get(id) ?? 0;
    seen.set(id, k + 1);
    const n = total.get(id)!;
    out.push({ i, id, at: { x: c.x + (k - (n - 1) / 2) * gap, y: c.y } });
  });
  return out;
}

export interface DropLook {
  /** Радиус кружка с номером (в мире): попадание в кружок — эта остановка. */
  dot: number;
  center: (id: number) => Vec | undefined;
  /** Докуда от центра станции бросок считается на неё (её участок и запас на промах). */
  reach: (id: number) => number;
  /** Вторая половина пары остановок (Station.pair) — бросок на неё тоже на эту остановку. */
  mate: (id: number) => number | undefined;
}

/**
 * На какую остановку маршрута (номер в маршруте) упадёт покупка, отпущенная в точке p: в кружок с номером, на станцию
 * или на вторую половину её пары. Подходят несколько (обе половины пары в маршруте, станция в маршруте дважды) —
 * та, чей кружок ближе к p; поровну — с меньшим номером. Мимо — null.
 */
export function pickDropStop(spots: readonly DropSpot[], p: Vec, look: DropLook): number | null {
  const near = (id: number | undefined) => {
    if (id === undefined) return false;
    const c = look.center(id);
    return !!c && dist(p, c) <= look.reach(id);
  };
  let best: number | null = null;
  let bestD = Infinity;
  for (const s of spots) {
    const d = dist(p, s.at);
    if (d > look.dot && !near(s.id) && !near(look.mate(s.id))) continue;
    if (d < bestD || (d === bestD && best !== null && s.i < best)) {
      best = s.i;
      bestD = d;
    }
  }
  return best;
}
