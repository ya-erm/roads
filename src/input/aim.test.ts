import { describe, expect, it } from 'vitest';
import { aimAlong } from './aim';

const O = { x: 100, y: 100 };
const EAST = { x: 1, y: 0 };

describe('aimAlong: прилипание конца к «прямо» и 90°', () => {
  it('почти по направлению — ровно «прямо», длина — проекция на него', () => {
    const aim = aimAlong(O, { x: 300, y: 110 }, [EAST]);
    expect(aim?.hint).toBe('прямо');
    expect(aim!.pos.x).toBeCloseTo(300, 6);
    expect(aim!.pos.y).toBeCloseTo(100, 6);
  });

  it('почти поперёк — ровно 90° в обе стороны', () => {
    const down = aimAlong(O, { x: 108, y: 300 }, [EAST]);
    expect(down?.hint).toBe('90°');
    expect(down!.pos.x).toBeCloseTo(100, 6);
    const up = aimAlong(O, { x: 92, y: -100 }, [EAST]);
    expect(up?.hint).toBe('90°');
    expect(up!.pos.x).toBeCloseTo(100, 6);
  });

  it('далеко от направлений, слишком близко к началу или без направлений — не прилипает', () => {
    expect(aimAlong(O, { x: 300, y: 200 }, [EAST])).toBeNull();
    expect(aimAlong(O, { x: 115, y: 101 }, [EAST])).toBeNull();
    expect(aimAlong(O, { x: 300, y: 101 }, [])).toBeNull();
  });

  it('из нескольких направлений — ближайшее к курсору', () => {
    const diag = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    const aim = aimAlong(O, { x: 300, y: 290 }, [EAST, diag]);
    expect(aim?.hint).toBe('прямо');
    expect(aim!.pos.x - O.x).toBeCloseTo(aim!.pos.y - O.y, 6);
  });
});
