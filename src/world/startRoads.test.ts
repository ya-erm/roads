import { describe, expect, it } from 'vitest';
import { add, dist, scale, type Vec } from '../core/vec';
import { Game } from '../game/game';
import { fieldSpot, freshGame } from '../game/testkit';
import { RoadTools } from '../input/roadtools';
import { asphaltEdgesAt } from '../lanes/geometry';
import { LaneNet, profileOf, twoWay, type Corridor } from '../lanes/model';
import type { Industry } from './entities';
import { industryAccess } from './industrySites';
import { halfWidth, ROAD_CLASSES, ROAD_PRESETS, specCost, specKmh } from './roadTypes';
import { DEFAULT_SETTINGS } from './settings';
import { footprintSide, pointInFootprint } from './spatial';
import { DIRT_SPEC, EDGE_SPEC, layStartRoads, START_ROADS } from './startRoads';
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
function roadSide(game: Game, ind: Industry): { n: Vec; anchor: Vec; node: number } | null {
  const net = game.roads.net;
  const fp = ind.fp;
  const candidates = sides(ind).map((s) => ({ n: s.n, anchor: add(fp.center, scale(s.n, fp.parts ? footprintSide(fp, s.n) : s.half)) }));
  if (fp.groundParts) {
    const n = candidates[0].n;
    candidates.unshift({ n, anchor: add(industryAccess(fp, ind.info.kind), scale(n, 1.4)) });
  }
  for (const s of candidates) {
    const exit = add(s.anchor, scale(s.n, START_ROADS.industryExit));
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

  it('обычная грунтовка и дворовый проезд одинаково узкие, у других профилей грунтовки обычные полосы', () => {
    const dirt = ROAD_PRESETS.find((p) => p.id === 'dirt')!.spec;
    const yard = ROAD_PRESETS.find((p) => p.id === 'street')!.spec;
    expect(halfWidth(dirt)).toBe(5.25);
    expect(profileOf(dirt).lanes).toEqual(profileOf(yard).lanes);
    expect(profileOf(dirt).lanes.map((l) => l.offset)).toEqual([-2.45, 2.45]);
    expect(specKmh(dirt)).toBe(30);
    expect(specKmh({ ...dirt, limit: 40 })).toBe(40);
    expect(profileOf({ ...dirt, lanesF: 2 }).lanes).toEqual(twoWay(2, 1));
    expect(halfWidth({ ...dirt, lanesB: 0 })).toBe(5);
  });

  it('по seed — одни и те же; дорога — к части предприятий, от них — к улицам города', () => {
    const shape = (g: Game) => startOf(g).map((c) => [c.curve.p0, c.curve.p3].map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join('>'));
    for (const seed of [1, 5]) {
      const game = freshGame(seed);
      // Вторая партия — заново генерацией, не копией.
      expect(shape(game)).toEqual(shape(new Game(seed)));
      for (const c of dirtOf(game.roads.net)) expect(asphaltEdgesAt(c, c.length / 2)).toEqual([-5.25, 5.25]);
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
      const shift = scale({ x: -side.n.y, y: side.n.x }, checked % 2 ? 10 : -10);
      const st = game.placeStation(add(add(side.anchor, scale(side.n, 20)), shift), 14);
      expect(st?.industryId).toBe(ind.id);
      const net = game.roads.net;
      // Выезд двора — продолжение просёлка: от станции по дорогам — до улиц города.
      expect(net.nodes.has(side.node)).toBe(true);
      expect(net.node(side.node).corridors.length).toBe(2);
      expect(reachesStreet(net, st!.nodeId)).toBe(true);
      const approach = net.node(side.node).corridors.map((id) => net.corridor(id)).find((c) => c.cls === 'dirt')!;
      const roadEnd = approach.a === side.node ? approach.b : approach.a;
      expect(game.roads.route(st!.nodeId, roadEnd)).not.toBeNull();
      expect(game.roads.route(roadEnd, st!.nodeId)).not.toBeNull();
      if (++checked >= 3) break;
    }
    expect(checked).toBe(3);
  });

  it('игрок строит и перестраивает узкую грунтовку инструментом дорог', () => {
    const game = freshGame(1);
    const tools = new RoadTools(() => game);
    const a = fieldSpot(game, 200);
    const b = add(a, { x: 200, y: 0 });
    const mid = add(a, { x: 100, y: 0 });
    const corridor = () => game.roads.net.corridorNear(mid, 1)!;
    expect(tools.begin(a, 1)).toBe(true);
    expect(tools.build(b, DIRT_SPEC, 'straight', 1, false)).toBeNull();
    expect(asphaltEdgesAt(corridor(), 100)).toEqual([-5.25, 5.25]);
    expect(tools.upgrade(mid, EDGE_SPEC, 1)).toBeNull();
    expect(asphaltEdgesAt(corridor(), 100)).toEqual([-8.5, 8.5]);
    expect(tools.upgrade(mid, DIRT_SPEC, 1)).toBeNull();
    expect(asphaltEdgesAt(corridor(), 100)).toEqual([-5.25, 5.25]);
    expect(game.roads.net.problems()).toEqual([]);
  });

  it('при загрузке сужаются целые цепочки грунтовки, стык с широкой дорогой сохраняет проезд', () => {
    const roads = new LaneNet();
    const [a, b, d, e] = [0, 100, 300, 400].map((x) => roads.addSeam({ x, y: 0 }, { x: 1, y: 0 }));
    const center = roads.addJunction({ x: 200, y: 0 });
    const dirt = { cls: 'dirt' as const, lanes: twoWay(1, 1), limit: 40 };
    const west = roads.addCorridor(a.id, b.id, dirt);
    const middle = roads.addCorridor(b.id, center.id, dirt);
    const east = roads.addCorridor(center.id, d.id, dirt);
    const highway = roads.addCorridor(d.id, e.id, profileOf(EDGE_SPEC));
    const legacy = roads.toJSON();
    delete legacy.dirtWidths;
    const loaded = LaneNet.fromJSON(legacy, true);
    expect(loaded.corridor(west.id).lanes.map((l) => l.offset)).toEqual([-2.45, 2.45]);
    expect(loaded.corridor(middle.id).limit).toBe(40);
    expect(loaded.across(loaded.corridor(west.id), 1, 'b')?.corridor.id).toBe(middle.id);
    expect(loaded.across(loaded.corridor(east.id), 1, 'b')?.corridor.id).toBe(highway.id);
    expect(loaded.problems()).toEqual([]);
    expect(LaneNet.fromJSON(loaded.toJSON(), true).toJSON()).toEqual(loaded.toJSON());
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
