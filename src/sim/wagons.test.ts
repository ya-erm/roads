import { describe, expect, it } from 'vitest';
import { stepWagons, trainWagonFills, WAGON_RATE, WagonLook, wagonFills } from './wagons';

/** Гоняет анимацию секунд seconds шагами по 0.05 с; each — после каждого шага. */
function run(look: WagonLook, target: number, color: string | undefined, capacity: number, seconds: number, each?: () => void) {
  for (let t = 0; t < seconds - 1e-9; t += 0.05) {
    stepWagons(look, target, color, capacity, 0.05);
    each?.();
  }
}

/** Доли по вагонам с точностью до 1e-6. */
function near(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((f, i) => expect(f).toBeCloseTo(expected[i], 6));
}

describe('Заполненность вагонов', () => {
  it('груз занимает вагоны по порядку от головы', () => {
    expect(wagonFills(60, 120, 4)).toEqual([1, 1, 0, 0]);
    expect(wagonFills(120, 120, 4)).toEqual([1, 1, 1, 1]);
    expect(wagonFills(0, 120, 4)).toEqual([0, 0, 0, 0]);
    const part = wagonFills(70, 120, 4);
    expect(part.slice(0, 2)).toEqual([1, 1]);
    expect(part[2]).toBeCloseTo(1 / 3, 6);
    expect(part[3]).toBe(0);
    // Доли вместимости, как их хранит поезд: половина пяти вагонов — два с половиной.
    near(wagonFills(0.5, 1, 5), [1, 1, 0.5, 0, 0]);
  });

  it('пограничные случаи: перегруз, без вагонов, нулевая вместимость, погрешность', () => {
    expect(wagonFills(500, 120, 3)).toEqual([1, 1, 1]);
    expect(wagonFills(-5, 120, 3)).toEqual([0, 0, 0]);
    expect(wagonFills(50, 120, 0)).toEqual([]);
    expect(wagonFills(50, 0, 2)).toEqual([0, 0]);
    // 0.6 из 1 на 5 вагонов — ровно три полных, без «почти полного» четвёртого и щёлочки в третьем.
    expect(wagonFills(0.6, 1, 5)).toEqual([1, 1, 1, 0, 0]);
  });
});

describe('Анимация погрузки по вагонам', () => {
  it('первый показ — сразу как есть, в пути (dt = Infinity) — тоже', () => {
    const look: WagonLook = {};
    stepWagons(look, 0.5, '#coal', 120, 0.05);
    expect(look).toEqual({ fill: 0.5, load: '#coal' });
    look.dip = 0.1;
    stepWagons(look, 1, '#coal', 120, Infinity);
    expect(look).toEqual({ fill: 1, load: '#coal' });
  });

  it('погрузка идёт в темпе стоянки, вагоны наполняются по очереди', () => {
    const look: WagonLook = { fill: 0 };
    const cap = 120;
    // Каждый шаг — не больше одного недогруженного вагона, и он не отступает назад.
    let current = 0;
    run(look, 0.5, '#coal', cap, 3, () => {
      const fills = wagonFills(look.fill!, 1, 4);
      const partial = fills.map((f, i) => (f > 0 && f < 1 ? i : -1)).filter((i) => i >= 0);
      expect(partial.length).toBeLessThanOrEqual(1);
      if (partial.length) {
        expect(partial[0]).toBeGreaterThanOrEqual(current);
        current = partial[0];
      }
    });
    // За 3 с — 30 единиц из 120: ровно первый вагон из четырёх.
    expect(look.fill).toBeCloseTo((WAGON_RATE * 3) / cap, 6);
    expect(wagonFills(look.fill!, 1, 4)).toEqual([1, 0, 0, 0]);
    expect(look.load).toBe('#coal');
    run(look, 0.5, '#coal', cap, 10);
    // Догрузились до половины и стоят: 60/120 — первые два вагона из четырёх.
    expect(look.fill).toBe(0.5);
    expect(wagonFills(look.fill!, 1, 4)).toEqual([1, 1, 0, 0]);
  });

  it('выгрузка: вагоны пустеют с хвоста к голове, пустой поезд — без цвета груза', () => {
    const look: WagonLook = { fill: 0.75, load: '#coal' };
    run(look, 0, undefined, 120, 1.5);
    // 15 из 90 выгружено: третий вагон из четырёх наполовину, хвостовой уже пуст.
    const fills = wagonFills(look.fill!, 1, 4);
    expect(fills[0]).toBe(1);
    expect(fills[1]).toBe(1);
    expect(fills[2]).toBeCloseTo(0.5, 6);
    expect(fills[3]).toBe(0);
    expect(look.load).toBe('#coal');
    run(look, 0, undefined, 120, 8);
    expect(look.fill).toBe(0);
    expect(look.load).toBeUndefined();
  });

  it('другой груз: старый выгружается целиком, потом грузится новый своим цветом', () => {
    const look: WagonLook = { fill: 0.5, load: '#coal' };
    const seen: [number, string | undefined][] = [];
    run(look, 0.25, '#goods', 120, 10, () => seen.push([look.fill!, look.load]));
    // Пока уголь не выгружен — вагоны угольные и только пустеют.
    const switchAt = seen.findIndex(([, c]) => c === '#goods');
    expect(switchAt).toBeGreaterThan(0);
    for (let i = 1; i < switchAt; i++) expect(seen[i][0]).toBeLessThanOrEqual(seen[i - 1][0]);
    expect(seen[switchAt - 1][1]).toBe('#coal');
    // Дальше — товары от пустого до четверти.
    for (let i = switchAt + 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThanOrEqual(seen[i - 1][0]);
    expect(look).toEqual({ fill: 0.25, load: '#goods' });
  });

  it('пассажиры: сначала выходят до dip, потом садятся новые', () => {
    const look: WagonLook = { fill: 0.8, dip: 0.2 };
    const seen: number[] = [];
    run(look, 0.6, undefined, 100, 12, () => seen.push(look.fill!));
    const low = Math.min(...seen);
    expect(low).toBeCloseTo(0.2, 6);
    const at = seen.indexOf(low);
    // До дна — только убывает, после — только растёт, до 60%.
    for (let i = 1; i <= at; i++) expect(seen[i]).toBeLessThanOrEqual(seen[i - 1]);
    for (let i = at + 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(look.fill).toBeCloseTo(0.6, 6);
    expect(look.dip).toBeUndefined();
    // 60 вышли и 40 сели — 100 единиц, 10 с при 10 в секунду: как и стоянка.
    const doneAt = seen.findIndex((f, i) => i > at && Math.abs(f - 0.6) < 1e-9);
    expect(doneAt * 0.05 + 0.05).toBeCloseTo(100 / WAGON_RATE, 1);
  });

  it('dip выше текущего вида — просто снимается', () => {
    const look: WagonLook = { fill: 0.1, dip: 0.4 };
    stepWagons(look, 0.3, undefined, 100, 0.05);
    expect(look.dip).toBeUndefined();
    expect(look.fill).toBeCloseTo(0.1 + (WAGON_RATE * 0.05) / 100, 9);
  });

  it('несколько потоков: вид догоняет во столько раз быстрее, один поток — как раньше', () => {
    const one: WagonLook = { fill: 0 };
    const four: WagonLook = { fill: 0 };
    stepWagons(one, 1, undefined, 180, 1);
    stepWagons(four, 1, undefined, 180, 1, 4);
    expect(one.fill).toBeCloseTo(WAGON_RATE / 180, 9);
    expect(four.fill).toBeCloseTo((4 * WAGON_RATE) / 180, 9);
    // 180 вышли и 180 сели через 4 вагона — 9 с вместо 36.
    const look: WagonLook = { fill: 1, dip: 0 };
    const step = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / 0.05); i++) stepWagons(look, 1, undefined, 180, 0.05, 4);
    };
    step(4.5);
    expect(look.fill).toBeCloseTo(0, 6);
    step(4.5);
    expect(look.fill).toBeCloseTo(1, 6);
    expect(look.dip).toBeUndefined();
  });
});

describe('Вагоны поезда по виду состава', () => {
  it('груз — по порядку от головы, пассажиры — во всех вагонах поровну', () => {
    expect(trainWagonFills(0.5, 4, 'freight')).toEqual([1, 1, 0, 0]);
    expect(trainWagonFills(0.5, 4, 'passenger')).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(trainWagonFills(1, 3, 'passenger')).toEqual([1, 1, 1]);
    expect(trainWagonFills(0, 3, 'passenger')).toEqual([0, 0, 0]);
    // Погрешность и выход за пределы — как у груза: без щёлочек и перегруза.
    expect(trainWagonFills(1 - 1e-9, 2, 'passenger')).toEqual([1, 1]);
    expect(trainWagonFills(1e-9, 2, 'passenger')).toEqual([0, 0]);
    expect(trainWagonFills(1.4, 2, 'passenger')).toEqual([1, 1]);
    expect(trainWagonFills(Number.NaN, 2, 'passenger')).toEqual([0, 0]);
    expect(trainWagonFills(0.5, 0, 'passenger')).toEqual([]);
  });
});
