import { describe, expect, it } from 'vitest';
import { TOWN_SCALE } from '../config';
import { Rng } from '../core/rng';
import { dist } from '../core/vec';
import { Game } from '../game/game';
import { asphaltEdgesAt } from '../lanes/geometry';
import { laneSpeed } from '../lanes/graph';
import { LaneNet, profileOf, twoWay, type Corridor } from '../lanes/model';
import type { Structure, Town, TownStyle } from './entities';
import { halfWidth, KMH_PER_UNIT, ROAD_PRESETS, specKmh } from './roadTypes';
import { DEFAULT_SETTINGS } from './settings';
import { FootprintIndex } from './spatial';
import { Terrain } from './terrain';
import { buildTown } from './worldgen';

const styles = [['linear', 1], ['organic', 2], ['radial', 3]] as const satisfies readonly (readonly [TownStyle, number])[];

/** Сколько улиц города сходится в каждом его узле. */
function degrees(game: Game, town: Town): Map<number, number> {
  const deg = new Map<number, number>();
  for (const id of town.streets) {
    const c = game.roads.net.corridors.get(id);
    if (!c) continue;
    for (const n of [c.a, c.b]) deg.set(n, (deg.get(n) ?? 0) + 1);
  }
  return deg;
}

describe('Улицы города — как у настоящего', { timeout: 60_000 }, () => {
  const games = [1, 2].map((seed) => new Game({ ...DEFAULT_SETTINGS, seed }));
  const towns = games.flatMap((game) => game.towns.map((town) => ({ game, town })));

  it('по seed — те же улицы', () => {
    const again = new Game({ ...DEFAULT_SETTINGS, seed: 1 });
    const shape = (g: Game) => g.towns.map((t) => t.streets.map((id) => g.roads.net.corridor(id).curve));
    expect(shape(again)).toEqual(shape(games[0]));
  });

  it('у кольцевого города кольцо — только площадь в центре: дальше улицы расходятся, а не идут кругами', () => {
    const radial = towns.filter(({ town }) => town.style === 'radial');
    expect(radial.length).toBeGreaterThan(0);
    for (const { game, town } of radial) {
      // Площадь: дуги вокруг ратуши ближе 130 м от центра (в масштабе застройки — TOWN_SCALE).
      const square = town.streets.map((id) => game.roads.net.corridor(id)).filter((c) => [c.curve.p0, c.curve.p3].every((p) => dist(p, town.center) < 130 * TOWN_SCALE));
      expect(square.length).toBeGreaterThanOrEqual(3);
      // Из центра — главные улицы-выезды: узлов дальше полутора сотен метров больше, чем у площади.
      const far = [...degrees(game, town).keys()].filter((id) => dist(game.roads.net.node(id).pos, town.center) > 400 * TOWN_SCALE);
      expect(far.length).toBeGreaterThan(10);
    }
  });

  it('перекрёстки — больше Т-образные, чем кресты; есть тупики', () => {
    let tees = 0;
    let crosses = 0;
    for (const { game, town } of towns) {
      const d = [...degrees(game, town).values()];
      tees += d.filter((x) => x === 3).length;
      crosses += d.filter((x) => x >= 4).length;
      if (town.style !== 'linear') expect(d.filter((x) => x === 1).length).toBeGreaterThanOrEqual(3);
    }
    expect(tees).toBeGreaterThan(crosses * 1.5);
  });

  it('кварталы разной длины: расстояния между соседними перекрёстками не одинаковые', () => {
    for (const { game, town } of towns.filter(({ town }) => town.style !== 'linear')) {
      const lengths = town.streets.map((id) => game.roads.net.corridor(id).length);
      const mean = lengths.reduce((s, l) => s + l, 0) / lengths.length;
      const spread = Math.sqrt(lengths.reduce((s, l) => s + (l - mean) ** 2, 0) / lengths.length) / mean;
      expect(spread).toBeGreaterThan(0.1);
    }
  });

  it('улицы не ближе к чужим, чем нужно под дома с обеих сторон', () => {
    for (const { game, town } of towns) {
      const net = game.roads.net;
      const own = new Set(town.streets);
      for (const id of town.streets) {
        const c = net.corridor(id);
        const mid = c.lut.pointAt(c.length / 2);
        for (const o of net.corridorsNear(mid, 40)) {
          if (!own.has(o.id) || o.id === c.id || [o.a, o.b].some((n) => n === c.a || n === c.b)) continue;
          expect(o.lut.closest(mid).d).toBeGreaterThan(30);
        }
      }
    }
  });
});

describe('Уличная сеть города', () => {
  it.each(styles)('у %s есть основные улицы и подъезды во дворы', (style, size) => {
    const roads = new LaneNet();
    const rng = new Rng(4);
    const terrain = new Terrain(rng, { ...DEFAULT_SETTINGS, size: 'small', water: 'dry' });
    const center = { x: terrain.width / 2, y: terrain.height / 2 };
    let id = 1;
    const town = buildTown({ roads, rng, terrain, index: new FootprintIndex<Structure>(), nextId: () => id++ }, 1, center, 'Город', size, style)!;
    expect(town.population).toBeGreaterThan(0);
    const streets = town.streets.map((sid) => roads.corridor(sid));
    const main = streets.filter((c) => c.cls === 'avenue');
    const yards = streets.filter((c) => c.cls === 'street');
    expect(main.length).toBeGreaterThanOrEqual(2);
    expect(yards.length).toBeGreaterThanOrEqual(1);
    expect(main.every((c) => laneSpeed(c) * KMH_PER_UNIT === 60)).toBe(true);
    expect(yards.every((c) => laneSpeed(c) * KMH_PER_UNIT === 40)).toBe(true);
    expect(yards.every((c) => asphaltEdgesAt(c, c.length / 2)?.[1] === 5.25)).toBe(true);
    const nodes = new Set(main.flatMap((c) => [c.a, c.b]));
    for (const nid of nodes) expect(roads.node(nid).corridors.filter((cid) => roads.corridor(cid).cls === 'street').length).toBeLessThanOrEqual(1);
    const reached = new Set([main[0].a]);
    for (const nid of reached) {
      for (const cid of roads.node(nid).corridors) {
        const c = roads.corridor(cid);
        reached.add(c.a === nid ? c.b : c.a);
      }
    }
    expect(streets.every((c) => reached.has(c.a) && reached.has(c.b))).toBe(true);
    const meanLength = (xs: Corridor[]) => xs.reduce((total, c) => total + c.length, 0) / xs.length;
    expect(meanLength(main)).toBeGreaterThan(meanLength(yards));
    const straight = main.filter((c) => dist(c.curve.p0, c.curve.p3) >= 0.99 * c.length);
    expect(straight.length).toBeGreaterThan(main.length / 2);
    expect(yards.some((c) => !nodes.has(c.a) && !nodes.has(c.b))).toBe(true);
  });

  it('у строителя есть профили 1+1 для дворов и основных улиц', () => {
    const yard = ROAD_PRESETS.find((p) => p.id === 'street')!.spec;
    const main = ROAD_PRESETS.find((p) => p.id === 'main-street')!.spec;
    expect([yard.lanesF, yard.lanesB, main.lanesF, main.lanesB]).toEqual([1, 1, 1, 1]);
    expect([specKmh(yard), specKmh(main)]).toEqual([40, 60]);
    expect([halfWidth(yard), halfWidth(main)]).toEqual([5.25, 8.5]);
    expect(profileOf(yard).lanes.map((l) => l.offset)).toEqual([-2.45, 2.45]);
  });

  it('старые дворы сужаются при загрузке, сквозные полосы на стыке с основной улицей сохраняются', () => {
    const roads = new LaneNet();
    const a = roads.addSeam({ x: 0, y: 0 }, { x: 1, y: 0 });
    const b = roads.addJunction({ x: 100, y: 0 });
    const c = roads.addSeam({ x: 200, y: 0 }, { x: 1, y: 0 });
    const d = roads.addSeam({ x: 300, y: 0 }, { x: 1, y: 0 });
    const plain = roads.addCorridor(a.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
    const atSeam = roads.addCorridor(b.id, c.id, { cls: 'street', lanes: twoWay(1, 1) });
    const main = roads.addCorridor(c.id, d.id, { cls: 'avenue', lanes: twoWay(1, 1) });
    const legacy = roads.toJSON();
    delete legacy.yardWidths;
    const restored = LaneNet.fromJSON(legacy, true);
    expect(restored.corridor(plain.id).lanes.map((l) => l.offset)).toEqual([-2.45, 2.45]);
    expect(restored.across(restored.corridor(atSeam.id), 1, 'b')?.corridor.id).toBe(main.id);
    expect(LaneNet.fromJSON(restored.toJSON(), true).toJSON()).toEqual(restored.toJSON());
  });
});
