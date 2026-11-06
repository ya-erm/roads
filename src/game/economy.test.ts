import { describe, expect, it } from 'vitest';
import { ECONOMY, MONTH_LENGTH } from '../config';
import { dist } from '../core/vec';
import type { IndustryKind } from '../world/cargo';
import type { Station } from '../world/entities';
import { Game } from './game';
import { freightRoute, runMonths, townStreets, withoutCitizens } from './testkit';
import { MODELS, modelsFor } from './transport';

/**
 * Экономика: типичные линии должны окупаться, если их разумно построить.
 * Что движение в городах не встаёт со временем — в townTraffic.test.ts.
 */

/**
 * Грузовая линия между ближайшей парой предприятий; итоги за months месяцев после разгона. Трасса — своя сеть
 * в стороне от городов, машины жителей на неё не попадают: без них месяц симуляции — доли секунды.
 */
function freightLine(seed: number, from: IndustryKind, to: IndustryKind, trucks: number, months: number) {
  const game = withoutCitizens(new Game(seed));
  const { built, line, from: f } = freightRoute(game, from, to);
  expect(built).toBe(true);
  for (let i = 0; i < trucks; i++) game.buyVehicle(line.id, 'truck');
  runMonths(game, 1);
  const r0 = line.revenueTotal;
  let cost = 0;
  for (let m = 0; m < months; m++) {
    runMonths(game, 1);
    cost += line.costLast;
  }
  return { game, farm: f, revenue: line.revenueTotal - r0, cost };
}

// Симуляции на месяцы вперёд — дольше стандартного лимита теста.
describe('Экономика', { timeout: 60_000 }, () => {
  it('грузовики на линии ферма → комбинат окупаются, а ферма растёт', () => {
    const r = freightLine(7, 'farm', 'foodplant', 2, 2);
    // Выручка заметно больше содержания.
    expect(r.revenue).toBeGreaterThan(r.cost * 2);
    // Продукцию исправно вывозят — производство растёт.
    expect(r.farm.level ?? 1).toBeGreaterThan(1);
  });

  it('грузовик не исчезает у станции: заезжает на свой пост, и только там выгружается и получает оплату', () => {
    const { game } = freightLine(7, 'farm', 'foodplant', 1, 0);
    const line = [...game.lines.values()][0];
    const v = game.fleet.get(line.vehicles[0])!;
    const plant = game.stations.get(line.stops[1])!;
    game.speed = 1;
    // Ждём, когда грузовик с зерном сойдёт с дороги у комбината.
    let arrived = false;
    for (let t = 0; t < MONTH_LENGTH * 3 && !arrived; t += 0.1) {
      const driving = v.simId !== null && v.stop === 1 && v.amount > 0;
      game.update(0.1);
      arrived = driving && v.simId === null;
    }
    expect(arrived).toBe(true);
    // Пост уже за ним и окрашен в цвет линии, но грузовик ещё у края площадки, с зерном, денег пока нет.
    expect(v.state).toBe('loading');
    expect(v.enter).toBeDefined();
    expect(plant.occupied).toContain(v.id);
    expect(game.stationBays(plant)[v.bay!]).toBe(line.color);
    expect(v.cargo).toBe('grain');
    const look = game.fleetLook(v)!;
    expect(look).toBeDefined();
    expect(game.inFootprint(look.pos, plant.fp)).toBe(false);
    const r0 = line.revenueTotal;
    let entering = 0;
    let inside = false;
    while (v.enter && entering < 10) {
      inside = game.inFootprint(game.fleetLook(v)!.pos, plant.fp);
      expect(line.revenueTotal).toBe(r0);
      game.update(0.1);
      entering += 0.1;
    }
    // Заезд — не мгновенно, но и не долго; доехал до поста под навесом.
    expect(entering).toBeGreaterThan(1);
    expect(entering).toBeLessThan(5);
    expect(inside).toBe(true);
    // На посту: зерно сдано и оплачено, дальше обычная погрузка и отправление.
    expect(line.revenueTotal).toBeGreaterThan(r0);
    expect(v.cargo).not.toBe('grain');
    expect(plant.occupied).toContain(v.id);
    for (let t = 0; t < 60 && v.state !== 'driving'; t += 0.1) game.update(0.1);
    expect(v.state).toBe('driving');
    expect(plant.occupied).not.toContain(v.id);
    expect(v.bay).toBeUndefined();
  });

  it('автобусы в городе окупаются', () => {
    // Машины жителей здесь нужны: автобусы делят с ними улицы.
    const game = new Game(7);
    game.money = 5_000_000;
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const placed: Station[] = [];
    for (const seg of townStreets(game, town.id)) {
      if (placed.length >= 2) continue;
      const p = seg.lut.pointAt(seg.length / 2);
      const t = seg.lut.tangentAt(seg.length / 2);
      const q = { x: p.x - t.y * 40, y: p.y + t.x * 40 };
      if (placed.some((s) => dist(s.fp.center, q) < 500)) continue;
      const st = game.placeStation(q, 14);
      if (st) placed.push(st);
    }
    expect(placed).toHaveLength(2);
    const line = game.createLine(placed.map((s) => s.id))!;
    game.buyVehicle(line.id, 'bus');
    game.buyVehicle(line.id, 'bus');
    runMonths(game, 1);
    const r0 = line.revenueTotal;
    let cost = 0;
    for (let m = 0; m < 2; m++) {
      runMonths(game, 1);
      cost += line.costLast;
    }
    expect(line.revenueTotal - r0).toBeGreaterThan(cost);
  });

  it('модели по эпохам: новые появляются со временем, старые меняются на новые', () => {
    const r = freightLine(7, 'farm', 'foodplant', 1, 0);
    const game = r.game;
    const line = [...game.lines.values()][0];
    const v = game.fleet.get(line.vehicles[0])!;
    expect(game.year).toBe(2000);
    expect(modelsFor('road', game.modelOpen)).toEqual(['truck', 'bus']);
    expect(game.buyVehicle(line.id, 'truck3')).toBeNull();
    expect(game.replacementFor(v)).toBeNull();
    // Эпохи сжаты втрое (месяц втрое длиннее): «Грузовик II» — через 4 года после начала, «Фура» — через 9.
    expect(game.modelYear('truck2')).toBe(2004);
    expect(game.modelYear('truck3')).toBe(2009);
    (game as unknown as { month: number }).month = 4 * 12;
    expect(modelsFor('road', game.modelOpen)).toContain('truck2');
    expect(game.replacementFor(v)).toBe('truck2');
    // Прошло 9 лет: есть «Фура» — её предлагают взамен, содержание старого не растёт.
    (game as unknown as { month: number }).month = 9 * 12;
    expect(game.year).toBe(2009);
    expect(modelsFor('road', game.modelOpen)).toContain('truck3');
    expect(game.runningCost(v)).toBe(MODELS.truck.running);
    expect(game.replacementFor(v)).toBe('truck3');
    const fresh = game.replaceVehicle(v.id)!;
    expect(fresh.model).toBe('truck3');
    expect(line.vehicles).toEqual([fresh.id]);
    expect(game.replacementFor(fresh)).toBeNull();
  });

  it('кредит: проценты раз в месяц, гасится частями', () => {
    // Проценты от жителей не зависят: месяц — без их машин.
    const game = withoutCitizens(new Game(7));
    const money = game.money;
    expect(game.takeLoan()).toBe(true);
    expect(game.loan).toBe(100_000);
    expect(game.money).toBe(money + 100_000);
    runMonths(game, 1);
    const rec = game.history[game.history.length - 1];
    expect(rec.ledger!.interest).toBe(Math.round(100_000 * ECONOMY.loanRate));
    expect(game.repayLoan()).toBe(true);
    expect(game.loan).toBe(0);
    expect(game.repayLoan()).toBe(false);
  });

  it('быстрая доставка оплачивается дороже, медленная — дешевле', () => {
    const game = new Game(7);
    expect(game.speedFactor(1500, 100)).toBe(1);
    expect(game.speedFactor(4500, 100)).toBe(1.5);
    expect(game.speedFactor(300, 100)).toBe(0.8);
  });

  it('отчёт о финансах: статьи сходятся с итогом месяца', () => {
    const r = freightLine(7, 'farm', 'foodplant', 2, 1);
    const rec = r.game.history[r.game.history.length - 1];
    expect(rec.ledger).toBeDefined();
    const l = rec.ledger!;
    expect(l.transport + l.sales).toBe(rec.income);
    expect(l.vehicles + l.roads + l.build + l.purchases + l.interest).toBe(rec.expenses);
    expect(l.vehicles).toBeGreaterThan(0);
  });
});
