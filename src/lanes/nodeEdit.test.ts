import { describe, expect, it } from 'vitest';
import { bezPoint, minRadius } from '../core/bezier';
import { add, dot, norm, scale, sub, Vec } from '../core/vec';
import type { Game } from '../game/game';
import { freshGame, HIGHWAY, road, roadPlan, STREET } from '../game/testkit';
import { ROAD_CLASSES } from '../world/roadTypes';
import type { Corridor, LaneNet } from './model';
import { jointOf, mergeEdit, mergePreview, mergeProblem, splitEdit, splitProblem, toggleJointEdit } from './nodeEdit';

function dryGame(): Game {
  return freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
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

  it('что убрать нельзя — с причиной: тупик, перекрёсток, разная скорость; излом — можно; узел у самого конца — нельзя', () => {
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
    // Излом из двух дорог: убирается сразу — сольются плавной кривой.
    const tip = nodeAt(net, add(o, { x: 300, y: 0 })).id;
    expect(road(game, tip, { free: add(o, { x: 420, y: -120 }) }, { ...STREET, kink: true })).toBe(true);
    net = game.roads.net;
    expect(net.node(tip).kind).toBe('junction');
    expect(mergeProblem(net, tip)).toBeNull();
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

/** Тупик o → излом K (o + 200 по x) → поворот на 45° до far: дорога изломом из двух полотен. */
function kinkScene(profile = STREET, second: Vec = { x: 350, y: -150 }): { game: Game; o: Vec; K: number; far: Vec } {
  const game = dryGame();
  const o = spot(game, { x: 400, y: 0 });
  expect(road(game, { free: o }, { free: add(o, { x: 200, y: 0 }) }, profile)).toBe(true);
  const K = nodeAt(game.roads.net, add(o, { x: 200, y: 0 })).id;
  const far = add(o, second);
  expect(road(game, K, { free: far }, { ...profile, kink: true })).toBe(true);
  expect(game.roads.net.node(K).kind).toBe('junction');
  return { game, o, K, far };
}

/** Касательная полотна c по ходу от узла from. */
function tangentFrom(c: Corridor, from: number): Vec {
  return c.a === from ? c.lut.tangentAt(0) : scale(c.lut.tangentAt(c.length), -1);
}

describe('Излом: убрать сразу и двойной клик — излом ↔ гладкий', () => {
  it('излом убирается сразу: одна дорога плавной кривой, касательные на концах прежние; Ctrl+Z — излом снова', () => {
    const { game, o, K, far } = kinkScene();
    const before = game.roads.net;
    const ids = [...before.node(K).corridors];
    expect(mergeProblem(before, K)).toBeNull();
    const preview = mergePreview(before, K);
    expect(preview).not.toBeNull();
    game.checkpoint('излом убран');
    const plan = game.roadBuilder.plan(mergeEdit(K));
    expect(plan.ok).toBe(true);
    game.roadBuilder.apply(plan);
    game.commit();
    const net = game.roads.net;
    expect(net.nodes.has(K)).toBe(false);
    for (const id of ids) expect(net.corridors.has(id)).toBe(false);
    const A = nodeAt(net, o);
    const B = nodeAt(net, far);
    expect(A.corridors.length).toBe(1);
    const one = net.corridor(A.corridors[0]);
    expect([one.a, one.b].sort()).toEqual([A.id, B.id].sort());
    // Плавно: поворот не круче, чем можно улице; угол срезан, но не дальше разумного.
    expect(minRadius(one.curve)).toBeGreaterThanOrEqual(ROAD_CLASSES.street.minRadius);
    expect(one.curve).toEqual(preview);
    const dev = deviation(before, ids, net);
    expect(dev).toBeGreaterThan(3);
    expect(dev).toBeLessThan(40);
    // Концы — с прежними касательными: из тупика по x, в дальний конец — по второй дороге.
    expect(dot(tangentFrom(one, A.id), { x: 1, y: 0 })).toBeGreaterThan(0.999);
    const d2 = norm(sub(far, add(o, { x: 200, y: 0 })));
    expect(dot(scale(tangentFrom(one, B.id), -1), d2)).toBeGreaterThan(0.999);
    expect(net.problems()).toEqual([]);
    expect(game.roads.route(A.id, B.id)).not.toBeNull();
    expect(game.roads.route(B.id, A.id)).not.toBeNull();
    // Ctrl+Z — излом на месте.
    expect(game.undo()).toBeTruthy();
    const back = game.roads.net;
    expect(back.node(K).kind).toBe('junction');
    expect([...back.node(K).corridors].sort()).toEqual([...ids].sort());
  });

  it('излом слишком крутой для типа дороги — отказ с радиусом; кривая задевает дорогу — отказ проверки стройки', () => {
    // Магистраль: поворот на 90° в 40 м от тупика — плавно не выйдет.
    const steep = kinkScene(HIGHWAY, { x: 200, y: -40 });
    expect(mergeProblem(steep.game.roads.net, steep.K)).toMatch(/Излом слишком крутой.*радиусом \d+ м.*Магистраль.*от 49 м/);
    expect(mergePreview(steep.game.roads.net, steep.K)).toBeNull();
    const plan = steep.game.roadBuilder.plan(mergeEdit(steep.K));
    expect(plan.ok).toBe(false);
    expect(plan.reason).toMatch(/Излом слишком крутой/);
    // Магистраль под 90° с длинными плечами: срезанный угол широкий, в нём — улица; по форме слить можно, но
    // кривая прошла бы по улице — отказ проверки дороги.
    const { game, o, K } = kinkScene(HIGHWAY, { x: 200, y: -200 });
    const curve = mergePreview(game.roads.net, K)!;
    expect(curve).not.toBeNull();
    const q = bezPoint(curve, 0.5);
    const out = norm(sub(q, add(o, { x: 200, y: 0 })));
    expect(road(game, { free: add(q, scale(out, -6)) }, { free: add(q, scale(out, 60)) })).toBe(true);
    expect(mergeProblem(game.roads.net, K)).toBeNull();
    const blocked = game.roadBuilder.plan(mergeEdit(K));
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toBe('Слишком близко к другой дороге');
  });

  it('двойной клик: гладкий стык — излом (форма та же), излом — гладкий (перья на одну прямую посередине); Ctrl+Z', () => {
    const { game, K } = kinkScene();
    let net = game.roads.net;
    expect(jointOf(net, K)).toBe('kink');
    const ids = [...net.node(K).corridors];
    const dirs0 = ids.map((id) => tangentFrom(net.corridor(id), K));
    // Излом → гладко: каждая дорога поворачивает в узле на половину угла излома.
    game.checkpoint('узел гладкий');
    const smooth = game.roadBuilder.plan(toggleJointEdit(K), { rebuild: true });
    expect(smooth.ok).toBe(true);
    game.roadBuilder.apply(smooth);
    game.commit();
    net = game.roads.net;
    expect(net.node(K).kind).toBe('seam');
    expect(jointOf(net, K)).toBe('smooth');
    const dirs1 = ids.map((id) => tangentFrom(net.corridor(id), K));
    expect(dot(dirs1[0], dirs1[1])).toBeLessThan(-0.9999);
    const kinkAngle = Math.acos(-dot(dirs0[0], dirs0[1]));
    for (let i = 0; i < 2; i++) expect(Math.acos(Math.min(1, dot(dirs0[i], dirs1[i])))).toBeCloseTo(kinkAngle / 2, 2);
    expect(net.problems()).toEqual([]);
    // Гладко → излом: форма та же, перья дальше тянут порознь; такой узел снова убирается.
    const shape = net.corridor(ids[0]).curve;
    const kink = game.roadBuilder.plan(toggleJointEdit(K), { only: () => false });
    expect(kink.ok).toBe(true);
    game.checkpoint('излом в узле');
    game.roadBuilder.apply(kink);
    game.commit();
    net = game.roads.net;
    expect(net.node(K).kind).toBe('junction');
    expect(net.corridor(ids[0]).curve).toEqual(shape);
    expect(jointOf(net, K)).toBe('kink');
    expect(mergeProblem(net, K)).toBeNull();
    // Ctrl+Z — снова гладкий стык, ещё раз — излом как был.
    expect(game.undo()).toBeTruthy();
    expect(game.roads.net.node(K).kind).toBe('seam');
    expect(game.undo()).toBeTruthy();
    expect(game.roads.net.node(K).kind).toBe('junction');
    expect(tangentFrom(game.roads.net.corridor(ids[1]), K).x).toBeCloseTo(dirs0[1].x, 5);
  });

  it('двойной клик не по узлу двух дорог — с причиной', () => {
    const { game, o, K } = kinkScene();
    const net = game.roads.net;
    expect(jointOf(net, nodeAt(net, o).id)).toMatch(/Тупик/);
    // Ответвление от излома — уже перекрёсток.
    expect(road(game, K, { free: add(o, { x: 260, y: 100 }) })).toBe(true);
    expect(jointOf(game.roads.net, K)).toMatch(/Перекрёсток/);
    expect(game.roadBuilder.plan(toggleJointEdit(K)).reason).toMatch(/Перекрёсток/);
  });
});
