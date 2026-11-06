import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { TOWN_NEED } from '../world/entities';
import { DEFAULT_SETTINGS } from '../world/settings';
import { monthGauge, monthNow, type MonthNow } from './objectives';
import type { ObjectiveParams } from './types';

const zero: MonthNow = { units: 0, speed: 1, income: 0, costs: 0, newRoutes: 0, closed: 0, needs: 0, supplied: 0 };
const now = (patch: Partial<MonthNow>): MonthNow => ({ ...zero, ...patch });
/** Числа ru-RU разделены неразрывным пробелом — в ожиданиях пишем обычный. */
const sp = (s: string | undefined) => s?.replace(/ /g, ' ');

describe('Шкала месячного задания — по показателю этого месяца, а не по числу месяцев', () => {
  it('новые маршруты: «312 / 470 ед.», доля — перевезённое к нужному', () => {
    const p: ObjectiveParams = { kind: 'newRoutes', amount: 470, since: 6, months: 1 };
    const g = monthGauge(p, now({ newRoutes: 312, units: 900 }))!;
    expect(g.text).toBe('312 / 470 ед.');
    expect(g.fraction).toBeCloseTo(312 / 470);
    expect(g.extra).toBeUndefined();
    // Больше нужного — полоска полная, подпись — как есть.
    expect(monthGauge(p, now({ newRoutes: 600 }))!.fraction).toBe(1);
    expect(monthGauge(p, now({ newRoutes: 600 }))!.text).toBe('600 / 470 ед.');
  });

  it('перевозить при расходах: объём на шкале, расходы — вторым условием с отметкой', () => {
    const p: ObjectiveParams = { kind: 'throughput', amount: 1330, costRatio: 0.72, months: 3 };
    const ok = monthGauge(p, now({ units: 665, income: 10000, costs: 5800 }))!;
    expect(sp(ok.text)).toBe('665 / 1 330 ед.');
    expect(ok.fraction).toBeCloseTo(0.5);
    expect(ok.extra).toEqual({ text: 'расходы 58% / 72%', ok: true });
    expect(monthGauge(p, now({ units: 665, income: 10000, costs: 8000 }))!.extra!.ok).toBe(false);
    // Выручки ещё нет — о расходах молчим.
    expect(monthGauge(p, now({}))!.extra).toBeUndefined();
  });

  it('быстрая доставка: надбавка на шкале, объём — вторым условием; доля — по тому, что дальше от цели', () => {
    const p: ObjectiveParams = { kind: 'quality', speed: 1.2, volume: 500, months: 2 };
    const g = monthGauge(p, now({ units: 400, speed: 1.15 }))!;
    expect(g.text).toBe('×1.15 / ×1.2');
    expect(g.extra).toEqual({ text: '400 / 500 ед.', ok: false });
    expect(g.fraction).toBeCloseTo(0.75);
    expect(monthGauge(p, now({ units: 100, speed: 1.2 }))!.fraction).toBeCloseTo(0.2);
  });

  it('прибыль: в минусе — пустая полоска и знак минус', () => {
    const p: ObjectiveParams = { kind: 'profit', amount: 29000, months: 1 };
    const gain = monthGauge(p, now({ income: 20000, costs: 5500 }))!;
    expect(gain.fraction).toBe(0.5);
    expect(sp(gain.text)).toBe('$14 500 / $29 000');
    const loss = monthGauge(p, now({ income: 1000, costs: 6000 }))!;
    expect(loss.fraction).toBe(0);
    expect(sp(loss.text)).toBe('−$5 000 / $29 000');
  });

  it('снабжение города: закрыто из нужных, доля — по привезённому', () => {
    const p: ObjectiveParams = { kind: 'supply', town: 1, months: 2, needs: 3 };
    expect(monthGauge(p, now({ closed: 1, needs: 3, supplied: 0.6 }))).toEqual({ fraction: 0.6, text: 'закрыто 1 / 3' });
  });

  it('накопительные задания — без месячной шкалы', () => {
    expect(monthGauge({ kind: 'passengers', amount: 100, towns: null }, now({ units: 50 }))).toBeNull();
    expect(monthGauge({ kind: 'industry', industry: 1, level: 2 }, zero)).toBeNull();
  });
});

describe('Показатели текущего месяца для шкалы', () => {
  const game = () => new Game({ ...DEFAULT_SETTINGS, seed: 42, scenario: { difficulty: 'normal', challenge: false } });

  it('перевезено и надбавка — из счётчиков идущего месяца, новые маршруты — только линии этапа', () => {
    const g = game();
    const s = g.scenario!.state;
    s.stats.units = 300;
    s.stats.speedSum = 330;
    const fake = (created: number | undefined, carriedMonth: number) =>
      ({ created, carriedMonth, carriedLast: 999 }) as unknown as ReturnType<typeof g.lines.get>;
    g.lines.set(9001, fake(5, 120)!);
    g.lines.set(9002, fake(1, 80)!);
    g.lines.set(9003, fake(undefined, 50)!);
    const n = monthNow(g, s, { kind: 'newRoutes', amount: 470, since: 3, months: 1 });
    expect(n.units).toBe(300);
    expect(n.speed).toBeCloseTo(1.1);
    expect(n.newRoutes).toBe(120);
  });

  it('снабжение: доля — по самым близким к норме потребностям', () => {
    const g = game();
    const t = g.towns.find((x) => x.demands.length >= 3)!;
    const [a, b, c] = t.demands;
    t.supplied = { [a]: TOWN_NEED, [b]: TOWN_NEED / 2, [c]: TOWN_NEED / 10 };
    const n = monthNow(g, g.scenario!.state, { kind: 'supply', town: t.id, months: 1, needs: 2 });
    expect(n.closed).toBe(1);
    expect(n.needs).toBe(2);
    expect(n.supplied).toBeCloseTo((1 + 0.5) / 2);
  });
});
