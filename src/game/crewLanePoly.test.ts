import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { POLY_INDEX_MIN, polyAt } from './crewLane';

/** Прежний расчёт — перебором отрезков с начала: эталон для разметки длинных ломаных. */
function linearAt(pts: readonly Vec[], s: number): { pos: Vec; dir: Vec } {
  let dir = { x: 1, y: 0 };
  let left = s;
  let first = true;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d < 1e-9) continue;
    dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    if (first && left < 0) return { pos: { x: a.x + dir.x * left, y: a.y + dir.y * left }, dir };
    first = false;
    if (left <= d) return { pos: { x: a.x + dir.x * left, y: a.y + dir.y * left }, dir };
    left -= d;
  }
  const z = pts[pts.length - 1];
  return { pos: { x: z.x + dir.x * Math.max(0, left), y: z.y + dir.y * Math.max(0, left) }, dir };
}

/** Извилистая ломаная из n точек с повторами (нулевые отрезки) — как полоса бригады со скруглениями. */
function wiggle(n: number, seed = 1): Vec[] {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const out: Vec[] = [{ x: 0, y: 0 }];
  let ang = 0;
  for (let i = 1; i < n; i++) {
    const prev = out[i - 1];
    if (i % 7 === 0) {
      out.push({ ...prev });
      continue;
    }
    ang += (rnd() - 0.5) * 0.8;
    const step = 0.5 + rnd() * 6;
    out.push({ x: prev.x + Math.cos(ang) * step, y: prev.y + Math.sin(ang) * step });
  }
  return out;
}

const close = (a: { pos: Vec; dir: Vec }, b: { pos: Vec; dir: Vec }) => {
  expect(a.pos.x).toBeCloseTo(b.pos.x, 9);
  expect(a.pos.y).toBeCloseTo(b.pos.y, 9);
  expect(a.dir.x).toBeCloseTo(b.dir.x, 12);
  expect(a.dir.y).toBeCloseTo(b.dir.y, 12);
};

describe('Точка на длинной ломаной (полоса бригады) — по разметке, как перебором', () => {
  it('везде на полосе, позади начала и за концом — то же место и курс', () => {
    const path = wiggle(200);
    expect(path.length).toBeGreaterThanOrEqual(POLY_INDEX_MIN);
    let total = 0;
    for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    for (let s = -30; s <= total + 30; s += total / 997) close(polyAt(path, s), linearAt(path, s));
    // Ровно на стыках отрезков — та же точка; курс — одного из двух отрезков у стыка (на стыке округление решает,
    // какого: и так, и так верно).
    let at = 0;
    for (let i = 1; i < path.length; i++) {
      at += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      const a = polyAt(path, at);
      const b = linearAt(path, at);
      expect(a.pos.x).toBeCloseTo(b.pos.x, 9);
      expect(a.pos.y).toBeCloseTo(b.pos.y, 9);
      const near = [linearAt(path, at - 1e-6).dir, linearAt(path, at + 1e-6).dir];
      expect(near.some((d) => Math.abs(d.x - a.dir.x) < 1e-9 && Math.abs(d.y - a.dir.y) < 1e-9)).toBe(true);
    }
    close(polyAt(path, 0), linearAt(path, 0));
    close(polyAt(path, total), linearAt(path, total));
  });

  it('ломаная из одной точки (все отрезки нулевые) — как раньше', () => {
    const path = Array.from({ length: POLY_INDEX_MIN + 2 }, () => ({ x: 5, y: 7 }));
    for (const s of [-3, 0, 4]) close(polyAt(path, s), linearAt(path, s));
  });

  it('массив поменяли — разметка заново; курс в ответе можно менять, разметку это не портит', () => {
    const path = wiggle(40, 7);
    const a = polyAt(path, 50);
    a.dir.x = 123;
    close(polyAt(path, 50), linearAt(path, 50));
    // Дописали точки и сдвинули конец — место за прежним концом уже на новой части полосы.
    const end = path[path.length - 1];
    path.push({ x: end.x + 100, y: end.y }, { x: end.x + 100, y: end.y + 100 });
    for (const s of [10, 200, 260, 400]) close(polyAt(path, s), linearAt(path, s));
    path[path.length - 1] = { x: end.x + 100, y: end.y - 100 };
    for (const s of [10, 200, 260, 400]) close(polyAt(path, s), linearAt(path, s));
  });
});
