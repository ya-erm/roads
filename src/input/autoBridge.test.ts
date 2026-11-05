import { describe, expect, it } from 'vitest';
import { minRadius } from '../core/bezier';
import { angleOf, dist, Vec } from '../core/vec';
import type { DrawMode } from '../game/build';
import { Game } from '../game/game';
import type { RoadPlan } from '../game/roadbuild';
import { road, roadPlan } from '../game/testkit';
import { type Corridor, type LaneNet, twoWay } from '../lanes/model';
import { RoadTools } from './roadtools';

const SPEC = { cls: 'highway' as const, lanesF: 1, lanesB: 1 };
const HIGHWAY = { cls: 'highway' as const, lanes: twoWay(1, 1) };

/** Прямая дорога на запад от тупика end: от него ведём дальше. */
function deadEnd(game: Game): Vec {
  for (let y = 400; y < game.terrain.height - 600; y += 120) {
    for (let x = 300; x < game.terrain.width - 900; x += 160) {
      const end = { x: x + 200, y };
      const far = { x: end.x + 320, y: end.y + 140 };
      if (!road(game, { free: { x, y } }, { free: end }, HIGHWAY)) continue;
      if (roadPlan(game, end, { free: far }, { ...HIGHWAY, arc: true }).ok) return end;
    }
  }
  throw new Error('нет места');
}

/** Новые полотна плана по порядку от точки from и уровни их узлов. */
function freshPath(before: LaneNet, plan: RoadPlan, from: Vec): Corridor[] {
  const net = plan.net!;
  const fresh = [...net.corridors.values()].filter((c) => !before.corridors.has(c.id));
  const out: Corridor[] = [];
  let cur = from;
  for (;;) {
    const c = fresh.find((x) => !out.includes(x) && (dist(x.curve.p0, cur) < 2 || dist(x.curve.p3, cur) < 2));
    if (!c) break;
    out.push(c);
    cur = dist(c.curve.p0, cur) < 2 ? c.curve.p3 : c.curve.p0;
  }
  return out;
}

/** Наибольшее отклонение оси path от оси ref, м. */
function deviation(path: Corridor[], ref: Corridor[]): number {
  let worst = 0;
  for (const c of path) {
    for (let i = 0; i <= 40; i++) {
      const p = c.lut.pointAt((c.length * i) / 40);
      worst = Math.max(worst, Math.min(...ref.map((r) => r.lut.closest(p).d)));
    }
  }
  return worst;
}

/** Наибольший излом оси на стыках кусков, градусы. */
function worstKink(path: Corridor[]): number {
  let worst = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    // Куски идут по порядку: конец одного — начало другого (концы могли лечь в другую сторону).
    const aEnd = dist(a.curve.p3, b.curve.p0) < 2 || dist(a.curve.p3, b.curve.p3) < 2 ? a.length : 0;
    const bStart = dist(b.curve.p0, aEnd ? a.curve.p3 : a.curve.p0) < 2 ? 0 : b.length;
    const ta = a.lut.tangentAt(aEnd);
    const tb = b.lut.tangentAt(bStart);
    const da = aEnd ? ta : { x: -ta.x, y: -ta.y };
    const db = bStart ? { x: -tb.x, y: -tb.y } : tb;
    let d = Math.abs(angleOf(da) - angleOf(db));
    if (d > Math.PI) d = Math.PI * 2 - d;
    worst = Math.max(worst, (d * 180) / Math.PI);
  }
  return worst;
}

describe('«Авто»: мост не меняет форму дороги в плане', () => {
  const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 500_000_000, water: 'dry' });
  const end = deadEnd(game);
  // Овраг поперёк будущей дороги: на 25 м ниже, шириной ~120 м — по земле не пройти, нужен мост с пандусами.
  const mid = { x: end.x + 170, y: end.y + 40 };
  game.ground = () => (p: Vec) => -25 * Math.exp(-(((p.x - mid.x) / 60) ** 2));
  const far = { x: end.x + 320, y: end.y + 140 };
  const control = { x: end.x + 200, y: end.y - 20 };

  const plans = (mode: DrawMode) => {
    const rt = new RoadTools(() => game);
    rt.begin(end, 10);
    if (mode === 'curve') rt.control = control;
    rt.auto = false;
    const ground = rt.buildPlan(far, SPEC, mode, 10, false)!;
    rt.auto = true;
    const auto = rt.buildPlan(far, SPEC, mode, 10, false)!;
    return { rt, ground, auto };
  };

  for (const mode of ['arc', 'curve', 'straight'] as const) {
    it(`${mode}: ось с мостом — та же, что без моста; на стыках пандусов нет изломов`, () => {
      const { rt, ground, auto } = plans(mode);
      expect(ground.net).not.toBeNull();
      expect(auto.ok).toBe(true);
      expect(rt.autoInfo!.bridge).toBeGreaterThan(0);
      const before = game.roads.net;
      const g = freshPath(before, ground, end);
      const a = freshPath(before, auto, end);
      // Мост с пандусами — несколько кусков, концы — те же.
      expect(a.length).toBeGreaterThan(2);
      const levels = new Set(a.flatMap((c) => [auto.net!.node(c.a).level, auto.net!.node(c.b).level]));
      expect(levels.has(1)).toBe(true);
      expect(deviation(a, g)).toBeLessThan(0.3);
      expect(worstKink(a)).toBeLessThan(0.5);
      // Поворот на пандусах не круче, чем у той же дороги без моста (раньше на съезде радиус падал в разы).
      const radius = (cs: Corridor[]) => Math.min(...cs.map((c) => minRadius(c.curve)));
      expect(radius(a)).toBeGreaterThanOrEqual(radius(g) * 0.98);
    });
  }
});
