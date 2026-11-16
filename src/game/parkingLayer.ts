import type { Vec } from '../core/vec';

/**
 * Слой «🅿️» (docs/PARKING.md): занятость мест по клеткам карты — дворовые стоянки, гаражные боксы, стоянки
 * магазинов. Клетка — 167 ед. (≈ 100 м; единица карты — 0,6 м). Цвет — по доле занятых мест: зелёный — меньше 70 %,
 * жёлтый — 70–90 %, красный — больше 90 %.
 */
export const PARKING_LAYER = {
  /** Сторона клетки, ед. (≈ 100 м). */
  cell: 167,
  /** Пороги доли занятых мест: до yellow — зелёный, до red — жёлтый, выше — красный. */
  yellow: 0.7,
  red: 0.9,
};

/** Клетка слоя: левый верхний угол, сторона, сколько мест и сколько занято. */
export interface ParkingCell {
  x: number;
  y: number;
  size: number;
  total: number;
  used: number;
}

export type ParkingLevel = 'free' | 'busy' | 'full';

/** Насколько занята клетка: free — меньше 70 %, busy — 70–90 %, full — больше 90 %. */
export function parkingLevel(c: Pick<ParkingCell, 'total' | 'used'>): ParkingLevel {
  const share = c.total ? c.used / c.total : 0;
  return share > PARKING_LAYER.red ? 'full' : share >= PARKING_LAYER.yellow ? 'busy' : 'free';
}

/** Места по домам (где, сколько, сколько занято) — по клеткам; клетки без мест не нужны. */
export function parkingCells(pts: readonly { pos: Vec; total: number; used: number }[], size = PARKING_LAYER.cell): ParkingCell[] {
  const cells = new Map<string, ParkingCell>();
  for (const p of pts) {
    if (!p.total) continue;
    const i = Math.floor(p.pos.x / size);
    const j = Math.floor(p.pos.y / size);
    const key = `${i}:${j}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { x: i * size, y: j * size, size, total: 0, used: 0 }));
    c.total += p.total;
    c.used += p.used;
  }
  return [...cells.values()];
}
