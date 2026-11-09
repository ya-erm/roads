import { describe, expect, it } from 'vitest';
import { add, dist, scale, type Vec } from '../core/vec';
import { Game } from '../game/game';
import { freshGame } from '../game/testkit';
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
/** Дороги, уходящие за край карты: одним концом — на краю. */
const edgeRoads = (game: Game) => [...game.roads.net.corridors.values()].filter((c) => onEdge(game, c.curve.p0) || onEdge(game, c.curve.p3));
/** Все стартовые дороги: просёлки и шоссе за край. */
const startOf = (game: Game) => [...dirtOf(game.roads.net), ...edgeRoads(game)];

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

/** Дошли ли от узла по дорогам до улиц города (улица или проспект). */
function reachesStreet(net: LaneNet, from: number): boolean {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const id = queue.pop()!;
    for (const cid of net.node(id).corridors) {
      const c = net.corridor(cid);
      if (c.cls === 'street' || c.cls === 'avenue') return true;
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
    const shape = (g: Game) => startOf(g).map((c) => [c.curve.p0, c.curve.p3].map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join('>'));
    for (const seed of [1, 5]) {
      const game = freshGame(seed);
      // Вторая партия — заново генерацией, не копией.
      expect(shape(game)).toEqual(shape(new Game(seed)));
      const served = game.industries.filter((i) => roadSide(game, i));
      expect(served.length).toBeGreaterThan(game.industries.length / 5);
      expect(served.length).toBeLessThan(game.industries.length);
      for (const ind of served) expect(reachesStreet(game.roads.net, roadSide(game, ind)!.node)).toBe(true);
    }
  });

  it('у городов близко к краю — шоссе 1+1 за край карты: от улиц города перекрёстком, прямо до края', () => {
    let found = 0;
    for (const seed of [1, 2, 3]) {
      const game = freshGame(seed);
      const net = game.roads.net;
      for (const c of edgeRoads(game)) {
        expect(c.cls).toBe('highway');
        expect(c.lanes).toHaveLength(2);
        expect(c.limit ?? ROAD_CLASSES[c.cls].limit).toBe(90);
        const end = onEdge(game, c.curve.p0) ? net.node(c.a) : net.node(c.b);
        const start = end.id === c.a ? net.node(c.b) : net.node(c.a);
        expect(net.isDeadEnd(end)).toBe(true);
        // К городу — перекрёстком, а не продолжением тупика улицы.
        expect(start.kind).toBe('junction');
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
      for (const c of startOf(game)) {
        for (let s = 10; s < c.length - 10; s += 10) {
          const p = c.lut.pointAt(s);
          if (!game.terrain.inBounds(p, 1)) continue;
          expect(game.isWater(p, 4)).toBe(false);
          expect(game.index.near(p, 60).some((it) => pointInFootprint(p, it.fp, 6))).toBe(false);
        }
      }
    }
  });

  it('тупики улиц остаются тупиками: машинам есть где развернуться, не уезжая в конец просёлка', () => {
    for (const seed of [1, 7]) {
      const game = freshGame(seed);
      const net = game.roads.net;
      for (const n of net.nodes.values()) {
        const cls = n.corridors.map((id) => net.corridor(id).cls);
        // Просёлок и шоссе за край примыкают к улице только перекрёстком — не продолжают её тупик стыком.
        if ((cls.includes('dirt') || cls.includes('highway')) && cls.some((c) => c === 'street' || c === 'avenue')) expect(n.kind).toBe('junction');
      }
    }
  });

  it('мир под ними тот же: города, предприятия и случайность партии от просёлков не зависят', () => {
    const game = freshGame(3);
    const ctx = game['worldContext']() as WorldContext;
    const net = game.roads.net;
    for (const c of startOf(game)) net.removeCorridor(c.id);
    const banned = new Proxy(ctx.rng, {
      get() {
        throw new Error('просёлки не берут случайность партии');
      },
    });
    layStartRoads({ ...ctx, rng: banned }, game.towns, game.industries, game.seed);
    expect(dirtOf(net).length).toBeGreaterThan(0);
    expect(edgeRoads(game).length).toBeGreaterThan(0);
  });

  it('грузовой двор с той стороны, куда подходит просёлок, встаёт напротив него и сам к нему подключается', () => {
    const game = freshGame(1);
    game.money = 5_000_000;
    let checked = 0;
    for (const ind of game.industries) {
      const side = roadSide(game, ind);
      if (!side) continue;
      // Курсор — не посередине стены, а ближе к углу (по очереди к разным): двор всё равно встаёт напротив просёлка.
      const along = side.half === ind.fp.w / 2 ? ind.fp.h : ind.fp.w;
      const shift = scale({ x: -side.n.y, y: side.n.x }, (checked % 2 ? 0.3 : -0.3) * along);
      const st = game.placeStation(add(add(ind.fp.center, scale(side.n, side.half + 20)), shift), 14);
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

  it('игрок перестраивает и сносит просёлок, как обычную дорогу; шоссе за край — тоже', () => {
    const game = freshGame(1);
    game.money = 5_000_000;
    const tools = new RoadTools(() => game);
    const net = () => game.roads.net;
    const edge = edgeRoads(game)[0];
    const mid = edge.lut.pointAt(edge.length / 2);
    expect(tools.upgrade(mid, { cls: 'highway', lanesF: 2, lanesB: 2 }, 6)).toBeNull();
    const now = [...net().corridors.values()].find((c) => c.lut.closest(mid).d < 1)!;
    expect(now.cls).toBe('highway');
    expect(now.lanes).toHaveLength(4);
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
    const game = freshGame(2);
    const count = startOf(game).length;
    expect(count).toBeGreaterThan(0);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(save.settings, save);
    expect(startOf(loaded).length).toBe(count);
    expect(loaded.roads.net.corridors.size).toBe(game.roads.net.corridors.size);
    // Старая партия: сеть до стартовых дорог — после загрузки их и нет, мир по seed не достраивается.
    for (const c of startOf(game)) game.roads.net.removeCorridor(c.id);
    for (const n of [...game.roads.net.nodes.values()]) if (!n.corridors.length) game.roads.net.removeNode(n.id);
    const old = JSON.parse(JSON.stringify(game.toSave()));
    const reopened = new Game(old.settings, old);
    expect(startOf(reopened)).toHaveLength(0);
    expect(reopened.towns.length).toBe(game.towns.length);
  });
});
