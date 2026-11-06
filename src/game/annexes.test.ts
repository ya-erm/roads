import { describe, expect, it } from 'vitest';
import { ANNEX, COST, ECONOMY } from '../config';
import { add, scale, type Vec } from '../core/vec';
import type { Industry } from '../world/entities';
import { footprintRadius } from '../world/spatial';
import { annexHtml } from '../ui/annexUi';
import { annexReady, annexZone, growthCap } from './annexes';
import { Game } from './game';
import { freightRoute, withoutCitizens } from './testkit';

/** Ферма с маршрутом (её продукцию вывозят) — как после месяцев исправной работы. */
function setup() {
  const game = withoutCitizens(new Game(7));
  game.money = 5_000_000;
  const { built, line, from } = freightRoute(game);
  expect(built).toBe(true);
  game.buyVehicle(line.id, 'truck');
  return { game, farm: from };
}

/** Упёрлась в предел и месяц продукцию вывозили — готова к расширению. */
function ready(farm: Industry) {
  farm.level = growthCap(farm);
  farm.streak = ECONOMY.growthMonths;
}

/** Первое место вокруг предприятия, где пристройка ставится. */
function freeSpot(game: Game, ind: Industry): Vec {
  for (const extra of [0.6, 0.75, 0.9]) {
    const d = footprintRadius(ind.fp) + (annexZone(ind) - footprintRadius(ind.fp)) * extra;
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      const p = add(ind.fp.center, scale({ x: Math.cos(a), y: Math.sin(a) }, d));
      if (game.annexPlan(ind.id, p).ok) return p;
    }
  }
  throw new Error('Нет места под пристройку');
}

/** Конец месяца: рост предприятий по тому, как вывозили продукцию. */
const grow = (game: Game) => (game as unknown as { growIndustries(): void }).growIndustries();

describe('Пристройки предприятий', () => {
  it('само предприятие растёт только до ×2: дальше — предел, пока нет пристройки', () => {
    const { game, farm } = setup();
    farm.level = 1.75;
    farm.streak = 1;
    farm.producedLast = 40;
    farm.piledMonth = 0;
    grow(game);
    expect(farm.level).toBe(ANNEX.base);
    for (let m = 0; m < 3; m++) {
      farm.producedLast = 40;
      farm.piledMonth = 0;
      grow(game);
    }
    expect(farm.level).toBe(ANNEX.base);
    // Упёрлась, а вывозят исправно — готова расти дальше.
    expect(annexReady(farm)).toBe(true);
  });

  it('не готово — пристройку не поставить, в карточке кнопки нет', () => {
    const { game, farm } = setup();
    farm.level = 1.5;
    farm.streak = 1;
    expect(annexReady(farm)).toBe(false);
    expect(game.annexPlan(farm.id, add(farm.fp.center, { x: footprintRadius(farm.fp) + 30, y: 0 })).reason).toMatch(/ещё не готово/);
    expect(annexHtml(farm, false)).not.toContain('data-action="ind-annex"');
    expect(annexHtml(farm, false)).toContain('Растёт само до ×2');
  });

  it('готово → пристройка рядом: уровень сразу выше, дальше растёт до ×3; кнопка в карточке', () => {
    const { game, farm } = setup();
    ready(farm);
    expect(annexHtml(farm, false)).toContain('data-action="ind-annex"');
    const money = game.money;
    const p = freeSpot(game, farm);
    expect(game.buildAnnex(farm.id, p)).toBeNull();
    expect(game.money).toBe(money - ANNEX.cost);
    expect(farm.annexes).toHaveLength(1);
    expect(farm.level).toBe(ANNEX.base + ECONOMY.growthStep);
    expect(growthCap(farm)).toBe(ANNEX.base + 1);
    expect(game.structureAt(p)).toMatchObject({ type: 'annex', industryId: farm.id });
    // Растёт само — до нового предела.
    for (let m = 0; m < 8; m++) {
      farm.producedLast = 40;
      farm.piledMonth = 0;
      grow(game);
    }
    expect(farm.level).toBe(ANNEX.base + 1);
    // Сразу вторую — нельзя: предприятие ещё не готово (только что выросло).
    farm.streak = 0;
    expect(game.annexPlan(farm.id, freeSpotAny(game, farm)).reason).toMatch(/ещё не готово/);
  });

  it('вне зоны, на самом предприятии — нельзя', () => {
    const { game, farm } = setup();
    ready(farm);
    expect(game.annexPlan(farm.id, add(farm.fp.center, { x: annexZone(farm) + 50, y: 0 })).reason).toBe('Пристройка — только рядом с предприятием');
    expect(game.annexPlan(farm.id, farm.fp.center).reason).toBe('Мешает предприятие');
  });

  it('снос пристройки — уровень назад, до прежнего предела; часть цены вернётся', () => {
    const { game, farm } = setup();
    ready(farm);
    const p = freeSpot(game, farm);
    game.buildAnnex(farm.id, p);
    farm.level = 2.75;
    const money = game.money;
    const a = farm.annexes![0];
    game.removeAnnex(a);
    expect(farm.annexes).toEqual([]);
    expect(farm.level).toBe(ANNEX.base);
    expect(game.money).toBe(money + Math.round(ANNEX.cost * COST.refundRatio));
    expect(game.structureAt(p)?.type).not.toBe('annex');
  });

  it('Ctrl+Z убирает пристройку и уровень, который она дала; деньги возвращаются', () => {
    const { game, farm } = setup();
    ready(farm);
    const money = game.money;
    const p = freeSpot(game, farm);
    game.buildAnnex(farm.id, p);
    expect(game.undo()).toBe('пристройка предприятия');
    expect(farm.annexes ?? []).toEqual([]);
    expect(farm.level).toBe(ANNEX.base);
    expect(game.money).toBe(money);
    expect(game.structureAt(p)?.type).not.toBe('annex');
  });

  it('сохраняется в партии; старое сохранение без пристроек — уровни те же', () => {
    const { game, farm } = setup();
    ready(farm);
    const p = freeSpot(game, farm);
    game.buildAnnex(farm.id, p);
    const loaded = withoutCitizens(new Game(game.settings, JSON.parse(JSON.stringify(game.toSave()))));
    const lf = loaded.industries.find((i) => i.id === farm.id)!;
    expect(lf.annexes).toHaveLength(1);
    expect(lf.level).toBe(farm.level);
    expect(growthCap(lf)).toBe(ANNEX.base + 1);
    expect(loaded.structureAt(p)).toMatchObject({ type: 'annex', industryId: farm.id });
    // Старое сохранение: поля нет, уровень ×3.5 остаётся как был (выше ×2 — уже не растёт без пристроек).
    const old = JSON.parse(JSON.stringify(game.toSave()));
    for (const i of old.industries) {
      delete i.annexes;
      if (i.id === farm.id) i.level = 3.5;
    }
    const was = withoutCitizens(new Game(game.settings, old));
    expect(was.industries.find((i) => i.id === farm.id)!.level).toBe(3.5);
  });
});

/** Место без построек вокруг предприятия — даже когда пристройку сейчас нельзя (проверяем только причину). */
function freeSpotAny(game: Game, ind: Industry): Vec {
  const keep = { level: ind.level, streak: ind.streak };
  ready(ind);
  const p = freeSpot(game, ind);
  Object.assign(ind, keep);
  return p;
}
