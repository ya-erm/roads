import { describe, expect, it } from 'vitest';
import { ECONOMY, MONTH_LENGTH, SIM_DT } from '../config';
import { Game, type SaveData } from './game';
import { freightRoute, freshGame, runSeconds, withoutCitizens } from './testkit';
import { MODELS } from './transport';

/**
 * Непрерывное содержание (Game.accrueUpkeep): транспорт, бригады, ремонт и проценты начисляются каждый такт по доле
 * месяца и списываются раз в секунду игры целыми долларами; в конце месяца — только остаток.
 */
const running = MODELS.truck.running;

/** Партия с грузовой линией без машин жителей (месяц симуляции — доли секунды). */
function setup() {
  const game = withoutCitizens(freshGame(7));
  const r = freightRoute(game);
  expect(r.built).toBe(true);
  expect(game.time).toBeLessThan(1);
  return { game, line: r.line };
}

/** Вперёд кадрами по frame секунд (по умолчанию 0.1), пока не подведены итоги месяца month. */
function untilMonth(game: Game, month: number, frame = 0.1): void {
  game.speed = 1;
  for (let n = 0; (game.monthIndex < month || game.monthClosing) && n < 100_000; n++) game.update(frame);
  expect(game.monthIndex).toBe(month);
}

/** Партия вперёд, пока время не дойдёт до at (секунд игры). */
function until(game: Game, at: number): void {
  game.speed = 1;
  while (game.time < at) game.update(SIM_DT);
}

describe('Содержание списывается непрерывно', { timeout: 60_000 }, () => {
  it('машина, купленная посреди месяца, за этот месяц стоит половину; следующий — целиком', () => {
    const { game, line } = setup();
    until(game, MONTH_LENGTH / 2);
    const t = game.time;
    const v = game.buyVehicle(line.id, 'truck')!;
    expect(v).not.toBeNull();
    untilMonth(game, 1);
    // За остаток месяца: (60 − 30) / 60 от месячного — с точностью до доллара половина.
    expect(line.costLast).toBe(Math.round((running * (MONTH_LENGTH - t)) / MONTH_LENGTH));
    expect(Math.abs(line.costLast - running / 2)).toBeLessThanOrEqual(1);
    expect(game.history[0].ledger!.vehicles).toBe(line.costLast);
    untilMonth(game, 2);
    expect(line.costLast).toBe(running);
    expect(game.history[1].ledger!.vehicles).toBe(running);
  });

  it('купленная в последнюю секунду месяца почти ничего не стоит в этом месяце', () => {
    const { game, line } = setup();
    until(game, MONTH_LENGTH - 1);
    game.buyVehicle(line.id, 'truck');
    untilMonth(game, 1);
    expect(line.costLast).toBeLessThanOrEqual(Math.ceil(running / MONTH_LENGTH));
    expect(line.costLast).toBeGreaterThan(0);
  });

  it('продажа останавливает начисление: проданная посреди месяца — за половину', () => {
    const { game, line } = setup();
    const a = game.buyVehicle(line.id, 'truck')!;
    game.buyVehicle(line.id, 'truck');
    until(game, MONTH_LENGTH / 2);
    const t = game.time;
    const before = line.costMonth;
    game.sellVehicle(a.id);
    // Начисленное до продажи списано сразу (за обе машины — поровну, за полмесяца).
    expect(line.costMonth - before).toBeGreaterThanOrEqual(0);
    expect(Math.abs(line.costMonth - running * (t / MONTH_LENGTH) * 2)).toBeLessThanOrEqual(2);
    untilMonth(game, 1);
    expect(Math.abs(line.costLast - (running + Math.round((running * t) / MONTH_LENGTH)))).toBeLessThanOrEqual(1);
    expect(line.vehicles).toHaveLength(1);
  });

  it('без крупного платежа в конце месяца: раз в секунду целыми долларами, итоги месяца — только остаток', () => {
    const { game, line } = setup();
    for (let i = 0; i < 4; i++) game.buyVehicle(line.id, 'truck');
    expect(game.takeLoan()).toBe(true);
    const f = game.upkeepForecast();
    expect(f.vehicles).toBe(4 * running);
    expect(f.roads).toBeGreaterThan(0);
    expect(f.interest).toBeGreaterThan(0);
    // Траты за месяц — только содержание (стройки и покупок нет): расходы месяца растут по секундам.
    const steps: number[] = [];
    let last = game.expensesMonth;
    game.speed = 1;
    while (game.monthIndex === 0) {
      const spent = game.expensesMonth;
      game.update(SIM_DT);
      if (game.monthIndex === 0 && game.expensesMonth !== spent) steps.push(game.expensesMonth - spent);
      if (game.monthIndex === 0) last = game.expensesMonth;
    }
    const rec = game.history[0];
    const l = rec.ledger!;
    // За полный месяц — ровно месячные суммы по статьям.
    expect(l.vehicles).toBe(f.vehicles + f.crews);
    expect(l.roads).toBe(f.roads);
    expect(l.interest).toBe(f.interest);
    // Платежей — около 60 (раз в секунду), каждый — около секунды содержания (+ дробь меньше доллара у каждой из
    // 7 статей: 4 машины, бригады, ремонт, проценты).
    expect(steps.length).toBeGreaterThanOrEqual(58);
    expect(steps.length).toBeLessThanOrEqual(61);
    for (const s of steps) expect(s).toBeLessThanOrEqual(Math.ceil(f.total / MONTH_LENGTH) + 7);
    // В итогах месяца — остаток последнего такта, а не месячная сумма.
    expect(rec.expenses - last).toBeLessThanOrEqual(Math.ceil(f.total / MONTH_LENGTH) + 7);
    expect(rec.expenses - last).toBeLessThan(f.total / 10);
  });

  it('сумма за месяц не зависит от того, как такты легли по кадрам', () => {
    const play = (frame: number | (() => number)) => {
      const { game, line } = setup();
      for (let i = 0; i < 3; i++) game.buyVehicle(line.id, 'truck');
      game.takeLoan();
      game.speed = 1;
      for (let n = 0; game.monthIndex < 1 && n < 100_000; n++) game.update(typeof frame === 'number' ? frame : frame());
      const rec = game.history[0];
      return JSON.stringify({ ledger: rec.ledger, expenses: rec.expenses, income: rec.income, money: rec.money, cost: line.costLast });
    };
    let k = 0;
    const ragged = () => [0.013, 0.1, 0.051, 0.002, 0.077][k++ % 5];
    const one = play(SIM_DT);
    expect(play(0.1)).toBe(one);
    expect(play(ragged)).toBe(one);
  });

  it('проценты — от нынешнего долга: кредит, взятый посреди месяца, — за полмесяца', () => {
    const { game } = setup();
    until(game, MONTH_LENGTH / 2);
    const t = game.time;
    expect(game.takeLoan()).toBe(true);
    untilMonth(game, 1);
    const full = Math.round(100_000 * ECONOMY.loanRate);
    expect(game.history[0].ledger!.interest).toBe(Math.round((full * (MONTH_LENGTH - t)) / MONTH_LENGTH));
    // Погасили посреди следующего месяца — проценты только до того дня.
    until(game, MONTH_LENGTH * 1.5);
    const t2 = game.time - MONTH_LENGTH;
    expect(game.repayLoan()).toBe(true);
    untilMonth(game, 2);
    expect(Math.abs(game.history[1].ledger!.interest - (full * t2) / MONTH_LENGTH)).toBeLessThanOrEqual(1);
  });

  it('сохранение посреди месяца: начисленное и не списанное — в сохранении, итоги месяца те же', () => {
    const { game, line } = setup();
    for (let i = 0; i < 2; i++) game.buyVehicle(line.id, 'truck');
    game.takeLoan();
    runSeconds(game, 25.37);
    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    expect(save.upkeep).toBeDefined();
    expect(save.upkeep!.at).toBeCloseTo(game.time, 6);
    expect(save.fleet.every((v) => v.upkeepDue !== undefined)).toBe(true);
    const loaded = withoutCitizens(new Game(save.settings, save));
    const loadedLine = loaded.lines.get(line.id)!;
    untilMonth(game, 1);
    untilMonth(loaded, 1);
    const a = game.history[0].ledger!;
    const b = loaded.history[0].ledger!;
    expect([b.vehicles, b.roads, b.interest]).toEqual([a.vehicles, a.roads, a.interest]);
    expect(loadedLine.costLast).toBe(line.costLast);
    expect(a.vehicles).toBe(2 * running);
  });

  it('старое сохранение посреди месяца (всё списывалось в конце): за прошедшую часть месяца — сразу, за месяц — как прежде', () => {
    const { game, line } = setup();
    for (let i = 0; i < 2; i++) game.buyVehicle(line.id, 'truck');
    game.takeLoan();
    runSeconds(game, 25);
    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    // Как сохранение до непрерывного содержания: начисленного нет, в идущем месяце содержание не списано.
    delete save.upkeep;
    const l = save.ledger!;
    save.expensesMonth -= l.vehicles + l.roads + l.interest;
    save.money += l.vehicles + l.roads + l.interest;
    l.vehicles = l.roads = l.interest = 0;
    for (const v of save.fleet) {
      delete v.upkeepDue;
      v.profitMonth = 0;
    }
    for (const x of save.lines) x.costMonth = 0;
    const old = withoutCitizens(new Game(save.settings, save));
    const f = old.upkeepForecast();
    untilMonth(old, 1);
    const rec = old.history[0].ledger!;
    // Партия заплатила за месяц столько же, сколько списали бы прежние итоги месяца одной суммой.
    expect(rec.vehicles).toBe(f.vehicles + f.crews);
    expect(rec.roads).toBe(f.roads);
    expect(rec.interest).toBe(f.interest);
    expect(old.lines.get(line.id)!.costLast).toBe(2 * running);
  });
});

describe('Запас на содержание и грань банкротства', () => {
  it('стройка держит запас на полмесяца вперёд: buildBudget = budget − темп × 30 с', () => {
    const { game, line } = setup();
    for (let i = 0; i < 3; i++) game.buyVehicle(line.id, 'truck');
    game.takeLoan();
    const f = game.upkeepForecast();
    expect(ECONOMY.upkeepReserve).toBe(MONTH_LENGTH / 2);
    expect(game.upkeepReserve).toBe(Math.ceil(f.total / 2));
    expect(game.buildBudget).toBe(game.budget - game.upkeepReserve);
    // Запас не зависит от дня месяца: в конце месяца крупного платежа больше нет.
    until(game, MONTH_LENGTH - 2);
    expect(game.upkeepReserve).toBe(Math.ceil(game.upkeepForecast().total / 2));
  });

  it('грань банкротства — по счёту и темпу содержания: сколько секунд счёт продержится над кредитным пределом', () => {
    const { game, line } = setup();
    for (let i = 0; i < 3; i++) game.buyVehicle(line.id, 'truck');
    const perSecond = game.upkeepForecast().total / MONTH_LENGTH;
    game.money = ECONOMY.creditLimit + perSecond * 20;
    expect(game.upkeepRunway).toBeCloseTo(20, 6);
    expect(game.nearBankrupt).toBe(false);
    game.money = ECONOMY.creditLimit + perSecond * 10;
    expect(game.nearBankrupt).toBe(true);
    game.money = ECONOMY.creditLimit - 1;
    expect(game.upkeepRunway).toBe(0);
    expect(game.nearBankrupt).toBe(true);
    // Счёт переходит грань по ходу месяца — уведомление сразу, а не в конце месяца.
    game.money = ECONOMY.creditLimit + perSecond * (ECONOMY.brinkSeconds + 2);
    const warned = () => game.notices.filter((n) => n.text === 'Компания на грани банкротства!').length;
    const n0 = warned();
    runSeconds(game, 4);
    expect(game.monthIndex).toBe(0);
    expect(warned()).toBe(n0 + 1);
  });
});
