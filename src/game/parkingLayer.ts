import type { Vec } from '../core/vec';

/**
 * Слой «🅿️» (docs/PARKING.md): занятость мест по клеткам карты — дворовые стоянки, гаражные боксы, стоянки
 * магазинов, полосы стоянки и площадки. Клетка — 167 ед. (≈ 100 м; единица карты — 0,6 м). Цвет — по доле занятых
 * мест: зелёный — меньше 70 %, жёлтый — 70–90 %, красный — больше 90 % или за месяц были отказы (машина не нашла места
 * у цели и уехала домой); штриховка — там, где машины кружат, ища место.
 */
export const PARKING_LAYER = {
  /** Сторона клетки, ед. (≈ 100 м). */
  cell: 167,
  /** Пороги доли занятых мест: до yellow — зелёный, до red — жёлтый, выше — красный. */
  yellow: 0.7,
  red: 0.9,
};

/**
 * Клетка слоя: левый верхний угол, сторона, сколько мест и сколько занято; отказов за месяц (машина не нашла места
 * у цели в клетке и уехала домой, game/parkSearch.ts) и сколько машин кружит сейчас, ища место у цели в клетке.
 */
export interface ParkingCell {
  x: number;
  y: number;
  size: number;
  total: number;
  used: number;
  refused?: number;
  circling?: number;
}

export type ParkingLevel = 'free' | 'busy' | 'full';

/** Насколько занята клетка: free — меньше 70 %, busy — 70–90 %, full — больше 90 % или были отказы. */
export function parkingLevel(c: Pick<ParkingCell, 'total' | 'used' | 'refused'>): ParkingLevel {
  if (c.refused) return 'full';
  const share = c.total ? c.used / c.total : 0;
  return share > PARKING_LAYER.red ? 'full' : share >= PARKING_LAYER.yellow ? 'busy' : 'free';
}

/**
 * Места по домам (где, сколько, сколько занято) — по клеткам; клетки без мест не нужны, кроме тех, где за месяц были
 * отказы (refused — по ключу клетки `${i}:${j}`) или где кружат (circling — цели кружащих машин).
 */
export function parkingCells(
  pts: readonly { pos: Vec; total: number; used: number }[],
  size = PARKING_LAYER.cell,
  extra: { refused?: Record<string, number>; circling?: readonly Vec[] } = {},
): ParkingCell[] {
  const cells = new Map<string, ParkingCell>();
  const cell = (i: number, j: number): ParkingCell => {
    const key = `${i}:${j}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { x: i * size, y: j * size, size, total: 0, used: 0 }));
    return c;
  };
  for (const p of pts) {
    if (!p.total) continue;
    const c = cell(Math.floor(p.pos.x / size), Math.floor(p.pos.y / size));
    c.total += p.total;
    c.used += p.used;
  }
  for (const [key, n] of Object.entries(extra.refused ?? {})) {
    if (!n) continue;
    const [i, j] = key.split(':').map(Number);
    const c = cell(i, j);
    c.refused = (c.refused ?? 0) + n;
  }
  for (const p of extra.circling ?? []) {
    const c = cell(Math.floor(p.x / size), Math.floor(p.y / size));
    c.circling = (c.circling ?? 0) + 1;
  }
  return [...cells.values()];
}
