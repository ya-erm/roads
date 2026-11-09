import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import type { Vec } from '../core/vec';
import { closureOf, endCuts, keptLanes, reverseZone } from '../lanes/closure';
import { splitBuild } from '../lanes/edit';
import { type Corridor, type CorridorWas, oneWay, twoWay } from '../lanes/model';
import type { BuildBase } from '../world/entities';
import type { WorldSettings } from '../world/settings';
import { projectCardHtml } from '../ui/projectCard';
import { unstarted } from './construction';
import { Game } from './game';
import { rebuildCost, rebuildDiff } from './rebuild';
import { fullCorridorCost } from './roadbuild';
import { anchorOf, AVENUE, clearStrip, road, runSeconds, STREET, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' };
const K = CONSTRUCTION.rebuild;

function nodeAt(game: Game, p: Vec): number | null {
  return [...game.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - p.x, n.pos.y - p.y) < 1)?.id ?? null;
}

/** Свободное место для прямой улицы длиной len вдоль x с подъездом с запада. */
function freeSpot(game: Game, len: number): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 160) {
      if (!clearStrip(game, { x: x - 120, y }, { x: x + len + 100, y }, 200)) continue;
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x: x - 90, y } }), anchorOf(game, { free: { x: x + len, y } }), STREET);
      if (plan.ok && !plan.demolish.length) return { x, y };
    }
  }
  throw new Error('нет места');
}

/**
 * Готовая улица 1+1 от at на восток длиной len, а к ней с запада — подъезд от ворот базы (база своя, одна бригада;
 * бригаду бесплатной базы партии не берём). Ответ — полотно улицы.
 */
function scene(mode: 'build' | 'instant', len = 600, reverse = false): { game: Game; c: Corridor; at: Vec; base: BuildBase | null } {
  const game = withoutCitizens(new Game({ ...WORLD, ...(mode === 'build' ? { construction: 'build' as const } : {}) }));
  const at = freeSpot(game, len);
  const gate = { x: at.x - 90, y: at.y };
  expect(road(game, { free: gate }, { free: at })).toBe(true);
  // reverse — улица нарисована с востока: её конец b — у базы, бригада заполняет её от b (fromB).
  if (reverse) expect(road(game, { free: { x: at.x + len, y: at.y } }, nodeAt(game, at)!)).toBe(true);
  else expect(road(game, nodeAt(game, at)!, { free: { x: at.x + len, y: at.y } })).toBe(true);
  // За дальним концом — ещё кусок улицы: улица не в тупик (по полосам на ней можно оставить одну сторону).
  if (mode === 'build') expect(road(game, nodeAt(game, { x: at.x + len, y: at.y })!, { free: { x: at.x + len + 90, y: at.y } })).toBe(true);
  let base: BuildBase | null = null;
  if (mode === 'build') {
    const crews = game.construction.crews;
    base = { type: 'base', id: 990_000, fp: { center: { x: gate.x, y: gate.y + 40 }, w: 36, h: 24, angle: 0 }, nodeId: nodeAt(game, gate)! };
    crews.bases.set(base.id, base);
    crews.hire(base.id);
  }
  const c = [...game.roads.net.corridors.values()].find((k) => Math.abs(k.lut.pointAt(k.length / 2).x - (at.x + len / 2)) < 2)!;
  expect(c).toBeTruthy();
  return { game, c, at, base };
}

const live = (game: Game, id: number) => game.roads.net.corridors.get(id)!;
const opened = (game: Game, id: number) => game.roads.open.corridors.get(id);

describe('Перестройка: правила', () => {
  it('перекрытие по полосам: 1+1 — одна полоса в одну сторону, 2+2 — 1+1, 3+3 — 2+2, одностороння 2 → 1', () => {
    const k = (lanes: ReturnType<typeof twoWay>) => {
      const kept = keptLanes(lanes);
      return [kept.filter((l) => l.flow > 0).length, kept.filter((l) => l.flow < 0).length];
    };
    expect(k(twoWay(1, 1))).toEqual([1, 0]);
    expect(k(twoWay(2, 2))).toEqual([1, 1]);
    expect(k(twoWay(3, 3))).toEqual([2, 2]);
    expect(k(twoWay(2, 1))).toEqual([1, 0]);
    expect(k(oneWay(2))).toEqual([1, 0]);
    expect(k(oneWay(1))).toEqual([1, 0]);
    // Улица в тупик: развернуться негде — в каждую сторону по полосе.
    const dead = keptLanes(twoWay(1, 1), true);
    expect([dead.filter((l) => l.flow > 0).length, dead.filter((l) => l.flow < 0).length]).toEqual([1, 1]);
    // Остаются полосы у оси.
    const kept = keptLanes(twoWay(2, 2));
    expect(Math.max(...kept.map((l) => Math.abs(l.offset)))).toBeLessThan(Math.max(...twoWay(2, 2).map((l) => Math.abs(l.offset))));
  });

  it('цена: разница цен и работа (на месте — четверть новой, перенос — 60%), время — доля новой дороги', () => {
    const inPlace = { shift: 0, moved: 0, widened: 600, cls: true, flip: false };
    expect(rebuildCost(21_600, 8_400, inPlace, 600)).toEqual({ price: 13_200 + 5_400, work: K.inPlace });
    // Перенос той же дороги целиком: разницы нет — 60% новой, время — как у новой.
    const moved = { shift: 40, moved: 1, widened: 0, cls: false, flip: false };
    expect(rebuildCost(8_400, 8_400, moved, 600)).toEqual({ price: 5_040, work: 1 });
    // Короткий «кармашек» на длинной улице: работы мало, время — не меньше minWork.
    const pocket = { shift: 0, moved: 0, widened: 60, cls: false, flip: false };
    const r = rebuildCost(9_000, 8_400, pocket, 600);
    expect(r.price).toBe(600 + Math.round(9_000 * K.rework * 0.1));
    expect(r.work).toBe(K.minWork);
  });
});

describe('Перестройка: «Мгновенно» — как раньше', () => {
  it('новый профиль — сразу, без проекта', () => {
    const { game, c } = scene('instant');
    const plan = game.roadBuilder.rebuild(c.id, { cls: AVENUE.cls, lanes: AVENUE.lanes });
    expect(plan.ok).toBe(true);
    expect(plan.project).toBeUndefined();
    expect(plan.cost).toBeGreaterThan(0);
    expect(game.roadBuilder.apply(plan)).toBe(true);
    expect(live(game, c.id).build).toBeUndefined();
    expect(live(game, c.id).cls).toBe('avenue');
  });
});

describe('Перестройка: «Со строительством»', () => {
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });

  it('скорость, разворот односторонней, меньше полос и сдвиг до 7 м — сразу; дальше — перенос стройкой', () => {
    const { game, c, at } = scene('build');
    // Скорость — знаки.
    const lim = game.roadBuilder.setLimit([c.id], 30);
    expect(lim.project).toBeUndefined();
    // Меньше полос: 1+1 → одна полоса — снос, сразу.
    const less = game.roadBuilder.rebuild(c.id, { cls: 'street', lanes: oneWay(1) });
    expect(less.ok).toBe(true);
    expect(less.project).toBeUndefined();
    // Узел на конце — на 5 м вбок: сразу (подпись «↔ 5 м ⚡»).
    const end = nodeAt(game, { x: at.x + 600, y: at.y })!;
    const small = game.roadBuilder.moveNode(end, { x: at.x + 600, y: at.y + 5 });
    expect(small.ok).toBe(true);
    expect(small.project).toBeUndefined();
    expect(small.shift).toBeCloseTo(5, 0);
    // На 40 м — перенос: проект, перекрыт сразу.
    const big = game.roadBuilder.moveNode(end, { x: at.x + 600, y: at.y + 40 });
    expect(big.ok).toBe(true);
    expect(big.project?.rebuild?.moved).toBe(true);
    expect(big.cost).toBeLessThanOrEqual(0);
    expect(game.roadBuilder.apply(big)).toBe(true);
    const w = live(game, c.id).build?.was;
    expect(w?.moved).toBe(true);
    expect(w?.nodes?.[0].id).toBe(end);
    expect(closureOf(live(game, c.id).build)).toBe('closed');
    expect(opened(game, c.id)).toBeUndefined();
    // Отмена — дорога на прежнем месте, денег не тратили.
    const p = live(game, c.id).build!.project;
    expect(game.cancelProject(p)).toBe(true);
    expect(live(game, c.id).build).toBeUndefined();
    expect(game.roads.net.node(end).pos.y).toBeCloseTo(at.y, 3);
    expect(opened(game, c.id)).toBeTruthy();
  });

  it('новый класс и полосы — проект: сразу не платят, пока бригада не начала — ездят по прежней дороге', () => {
    const { game, c } = scene('build');
    const money = game.money;
    const plan = game.roadBuilder.rebuild(c.id, { cls: AVENUE.cls, lanes: AVENUE.lanes });
    expect(plan.ok).toBe(true);
    expect(plan.cost).toBe(0);
    expect(plan.project?.rebuild?.count).toBe(1);
    expect(game.roadBuilder.apply(plan)).toBe(true);
    expect(game.money).toBe(money);
    const now = live(game, c.id);
    expect(now.cls).toBe('avenue');
    const w = now.build!.was!;
    expect(w.part).toBe(true);
    expect(w.cls).toBe('street');
    // Цена — по правилу rebuildCost: прежняя улица против нового проспекта.
    const water = (q: Vec, m?: number) => game.isWater(q, m);
    const full = fullCorridorCost(game.roads.net, now, water, game.ground());
    expect(w.price).toBe(rebuildCost(full, w.value, rebuildDiff({ ...now, cls: 'street', lanes: twoWay(1, 1) }, now), now.length).price);
    const p = game.construction.projects.get(now.build!.project)!;
    expect(p.label.startsWith('Перестройка')).toBe(true);
    // Работы не начаты — прежняя улица 1+1 открыта.
    expect(closureOf(now.build)).toBe('old');
    expect(opened(game, c.id)?.lanes.length).toBe(2);
    expect(opened(game, c.id)?.cls).toBe('street');
    expect(game.roads.graph.corridorLinks(c.id).length).toBeGreaterThan(0);
    // Карточка проекта: схема перекрытия и выбор ◐ по полосам / ⛔ целиком; плашка и строка — 🚧.
    const card = projectCardHtml(game, p.id);
    expect(card).toContain('data-action="project-closure"');
    expect(card).toContain('перекроют, когда начнут');
    expect(game.construction.info(p.id)?.rebuild?.count).toBe(1);
  });

  it('работы идут «с проездом»: на участке у бригады одна полоса в обе стороны, 30 км/ч; целиком — дороги нет; достроили — проспект, заплачено по цене', () => {
    const { game, c } = scene('build');
    let paid = 0;
    const spend = game.spend.bind(game);
    game.spend = (amount, kind) => {
      if (kind !== 'purchases') paid += amount;
      spend(amount, kind);
    };
    expect(game.roadBuilder.apply(game.roadBuilder.rebuild(c.id, { cls: AVENUE.cls, lanes: AVENUE.lanes }))).toBe(true);
    const id = live(game, c.id).build!.project;
    const price = live(game, c.id).build!.was!.price;
    let t = 0;
    while (t < 200 && (live(game, c.id).build?.done ?? 0) <= 0) {
      runSeconds(game, 0.5);
      t += 0.5;
    }
    expect(live(game, c.id).build?.done).toBeGreaterThan(0);
    // «С проездом» на 1+1: на участке под реверсом — одна полоса (открытая половина) в обе стороны, вне его — обе
    // стороны на своих местах; скорость зоны работ.
    expect(closureOf(live(game, c.id).build)).toBe('part');
    const o = opened(game, c.id)!;
    const zone = reverseZone(live(game, c.id), live(game, c.id).build!, endCuts(game.roads.net, live(game, c.id)));
    const mid = (zone[0] + zone[1]) / 2;
    const inZone = o.lanes.filter((l) => l.from <= mid && l.to >= mid);
    expect(inZone.map((l) => l.flow).sort()).toEqual([-1, 1]);
    expect(new Set(inZone.map((l) => l.offset)).size).toBe(1);
    const before = o.lanes.filter((l) => l.from <= 1);
    expect(before.map((l) => l.flow).sort()).toEqual([-1, 1]);
    expect(new Set(before.map((l) => l.offset)).size).toBe(2);
    expect(o.limit).toBe(K.zone);
    expect(game.construction.rebuildOf(id)?.open).toEqual([1, 2]);
    // Перекрыть целиком — полотна в сети движения нет, стройка быстрее.
    const slow = game.construction.info(id)!.seconds;
    game.setProjectClosure(id, false);
    expect(opened(game, c.id)).toBeUndefined();
    expect(game.roads.graph.corridorLinks(c.id).length).toBe(0);
    expect(game.construction.info(id)!.seconds).toBeLessThan(slow);
    // Достроили — проспект открыт, заплачено ровно по цене перестройки.
    for (let i = 0; i < 400 && live(game, c.id).build; i++) runSeconds(game, 1);
    expect(live(game, c.id).build).toBeUndefined();
    expect(game.construction.projects.has(id)).toBe(false);
    expect(opened(game, c.id)?.cls).toBe('avenue');
    expect(paid).toBeGreaterThan(price - 2);
    expect(paid).toBeLessThan(price + 2);
  });

  it('отмена начатой перестройки: прежняя улица, заплаченное — назад', () => {
    const { game, c } = scene('build');
    const money = game.money;
    expect(game.roadBuilder.apply(game.roadBuilder.rebuild(c.id, { cls: AVENUE.cls, lanes: AVENUE.lanes }))).toBe(true);
    const id = live(game, c.id).build!.project;
    let t = 0;
    while (t < 300 && (game.construction.projects.get(id)?.spent ?? 0) < 1000) {
      runSeconds(game, 0.5);
      t += 0.5;
    }
    const spent = game.construction.projects.get(id)!.spent;
    expect(spent).toBeGreaterThan(0);
    const before = game.money;
    expect(game.cancelProject(id)).toBe(true);
    expect(game.money - before).toBe(spent);
    const now = live(game, c.id);
    expect(now.build).toBeUndefined();
    expect(now.cls).toBe('street');
    expect(now.lanes.length).toBe(2);
    // Деньги — как до перестройки, кроме содержания бригады.
    expect(game.money).toBeGreaterThan(money - 5_000);
  });

  it('новая полоса «Полосой» тоже перестройка; сохранение хранит прежнюю дорогу', () => {
    const { game, c } = scene('build');
    expect(game.roadBuilder.apply(game.roadBuilder.rebuild(c.id, { cls: 'street', lanes: twoWay(2, 1) }))).toBe(true);
    const w = live(game, c.id).build!.was!;
    expect(w.cls).toBe('street');
    expect(w.part).toBe(true);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const back = withoutCitizens(new Game(save.settings, save));
    const k = back.roads.net.corridors.get(c.id)!;
    expect(k.build?.was?.lanes.length).toBe(2);
    expect(k.build?.was?.price).toBe(w.price);
    expect(back.roads.open.corridors.get(c.id)?.lanes.length).toBe(2);
    expect(back.construction.projects.get(k.build!.project)?.label.startsWith('Перестройка')).toBe(true);
  });

  it('бригада заходит с конца b: пока не начали — прежняя дорога и маршрут по ней; начали — по открытым полосам', () => {
    const { game, c, at } = scene('build', 600, true);
    const gate = nodeAt(game, { x: at.x - 90, y: at.y })!;
    const far = nodeAt(game, { x: at.x + 690, y: at.y })!;
    expect(live(game, c.id).b).toBe(nodeAt(game, at));
    expect(game.roadBuilder.apply(game.roadBuilder.rebuild(c.id, { cls: AVENUE.cls, lanes: AVENUE.lanes }))).toBe(true);
    let fromB = false;
    for (let t = 0; t < 200 && (live(game, c.id).build?.done ?? 0) <= 0; t += 0.5) {
      const b = live(game, c.id).build!;
      fromB ||= !!b.fromB;
      // Бригада выбрала конец — стройка по-прежнему помнит прежнюю дорогу: она открыта, маршрут в обе стороны есть.
      expect(b.was?.cls).toBe('street');
      expect(closureOf(b)).toBe('old');
      expect(game.roads.route(gate, far)).toBeTruthy();
      expect(game.roads.route(far, gate)).toBeTruthy();
      runSeconds(game, 0.5);
    }
    expect(fromB).toBe(true);
    expect(live(game, c.id).build?.done).toBeGreaterThan(0);
    expect(live(game, c.id).build?.was?.cls).toBe('street');
    // «С проездом» на 1+1 — реверс по одной полосе: маршрут есть в обе стороны (по очереди, по светофорам).
    expect(closureOf(live(game, c.id).build)).toBe('part');
    expect(game.roads.route(far, gate)).toBeTruthy();
    expect(game.roads.route(gate, far)).toBeTruthy();
    expect(game.workSignals.list.has(c.id)).toBe(true);
    // Целиком — объезда нет: нет пути ни туда, ни обратно.
    game.setProjectClosure(live(game, c.id).build!.project, false);
    expect(game.roads.route(far, gate)).toBeNull();
  });
});

describe('Перестройка: прежняя дорога не теряется', () => {
  const was = (): CorridorWas => ({ cls: 'street', lanes: twoWay(1, 1), len: 50, limit: 40, value: 1000, price: 3000, work: 0.6, part: true });

  it('не начатый участок, заполняемый с другого конца, — всё ещё перестройка', () => {
    const b = unstarted(7, true, { project: 7, done: 0, was: was() });
    expect(b).toEqual({ project: 7, done: 0, fromB: true, was: was() });
    expect(closureOf(b)).toBe('old');
    expect(unstarted(7, false, { project: 7, done: 0, fromB: true })).toEqual({ project: 7, done: 0 });
  });

  it('разрез перестраиваемого полотна: у кусков — свои части прежней дороги', () => {
    const [p, q] = splitBuild({ project: 3, done: 0, fromB: true, was: { ...was(), moved: true, nodes: [{ id: 1, pos: { x: 0, y: 0 } }] } }, 100, 40);
    expect(p.was?.len).toBe(40);
    expect(q.was?.len).toBe(60);
    expect(p.was?.lanes.map((l) => [l.flow, l.from, l.to])).toEqual([
      [-1, 0, 40],
      [1, 0, 40],
    ]);
    expect(q.was?.lanes.map((l) => [l.flow, l.from, l.to])).toEqual([
      [-1, 0, 60],
      [1, 0, 60],
    ]);
    expect([p.was?.value, q.was?.value]).toEqual([400, 600]);
    expect([p.was?.price, q.was?.price]).toEqual([1200, 1800]);
    // Перенос остаётся переносом, но прежние места узлов кускам не вернуть.
    expect(p.was?.moved).toBe(true);
    expect(p.was?.nodes).toBeUndefined();
    expect(closureOf(p)).toBe('closed');
    // Без перестройки — как было.
    expect(splitBuild({ project: 3, done: 0 }, 100, 40)[0].was).toBeUndefined();
  });

  it('сохранение, где участок перестройки потерял прежнюю дорогу, чинится по соседнему участку', () => {
    const { game, c, at } = scene('build', 600, true);
    const gate = nodeAt(game, { x: at.x - 90, y: at.y })!;
    const far = nodeAt(game, { x: at.x + 690, y: at.y })!;
    // Перестройка улицы и её продолжения на восток — разными проектами (так их закладывает протяжка по участкам).
    expect(game.roadBuilder.apply(game.roadBuilder.rebuild(c.id, { cls: AVENUE.cls, lanes: AVENUE.lanes }))).toBe(true);
    const next = [...game.roads.net.corridors.values()].find((k) => k.id !== c.id && (k.a === c.a || k.b === c.a))!;
    expect(game.roadBuilder.apply(game.roadBuilder.rebuild(next.id, { cls: AVENUE.cls, lanes: AVENUE.lanes }))).toBe(true);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    // Как в 0.2.102: стройку участка записали заново без was — полотно стало «новой дорогой», маршрута нет.
    const lost = save.roads.corridors.find((k: Corridor) => k.id === c.id);
    lost.build = { project: lost.build.project, done: 0, fromB: true };
    const back = withoutCitizens(new Game(save.settings, save));
    const k = back.roads.net.corridors.get(c.id)!;
    expect(k.build?.was?.cls).toBe('street');
    expect(k.build?.was?.lanes.length).toBe(2);
    expect(closureOf(k.build)).toBe('old');
    expect(back.roads.route(gate, far)).toBeTruthy();
    expect(back.roads.route(far, gate)).toBeTruthy();
  });
});

describe('Перестройка «с проездом» узкой дороги: по половине полотна, реверс со светофорами', () => {
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });
  const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff' };

  it('одна бригада, два прохода навстречу друг другу, машины проходят в обе стороны по очереди; заплачено по цене', () => {
    const { game, c, at, base } = scene('build');
    // Вторая бригада на базе: на узкой «с проездом» её не возьмут.
    game.construction.crews.hire(base!.id);
    const gate = nodeAt(game, { x: at.x - 90, y: at.y })!;
    const far = nodeAt(game, { x: at.x + 690, y: at.y })!;
    let paid = 0;
    const spend = game.spend.bind(game);
    game.spend = (amount, kind) => {
      if (kind !== 'purchases') paid += amount;
      spend(amount, kind);
    };
    expect(game.roadBuilder.apply(game.roadBuilder.rebuild(c.id, { cls: AVENUE.cls, lanes: AVENUE.lanes }))).toBe(true);
    const id = live(game, c.id).build!.project;
    const price = live(game, c.id).build!.was!.price;
    expect(game.construction.crews.cap(id)).toBe(1);
    // Срок: «с проездом» — два прохода по pass от перестройки целиком; ⛔ целиком той же бригадой — быстрее во столько раз.
    const slow = game.construction.info(id)!.seconds;
    game.setProjectClosure(id, false);
    const fast = game.construction.info(id)!.seconds;
    expect(game.construction.crews.cap(id)).toBeGreaterThan(1);
    game.setProjectClosure(id, true);
    expect(slow / fast).toBeCloseTo(2 * K.pass, 1);
    // Машины в обе стороны, пока идёт первый проход.
    const sent: { id: number; west: boolean }[] = [];
    const spawn = () => {
      const g = game.roads.graph;
      for (const [from, to, west] of [
        [gate, far, false],
        [far, gate, true],
      ] as const) {
        const route = game.roads.route(from, to);
        const v = route && game.traffic.spawn({ ...CAR, targetNode: to, route });
        if (v) sent.push({ id: v.id, west });
        expect(g).toBe(game.roads.graph);
      }
    };
    const fromB0 = { value: undefined as boolean | undefined };
    const greens = new Set<number>();
    let t = 0;
    for (; t < 400 && !live(game, c.id).build?.pass; t += 0.5) {
      runSeconds(game, 0.5);
      const b = live(game, c.id).build!;
      if (b.done > 0 && fromB0.value === undefined) fromB0.value = !!b.fromB;
      if (b.done > 0 && Math.round(t * 2) % 6 === 0) spawn();
      const sig = game.workSignals.list.get(c.id);
      if (sig) greens.add(sig.state.go);
      // Бригада одна, хоть свободная и есть.
      expect(game.construction.crews.assigned(id).length).toBeLessThanOrEqual(1);
    }
    // Первый проход кончился: готова половина, второй — навстречу.
    const b2 = live(game, c.id).build!;
    expect(b2.pass).toBe(2);
    expect(!!b2.fromB).toBe(!fromB0.value);
    expect(b2.done).toBeCloseTo(c.length / 2, 0);
    expect(closureOf(b2)).toBe('part');
    // Светофоры пропускали обе стороны по очереди.
    expect(greens.has(1) && greens.has(-1) && greens.has(0)).toBe(true);
    // Машины доехали в обе стороны, никто не застрял.
    for (let i = 0; i < 300 && sent.some((s) => game.traffic.vehicles.has(s.id)); i++) runSeconds(game, 1);
    expect(sent.filter((s) => s.west).length).toBeGreaterThan(3);
    expect(sent.filter((s) => !s.west).length).toBeGreaterThan(3);
    expect(sent.filter((s) => game.traffic.vehicles.has(s.id))).toEqual([]);
    // Достроили — проспект, светофоров нет, заплачено ровно по цене.
    for (let i = 0; i < 600 && live(game, c.id).build; i++) runSeconds(game, 1);
    expect(live(game, c.id).build).toBeUndefined();
    runSeconds(game, 0.2);
    expect(game.workSignals.list.size).toBe(0);
    expect(game.traffic.signals.size).toBe(0);
    expect(opened(game, c.id)?.cls).toBe('avenue');
    expect(paid).toBeGreaterThan(price - 2);
    expect(paid).toBeLessThan(price + 2);
  });
});
