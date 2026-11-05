import { describe, expect, it } from 'vitest';
import { fleetBar, fleetBarRoom } from './fleetBar';

describe('fleetBar', () => {
  it('помещается — рисует все, без «+N»', () => {
    expect(fleetBar(3, 10, 12)).toEqual({ shown: 10, more: 0 });
    expect(fleetBar(12, 12, 12)).toEqual({ shown: 12, more: 0 });
  });

  it('не помещается — рисует сколько влезет, остальное в «+N»', () => {
    expect(fleetBar(28, 30, 12)).toEqual({ shown: 11, more: 19 });
  });

  it('машин на маршруте больше предела — считает по ним', () => {
    expect(fleetBar(20, 5, 12)).toEqual({ shown: 11, more: 9 });
  });

  it('значки-флаги отнимают место', () => {
    expect(fleetBar(1, 12, 12, 1)).toEqual({ shown: 10, more: 2 });
    expect(fleetBar(1, 10, 12, 2)).toEqual({ shown: 10, more: 0 });
  });

  it('видимые и скрытые в сумме — весь парк, и в ряд помещаются', () => {
    for (let max = 1; max <= 50; max++) {
      const flags = max % 3;
      const { shown, more } = fleetBar(0, max, 12, flags);
      expect(shown + more).toBe(max);
      expect(shown + flags + (more ? 1 : 0)).toBeLessThanOrEqual(12);
    }
  });
});

describe('fleetBarRoom', () => {
  it('шире панель — больше мест', () => {
    expect(fleetBarRoom(340)).toBe(12);
    expect(fleetBarRoom(465)).toBe(18);
  });

  it('панель ещё не показана — запасное число', () => {
    expect(fleetBarRoom(0)).toBe(12);
  });
});
