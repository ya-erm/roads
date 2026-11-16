import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import type { Vec } from '../core/vec';
import type { Corridor } from '../lanes/model';
import type { WorldSettings } from '../world/settings';
import { buildRate, pieceRate, workFactor } from './constructionWork';
import { Game } from './game';
import { anchorOf, fieldSpot, road, STREET, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' };

/** Первая база — у улиц самого большого города, где площадка встаёт без сноса домов. */
function withBase(game: Game): Game {
  const town = [...game.towns].sort((a, b) => b.population - a.population || a.id - b.id)[0];
  for (const k of [1, 0.75, 1.3, 0.5, 1.7]) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const p = { x: town.center.x + Math.cos(a) * town.radius * k, y: town.center.y + Math.sin(a) * town.radius * k };
      const plan = game.basePlan(p);
      if (plan.ok && !plan.demolish.length && game.buildBase(p) === null) return game;
    }
  }
  throw new Error('нет места для базы');
}

/** Новые полотна, что появились после fn. */
function fresh(game: Game, fn: () => void): Corridor[] {
  const had = new Set(game.roads.net.corridors.keys());
  fn();
  return [...game.roads.net.corridors.values()].filter((c) => !had.has(c.id));
}

describe('Стройка в чистом поле', () => {
  // Темп без поправки на расстояние до базы: сравниваем только место.
  const { reach, field } = CONSTRUCTION;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
    CONSTRUCTION.field = field;
  });

  it('метр в поле — в CONSTRUCTION.field раз дольше, у застройки и без сведений о ней — как прежде; перестройка — без поля', () => {
    expect(CONSTRUCTION.field).toBeGreaterThan(0.4);
    expect(CONSTRUCTION.field).toBeLessThan(1);
    const game = withoutCitizens(new Game(WORLD));
    const at = fieldSpot(game, 600);
    const cs = fresh(game, () => expect(road(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true));
    expect(cs.length).toBeGreaterThan(0);
    const net = game.roads.net;
    const water = (p: Vec, m?: number) => game.isWater(p, m);
    for (const c of cs) {
      const town = workFactor(net, c, water, () => true);
      expect(workFactor(net, c, water)).toBe(town);
      expect(workFactor(net, c, water, () => false)).toBeCloseTo(town * CONSTRUCTION.field, 9);
      // Поле — по каждой точке оси: застройка у половины полотна — половина ускорения.
      const half = workFactor(net, c, water, (p) => p.x < at.x + 300);
      expect(half).toBeGreaterThan(town * CONSTRUCTION.field);
      expect(half).toBeLessThan(town);
      expect(buildRate(net, c, water, () => false)).toBeCloseTo(buildRate(net, c, water) / CONSTRUCTION.field, 6);
      // Перестройка готовой дороги (CorridorBuild.was) — на дороге, по которой ездят: темп прежний и в поле.
      const rework = { ...c, build: { project: 1, done: 0, was: { work: 1 } } } as unknown as Corridor;
      expect(pieceRate(net, rework, water, () => false)).toBeCloseTo(pieceRate(net, rework, water, () => true), 9);
      expect(pieceRate(net, c, water, () => false)).toBeCloseTo(buildRate(net, c, water, () => false), 9);
    }
  });

  it('застройка — у домов города; поле — вдали от зданий, предприятий и станций', () => {
    const game = withoutCitizens(new Game(WORLD));
    const house = game.towns.flatMap((t) => t.buildings)[0];
    expect(house).toBeDefined();
    expect(game.builtNear(house.fp.center)).toBe(true);
    expect(game.builtNear({ x: house.fp.center.x + CONSTRUCTION.fieldClear * 0.5, y: house.fp.center.y })).toBe(true);
    const ind = game.industries[0];
    expect(game.builtNear(ind.fp.center)).toBe(true);
    const at = fieldSpot(game, 400);
    expect(game.builtNear(at)).toBe(false);
    expect(game.builtNear({ x: at.x + 400, y: at.y })).toBe(false);
  });

  it('проект в поле строится быстрее, и срок в карточке это видит', () => {
    const seconds = (k: number) => {
      CONSTRUCTION.field = k;
      const game = withBase(withoutCitizens(new Game({ ...WORLD, construction: 'build' })));
      const at = fieldSpot(game, 900);
      const plan = game.roadBuilder.road(anchorOf(game, { free: at }), anchorOf(game, { free: { x: at.x + 900, y: at.y } }), STREET, { project: true });
      expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
      const info = game.construction.list()[0];
      expect(info).toBeDefined();
      return info.seconds;
    };
    const town = seconds(1);
    const open = seconds(field);
    expect(open / town).toBeCloseTo(field, 2);
  });
});
