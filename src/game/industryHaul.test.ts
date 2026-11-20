import { describe, expect, it } from 'vitest';
import { boxesOverlap } from '../lanes/curb';
import type { Station } from '../world/entities';
import { IndustryHaul, industryHaulBox } from './industryHaul';

describe('Перегрузка у предприятия', () => {
  it('встречные машины расходятся по своим сторонам одного проезда', () => {
    const yard = new IndustryHaul();
    const st = { kind: 'road', industryId: 1 } as Station;
    const roads = [[{ x: -60, y: 0 }, { x: 60, y: 0 }]];
    yard.record(st, 'construction', 'out', 16, 0, roads);
    yard.record(st, 'stone', 'in', 16, 3, roads);
    const [out, incoming] = yard.view(st, 8.2)!.trips;
    expect(out.phase).toBe('carrying');
    expect(incoming.phase).toBe('carrying');
    expect(out.pose![1]).toBeGreaterThan(0);
    expect(incoming.pose![1]).toBeLessThan(0);
    expect(boxesOverlap(industryHaulBox(out.pose!), industryHaulBox(incoming.pose!))).toBe(false);
  });

  it('машинки уступают на пересечении и обе заканчивают рейсы', () => {
    const yard = new IndustryHaul();
    const st = { kind: 'road', industryId: 1 } as Station;
    yard.record(st, 'construction', 'out', 16, 0, [[{ x: -70, y: 0 }, { x: 70, y: 0 }]]);
    yard.record(st, 'stone', 'in', 16, 3, [[{ x: 0, y: 70 }, { x: 0, y: -34 }]]);
    let simultaneous = false;
    let yielded = false;
    let lastProgress = -1;
    for (let i = 0; i < 800; i++) {
      const trips = yard.view(st, 3 + i / 20)?.trips ?? [];
      if (trips.length < 2) continue;
      simultaneous = true;
      const [a, b] = trips;
      expect(boxesOverlap(industryHaulBox(a.pose!), industryHaulBox(b.pose!))).toBe(false);
      if (b.phase === 'carrying' && b.progress > 0 && b.progress === lastProgress) yielded = true;
      lastProgress = b.progress;
    }
    expect(simultaneous).toBe(true);
    expect(yielded).toBe(true);
    expect(yard.view(st, 45)).toBeUndefined();
  });

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
