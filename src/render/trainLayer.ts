import type { PathEdge } from '../sim/rail';

/** Слой отрисовки по высоте: −1 — тоннель, 0 — земля, 1 — мост, 2 — эстакада над ним. */
export function levelBand(level: number): number {
  return level < -0.5 ? -1 : level < 0.5 ? 0 : level < 1.5 ? 1 : 2;
}

/**
 * Слой, в котором рисуют участок пути с наибольшей высотой maxLevel (как Renderer.railLevel): на земле — 0, иначе
 * весь участок, пандус с земли целиком, — слоем моста (1) или эстакады (2).
 */
export function railSegLayer(maxLevel: number): number {
  if (maxLevel <= 0.01) return 0;
  return Math.min(2, Math.max(1, Math.ceil(maxLevel - 0.01)));
}

/**
 * Слои вагонов поезда, от головы: вагон рисуют не ниже слоя участков, на которые заходит его корпус (с запасом
 * margin), — на пандусе он над его полотном, а не под ним, хотя ещё ниже половины подъёма; заехавший на пандус
 * краем — тоже. В тоннеле (levels[k] ниже −0.5) — бледно под землёй, как раньше. levels — высоты середин вагонов
 * (RailSystem.cars), segLayer — слой участка пути (railSegLayer).
 */
export function carLayers(
  train: { path: readonly PathEdge[]; head: number; cars: number; carLength: number },
  levels: readonly number[],
  segLayer: (seg: number) => number,
  margin = 1,
): number[] {
  return levels.map((level, k) => {
    const band = levelBand(level);
    if (band < 0) return band;
    const front = train.head - k * train.carLength + margin;
    const rear = train.head - (k + 1) * train.carLength - margin;
    let layer = band;
    for (const e of train.path) {
      if (e.start < front && e.start + e.len > rear) layer = Math.max(layer, segLayer(e.seg));
    }
    return layer;
  });
}
