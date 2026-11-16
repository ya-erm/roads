import { describe, expect, it } from 'vitest';
import { add, scale, type Vec } from '../core/vec';
import { RAIL_SPEC } from '../world/roadTypes';
import { MAP_SCALE, MAP_SIZES } from '../world/settings';
import type { RoadRequest, Snap } from './build';
import { Game } from './game';
import { clearStrip, freshGame, withoutCitizens } from './testkit';

/** Партия на карте нового размера (×MAP_SCALE), без воды, денег с запасом. */
const bigGame = () => withoutCitizens(freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 90_000_000, water: 'dry', mapScale: MAP_SCALE }));

/** Чистая полоса длиной len с запада на восток — правее старого края карты (x больше прежней ширины). */
function eastSpot(game: Game, len: number): Vec {
  for (let y = 500; y < game.terrain.height - 500; y += 150) {
    for (let x = MAP_SIZES.small.w + 200; x < game.terrain.width - len - 300; x += 200) {
      if (clearStrip(game, { x, y }, { x: x + len, y }, 120)) return { x, y };
    }
  }
  throw new Error('нет места');
}

/** Путь с запада на восток через точки на расстояниях marks от from, на высотах levels; узлы — подряд. */
function layChain(game: Game, from: Vec, marks: number[], levels: number[]): void {
  let start: Snap = { kind: 'free', pos: add(from, { x: marks[0], y: 0 }), level: levels[0] };
  for (let i = 1; i < marks.length; i++) {
    const end: Snap = { kind: 'free', pos: add(from, { x: marks[i], y: 0 }), level: levels[i] };
    const req: RoadRequest = { start, end, spec: RAIL_SPEC, mode: 'straight' };
    expect(game.builder.plan(req).reason ?? 'ok').toBe('ok');
    const res = game.builder.build(req)!;
    expect(res).not.toBeNull();
    start = { kind: 'node', nodeId: res.endNode, pos: game.net.node(res.endNode).pos, level: levels[i] };
  }
}

const at = (from: Vec, s: number, side = 0): Vec => add(from, { x: s, y: side });

describe('Пристроить путь рядом', () => {
  it('на карте нового размера: мост дальше по той же цепочке не мешает, на самом мосту и подъёме — своя причина', () => {
    const game = bigGame();
    const from = eastSpot(game, 2600);
    expect(from.x).toBeGreaterThan(MAP_SIZES.small.w);
    // Земля 0…1000 м, подъём на мост 1000…1600, мост 1600…2000, спуск 2000…2600.
    layChain(game, from, [0, 1000, 1600, 2000, 2600], [0, 0, 1, 1, 0]);
    const before = game.net.segments.size;
    // На земле — пристраивается, хотя дальше по цепочке без стрелок мост.
    const a = at(from, 100);
    const b = at(from, 900, 20);
    expect(game.parallelTrackPlan(a, b, 14).reason ?? 'ok').toBe('ok');
    expect(game.buildParallelTrack(a, b, 14)).toBeNull();
    expect(game.net.segments.size).toBeGreaterThan(before);
    const side = game.net.findSegmentNear(at(from, 500, 13), 4, (s) => s.spec.cls === 'rail');
    expect(side?.d ?? Infinity).toBeLessThan(1);
    // Новый путь — на земле.
    expect(game.net.node(side!.seg.a).level).toBe(0);
    expect(game.net.node(side!.seg.b).level).toBe(0);
    // Захватили подъём — понятная причина; на мосту — «только на земле».
    expect(game.parallelTrackPlan(at(from, 1100), at(from, 1500, -20), 14).reason).toBe('Пристроить путь нельзя на подъёме к мосту');
    expect(game.parallelTrackPlan(at(from, 1650), at(from, 1950, -20), 14).reason).toBe('Пристроить путь — только на земле');
  });

  it('тоннель дальше по цепочке не мешает; на спуске в тоннель и в нём — своя причина', () => {
    const game = bigGame();
    const from = eastSpot(game, 2600);
    // Холм над тоннелем: земля 0…1000 м ровная, дальше поднимается — тоннель под ним.
    game.ground = () => (p: Vec) => 20 + Math.max(0, Math.min(p.x - from.x - 1000, 2600 - (p.x - from.x)) * 0.03);
    layChain(game, from, [0, 1000, 1600, 2000, 2600], [0, 0, -1, -1, 0]);
    expect(game.parallelTrackPlan(at(from, 100), at(from, 900, 20), 14).reason ?? 'ok').toBe('ok');
    expect(game.parallelTrackPlan(at(from, 1100), at(from, 1500, -20), 14).reason).toBe('Пристроить путь нельзя на спуске в тоннель');
    expect(game.parallelTrackPlan(at(from, 1650), at(from, 1950, -20), 14).reason).toBe('Пристроить путь нельзя в тоннеле');
  });

  it('на склоне с уклоном в пределах допустимого для путей — пристраивается', () => {
    const game = bigGame();
    const from = eastSpot(game, 1200);
    // Земля поднимается на 2,5% к востоку (у путей можно до 3,5%).
    game.ground = () => (p: Vec) => 20 + 0.025 * (p.x - from.x);
    layChain(game, from, [0, 1200], [0, 0]);
    const plan = game.parallelTrackPlan(at(from, 100), at(from, 1100, -20), 14);
    expect(plan.reason ?? 'ok').toBe('ok');
    expect(game.buildParallelTrack(at(from, 100), at(from, 1100, -20), 14)).toBeNull();
    expect(game.net.findSegmentNear(add(at(from, 600), scale({ x: 0, y: -1 }, 13)), 4, (s) => s.spec.cls === 'rail')?.d ?? Infinity).toBeLessThan(1);
  });
});
