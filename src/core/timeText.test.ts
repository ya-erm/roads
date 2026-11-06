import { describe, expect, it } from 'vitest';
import { clockText, durationText, leftText } from './timeText';

describe('время минутами и секундами', () => {
  it('«м:сс»: секунды — двумя цифрами, с округлением', () => {
    expect(clockText(200)).toBe('3:20');
    expect(clockText(60)).toBe('1:00');
    expect(clockText(5)).toBe('0:05');
    expect(clockText(59.4)).toBe('0:59');
    expect(clockText(59.6)).toBe('1:00');
  });

  it('час и больше — тоже минутами; меньше нуля и не число — «0:00»', () => {
    expect(clockText(3725)).toBe('62:05');
    expect(clockText(-3)).toBe('0:00');
    expect(clockText(Number.NaN)).toBe('0:00');
  });

  it('сколько осталось до срока — целыми минутами с округлением вверх: только что выданное на 5 минут — «5 мин»', () => {
    expect(leftText(300)).toBe('5 мин');
    expect(leftText(299.97)).toBe('5 мин');
    expect(leftText(241)).toBe('5 мин');
    expect(leftText(240)).toBe('4 мин');
    expect(leftText(600)).toBe('10 мин');
    expect(leftText(61)).toBe('2 мин');
    expect(leftText(60)).toBe('1 мин');
  });

  it('последнюю минуту — секундами: «59 сек», «58 сек»…; прошло — «0 сек»', () => {
    expect(leftText(59.4)).toBe('59 сек');
    expect(leftText(58)).toBe('58 сек');
    expect(leftText(0.2)).toBe('1 сек');
    expect(leftText(0)).toBe('0 сек');
    expect(leftText(-5)).toBe('0 сек');
    // Секунды не показываются, пока минут больше одной: ни «м:сс», ни «сек».
    for (const s of [61, 125, 299, 3725]) expect(leftText(s)).toMatch(/^\d+ мин$/);
  });

  it('срок: целые минуты — «N мин», меньше минуты — секундами, остальное — «м:сс»', () => {
    expect(durationText(120)).toBe('2 мин');
    expect(durationText(600)).toBe('10 мин');
    expect(durationText(45)).toBe('45 с');
    expect(durationText(90)).toBe('1:30');
    expect(durationText(0)).toBe('0 с');
  });
});
