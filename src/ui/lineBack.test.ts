import { describe, expect, it } from 'vitest';
import { lineBackFrom, lineCloseTarget } from './lineBack';

const towns = [{ id: 1 }, { id: 2 }];

describe('Крестик карточки маршрута', () => {
  it('маршрут открыт из панели города — крестик возвращает к этому городу', () => {
    const back = lineBackFrom({ type: 'town', id: 2 }, 7);
    expect(back).toEqual({ line: 7, town: 2 });
    expect(lineCloseTarget(back, 7, towns)).toEqual({ type: 'town', id: 2 });
  });

  it('маршрут открыт из общего списка, станции или предприятия — крестик просто закрывает карточку', () => {
    for (const sel of [null, { type: 'station', id: 1 }, { type: 'industry', id: 1 }] as const) {
      const back = lineBackFrom(sel, 7);
      expect(back).toBeNull();
      expect(lineCloseTarget(back, 7, towns)).toBeNull();
    }
  });

  it('открыта уже другая карточка или города больше нет — возвращаться некуда', () => {
    const back = lineBackFrom({ type: 'town', id: 1 }, 7);
    expect(lineCloseTarget(back, 8, towns)).toBeNull();
    expect(lineCloseTarget(back, null, towns)).toBeNull();
    expect(lineCloseTarget(back, 7, [{ id: 2 }])).toBeNull();
  });
});
