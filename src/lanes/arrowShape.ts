import { add, norm, rightNormal, sub, v, Vec } from '../core/vec';

/** Куда можно с полосы на перекрёстке — как стрелки разметки. */
export type Turn = 'uturn' | 'left' | 'straight' | 'right';

/** Масштаб заготовки стрелки (она рисуется в своих единицах, полоса — 7). */
export const ARROW_K = 0.9;
/** Хвост ствола и нос прямой стрелки в своих единицах. */
export const ARROW_TAIL = -5;
export const ARROW_NOSE = 4.4;
/** Толщина ствола и дуг. */
const W = 0.9;

/** Лента толщиной W вдоль ломаной — замкнутый контур. */
function ribbon(pts: Vec[]): Vec[] {
  const l: Vec[] = [];
  const r: Vec[] = [];
  pts.forEach((p, i) => {
    const d = norm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]));
    const n = { x: (-d.y * W) / 2, y: (d.x * W) / 2 };
    l.push(sub(p, n));
    r.push(add(p, n));
  });
  return [...l, ...r.reverse()];
}

/** Все контуры — в одну сторону обхода: тогда одна заливка их объединяет, без двойной прозрачности. */
function oriented(poly: Vec[]): Vec[] {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a < 0 ? poly.reverse() : poly;
}

/** Контуры стрелки в своих координатах: x — вперёд по полосе, y — вправо. */
export function arrowShape(turns: Turn[]): Vec[][] {
  const S = turns.includes('straight');
  const L = turns.includes('left');
  const R = turns.includes('right');
  const U = turns.includes('uturn');
  const polys: Vec[][] = [];
  // При «прямо» повороты отходят от середины ствола, без него ствол сам заворачивает вбок.
  const branch = S ? -0.7 : 1.2;
  // Разворот — ниже поворота налево, чтобы не налезали друг на друга.
  const hook = L ? (S ? -2.8 : -1.1) : S ? -0.7 : 1.4;
  let top = S ? 2.3 : ARROW_TAIL + 2;
  if (L || R) top = Math.max(top, branch);
  if (U) top = Math.max(top, hook);
  polys.push(ribbon([v(ARROW_TAIL, 0), v(top, 0)]));
  if (S) polys.push([v(ARROW_NOSE, 0), v(2.1, 1.3), v(2.1, -1.3)]);
  for (const side of [-1, 1]) {
    if (!(side < 0 ? L : R)) continue;
    // Четверть круга от ствола вбок и головка поперёк полосы.
    const r = 1.1;
    const arc: Vec[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i / 8) * (Math.PI / 2);
      arc.push(v(branch + r * Math.sin(a), side * r * (1 - Math.cos(a))));
    }
    arc.push(v(branch + r, side * (r + 0.25)));
    polys.push(ribbon(arc));
    const x = branch + r;
    const y = side * (r + 0.1);
    polys.push([v(x, y + side * 1.8), v(x - 1.2, y), v(x + 1.2, y)]);
  }
  if (U) {
    // Полукруг влево и головка назад.
    const r = 0.95;
    const arc: Vec[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      arc.push(v(hook + r * Math.sin(a), -r * (1 - Math.cos(a))));
    }
    arc.push(v(hook - 0.25, -2 * r));
    polys.push(ribbon(arc));
    const x = hook - 0.1;
    polys.push([v(x - 1.8, -2 * r), v(x, -2 * r - 1.1), v(x, -2 * r + 1.1)]);
  }
  return polys.map(oriented);
}

/** Контуры заготовки в мире: середина в pos, вперёд — по dir (единичный), в масштабе ARROW_K. */
export function arrowAt(shape: Vec[][], pos: Vec, dir: Vec): Vec[][] {
  const N = rightNormal(dir);
  return shape.map((poly) => poly.map((p) => v(pos.x + (dir.x * p.x + N.x * p.y) * ARROW_K, pos.y + (dir.y * p.x + N.y * p.y) * ARROW_K)));
}
