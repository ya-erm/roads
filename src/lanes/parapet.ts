import { add, norm, scale, sub, Vec } from '../core/vec';

/**
 * Бетонное ограждение моста по краям полотна. Стоит снаружи асфальта, вплотную к нему, — полосы и машины на мосту
 * той же ширины, что на земле, стенка их не съедает. width — толщина в метрах (тёмная кромка), top — доля
 * светлого верха посередине; при отдалении стенка не тоньше minPx пикселей экрана, иначе она пропадает.
 */
export const PARAPET = { width: 1.6, top: 0.6, minPx: 1.2 };

/** Толщина ограждения в метрах при масштабе zoom (пикселей экрана на метр). */
export function parapetWidth(zoom: number): number {
  return Math.max(PARAPET.width, PARAPET.minPx / Math.max(zoom, 1e-6));
}

/**
 * Ось ограждения у кромки асфальта edge: каждая точка сдвинута наружу — от парной точки other на другой кромке
 * (точки парами, в одних и тех же местах оси) — на d. Стенка толщиной 2·d прилегает к асфальту снаружи.
 */
export function parapetLine(edge: Vec[], other: Vec[], d: number): Vec[] {
  return edge.map((p, i) => add(p, scale(norm(sub(p, other[i])), d)));
}
