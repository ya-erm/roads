import { describe, expect, it } from 'vitest';
import { boxesOverlap } from '../lanes/curb';
import { INDUSTRY_TYPES } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import { industryAccess, industryFootprint, industryLoadingApron } from '../world/industrySites';
import { IndustryHaul, industryHaulBox } from './industryHaul';
import { industryHaulPaths } from './industryHaulRoutes';

describe('Перегрузка у предприятия', () => {
  it('встречные машины расходятся по своим сторонам одного проезда', () => {
    const yard = new IndustryHaul();
    const st = { kind: 'road', industryId: 1 } as Station;
    const roads = [{ road: [{ x: -60, y: 0 }, { x: 60, y: 0 }] }];
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
    yard.record(st, 'construction', 'out', 16, 0, [{ road: [{ x: -70, y: 0 }, { x: 70, y: 0 }] }]);
    yard.record(st, 'stone', 'in', 16, 3, [{ road: [{ x: 0, y: 70 }, { x: 0, y: -34 }] }]);
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

  it('заезжает на размеченные места у корпуса и сдаёт с них, прежде чем ехать к станции', () => {
    const info = INDUSTRY_TYPES.meatplant;
    const fp = industryFootprint(info, { x: 0, y: 0 }, 0, true);
    const ind = { id: 1, info, fp } as Industry;
    const gate = industryAccess(fp, info.kind);
    const st = {
      kind: 'road',
      industryId: 1,
      industryAccess: true,
      fp: { center: { x: gate.x + 32.4, y: gate.y }, w: 100, h: 56, angle: Math.PI / 2 },
    } as Station;
    const apron = industryLoadingApron(info)!;
    const yard = new IndustryHaul();
    yard.record(st, 'grain', 'in', 64, 0, industryHaulPaths(st, ind, -1, 'grain', 'in'));
    const visited = new Set<number>();
    let reversed = false;
    for (let step = 0; step < 1500; step++) {
      const trips = yard.view(st, step / 20)?.trips ?? [];
      if (trips.length === 0) break;
      for (const trip of trips) {
        const [x, y, yaw, forward] = trip.pose!;
        if (trip.phase === 'unloading' && Math.abs(y - apron.bayY) < 0.01) {
          const bay = apron.bays.find((b) => Math.abs(x - b) < 0.01);
          expect(bay).toBeDefined();
          expect(Math.sin(yaw)).toBeCloseTo(-1);
          visited.add(bay!);
        }
        if (trip.phase === 'returning' && !forward && y < apron.aisle) reversed = true;
      }
      for (let i = 0; i < trips.length; i++) for (let j = i + 1; j < trips.length; j++) {
        expect(boxesOverlap(industryHaulBox(trips[i].pose!), industryHaulBox(trips[j].pose!))).toBe(false);
      }
    }
    expect(visited.size).toBeGreaterThanOrEqual(3);
    expect(reversed).toBe(true);
  });
});
