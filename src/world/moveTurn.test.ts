import { describe, expect, it } from 'vitest';
import { snapTurn, streetBase, TURN_HANDLE_OFF, TURN_STEP, turnableBuilding, turnFromHandle, turnHandlePos, turnLabel, turnReach, turnText, wrapTurn } from './moveTurn';

const deg = (d: number) => (d * Math.PI) / 180;

describe('поворот при переносе (moveTurn)', () => {
  it('шаг 15°, угол — в (−180°, 180°], без поворота — ровно 0', () => {
    expect(TURN_STEP).toBeCloseTo(deg(15), 12);
    expect(snapTurn(deg(22))).toBeCloseTo(deg(15), 12);
    expect(snapTurn(deg(23))).toBeCloseTo(deg(30), 12);
    expect(wrapTurn(deg(270))).toBeCloseTo(deg(-90), 12);
    expect(wrapTurn(deg(-180))).toBeCloseTo(deg(180), 12);
    expect(Object.is(snapTurn(deg(-3)), 0)).toBe(true);
    expect(snapTurn(deg(360))).toBe(0);
  });

  it('подпись — стрелкой и градусами, R — значком', () => {
    expect(turnText(0)).toBe('');
    expect(turnText(deg(45))).toBe('↻ 45°');
    expect(turnText(deg(-30))).toBe('↺ 30°');
    expect(turnLabel(0, true)).toBe(' · R ↻');
    expect(turnLabel(deg(90), true)).toBe(' · ↻ 90° · R ↻');
    expect(turnLabel(deg(90), false)).toBe('');
  });

  it('без поворота лицо (−y) — к улице; ближний угол повёрнутого участка — на reach от середины', () => {
    // Улица на севере (−y), участок южнее: нормаль от улицы — +y, рисунок без поворота.
    expect(streetBase({ x: 0, y: 1 })).toBe(0);
    // Улица на востоке: нормаль −x — ось y рисунка смотрит на запад.
    const a = streetBase({ x: -1, y: 0 });
    expect(-Math.sin(a)).toBeCloseTo(-1, 12);
    expect(Math.cos(a)).toBeCloseTo(0, 12);
    expect(turnReach(60, 40, 0)).toBeCloseTo(20, 12);
    expect(turnReach(60, 40, deg(90))).toBeCloseTo(30, 12);
    expect(turnReach(60, 40, deg(45))).toBeCloseTo(50 * Math.SQRT1_2, 12);
    expect(turnReach(60, 40, deg(180))).toBeCloseTo(20, 12);
  });

  it('ручка — за дальним краем; тянут — угол рисунка от курсора шагом 15°', () => {
    const c = { x: 100, y: 50 };
    const h = turnHandlePos(c, 0, 20);
    expect(h.x).toBeCloseTo(100, 12);
    expect(h.y).toBeCloseTo(50 + 20 + TURN_HANDLE_OFF, 12);
    // Курсор там же, где ручка, — поворота нет; на востоке от середины — рисунок повёрнут на −90° (против часовой).
    expect(turnFromHandle(c, h, 0)).toBe(0);
    expect(turnFromHandle(c, { x: 200, y: 50 }, 0)).toBeCloseTo(deg(-90), 12);
    // Чуть мимо шага — к ближнему; от угла улицы base — поворот относительно неё.
    expect(turnFromHandle(c, { x: 100 - 30, y: 50 + 100 }, 0)).toBeCloseTo(deg(15), 12);
    expect(turnFromHandle(c, h, deg(30))).toBeCloseTo(deg(-30), 12);
    // Ручка с другой стороны рисунка (−y): курсор у неё — тоже без поворота.
    const back = turnHandlePos(c, deg(30), 20, -1);
    expect(turnFromHandle(c, back, deg(30), -1)).toBe(0);
  });

  it('поворачиваются ратуша и храм, дома — нет', () => {
    expect(turnableBuilding({ kind: 'landmark' })).toBe(true);
    expect(turnableBuilding({ kind: 'res' })).toBe(false);
    expect(turnableBuilding({ kind: 'com' })).toBe(false);
  });
});
