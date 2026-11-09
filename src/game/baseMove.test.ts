/**
 * Строительная база двигается (режим «Со строительством»): расширенная улица отодвигает её от новой кромки, как навес
 * остановки; игрок переносит её сам — без платы за базу, свободные бригады едут следом по дорогам. Отмена (Ctrl+Z),
 * сохранение, повтор.
 */
import { describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import type { Vec } from '../core/vec';
import { RoadTools } from '../input/roadtools';
import type { BuildBase } from '../world/entities';
import type { WorldSettings } from '../world/settings';
import { halfAtS } from '../world/worldgen';
import { Game } from './game';
import { anchorOf, openSpot, road, roadPlan, runSeconds, STREET, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };
const AVENUE = { cls: 'avenue' as const, lanesF: 2, lanesB: 2 };

/** Улица с запада на восток в чистом поле и база у её середины с севера (−y). */
function setup(): { game: Game; at: Vec; base: BuildBase } {
  const game = withoutCitizens(new Game({ ...WORLD }));
  // Чистое поле вдоль улицы и на 500 м к югу от её конца: там вторая улица (withSecondStreet).
  const at = openSpot(game, [
    [{ x: 0, y: 0 }, { x: 600, y: 0 }, 150],
    [{ x: 600, y: 0 }, { x: 600, y: 520 }, 120],
  ]);
  expect(road(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
  expect(game.buildBase({ x: at.x + 300, y: at.y - 30 })).toBeNull();
  const base = [...game.construction.crews.bases.values()][0];
  expect(base.fp.center.y).toBeLessThan(at.y);
  return { game, at, base };
}

/** Самая малая щель между площадкой базы и кромкой любой дороги (по точкам внутри площадки). */
function clearance(game: Game, base: BuildBase): number {
  const fp = base.fp;
  const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const v = { x: -u.y, y: u.x };
  let min = Infinity;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 4; j++) {
      const q = { x: fp.center.x + u.x * (i / 8 - 0.5) * fp.w + v.x * (j / 4 - 0.5) * fp.h, y: fp.center.y + u.y * (i / 8 - 0.5) * fp.w + v.y * (j / 4 - 0.5) * fp.h };
      for (const c of game.roads.net.corridorsNear(q, 60)) {
        const hit = c.lut.closest(q);
        min = Math.min(min, hit.d - halfAtS(c, hit.s));
      }
    }
  }
  return min;
}

describe('Строительная база: расширение улицы', () => {
  it('улицу перестроили в проспект — база отодвинулась от новой кромки, ворота те же', () => {
    const { game, at, base } = setup();
    const gate = base.nodeId;
    const was = { ...base.fp.center };
    const tools = new RoadTools(() => game);
    const plan = tools.upgradePlan({ x: at.x + 300, y: at.y }, AVENUE, 4)!.plan;
    expect(plan.reason).toBeUndefined();
    // В предпросмотре — новое место базы.
    expect(plan.moved?.some((fp) => fp.w === base.fp.w && fp.center.y < was.y - 1)).toBe(true);
    expect(tools.upgrade({ x: at.x + 300, y: at.y }, AVENUE, 4)).toBeNull();
    expect(base.fp.center.y).toBeLessThan(was.y - 1);
    // Вдоль той же улицы: по x не сдвинулась.
    expect(base.fp.center.x).toBeCloseTo(was.x, 3);
    expect(base.nodeId).toBe(gate);
    // До кромки проспекта — зазор, как при постановке.
    expect(clearance(game, base)).toBeGreaterThan(CONSTRUCTION.base.gap - 0.2);
    expect(game.structureAt(base.fp.center)?.type).toBe('base');
    expect(game.journal.entries.some((e) => e.k === 'base>' && e.shove)).toBe(true);
  });

  it('дом позади базы на её новом месте — под снос, за доплату', () => {
    const { game, at, base } = setup();
    // Дом города ставим вплотную за площадку (как будто вырос там).
    const house = game.towns.flatMap((t) => t.buildings).find((b) => b.kind !== 'landmark')!;
    game.index.remove(house);
    house.fp = { center: { x: base.fp.center.x, y: base.fp.center.y - base.fp.h / 2 - 6 }, w: 10, h: 8, angle: 0 };
    game.index.add(house);
    const tools = new RoadTools(() => game);
    const plan = tools.upgradePlan({ x: at.x + 300, y: at.y }, AVENUE, 4)!.plan;
    expect(plan.reason).toBeUndefined();
    expect(plan.demolish).toContain(house.id);
    const razeCost = game.demolishCost(house.id);
    expect(razeCost).toBeGreaterThan(0);
    expect(plan.cost).toBeGreaterThanOrEqual(razeCost);
    const money = game.money;
    expect(tools.upgrade({ x: at.x + 300, y: at.y }, AVENUE, 4)).toBeNull();
    expect(game.buildingById(house.id)).toBeUndefined();
    expect(money - game.money).toBe(plan.cost);
  });

  it('отодвинуть некуда (позади дорога) — «Мешает база», база на месте', () => {
    const { game, at, base } = setup();
    const was = { ...base.fp };
    // Дорога позади площадки, параллельно улице, — вплотную, но не впритык.
    const street = game.roads.net.corridorsNear(at, 700)[0];
    const half = halfAtS(street, street.length / 2);
    const back = base.fp.center.y - base.fp.h / 2 - half - 3;
    expect(road(game, { free: { x: at.x + 100, y: back } }, { free: { x: at.x + 500, y: back } })).toBe(true);
    const tools = new RoadTools(() => game);
    expect(tools.upgrade({ x: at.x + 300, y: at.y }, AVENUE, 4)).toBe('Мешает база');
    expect(base.fp).toEqual(was);
  });

  it('новая дорога поперёк базы — «Мешает база», а не «Мешает здание»', () => {
    const { game, at, base } = setup();
    const x = base.fp.center.x;
    const plan = roadPlan(game, { free: { x, y: at.y - 120 } }, { free: { x, y: at.y - 10 } });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('Мешает база');
  });
});

/** Улица и вторая, на юг от её восточного конца: туда переносим базу (у неё ворота — на второй улице). */
function withSecondStreet(): { game: Game; at: Vec; base: BuildBase; to: Vec } {
  const s = setup();
  const end = { x: s.at.x + 600, y: s.at.y };
  const node = [...s.game.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - end.x, n.pos.y - end.y) < 1)!;
  expect(road(s.game, node.id, { free: { x: end.x, y: end.y + 500 } })).toBe(true);
  expect(s.game.reach(s.base.nodeId, node.id)).toBe(true);
  return { ...s, to: { x: end.x + 30, y: end.y + 380 } };
}

describe('Строительная база: перенос', () => {
  it('без платы за базу; свободная бригада едет к новым воротам по дороге и встаёт на базе', () => {
    const { game, base, to } = withSecondStreet();
    const crew = game.construction.crews.of(base.id)[0];
    expect(crew.state).toBe('idle');
    const gate = base.nodeId;
    const from = { ...base.fp.center };
    const plan = game.baseMovePlan(base.id, to);
    expect(plan.ok).toBe(true);
    expect(plan.cost).toBe(0);
    const money = game.money;
    expect(game.moveBase(base.id, to)).toBeNull();
    expect(game.money).toBe(money);
    expect(base.fp.center).toEqual(plan.fp!.center);
    expect(base.nodeId).not.toBe(gate);
    expect(game.structureAt(from)?.type).not.toBe('base');
    expect(game.structureAt(base.fp.center)?.type).toBe('base');
    // Не перескоком: бригада выезжает от старых ворот.
    expect(crew.state).toBe('back');
    expect(crew.at).toBe(gate);
    let drove = false;
    runSeconds(game, 240, () => {
      if (game.construction.crews.lead(crew) !== undefined) drove = true;
    });
    expect(drove).toBe(true);
    expect(crew.state).toBe('idle');
    expect(crew.pos).toBeUndefined();
    const entry = game.journal.entries.find((e) => e.k === 'base>');
    expect(entry?.id).toBe(base.id);
    expect(entry?.shove).toBeUndefined();
  });

  it('сама себе не мешает, а другая база — мешает; за снос домов — плата', () => {
    const { game, base, to } = withSecondStreet();
    // Чуть в сторону, у той же улицы: площадка на старой — не помеха.
    const near = game.baseMovePlan(base.id, { x: base.fp.center.x + 10, y: base.fp.center.y });
    expect(near.ok).toBe(true);
    expect(near.cost).toBe(0);
    // Другая база на месте — мешает.
    const spot = { x: to.x, y: to.y - 200 };
    expect(game.buildBase(spot)).toBeNull();
    expect(game.baseMovePlan(base.id, spot).reason).toBe('Мешает база');
    // Дома под новым местом — под снос за плату (у города, где они есть).
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    let paid: ReturnType<Game['baseMovePlan']> | null = null;
    for (let i = 0; i < 48 && !paid; i++) {
      const a = (i / 48) * Math.PI * 2;
      const plan = game.baseMovePlan(base.id, { x: town.center.x + Math.cos(a) * town.radius * 0.5, y: town.center.y + Math.sin(a) * town.radius * 0.5 });
      if (plan.ok && plan.demolish.length) paid = plan;
    }
    expect(paid).not.toBeNull();
    expect(paid!.cost).toBeGreaterThan(0);
    expect(paid!.cost).toBeLessThan(CONSTRUCTION.base.cost);
  });

  it('Ctrl+Z возвращает базу и её ворота; свободная бригада едет назад по дорогам', () => {
    const { game, base, to } = withSecondStreet();
    const was = structuredClone(base.fp);
    const gate = base.nodeId;
    game.checkpoint('перенос базы');
    expect(game.moveBase(base.id, to)).toBeNull();
    game.commit();
    expect(game.canUndo).toBe(true);
    runSeconds(game, 2);
    expect(game.undo()).toBe('перенос базы');
    expect(base.fp).toEqual(was);
    expect(base.nodeId).toBe(gate);
    expect(game.structureAt(was.center)?.type).toBe('base');
    runSeconds(game, 240);
    const crew = game.construction.crews.of(base.id)[0];
    expect(crew.state).toBe('idle');
  });

  it('работающая бригада доделывает своё, а домой едет уже к новой базе', () => {
    const { game, at, base, to } = withSecondStreet();
    // Проект — от южного конца второй улицы на восток.
    const south = { x: at.x + 600, y: at.y + 500 };
    const start = [...game.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - south.x, n.pos.y - south.y) < 1)!.id;
    const plan = game.roadBuilder.road(anchorOf(game, start), anchorOf(game, { free: { x: south.x + 250, y: south.y } }), STREET, { project: true });
    expect(plan.reason).toBeUndefined();
    expect(game.roadBuilder.apply(plan)).toBe(true);
    const id = game.construction.list()[0].project.id;
    const crew = game.construction.crews.of(base.id)[0];
    for (let t = 0; t < 120 && crew.state !== 'working'; t += 0.1) runSeconds(game, 0.1);
    expect(crew.state).toBe('working');
    expect(game.moveBase(base.id, to)).toBeNull();
    expect(crew.state).toBe('working');
    expect(crew.project).toBe(id);
    const done = game.construction.info(id)!.done;
    runSeconds(game, 3);
    expect(game.construction.info(id)!.done).toBeGreaterThan(done);
    // Достроили — домой, к новым воротам.
    for (let t = 0; t < 900 && (game.construction.info(id) || crew.state !== 'idle'); t += 1) runSeconds(game, 1);
    expect(game.construction.info(id)).toBeFalsy();
    expect(crew.state).toBe('idle');
    expect(crew.base).toBe(base.id);
  });

  it('итог одинаков при повторе и после сохранения', () => {
    const run = () => {
      const { game, base, to } = withSecondStreet();
      expect(game.moveBase(base.id, to)).toBeNull();
      const save = JSON.parse(JSON.stringify(game.toSave()));
      const loaded = withoutCitizens(new Game(save.settings, save));
      const lb = loaded.construction.crews.bases.get(base.id)!;
      expect(lb.fp).toEqual(base.fp);
      expect(lb.nodeId).toBe(base.nodeId);
      expect(loaded.construction.crews.of(base.id)[0].state).toBe('back');
      for (const g of [game, loaded]) runSeconds(g, 240);
      expect(loaded.construction.crews.of(base.id)[0].state).toBe('idle');
      return JSON.stringify(game.construction.crews.toSave());
    };
    expect(run()).toBe(run());
  });
});
