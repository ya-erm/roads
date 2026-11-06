import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { DEFAULT_SETTINGS } from '../world/settings';
import type { Objective, ScenarioState } from '../scenario/types';
import { Game, type SaveData } from './game';
import { minutesText, repaceSave, saveMonthLength } from './monthPace';
import { withoutCitizens } from './testkit';

/** Задание сценария со всеми полями, которые трогает пересчёт. */
function objective(o: Partial<Objective>): Objective {
  return {
    id: 'o1',
    params: { kind: 'deliver', cargo: 'food', amount: 300, to: null },
    role: 'goal',
    phase: 0,
    title: '',
    why: '',
    critical: false,
    status: 'active',
    created: 0,
    started: 0,
    deadline: null,
    base: 0,
    progress: 0,
    target: 300,
    streak: 0,
    reward: {},
    fail: {},
    related: [],
    points: 60,
    ...o,
  };
}

/**
 * Старое сохранение (месяц — 120 с, без monthLength): 3,5 месяца партии — середина апреля первого года,
 * с машиной в пути, линией, предприятием, городом и сценарием.
 */
function oldSave(): SaveData {
  const scenario = {
    objectives: [
      objective({ id: 'deliver', deadline: 6, fast: 4.5, why: 'Нужно за 3 мес.' }),
      objective({
        id: 'profit',
        params: { kind: 'profit', amount: 12_000, months: 2 },
        target: 2,
        streak: 1,
        progress: 1,
        deadline: 8,
        reward: { money: 5000, effects: [{ kind: 'growth', target: 1, factor: 1.5, months: 6 }], follow: [{ event: 'boom', subject: null, delay: 1 }] },
      }),
      objective({ id: 'offer', status: 'offered', deadline: null, offerUntil: 5, months: 3, fastMonths: 2 }),
      objective({ id: 'old', status: 'done', deadline: 2, closedAt: 2, params: { kind: 'profit', amount: 9000, months: 1 }, target: 1 }),
    ],
    effects: [{ id: 'x1', kind: 'industry', target: 1, factor: 1.2, months: 2, until: 5, source: 'e1' }],
    events: [{ id: 'e1', type: 'order', month: 2, importance: 'minor', title: '', cause: 'уже 2 мес. стоит', effects: ['Контракт: 300 ед. за 3 мес.'], related: [], until: 7 }],
    queue: [{ event: 'boom', subject: null, delay: 1, at: 5, parent: 'e1' }],
    brief: { region: '', text: '', capital: 0, loan: 0, loanMax: 0, months: 20, facts: [] },
    watch: { 1: { low: 1, idle: 2, active: true } },
    bankrupt: 1,
    stats: { delivered: {}, to: {}, pax: 0, between: {}, units: 40, paxUnits: 10, speedSum: 48, months: [{ month: 2, units: 100, pax: 20, speed: 1.2, income: 9000, costs: 4000 }] },
  } as unknown as ScenarioState;
  return {
    time: 420,
    month: 3,
    incomeMonth: 7000,
    expensesMonth: 2000,
    ledger: { transport: 6000, sales: 1000, vehicles: 0, roads: 0, build: 2000, purchases: 0, interest: 0 },
    lines: [{ id: 1, revenueMonth: 4000, costMonth: 1000, carriedMonth: 60, revenueLast: 8000, costLast: 2200, carriedLast: 120, departedAt: 400, statsFrom: 380, auto: { on: true, min: 1, max: 5, sell: 410 } }],
    fleet: [{ id: 1, loadedTime: 390, lapAt: 300, passengers: [{ from: 1, to: 2, count: 5, at: 395 }], profitMonth: 900, profitLast: 1800, timer: 3, waited: 12 }],
    industries: [{ id: 1, producedMonth: 30, producedLast: 108, piledMonth: 40, streak: 1, stock: { grain: 50 } }],
    towns: [{ id: 1, supplied: { food: 20 }, lastSupplied: { food: 31 } }],
    history: [{ label: 'Мар 2000', income: 12_000, expenses: 5000, money: 1000 }],
    journal: [{ m: 3.2, k: 'note' }],
    timelapse: { v: 1, frames: [] },
    scenario,
  } as unknown as SaveData;
}

describe('Длина месяца партии в сохранении', () => {
  it('в новых сохранениях — своя, в старых — 120 с, а в самых старых — 40 с (по номеру месяца)', () => {
    expect(saveMonthLength({ time: 100, month: 1, monthLength: 60 })).toBe(60);
    expect(saveMonthLength({ time: 1681, month: 14 })).toBe(120);
    expect(saveMonthLength({ time: 14_401, month: 360 })).toBe(40);
    // Первые 40 секунд номер месяца подходит обоим — значит, 120 с.
    expect(saveMonthLength({ time: 30, month: 0 })).toBe(120);
  });

  it('сохранение под нынешний месяц не пересчитывается', () => {
    const save = { ...oldSave(), time: 210, monthLength: MONTH_LENGTH };
    expect(repaceSave(save)).toBe(save);
  });
});

describe('Старое сохранение (месяц 120 с) под месяц в минуту', () => {
  const save = oldSave();
  const s = repaceSave(save);
  const sc = s.scenario!;
  const obj = (id: string) => sc.objectives.find((o) => o.id === id)!;

  it('дата та же: номер месяца и доля прошедшего месяца; в сохранении — новая длина месяца', () => {
    expect(s.month).toBe(3);
    expect(s.time).toBe(3.5 * MONTH_LENGTH);
    expect(Math.floor(s.time / MONTH_LENGTH)).toBe(save.month);
    expect(s.monthLength).toBe(MONTH_LENGTH);
    // 3,5 месяца по 2 мин — 7 минут-месяцев: календарь отстаёт от реального времени на 3,5 месяца.
    expect(s.paceShift).toBe(3.5);
  });

  it('исходное сохранение не меняется; журнал, кадры таймлапса и история по месяцам — как были', () => {
    expect(save.time).toBe(420);
    expect(save.scenario!.objectives[0].deadline).toBe(6);
    expect(s.journal).toBe(save.journal);
    expect(s.timelapse).toBe(save.timelapse);
    expect(s.history).toEqual(save.history);
  });

  it('отметки времени машин и линий — столько же секунд назад', () => {
    const shift = s.time - save.time;
    expect(s.lines[0].departedAt).toBe(400 + shift);
    expect(s.lines[0].statsFrom).toBe(380 + shift);
    expect(s.lines[0].auto!.sell).toBe(410 + shift);
    expect(s.fleet[0].loadedTime).toBe(390 + shift);
    expect(s.fleet[0].lapAt).toBe(300 + shift);
    expect(s.fleet[0].passengers[0].at).toBe(395 + shift);
    // Длительности — секунды как секунды.
    expect(s.fleet[0].timer).toBe(3);
    expect(s.fleet[0].waited).toBe(12);
  });

  it('суммы этого и прошлого месяца — за месяц вдвое короче: вдвое меньше; разовые (стройка, продажи) — как были', () => {
    expect(s.ledger!.transport).toBe(3000);
    expect(s.incomeMonth).toBe(4000);
    expect(s.ledger!.sales).toBe(1000);
    expect(s.ledger!.build).toBe(2000);
    expect(s.expensesMonth).toBe(2000);
    expect(s.lines[0].revenueLast).toBe(4000);
    expect(s.lines[0].carriedMonth).toBe(30);
    expect(s.fleet[0].profitLast).toBe(900);
    expect(s.industries[0].producedLast).toBe(54);
    expect(s.industries[0].piledMonth).toBe(20);
    expect(s.towns[0].supplied.food).toBe(10);
    expect(s.towns[0].lastSupplied.food).toBe(16);
    // Запасы — не за месяц: как были.
    expect(s.industries[0].stock.grain).toBe(50);
  });

  it('серии в месяцах — вдвое длиннее: рост предприятия, «месяцы подряд», наблюдение событий, банкротство', () => {
    expect(s.industries[0].streak).toBe(2);
    expect(sc.watch[1]).toEqual({ low: 2, idle: 4, active: true });
    expect(sc.bankrupt).toBe(2);
    expect(sc.brief.months).toBe(40);
  });

  it('сроки впереди — те же минуты от сегодняшнего месяца, прошедшие — как были', () => {
    // Было: срок — начало 6-го месяца, 2,5 месяца по 2 мин = 5 мин; стало: 3 + 2·3 = 9-й месяц, 5,5 мин.
    expect(obj('deliver').deadline).toBe(9);
    const leftBefore = 6 * 120 - save.time;
    const leftAfter = obj('deliver').deadline! * MONTH_LENGTH - s.time;
    expect(leftAfter).toBeGreaterThanOrEqual(leftBefore);
    expect(leftAfter - leftBefore).toBeLessThanOrEqual(MONTH_LENGTH);
    // Быстрый срок — месяц с долей, ровно те же минуты.
    expect(obj('deliver').fast! * MONTH_LENGTH - s.time).toBeCloseTo(4.5 * 120 - save.time, 6);
    expect(obj('offer').offerUntil).toBe(7);
    expect(obj('offer').months).toBe(6);
    expect(obj('offer').fastMonths).toBe(4);
    expect(sc.effects[0].until).toBe(7);
    expect(sc.events[0].until).toBe(11);
    expect(sc.events[0].month).toBe(2);
    expect(sc.queue[0]).toMatchObject({ at: 7, delay: 2 });
    // Закрытое задание — история: не трогаем.
    expect(obj('old').deadline).toBe(2);
    expect(obj('old').params).toEqual({ kind: 'profit', amount: 9000, months: 1 });
  });

  it('месячное задание: условие месяца — вдвое меньше, месяцев подряд — вдвое больше, награда — те же минуты', () => {
    const p = obj('profit');
    expect(p.params).toEqual({ kind: 'profit', amount: 6000, months: 4 });
    expect(p.target).toBe(4);
    expect(p.streak).toBe(2);
    expect(p.progress).toBe(2);
    expect(p.reward.effects![0].months).toBe(12);
    expect(p.reward.follow![0].delay).toBe(2);
  });

  it('итоги сценария по месяцам — в нынешних месяцах; тексты «N мес.» — минутами', () => {
    expect(sc.stats.units).toBe(20);
    expect(sc.stats.months[0]).toMatchObject({ month: 2, units: 50, pax: 10, income: 4500, costs: 2000, speed: 1.2 });
    expect(obj('deliver').why).toBe('Нужно за 6 мин');
    expect(sc.events[0].cause).toBe('уже 4 мин стоит');
    expect(sc.events[0].effects).toEqual(['Контракт: 300 ед. за 6 мин']);
    expect(minutesText('на 0,5 мес.', 120)).toBe('на 1 мин');
  });
});

describe('Старая партия открывается в игре', { timeout: 60_000 }, () => {
  it('с той же датой и тем же временем до сроков; названия месячных заданий — по новым условиям; второй раз не пересчитывается', () => {
    const game = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 11, scenario: { difficulty: 'normal', challenge: false } }));
    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    // Как сохранила бы игра с месяцем в 2 минуты: середина апреля, срок задания — начало июля.
    delete save.monthLength;
    save.time = 3.5 * 120;
    save.month = 3;
    const sc = save.scenario!;
    const goal = sc.objectives.find((o) => o.status === 'active')!;
    goal.deadline = 6;
    const profit = sc.objectives.find((o) => o.status === 'active' && o.params.kind === 'profit');
    if (profit && profit.params.kind === 'profit') {
      profit.params = { kind: 'profit', amount: 20_000, months: 2 };
      profit.title = 'Операционная прибыль от $20 000 в месяц, 2 месяца подряд';
    }

    const loaded = withoutCitizens(new Game(save.settings, save));
    expect(loaded.dateLabel).toBe(game.dateAt(3));
    expect(loaded.monthProgress).toBeCloseTo(0.5, 6);
    const left = loaded.scenario!.secondsLeft(loaded.scenario!.objective(goal.id)!)!;
    expect(left).toBeGreaterThanOrEqual(6 * 120 - 3.5 * 120);
    expect(left).toBeLessThanOrEqual(6 * 120 - 3.5 * 120 + MONTH_LENGTH);
    if (profit) expect(loaded.scenario!.objective(profit.id)!.title).toBe(`Операционная прибыль от $${(10_000).toLocaleString('ru-RU')} в месяц, 4 месяца подряд`);
    expect(loaded.journal.entries.some((e) => e.k === 'pace' && e.from === 120 && e.to === MONTH_LENGTH)).toBe(true);

    // Пересохранили — уже новая длина месяца: следующая загрузка ничего не пересчитывает.
    const again = JSON.parse(JSON.stringify(loaded.toSave())) as SaveData;
    expect(again.monthLength).toBe(MONTH_LENGTH);
    const reloaded = new Game(again.settings, again);
    expect(reloaded.time).toBe(loaded.time);
    expect(reloaded.scenario!.objective(goal.id)!.deadline).toBe(loaded.scenario!.objective(goal.id)!.deadline);
    expect(reloaded.journal.entries.filter((e) => e.k === 'pace')).toHaveLength(1);
  });
});
