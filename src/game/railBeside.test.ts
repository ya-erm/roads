import { describe, expect, it } from 'vitest';
import { arcCubic, Cubic, CurveLUT, distanceToCubic, offsetCubic, offsetCubics } from '../core/bezier';
import { add, dist, rightNormal, scale, sub, Vec } from '../core/vec';
import { RAIL_SPEC, TRACK_GAP } from '../world/roadTypes';
import type { RoadRequest, Snap } from './build';
import { Game } from './game';
import { besideRun, besideTrack } from './railEdit';
import { clearStrip } from './testkit';

const dryGame = () => new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });

const free = (pos: Vec): Snap => ({ kind: 'free', pos, level: 0 });
const along = (curve: Cubic): RoadRequest => ({ start: free(curve.p0), end: free(curve.p3), spec: RAIL_SPEC, mode: 'straight', curve });

/** Точки кривых через каждые step метров, с концами. */
function samples(curves: Cubic[], step = 2): Vec[] {
  const pts: Vec[] = [];
  for (const c of curves) {
    const lut = new CurveLUT(c);
    const n = Math.max(1, Math.ceil(lut.length / step));
    for (let i = 0; i <= n; i++) pts.push(lut.pointAt((lut.length * i) / n));
  }
  return pts;
}

/** Расстояние от точек пути path до ближайшей из кривых base: наименьшее и наибольшее по всей длине. */
function gapRange(path: Cubic[], base: Cubic[]): { min: number; max: number } {
  let min = Infinity;
  let max = 0;
  for (const p of samples(path)) {
    const d = Math.min(...base.map((c) => distanceToCubic(c, p)));
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return { min, max };
}

/** Точка и ход пути из кривых curves (подряд) на расстоянии s от начала. */
function pointAlong(curves: Cubic[], s: number): { p: Vec; t: Vec } {
  let rest = s;
  for (const c of curves) {
    const lut = new CurveLUT(c);
    if (rest <= lut.length || c === curves[curves.length - 1]) {
      const at = Math.min(rest, lut.length);
      return { p: lut.pointAt(at), t: lut.tangentAt(at) };
    }
    rest -= lut.length;
  }
  throw new Error('Пустой путь');
}

const lengthOf = (curves: Cubic[]) => curves.reduce((s, c) => s + new CurveLUT(c).length, 0);

/** Сбоку от пути на расстоянии s от начала: k = ±1 — сторона, чуть мимо междупутья (как промахивается курсор). */
const beside = (curves: Cubic[], s: number, k: number): Vec => {
  const { p, t } = pointAlong(curves, s);
  return add(p, scale(rightNormal(t), k * (TRACK_GAP + 0.8)));
};

/**
 * Кладёт путь из кривых make(at) (at — локальные координаты: x вдоль dir, y вбок) там, где хватает места
 * и по бокам: сначала — планы всех кусков и их копий с обеих сторон, потом — стройка подряд.
 */
function layCurves(game: Game, make: (at: (x: number, y: number) => Vec) => Cubic[]): { curves: Cubic[]; built: Cubic[] } {
  for (let y = 500; y < game.terrain.height - 500; y += 170) {
    for (let x = 300; x < game.terrain.width - 1300; x += 230) {
      for (const angle of [0, 0.3, -0.3]) {
        const dir = { x: Math.cos(angle), y: Math.sin(angle) };
        const n = rightNormal(dir);
        const at = (u: number, v: number) => add(add({ x, y }, scale(dir, u)), scale(n, v));
        const curves = make(at);
        // В чистом поле: без дорог (и стартовых просёлков) и домов рядом.
        if (!curves.every((c) => clearStrip(game, c.p0, c.p3, 250))) continue;
        const room = curves.flatMap((c) => [c, ...[-1, 1].flatMap((k) => offsetCubics(c, k * TRACK_GAP))]);
        if (!room.every((c) => game.builder.plan(along(c)).ok)) continue;
        return { curves, built: buildPieces(game, curves) };
      }
    }
  }
  throw new Error('Нет места для пути');
}

/** Строит куски подряд, как инструмент: следующий — от конца предыдущего. Возвращает новые участки. */
function buildPieces(game: Game, pieces: Cubic[]): Cubic[] {
  const before = new Set(game.net.segments.keys());
  for (const c of pieces) expect(game.builder.plan(along(c)).reason ?? 'ok').toBe('ok');
  let prev: Snap | null = null;
  for (const c of pieces) {
    const start = prev ?? free(c.p0);
    const res = game.builder.build({ ...along(c), start, curve: { ...c, p0: start.pos } });
    expect(res).not.toBeNull();
    const node = game.net.node(res!.endNode);
    prev = { kind: 'node', nodeId: node.id, pos: node.pos, level: 0 };
  }
  return [...game.net.segments.values()].filter((s) => !before.has(s.id)).map((s) => s.curve);
}

/** S-образный путь из двух неокружных кривых: на 1000 м уходит вбок на 200 м. */
const sCurve = (at: (x: number, y: number) => Vec): Cubic[] => [
  { p0: at(0, 0), p1: at(200, 0), p2: at(320, 30), p3: at(500, 100) },
  { p0: at(500, 100), p1: at(680, 170), p2: at(800, 200), p3: at(1000, 200) },
];

/** Поворот на 90° одной кривой, круче к концу (кривизна сильно меняется) — так выходит после перьев «Двигать». */
const hook = (at: (x: number, y: number) => Vec): Cubic[] => [{ p0: at(0, 0), p1: at(420, 0), p2: at(540, 60), p3: at(540, 420) }];

describe('Параллельный путь — на междупутье по всей длине', { timeout: 60_000 }, () => {
  it('параллель кривой с меняющейся кривизной — несколькими кусками, расстояние постоянно', () => {
    const c: Cubic = { p0: { x: 0, y: 0 }, p1: { x: 700, y: 0 }, p2: { x: 900, y: 100 }, p3: { x: 900, y: 700 } };
    for (const d of [TRACK_GAP, -TRACK_GAP]) {
      // Одна сдвинутая кривая совпадает с параллелью лишь у концов, посередине — отходит.
      const one = gapRange([offsetCubic(c, d)], [c]);
      expect(one.max - one.min).toBeGreaterThan(1);
      const pieces = offsetCubics(c, d);
      expect(pieces.length).toBeGreaterThan(1);
      const r = gapRange(pieces, [c]);
      expect(r.min).toBeGreaterThan(TRACK_GAP - 0.2);
      expect(r.max).toBeLessThan(TRACK_GAP + 0.2);
      // Куски стыкуются концами.
      for (let i = 1; i < pieces.length; i++) expect(dist(pieces[i].p0, pieces[i - 1].p3)).toBeLessThan(1e-9);
    }
  });

  it('от тупика до тупика вдоль дуги: новый путь — копия дуги сбоку, а не своя кривая между концами', () => {
    const game = dryGame();
    // Дуга ~43° длиной ~830 м — как её кладёт инструмент «дугой».
    const { curves, built: old } = layCurves(game, (at) => [arcCubic(at(0, 0), sub(at(1, 0), at(0, 0)), at(760, 300))!]);
    const L = lengthOf(curves);
    const { t: t0 } = pointAlong(curves, 0);
    const { p: end, t: t1 } = pointAlong(curves, L);
    // Начало — напротив первого тупика, конец — напротив второго, с внешней стороны дуги (курсор — мимо).
    const a = besideTrack(game.net, add(add(curves[0].p0, scale(rightNormal(t0), -TRACK_GAP - 1)), scale(t0, 2)), 0, 8)!;
    const b = besideTrack(game.net, add(add(end, scale(rightNormal(t1), -TRACK_GAP + 1)), scale(t1, -2)), 0, 8)!;
    expect(a?.end).toBe(true);
    expect(b?.end).toBe(true);
    // Раньше инструмент клал кривую с касательными вдоль пути на концах: посередине она отходила от дуги.
    const h = dist(a.pos, b.pos) * 0.4;
    const before = gapRange([{ p0: a.pos, p1: add(a.pos, scale(t0, h)), p2: sub(b.pos, scale(t1, h)), p3: b.pos }], old);
    expect(before.max - TRACK_GAP).toBeGreaterThan(3);

    const pieces = besideRun(game.net, a.pos, b, 0)!;
    expect(pieces).not.toBeNull();
    expect(pieces[0].p0).toEqual(a.pos);
    expect(pieces[pieces.length - 1].p3).toEqual(b.pos);
    const r = gapRange(buildPieces(game, pieces), old);
    expect(r.min).toBeGreaterThan(TRACK_GAP - 0.3);
    expect(r.max).toBeLessThan(TRACK_GAP + 0.3);
  });

  it('вдоль S-образного пути из двух участков, от середины к середине в обе стороны: расстояние постоянно', () => {
    const game = dryGame();
    const { curves, built: old } = layCurves(game, sCurve);
    for (const [s0, s1] of [
      [150, 900],
      [900, 150],
    ]) {
      for (const k of [1, -1]) {
        const a = besideTrack(game.net, beside(curves, s0, k), 0, 8)!;
        const b = besideTrack(game.net, beside(curves, s1, k), 0, 8)!;
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        const pieces = besideRun(game.net, a.pos, b, 0)!;
        expect(pieces).not.toBeNull();
        expect(pieces.length).toBeGreaterThan(1);
        const r = gapRange(pieces, old);
        expect(r.min).toBeGreaterThan(TRACK_GAP - 0.3);
        expect(r.max).toBeLessThan(TRACK_GAP + 0.3);
        // Каждый кусок встаёт: не слишком близко к пути и не короче наименьшего участка.
        for (const c of pieces) expect(game.builder.plan(along(c)).reason ?? 'ok').toBe('ok');
      }
    }
    // Начало и конец с разных сторон — не вдоль: путь кладётся как обычно.
    const a = besideTrack(game.net, beside(curves, 150, 1), 0, 8)!;
    const b = besideTrack(game.net, beside(curves, 900, -1), 0, 8)!;
    expect(besideRun(game.net, a.pos, b, 0)).toBeNull();
    // Продолжаем путь, который уходит поперёк соседнего, — тоже нет.
    const b2 = besideTrack(game.net, beside(curves, 900, 1), 0, 8)!;
    expect(besideRun(game.net, a.pos, b2, 0, rightNormal(pointAlong(curves, 150).t))).toBeNull();
    expect(besideRun(game.net, a.pos, b2, 0, pointAlong(curves, 150).t)).not.toBeNull();
  });

  it('«Пристроить» вдоль поворота с меняющейся кривизной: новый путь на междупутье по всей длине, с обеих сторон', () => {
    for (const k of [1, -1]) {
      const game = dryGame();
      const { curves, built: old } = layCurves(game, hook);
      const before = new Set(game.net.segments.keys());
      // Зажали на пути у начала, отпустили у конца — сбоку со стороны k.
      const from = pointAlong(curves, 20).p;
      const to = beside(curves, lengthOf(curves) - 20, k * 1.5);
      expect(game.parallelTrackPlan(from, to, 14).reason ?? 'ok').toBe('ok');
      expect(game.buildParallelTrack(from, to, 14)).toBeNull();
      const built = [...game.net.segments.values()].filter((s) => !before.has(s.id)).map((s) => s.curve);
      // Один участок — несколькими кусками: одна сдвинутая кривая отошла бы посередине.
      expect(built.length).toBeGreaterThan(1);
      const r = gapRange(built, old);
      expect(r.min).toBeGreaterThan(TRACK_GAP - 0.3);
      expect(r.max).toBeLessThan(TRACK_GAP + 0.3);
    }
  });
});
