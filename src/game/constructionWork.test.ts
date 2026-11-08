import { describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { splitBuild } from '../lanes/edit';
import { advanceStages, convoyGap, paidFor, type Spans, spansOf, stageLayout, stageSeconds, stageSpans, stageWork } from './constructionWork';

describe('Этапы участка — каждый своим ходом', () => {
  const L = 300;
  const g = convoyGap(L);

  it('этап, чья машина не на месте, стоит; покрытие — не ближе интервала колонны к отсыпке, разметка — к покрытию', () => {
    // Доехала только машина отсыпки: отсыпка идёт, покрытие и разметка стоят.
    let s: Spans = [0, 0, 0];
    s = advanceStages(s, L, [10, 0, 0], 5).spans;
    expect(s).toEqual([50, 0, 0]);
    // Доехала машина покрытия, а отсыпка ещё не ушла на интервал: покрытие ждёт.
    s = advanceStages([30, 0, 0], L, [0, 10, 0], 1).spans;
    expect(s).toEqual([30, 0, 0]);
    // Ушла — покрытие идёт за ней с отставанием, не ближе интервала.
    s = advanceStages([50, 0, 0], L, [10, 10, 0], 1).spans;
    expect(s[0]).toBe(60);
    expect(s[1]).toBe(10);
    s = advanceStages([60, 10, 0], L, [10, 30, 0], 1).spans;
    expect(s[1]).toBe(70 - g);
    // Машины отсыпки нет (уехала, не доехала) — покрытие упирается в неё и стоит, но назад не идёт.
    s = advanceStages([120, 120 - g, 0], L, [0, 10, 10], 3).spans;
    expect(s).toEqual([120, 120 - g, 30]);
    // В конце участка разрыв сходится к нулю: отсыпка дошла до конца — покрытие и разметка догоняют до конца.
    s = advanceStages([L, L - g, L - 2 * g], L, [10, 10, 10], 100).spans;
    expect(s).toEqual([L, L, L]);
  });

  it('участок кончился посреди такта — сколько времени ушло (остаток — следующему участку)', () => {
    const r = advanceStages([L, L, L - 5], L, [10, 10, 10], 2);
    expect(r.spans).toEqual([L, L, L]);
    expect(r.used).toBeCloseTo(0.5, 9);
    // Не кончился — всё время ушло, даже если этапы ждали.
    expect(advanceStages([10, 0, 0], L, [0, 10, 10], 2).used).toBe(2);
  });

  it('деньги — те же: за метр — та же цена, за участок — та же сумма при любом порядке, в каком доезжали машины', () => {
    const full = 4321;
    const w = CONSTRUCTION.stages;
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    // Машины доезжают по одной (отсыпка, через 7 с покрытие, через 15 с разметка), такт — 0,1 с.
    for (const arrive of [
      [0, 7, 15],
      [0, 0, 0],
      [0, 30, 31],
    ]) {
      let s: Spans = [0, 0, 0];
      let done = 0;
      let paid = 0;
      for (let t = 0; t < 400 && done < L; t += 0.1) {
        const speed = arrive.map((a) => (t >= a ? 11 : 0));
        s = advanceStages(s, L, speed, 0.1).spans;
        const next = s[2] >= L - 1e-6 ? L : Math.max(done, stageWork(s, L));
        paid += paidFor(full, next, L) - paidFor(full, done, L);
        done = next;
      }
      expect(done).toBe(L);
      expect(paid).toBe(full);
    }
  });

  it('сколько ещё строить: разметка кончает на два интервала колонны позже отсыпки', () => {
    expect(stageSeconds([0, 0, 0], L, 10)).toBeCloseTo((L + 2 * g) / 10, 9);
    expect(stageSeconds([L, L - g, L - 2 * g], L, 10)).toBeCloseTo((2 * g) / 10, 9);
    expect(stageSeconds([L, L, L], L, 10)).toBe(0);
    // Проверка шагами: все машины на месте — участок готов ровно к этому сроку.
    let s: Spans = [100, 100 - g, 20];
    const want = stageSeconds(s, L, 10);
    let t = 0;
    for (; s[2] < L - 1e-6 && t < 100; t += 0.01) s = advanceStages(s, L, [10, 10, 10], 0.01).spans;
    expect(t).toBeCloseTo(want, 1);
  });

  it('старое сохранение (одно done): этапы — колонной из него, работа по ним — то же done', () => {
    for (const done of [0, 5, 40, 77.7, 150, 250, 299.9, L]) {
      const sp = spansOf({ project: 1, done }, L);
      expect(sp).toEqual(stageSpans(done, L));
      expect(stageWork(sp, L)).toBeCloseTo(done, 6);
    }
    // Свои этапы — как есть.
    expect(spansOf({ project: 1, done: 30, stages: [60, 10, 0] }, L)).toEqual([60, 10, 0]);
    // Испорченные — как в старом сохранении.
    expect(spansOf({ project: 1, done: 30, stages: [Number.NaN, 1, 2] }, L)).toEqual(stageSpans(30, L));
  });

  it('разрез участка делит каждый этап по месту разреза; готовое кусков в сумме — то же', () => {
    const b = { project: 3, done: 0.45 * 200 + 0.4 * 160 + 0.15 * 30, stages: [200, 160, 30] as Spans };
    const [p, q] = splitBuild(b, L, 100);
    expect(p.stages).toEqual([100, 100, 30]);
    expect(q.stages).toEqual([100, 60, 0]);
    expect(p.done + q.done).toBeCloseTo(b.done, 9);
    const [x, y] = splitBuild({ ...b, fromB: true }, L, 100);
    // От конца b: сначала второй кусок (200 м), потом первый.
    expect(y.stages).toEqual([200, 160, 30]);
    expect(x.stages).toEqual([0, 0, 0]);
    expect(x.done + y.done).toBeCloseTo(b.done, 9);
  });
});

describe('Стройка на карте: где рисовать отсыпку и когда этап доходит до площадки узла', () => {
  const L = 280;

  it('отсыпка — только по своему у полотна, не по площадке перекрёстка', () => {
    // Примыкание к готовой дороге у конца a: площадка — первые 38 м.
    expect(stageLayout([20, 0, 0], L, false, 38, 0).earth).toBeNull();
    expect(stageLayout([120, 80, 40], L, false, 38, 0).earth).toEqual([38, 120]);
    // Стройка от конца b к перекрёстку у a: отсыпка доходит до площадки и не заходит на неё.
    expect(stageLayout([L, L - 40, L - 80], L, true, 38, 0).earth).toEqual([38, L]);
    expect(stageLayout([100, 60, 20], L, true, 38, 0).earth).toEqual([L - 100, L]);
    // Без перекрёстков — как раньше, от начала заполнения.
    expect(stageLayout([50, 10, 0], L, false, 0, 0).earth).toEqual([0, 50]);
    expect(stageLayout([0, 0, 0], L, false, 0, 0).earth).toBeNull();
  });

  it('у начала заполнения этап на площадке — как только начат, у дальнего конца — когда дошёл до неё', () => {
    expect(stageLayout([0, 0, 0], L, false, 38, 20).reach).toEqual({ a: -1, b: -1 });
    expect(stageLayout([10, 0, 0], L, false, 38, 20).reach).toEqual({ a: 0, b: -1 });
    expect(stageLayout([60, 20, 0], L, false, 38, 20).reach).toEqual({ a: 1, b: -1 });
    expect(stageLayout([100, 60, 20], L, false, 38, 20).reach).toEqual({ a: 2, b: -1 });
    // Отсыпка дошла до площадки у b (L − 20), покрытие — ещё нет.
    expect(stageLayout([L - 20, L - 60, L - 100], L, false, 38, 20).reach).toEqual({ a: 2, b: 0 });
    expect(stageLayout([L, L, L], L, false, 38, 20).reach).toEqual({ a: 2, b: 2 });
    // От конца b — зеркально: начало — у b, дальний конец — a со своей площадкой.
    expect(stageLayout([10, 0, 0], L, true, 38, 20).reach).toEqual({ a: -1, b: 0 });
    expect(stageLayout([L - 38, L - 78, L - 118], L, true, 38, 20).reach).toEqual({ a: 0, b: 2 });
  });
});
