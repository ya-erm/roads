import { describe, expect, it } from 'vitest';
import { add, Vec } from '../core/vec';
import { Game } from '../game/game';
import { road, roadPlan, STREET } from '../game/testkit';
import type { LaneNet } from './model';
import { mergeEdit, mergeProblem, splitEdit, splitProblem } from './nodeEdit';

function dryGame(): Game {
  return new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
}

/** Свободное место, где дорога от o до o+d (и вокруг) строится. */
function spot(game: Game, d: Vec): Vec {
  for (let y = 500; y < game.terrain.height - 600; y += 140) {
    for (let x = 400; x < game.terrain.width - 700; x += 170) {
      const o = { x, y };
      if (roadPlan(game, { free: add(o, { x: -40, y: 160 }) }, { free: add(o, add(d, { x: 40, y: -160 })) }).ok && roadPlan(game, { free: o }, { free: add(o, d) }).ok) return o;
    }
  }
  throw new Error('Нет места');
}

const nodeAt = (net: LaneNet, p: Vec) => net.nodesNear(p, 1)[0];

/** Насколько ось сети после правки отходит от прежней оси (по точкам прежних полотен ids). */
function deviation(before: LaneNet, ids: number[], after: LaneNet): number {
  let worst = 0;
  for (const id of ids) {
    const c = before.corridor(id);
    for (let i = 0; i <= 20; i++) {
      const q = c.lut.pointAt((c.length * i) / 20);
      const d = Math.min(...after.corridorsNear(q, 20).map((o) => o.lut.closest(q).d));
      worst = Math.max(worst, d);
    }
  }
  return worst;
}

describe('Узел на дороге: разделить и убрать', () => {
  it('дорога делится узлом — форма и полосы те же; узел убирают — снова одно полотно той же формы', () => {
    const game = dryGame();
    const o = spot(game, { x: 300, y: 0 });
    // Дуга: так видно, что форма сохраняется не только у прямой.
    expect(game.roadBuilder.apply(game.roadBuilder.road({ kind: 'free', pos: o }, { kind: 'free', pos: add(o, { x: 300, y: 0 }) }, { ...STREET, control: add(o, { x: 150, y: -90 }) }))).toBe(true);
    const net0 = game.roads.net;
    const c = [...net0.corridors.values()].find((x) => x.a === nodeAt(net0, o).id || x.b === nodeAt(net0, o).id)!;
    const lanes = JSON.stringify(c.lanes.map((l) => [l.offset, l.flow]));
    const money = game.money;
    // Разделить посередине.
    expect(splitProblem(net0, c, c.length / 2)).toBeNull();
    const split = game.roadBuilder.plan(splitEdit(c.id, c.length / 2), { only: () => false });
    expect(split.ok).toBe(true);
    game.checkpoint('узел на дороге');
    game.roadBuilder.apply(split);
    game.commit();
    const net1 = game.roads.net;
    const mid = nodeAt(net1, c.lut.pointAt(c.length / 2));
    expect(mid.kind).toBe('seam');
    expect(mid.corridors.length).toBe(2);
    expect(deviation(net0, [c.id], net1)).toBeLessThan(0.05);
    expect(net1.problems()).toEqual([]);
    expect(game.money).toBe(money);
    // Убрать узел: снова одно полотно, полосы те же, форма почти та же.
    expect(mergeProblem(net1, mid.id)).toBeNull();
    const halves = [...mid.corridors];
    const merge = game.roadBuilder.plan(mergeEdit(mid.id));
    expect(merge.ok).toBe(true);
    game.roadBuilder.apply(merge);
    const net2 = game.roads.net;
    expect(net2.nodes.has(mid.id)).toBe(false);
    const one = [...net2.corridors.values()].find((x) => x.a === nodeAt(net2, o).id || x.b === nodeAt(net2, o).id)!;
    expect(net2.corridors.has(halves[0])).toBe(false);
    expect(JSON.stringify(one.lanes.map((l) => [l.offset, l.flow]))).toBe(lanes);
    expect(Math.abs(one.length - c.length)).toBeLessThan(0.5);
    expect(deviation(net0, [c.id], net2)).toBeLessThan(0.5);
    expect(net2.problems()).toEqual([]);
    expect(game.roads.route(nodeAt(net2, o).id, nodeAt(net2, add(o, { x: 300, y: 0 })).id)).not.toBeNull();
    // Ctrl+Z — узел снова на месте... и ещё раз — дорога как была.
    expect(game.undo()).toBeTruthy();
  });

  it('полотна навстречу друг другу (у обоих конец в узле) сливаются с полосами в нужную сторону', () => {
    const game = dryGame();
    const o = spot(game, { x: 400, y: 0 });
    expect(road(game, { free: o }, { free: add(o, { x: 200, y: 0 }) })).toBe(true);
    const B = nodeAt(game.roads.net, add(o, { x: 200, y: 0 })).id;
    // Вторая дорога строится от дальней точки к тупику B — оба полотна кончаются в B.
    expect(road(game, { free: add(o, { x: 400, y: 0 }) }, B)).toBe(true);
    const net = game.roads.net;
    expect(net.node(B).kind).toBe('seam');
    expect(net.node(B).corridors.map((id) => (net.corridor(id).b === B ? 'b' : 'a'))).toEqual(['b', 'b']);
    expect(mergeProblem(net, B)).toBeNull();
    const plan = game.roadBuilder.plan(mergeEdit(B));
    expect(plan.ok).toBe(true);
    game.roadBuilder.apply(plan);
    const after = game.roads.net;
    expect(after.problems()).toEqual([]);
    const a = nodeAt(after, o).id;
    const c = nodeAt(after, add(o, { x: 400, y: 0 })).id;
    expect(game.roads.route(a, c)).not.toBeNull();
    expect(game.roads.route(c, a)).not.toBeNull();
  });

  it('что убрать нельзя — с причиной: тупик, перекрёсток, излом, разная скорость; узел у самого конца — нельзя', () => {
    const game = dryGame();
    const o = spot(game, { x: 300, y: 0 });
    expect(road(game, { free: o }, { free: add(o, { x: 300, y: 0 }) })).toBe(true);
    let net = game.roads.net;
    const end = nodeAt(net, o);
    expect(mergeProblem(net, end.id)).toMatch(/Тупик/);
    const c = net.corridor(end.corridors[0]);
    expect(splitProblem(net, c, 4)).toMatch(/близко/);
    // Перекрёсток: ответвление от середины.
    expect(road(game, add(o, { x: 150, y: 0 }), { free: add(o, { x: 150, y: 150 }) })).toBe(true);
    net = game.roads.net;
    const t = nodeAt(net, add(o, { x: 150, y: 0 }));
    expect(t.kind).toBe('junction');
    expect(mergeProblem(net, t.id)).toMatch(/Перекрёсток/);
    // Излом из двух дорог: сначала гладко.
    const tip = nodeAt(net, add(o, { x: 300, y: 0 })).id;
    expect(road(game, tip, { free: add(o, { x: 420, y: -120 }) }, { ...STREET, kink: true })).toBe(true);
    net = game.roads.net;
    expect(mergeProblem(net, tip)).toMatch(/излом/);
    // Разная скорость у двух половин — узел нужен.
    const far = nodeAt(net, add(o, { x: 420, y: -120 })).id;
    expect(road(game, far, { free: add(o, { x: 540, y: -240 }) })).toBe(true);
    net = game.roads.net;
    const seam = net.node(far);
    expect(seam.kind).toBe('seam');
    expect(mergeProblem(net, far)).toBeNull();
    const limited = game.roadBuilder.setLimit([seam.corridors[0]], 60);
    game.roadBuilder.apply(limited);
    expect(mergeProblem(game.roads.net, far)).toMatch(/скорости/);
  });
});
