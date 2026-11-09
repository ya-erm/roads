import { describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { clearMax, crossTime, type PhaseState, reverseGreen, stepPhase } from './workSignals';

const R = CONSTRUCTION.rebuild.reverse;

describe('Светофоры реверса: фазы', () => {
  it('числа: проезд 250 м на 30 км/ч — ~18 с, зелёный ~19 с, очистка не дольше ~47 с; короткий участок — не меньше 10 с', () => {
    expect(crossTime(250)).toBeCloseTo(250 / (30 / 2.2), 6);
    expect(reverseGreen(250)).toBeCloseTo(R.base + R.perSec * crossTime(250), 6);
    expect(reverseGreen(250)).toBeGreaterThan(18);
    expect(reverseGreen(250)).toBeLessThan(20);
    expect(reverseGreen(20)).toBe(R.green[0]);
    expect(reverseGreen(5000)).toBe(R.green[1]);
    expect(clearMax(250)).toBeCloseTo(2 * crossTime(250) + 10, 6);
  });

  it('зелёный держится, пока с другой стороны никого; ждут — по истечении зелёного очистка, потом им', () => {
    const s: PhaseState = { go: 1, next: 1, t: 0 };
    const len = 250;
    let waiting = 0;
    let inside = 0;
    const step = (sec: number) => {
      for (let t = 0; t < sec; t += 0.1) stepPhase(s, 0.1, len, (f) => (f === -1 ? waiting : 3), () => inside);
    };
    step(60);
    expect(s.go).toBe(1);
    // С другой стороны подъехали — зелёный дорабатывает своё и гаснет.
    waiting = 2;
    s.t = 0;
    step(R.minGreen + 0.5);
    expect(s.go).toBe(1);
    // Очистка: на участке ещё едут пустившиеся на зелёный — красный обеим.
    inside = 1;
    step(reverseGreen(len));
    expect(s.go).toBe(0);
    step(5);
    expect(s.go).toBe(0);
    inside = 0;
    step(R.allRed + 0.2);
    expect(s.go).toBe(-1);
  });

  it('своя сторона опустела — переключается раньше; застрявшая машина не держит очистку дольше clearMax', () => {
    const s: PhaseState = { go: -1, next: -1, t: 0 };
    const len = 100;
    stepPhase(s, R.minGreen + 0.1, len, (f) => (f === 1 ? 1 : 0), () => 0);
    expect(s.go).toBe(0);
    expect(s.next).toBe(1);
    // Не видно, есть ли очередь (null) — считается, что есть: работает по времени.
    const blind: PhaseState = { go: 1, next: 1, t: 0 };
    stepPhase(blind, reverseGreen(len) + 0.1, len, () => null, () => 0);
    expect(blind.go).toBe(0);
    for (let t = 0; t < clearMax(len) + 0.2; t += 0.5) stepPhase(blind, 0.5, len, () => null, () => 1);
    expect(blind.go).toBe(-1);
  });
});
