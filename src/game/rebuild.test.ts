import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import type { Vec } from '../core/vec';
import { closureOf, keptLanes } from '../lanes/closure';
import { type Corridor, oneWay, twoWay } from '../lanes/model';
import type { BuildBase } from '../world/entities';
import type { WorldSettings } from '../world/settings';
import { projectCardHtml } from '../ui/projectCard';
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
function scene(mode: 'build' | 'instant', len = 600): { game: Game; c: Corridor; at: Vec; base: BuildBase | null } {
  const game = withoutCitizens(new Game({ ...WORLD, ...(mode === 'build' ? { construction: 'build' as const } : {}) }));
  const at = freeSpot(game, len);
  const gate = { x: at.x - 90, y: at.y };
  expect(road(game, { free: gate }, { free: at })).toBe(true);
  expect(road(game, nodeAt(game, at)!, { free: { x: at.x + len, y: at.y } })).toBe(true);
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

  it('работы идут по полосам: открыта одна полоса на 30 км/ч; целиком — дороги нет; достроили — проспект, заплачено по цене', () => {
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
    // По полосам: прежняя улица 1+1 — одна полоса (по ходу оси), скорость зоны работ.
    expect(closureOf(live(game, c.id).build)).toBe('part');
    const o = opened(game, c.id)!;
    expect(o.lanes.length).toBe(1);
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
});
