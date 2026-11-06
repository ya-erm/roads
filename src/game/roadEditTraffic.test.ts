import { describe, expect, it, vi } from 'vitest';

// Поиск пути — тот же, но с подсчётом вызовов: машинам, которых правка не задела, его искать не должны.
vi.mock('../lanes/routing', async (importOriginal) => {
  const m = await importOriginal<typeof import('../lanes/routing')>();
  return { ...m, findLaneRoute: vi.fn(m.findLaneRoute) };
});

import { dist, type Vec } from '../core/vec';
import { LaneGraph } from '../lanes/graph';
import { findLaneRoute } from '../lanes/routing';
import { queueMismatches, REROUTE_BATCH } from '../lanes/traffic';
import type { Vehicle } from '../sim/vehicle';
import { Game } from './game';
import { runSeconds, STREET } from './testkit';

const searches = vi.mocked(findLaneRoute);

/** Связь — по месту в сети (номера связей в каждом графе свои): полотно, ход, отрезок оси. */
const linkKey = (g: LaneGraph, id: number) => {
  const l = g.links.get(id);
  return l ? `${l.corridor}:${l.flow}:${l.s0}:${l.s1}` : `?${id}`;
};
const laneKey = (g: LaneGraph, id: number) => {
  const l = g.lanes.get(id);
  return l ? `${linkKey(g, l.link)}:${l.laneIdx}` : `?${id}`;
};
const moveOf = (g: LaneGraph, key: string | null) => {
  const m = key ? g.moves.get(key) : undefined;
  return m ? `${laneKey(g, m.inLane)}>${laneKey(g, m.outLane)}` : null;
};

/** Где и как едет машина — по месту в сети. */
function where(game: Game, v: Vehicle) {
  const g = game.roads.graph;
  return {
    lane: laneKey(g, v.lane),
    move: moveOf(g, v.onMovement),
    granted: moveOf(g, v.granted),
    s: v.s,
    pos: { ...v.pos },
    route: v.route.slice(v.routeIndex).map((id) => linkKey(g, id)),
  };
}

/** Город с машинами жителей: партия по seed 7 после разгона. */
function busyGame(): Game {
  const game = new Game(7);
  game.money = 1e9;
  runSeconds(game, 40);
  return game;
}

/** Свободное место для дороги вдали от всех дорог и воды. */
function farSpot(game: Game): { a: Vec; b: Vec } {
  const net = game.roads.net;
  const near = (p: Vec) => Math.min(...[...net.nodes.values()].map((n) => dist(n.pos, p)), ...[...net.corridors.values()].map((c) => c.lut.closest(p).d));
  for (let y = 300; y < game.terrain.height - 300; y += 150) {
    for (let x = 300; x < game.terrain.width - 300; x += 150) {
      const a = { x, y };
      const b = { x: x + 150, y: y + 30 };
      if (game.isWater(a, 30) || game.isWater(b, 30) || near(a) < 300 || near(b) < 300) continue;
      if (game.roadBuilder.road({ kind: 'free', pos: a }, { kind: 'free', pos: b }, STREET).ok) return { a, b };
    }
  }
  throw new Error('нет места');
}

/** Все машины — каждая ровно в одной очереди (полосы или манёвра), места в очередях записаны верно. */
function queuesOk(game: Game): void {
  const g = game.roads.graph;
  const t = game.roads.traffic;
  expect(queueMismatches(g)).toEqual([]);
  const seen = new Map<Vehicle, number>();
  for (const l of g.lanes.values()) for (const v of l.vehicles) seen.set(v, (seen.get(v) ?? 0) + 1);
  for (const m of g.moves.values()) for (const v of m.vehicles) seen.set(v, (seen.get(v) ?? 0) + 1);
  for (const v of t.vehicles.values()) expect(seen.get(v)).toBe(1);
  // Машина посреди перекрёстка держит его: в брони узла.
  for (const v of t.vehicles.values()) {
    const m = v.onMovement ? g.moves.get(v.onMovement) : undefined;
    if (m?.node != null) expect(g.nodes.get(m.node)!.reserved).toContain(v);
  }
}

describe('Стройка и снос дорог: машины на новом графе', { timeout: 120_000 }, () => {
  it('дорога в стороне: машины едут как ехали — без поиска полосы и пути, посреди перекрёстка тоже', () => {
    const game = busyGame();
    const t = game.roads.traffic;
    expect(t.vehicles.size).toBeGreaterThan(40);
    const before = new Map([...t.vehicles.values()].map((v) => [v, where(game, v)]));
    const turning = [...t.vehicles.values()].filter((v) => v.onMovement);
    expect(turning.length).toBeGreaterThan(0);
    const { a, b } = farSpot(game);
    const plan = game.roadBuilder.road({ kind: 'free', pos: a }, { kind: 'free', pos: b }, STREET);
    searches.mockClear();
    expect(game.roadBuilder.apply(plan)).toBe(true);
    expect(searches).not.toHaveBeenCalled();
    expect(t.vehicles.size).toBe(before.size);
    for (const [v, was] of before) {
      expect(where(game, v)).toEqual(was);
      expect(t.routeCut(v)).toBe(false);
    }
    // Посреди перекрёстка — там же на манёвре, не в начале полосы выезда.
    for (const v of turning) expect(v.onMovement).not.toBeNull();
    queuesOk(game);
    runSeconds(game, 5);
    queuesOk(game);
  });

  it('примыкание к перекрёстку: задетые прокладывают путь порциями, ближние первыми и до разрыва', () => {
    const game = busyGame();
    const t = game.roads.traffic;
    const g0 = game.roads.graph;
    // Перекрёсток, через который едет больше всего машин.
    const through = new Map<number, number>();
    for (const v of t.vehicles.values()) for (const id of v.route.slice(v.routeIndex)) {
      const to = g0.links.get(id)?.toNode;
      if (to != null && game.roads.net.nodes.get(to)?.kind === 'junction') through.set(to, (through.get(to) ?? 0) + 1);
    }
    const ranked = [...through].sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    let applied = false;
    let inside: { v: Vehicle; pos: Vec }[] = [];
    for (const [id] of ranked.slice(0, 10)) {
      const n = game.roads.net.node(id);
      for (let k = 0; k < 16 && !applied; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const plan = game.roadBuilder.road({ kind: 'node', node: id, pos: n.pos }, { kind: 'free', pos: { x: n.pos.x + Math.cos(ang) * 120, y: n.pos.y + Math.sin(ang) * 120 } }, STREET);
        if (!plan.ok) continue;
        // Кто сейчас посреди этого перекрёстка (он поменяется): там же на повороте, а не в начале полосы выезда.
        inside = [...t.vehicles.values()]
          .filter((v) => v.onMovement && g0.moves.get(v.onMovement)?.node === id)
          .map((v) => ({ v, pos: { ...v.pos } }));
        searches.mockClear();
        applied = game.roadBuilder.apply(plan);
      }
      if (applied) break;
    }
    expect(applied).toBe(true);
    // Посреди перекрёстка, у которого поменялась форма: на той же кривой поворота (в ближайшей точке) или на полосе под
    // собой — и нарисована там же, где была: сдвиг тает потом.
    for (const { v, pos } of inside) {
      if (!t.vehicles.has(v.id)) continue;
      expect(dist(v.pos, pos)).toBeLessThan(0.05);
    }
    const cut = [...t.vehicles.values()].filter((v) => t.routeCut(v));
    expect(cut.length).toBeGreaterThan(0);
    // Сразу путь ищут только тем, кого ставят на полосу заново (их полоса поменялась), — не всем.
    expect(searches.mock.calls.length).toBeLessThan(t.vehicles.size / 3);
    // Пока маршрут оборван, до его конца не доезжают: доехавшие — только до своей цели.
    const arrive = game.roads.traffic['events'].onArrive;
    let wrong = 0;
    game.roads.traffic['events'].onArrive = (v: Vehicle) => {
      if (game.roads.graph.links.get(v.route[v.route.length - 1])?.toNode !== v.targetNode) wrong++;
      arrive(v);
    };
    // Порции поменьше, чтобы их было несколько.
    const batch = 3;
    t.rerouteBatch = batch;
    expect(cut.length).toBeGreaterThan(batch * 2);
    const g = game.roads.graph;
    const left = (v: Vehicle) => {
      const lane = t.currentLane(v)!;
      const m = v.onMovement ? g.moves.get(v.onMovement)! : null;
      let d = m ? m.length - v.s : lane.length - v.s;
      for (let i = v.routeIndex + 1; i < v.route.length; i++) d += g.links.get(v.route[i])!.length;
      return d;
    };
    const nearest = [...cut].sort((x, y) => left(x) - left(y) || x.id - y.id)[0];
    let ticks = 0;
    while (cut.some((v) => t.routeCut(v)) && ticks < 100) {
      const waiting = cut.filter((v) => t.routeCut(v));
      // Подъезжающих к разрыву (ближе 30 м и 2 с пути) перестраивают вне очереди.
      const near = waiting.filter((v) => left(v) < 30 + v.v * 2 || v.routeIndex >= v.route.length - 1).length;
      t.step(1 / 30);
      ticks++;
      const done = waiting.length - cut.filter((v) => t.routeCut(v)).length;
      expect(done).toBeGreaterThan(0);
      expect(done).toBeLessThanOrEqual(batch + near);
      // Ближняя к разрыву — в первой порции.
      if (ticks === 1) expect(t.routeCut(nearest)).toBe(false);
      for (const v of cut) if (t.routeCut(v)) expect(v.routeIndex).toBeLessThan(v.route.length - 1);
    }
    expect(ticks).toBeGreaterThan(1);
    expect(ticks).toBeLessThanOrEqual(Math.ceil(cut.length / batch) + 1);
    expect(REROUTE_BATCH).toBeGreaterThan(batch);
    expect(wrong).toBe(0);
    for (const v of cut) if (t.vehicles.has(v.id)) expect(game.roads.graph.links.get(v.route[v.route.length - 1])?.toNode).toBe(v.targetNode);
    queuesOk(game);
  });

  it('снос участка под машиной: она теряется сразу, остальные — на месте', () => {
    const game = busyGame();
    const t = game.roads.traffic;
    const g0 = game.roads.graph;
    const on = new Map<number, Vehicle[]>();
    for (const v of t.vehicles.values()) {
      const lane = t.currentLane(v);
      const c = lane && !v.onMovement ? g0.links.get(lane.link)!.corridor : null;
      if (c !== null && c !== undefined) on.set(c, [...(on.get(c) ?? []), v]);
    }
    const [corridor, riders] = [...on].sort((x, y) => y[1].length - x[1].length || x[0] - y[0])[0];
    expect(riders.length).toBeGreaterThan(0);
    const lost: Vehicle[] = [];
    const onLost = game.roads.traffic['events'].onLost;
    game.roads.traffic['events'].onLost = (v: Vehicle) => {
      lost.push(v);
      onLost(v);
    };
    const seen = new Map([...t.vehicles.values()].map((v) => [v, { ...v.pos }]));
    expect(game.roadBuilder.apply(game.roadBuilder.bulldoze([corridor]))).toBe(true);
    // Кого переставили (посреди перекрёстка у снесённой дороги, на укоротившейся полосе), — нарисованы там же, где были;
    // сдвиг тает меньше чем за секунду.
    for (const [v, pos] of seen) if (t.vehicles.has(v.id)) expect(dist(v.pos, pos)).toBeLessThan(0.05);
    const moved = [...t.vehicles.values()].filter((v) => v.shift);
    runSeconds(game, 1);
    for (const v of moved) expect(v.shift).toBeUndefined();
    // Под ней полосы нет: потеряна (или встала на соседнюю дорогу рядом) — сразу, а не в очереди.
    for (const v of riders) {
      if (!lost.includes(v)) {
        expect(game.roads.graph.links.get(t.currentLane(v)!.link)!.corridor).not.toBe(corridor);
        expect(t.routeCut(v)).toBe(false);
      }
    }
    expect(lost.filter((v) => riders.includes(v)).length).toBeGreaterThan(0);
    queuesOk(game);
    runSeconds(game, 5);
    queuesOk(game);
  });

  it('граф, собранный с прежним (готовые манёвры и конфликты у узлов, что не менялись), — тот же, что заново', () => {
    const game = new Game(7);
    game.money = 1e9;
    const dump = (g: LaneGraph) =>
      JSON.stringify([
        [...g.links.values()].map((l) => [l.id, l.corridor, l.flow, l.s0, l.s1, l.fromNode, l.toNode, l.lanes.map((x) => [x.id, x.laneIdx, x.offset, x.solidRight, x.solidZones])]),
        [...g.moves.values()].map((m) => [m.key, m.node, m.inLink, m.outLink, m.length, m.speed, m.points, [...m.conflicts], [...m.zones]]),
        [...g.nodes.values()].map((n) => [n.id, [...n.priorityLanes], n.lights?.phases.map((p) => [[...p.moves], [...p.yields].map(([k, s]) => [k, [...s]]), p.green])]),
        [...g.transitions].map(([k, v]) => [k, v.map((m) => m.key)]),
      ]);
    const same = () => expect(dump(game.roads.graph)).toBe(dump(new LaneGraph(game.roads.net)));
    const net = game.roads.net;
    const { a, b } = farSpot(game);
    game.roadBuilder.apply(game.roadBuilder.road({ kind: 'free', pos: a }, { kind: 'free', pos: b }, STREET));
    // Узлы стройки в стороне не трогают: почти все — как были.
    expect(game.roads.graph.sameNodes.size).toBeGreaterThan(game.roads.graph.nodes.size - 4);
    same();
    const j = [...game.roads.net.nodes.values()].filter((n) => n.kind === 'junction').sort((x, y) => y.corridors.length - x.corridors.length || x.id - y.id)[0];
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const plan = game.roadBuilder.road({ kind: 'node', node: j.id, pos: j.pos }, { kind: 'free', pos: { x: j.pos.x + Math.cos(ang) * 120, y: j.pos.y + Math.sin(ang) * 120 } }, STREET);
      if (plan.ok && game.roadBuilder.apply(plan)) break;
    }
    expect(game.roads.graph.sameNodes.has(j.id)).toBe(false);
    same();
    const c = [...game.roads.net.corridors.values()].find((x) => game.roads.net.node(x.a).kind === 'junction' && game.roads.net.node(x.b).kind === 'junction')!;
    game.roadBuilder.apply(game.roadBuilder.bulldoze([c.id]));
    same();
    // Светофор на перекрёстке: манёвры те же, а узел — уже не «как был».
    const lit = [...game.roads.net.nodes.values()].find((n) => n.kind === 'junction' && n.corridors.length >= 3 && !n.control)!;
    lit.control = 'lights';
    game.roads.net.version++;
    game.roads.changed();
    expect(game.roads.graph.sameNodes.has(lit.id)).toBe(false);
    same();
    // Запрет поворота правит узел на месте (тот же объект сети) — манёвры узла всё равно заново.
    const cross = [...game.roads.net.nodes.values()].find((n) => n.kind === 'junction' && n.corridors.length >= 3 && n.id !== lit.id)!;
    game.setJunction(cross.id, { bans: [`${cross.corridors[0]}>${cross.corridors[1]}`] });
    expect(game.roads.graph.sameNodes.has(cross.id)).toBe(false);
    same();
    // Главная дорога — тоже на месте: главная у узла — заново, а не копией.
    const main = [...game.roads.net.nodes.values()].find((n) => n.kind === 'junction' && n.corridors.length >= 3 && !n.control && n.id !== cross.id)!;
    game.setJunction(main.id, { mainPair: [] });
    same();
    game.setJunction(main.id, { mainPair: [main.corridors[0], main.corridors[1]] });
    same();
    // Правка ничего не изменила — всё копией.
    game.roads.net.version++;
    game.roads.changed();
    expect(game.roads.graph.sameNodes.size).toBe(game.roads.graph.nodes.size);
    expect(game.roads.graph.linkFromPrev.size).toBe(game.roads.graph.links.size);
    same();
    expect(net).not.toBe(game.roads.net);
  });

  it('та же партия с теми же правками — тот же результат', () => {
    const play = () => {
      const game = busyGame();
      const { a, b } = farSpot(game);
      game.roadBuilder.apply(game.roadBuilder.road({ kind: 'free', pos: a }, { kind: 'free', pos: b }, STREET));
      runSeconds(game, 2);
      const j = [...game.roads.net.nodes.values()].filter((n) => n.kind === 'junction').sort((x, y) => y.corridors.length - x.corridors.length || x.id - y.id)[0];
      for (let k = 0; k < 16; k++) {
        const ang = (k / 16) * Math.PI * 2;
        const plan = game.roadBuilder.road({ kind: 'node', node: j.id, pos: j.pos }, { kind: 'free', pos: { x: j.pos.x + Math.cos(ang) * 120, y: j.pos.y + Math.sin(ang) * 120 } }, STREET);
        if (plan.ok && game.roadBuilder.apply(plan)) break;
      }
      runSeconds(game, 10);
      const save = game.toSave() as unknown as Record<string, unknown>;
      delete save.savedAt;
      return JSON.stringify(save);
    };
    expect(play()).toBe(play());
  });
});
