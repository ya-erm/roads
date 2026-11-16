import { dist, type Vec } from '../core/vec';

/**
 * Манёвры во дворах: отрезки пути середины кузова (кривая Безье или прямая), передом или задним ходом, и где машина на
 * отрезке. Общее для машин жителей у гаражей и стоянок (game/garages.ts) и грузовиков у рамп получателей
 * (game/docks.ts).
 */

/** Отрезок пути манёвра: точки середины кузова, касательные (по ходу), длины до точек, задним ходом ли, предел скорости. */
export interface Leg {
  pts: Vec[];
  tan: Vec[];
  cum: number[];
  len: number;
  back: boolean;
  vmax: number;
}

/** Кубическая кривая Безье p0 → p3 (касательные — к p1 и от p2) из n частей. */
export function bezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec, back: boolean, vmax: number, n = 18): Leg {
  const pts: Vec[] = [];
  const tan: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    });
    const d = {
      x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
      y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
    };
    const l = Math.hypot(d.x, d.y) || 1;
    tan.push({ x: d.x / l, y: d.y / l });
  }
  return finish(pts, tan, back, vmax);
}

/** Прямая a → b. */
export function straight(a: Vec, b: Vec, back: boolean, vmax: number): Leg {
  const l = dist(a, b) || 1;
  const t = { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  return finish([a, b], [t, t], back, vmax);
}

function finish(pts: Vec[], tan: Vec[], back: boolean, vmax: number): Leg {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, tan, cum, len: cum[cum.length - 1], back, vmax };
}

/** Середина кузова и курс (нос) на отрезке в s от его начала: задним ходом нос смотрит против хода. */
export function legPose(leg: Leg, s: number): { c: Vec; h: Vec } {
  const { pts, tan, cum } = leg;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const span = cum[i] - cum[i - 1];
  const t = span > 1e-9 ? Math.max(0, Math.min(1, (s - cum[i - 1]) / span)) : 1;
  const c = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
  const hx = tan[i - 1].x + (tan[i].x - tan[i - 1].x) * t;
  const hy = tan[i - 1].y + (tan[i].y - tan[i - 1].y) * t;
  const l = Math.hypot(hx, hy) || 1;
  const k = leg.back ? -1 / l : 1 / l;
  return { c, h: { x: hx * k, y: hy * k } };
}
