import { describe, expect, it } from 'vitest';
import { freshGame } from '../game/testkit';
import type { TownBuilding } from './entities';
import { NEW_GAME_SETTINGS } from './settings';
import { formOf } from './townForms';
import { homeCars, SLAB_FRONT, slabPlan, TOWNHOUSE_END, townhousePlan, YARD_STALL, yardLotOf, yardSpots, type SlabAlong } from './yardLots';

let nextId = 7000;
const slab = (w: number, h: number, people = 140): TownBuilding => ({
  type: 'building',
  id: nextId++,
  townId: 1,
  fp: { center: { x: 0, y: 0 }, w, h, angle: 0.4 },
  kind: 'res',
  floors: 5,
  people,
  anchor: 0,
  color: '#d8d2c6',
  roof: '#8a8580',
  form: 'slab',
  face: -1,
});

const stalls = (b: TownBuilding) => yardLotOf(b)?.rows.reduce((s, r) => s + r.stalls.length, 0) ?? 0;

describe('Стоянки панелек — у улицы', () => {
  it('глубокий участок: карман перед фасадом с заездом прямо с улицы, мест — на все машины дома с запасом; двор — без машин', () => {
    for (let i = 0; i < 40; i++) {
      const b = slab(80 + i, 46 + (i % 7));
      const p = slabPlan(b) as SlabAlong;
      expect(p.kind).toBe('along');
      expect(p.doors).toBe('front');
      const y0 = -b.fp.h / 2;
      // Места — от края участка у улицы, за ними тротуар у фасада, дальше корпус; двор за корпусом не мельче нормы.
      for (const r of p.front) {
        expect(r.direct).toBe(true);
        expect(r.side).toBe(-1);
        expect(r.open).toBe('y-');
        expect(r.stalls.length).toBeLessThanOrEqual(SLAB_FRONT.seg);
        for (const s of r.stalls) {
          expect(s.y).toBeCloseTo(y0 + SLAB_FRONT.edge);
          expect(s.y + s.h).toBeLessThanOrEqual(p.by - SLAB_FRONT.walk + 1e-6);
          expect(s.x).toBeGreaterThanOrEqual(p.bx - 1e-6);
          expect(s.x + s.w).toBeLessThanOrEqual(p.bx + p.L + 1e-6);
        }
      }
      expect(b.fp.h / 2 - 0.6 - p.top).toBeGreaterThanOrEqual(SLAB_FRONT.yard);
      // Мест — на все машины дома (участок длинный); двор — с площадками.
      expect(stalls(b)).toBeGreaterThanOrEqual(homeCars(b));
      expect(p.plan?.pieces.length).toBeGreaterThan(0);
      // Ворот двора нет: у каждого места — свой заезд с улицы.
      const lot = yardLotOf(b)!;
      expect(lot.gate).toBeNull();
      const ys = yardSpots(b, lot, 7.5);
      expect(ys.gate).toBeNull();
      expect(ys.spots.every((s) => !!s.drive && !s.drive.garage)).toBe(true);
      // Между кусками кармана — дорожка от улицы к подъездам.
      expect(p.paths.length).toBeGreaterThanOrEqual(p.front.length - 1);
    }
  });

  it('мелкий участок: корпус у тротуара, подъезды во двор, места — у торца с заездом с улицы, на корпус не заходят', () => {
    let ends = 0;
    for (let i = 0; i < 30; i++) {
      const b = slab(70 + i, 36 + (i % 3));
      const p = slabPlan(b) as SlabAlong;
      expect(p.doors).toBe('back');
      expect(p.walk).toBeNull();
      for (const r of p.front) {
        ends++;
        expect(r.direct).toBe(true);
        expect(r.stalls.length).toBeGreaterThanOrEqual(SLAB_FRONT.end[0]);
        expect(r.stalls.length).toBeLessThanOrEqual(SLAB_FRONT.end[1]);
        // Сбоку от корпуса, не на нём.
        for (const s of r.stalls) expect(s.x + s.w <= p.bx + 1e-6 || s.x >= p.bx + p.L - 1e-6).toBe(true);
        expect(r.stalls[0].h).toBeLessThanOrEqual(YARD_STALL.d);
      }
      expect(yardLotOf(b)?.gate ?? null).toBeNull();
    }
    expect(ends).toBe(30);
  });

  it('дом старого центра: места у торца, у улицы, с заездом с улицы; корпус — рядом, не на них; флигель — с другой стороны', () => {
    for (let i = 0; i < 40; i++) {
      const b: TownBuilding = { ...slab(34 + (i % 14), 30 + (i % 9), 30), form: 'townhouse', floors: 2 };
      const p = townhousePlan(b);
      const r = p.row!;
      expect(r).toBeTruthy();
      expect(r.direct).toBe(true);
      expect(r.side).toBe(-1);
      expect(r.stalls.length).toBeGreaterThanOrEqual(TOWNHOUSE_END.stalls[0]);
      expect(r.stalls.length).toBeLessThanOrEqual(TOWNHOUSE_END.stalls[1]);
      for (const s of r.stalls) {
        expect(s.y).toBeCloseTo(-b.fp.h / 2 + 0.6);
        expect(s.x + s.w <= p.bx + 1e-6 || s.x >= p.bx + p.bw - 1e-6).toBe(true);
        expect(Math.abs(s.x + s.w / 2)).toBeLessThan(b.fp.w / 2);
        if (p.wing) expect(s.x + s.w <= p.wing.x || s.x >= p.wing.x + p.wing.w).toBe(true);
      }
      expect(p.bw).toBeGreaterThanOrEqual(TOWNHOUSE_END.minBody);
      expect(p.door).toBeGreaterThan(p.bx);
      expect(p.door).toBeLessThan(p.bx + p.bw);
      const lot = yardLotOf(b)!;
      expect(lot.gate).toBeNull();
      expect(yardSpots(b, lot, 7.5).spots.every((s) => !!s.drive)).toBe(true);
    }
    // Узкий участок — корпус во всю ширину, мест нет.
    const narrow: TownBuilding = { ...slab(26, 30, 30), form: 'townhouse', floors: 2 };
    expect(townhousePlan(narrow).row).toBeNull();
    expect(yardLotOf(narrow)).toBeNull();
  });

  it('мир по seed: у панелек мест во дворе за воротами нет — у большинства карман у улицы, места не выходят за участок', { timeout: 30_000 }, () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
    let along = 0;
    let front = 0;
    // Места за воротами двора — только за настоящей аркой квартала и у гаражных боксов; у прочих — заезд с улицы.
    for (const t of g.towns)
      for (const b of t.buildings) {
        const lot = b.kind !== 'landmark' ? yardLotOf(b) : null;
        if (lot?.gate) expect(['courtyard', 'garages']).toContain(formOf(b));
        else for (const r of lot?.rows ?? []) expect(r.direct).toBe(true);
      }
    for (const t of g.towns)
      for (const b of t.buildings) {
        if (formOf(b) !== 'slab' || b.kind !== 'res') continue;
        const lot = yardLotOf(b);
        expect(lot?.gate ?? null).toBeNull();
        for (const r of lot?.rows ?? [])
          for (const s of r.stalls) {
            expect(Math.abs(s.x + s.w / 2)).toBeLessThanOrEqual(b.fp.w / 2);
            expect(s.y).toBeGreaterThanOrEqual(-b.fp.h / 2);
            expect(s.y + s.h).toBeLessThanOrEqual(b.fp.h / 2);
          }
        const p = slabPlan(b);
        if (p.kind !== 'along') continue;
        along++;
        if (p.doors === 'front') front++;
      }
    expect(along).toBeGreaterThan(50);
    expect(front / along).toBeGreaterThan(0.85);
  });
});
