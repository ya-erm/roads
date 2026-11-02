import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { buildRoad, splitCorridor } from '../lanes/edit';
import { LaneGraph } from '../lanes/graph';
import { laneKey, LaneNet, LaneNode, parseLaneKey, twoWay } from '../lanes/model';
import { findLaneRoute } from '../lanes/routing';
import { LaneTraffic } from '../lanes/traffic';
import { Game, LaneEnd } from './game';

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 30, accel: 10, color: '#888' };

/** Перекрёсток на четыре дороги в городе, перестроенный в проспекты 2+2 — чтобы было из чего выбирать. */
function avenueCrossroads(game: Game): LaneNode {
  const net = game.roads.net;
  const n = [...net.nodes.values()].find(
    (x) => x.kind === 'junction' && (x.roundabout ?? null) === null && !x.control && net.ends(x).length === 4 && x.corridors.length === 4,
  )!;
  for (const id of n.corridors) {
    const c = net.corridor(id);
    c.cls = 'avenue';
    net.setLanes(c, twoWay(2, 2));
  }
  game.networkChanged();
  return n;
}

/** Куда ведёт полоса: id полос выезда. */
const targets = (game: Game, lane: number) => (game.roads.graph.movesFrom.get(lane) ?? []).map((m) => m.outLane).sort((a, b) => a - b);

/** Полоса въезда и полоса выезда, с которой она сейчас не связана. */
function pickPair(game: Game, n: LaneNode): { from: LaneEnd; to: LaneEnd } {
  const ends = game.laneEnds(n.id);
  const from = ends.find((e) => e.kind === 'in' && e.i === 0)!;
  const now = targets(game, from.lane);
  const to = ends.find((e) => e.kind === 'out' && from.exits.includes(e.seg) && !now.includes(e.lane))!;
  return { from, to };
}

describe('Связи полос на перекрёстке', () => {
  it('настроенная полоса едет только по своим связям, остальные — как раньше', () => {
    const game = new Game(7);
    const n = avenueCrossroads(game);
    const { from, to } = pickPair(game, n);
    expect(to).toBeDefined();
    const auto = targets(game, from.lane);
    expect(auto.length).toBeGreaterThan(0);
    const neighbour = game.laneEnds(n.id).find((e) => e.kind === 'in' && e.seg === from.seg && e.i === 1)!;
    const neighbourBefore = targets(game, neighbour.lane);

    // Первый клик переносит автоматические связи в настройку и добавляет новую.
    expect(game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i)).toBeNull();
    // Граф пересобран — id полос новые: сверяемся по меткам.
    const lanesNow = () => game.laneEnds(n.id);
    const fromNow = () => lanesNow().find((e) => e.kind === 'in' && e.seg === from.seg && e.i === from.i)!;
    const outOf = (id: number) => lanesNow().find((e) => e.kind === 'out' && e.lane === id)!;
    const linked = () => targets(game, fromNow().lane).map((id) => `${outOf(id).seg}.${outOf(id).i}`).sort();
    expect(linked()).toContain(`${to.seg}.${to.i}`);
    expect(linked()).toHaveLength(auto.length + 1);
    // Убираем прежние — остаётся только выбранная.
    for (const key of linked()) {
      if (key === `${to.seg}.${to.i}`) continue;
      const [seg, i] = key.split('.').map(Number);
      expect(game.toggleLaneConnection(n.id, from.seg, from.i, seg, i)).toBeNull();
    }
    expect(linked()).toEqual([`${to.seg}.${to.i}`]);
    expect(n.lanes).toEqual([laneKey({ from: from.seg, i: from.i, to: to.seg, j: to.i })]);
    expect(fromNow().custom).toBe(true);
    expect(game.junctionInfo(n.id)!.customLanes).toBe(1);
    // Соседняя полоса не настроена — её связей столько же.
    const neighbourNow = lanesNow().find((e) => e.kind === 'in' && e.seg === from.seg && e.i === 1)!;
    expect(targets(game, neighbourNow.lane)).toHaveLength(neighbourBefore.length);
    // Последнюю связь не убрать: полоса без выезда — тупик.
    expect(game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i)).not.toBeNull();
    expect(linked()).toEqual([`${to.seg}.${to.i}`]);
    // Обратно в своё же полотно (разворот) — нельзя.
    expect(game.toggleLaneConnection(n.id, from.seg, from.i, from.seg, 0)).not.toBeNull();
  });

  it('связи сохраняются вместе с игрой', () => {
    const game = new Game(7);
    const n = avenueCrossroads(game);
    const { from, to } = pickPair(game, n);
    game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i);
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.roads.net.node(n.id).lanes).toEqual(n.lanes);
    const count = (g: Game) => targets(g, g.laneEnds(n.id).find((e) => e.kind === 'in' && e.seg === from.seg && e.i === from.i)!.lane).length;
    expect(count(loaded)).toBe(count(game));
  });

  it('связи, запреты и главная переживают разрезание примыкающих полотен', () => {
    const game = new Game(7);
    const n = avenueCrossroads(game);
    const { from, to } = pickPair(game, n);
    game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i);
    game.setJunction(n.id, { bans: [`${to.seg}>${from.seg}`] });
    const count = n.lanes!.length;
    // Разрезаем и полотно въезда, и полотно выезда; у перекрёстка остаются их новые куски.
    const net = game.roads.net;
    const near = (r: { first: { id: number; a: number; b: number }; second: { id: number; a: number; b: number } }) =>
      [r.first, r.second].find((s) => s.a === n.id || s.b === n.id)!.id;
    const newIn = near(splitCorridor(net, net.corridor(from.seg), net.corridor(from.seg).length / 2, 'seam'));
    const newOut = near(splitCorridor(net, net.corridor(to.seg), net.corridor(to.seg).length / 2, 'seam'));
    game.networkChanged();
    const node = net.node(n.id);
    expect(node.lanes!.length).toBe(count);
    expect(node.lanes).toContain(laneKey({ from: newIn, i: from.i, to: newOut, j: to.i }));
    for (const key of node.lanes!) {
      const l = parseLaneKey(key)!;
      expect(node.corridors).toContain(l.from);
      expect(node.corridors).toContain(l.to);
    }
    expect(node.bans).toEqual([`${newOut}>${newIn}`]);
    const ends = game.laneEnds(n.id);
    const lane = ends.find((e) => e.kind === 'in' && e.seg === newIn && e.i === from.i)!;
    const out = ends.find((e) => e.kind === 'out' && e.seg === newOut && e.i === to.i)!;
    expect(lane.custom).toBe(true);
    expect(ends.filter((e) => e.custom).length).toBe(1);
    expect(targets(game, lane.lane)).toContain(out.lane);
    expect(targets(game, lane.lane).length).toBe(count);
  });

  it('сброс возвращает автоматические связи', () => {
    const game = new Game(7);
    const n = avenueCrossroads(game);
    const { from, to } = pickPair(game, n);
    const auto = targets(game, from.lane).length;
    game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i);
    game.resetLanes(n.id);
    expect(n.lanes).toBeUndefined();
    const again = game.laneEnds(n.id).find((e) => e.kind === 'in' && e.seg === from.seg && e.i === from.i)!;
    expect(targets(game, again.lane)).toHaveLength(auto);
    expect(game.junctionInfo(n.id)!.customLanes).toBe(0);
  });

  it('новый запрет поворота снимает связи полос в ту сторону', () => {
    const game = new Game(7);
    const n = avenueCrossroads(game);
    const { from, to } = pickPair(game, n);
    game.toggleLaneConnection(n.id, from.seg, from.i, to.seg, to.i);
    game.setJunction(n.id, { bans: [`${from.seg}>${to.seg}`] });
    expect((n.lanes ?? []).some((k) => parseLaneKey(k)?.from === from.seg && parseLaneKey(k)?.to === to.seg)).toBe(false);
    const g = game.roads.graph;
    const lane = game.laneEnds(n.id).find((e) => e.kind === 'in' && e.seg === from.seg && e.i === from.i)!;
    expect(targets(game, lane.lane).some((id) => g.links.get(g.lanes.get(id)!.link)!.corridor === to.seg)).toBe(false);
  });
});

describe('Движение по настроенным полосам', () => {
  it('машины проезжают перекрёсток по связям, заданным игроком', () => {
    const net = new LaneNet();
    const AVENUE = { cls: 'avenue' as const, lanes: twoWay(2, 2) };
    const free = (x: number, y: number) => ({ kind: 'free' as const, pos: { x, y } });
    buildRoad(net, free(0, 300), free(600, 300), AVENUE);
    buildRoad(net, free(300, 0), free(300, 600), AVENUE);
    const c = [...net.nodes.values()].find((x) => x.kind === 'junction')!;
    expect(net.ends(c)).toHaveLength(4);
    const nodeAt = (p: Vec) => net.nodesNear(p, 2)[0];
    const arm = (p: Vec) => net.ends(c).find((e) => e.corridor.a === nodeAt(p).id || e.corridor.b === nodeAt(p).id)!.corridor.id;
    const W = { x: 0, y: 300 };
    const E = { x: 600, y: 300 };
    const N = { x: 300, y: 0 };
    const S = { x: 300, y: 600 };
    const west = arm(W);
    const south = arm(S);
    const east = arm(E);
    // С запада: правая полоса — только прямо, левая — только направо (на юг, в левую полосу).
    c.lanes = [laneKey({ from: west, i: 0, to: east, j: 0 }), laneKey({ from: west, i: 1, to: south, j: 1 })];
    const graph = new LaneGraph(net);
    const inLink = graph.inLinks.get(c.id)!.find((l) => l.corridor === west)!;
    const right = inLink.lanes[inLink.lanes.length - 1];
    const left = inLink.lanes[0];
    const outCorridor = (m: { outLink: number }) => graph.links.get(m.outLink)!.corridor;
    expect(graph.movesFrom.get(right.id)!.map(outCorridor)).toEqual([east]);
    expect(graph.movesFrom.get(left.id)!.map(outCorridor)).toEqual([south]);
    // Налево (на север) с запада больше не повернуть.
    const north = arm(N);
    expect([...inLink.lanes].some((l) => (graph.movesFrom.get(l.id) ?? []).some((m) => outCorridor(m) === north))).toBe(false);

    // Машины с запада едут по очереди прямо и направо — все доезжают.
    const arrived: number[] = [];
    let lost = 0;
    const traffic = new LaneTraffic(graph, { onArrive: (v) => arrived.push(v.id), onLost: () => lost++ });
    const used = new Set<string>();
    let sent = 0;
    for (let step = 0; step < 90 * 30; step++) {
      if (sent < 8 && step % 90 === 0) {
        const goal = nodeAt(sent % 2 ? S : E);
        const route = findLaneRoute(graph, graph.outLinks.get(nodeAt(W).id)!, goal.id)!;
        if (traffic.spawn({ ...CAR, targetNode: goal.id, route })) sent++;
      }
      traffic.step(1 / 30);
      for (const v of traffic.vehicles.values()) if (v.onMovement) used.add(v.onMovement);
    }
    expect(sent).toBe(8);
    expect(lost).toBe(0);
    expect(arrived).toHaveLength(8);
    // Направо ехали именно с левой полосы — в левую полосу южной дороги.
    const southOut = graph.outLinks.get(c.id)!.find((l) => l.corridor === south)!;
    expect(used.has(`${left.id}>${southOut.lanes[0].id}`)).toBe(true);
  });
});
