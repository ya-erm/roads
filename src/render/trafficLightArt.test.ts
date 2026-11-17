import { describe, expect, it } from 'vitest';
import { LAMP_X, lampOf, lightScale } from './trafficLightArt';

describe('Светофор на карте', () => {
  it('сигнал секции: разрешено — зелёный, пока фаза меняется — жёлтый, нет — красный', () => {
    expect(lampOf(true, false)).toBe('green');
    expect(lampOf(true, true)).toBe('yellow');
    expect(lampOf(false, false)).toBe('red');
    expect(lampOf(undefined, true)).toBe('red');
  });

  it('вблизи — в 1,3 своего размера, издали крупнее, но не больше чем в 3 раза', () => {
    expect(lightScale(9)).toBe(1.3);
    expect(lightScale(2)).toBe(1.3);
    expect(lightScale(1.2)).toBeCloseTo(2);
    expect(lightScale(0.4)).toBe(3);
    // Корпус (4,8 м) на экране с отдалением не исчезает: до самого порога (зум 0,4) — не короче 5,7 пикселя.
    for (const z of [0.4, 0.6, 1, 1.5, 3]) expect(4.8 * lightScale(z) * z).toBeGreaterThanOrEqual(5.7);
  });

  it('красная — у стоп-линии, зелёная — дальше всех навстречу машинам', () => {
    expect(LAMP_X.red).toBeLessThan(0);
    expect(LAMP_X.red).toBeGreaterThan(LAMP_X.yellow);
    expect(LAMP_X.yellow).toBeGreaterThan(LAMP_X.green);
  });
});
