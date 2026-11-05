import { add, cross, dist, dot, len, lerp, norm, scale, sub, Vec } from './vec';

export interface Cubic {
  p0: Vec;
  p1: Vec;
  p2: Vec;
  p3: Vec;
}

export function bezPoint(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const d = 3 * mt * t * t;
  const e = t * t * t;
  return {
    x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y,
  };
}

export function bezDeriv(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  const a = 3 * mt * mt;
  const b = 6 * mt * t;
  const d = 3 * t * t;
  return {
    x: a * (c.p1.x - c.p0.x) + b * (c.p2.x - c.p1.x) + d * (c.p3.x - c.p2.x),
    y: a * (c.p1.y - c.p0.y) + b * (c.p2.y - c.p1.y) + d * (c.p3.y - c.p2.y),
  };
}

export function bezSecond(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  return {
    x: 6 * mt * (c.p2.x - 2 * c.p1.x + c.p0.x) + 6 * t * (c.p3.x - 2 * c.p2.x + c.p1.x),
    y: 6 * mt * (c.p2.y - 2 * c.p1.y + c.p0.y) + 6 * t * (c.p3.y - 2 * c.p2.y + c.p1.y),
  };
}

/** Деление кривой в точке t (алгоритм де Кастельжо). */
export function splitBezier(c: Cubic, t: number): [Cubic, Cubic] {
  const p01 = lerp(c.p0, c.p1, t);
  const p12 = lerp(c.p1, c.p2, t);
  const p23 = lerp(c.p2, c.p3, t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const m = lerp(p012, p123, t);
  return [
    { p0: c.p0, p1: p01, p2: p012, p3: m },
    { p0: m, p1: p123, p2: p23, p3: c.p3 },
  ];
}

export function reverseCubic(c: Cubic): Cubic {
  return { p0: c.p3, p1: c.p2, p2: c.p1, p3: c.p0 };
}

export function straightCubic(a: Vec, b: Vec): Cubic {
  return { p0: a, p1: lerp(a, b, 1 / 3), p2: lerp(a, b, 2 / 3), p3: b };
}

/**
 * Кривая, параллельная c на расстоянии d вбок (по нормали (−t.y, t.x)): концы сдвигаются по нормали,
 * ручки — укорачиваются со стороны поворота и удлиняются с внешней (по кривизне на концах),
 * так дуга остаётся дугой.
 */
export function offsetCubic(c: Cubic, d: number): Cubic {
  const end = (t: number) => {
    const p = bezPoint(c, t);
    const d1 = bezDeriv(c, t);
    const d2 = bezSecond(c, t);
    const l = len(d1) || 1;
    const n = { x: -d1.y / l, y: d1.x / l };
    const k = cross(d1, d2) / (l * l * l);
    return { p: add(p, scale(n, d)), s: 1 - d * k };
  };
  const a = end(0);
  const b = end(1);
  return { p0: a.p, p1: add(a.p, scale(sub(c.p1, c.p0), a.s)), p2: add(b.p, scale(sub(c.p2, c.p3), b.s)), p3: b.p };
}

/**
 * Параллель кривой c на расстоянии d по всей длине. offsetCubic точен у дуги окружности, а где кривизна
 * меняется (длинная или S-образная кривая), его середина отходит от параллели — тогда кривая делится
 * пополам и сдвигается по кускам, пока каждый не ляжет на расстоянии d с точностью tol. Кривые короче
 * 2·minLen не делятся. Куски — по порядку, стыкуются концами и касательными.
 */
export function offsetCubics(c: Cubic, d: number, tol = 0.15, minLen = 16): Cubic[] {
  const o = offsetCubic(c, d);
  if (offsetError(c, o, d) <= tol || cubicLength(c) < 2 * minLen) return [o];
  const [a, b] = splitBezier(c, 0.5);
  return [...offsetCubics(a, d, tol, minLen), ...offsetCubics(b, d, tol, minLen)];
}

/** Насколько кривая o отходит от параллели c на расстоянии d: наибольшее |расстояние до c − |d|| по точкам o. */
export function offsetError(c: Cubic, o: Cubic, d: number, samples = 16): number {
  let worst = 0;
  for (let i = 1; i < samples; i++) worst = Math.max(worst, Math.abs(distanceToCubic(c, bezPoint(o, i / samples)) - Math.abs(d)));
  return worst;
}

/** Расстояние от точки p до кривой c: грубо по точкам, затем уточнение Ньютоном. */
export function distanceToCubic(c: Cubic, p: Vec, samples = 32): number {
  let t = 0;
  let best = Infinity;
  for (let i = 0; i <= samples; i++) {
    const d = dist(bezPoint(c, i / samples), p);
    if (d < best) {
      best = d;
      t = i / samples;
    }
  }
  for (let k = 0; k < 6; k++) {
    const r = sub(bezPoint(c, t), p);
    const d1 = bezDeriv(c, t);
    const f = dot(r, d1);
    const df = dot(d1, d1) + dot(r, bezSecond(c, t));
    if (Math.abs(df) < 1e-12) break;
    t = Math.max(0, Math.min(1, t - f / df));
  }
  return Math.min(best, dist(bezPoint(c, t), p));
}

/** Длина кривой (по ломаной из n кусков). */
export function cubicLength(c: Cubic, n = 24): number {
  let total = 0;
  let prev = c.p0;
  for (let i = 1; i <= n; i++) {
    const p = bezPoint(c, i / n);
    total += dist(prev, p);
    prev = p;
  }
  return total;
}

export function quadToCubic(a: Vec, ctrl: Vec, b: Vec): Cubic {
  return { p0: a, p1: lerp(a, ctrl, 2 / 3), p2: lerp(b, ctrl, 2 / 3), p3: b };
}

/**
 * Дуга окружности, выходящая из start по касательной tangent и приходящая в end.
 * Возвращает null, если поворот больше 160°.
 */
export function arcCubic(start: Vec, tangent: Vec, end: Vec): Cubic | null {
  const chord = sub(end, start);
  const d = len(chord);
  if (d < 1e-6) return null;
  const c = scale(chord, 1 / d);
  const t = norm(tangent);
  const phi = Math.atan2(cross(t, c), dot(t, c));
  if (Math.abs(phi) < 1e-3) return straightCubic(start, end);
  if (Math.abs(phi) > (80 * Math.PI) / 180) return null;
  const theta = 2 * Math.abs(phi);
  const r = d / (2 * Math.abs(Math.sin(phi)));
  const h = (4 / 3) * Math.tan(theta / 4) * r;
  const tEnd = sub(scale(c, 2 * dot(t, c)), t);
  return { p0: start, p1: add(start, scale(t, h)), p2: sub(end, scale(tEnd, h)), p3: end };
}

/** Кусок окружности с центром center от угла a0 до a1 (через убывание или рост угла). */
export function circleArc(center: Vec, r: number, a0: number, a1: number): Cubic {
  const delta = a1 - a0;
  const h = (4 / 3) * Math.tan(Math.abs(delta) / 4) * r;
  const sgn = Math.sign(delta);
  const p = (a: number) => ({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r });
  const tan = (a: number) => ({ x: -Math.sin(a) * sgn, y: Math.cos(a) * sgn });
  const s = p(a0);
  const e = p(a1);
  return { p0: s, p1: add(s, scale(tan(a0), h)), p2: sub(e, scale(tan(a1), h)), p3: e };
}

/** Минимальный радиус кривизны кривой. */
export function minRadius(c: Cubic, samples = 32): number {
  let best = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const d1 = bezDeriv(c, t);
    const d2 = bezSecond(c, t);
    const k = Math.abs(cross(d1, d2));
    const sp = len(d1);
    if (k < 1e-9 || sp < 1e-6) continue;
    best = Math.min(best, (sp * sp * sp) / k);
  }
  return best;
}

/** Таблица «длина дуги → параметр» для равномерного движения по кривой. */
export class CurveLUT {
  readonly points: Vec[] = [];
  readonly ts: number[] = [];
  readonly cum: number[] = [];
  readonly length: number;

  constructor(readonly curve: Cubic) {
    const approx = dist(curve.p0, curve.p1) + dist(curve.p1, curve.p2) + dist(curve.p2, curve.p3);
    const n = Math.max(8, Math.min(160, Math.ceil(approx / 3)));
    let total = 0;
    let prev = curve.p0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = i === 0 ? curve.p0 : bezPoint(curve, t);
      if (i > 0) total += dist(prev, p);
      this.points.push(p);
      this.ts.push(t);
      this.cum.push(total);
      prev = p;
    }
    this.length = Math.max(total, 1e-6);
  }

  private index(s: number): { i: number; f: number } {
    const cum = this.cum;
    const target = Math.max(0, Math.min(this.length, s));
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid;
      else hi = mid;
    }
    const segLen = cum[hi] - cum[lo];
    return { i: lo, f: segLen > 1e-9 ? (target - cum[lo]) / segLen : 0 };
  }

  tAt(s: number): number {
    const { i, f } = this.index(s);
    return this.ts[i] + (this.ts[i + 1] - this.ts[i]) * f;
  }

  sAtT(t: number): number {
    const n = this.ts.length - 1;
    const x = Math.max(0, Math.min(1, t)) * n;
    const i = Math.min(n - 1, Math.floor(x));
    return this.cum[i] + (this.cum[i + 1] - this.cum[i]) * (x - i);
  }

  pointAt(s: number): Vec {
    const { i, f } = this.index(s);
    return lerp(this.points[i], this.points[i + 1], f);
  }

  tangentAt(s: number): Vec {
    const t = this.tAt(s);
    const d = bezDeriv(this.curve, t);
    const l = len(d);
    if (l > 1e-6) return scale(d, 1 / l);
    return norm(sub(this.curve.p3, this.curve.p0));
  }

  /** Полилиния, смещённая вправо на off, на участке [s0, s1]. */
  offsetPolyline(off: number, s0 = 0, s1 = this.length, step = 3): Vec[] {
    const pts: Vec[] = [];
    const a = Math.max(0, s0);
    const b = Math.min(this.length, s1);
    if (b <= a) return pts;
    const n = Math.max(1, Math.ceil((b - a) / step));
    for (let i = 0; i <= n; i++) {
      const s = a + ((b - a) * i) / n;
      const p = this.pointAt(s);
      if (off === 0) {
        pts.push(p);
      } else {
        const t = this.tangentAt(s);
        pts.push({ x: p.x - t.y * off, y: p.y + t.x * off });
      }
    }
    return pts;
  }

  /** Ближайшая точка кривой к p. */
  closest(p: Vec): { s: number; t: number; point: Vec; d: number } {
    let best = { i: 0, f: 0, d: Infinity };
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i];
      const b = this.points[i + 1];
      const ab = sub(b, a);
      const l2 = dot(ab, ab);
      const f = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
      const d = dist(p, lerp(a, b, f));
      if (d < best.d) best = { i, f, d };
    }
    const s = this.cum[best.i] + (this.cum[best.i + 1] - this.cum[best.i]) * best.f;
    const t = this.ts[best.i] + (this.ts[best.i + 1] - this.ts[best.i]) * best.f;
    return { s, t, point: this.pointAt(s), d: best.d };
  }
}

export interface CurveHit {
  /** Длина дуги на первой кривой. */
  s1: number;
  s2: number;
  t1: number;
  t2: number;
  point: Vec;
}

/** Пересечения двух кривых через их полилинии. */
export function intersectCurves(a: CurveLUT, b: CurveLUT): CurveHit[] {
  const hits: CurveHit[] = [];
  const pa = a.points;
  const pb = b.points;
  for (let i = 0; i < pa.length - 1; i++) {
    const a0 = pa[i];
    const a1 = pa[i + 1];
    const minX = Math.min(a0.x, a1.x);
    const maxX = Math.max(a0.x, a1.x);
    const minY = Math.min(a0.y, a1.y);
    const maxY = Math.max(a0.y, a1.y);
    for (let j = 0; j < pb.length - 1; j++) {
      const b0 = pb[j];
      const b1 = pb[j + 1];
      if (Math.max(b0.x, b1.x) < minX || Math.min(b0.x, b1.x) > maxX) continue;
      if (Math.max(b0.y, b1.y) < minY || Math.min(b0.y, b1.y) > maxY) continue;
      const r = sub(a1, a0);
      const q = sub(b1, b0);
      const denom = cross(r, q);
      if (Math.abs(denom) < 1e-9) continue;
      const w = sub(b0, a0);
      const eps = 1e-7;
      const u = cross(w, q) / denom;
      const v = cross(w, r) / denom;
      if (u < -eps || u > 1 + eps || v < -eps || v > 1 + eps) continue;
      const point = add(a0, scale(r, u));
      // Пересечение на стыке кусков полилинии находится дважды — оставляем одно.
      if (hits.some((h) => dist(h.point, point) < 0.5)) continue;
      hits.push({
        s1: a.cum[i] + (a.cum[i + 1] - a.cum[i]) * u,
        s2: b.cum[j] + (b.cum[j + 1] - b.cum[j]) * v,
        t1: a.ts[i] + (a.ts[i + 1] - a.ts[i]) * u,
        t2: b.ts[j] + (b.ts[j + 1] - b.ts[j]) * v,
        point,
      });
    }
  }
  return hits;
}

/** Минимальное расстояние между полилиниями (грубо, по вершинам и отрезкам). */
export function polylineMinDistance(a: Vec[], b: Vec[]): number {
  let best = Infinity;
  for (const p of a) {
    for (let j = 0; j < b.length - 1; j++) {
      const q0 = b[j];
      const q1 = b[j + 1];
      const ab = sub(q1, q0);
      const l2 = dot(ab, ab);
      const f = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, q0), ab) / l2)) : 0;
      const d = dist(p, lerp(q0, q1, f));
      if (d < best) best = d;
    }
  }
  return best;
}
