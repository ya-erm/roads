import { describe, expect, it } from 'vitest';
import type { Station } from '../world/entities';
import { IndustryHaul } from './industryHaul';

describe('Перегрузка у предприятия', () => {
  it('грузит камень на станции, отвозит его и привозит кирпичи отдельным рейсом', () => {
    const yard = new IndustryHaul();
    const st = { kind: 'road', industryId: 1, industryAccess: true, cargo: { construction: 18 } } as Station;
    yard.record(st, 'stone', 'in', 12, 0);
    yard.record(st, 'construction', 'out', 18, 1);
    expect(yard.view(st, 1)).toMatchObject({ cargo: 'stone', phase: 'loading', outgoing: {} });
    expect(yard.view(st, 1)?.incoming.stone).toBeLessThan(12);
    expect(yard.view(st, 5)).toMatchObject({ cargo: 'stone', phase: 'carrying', incoming: { stone: 0 } });
    expect(yard.view(st, 10)).toMatchObject({ cargo: 'stone', phase: 'unloading' });
    expect(yard.view(st, 15)).toMatchObject({ cargo: 'stone', phase: 'returning', fill: 0 });
    expect(yard.view(st, 22)).toMatchObject({ cargo: 'construction', phase: 'carrying', outgoing: { construction: 18 } });
    expect(yard.view(st, 30)?.outgoing.construction).toBeLessThan(18);
    expect(yard.view(st, 40)).toBeUndefined();
    expect(st.cargo).toEqual({ construction: 18 });
  });
});
