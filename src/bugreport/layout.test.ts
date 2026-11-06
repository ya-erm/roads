import { describe, expect, it } from 'vitest';
import { BUG_BUTTON, bugButtonSpot, type Rect } from './layout';
import { constrain } from './marks';

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom, width: right - left });

describe('Кнопка баг-репорта: место', () => {
  const view = { w: 1440, h: 900 };
  // Миникарта 212×160 в правом нижнем углу (14 px от краёв).
  const minimap = rect(1214, 726, 1426, 886);

  it('слева от миникарты, низом по её низу', () => {
    expect(bugButtonSpot(view, minimap, rect(365, 816, 1075, 886))).toEqual({ right: 234, bottom: 14 });
  });

  it('узкое окно: панель инструментов дошла до кнопки — кнопка над ней, всё так же у миникарты', () => {
    const narrow = { w: 1200, h: 900 };
    const mm = rect(974, 726, 1186, 886);
    const toolbar = rect(245, 816, 955, 886);
    const spot = bugButtonSpot(narrow, mm, toolbar);
    expect(spot.right).toBe(234);
    expect(spot.bottom).toBe(900 - 816 + BUG_BUTTON.gap);
    // Кнопка левее миникарты и не заходит на панель.
    const left = narrow.w - spot.right - BUG_BUTTON.size;
    expect(left + BUG_BUTTON.size).toBeLessThanOrEqual(mm.left);
  });

  it('панель инструментов в нескольких пикселях — кнопка остаётся внизу', () => {
    const view1280 = { w: 1280, h: 800 };
    const mm = rect(1054, 640, 1266, 786);
    expect(bugButtonSpot(view1280, mm, rect(285, 716, 995, 786))).toEqual({ right: 234, bottom: 14 });
  });

  it('без миникарты — запасное место из CSS', () => {
    expect(bugButtonSpot(view, null, null)).toEqual(BUG_BUTTON.fallback);
    expect(bugButtonSpot(view, rect(0, 0, 0, 0), null)).toEqual(BUG_BUTTON.fallback);
  });
});

describe('Shift при рисовании', () => {
  it('линия — с шагом 45°, той же длины', () => {
    const p = constrain('line', { x: 0, y: 0 }, { x: 100, y: 10 });
    expect(p.x).toBeCloseTo(Math.hypot(100, 10));
    expect(p.y).toBeCloseTo(0);
    const d = constrain('arrow', { x: 0, y: 0 }, { x: 50, y: 60 });
    expect(d.x).toBeCloseTo(d.y);
  });

  it('прямоугольник и овал — квадратом в сторону курсора', () => {
    expect(constrain('rect', { x: 10, y: 10 }, { x: 40, y: -5 })).toEqual({ x: 40, y: -20 });
    expect(constrain('ellipse', { x: 0, y: 0 }, { x: -5, y: 20 })).toEqual({ x: -20, y: 20 });
  });
});
