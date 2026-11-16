import { describe, expect, it } from 'vitest';
import type { TownPark } from '../world/entities';
import { parkMoveHtml } from './parkCard';

const park = (kind: TownPark['kind'], w: number, h: number): TownPark => ({ id: 101, kind, fp: { center: { x: 0, y: 0 }, w, h, angle: 0 } });

describe('«Перенести» в карточке парка', () => {
  it('цена — от площади участка, подсказка — data-tip значками', () => {
    const square = parkMoveHtml(park('square', 51.2, 38.4));
    expect(square).toContain('data-action="park-move"');
    // Тысячи — через неразрывный пробел (core/moneyText).
    expect(square).toMatch(/\$1\s180/);
    expect(square).toContain('data-tip="🌳⛲🪑');
    expect(square).not.toContain('title=');
    expect(parkMoveHtml(park('park', 137.6, 99.2))).toMatch(/\$8\s190/);
    // Крошечный сквер — не дешевле $1 000.
    expect(parkMoveHtml(park('memorial', 20, 15))).toMatch(/\$1\s000/);
  });

  it('набережную не перенести: она у воды', () => {
    expect(parkMoveHtml(park('embankment', 54, 13))).toBe('');
  });
});
