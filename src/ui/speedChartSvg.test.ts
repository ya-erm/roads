import { describe, expect, it } from 'vitest';
import { chartIndexAt, speedChart } from '../game/speedChart';
import { KMH_PER_UNIT } from '../world/roadTypes';
import { chartDistAt, chartHoverAt, chartX, distLabel, speedChartSvg, speedTicks, speedTipHtml, thinOut } from './speedChartSvg';

describe('Рисунок графика скорости', () => {
  it('подписи скорости — 2–4 штуки, расстояние — в метрах и километрах', () => {
    for (const max of [40, 60, 100, 140, 220]) {
      const t = speedTicks(max);
      expect(t.length).toBeGreaterThanOrEqual(2);
      expect(t.length).toBeLessThanOrEqual(4);
      expect(t[t.length - 1]).toBeLessThanOrEqual(max);
    }
    expect(distLabel(100)).toMatch(/^\d+ м$/);
    expect(distLabel(4000)).toMatch(/^\d+,\d км$/);
  });

  it('прореживание оставляет остановки и провалы скорости', () => {
    const v = Array.from({ length: 2000 }, (_, i) => (i === 777 ? 0 : i === 1333 ? 3 : 20));
    const keep = thinOut(v, 100);
    expect(keep.length).toBeLessThan(150);
    expect(keep).toContain(0);
    expect(keep).toContain(777);
    expect(keep).toContain(1333);
    expect(keep).toContain(1999);
  });

  it('у каждой остановки — номер, первая повторяется в конце круга', () => {
    const chart = speedChart([{ pieces: [{ length: 600, cap: 30, grade: 0 }] }, { pieces: [{ length: 400, cap: 30, grade: 0.05 }] }], {
      top: () => 40,
      accel: () => 4,
      decel: 8,
    })!;
    const svg = speedChartSvg(chart, '#3b7dd8', ['Вокзал', 'Рынок']);
    expect(svg.match(/<circle cx/g)).toHaveLength(3);
    expect(svg).toContain('#e3e8ee');
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('class="speed-cursor"');
    expect(svg).toContain('class="speed-dot"');
    // Системных подсказок нет — их заменяет своя (speedTipHtml), браузерная появляется с задержкой.
    expect(svg).not.toContain('<title');
    // Курсор у левого поля — начало круга, у правого края — конец; точка на рисунке — там же.
    expect(chartDistAt(chart, 0)).toBe(0);
    expect(chartDistAt(chart, 1)).toBeCloseTo(chart.length);
    const d = chartDistAt(chart, 0.5);
    expect(chartX(chart, d) / 360).toBeCloseTo(0.5);
  });

  it('подсказка под курсором — скорость и предел точки графика, у кружка — номер и название остановки', () => {
    const chart = speedChart([{ pieces: [{ length: 600, cap: 30, grade: 0 }] }, { pieces: [{ length: 400, cap: 30, grade: 0 }] }], {
      top: () => 40,
      accel: () => 4,
      decel: 8,
    })!;
    const names = ['Вокзал', 'Рынок'];
    // Середина первого перегона: машина идёт на пределе, остановки рядом нет.
    const fx = chartX(chart, 300) / 360;
    const mid = chartHoverAt(chart, fx);
    expect(mid.i).toBe(chartIndexAt(chart, chartDistAt(chart, fx)));
    expect(mid.d).toBeCloseTo(300, -1);
    expect(mid.x / 360).toBeCloseTo(fx, 2);
    expect(mid.kmh).toBe(Math.round(chart.v[mid.i] * KMH_PER_UNIT));
    expect(mid.kmh).toBe(Math.round(30 * KMH_PER_UNIT));
    expect(mid.capKmh).toBe(Math.round(30 * KMH_PER_UNIT));
    expect(mid.stop).toBe(-1);
    const tip = speedTipHtml(mid, names, '#3b7dd8');
    expect(tip).toContain(`<b>${mid.kmh} км/ч</b>`);
    expect(tip).toContain(`предел ${mid.capKmh}`);
    expect(tip).toContain(distLabel(mid.d));
    expect(tip).not.toContain('Вокзал');
    // У остановки машина стоит: точка — внизу графика, ниже точки на ходу; в подсказке — её номер и название.
    const atStop = chartHoverAt(chart, chartX(chart, 600) / 360);
    expect(atStop.kmh).toBe(0);
    expect(atStop.stop).toBe(1);
    expect(atStop.y).toBeGreaterThan(mid.y);
    expect(speedTipHtml(atStop, names, '#3b7dd8')).toContain('>2</i>Рынок');
    // Правый край — конец круга, снова первая остановка.
    const end = chartHoverAt(chart, 1);
    expect(end.stop).toBe(chart.stops.length - 1);
    expect(speedTipHtml(end, names, '#3b7dd8')).toContain('>1</i>Вокзал');
    // Левее поля с подписями — начало круга.
    expect(chartHoverAt(chart, 0).d).toBe(0);
  });
});
