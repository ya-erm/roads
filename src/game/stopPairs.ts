import { dist, type Vec } from '../core/vec';
import { ridePath } from './fare';

/**
 * Пары остановок напротив (Station.pair, STOP.pair): чистые правила без игры — чья половина у дома, сколько ехать
 * по линии от половины до остановки, как склеить маршрут, когда половину пары в нём заменили другой.
 */

/** Половина пары, к которой относится дом в точке at: к ближней; поровну — к той, у которой номер меньше. */
export function nearerHalf(at: Vec, a: { id: number; fp: { center: Vec } }, b: { id: number; fp: { center: Vec } }): number {
  const da = dist(at, a.fp.center);
  const db = dist(at, b.fp.center);
  if (da !== db) return da < db ? a.id : b.id;
  return Math.min(a.id, b.id);
}

/**
 * Сколько ехать по линии stops от остановки from до остановки to (по прямой между остановками, по кругу вперёд);
 * to встречается несколько раз — до ближайшей. Не по пути — Infinity.
 */
export function rideAhead(stops: readonly number[], pos: (id: number) => Vec | undefined, from: number, to: number): number {
  let best = Infinity;
  for (let j = 0; j < stops.length; j++) {
    if (stops[j] !== to) continue;
    const path = ridePath(stops, pos, from, j);
    if (path !== null && path < best) best = path;
  }
  return best;
}

/**
 * Маршрут после замены половин пар: соседние одинаковые остановки склеиваются (и последняя с первой — маршрут по
 * кругу). index — новый номер каждой прежней остановки (склеенная — номер той, с которой склеилась). Остановок
 * осталось меньше двух — null.
 */
export function mergeStops(stops: readonly number[]): { stops: number[]; index: number[] } | null {
  const keep: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < stops.length; i++) {
    if (keep.length && stops[keep[keep.length - 1]] === stops[i]) {
      index.push(keep.length - 1);
      continue;
    }
    index.push(keep.length);
    keep.push(i);
  }
  if (keep.length > 1 && stops[keep[keep.length - 1]] === stops[keep[0]]) {
    const last = keep.length - 1;
    for (let i = 0; i < index.length; i++) if (index[i] === last) index[i] = 0;
    keep.pop();
  }
  if (keep.length < 2) return null;
  return { stops: keep.map((i) => stops[i]), index };
}

/**
 * Куда едут автобусы, что встают у навеса shelter, когда узел остановки на оси улицы — node: движение правостороннее,
 * навес справа по ходу (rightNormal хода смотрит от оси к навесу).
 */
export function curbHeading(shelter: Vec, node: Vec): Vec {
  const n = { x: shelter.x - node.x, y: shelter.y - node.y };
  const l = Math.hypot(n.x, n.y) || 1;
  return { x: n.y / l, y: -n.x / l };
}

/** Стрелка по направлению на экране (y вниз): куда едут автобусы, что встают у половины пары. */
export function headingArrow(dir: Vec): string {
  const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  const k = Math.round(Math.atan2(dir.y, dir.x) / (Math.PI / 4));
  return arrows[((k % 8) + 8) % 8];
}
