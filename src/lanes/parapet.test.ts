import { describe, expect, it } from 'vitest';
import { PARAPET, parapetLine, parapetWidth } from './parapet';

describe('ограждение моста', () => {
  it('вблизи — тонкая стенка в метрах, при отдалении — не тоньше minPx пикселей', () => {
    expect(parapetWidth(3)).toBe(PARAPET.width);
    expect(parapetWidth(1)).toBe(PARAPET.width);
    for (const zoom of [3, 1, 0.5, 0.2, 0.08]) expect(parapetWidth(zoom) * zoom).toBeGreaterThanOrEqual(PARAPET.minPx - 1e-9);
    // Уже прежних 3,2 м — грузовик на мосту не упирается в стенки.
    expect(PARAPET.width).toBeLessThan(3.2);
  });

  it('стенка снаружи асфальта: внутренний край — ровно по кромке, на полосы не заходит', () => {
    // Полотно вдоль x: левая кромка y = −5, правая y = +5.
    const left = [0, 10, 20].map((x) => ({ x, y: -5 }));
    const right = [0, 10, 20].map((x) => ({ x, y: 5 }));
    const w = parapetWidth(2);
    const l = parapetLine(left, right, w / 2);
    const r = parapetLine(right, left, w / 2);
    for (const p of l) {
      expect(p.y).toBeCloseTo(-5 - w / 2, 9);
      expect(p.y + w / 2).toBeCloseTo(-5, 9);
    }
    for (const p of r) expect(p.y - w / 2).toBeCloseTo(5, 9);
    expect(l.map((p) => p.x)).toEqual([0, 10, 20]);
  });

  it('на повороте сдвиг — поперёк полотна, от другой кромки', () => {
    const edge = [{ x: 3, y: 4 }];
    const other = [{ x: 0, y: 0 }];
    const [p] = parapetLine(edge, other, 1);
    expect(p.x).toBeCloseTo(3.6, 9);
    expect(p.y).toBeCloseTo(4.8, 9);
  });
});
