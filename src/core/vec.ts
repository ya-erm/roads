export interface Vec {
  x: number;
  y: number;
}

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export function norm(a: Vec): Vec {
  const l = len(a);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}

/** Правая нормаль в экранных координатах (y вниз). */
export const rightNormal = (d: Vec): Vec => ({ x: -d.y, y: d.x });

export function angleOf(d: Vec): number {
  return Math.atan2(d.y, d.x);
}

/** Разница углов в диапазоне [-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Ближайшая точка на отрезке и параметр t. */
export function closestOnSegment(p: Vec, a: Vec, b: Vec): { point: Vec; t: number; d: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  let t = l2 > 0 ? dot(sub(p, a), ab) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const point = lerp(a, b, t);
  return { point, t, d: dist(p, point) };
}

/** Пересечение отрезков p1p2 и p3p4. Возвращает параметры t и u. */
export function segmentIntersection(
  p1: Vec,
  p2: Vec,
  p3: Vec,
  p4: Vec,
): { t: number; u: number; point: Vec } | null {
  const r = sub(p2, p1);
  const s = sub(p4, p3);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-9) return null;
  const qp = sub(p3, p1);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, point: add(p1, scale(r, t)) };
}

export function cubicBezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Минимальное расстояние между отрезками p1p2 и p3p4. */
export function segSegDist(p1: Vec, p2: Vec, p3: Vec, p4: Vec): number {
  if (segmentIntersection(p1, p2, p3, p4)) return 0;
  return Math.min(
    closestOnSegment(p1, p3, p4).d,
    closestOnSegment(p2, p3, p4).d,
    closestOnSegment(p3, p1, p2).d,
    closestOnSegment(p4, p1, p2).d,
  );
}

