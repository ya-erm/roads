import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { road, STREET } from '../game/testkit';
import { DEFAULT_SETTINGS } from '../world/settings';
import { buildLaneProfile, curveSpeed, gradeFactor, PROFILE_STEP } from './speedProfile';

const HIGHWAY = { cls: 'highway' as const, lanes: STREET.lanes };

/** Пустой угол карты без воды: дорога строится где угодно. */
function field(): Game {
  return new Game({ ...DEFAULT_SETTINGS, seed: 3, size: 'small', towns: 4, water: 'dry', money: 5_000_000 });
}

function freeSpot(game: Game): { x: number; y: number } {
  const t = game.terrain;
  for (let y = 600; y < t.height - 600; y += 100) {
    for (let x = 600; x < t.width - 900; x += 100) {
      const ok = [0, 150, 300].every((dx) => !t.isWater({ x: x + dx, y }, 120) && !game.blocked({ x: x + dx, y }, 120)) && !game.roads.net.corridorsNear({ x: x + 150, y }, 300).length;
      if (ok) return { x, y };
    }
  }
  throw new Error('нет места');
}

describe('Скорость машин на изгибах и уклонах', () => {
  it('на изгибе дороги скорость ниже разрешённой, и машина тормозит заранее', () => {
    const game = field();
    const o = freeSpot(game);
    // Шоссе с крутым изгибом посередине (радиус около 100 м — меньше, чем нужно для 90 км/ч).
    expect(road(game, { free: o }, { free: { x: o.x + 300, y: o.y } }, { ...HIGHWAY, control: { x: o.x + 150, y: o.y + 220 } })).toBe(true);
    game.roads.changed();
    const graph = game.roads.graph;
    const net = game.roads.net;
    const curved = [...net.corridors.values()].find((c) => c.lut.closest({ x: o.x + 150, y: o.y + 110 }).d < 10)!;
    const lane = [...graph.lanes.values()].find((l) => graph.links.get(l.link)!.corridor === curved.id)!;
    const prof = buildLaneProfile(graph, lane, null);
    const slowest = Math.min(...prof.v);
    expect(slowest).toBeLessThan(lane.speed * 0.9);
    // Перед самым медленным местом скорость спадает постепенно, а не скачком.
    const k = prof.v.indexOf(slowest);
    for (let i = 1; i <= k; i++) expect(prof.v[i - 1] ** 2 - prof.v[i] ** 2).toBeLessThanOrEqual(18 * PROFILE_STEP + 1e-3);
    expect(curveSpeed(12)).toBeLessThan(curveSpeed(150));
  });

  it('уклон по ходу движения: в гору — с плюсом, обратно — с минусом; грузовик в гору теряет больше легковой', () => {
    const game = field();
    const o = freeSpot(game);
    expect(road(game, { free: o }, { free: { x: o.x + 300, y: o.y } }, STREET)).toBe(true);
    game.roads.changed();
    const graph = game.roads.graph;
    const net = game.roads.net;
    const c = [...net.corridors.values()].find((x) => x.lut.closest({ x: o.x + 150, y: o.y }).d < 2)!;
    const lanes = [...graph.lanes.values()].filter((l) => graph.links.get(l.link)!.corridor === c.id);
    // Склон 6% на восток.
    const ground = (p: { x: number; y: number }) => p.x * 0.06;
    const grades = lanes.map((l) => {
      const p = buildLaneProfile(graph, l, ground);
      return { flow: graph.links.get(l.link)!.flow, g: p.g[Math.floor(p.g.length / 2)] };
    });
    const east = c.curve.p3.x > c.curve.p0.x ? 1 : -1;
    for (const { flow, g } of grades) expect(g * flow * east).toBeCloseTo(0.06, 2);
    expect(gradeFactor(0.06, true)).toBeLessThan(gradeFactor(0.06, false));
    expect(gradeFactor(0.06, false)).toBeLessThan(1);
    expect(gradeFactor(0, true)).toBe(1);
  });
});
