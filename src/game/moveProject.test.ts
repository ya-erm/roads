import { describe, expect, it } from 'vitest';
import { add, dist, Vec } from '../core/vec';
import { RoadTools } from '../input/roadtools';
import { Game } from './game';
import { MoveProject } from './moveProject';
import { moveNodeEdit, reshapeEdit } from './roadbuild';
import { corridorCurveSigns, freshSignCorridors, staleSignCorridors } from './roadProject';
import { roadPlan, STREET } from './testkit';

const KINKED = { ...STREET, kink: true };

function dryGame(): Game {
  return new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
}

/** Г-образный изгиб A–B–C из двух прямых улиц в свободном месте: узлы и угол. */
function bend(game: Game): { a: number; b: number; c: number; o: Vec } {
  for (let y = 400; y < game.terrain.height - 500; y += 120) {
    for (let x = 300; x < game.terrain.width - 500; x += 160) {
      const o = { x, y };
      if (!roadPlan(game, { free: add(o, { x: -60, y: 260 }) }, { free: add(o, { x: 260, y: -60 }) }).ok) continue;
      const first = roadPlan(game, { free: o }, { free: add(o, { x: 200, y: 0 }) }, KINKED);
      if (!first.ok || !game.roadBuilder.apply(first)) continue;
      const net = () => game.roads.net;
      const a = net().nodesNear(o, 1)[0].id;
      const b = net().nodesNear(add(o, { x: 200, y: 0 }), 1)[0].id;
      const second = roadPlan(game, b, { free: add(o, { x: 200, y: 200 }) }, KINKED);
      if (!second.ok || !game.roadBuilder.apply(second)) continue;
      return { a, b, c: net().nodesNear(add(o, { x: 200, y: 200 }), 1)[0].id, o };
    }
  }
  throw new Error('Нет места для изгиба');
}

describe('Проект перемещения', () => {
  it('правки копятся, дорога не меняется и денег не тратит; «Построить» — всё разом, Ctrl+Z — назад', () => {
    const game = dryGame();
    const { b, c, o } = bend(game);
    const mp = new MoveProject(() => game);
    const money = game.money;
    const shape = JSON.stringify([...game.roads.net.corridors.values()].map((x) => x.curve));
    const B = add(o, { x: 230, y: -30 });
    const C = add(o, { x: 260, y: 200 });
    expect(mp.add(moveNodeEdit(b, B))).toBeNull();
    expect(mp.add(moveNodeEdit(c, C))).toBeNull();
    // Дорога — как была; проект — сеть с обеими правками.
    expect(game.money).toBe(money);
    expect(JSON.stringify([...game.roads.net.corridors.values()].map((x) => x.curve))).toBe(shape);
    const draft = mp.net()!;
    expect(dist(draft.node(b).pos, B)).toBeLessThan(1e-9);
    expect(dist(draft.node(c).pos, C)).toBeLessThan(1e-9);
    const plan = mp.plan();
    expect(plan.ok).toBe(true);
    // Цена — разом за обе правки, как один перенос.
    expect(mp.build()).toBeNull();
    expect(mp.edits.length).toBe(0);
    expect(dist(game.roads.net.node(b).pos, B)).toBeLessThan(1e-9);
    expect(dist(game.roads.net.node(c).pos, C)).toBeLessThan(1e-9);
    expect(game.money).toBe(money - plan.cost);
    expect(game.roads.net.problems()).toEqual([]);
    // Один шаг отмены — оба переноса назад.
    expect(game.undo()).toBe('перенос дороги');
    expect(dist(game.roads.net.node(b).pos, add(o, { x: 200, y: 0 }))).toBeLessThan(1e-9);
    expect(dist(game.roads.net.node(c).pos, add(o, { x: 200, y: 200 }))).toBeLessThan(1e-9);
    expect(game.money).toBe(money);
  });

  it('Ctrl+Z в проекте — шаг назад; «Отменить» — сброс; правка, которой не сделать, не добавляется', () => {
    const game = dryGame();
    const { b, c, o } = bend(game);
    const mp = new MoveProject(() => game);
    mp.add(moveNodeEdit(b, add(o, { x: 220, y: -20 })));
    mp.add(moveNodeEdit(c, add(o, { x: 240, y: 220 })));
    expect(mp.undo()).toBe(true);
    expect(dist(mp.net()!.node(c).pos, add(o, { x: 200, y: 200 }))).toBeLessThan(1e-9);
    expect(dist(mp.net()!.node(b).pos, add(o, { x: 220, y: -20 }))).toBeLessThan(1e-9);
    // Нет такого полотна — правка не выходит совсем.
    expect(mp.add(reshapeEdit(999_999, (_, x) => x.curve))).toBeTruthy();
    expect(mp.edits.length).toBe(1);
    mp.clear();
    expect(mp.net()).toBeNull();
    expect(mp.build()).toBe('Проект пуст');
  });

  it('не проходит проверку — правка в проекте (красным), её чинит следующая; построить можно, только когда всё в порядке', () => {
    const game = dryGame();
    const { b, o } = bend(game);
    const mp = new MoveProject(() => game);
    // Изгиб — почти на угол A: полотно короче допустимого.
    expect(mp.add(moveNodeEdit(b, add(o, { x: 4, y: 3 })))).toBeNull();
    expect(mp.plan().ok).toBe(false);
    expect(mp.build()).toBe(mp.plan().reason);
    expect(dist(game.roads.net.node(b).pos, add(o, { x: 200, y: 0 }))).toBeLessThan(1e-9);
    expect(mp.add(moveNodeEdit(b, add(o, { x: 210, y: 20 })))).toBeNull();
    expect(mp.plan().ok).toBe(true);
    expect(mp.build()).toBeNull();
  });

  it('инструмент «Двигать» тянет от сети с проектом: узел берут там, где он в проекте', () => {
    const game = dryGame();
    const { b, o } = bend(game);
    const mp = new MoveProject(() => game);
    const rt = new RoadTools(() => game);
    const B1 = add(o, { x: 230, y: -40 });
    mp.add(moveNodeEdit(b, B1));
    rt.base = mp.net();
    // Узел в проекте — уже в B1: за него и берут, а не за старое место.
    expect(rt.moveDown(add(o, { x: 200, y: 0 }), 6)).toBe(false);
    expect(rt.moveDown(B1, 6)).toBe(true);
    const B2 = add(o, { x: 250, y: -10 });
    const edit = rt.moveEdit(B2)!;
    rt.moveEnd();
    expect(mp.add(edit)).toBeNull();
    expect(dist(mp.net()!.node(b).pos, B2)).toBeLessThan(1e-9);
    expect(dist(game.roads.net.node(b).pos, add(o, { x: 200, y: 0 }))).toBeLessThan(1e-9);
  });

  it('знаки старого положения переносимых дорог — «старые», остальных дорог — нет', () => {
    const game = dryGame();
    const { a, b, o } = bend(game);
    const mp = new MoveProject(() => game);
    mp.add(moveNodeEdit(b, add(o, { x: 230, y: -30 })));
    const stale = staleSignCorridors(game.roads.net, mp.net()!);
    // Обе дороги изгиба поменяли форму — их знаки старые; улицы города не тронуты.
    expect([...stale].sort()).toEqual([...game.roads.net.node(b).corridors].sort());
    expect(stale.has(game.roads.net.node(a).corridors[0])).toBe(true);
    expect(game.roads.net.corridors.size).toBeGreaterThan(stale.size);
    // Без правок — старых знаков нет.
    expect(staleSignCorridors(game.roads.net, game.roads.net.clone()).size).toBe(0);
  });

  it('протяжка в «Двигать»: знаки считаются по новой форме только у изменённых дорог, их прежние знаки — скрыть', () => {
    const game = dryGame();
    const { a, b } = bend(game);
    const net = game.roads.net;
    const id = net.node(a).corridors[0];
    const A = net.node(a).pos;
    const B = net.node(b).pos;
    // Тянем перо: улица — «змейкой», на 40 км/ч уже тесно.
    const plan = game.roadBuilder.plan(reshapeEdit(id, () => ({ p0: A, p1: add(A, { x: 20, y: -120 }), p2: add(B, { x: -20, y: 120 }), p3: B })));
    const after = plan.net!;
    const fresh = freshSignCorridors(net, after, plan.changed);
    expect(fresh).toEqual([id]);
    expect([...staleSignCorridors(net, after)]).toEqual([id]);
    const live = corridorCurveSigns(after, fresh);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((s) => s.kmh < 40)).toBe(true);
    // Узел перенесли: изменились обе дороги изгиба — у остальных знаки прежние.
    const moved = game.roadBuilder.moveNode(b, add(B, { x: 20, y: -30 }));
    expect([...freshSignCorridors(net, moved.net!, moved.changed)].sort()).toEqual([...net.node(b).corridors].sort());
  });

  it('знаки скорости на поворотах полотен проекта', () => {
    const game = dryGame();
    const { a, b, o } = bend(game);
    const mp = new MoveProject(() => game);
    const id = game.roads.net.node(a).corridors[0];
    // Прямая улица выгнута в «змейку» с крутыми поворотами — на 40 км/ч уже тесно.
    const A = game.roads.net.node(a).pos;
    const B = game.roads.net.node(b).pos;
    expect(mp.add(reshapeEdit(id, () => ({ p0: A, p1: add(A, { x: 20, y: -120 }), p2: add(B, { x: -20, y: 120 }), p3: B })))).toBeNull();
    const net = mp.net()!;
    expect(corridorCurveSigns(net, [id]).length).toBeGreaterThan(0);
    expect(corridorCurveSigns(game.roads.net, [id])).toEqual([]);
    expect(o).toBeDefined();
  });
});
