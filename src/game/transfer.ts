/**
 * Перевалка между соседними станциями: груз, который другая линия выгрузила на склад станции (пересадка), может
 * забрать маршрут с грузовой станции рядом (TRANSFER.reach край к краю) — например, ткань, привезённую поездом
 * на ж/д станцию, увозит грузовик с автостанции у того же предприятия. Продукция предприятий (её делят между
 * станциями в охвате и так) через соседей не перекладывается — только груз со склада.
 */
import { TRANSFER } from '../config';
import { dist } from '../core/vec';
import { FREIGHT, type CargoType } from '../world/cargo';
import type { Station } from '../world/entities';
import { footprintRadius, footprintsOverlap } from '../world/spatial';

/** Соседи для перевалки: обе станции работают с грузом и стоят край к краю не дальше TRANSFER.reach. */
export function transferNear(a: Station, b: Station): boolean {
  if (a.id === b.id || !a.serves.cargo || !b.serves.cargo || a.kind === 'stop' || b.kind === 'stop') return false;
  if (dist(a.fp.center, b.fp.center) > footprintRadius(a.fp) + footprintRadius(b.fp) + TRANSFER.reach) return false;
  return footprintsOverlap(a.fp, b.fp, TRANSFER.reach) || footprintsOverlap(b.fp, a.fp, TRANSFER.reach);
}

/** Соседние станции для перевалки у st — ближние первыми (при равенстве — по id: порядок не зависит от карты). */
export function transferNeighbors(st: Station, stations: Iterable<Station>): Station[] {
  const near: Station[] = [];
  for (const o of stations) if (transferNear(st, o)) near.push(o);
  const d = (o: Station) => dist(st.fp.center, o.fp.center);
  return near.sort((a, b) => d(a) - d(b) || a.id - b.id);
}

/**
 * Сколько груза c со склада станции можно переложить соседям: только привезённый сюда другой линией
 * (cargoOrigin — другая станция), а не продукция предприятий у самой станции.
 */
export function transferable(st: Station, c: CargoType): number {
  const origin = st.cargoOrigin?.[c];
  if (origin === undefined || origin === st.id) return 0;
  return Math.floor(st.cargo[c] ?? 0);
}

/** Какой груз со склада станции можно переложить соседям, по видам (только то, чего не меньше единицы). */
export function transferStock(st: Station): [CargoType, number][] {
  return FREIGHT.map((c) => [c, transferable(st, c)] as [CargoType, number]).filter(([, n]) => n >= 1);
}
