import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { Game } from '../game/game';
import { freightRoute, runSeconds, withoutCitizens } from '../game/testkit';
import { MODELS } from '../game/transport';
import { DEFAULT_SETTINGS } from '../world/settings';
import { refOf } from './analysis';
import {
  type Circuit,
  forecastOf,
  forecastTip,
  type Haul,
  haulOf,
  lapAmount,
  lapOf,
  linePace,
  type Outlook,
  outlookOf,
  queueAt,
  schedule,
  type Unit,
  unitTrips,
} from './forecast';

/** Числа ru-RU разделены неразрывным пробелом — в ожиданиях пишем обычный. */
const sp = (s: string) => s.replace(/ /g, ' ');

/** Длинный маршрут: погрузка (0) → получатель задания (1), перегоны по 5 минут, стоянка 10 с. */
const long: Circuit = { legs: [300, 300], dwell: 10, load: [true, false], sink: [false, true], drop: [false, true] };
const truck = (patch: Partial<Unit> = {}): Unit => ({ stop: 0, driving: false, wait: 0, carrying: 0, capacity: 16, ...patch });

describe('Расписание машины', () => {
  it('новая машина на погрузке: первая доставка через перегон — к сроку успевает или нет', () => {
    expect(unitTrips(long, truck({ wait: 5 }), 480)).toEqual({ first: 305, amount: 16, count: 1 });
    // Срок раньше, чем она доедет, — ни одной доставки.
    expect(unitTrips(long, truck({ wait: 5 }), 300)).toEqual({ first: null, amount: 0, count: 0 });
    // Дальше — раз в круг: 305 + 10 + 300 + 10 + 300.
    expect(unitTrips(long, truck({ wait: 5 }), 925)).toEqual({ first: 305, amount: 32, count: 2 });
  });

  it('едет гружёная к получателю — довезёт за остаток перегона, дальше — раз в круг', () => {
    const loaded = truck({ stop: 1, driving: true, wait: 100, carrying: 12 });
    expect(unitTrips(long, loaded, 480)).toEqual({ first: 100, amount: 12, count: 1 });
    expect(unitTrips(long, loaded, 720)).toEqual({ first: 100, amount: 28, count: 2 });
    expect(unitTrips(long, loaded, 99).first).toBeNull();
  });

  it('едет пустая за грузом — до погрузки, стоянка и перегон до получателя', () => {
    expect(unitTrips(long, truck({ stop: 0, driving: true, wait: 50 }), 480).first).toBe(360);
  });

  it('на погрузке ждут груз: запаса хватает — уезжают полными сразу; нет — делят выпуск и уезжают, когда кончится терпение', () => {
    const a = truck({ wait: 3 });
    queueAt({ stock: 40, rate: 1 }, [{ unit: a, patience: 27 }]);
    expect(a).toMatchObject({ wait: 3, departs: 16 });
    // Две машины, склад пуст, выпуск 0.9 ед./с — каждой по 0.45: полную не наберут, уедут через 27 с ожидания.
    const b = truck({ wait: 3 });
    const c = truck({ wait: 6 });
    queueAt({ stock: 0, rate: 0.9 }, [
      { unit: b, patience: 27 },
      { unit: c, patience: 27 },
    ]);
    expect(b.wait).toBeCloseTo(30);
    expect(b.departs).toBeCloseTo(13.5);
    expect(c.wait).toBeCloseTo(33);
    // Уехала неполной — и довезёт столько, сколько взяла.
    expect(unitTrips(long, b, 480)).toEqual({ first: 330, amount: 13.5, count: 1 });
  });

  it('груз сойдёт раньше, у другого получателя, — не в счёт задания', () => {
    const via: Circuit = { legs: [100, 100, 100], dwell: 10, load: [true, false, false], sink: [false, true, true], drop: [false, false, true] };
    expect(unitTrips(via, truck(), 2000)).toEqual({ first: null, amount: 0, count: 0 });
  });

  it('круг и сколько за него довозит машина; все машины — сумма, первая доставка — самая ранняя, темп по циклу', () => {
    expect(lapOf(long)).toBe(620);
    expect(lapAmount(long, 16)).toBe(16);
    const s = schedule([{ circuit: long, units: [truck({ wait: 5 }), truck({ stop: 1, driving: true, wait: 100, carrying: 16 })] }], 480);
    expect(s).toMatchObject({ vehicles: 2, amount: 32, first: 100 });
    expect(s.rate).toBeCloseTo(32 / 620);
  });
});

describe('Прогноз к сроку', () => {
  const outlook = (patch: Partial<Outlook>): Outlook => ({ vehicles: 1, amount: 0, first: null, rate: 0, supply: null, supplyRate: null, ...patch });

  it('какие задания: груз и пассажиры — да, месячные, рост, уровень и подключения — нет', () => {
    const to = { type: 'industry' as const, id: 4 };
    expect(haulOf({ kind: 'deliver', cargo: 'logs', amount: 130, to })).toEqual({ kind: 'cargo', cargo: 'logs', to, from: undefined });
    expect(haulOf({ kind: 'passengers', amount: 300, towns: [3, 7] })).toEqual({ kind: 'pax', towns: [3, 7] });
    expect(haulOf({ kind: 'throughput', amount: 900, costRatio: 0.7, months: 3 })).toBeNull();
    expect(haulOf({ kind: 'supply', town: 1, months: 2 })).toBeNull();
    expect(haulOf({ kind: 'population', town: 1, amount: 5000 })).toBeNull();
    expect(haulOf({ kind: 'connect', what: 'town', amount: 2, known: [] })).toBeNull();
  });

  it('сделано + довезут по расписанию, но не больше, чем есть что везти; темп — по циклу и выпуску', () => {
    const f = forecastOf(10, 100, outlook({ vehicles: 2, amount: 64, first: 100, rate: 0.05, supply: 40, supplyRate: 0.03 }));
    expect(f.value).toBe(50);
    expect(f.fraction).toBeCloseTo(0.5);
    expect(f.reach).toBe(false);
    expect(f.perMinute).toBeCloseTo(1.8);
    // Доставки уже были — без «первой доставки».
    expect(f.first).toBeNull();
    expect(sp(forecastTip(f))).toBe('Прогноз к сроку: ~50 (темп 1,8 в мин)');
  });

  it('доставок ещё не было — когда первая; прогноз выше цели — «успеваем»', () => {
    const f = forecastOf(0, 130, outlook({ amount: 160, first: 305, rate: 16 / 620 }));
    expect(f.reach).toBe(true);
    expect(f.fraction).toBe(1);
    expect(sp(forecastTip(f))).toBe('Прогноз к сроку: ~160 · первая доставка через ~6 мин — успеваем');
  });

  it('линий нет — прогноз равен сделанному, «возить пока некому»; машины не доедут — так и говорит', () => {
    const idle = forecastOf(20, 130, outlook({ vehicles: 0 }));
    expect(idle.value).toBe(20);
    expect(sp(forecastTip(idle))).toBe('Прогноз к сроку: ~20 — возить пока некому');
    const late = forecastOf(0, 130, outlook({ vehicles: 3, amount: 0, first: null, rate: 0.1 }));
    expect(late.value).toBe(0);
    expect(late.stall).toBe('late');
    expect(sp(forecastTip(late))).toBe('Прогноз к сроку: ~0 — машины не успеют доехать до срока');
  });
});

describe('Расписание по линиям игры', () => {
  /** Сценарий с грузовым маршрутом ферма → пищекомбинат (на этой карте они рядом — маршрут строится). */
  function route() {
    const game = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 5, scenario: { difficulty: 'easy', challenge: false } }));
    const r = freightRoute(game);
    expect(r.built).toBe(true);
    const haul: Haul = { kind: 'cargo', cargo: r.from.info.produces, to: refOf(r.to) };
    return { game, ...r, haul };
  }

  it('машин нет — возить некому; новая машина у станции — прогноз сразу, успевает к сроку или нет', () => {
    const { game, line, haul } = route();
    expect(outlookOf(game, haul, 600).vehicles).toBe(0);
    game.buyVehicle(line.id, 'truck');
    const o = outlookOf(game, haul, 600);
    expect(o.vehicles).toBe(1);
    expect(o.first).toBeGreaterThan(5);
    expect(o.amount).toBeGreaterThanOrEqual(MODELS.truck.capacity);
    // Срок раньше первой доставки — не успеет ни разу.
    const short = outlookOf(game, haul, o.first! - 1);
    expect(short).toMatchObject({ first: null, amount: 0 });
    // Ещё машина — больше по расписанию.
    game.buyVehicle(line.id, 'truck');
    expect(outlookOf(game, haul, 600).amount).toBeGreaterThan(o.amount);
  });

  it('машина в пути с грузом: прогноз первой доставки сбывается', { timeout: 60_000 }, () => {
    const { game, line, haul } = route();
    const v = game.buyVehicle(line.id, 'truck')!;
    // До отправления с грузом.
    for (let t = 0; t < 120 && !(v.state === 'driving' && v.cargo === haul.cargo); t += 0.1) runSeconds(game, 0.1);
    expect(v.state).toBe('driving');
    runSeconds(game, 2);
    const o = outlookOf(game, haul, 600);
    expect(o.first).not.toBeNull();
    const carriedBefore = line.carriedMonth + line.carriedLast;
    const start = game.time;
    for (let t = 0; t < 120 && line.carriedMonth + line.carriedLast === carriedBefore; t += 0.1) runSeconds(game, 0.1);
    const actual = game.time - start;
    // Грубо, без пробок: в пределах полутора раз.
    expect(actual).toBeGreaterThan(o.first! / 1.5);
    expect(actual).toBeLessThan(o.first! * 1.5 + 5);
  });

  it('темп маршрута по циклу — для карточки: не больше выпуска, пока рейсов не было — первая доставка', () => {
    const { game, line, from, haul } = route();
    expect(linePace(game, line)).toEqual([]);
    game.buyVehicle(line.id, 'truck');
    const [pace] = linePace(game, line);
    expect(pace.cargo).toBe(haul.kind === 'cargo' ? haul.cargo : null);
    expect(pace.perMinute).toBeGreaterThan(0);
    // Выпуск фермы в минуту (месяц — MONTH_LENGTH секунд).
    const output = (game.industryRate(from) * 60) / MONTH_LENGTH;
    expect(pace.perMinute).toBeLessThanOrEqual(output + 1e-6);
    expect(pace.first).not.toBeNull();
    // Машин много — темп упирается в выпуск фермы.
    for (let i = 0; i < 12; i++) game.buyVehicle(line.id, 'truck');
    expect(linePace(game, line)[0].perMinute).toBeCloseTo(output);
  });

  it('прогноз задания — сразу после покупки машины, ещё до первой доставки', () => {
    const { game, line, to, haul } = route();
    const sc = game.scenario!;
    const o = sc.addObjective({ kind: 'deliver', cargo: haul.kind === 'cargo' ? haul.cargo : 'grain', amount: 2000, to: refOf(to) }, { role: 'contract', phase: null, months: 8, why: '', reward: {} });
    expect(sc.forecast(o)!.stall).toBe('idle');
    // Купили — прогноз пересчитан сразу, в ту же секунду игры (и на паузе).
    game.buyVehicle(line.id, 'truck');
    const f = sc.forecast(o)!;
    expect(f.stall).toBeNull();
    expect(f.value).toBeGreaterThan(0);
    expect(f.first).not.toBeNull();
    expect(sp(forecastTip(f))).toMatch(/^Прогноз к сроку: ~[\d ]+ · первая доставка через ~\d+ (сек|мин)$/);
  });
});
