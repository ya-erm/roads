import { describe, expect, it } from 'vitest';
import { add, dist, dot, scale, Vec } from '../core/vec';
import { alignNode, dragHandle, smoothCorner } from '../lanes/edit';
import { Game } from './game';
import { AVENUE, roadPlan, STREET } from './testkit';

/** Цепочка прямых улиц: на поворотах — излом (перекрёсток из двух дорог), а не плавная дуга. */
const KINKED = { ...STREET, kink: true };

function runSeconds(game: Game, seconds: number) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) game.update(0.1);
}

function dryGame(): Game {
  return new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
}

/** Строит цепочку прямых улиц через точки, если всё помещается. Возвращает узлы по порядку. */
function buildChain(game: Game, pts: Vec[]): number[] | null {
  for (let i = 1; i < pts.length; i++) if (!roadPlan(game, { free: pts[i - 1] }, { free: pts[i] }).ok) return null;
  const nodes: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const plan = roadPlan(game, i === 1 ? { free: pts[0] } : nodes[i - 1], { free: pts[i] }, KINKED);
    if (!plan.ok || !game.roadBuilder.apply(plan)) return null;
    if (i === 1) nodes.push(game.roads.net.nodesNear(pts[0], 1)[0].id);
    nodes.push(game.roads.net.nodesNear(pts[i], 1)[0].id);
  }
  return nodes;
}

/** Г-образный изгиб A–B–C в свободном месте. */
function buildBend(game: Game): { a: number; b: number; c: number; origin: Vec } {
  for (let y = 400; y < game.terrain.height - 500; y += 120) {
    for (let x = 300; x < game.terrain.width - 500; x += 160) {
      // Запас вокруг: изгиб потом выпрямляют и тянут в стороны.
      if (!roadPlan(game, { free: { x: x - 60, y: y + 260 } }, { free: { x: x + 260, y: y - 60 } }).ok) continue;
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

/** Снимок формы сети: узлы и кривые полотен. */
function shape(game: Game): string {
  const net = game.roads.net;
  const nodes = [...net.nodes.values()].map((n) => [n.id, n.kind, n.pos.x.toFixed(3), n.pos.y.toFixed(3), [...n.corridors].sort()]);
  const corridors = [...net.corridors.values()].map((c) => [c.id, c.a, c.b, c.curve]);
  return JSON.stringify({ nodes, corridors });
}

/** Переносит узел, если можно; true — перенесён. */
function move(game: Game, id: number, pos: Vec): boolean {
  const plan = game.roadBuilder.moveNode(id, pos);
  return plan.ok && game.roadBuilder.apply(plan);
}

describe('Перенос узла', () => {
  it('изгиб из двух полотен двигается и остаётся связанным', () => {
    const game = dryGame();
    const { a, b, c, origin } = buildBend(game);
    const net = () => game.roads.net;
    expect(net().node(b).kind).toBe('junction');
    const arms = [...net().node(b).corridors].sort();
    const money = game.money;
    // Узел прямо на линию A–C: дорога выпрямляется и становится короче.
    const target = { x: origin.x + 100, y: origin.y + 100 };
    const plan = game.roadBuilder.moveNode(b, target);
    expect(plan.ok).toBe(true);
    expect(move(game, b, target)).toBe(true);
    const node = net().node(b);
    expect(dist(node.pos, target)).toBeLessThan(1e-6);
    // Те же полотна, кривые начинаются и кончаются в узлах, прямые остались прямыми.
    expect([...node.corridors].sort()).toEqual(arms);
    for (const id of arms) {
      const s = net().corridor(id);
      expect(dist(s.curve.p0, net().node(s.a).pos)).toBeLessThan(1e-6);
      expect(dist(s.curve.p3, net().node(s.b).pos)).toBeLessThan(1e-6);
      expect(s.length).toBeCloseTo(dist(net().node(s.a).pos, net().node(s.b).pos), 3);
    }
    // Тупики A и C повернулись вслед за дорогами — проехать можно в обе стороны.
    expect(net().problems()).toEqual([]);
    expect(game.roads.route(a, c)).not.toBeNull();
    expect(game.roads.route(c, a)).not.toBeNull();
    // Дорога стала короче — часть денег возвращается, как при сносе.
    expect(plan.refund).toBeGreaterThan(0);
    expect(plan.spend).toBe(0);
    expect(game.money).toBe(money - plan.cost);
  });

  it('тупик продлевается вдоль дороги и уводится в сторону — дорога остаётся прямой', () => {
    const game = dryGame();
    const { c, origin } = buildBend(game);
    const net = () => game.roads.net;
    const end = { x: origin.x + 200, y: origin.y + 300 };
    expect(move(game, c, end)).toBe(true);
    expect(move(game, c, { x: origin.x + 260, y: origin.y + 280 })).toBe(true);
    const corridor = net().corridor(net().node(c).corridors[0]);
    expect(corridor.length).toBeCloseTo(dist(net().node(corridor.a).pos, net().node(corridor.b).pos), 3);
    expect(net().isDeadEnd(net().node(c))).toBe(true);
    expect(net().problems()).toEqual([]);
  });

  it('кривая, гладко продолжавшая прямую, остаётся гладкой', () => {
    const game = dryGame();
    const { origin } = buildBend(game);
    // Отдельная дорога: прямая, затем дуга по касательной к ней (продолжение тупика — стык).
    const o = { x: origin.x, y: origin.y + 120 };
    const nodes = buildChain(game, [o, { x: o.x + 120, y: o.y }])!;
    const plan = roadPlan(game, nodes[1], { free: { x: o.x + 220, y: o.y + 70 } });
    expect(plan.ok).toBe(true);
    game.roadBuilder.apply(plan);
    const net = () => game.roads.net;
    expect(net().node(nodes[1]).kind).toBe('seam');
    expect(move(game, nodes[1], { x: o.x + 130, y: o.y + 12 })).toBe(true);
    const [e1, e2] = net().ends(net().node(nodes[1]));
    expect(dot(e1.away, e2.away)).toBeLessThan(-0.999);
  });

  it('прямая через изгиб подтягивается, если курсор рядом', () => {
    const game = dryGame();
    const { b, origin } = buildBend(game);
    const p = alignNode(game.roads.net, b, { x: origin.x + 104, y: origin.y + 98 }, 12);
    expect(Math.abs(p.x - p.y - (origin.x - origin.y))).toBeLessThan(1e-6);
    // Далеко от прямой — точка как есть.
    const far = { x: origin.x + 150, y: origin.y + 40 };
    expect(alignNode(game.roads.net, b, far, 12)).toEqual(far);
  });

  it('перекрёсток тянет за собой все три дороги, запрет поворота остаётся', () => {
    const game = dryGame();
    const { a, b, origin } = buildBend(game);
    const net = () => game.roads.net;
    // Ответвление от середины A–B: получается Т-образный перекрёсток.
    const mid = { x: origin.x + 100, y: origin.y };
    const plan = roadPlan(game, mid, { free: { x: origin.x + 100, y: origin.y - 160 } });
    expect(plan.ok).toBe(true);
    game.roadBuilder.apply(plan);
    const j = net().nodesNear(mid, 1)[0];
    expect(j.kind).toBe('junction');
    expect(j.corridors.length).toBe(3);
    const arms = [...j.corridors];
    const other = (id: number) => {
      const s = net().corridor(id);
      return s.a === j.id ? s.b : s.a;
    };
    const toA = arms.find((id) => other(id) === a)!;
    const toEnd = arms.find((id) => net().isDeadEnd(net().node(other(id))) && other(id) !== a)!;
    const end = other(toEnd);
    // С ответвления нельзя повернуть к A.
    game.setJunction(j.id, { bans: [`${toEnd}>${toA}`], mainPair: arms.filter((id) => id !== toEnd) });

    const target = add(mid, { x: 25, y: -20 });
    expect(move(game, j.id, target)).toBe(true);
    const node = net().node(j.id);
    expect(dist(node.pos, target)).toBeLessThan(1e-6);
    expect([...node.corridors].sort()).toEqual([...arms].sort());
    expect(node.bans).toEqual([`${toEnd}>${toA}`]);
    // Запрет действует: манёвра с ответвления к A нет, а остальные есть.
    const g = game.roads.graph;
    const corridorOf = (link: number) => g.links.get(link)!.corridor;
    const moves = [...g.moves.values()].filter((m) => m.node === j.id);
    expect(moves.some((m) => corridorOf(m.inLink) === toEnd && corridorOf(m.outLink) === toA)).toBe(false);
    expect(moves.some((m) => corridorOf(m.inLink) === toEnd && corridorOf(m.outLink) !== toA)).toBe(true);
    // Главная дорога — по-прежнему A–B.
    const prio = g.nodes.get(j.id)!.priorityLanes;
    const main = (g.inLinks.get(j.id) ?? []).filter((l) => l.lanes.some((lane) => prio.has(lane.id))).map((l) => l.corridor);
    expect([...new Set(main)].sort()).toEqual(arms.filter((id) => id !== toEnd).sort());
    expect(game.roads.route(end, b)).not.toBeNull();
    expect(game.roads.route(a, end)).not.toBeNull();
  });

  it('недопустимый перенос отклоняется, сеть не меняется', () => {
    const game = dryGame();
    const { b, origin } = buildBend(game);
    const before = shape(game);
    const money = game.money;
    // За конец C, на продолжение A–C: дорога A–B прошла бы через узел C, дороги сошлись бы в одну.
    const bad = { x: origin.x + 300, y: origin.y + 300 };
    const plan = game.roadBuilder.moveNode(b, bad);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBeTruthy();
    expect(move(game, b, bad)).toBe(false);
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
          const plan = game.roadBuilder.moveNode(nodes[1], w);
          expect(plan.ok).toBe(false);
          expect(plan.reason).toMatch(/вод/i);
          expect(move(game, nodes[1], w)).toBe(false);
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
    expect(move(game, b, { x: origin.x + 230, y: origin.y - 40 })).toBe(true);
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
    const net = game.roads.net;
    // Сначала перекрёстки, у которых на дорогах больше всего машин.
    const cars = new Map<number, number>();
    for (const v of game.traffic.vehicles.values()) {
      const lane = game.roads.graph.lanes.get(v.lane);
      const c = lane && game.roads.graph.links.get(lane.link)?.corridor;
      if (c !== undefined) cars.set(c, (cars.get(c) ?? 0) + 1);
    }
    const busy = (id: number) => net.node(id).corridors.reduce((k, c) => k + (cars.get(c) ?? 0), 0);
    const nodes = [...net.nodes.values()].filter((n) => n.kind === 'junction' && n.corridors.length >= 3);
    nodes.sort((x, y) => busy(y.id) - busy(x.id));
    let moved = false;
    for (const n of nodes) {
      for (const off of [
        { x: 6, y: 0 },
        { x: 0, y: 6 },
        { x: -6, y: 0 },
        { x: 0, y: -6 },
      ]) {
        const corridors = [...n.corridors].sort();
        if (!move(game, n.id, add(n.pos, off))) continue;
        expect([...game.roads.net.node(n.id).corridors].sort()).toEqual(corridors);
        moved = true;
        break;
      }
      if (moved) break;
    }
    expect(moved).toBe(true);
    runSeconds(game, 20);
    expect(game.citizenCars).toBe(game.traffic.vehicles.size);
    expect(game.citizenCars).toBeGreaterThan(0);
  });
});

describe('Излом снова гладкий', () => {
  /** Тянет перо полотна id у узла node в точку p (kink — с Shift); true — построено. */
  function pull(game: Game, id: number, node: number, p: Vec, kink = false): boolean {
    const c = game.roads.net.corridor(id);
    const plan = game.roadBuilder.plan((n) => dragHandle(n, { corridor: id, end: c.a === node ? 'a' : 'b' }, p, kink));
    return plan.ok && game.roadBuilder.apply(plan);
  }

  it('перо излома из двух дорог без Shift — узел снова стык, перья на одной прямой; с Shift — излом остаётся', () => {
    const game = dryGame();
    const { a, b, c, origin } = buildBend(game);
    const net = () => game.roads.net;
    expect(net().node(b).kind).toBe('junction');
    const [first, second] = net().node(b).corridors.map((id) => net().corridor(id));
    const h = { corridor: first.id, end: (first.a === b ? 'a' : 'b') as 'a' | 'b' };
    expect(smoothCorner(net(), h, false)).toBe(true);
    // С Shift — только своё перо: узел так и остаётся изломом.
    expect(pull(game, first.id, b, add(origin, { x: 140, y: 30 }), true)).toBe(true);
    expect(net().node(b).kind).toBe('junction');
    // Без Shift — стык: обе дороги касаются его по одной прямой, полосы продолжают друг друга.
    expect(pull(game, first.id, b, add(origin, { x: 140, y: -40 }))).toBe(true);
    expect(net().node(b).kind).toBe('seam');
    const [e1, e2] = net().ends(net().node(b));
    expect(dot(e1.away, e2.away)).toBeLessThan(-0.999);
    // Длина пера соседа — прежняя.
    const other = net().corridor(second.id);
    const end = other.a === b ? other.curve.p1 : other.curve.p2;
    const was = second.a === b ? second.curve.p1 : second.curve.p2;
    expect(dist(end, net().node(b).pos)).toBeCloseTo(dist(was, net().node(b).pos), 6);
    expect(net().problems()).toEqual([]);
    expect(game.roads.route(a, c)).not.toBeNull();
  });

  it('излом дорог с разными полосами гладким не станет — тянется только своё перо', () => {
    const game = dryGame();
    const { b, origin } = buildBend(game);
    const net = () => game.roads.net;
    const [first, second] = net().node(b).corridors;
    // Вторая дорога — проспект: полосы улицы её не продолжают.
    const up = game.roadBuilder.rebuild(second, { cls: 'avenue', lanes: AVENUE.lanes });
    expect(up.ok && game.roadBuilder.apply(up)).toBe(true);
    const fc = net().corridor(first);
    expect(smoothCorner(net(), { corridor: first, end: fc.a === b ? 'a' : 'b' }, false)).toBe(false);
    expect(pull(game, first, b, add(origin, { x: 140, y: -40 }))).toBe(true);
    expect(net().node(b).kind).toBe('junction');
  });
});
