import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import type { Vec } from '../core/vec';
import { routeFromNode } from '../sim/routing';
import { Traffic } from '../sim/traffic';
import type { Vehicle } from '../sim/vehicle';
import { laneLinkKey, Network, parseLaneLink, RoadNode, Segment } from '../world/network';
import type { RoadSpec } from '../world/roadTypes';
import { BuildContext, Builder } from './build';
import { Game, LaneEnd } from './game';

const AVENUE: RoadSpec = { cls: 'avenue', lanesF: 2, lanesB: 2 };
const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 30, accel: 10, color: '#888' };

/** Перекрёсток на четыре дороги в городе, перестроенный в проспекты 2+2 — чтобы было из чего выбирать. */
function avenueCrossroads(game: Game): RoadNode {
  const n = [...game.net.nodes.values()].find(
    (x) => x.roundabout === null && x.control === 'none' && game.net.roadSegs(x).length === 4 && x.segments.length === 4,
  )!;
  for (const id of n.segments) game.net.setSpec(id, AVENUE);
  game.networkChanged();
  return n;
}

/** Куда ведёт полоса: id полос выезда. */
const targets = (net: Network, lane: number) => (net.movesFrom.get(lane) ?? []).map((m) => m.outLane).sort((a, b) => a - b);

/** Полоса въезда и полоса выезда, с которой она сейчас не связана. */
function pickPair(game: Game, n: RoadNode): { from: LaneEnd; to: LaneEnd } {
  const ends = game.laneEnds(n.id);
  const from = ends.find((e) => e.kind === 'in' && e.i === 0)!;
  const now = targets(game.net, from.lane);
  const to = ends.find((e) => e.kind === 'out' && from.exits.includes(e.seg) && !now.includes(e.lane))!;
  return { from, to };
}

// Связи полос в игре вернутся на модели полос (этап 4.4) — тогда эти проверки переедут на неё.
describe.skip('Связи полос на перекрёстке', () => {
  it('настроенная полоса едет только по своим связям, остальные — как раньше', () => {
    const game = new Game(7);
    const n = avenueCrossroads(game);
    const { from, to } = pickPair(game, n);
    expect(to).toBeDefined();
    const auto = targets(game.net, from.lane);
    expect(auto.length).toBeGreaterThan(0);
    const neighbour = game.laneEnds(n.id).find((e) => e.kind === 'in' && e.seg === from.seg && e.i === 1)!;
    const neighbourBefore = targets(game.net, neighbour.lane);

    // Первый клик переносит автоматические связи в настройку и добавляет новую.
    expect(game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i)).toBeNull();
    expect(targets(game.net, from.lane)).toEqual([...auto, to.lane].sort((a, b) => a - b));
    // Убираем прежние — остаётся только выбранная.
    for (const id of auto) {
      const out = game.laneEnds(n.id).find((e) => e.kind === 'out' && e.lane === id)!;
      expect(game.toggleLaneConnection(n.id, from.seg, from.i, out.seg, out.i)).toBeNull();
    }
    expect(targets(game.net, from.lane)).toEqual([to.lane]);
    expect(n.lanes).toEqual([laneLinkKey({ inSeg: from.seg, i: from.i, outSeg: to.seg, j: to.i })]);
    expect(game.laneEnds(n.id).find((e) => e.lane === from.lane)!.custom).toBe(true);
    expect(game.junctionInfo(n.id)!.customLanes).toBe(1);
    // Соседняя полоса не настроена — её связи прежние.
    expect(targets(game.net, neighbour.lane)).toEqual(neighbourBefore);
    // Последнюю связь не убрать: полоса без выезда — тупик.
    expect(game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i)).not.toBeNull();
    expect(targets(game.net, from.lane)).toEqual([to.lane]);
    // Обратно в свой же участок (разворот) — нельзя.
    expect(game.toggleLaneConnection(n.id, from.seg, from.i, from.seg, 0)).not.toBeNull();
  });

  it('связи сохраняются вместе с игрой', () => {
    const game = new Game(7);
    const n = avenueCrossroads(game);
    const { from, to } = pickPair(game, n);
    game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i);
    const want = targets(game.net, from.lane);
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.net.node(n.id).lanes).toEqual(n.lanes);
    expect(targets(loaded.net, from.lane)).toEqual(want);
  });

  it('связи переживают разрезание примыкающих участков', () => {
    const game = new Game(7);
    const n = avenueCrossroads(game);
    const { from, to } = pickPair(game, n);
    game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i);
    const count = n.lanes!.length;
    // Разрезаем и участок въезда, и участок выезда; у перекрёстка остаются их новые куски.
    const near = (r: { first: Segment; second: Segment }) => [r.first, r.second].find((s) => s.a === n.id || s.b === n.id)!.id;
    const newIn = near(game.net.splitSegmentDetailed(from.seg, 0.5));
    const newOut = near(game.net.splitSegmentDetailed(to.seg, 0.5));
    game.networkChanged();
    expect(n.lanes!.length).toBe(count);
    expect(n.lanes).toContain(laneLinkKey({ inSeg: newIn, i: from.i, outSeg: newOut, j: to.i }));
    for (const key of n.lanes!) {
      const l = parseLaneLink(key)!;
      expect(n.segments).toContain(l.inSeg);
      expect(n.segments).toContain(l.outSeg);
    }
    const ends = game.laneEnds(n.id);
    const lane = ends.find((e) => e.kind === 'in' && e.seg === newIn && e.i === from.i)!;
    const out = ends.find((e) => e.kind === 'out' && e.seg === newOut && e.i === to.i)!;
    expect(lane.custom).toBe(true);
    expect(ends.filter((e) => e.custom).length).toBe(1);
    expect(targets(game.net, lane.lane)).toContain(out.lane);
    expect(targets(game.net, lane.lane).length).toBe(count);
  });

  it('сброс возвращает автоматические связи', () => {
    const game = new Game(7);
    const n = avenueCrossroads(game);
    const { from, to } = pickPair(game, n);
    const auto = targets(game.net, from.lane);
    game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i);
    expect(targets(game.net, from.lane)).not.toEqual(auto);
    game.resetLanes(n.id);
    expect(n.lanes).toBeUndefined();
    expect(targets(game.net, from.lane)).toEqual(auto);
    expect(game.junctionInfo(n.id)!.customLanes).toBe(0);
  });

  it('новый запрет поворота снимает связи полос в ту сторону', () => {
    const game = new Game(7);
    const n = avenueCrossroads(game);
    const { from, to } = pickPair(game, n);
    game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i);
    game.setJunction(n.id, { bans: [`${from.seg}>${to.seg}`] });
    expect((n.lanes ?? []).some((k) => k.endsWith(`>${to.seg}.${to.i}`) && k.startsWith(`${from.seg}.`))).toBe(false);
    expect(targets(game.net, from.lane).some((id) => game.net.lanes.get(id)!.seg === to.seg)).toBe(false);
  });
});

/** Мир без рельефа и зданий: только сеть, трафик и строитель. */
function makeWorld() {
  const net = new Network();
  const arrived: Vehicle[] = [];
  const lost: Vehicle[] = [];
  const traffic = new Traffic(net, { onArrive: (v) => arrived.push(v), onLost: (v) => lost.push(v) });
  const ctx: BuildContext = {
    net,
    budget: 1e12,
    roundaboutCenters: new Map(),
    isWater: () => false,
    inBounds: () => true,
    blocked: () => false,
    obstaclesAt: () => [],
    demolishCost: () => 0,
    demolish() {},
    spend() {},
    refund() {},
    networkChanged() {
      net.rebuild();
      traffic.validate();
    },
  };
  const builder = new Builder(ctx);
  const road = (a: Vec, b: Vec) => {
    const req = { start: builder.snap(a, 0, 6), end: builder.snap(b, 0, 6), spec: AVENUE, mode: 'straight' as const };
    if (!builder.plan(req).ok) throw new Error('Не строится');
    builder.build(req);
  };
  const nodeAt = (p: Vec) => net.findNodeNear(p, 2)!;
  return { net, traffic, arrived, lost, road, nodeAt, ctx };
}

describe('Движение по настроенным полосам', () => {
  it('машины проезжают перекрёсток по связям, заданным игроком', () => {
    const w = makeWorld();
    const W = { x: 0, y: 300 };
    const E = { x: 600, y: 300 };
    const N = { x: 300, y: 0 };
    const S = { x: 300, y: 600 };
    w.road(W, E);
    w.road(N, S);
    const c = w.nodeAt({ x: 300, y: 300 });
    expect(w.net.roadSegs(c).length).toBe(4);
    // Участок перекрёстка, ведущий к концу дороги в точке p.
    const seg = (p: Vec) => {
      const far = w.nodeAt(p).id;
      return w.net.roadSegs(c).find((id) => w.net.segment(id).a === far || w.net.segment(id).b === far)!;
    };
    const west = seg(W);
    const south = seg(S);
    const east = seg(E);
    // С запада: правая полоса — только прямо, левая — только направо (на юг, в левую полосу).
    c.lanes = [laneLinkKey({ inSeg: west, i: 0, outSeg: east, j: 0 }), laneLinkKey({ inSeg: west, i: 1, outSeg: south, j: 1 })];
    w.net.touch(c.id);
    w.ctx.networkChanged();
    const inLink = w.net.inLinks.get(c.id)!.find((l) => l.seg === west)!;
    const right = inLink.lanes[inLink.lanes.length - 1];
    const left = inLink.lanes[0];
    expect(w.net.movesFrom.get(right.id)!.map((m) => w.net.links.get(m.outLink)!.seg)).toEqual([east]);
    expect(w.net.movesFrom.get(left.id)!.map((m) => w.net.links.get(m.outLink)!.seg)).toEqual([south]);
    // Налево (на север) с запада больше не повернуть.
    const northOut = w.net.outLinks.get(c.id)!.find((l) => l.seg === seg(N))!;
    expect(w.net.linkNext.get(inLink.id)!.has(northOut.id)).toBe(false);

    // Машины с запада едут по очереди прямо и направо — все доезжают.
    const wNode = w.nodeAt(W);
    const used = new Set<string>();
    const every = Math.round(3 / SIM_DT);
    let sent = 0;
    for (let step = 0; step < Math.round(90 / SIM_DT); step++) {
      if (sent < 8 && step % every === 0) {
        const goal = w.nodeAt(sent % 2 ? S : E);
        const route = routeFromNode(w.net, wNode.id, goal.id)!;
        if (w.traffic.spawn({ ...CAR, targetNode: goal.id, route })) sent++;
      }
      w.traffic.step(SIM_DT);
      for (const v of w.traffic.vehicles.values()) if (v.onMovement) used.add(v.onMovement);
    }
    expect(sent).toBe(8);
    expect(w.lost.length).toBe(0);
    expect(w.arrived.length).toBe(8);
    // Направо ехали именно с левой полосы — в левую полосу южной дороги.
    const southOut = w.net.outLinks.get(c.id)!.find((l) => l.seg === south)!;
    expect(used.has(`${left.id}>${southOut.lanes[0].id}`)).toBe(true);
  });
});
