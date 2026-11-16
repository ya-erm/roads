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

/**
 * Ось ограждения по носу островка между двумя полотнами моста (nose — кромка асфальта дугой, выгнутой к стыку):
 * каждая точка сдвинута на d по нормали дуги наружу — в просвет между полотнами, куда дуга открыта. Концы — там,
 * где у обоих полотен начинается ограждение обращённых друг к другу кромок (parapetLine у них тоже наружу).
 */
export function noseParapet(nose: Vec[], d: number): Vec[] {
  const n = nose.length;
  if (n < 3) return [...nose];
  const tangent = (i: number) => norm(sub(nose[Math.min(n - 1, i + 1)], nose[Math.max(0, i - 1)]));
  const perp = (t: Vec): Vec => ({ x: -t.y, y: t.x });
  // Наружу — от вершины дуги к середине хорды: по эту сторону нормали и вся стенка.
  const m = Math.floor(n / 2);
  const out = sub(scale(add(nose[0], nose[n - 1]), 0.5), nose[m]);
  const pm = perp(tangent(m));
  const sign = pm.x * out.x + pm.y * out.y >= 0 ? d : -d;
  return nose.map((p, i) => add(p, scale(perp(tangent(i)), sign)));
}
