import { describe, expect, it } from 'vitest';
import { add, dist, dot, scale, Vec } from '../core/vec';
import { routeFromNode } from '../sim/routing';
import type { RoadRequest, Snap } from './build';
import { Game } from './game';

const STREET = { cls: 'street' as const, lanesF: 1, lanesB: 1 };

const free = (pos: Vec): Snap => ({ kind: 'free', pos, level: 0 });

function runSeconds(game: Game, seconds: number) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) game.update(0.1);
}

function dryGame(): Game {
  return new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
}

/** Строит цепочку прямых дорог через точки, если всё помещается. Возвращает узлы по порядку. */
function buildChain(game: Game, pts: Vec[]): number[] | null {
  const reqs: RoadRequest[] = [];
  for (let i = 1; i < pts.length; i++) reqs.push({ start: free(pts[i - 1]), end: free(pts[i]), spec: STREET, mode: 'straight' });
  if (!reqs.every((r) => game.builder.plan(r).ok)) return null;
  const nodes: number[] = [];
  let start: Snap = free(pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const res = game.builder.build({ start, end: free(pts[i]), spec: STREET, mode: 'straight' });
    if (!res) return null;
    if (!nodes.length) nodes.push(game.net.segment(game.net.node(res.endNode).segments[0]).a);
    nodes.push(res.endNode);
    const n = game.net.node(res.endNode);
    start = { kind: 'node', nodeId: n.id, pos: n.pos, level: n.level };
  }
  return nodes;
}

/** Г-образный изгиб A–B–C в свободном месте. */
function buildBend(game: Game): { a: number; b: number; c: number; origin: Vec } {
  for (let y = 400; y < game.terrain.height - 500; y += 120) {
    for (let x = 300; x < game.terrain.width - 500; x += 160) {
      // Запас вокруг: изгиб потом выпрямляют и тянут в стороны.
      const probe: RoadRequest = { start: free({ x: x - 60, y: y + 260 }), end: free({ x: x + 260, y: y - 60 }), spec: STREET, mode: 'straight' };
      if (!game.builder.plan(probe).ok) continue;
      const nodes = buildChain(game, [
        { x, y },
        { x: x + 200, y },
        { x: x + 200, y: y + 200 },
      ]);
      if (nodes) return { a: nodes[0], b: nodes[1], c: nodes[2], origin: { x, y } };
    }
  }
  throw new Error('Нет места для изгиба');
}

/** Снимок формы сети: узлы и кривые участков. */
function shape(game: Game): string {
  const nodes = [...game.net.nodes.values()].map((n) => [n.id, n.pos.x.toFixed(3), n.pos.y.toFixed(3), [...n.segments].sort()]);
  const segs = [...game.net.segments.values()].map((s) => [s.id, s.a, s.b, s.curve]);
  return JSON.stringify({ nodes, segs });
}

describe('Перенос узла', () => {
  it('изгиб из двух участков двигается и остаётся связанным', () => {
    const game = dryGame();
    const { a, b, c, origin } = buildBend(game);
    const segs = [...game.net.node(b).segments].sort();
    const money = game.money;
    // Узел прямо на линию A–C: дорога выпрямляется.
    const target = { x: origin.x + 100, y: origin.y + 100 };
    const plan = game.builder.moveNodePlan(b, target);
    expect(plan.ok).toBe(true);
    expect(game.builder.moveNode(b, target)).toBe(true);
    const node = game.net.node(b);
    expect(dist(node.pos, target)).toBeLessThan(1e-6);
    // Те же участки, те же концы, кривые начинаются и кончаются в узлах.
    expect([...node.segments].sort()).toEqual(segs);
    for (const id of segs) {
      const s = game.net.segment(id);
      expect(dist(s.curve.p0, game.net.node(s.a).pos)).toBeLessThan(1e-6);
      expect(dist(s.curve.p3, game.net.node(s.b).pos)).toBeLessThan(1e-6);
    }
    expect(game.net.segmentBetween(a, b)).not.toBeNull();
    expect(game.net.segmentBetween(b, c)).not.toBeNull();
    expect(routeFromNode(game.net, a, c)).not.toBeNull();
    expect(routeFromNode(game.net, c, a)).not.toBeNull();
    // Платим за новую дорогу, за старую возвращается половина — как при сносе.
    expect(plan.refund).toBeGreaterThan(0);
    expect(plan.cost).toBe(Math.round(plan.spend - plan.refund * 0.5));
    expect(game.money).toBe(money - Math.round(plan.spend) + Math.round(plan.refund * 0.5));
  });

  it('кривая, гладко продолжавшая прямую, остаётся гладкой', () => {
    const game = dryGame();
    const { origin } = buildBend(game);
    // Отдельная дорога: прямая, затем дуга по касательной к ней.
    const o = { x: origin.x, y: origin.y + 120 };
    const nodes = buildChain(game, [o, { x: o.x + 120, y: o.y }])!;
    const mid = game.net.node(nodes[1]);
    const arc: RoadRequest = {
      start: { kind: 'node', nodeId: mid.id, pos: mid.pos, level: 0 },
      end: free({ x: o.x + 220, y: o.y + 70 }),
      spec: STREET,
      mode: 'arc',
      tangent: { x: 1, y: 0 },
    };
    expect(game.builder.plan(arc).ok).toBe(true);
    game.builder.build(arc);
    const [s1, s2] = game.net.node(mid.id).segments;
    expect(game.builder.moveNode(mid.id, { x: o.x + 130, y: o.y + 12 })).toBe(true);
    expect(dot(game.net.dirFrom(mid.id, s1), game.net.dirFrom(mid.id, s2))).toBeLessThan(-0.999);
  });

  it('прямая через изгиб подтягивается, если курсор рядом', () => {
    const game = dryGame();
    const { b, origin } = buildBend(game);
    const p = game.builder.alignNode(b, { x: origin.x + 104, y: origin.y + 98 }, 12);
    expect(Math.abs(p.x - p.y - (origin.x - origin.y))).toBeLessThan(1e-6);
    // Далеко от прямой — точка как есть.
    const far = { x: origin.x + 150, y: origin.y + 40 };
    expect(game.builder.alignNode(b, far, 12)).toEqual(far);
  });

  it('перекрёсток тянет за собой все три дороги, запрет поворота остаётся', () => {
    const game = dryGame();
    const { a, b, origin } = buildBend(game);
    // Ответвление от середины A–B: получается Т-образный перекрёсток.
    const mid = { x: origin.x + 100, y: origin.y };
    const branch: RoadRequest = { start: game.builder.snap(mid, 0, 10), end: free({ x: origin.x + 100, y: origin.y - 160 }), spec: STREET, mode: 'straight' };
    expect(game.builder.plan(branch).ok).toBe(true);
    const res = game.builder.build(branch)!;
    const end = res.endNode;
    const j = [...game.net.nodes.values()].find((n) => dist(n.pos, mid) < 1)!;
    expect(j.segments.length).toBe(3);
    const arms = [...j.segments];
    const toA = arms.find((id) => game.net.segment(id).a === a || game.net.segment(id).b === a)!;
    const toEnd = arms.find((id) => game.net.segment(id).a === end || game.net.segment(id).b === end)!;
    // С ответвления нельзя повернуть к A.
    game.setJunction(j.id, { bans: [`${toEnd}>${toA}`], mainPair: arms.filter((id) => id !== toEnd) });

    const target = add(mid, { x: 25, y: -20 });
    expect(game.builder.moveNode(j.id, target)).toBe(true);
    const node = game.net.node(j.id);
    expect(dist(node.pos, target)).toBeLessThan(1e-6);
    expect([...node.segments].sort()).toEqual([...arms].sort());
    expect(node.bans).toEqual([`${toEnd}>${toA}`]);
    // Запрет действует: манёвра с ответвления к A нет, а остальные есть.
    const segOf = (lane: number) => game.net.lanes.get(lane)!.seg;
    const moves = game.net.nodeMovements.get(j.id)!;
    expect(moves.some((m) => segOf(m.inLane) === toEnd && segOf(m.outLane) === toA)).toBe(false);
    expect(moves.some((m) => segOf(m.inLane) === toEnd && segOf(m.outLane) !== toA)).toBe(true);
    // Главная дорога — по-прежнему A–B.
    const ins = game.net.inLinks.get(j.id)!;
    const main = ins.filter((l) => l.lanes.some((lane) => node.priorityLanes.has(lane.id))).map((l) => l.seg);
    expect(main.sort()).toEqual(arms.filter((id) => id !== toEnd).sort());
    expect(routeFromNode(game.net, end, b)).not.toBeNull();
    expect(routeFromNode(game.net, a, end)).not.toBeNull();
  });

  it('недопустимый перенос отклоняется, сеть не меняется', () => {
    const game = dryGame();
    const { b, origin } = buildBend(game);
    const before = shape(game);
    const money = game.money;
    // За конец C, на продолжение A–C: дорога A–B прошла бы через узел C, дороги сошлись бы в одну.
    const bad = { x: origin.x + 300, y: origin.y + 300 };
    const plan = game.builder.moveNodePlan(b, bad);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBeTruthy();
    expect(plan.plans.some((p) => !p.ok)).toBe(true);
    expect(game.builder.moveNode(b, bad)).toBe(false);
    expect(shape(game)).toBe(before);
    expect(game.money).toBe(money);
  });

  it('в воду узел не переносится', () => {
    const game = new Game({ seed: 7, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'normal' });
    let tried = false;
    for (let y = 300; y < game.terrain.height - 300 && !tried; y += 40) {
      for (let x = 300; x < game.terrain.width - 300 && !tried; x += 40) {
        const w = { x, y };
        if (!game.isWater(w, 12)) continue;
        for (let k = 0; k < 8 && !tried; k++) {
          const d = { x: Math.cos((k * Math.PI) / 4), y: Math.sin((k * Math.PI) / 4) };
          const perp = { x: -d.y, y: d.x };
          const bend = add(w, scale(d, 120));
          const pts = [add(bend, scale(perp, 150)), bend, add(bend, scale(d, 150))];
          if (pts.some((p) => game.isWater(p, 20))) continue;
          const nodes = buildChain(game, pts);
          if (!nodes) continue;
          tried = true;
          const before = shape(game);
          const plan = game.builder.moveNodePlan(nodes[1], w);
          expect(plan.ok).toBe(false);
          expect(plan.reason).toBe('Опора в воде — нужен мост');
          expect(game.builder.moveNode(nodes[1], w)).toBe(false);
          expect(shape(game)).toBe(before);
        }
      }
    }
    expect(tried).toBe(true);
  });

  it('Ctrl+Z возвращает узел, дороги и деньги', () => {
    const game = dryGame();
    const { b, origin } = buildBend(game);
    const before = shape(game);
    const money = game.money;
    game.checkpoint('перенос дороги');
    expect(game.builder.moveNode(b, { x: origin.x + 230, y: origin.y - 40 })).toBe(true);
    game.commit();
    expect(shape(game)).not.toBe(before);
    expect(game.money).not.toBe(money);
    expect(game.undo()).toBe('перенос дороги');
    expect(shape(game)).toBe(before);
    expect(game.money).toBe(money);
  });

  it('в городе: перекрёсток двигается, машины продолжают ездить', () => {
    const game = new Game(7);
    runSeconds(game, 10);
    let moved = false;
    // Сначала перекрёстки, у которых на дорогах больше всего машин.
    const busy = (id: number) =>
      [...game.net.lanes.values()].filter((l) => game.net.node(id).segments.includes(l.seg)).reduce((k, l) => k + l.vehicles.length, 0);
    const nodes = [...game.net.nodes.values()].filter((n) => n.segments.length >= 3 && game.builder.canMoveNode(n));
    nodes.sort((x, y) => busy(y.id) - busy(x.id));
    for (const n of nodes) {
      for (const off of [
        { x: 6, y: 0 },
        { x: 0, y: 6 },
        { x: -6, y: 0 },
        { x: 0, y: -6 },
      ]) {
        const target = add(n.pos, off);
        if (!game.builder.moveNodePlan(n.id, target).ok) continue;
        const segs = [...n.segments].sort();
        expect(game.builder.moveNode(n.id, target)).toBe(true);
        expect([...game.net.node(n.id).segments].sort()).toEqual(segs);
        moved = true;
        break;
      }
      if (moved) break;
    }
    expect(moved).toBe(true);
    runSeconds(game, 20);
    expect(game.citizenCars).toBe([...game.traffic.vehicles.values()].length);
    expect(game.citizenCars).toBeGreaterThan(0);
  });
});
