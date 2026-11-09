import { describe, expect, it } from 'vitest';
import { add, dist, scale, type Vec } from '../core/vec';
import { Game } from '../game/game';
import { RoadTools } from '../input/roadtools';
import type { Corridor, LaneNet } from '../lanes/model';
import type { Industry } from './entities';
import { ROAD_CLASSES, specCost } from './roadTypes';
import { DEFAULT_SETTINGS } from './settings';
import { pointInFootprint } from './spatial';
import { DIRT_SPEC, layStartRoads, START_ROADS } from './startRoads';
import type { WorldContext } from './worldgen';

const dirtOf = (net: LaneNet) => [...net.corridors.values()].filter((c) => c.cls === 'dirt');
const onEdge = (game: Game, p: Vec) => p.x < 1 || p.y < 1 || p.x > game.terrain.width - 1 || p.y > game.terrain.height - 1;
/** Просёлки, уходящие за край карты: одним концом — на краю. */
const edgeRoads = (game: Game) => dirtOf(game.roads.net).filter((c) => onEdge(game, c.curve.p0) || onEdge(game, c.curve.p3));

/** Середины стен предприятия и наружные нормали. */
function sides(ind: Industry): { n: Vec; half: number }[] {
  const u = { x: Math.cos(ind.fp.angle), y: Math.sin(ind.fp.angle) };
  const v = { x: -u.y, y: u.x };
  return [
    { n: u, half: ind.fp.w / 2 },
    { n: scale(u, -1), half: ind.fp.w / 2 },
    { n: v, half: ind.fp.h / 2 },
    { n: scale(v, -1), half: ind.fp.h / 2 },
  ];
}

/** Сторона предприятия, у которой кончается просёлок (тупик у выезда грузового двора), — или null. */
function roadSide(game: Game, ind: Industry): { n: Vec; half: number; node: number } | null {
  const net = game.roads.net;
  for (const s of sides(ind)) {
    const exit = add(ind.fp.center, scale(s.n, s.half + START_ROADS.industryExit));
    const node = net.nodesNear(exit, 2).find((n) => net.isDeadEnd(n) && n.corridors.some((id) => net.corridor(id).cls === 'dirt'));
    if (node) return { ...s, node: node.id };
  }
  return null;
}

/** Дошли ли от узла по дорогам до улиц города (не грунтовых). */
function reachesStreet(net: LaneNet, from: number): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.pop()!;
    for (const cid of net.node(id).corridors) {
      const c = net.corridor(cid);
      if (c.cls !== 'dirt') return true;
      const other = c.a === id ? c.b : c.a;
      if (!seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return false;
}

describe('Стартовые просёлки', { timeout: 60_000 }, () => {
  it('грунтовая — самая дешёвая и самая медленная дорога', () => {
    const others = (['street', 'avenue', 'highway', 'motorway'] as const).map((cls) => ROAD_CLASSES[cls]);
    expect(others.every((c) => c.cost > ROAD_CLASSES.dirt.cost && c.limit > ROAD_CLASSES.dirt.limit)).toBe(true);
    expect(specCost(DIRT_SPEC)).toBeLessThan(specCost({ cls: 'street', lanesF: 1, lanesB: 1 }));
  });

  it('по seed — одни и те же; дорога — к части предприятий, от них — к улицам города', () => {
    const shape = (g: Game) => dirtOf(g.roads.net).map((c) => [c.curve.p0, c.curve.p3].map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join('>'));
    for (const seed of [1, 5]) {
      const game = new Game(seed);
      expect(shape(game)).toEqual(shape(new Game(seed)));
      const served = game.industries.filter((i) => roadSide(game, i));
      expect(served.length).toBeGreaterThan(game.industries.length / 5);
      expect(served.length).toBeLessThan(game.industries.length);
      for (const ind of served) expect(reachesStreet(game.roads.net, roadSide(game, ind)!.node)).toBe(true);
    }
  });

  it('у городов близко к краю — дорога за край карты: от улиц города прямо до края', () => {
    let found = 0;
    for (const seed of [1, 2, 3]) {
      const game = new Game(seed);
      const net = game.roads.net;
      for (const c of edgeRoads(game)) {
        const end = onEdge(game, c.curve.p0) ? net.node(c.a) : net.node(c.b);
        expect(net.isDeadEnd(end)).toBe(true);
        expect(reachesStreet(net, end.id)).toBe(true);
        // Ближний город — у края: от его застройки до края не дальше предела.
        const town = game.towns.reduce((b, t) => (dist(t.center, end.pos) < dist(b.center, end.pos) ? t : b));
        expect(dist(town.center, end.pos) - (town.extent ?? town.radius)).toBeLessThan(START_ROADS.edgeReach);
        found++;
      }
      // Город далеко от всех краёв — без такой дороги.
      const W = game.terrain.width;
      const H = game.terrain.height;
      const far = game.towns.filter((t) => Math.min(t.center.x, t.center.y, W - t.center.x, H - t.center.y) - (t.extent ?? t.radius) > START_ROADS.edgeReach);
      for (const t of far) expect(edgeRoads(game).some((c) => dist(c.curve.p0, t.center) < (t.extent ?? t.radius) + 50)).toBe(false);
    }
    expect(found).toBeGreaterThanOrEqual(6);
  });

  it('не по воде, не через дома и предприятия; сеть без оборванных полос', () => {
    for (const seed of [1, 2, 3, 4]) {
      const game = new Game({ ...DEFAULT_SETTINGS, seed, relief: 'hills' });
      const net = game.roads.net;
      expect(net.problems()).toEqual([]);
      for (const c of dirtOf(net)) {
        for (let s = 10; s < c.length - 10; s += 10) {
          const p = c.lut.pointAt(s);
          if (!game.terrain.inBounds(p, 1)) continue;
          expect(game.isWater(p, 4)).toBe(false);
          expect(game.index.near(p, 60).some((it) => pointInFootprint(p, it.fp, 6))).toBe(false);
        }
      }
    }
  });

  it('мир под ними тот же: города, предприятия и случайность партии от просёлков не зависят', () => {
    const game = new Game(3);
    const ctx = game['worldContext']() as WorldContext;
    const net = game.roads.net;
    for (const c of dirtOf(net)) net.removeCorridor(c.id);
    const banned = new Proxy(ctx.rng, {
      get() {
        throw new Error('просёлки не берут случайность партии');
      },
    });
    layStartRoads({ ...ctx, rng: banned }, game.towns, game.industries, game.seed);
    expect(dirtOf(net).length).toBeGreaterThan(0);
  });

  it('грузовой двор с той стороны, куда подходит просёлок, сам к нему подключается', () => {
    const game = new Game(1);
    game.money = 5_000_000;
    let checked = 0;
    for (const ind of game.industries) {
      const side = roadSide(game, ind);
      if (!side) continue;
      const st = game.placeStation(add(ind.fp.center, scale(side.n, side.half + 20)), 14);
      expect(st?.industryId).toBe(ind.id);
      const net = game.roads.net;
      // Выезд двора — продолжение просёлка: от станции по дорогам — до улиц города.
      expect(net.nodes.has(side.node)).toBe(true);
      expect(net.node(side.node).corridors.length).toBe(2);
      expect(reachesStreet(net, st!.nodeId)).toBe(true);
      if (++checked >= 3) break;
    }
    expect(checked).toBe(3);
  });

  it('игрок перестраивает и сносит просёлок, как обычную дорогу; дорогу за край — тоже', () => {
    const game = new Game(1);
    game.money = 5_000_000;
    const tools = new RoadTools(() => game);
    const net = () => game.roads.net;
    const edge = edgeRoads(game)[0];
    const mid = edge.lut.pointAt(edge.length / 2);
    expect(tools.upgrade(mid, { cls: 'highway', lanesF: 1, lanesB: 1 }, 6)).toBeNull();
    const now = [...net().corridors.values()].find((c) => c.lut.closest(mid).d < 1)!;
    expect(now.cls).toBe('highway');
    expect(onEdge(game, now.curve.p0) || onEdge(game, now.curve.p3)).toBe(true);
    // Снос рамкой: просёлок к предприятию уходит, деньги — половина его цены.
    const road = dirtOf(net()).find((c) => c.length > 200 && !onEdge(game, c.curve.p0) && !onEdge(game, c.curve.p3)) as Corridor;
    const p = road.lut.pointAt(road.length / 2);
    const before = game.money;
    expect(game.bulldozeArea(add(p, { x: -8, y: -8 }), add(p, { x: 8, y: 8 }))).toBe(true);
    expect(net().corridors.has(road.id)).toBe(false);
    expect(game.money).toBeGreaterThan(before);
  });

  it('сохраняются вместе с дорогами; партия без них (старое сохранение) открывается без них', () => {
    const game = new Game(2);
    const count = dirtOf(game.roads.net).length;
    expect(count).toBeGreaterThan(0);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(save.settings, save);
    expect(dirtOf(loaded.roads.net).length).toBe(count);
    expect(loaded.roads.net.corridors.size).toBe(game.roads.net.corridors.size);
    // Старая партия: сеть до просёлков — после загрузки их и нет, мир по seed не достраивается.
    for (const c of dirtOf(game.roads.net)) game.roads.net.removeCorridor(c.id);
    for (const n of [...game.roads.net.nodes.values()]) if (!n.corridors.length) game.roads.net.removeNode(n.id);
    const old = JSON.parse(JSON.stringify(game.toSave()));
    const reopened = new Game(old.settings, old);
    expect(dirtOf(reopened.roads.net)).toHaveLength(0);
    expect(reopened.towns.length).toBe(game.towns.length);
  });
});
