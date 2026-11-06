import { describe, expect, it } from 'vitest';
import { travelTimeText } from './travelTime';

describe('время в пути', () => {
  it('минутами и секундами, как сроки заданий', () => {
    expect(travelTimeText(96)).toBe('1:36');
    expect(travelTimeText(128.6)).toBe('2:09');
    expect(travelTimeText(5)).toBe('0:05');
  });

  it('долгий круг — тоже минутами, без часов', () => {
    expect(travelTimeText(744)).toBe('12:24');
    expect(travelTimeText(3725)).toBe('62:05');
  });
});
