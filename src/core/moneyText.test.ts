import { describe, expect, it } from 'vitest';
import { money } from './moneyText';

const nbsp = (s: string) => s.replace(/\s/g, ' ');

describe('money', () => {
  it('пишет доллары с разрядами', () => {
    expect(nbsp(money(12_345))).toBe('$12 345');
    expect(money(0)).toBe('$0');
  });

  it('в минусе — «−$», а не «$-»', () => {
    expect(nbsp(money(-958_580))).toBe('−$958 580');
    expect(money(-958_580)).not.toContain('-');
  });

  it('округляет до доллара; почти ноль в минусе — без знака', () => {
    expect(money(12.6)).toBe('$13');
    expect(money(-0.4)).toBe('$0');
    expect(money(-1.6)).toBe('−$2');
  });
});
