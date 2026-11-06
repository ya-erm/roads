import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { Game } from '../game/game';
import { freightRoute, runSeconds, withoutCitizens } from '../game/testkit';
import { DEFAULT_SETTINGS } from '../world/settings';
import { refOf } from './analysis';
import { cargoKeys, forecastOf, forecastTip, PACE_BOOST, PACE_WINDOW, PaceLog, paceKey, paceOf, paxKeys, type Arrival, type FleetSample } from './forecast';
import type { ObjectiveParams } from './types';

/** Числа ru-RU разделены неразрывным пробелом — в ожиданиях пишем обычный. */
const sp = (s: string) => s.replace(/ /g, ' ');

/** Замеры парка раз в секунду с from по to: машин на линиях — fleet(t). */
function samples(from: number, to: number, fleet: (t: number) => Partial<Record<number, number>>): FleetSample[] {
  const out: FleetSample[] = [];
  for (let t = from; t <= to; t++) out.push({ t, n: new Map(Object.entries(fleet(t)).map(([k, v]) => [Number(k), v ?? 0])) });
  return out;
}

/** Доставки линией line по amount каждые every секунд с from по to. */
function arrivals(line: number | null, keys: string[], amount: number, every: number, from: number, to: number): Arrival[] {
  const out: Arrival[] = [];
  for (let t = from; t <= to; t += every) out.push({ t, line, amount, keys });
  return out;
}

describe('Прогноз: какие задания и какие доставки в счёт', () => {
  it('ключ — тот же счётчик, что у прогресса: получатель, производитель, груз, пара городов, все пассажиры', () => {
    const to = { type: 'industry' as const, id: 4 };
    expect(paceKey({ kind: 'deliver', cargo: 'logs', amount: 130, to })).toBe('to:industry:4:logs');
    expect(paceKey({ kind: 'deliver', cargo: 'fuel', amount: 410, to: null, from: 9 })).toBe('from:9:fuel');
    expect(paceKey({ kind: 'deliver', cargo: 'fuel', amount: 410, to: null })).toBe('cargo:fuel');
    expect(paceKey({ kind: 'passengers', amount: 1060, towns: null })).toBe('pax');
    expect(paceKey({ kind: 'passengers', amount: 300, towns: [7, 3] })).toBe('pair:3-7');
    // Доставка ложится во все свои счётчики.
    expect(cargoKeys('logs', to, 2)).toEqual(['cargo:logs', 'to:industry:4:logs', 'from:2:logs']);
    expect(paxKeys(3, 7)).toEqual(['pax', 'pair:3-7']);
    expect(paxKeys(3, 3)).toEqual(['pax']);
    expect(paxKeys(undefined, 7)).toEqual(['pax']);
  });

  it('месячные задания, рост города, уровень предприятия и подключения — без прогноза', () => {
    const none: ObjectiveParams[] = [
      { kind: 'profit', amount: 29000, months: 2 },
      { kind: 'supply', town: 1, months: 2 },
      { kind: 'quality', speed: 1.2, volume: 500, months: 2 },
      { kind: 'throughput', amount: 900, costRatio: 0.7, months: 3 },
      { kind: 'newRoutes', amount: 400, since: 3, months: 2 },
      { kind: 'industry', industry: 1, level: 2 },
      { kind: 'population', town: 1, amount: 5000 },
      { kind: 'connect', what: 'town', amount: 2, known: [] },
    ];
    for (const p of none) expect(paceKey(p), p.kind).toBeNull();
  });
});

describe('Темп доставок', () => {
  const key = 'cargo:fuel';
  const keys = ['cargo:fuel'];
  // Линия 1: две машины, 30 ед. каждые 20 с — 1.5 ед./с.
  const steady = { arrivals: arrivals(1, keys, 30, 20, 20, 180), fleet: samples(0, 180, () => ({ 1: 2 })), since: 0 };

  it('первую минуту наблюдений прогноза нет — по паре рейсов он скачет', () => {
    expect(paceOf(key, { ...steady, since: null }, 180, () => 2)).toBeNull();
    expect(paceOf(key, { ...steady, since: 130 }, 180, () => 2)).toBeNull();
    expect(paceOf(key, { ...steady, since: 120 }, 180, () => 2)).not.toBeNull();
  });

  it('за окно: доставлено ÷ время; чужой груз не в счёт, старое — за окном', () => {
    expect(paceOf(key, steady, 180, () => 2)).toBeCloseTo(1.5);
    expect(paceOf('cargo:logs', steady, 180, () => 2)).toBe(0);
    // Через окно после последней доставки — темп ноль.
    expect(paceOf(key, steady, 180 + PACE_WINDOW, () => 2)).toBe(0);
  });

  it('добавили машину — темп сразу растёт по парку линии, но не больше чем вдвое; убрали все — ноль', () => {
    expect(paceOf(key, steady, 180, () => 3)).toBeCloseTo(2.25);
    expect(paceOf(key, steady, 180, () => 20)).toBeCloseTo(1.5 * PACE_BOOST);
    expect(paceOf(key, steady, 180, () => 1)).toBeCloseTo(0.75);
    expect(paceOf(key, steady, 180, () => 0)).toBe(0);
  });

  it('машины добавили посреди окна — темп на машину считается по среднему парку', () => {
    // Первые 90 с — одна машина (67.5 ед.), дальше две (135 ед.): на машину — те же 0.75 ед./с, двум — 1.5.
    const data = {
      arrivals: [...arrivals(1, keys, 22.5, 30, 30, 90), ...arrivals(1, keys, 45, 30, 120, 180)],
      fleet: samples(1, 180, (t) => ({ 1: t <= 90 ? 1 : 2 })),
      since: 0,
    };
    expect(paceOf(key, data, 180, () => 2)).toBeCloseTo(1.5);
    // Снова одна — темп одной машины.
    expect(paceOf(key, data, 180, () => 1)).toBeCloseTo(0.75);
  });

  it('новая линия — по времени, пока у неё были машины, а не по всему окну', () => {
    // Линия 2 появилась минуту назад: 60 ед. за минуту — 1 ед./с, а не 60 / 180.
    const data = { arrivals: arrivals(2, keys, 20, 20, 140, 180), fleet: samples(0, 180, (t) => (t >= 120 ? { 2: 2 } : {})), since: 0 };
    expect(paceOf(key, data, 180, () => 2)).toBeCloseTo(1);
    // Две линии — темпы складываются.
    const both = { ...data, arrivals: [...data.arrivals, ...steady.arrivals], fleet: samples(0, 180, (t) => (t >= 120 ? { 1: 2, 2: 2 } : { 1: 2 })) };
    expect(paceOf(key, both, 180, () => 2)).toBeCloseTo(2.5);
  });

  it('доставки без линии — просто за окно', () => {
    expect(paceOf(key, { arrivals: arrivals(null, keys, 60, 30, 30, 120), fleet: [], since: 0 }, 120, () => 0)).toBeCloseTo(2);
  });

  it('журнал держит только окно: старые доставки и замеры уходят', () => {
    const log = new PaceLog();
    for (let t = 1; t <= 400; t++) {
      if (t % 10 === 0) log.add({ t, line: 1, amount: 10, keys });
      log.sample(t, new Map([[1, 1]]));
    }
    expect(log.since).toBe(1);
    expect(log.at).toBe(400);
    expect(log.arrivals[0].t).toBeGreaterThan(400 - PACE_WINDOW);
    expect(log.fleet.length).toBe(PACE_WINDOW);
    expect(log.rate(key, () => 1)).toBeCloseTo(1);
  });
});

describe('Прогноз к сроку', () => {
  it('сделано + темп × оставшееся время; не успеваем — сколько нужно в минуту', () => {
    // 436 / 1 060, 8 мин до срока, темп 60 в мин.
    const f = forecastOf(436, 1060, 480, 1);
    expect(f.value).toBeCloseTo(916);
    expect(f.fraction).toBeCloseTo(916 / 1060);
    expect(f.reach).toBe(false);
    expect(f.perMinute).toBeCloseTo(60);
    expect(f.need).toBeCloseTo(78);
    expect(sp(forecastTip(f))).toBe('Прогноз к сроку: ~916 (темп 60 в мин). Чтобы успеть — 78 в мин');
  });

  it('прогноз выше цели — шкала до конца и «успеваем»', () => {
    const f = forecastOf(272, 410, 480, 0.5);
    expect(f.value).toBeCloseTo(512);
    expect(f.fraction).toBe(1);
    expect(f.reach).toBe(true);
    expect(sp(forecastTip(f))).toBe('Прогноз к сроку: ~512 (темп 30 в мин) — успеваем');
  });

  it('ничего не возим — прогноз равен сделанному; малый темп — с десятыми', () => {
    const idle = forecastOf(0, 130, 300, 0);
    expect(idle.value).toBe(0);
    expect(idle.fraction).toBe(0);
    expect(sp(forecastTip(idle))).toBe('Прогноз к сроку: ~0 (темп 0 в мин). Чтобы успеть — 26 в мин');
    expect(sp(forecastTip(forecastOf(10, 130, 300, 0.04)))).toBe('Прогноз к сроку: ~22 (темп 2,4 в мин). Чтобы успеть — 24 в мин');
    // Срок вышел — сколько нужно, не пишем.
    expect(forecastOf(10, 130, 0, 1).need).toBeNull();
  });
});

describe('Прогноз в сценарии', () => {
  const settings = { ...DEFAULT_SETTINGS, seed: 7, scenario: { difficulty: 'easy' as const, challenge: false } };

  it('у накопительного задания со сроком — после первой минуты; у месячных и без срока — нет', () => {
    const game = new Game(settings);
    const sc = game.scenario!;
    const plant = game.industries.find((i) => i.info.accepts.length)!;
    const cargo = plant.info.accepts[0];
    const o = sc.addObjective({ kind: 'deliver', cargo, amount: 5000, to: refOf(plant) }, { role: 'contract', phase: null, months: 8, why: '', reward: {} });
    const monthly = sc.addObjective({ kind: 'throughput', amount: 900, costRatio: 0.7, months: 2 }, { role: 'goal', phase: 0, months: 8, why: '', reward: {} });
    const open = sc.addObjective({ kind: 'deliver', cargo, amount: 5000, to: null }, { role: 'extra', phase: null, months: null, why: '', reward: {} });
    // Каждую секунду — замер, каждые 10 с — 50 ед. получателю задания.
    const run = (until: number) => {
      while (game.time < until) {
        game.time += 1;
        if (Math.round(game.time) % 10 === 0) sc.onDelivered(cargo, 50, refOf(plant), 1);
        sc.tick(1);
      }
    };
    run(30);
    expect(sc.forecast(o)).toBeNull();
    run(120);
    const f = sc.forecast(o)!;
    expect(o.progress).toBe(600);
    expect(f.perMinute).toBeCloseTo(300, -1);
    const left = o.deadline! * MONTH_LENGTH - 120;
    expect(f.value).toBeCloseTo(600 + (f.perMinute / 60) * left);
    expect(sc.forecast(monthly)).toBeNull();
    expect(sc.forecast(open)).toBeNull();
  });

  it('по настоящим рейсам: прогноз появляется, а купили грузовик — сразу растёт', { timeout: 60_000 }, () => {
    // На этой карте ферма и пищекомбинат рядом — маршрут строится.
    const game = withoutCitizens(new Game({ ...settings, seed: 5 }));
    const sc = game.scenario!;
    const route = freightRoute(game);
    expect(route.built).toBe(true);
    game.buyVehicle(route.line.id, 'truck');
    game.buyVehicle(route.line.id, 'truck');
    const o = sc.addObjective({ kind: 'deliver', cargo: route.from.info.produces, amount: 5000, to: refOf(route.to) }, { role: 'contract', phase: null, months: 12, why: '', reward: {} });
    runSeconds(game, 150);
    const before = sc.forecast(o)!;
    expect(o.progress).toBeGreaterThan(0);
    expect(before.perMinute).toBeGreaterThan(0);
    game.buyVehicle(route.line.id, 'truck');
    runSeconds(game, 1.1);
    const after = sc.forecast(o)!;
    // Три машины вместо двух — темп в полтора раза больше, ещё до первого рейса новой.
    expect(after.perMinute / before.perMinute).toBeGreaterThan(1.3);
    expect(after.value).toBeGreaterThan(before.value);
  });
});
