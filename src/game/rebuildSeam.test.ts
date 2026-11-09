import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import type { Vec } from '../core/vec';
import { closureOf } from '../lanes/closure';
import { dragLane, startLane } from '../lanes/edit';
import { edgesAt, pointOff } from '../lanes/geometry';
import { type LaneNet, taperLen, twoWay } from '../lanes/model';
import { openNet } from '../lanes/open';
import type { BuildBase } from '../world/entities';
import type { WorldSettings } from '../world/settings';
import { Game } from './game';
import { anchorOf, clearStrip, HIGHWAY, road, runSeconds, withoutCitizens } from './testkit';

/**
 * Шоссе 1+1, нарисованное кусками (стыки между ними), перестраивают в магистраль 2+2 по куску за раз (отчёт
 * 0.2.115: между перестроенными кусками — сужения). Отгон к 1+1 у куска, перестроенного первым, у второго должен
 * уйти: дорога 2+2 продолжается — полотно ровное по всей длине и на стройке, и после неё.
 */
const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' };
const HW2 = { cls: 'highway' as const, lanes: twoWay(2, 2) };

function nodeAt(game: Game, p: Vec): number | null {
  return [...game.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - p.x, n.pos.y - p.y) < 1)?.id ?? null;
}

function freeSpot(game: Game, len: number): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 160) {
      if (!clearStrip(game, { x: x - 120, y }, { x: x + len + 200, y }, 200)) continue;
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x: x - 90, y } }), anchorOf(game, { free: { x: x + len + 150, y } }), HIGHWAY);
      if (plan.ok && !plan.demolish.length) return { x, y };
    }
  }
  throw new Error('нет места');
}

/**
 * Шоссе 1+1 с запада на восток: подъезд от ворот базы, куски по xs (стыки между ними), за последним — ещё 150 м.
 * Ответ — игра, начало и id кусков по xs.
 */
function scene(mode: 'build' | 'instant', xs: number[], profile: typeof HIGHWAY = HIGHWAY): { game: Game; at: Vec; pieces: number[] } {
  const game = withoutCitizens(new Game({ ...WORLD, ...(mode === 'build' ? { construction: 'build' as const } : {}) }));
  const len = xs[xs.length - 1];
  const at = freeSpot(game, len);
  const gate = { x: at.x - 90, y: at.y };
  expect(road(game, { free: gate }, { free: at }, HIGHWAY)).toBe(true);
  let prev = 0;
  for (const x of [...xs, len + 150]) {
    expect(road(game, nodeAt(game, { x: at.x + prev, y: at.y })!, { free: { x: at.x + x, y: at.y } }, profile)).toBe(true);
    prev = x;
  }
  if (mode === 'build') {
    const crews = game.construction.crews;
    const base: BuildBase = { type: 'base', id: 990_000, fp: { center: { x: gate.x, y: gate.y + 40 }, w: 36, h: 24, angle: 0 }, nodeId: nodeAt(game, gate)! };
    crews.bases.set(base.id, base);
    crews.hire(base.id);
  }
  const net = game.roads.net;
  let from = 0;
  const pieces = xs.map((x) => {
    const mid = { x: at.x + (from + x) / 2, y: at.y };
    from = x;
    return net.corridorNear(mid, 3)!.id;
  });
  return { game, at, pieces };
}

/** Ширина полотна (по полосам, с отгоном) вдоль дороги от x0 до x1 через каждые 2 м. */
function widths(net: LaneNet, at: Vec, x0: number, x1: number): number[] {
  const res: number[] = [];
  for (let x = x0; x <= x1; x += 2) {
    const p = { x: at.x + x, y: at.y };
    const c = net.corridorNear(p, 3)!;
    const e = edgesAt(c, c.lut.closest(p).s);
    res.push(e ? Math.round((e[1] - e[0]) * 10) / 10 : 0);
  }
  return res;
}

const W22 = 28;

describe('Перестройка кусками: магистраль 2+2 ровная по всей длине', () => {
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });

  it('«Мгновенно»: куски по очереди — между ними без сужений, отгон — только к шоссе 1+1 на концах', () => {
    const { game, at, pieces } = scene('instant', [200, 400, 600]);
    for (const id of pieces) expect(game.roadBuilder.apply(game.roadBuilder.rebuild(id, HW2))).toBe(true);
    const net = game.roads.net;
    expect(new Set(widths(net, at, 72, 528))).toEqual(new Set([W22]));
    // Дальше дорога — шоссе 1+1: там отгон (переход к другому профилю).
    expect(widths(net, at, 0, 0)[0]).toBeLessThan(W22);
    expect(widths(net, at, 600, 600)[0]).toBeLessThan(W22);
    expect(net.problems()).toEqual([]);
  });

  it('«Со строительством»: куски разными проектами — и на стройке, и после неё ровная, отгон только к 1+1', () => {
    const { game, at, pieces } = scene('build', [200, 400, 600]);
    // Средний — последним: оба соседа уже перестраиваются.
    for (const id of [pieces[0], pieces[2], pieces[1]]) expect(game.roadBuilder.apply(game.roadBuilder.rebuild(id, HW2))).toBe(true);
    const net = game.roads.net;
    // Проект стройки (чертёж на карте) — 2+2 по всей длине.
    expect(new Set(widths(net, at, 72, 528))).toEqual(new Set([W22]));
    // Пока работы не начаты — по прежней дороге: 1+1 по всей длине, без отгонов.
    expect(new Set(widths(openNet(net), at, 0, 600))).toEqual(new Set([14]));
    for (let i = 0; i < 2000 && pieces.some((id) => net.corridors.get(id)?.build); i++) runSeconds(game, 1);
    expect(pieces.every((id) => !game.roads.net.corridors.get(id)?.build)).toBe(true);
    expect(new Set(widths(game.roads.net, at, 72, 528))).toEqual(new Set([W22]));
    expect(new Set(widths(openNet(game.roads.net, true), at, 72, 528))).toEqual(new Set([W22]));
    expect(widths(game.roads.net, at, 0, 0)[0]).toBeLessThan(W22);
    expect(widths(game.roads.net, at, 600, 600)[0]).toBeLessThan(W22);
  });

  it('«Со строительством»: первый кусок достроен, потом перестраивают соседний — стык без сужения', () => {
    const { game, at, pieces } = scene('build', [300, 600]);
    expect(game.roadBuilder.apply(game.roadBuilder.rebuild(pieces[0], HW2))).toBe(true);
    const net = () => game.roads.net;
    for (let i = 0; i < 2000 && net().corridors.get(pieces[0])?.build; i++) runSeconds(game, 1);
    expect(net().corridors.get(pieces[0])?.build).toBeUndefined();
    // Достроенный — с отгоном к шоссе 1+1 у второго куска.
    expect(widths(net(), at, 298, 298)[0]).toBeLessThan(W22);
    const plan = game.roadBuilder.rebuild(pieces[1], HW2);
    expect(plan.ok).toBe(true);
    expect(game.roadBuilder.apply(plan)).toBe(true);
    expect(new Set(widths(net(), at, 72, 528))).toEqual(new Set([W22]));
    // Отгон достроенного уширяют до 2+2 — это работа на нём: он в том же проекте, с небольшой ценой.
    const a = net().corridors.get(pieces[0])!.build;
    expect(a?.project).toBe(plan.project?.id);
    expect(a?.was?.lanes.length).toBe(4);
    expect(a!.was!.price).toBeLessThan(plan.project!.cost / 4);
    for (let i = 0; i < 2000 && pieces.some((id) => net().corridors.get(id)?.build); i++) runSeconds(game, 1);
    expect(new Set(widths(net(), at, 72, 528))).toEqual(new Set([W22]));
  });

  it('короткий кусок (короче отгона) между перестроенными — тоже 2+2', () => {
    const { game, at, pieces } = scene('instant', [200, 250, 450]);
    // Короткий средний — сразу за первым: у второго конца пока шоссе 1+1, на отгон места нет.
    for (const id of pieces) expect(game.roadBuilder.apply(game.roadBuilder.rebuild(id, HW2))).toBe(true);
    const net = game.roads.net;
    expect(new Set(widths(net, at, 72, 378))).toEqual(new Set([W22]));
    expect(net.problems()).toEqual([]);
  });
});

describe('Продление полосы «Полосой» — стройка только прибавки', () => {
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });

  it('конец добавочной полосы на 30 м дальше: в проекте кусок с прибавкой и отгоном, остальное полотно готово и открыто', () => {
    const { game, at, pieces } = scene('build', [600], HW2);
    const id = pieces[0];
    const T = taperLen('highway');
    // Добавочная полоса справа на 150…300 м — готовая (правка без стройки).
    const add = game.roadBuilder.plan((n) => {
      const c = n.corridors.get(id)!;
      n.setLanes(c, [...c.lanes, { offset: 17.5, flow: 1, from: 150, to: 300 }]);
    });
    expect(add.ok).toBe(true);
    expect(game.roadBuilder.apply(add)).toBe(true);
    const before = game.roads.net.corridors.get(id)!;
    const L = before.length;
    // Тянем её конец с 300 до 330 м.
    const net0 = game.roads.net;
    let d = startLane(net0, pointOff(before, 298, 17.5), 14);
    expect(d.grab?.end).toBe('to');
    d = dragLane(net0, d, pointOff(before, 330, 17.5), 14);
    const plan = game.roadBuilder.lane(d, 'highway');
    expect(plan.ok).toBe(true);
    // Для сравнения: полоса вдоль всего полотна — перестройка всех 600 м.
    const whole = game.roadBuilder.rebuild(id, { cls: 'highway', lanes: [...twoWay(2, 2), { offset: 17.5, flow: 1, from: 0, to: L }] });
    expect(whole.project?.length).toBeCloseTo(L, 0);
    // Стройка — один кусок: прибавка 30 м и новый отгон, а не всё полотно в 600 м.
    const p = plan.project!;
    expect(p.rebuild?.count).toBe(1);
    expect(p.length).toBeGreaterThan(30);
    expect(p.length).toBeLessThan(30 + T + 20);
    const cut = plan.split?.get(id);
    expect(cut?.length).toBe(3);
    expect(game.roadBuilder.apply(plan)).toBe(true);
    const net = game.roads.net;
    const piece = net.corridors.get(p.corridors[0])!;
    const w = piece.build!.was!;
    expect(w.edge).toBe(true);
    // Остальное — готовое, как было.
    for (const k of cut!) if (k.id !== piece.id) expect(net.corridors.get(k.id)?.build).toBeUndefined();
    // Цена и время — по прибавке: во много раз меньше, чем полоса вдоль всего полотна.
    expect(w.price * 5).toBeLessThan(whole.project!.cost);
    expect(p.seconds * 5).toBeLessThan(whole.project!.seconds);
    // Пока не начали — по прежней дороге: полотно как до правки (с прежним концом полосы и отгоном).
    expect(widths(openNet(net), at, 0, 600)).toEqual(widths(openNet(net0), at, 0, 600));
    // Начали — перекрыто только место новой полосы: все прежние полосы открыты.
    for (let i = 0; i < 400 && (game.roads.net.corridors.get(piece.id)?.build?.done ?? 0) <= 0; i++) runSeconds(game, 0.5);
    const b = game.roads.net.corridors.get(piece.id)?.build;
    expect(b?.done).toBeGreaterThan(0);
    expect(closureOf(b)).toBe('part');
    expect(game.roads.open.corridors.get(piece.id)?.lanes.length).toBe(w.lanes.length);
    for (let i = 0; i < 2000 && game.roads.net.corridors.get(piece.id)?.build; i++) runSeconds(game, 1);
    expect(game.roads.net.corridors.get(piece.id)?.build).toBeUndefined();
    // Достроили: полоса до 330 м, полотно ровное по всей длине (5 полос на 150…330 м).
    const after = widths(game.roads.net, at, 150, 330);
    expect(new Set(after)).toEqual(new Set([W22 + 7]));
    expect(widths(game.roads.net, at, 330 + T + 4, L - 80).every((x) => x === W22)).toBe(true);
    expect(game.roads.net.problems()).toEqual([]);
  });

  it('полосу дотянули до стыка с такой же за ним: стройка — только у стыка, по куску с каждой стороны', () => {
    const { game, at, pieces } = scene('build', [400, 800], HW2);
    const T = taperLen('highway');
    // Добавочная полоса кончается отгоном перед стыком (до 300 м) и начинается за ним (с 470 м): разрыв ~170 м.
    const add = game.roadBuilder.plan((n) => {
      const [a, b] = pieces.map((id) => n.corridors.get(id)!);
      n.setLanes(a, [...a.lanes, { offset: 17.5, flow: 1, from: 100, to: 300 }]);
      n.setLanes(b, [...b.lanes, { offset: 17.5, flow: 1, from: T, to: 300 }]);
    });
    expect(game.roadBuilder.apply(add)).toBe(true);
    const net0 = game.roads.net;
    const a0 = net0.corridors.get(pieces[0])!;
    let d = startLane(net0, pointOff(a0, 298, 17.5), 14);
    d = dragLane(net0, d, pointOff(a0, 340, 17.5), 14);
    const plan = game.roadBuilder.lane(d, 'highway');
    expect(plan.ok).toBe(true);
    const p = plan.project!;
    // Два куска у стыка: свой (прибавка до стыка) и соседа (его отгон стал полосой) — не оба полотна по 400 м.
    expect(p.rebuild?.count).toBe(2);
    expect(p.length).toBeLessThan(100 + 2 * T + 30);
    expect(plan.split?.get(pieces[0])?.length).toBe(2);
    expect(plan.split?.get(pieces[1])?.length).toBe(2);
    expect(game.roadBuilder.apply(plan)).toBe(true);
    for (let i = 0; i < 2000 && p.corridors.some((id) => game.roads.net.corridors.get(id)?.build); i++) runSeconds(game, 1);
    // Достроили: полоса без разрыва с 100 до 700 м.
    expect(new Set(widths(game.roads.net, at, 100, 700))).toEqual(new Set([W22 + 7]));
    expect(game.roads.net.problems()).toEqual([]);
  });
});
