import { describe, expect, it } from 'vitest';
import type { Station } from '../world/entities';
import { IndustryHaul } from './industryHaul';

describe('Перегрузка у предприятия', () => {
  it('отвозит камень и параллельно привозит кирпичи несколькими машинами', () => {
    const yard = new IndustryHaul();
    const st = { kind: 'road', industryId: 1, industryAccess: true, cargo: { construction: 18 } } as Station;
    yard.record(st, 'stone', 'in', 12, 0);
    yard.record(st, 'construction', 'out', 18, 1);
    expect(yard.view(st, 1)?.trips[0]).toMatchObject({ cargo: 'stone', phase: 'loading' });
    expect(yard.view(st, 1)?.incoming.stone).toBeLessThan(12);
    expect(yard.view(st, 5)?.trips).toMatchObject([{ cargo: 'stone', phase: 'carrying' }, { cargo: 'construction', phase: 'carrying' }]);
    expect(yard.view(st, 9)?.trips).toHaveLength(3);
    expect(yard.view(st, 10)?.trips[0]).toMatchObject({ cargo: 'stone', phase: 'unloading' });
    expect(yard.view(st, 15)?.trips[0]).toMatchObject({ cargo: 'stone', phase: 'returning', fill: 0 });
    expect(yard.view(st, 15)?.outgoing.construction).toBeLessThan(18);
    expect(yard.view(st, 40)).toBeUndefined();
    expect(st.cargo).toEqual({ construction: 18 });
  });
});
