import { describe, expect, it } from 'vitest';
import { ECONOMY, MODEL_UNLOCK, MONTH_LENGTH } from '../config';
import { dist } from '../core/vec';
import type { IndustryKind } from '../world/cargo';
import type { Station } from '../world/entities';
import { breathe, freightRoute, freshGame, runMonths, runUntil, townStreets, withoutCitizens } from './testkit';
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
  const game = withoutCitizens(freshGame(seed));
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
  it('добыча и переработка идут с общим замедлением, нормы в карточке совпадают с выпуском', () => {
    const game = withoutCitizens(freshGame(7));
    const { built, from: farm, to: plant } = freightRoute(game);
    expect(built).toBe(true);
    plant.stock.grain = 200;

    const production = game as unknown as { updateIndustries(dt: number): void };
    production.updateIndustries(MONTH_LENGTH);

    expect(farm.producedMonth + farm.prodAcc).toBeCloseTo(40.5);
    expect(game.industryRate(farm)).toBe(Math.round(farm.producedMonth + farm.prodAcc));
    expect(plant.producedMonth).toBe(135);
    expect(game.industryRate(plant)).toBe(plant.producedMonth);
    expect(plant.stock.grain).toBe(65);
  });

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
    // Пост уже закреплён за грузовиком, но он только трогается от линии ожидания, с зерном и без оплаты.
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
    let inYard = 0;
    while (v.enter && entering < 10) {
      if (game.inFootprint(game.fleetLook(v)!.pos, plant.fp)) inYard += 0.1;
      expect(line.revenueTotal).toBe(r0);
      game.update(0.1);
      entering += 0.1;
    }
    expect(entering).toBeGreaterThan(inYard);
    expect(entering).toBeLessThan(9);
    expect(inYard).toBeGreaterThan(1);
    expect(inYard).toBeLessThan(5);
    // На посту: зерно сдано и оплачено, дальше обычная погрузка и отправление.
    expect(line.revenueTotal).toBeGreaterThan(r0);
    expect(v.cargo).not.toBe('grain');
    expect(plant.occupied).toContain(v.id);
    for (let t = 0; t < 60 && v.state !== 'driving'; t += 0.1) game.update(0.1);
    expect(v.state).toBe('driving');
    expect(plant.occupied).not.toContain(v.id);
    expect(v.bay).toBeUndefined();
  });

  // async и паузы между месяцами (breathe): пять месяцев города с машинами жителей — под нагрузкой дольше минуты.
  it('автобусы в городе окупаются', async () => {
    // Машины жителей здесь нужны: автобусы делят с ними улицы.
    const game = freshGame(7);
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
    await breathe();
    const r0 = line.revenueTotal;
    let cost = 0;
    // Четыре месяца, а не два: рейс между остановками — около 50 с, месяц — минута, и за два месяца в счёт попадает то
    // один приход автобуса, то два — по случаю (кто из жителей когда поехал: общий генератор). За два месяца доход
    // к расходу — 0,98–1,04 (и 1,7 — когда попал лишний приход), за четыре — 1,7–2,2.
    for (let m = 0; m < 4; m++) {
      runMonths(game, 1);
      cost += line.costLast;
      await breathe();
    }
    expect(line.revenueTotal - r0).toBeGreaterThan(cost);
  });

  it('модели новее открываются перевезённым, старые меняются на новые', () => {
    const r = freightLine(7, 'farm', 'foodplant', 1, 0);
    const game = r.game;
    const line = [...game.lines.values()][0];
    const v = game.fleet.get(line.vehicles[0])!;
    expect(modelsFor('road', game.modelOpen)).toEqual(['truck', 'bus']);
    expect(game.buyVehicle(line.id, 'truck3')).toBeNull();
    expect(game.replacementFor(v)).toBeNull();
    // Грузовики перевезли порог «Грузовика II» (unlocks.ts) — его предлагают взамен.
    game.unlocks.add('truck', MODEL_UNLOCK.truck2);
    expect(modelsFor('road', game.modelOpen)).toContain('truck2');
    expect(game.replacementFor(v)).toBe('truck2');
    // И порог «Фуры» — её предлагают взамен, содержание старого не растёт.
    game.unlocks.add('truck', MODEL_UNLOCK.truck3);
    expect(modelsFor('road', game.modelOpen)).toContain('truck3');
    expect(game.runningCost(v)).toBe(MODELS.truck.running);
    expect(game.replacementFor(v)).toBe('truck3');
    expect(runUntil(game, 2 * MONTH_LENGTH, () => v.inBay && !v.enter && !v.yardExit)).toBe(true);
    const fresh = game.replaceVehicle(v.id)!;
    expect(fresh.model).toBe('truck3');
    expect(line.vehicles).toEqual([fresh.id]);
    expect(game.replacementFor(fresh)).toBeNull();
  });

  it('кредит: проценты раз в месяц, гасится частями', () => {
    // Проценты от жителей не зависят: месяц — без их машин.
    const game = withoutCitizens(freshGame(7));
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
    const game = freshGame(7);
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
