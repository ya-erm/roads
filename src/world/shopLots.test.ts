import { describe, expect, it } from 'vitest';
import { freshGame } from '../game/testkit';
import type { TownBuilding } from './entities';
import { CAR_SIZE, drivewayLink, LOT_SETBACK } from './houseAccess';
import { NEW_GAME_SETTINGS } from './settings';
import {
  APRON,
  DEPOT_MIN_W,
  depotLot,
  DOCK_TRUCK,
  dockYardOf,
  dockYardsOf,
  fuelLot,
  SERVICE_DRIVE,
  shopLotOf,
  STALL,
  stallDriveways,
  stallFit,
  THROUGH_R,
  YARD_DEPTH,
  type ShopLot,
} from './shopLots';
import { pointInFootprint } from './spatial';

let nextId = 5000;
const lot = (o: Partial<TownBuilding> = {}): TownBuilding => ({
  type: 'building',
  id: nextId++,
  townId: 1,
  fp: { center: { x: 200, y: -80 }, w: 40, h: 40, angle: 0.4 },
  kind: 'com',
  floors: 2,
  people: 0,
  anchor: 0,
  color: '#efe3cf',
  roof: '#8f9aa4',
  form: 'shop',
  face: -1,
  ...o,
});

type Rect = { x: number; y: number; w: number; h: number };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;

/** Места подогнаны под машину и под площадку, лежат в участке и не налезают на здание и друг на друга. */
function checkLot(b: TownBuilding, plan: ShopLot): void {
  const W = b.fp.w;
  const H = b.fp.h;
  for (const g of plan.groups) {
    const n = g.stalls.length;
    expect(n).toBeGreaterThan(0);
    for (const s of g.stalls) {
      // Под машину 7,5 × 3: ширина 4,6–5 м, глубина 8,5.
      expect(s.w).toBeGreaterThanOrEqual(STALL.min - 1e-9);
      expect(s.w).toBeLessThanOrEqual(STALL.max + 1e-9);
      expect(s.w - CAR_SIZE.w).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(s.y1 - s.y0).toBe(STALL.d);
      expect(s.y1 - s.y0 - CAR_SIZE.l).toBeGreaterThanOrEqual(1);
      // Между краем участка и местами — асфальт под доворот.
      expect(s.y0 + H / 2).toBeCloseTo(APRON);
      expect(s.x - s.w / 2).toBeGreaterThan(-W / 2);
      expect(s.x + s.w / 2).toBeLessThan(W / 2);
      if (plan.building) expect(overlaps({ x: s.x - s.w / 2, y: s.y0, w: s.w, h: s.y1 - s.y0 }, plan.building)).toBe(false);
    }
    // Места — встык, площадка — ровно под них (по 0,4 м с краёв), съезд — во всю группу.
    for (let k = 1; k < n; k++) expect(g.stalls[k].x - g.stalls[k - 1].x).toBeCloseTo(g.stalls[k].w);
    const width = n * g.stalls[0].w;
    expect(g.pad.w).toBeCloseTo(width + 0.8);
    expect(g.cut.w).toBeCloseTo(width);
    expect(g.pad.y + g.pad.h).toBeGreaterThanOrEqual(g.stalls[0].y1);
  }
  const all = plan.groups.flatMap((g) => g.stalls);
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) expect(Math.abs(all[i].x - all[j].x)).toBeGreaterThanOrEqual((all[i].w + all[j].w) / 2 - 1e-6);
}

describe('Стоянки магазинов', () => {
  it('сколько мест — по ширине: 4,6–5 м на место, остаток делится поровну', () => {
    expect(stallFit(4)).toEqual({ n: 0, w: 0 });
    expect(stallFit(9.2)).toEqual({ n: 2, w: 4.6 });
    expect(stallFit(14.5).n).toBe(3);
    expect(stallFit(14.5).w).toBeCloseTo(14.5 / 3);
    // Широко для двух — два по 5 м (остаток — у здания), а не три узких.
    expect(stallFit(13.7)).toEqual({ n: 2, w: 5 });
  });

  it('небольшой магазин: стоянка сбоку на 2–4 места, с другой стороны — проезд к рампе, здание — во весь остаток ширины', () => {
    for (const [W, n] of [
      [35, 2],
      [40, 2],
      [47, 3],
      [57, 4],
    ] as const) {
      const b = lot({ fp: { center: { x: 0, y: 0 }, w: W, h: 40, angle: 0 } });
      const plan = shopLotOf(b)!;
      expect(plan.groups.length).toBe(1);
      expect(plan.groups[0].stalls.length).toBe(n);
      checkLot(b, plan);
      // Площадка подогнана под места: от края участка до здания — проезд, места и зазоры, без пустого асфальта.
      const g = plan.groups[0];
      const used = plan.building!.w + g.pad.w - 0.8;
      expect(used).toBeCloseTo(W - 3.5 - SERVICE_DRIVE);
    }
  });

  it('двор с рампой: проезд у торца не задевает здание и места, грузовик разворачивается в участке; мелкий двор — рампа у торца', () => {
    const cases: Partial<TownBuilding>[] = [];
    for (const W of [35, 40, 47, 57])
      for (const H of [36, 41, 52]) {
        const fp = { center: { x: 0, y: 0 }, w: W, h: H, angle: 0 };
        cases.push({ fp }, { floors: 5, fp }, { form: 'store', fp }, { form: 'office', fp }, { form: 'warehouse', fp });
        cases.push({ form: 'market', fp: { ...fp, w: W + 10, h: H + 6 } });
      }
    let turns = 0;
    for (const o of cases) {
      for (const id of [1, 2, 3]) {
        const b = lot({ ...o, id });
        const y = dockYardOf(b)!;
        expect(y).not.toBeNull();
        const W = b.fp.w;
        const H = b.fp.h;
        const drive = { x: y.drive.x - y.drive.w / 2, y: -H / 2, w: y.drive.w, h: y.drive.y1 + H / 2 };
        expect(drive.x).toBeGreaterThanOrEqual(-W / 2);
        expect(drive.x + drive.w).toBeLessThanOrEqual(W / 2);
        for (const p of y.pad) {
          expect(p.x).toBeGreaterThanOrEqual(-W / 2 - 1e-6);
          expect(p.x + p.w).toBeLessThanOrEqual(W / 2 + 1e-6);
          expect(p.y + p.h).toBeLessThanOrEqual(H / 2 + 1e-6);
        }
        const plan = shopLotOf(b);
        if (plan?.building) expect(overlaps(drive, plan.building)).toBe(false);
        for (const s of plan?.groups.flatMap((g) => g.stalls) ?? []) expect(overlaps(drive, { x: s.x - s.w / 2, y: s.y0, w: s.w, h: s.y1 - s.y0 })).toBe(false);
        if (y.kind !== 'turn') continue;
        turns++;
        // Разворот: кузов у рампы, поворот и вылет кузова за рампу — в участке.
        const far = y.rx - y.side * (DOCK_TRUCK.r + DOCK_TRUCK.l / 2);
        expect(Math.abs(far)).toBeLessThanOrEqual(W / 2);
        expect(H / 2 - y.wall).toBeGreaterThanOrEqual(YARD_DEPTH - 1e-6);
        expect(Math.abs(y.drive.x - y.rx)).toBeGreaterThanOrEqual(6 - 1e-6);
        if (plan?.building) {
          expect(y.rx).toBeGreaterThan(plan.building.x);
          expect(y.rx).toBeLessThan(plan.building.x + plan.building.w);
          expect(y.wall).toBeCloseTo(plan.building.y + plan.building.h);
        }
      }
    }
    // Небольшие и сельские магазины — с разворотом за зданием (их треть случаев и ещё часть универмагов).
    expect(turns).toBeGreaterThan(cases.length);
  });

  it('универмаг (от 4 этажей) — стоянка во всю ширину перед ним, проход ко входу посередине; рынок — так же', () => {
    const big = lot({ floors: 5, fp: { center: { x: 0, y: 0 }, w: 43, h: 44, angle: 0 } });
    const plan = shopLotOf(big)!;
    expect(plan.groups.length).toBe(2);
    expect(plan.groups.reduce((s, g) => s + g.stalls.length, 0)).toBe(6);
    expect(plan.walk!.w).toBeGreaterThanOrEqual(3);
    checkLot(big, plan);
    // Здание — за стоянкой.
    expect(plan.building!.y).toBeGreaterThan(plan.groups[0].stalls[0].y1);
    const market = lot({ form: 'market', fp: { center: { x: 0, y: 0 }, w: 60, h: 50, angle: 0 } });
    const m = shopLotOf(market)!;
    expect(m.building).toBeNull();
    expect(m.groups.length).toBe(2);
    checkLot(market, m);
  });

  it('сельский магазин — гравий без разметки, не больше 4 мест; контора и жилой дом — без стоянки', () => {
    for (const W of [36, 45, 61]) {
      const b = lot({ form: 'store', fp: { center: { x: 0, y: 0 }, w: W, h: 42, angle: 0 } });
      const plan = shopLotOf(b)!;
      expect(plan.gravel).toBe(true);
      const n = plan.groups[0].stalls.length;
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(4);
      checkLot(b, plan);
    }
    expect(shopLotOf(lot({ form: 'office' }))).toBeNull();
    expect(shopLotOf(lot({ kind: 'res', form: 'cottage' }))).toBeNull();
  });

  it('в мире: места — от бордюра внутрь участка, машина на месте — в участке; дом с другой стороны улицы — повёрнут', () => {
    const b = lot();
    for (const face of [-1, 1] as const) {
      const drives = stallDriveways({ ...b, face });
      expect(drives.length).toBe(2);
      for (const d of drives) {
        expect(pointInFootprint(d.curb, b.fp)).toBe(false);
        expect(pointInFootprint(d.gate, b.fp, 0.1)).toBe(true);
        expect(pointInFootprint(d.spot, b.fp, 0.1)).toBe(true);
        expect(Math.hypot(d.gate.x - d.curb.x, d.gate.y - d.curb.y)).toBeCloseTo(LOT_SETBACK + APRON + STALL.d);
        expect(d.garage).toBe(false);
      }
    }
  });

  it('мир по seed: у магазинов и рынков есть стоянки, их места упираются в свою улицу', { timeout: 30_000 }, () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
    const shops = g.towns.flatMap((t) => t.buildings).filter((b) => shopLotOf(b));
    expect(shops.length).toBeGreaterThan(20);
    const drives = shops.flatMap((b) => stallDriveways(b));
    expect(drives.length).toBeGreaterThan(shops.length * 2);
    const linked = drives.filter((d) => drivewayLink(g.roads.net, d)).length;
    expect(linked / drives.length).toBeGreaterThan(0.9);
  });

  it('АЗС и оптовая база: сквозной проезд — съезды у обоих краёв, проезд вдоль улицы глубже навеса, рампа — у него', () => {
    for (const W of [35.2, 40, 48])
      for (const H of [35.2, 42, 48]) {
        const fp = { center: { x: 0, y: 0 }, w: W, h: H, angle: 0 };
        const f = lot({ form: 'fuel', fp });
        const plan = fuelLot(f);
        const y = plan.yard;
        expect(y.kind).toBe('through');
        expect(dockYardsOf(f)).toEqual([y]);
        expect(y.drive.x).toBeCloseTo(-y.exit!.x);
        expect(y.drive.x - y.drive.w / 2).toBeGreaterThanOrEqual(-W / 2);
        expect(y.exit!.x + y.exit!.w / 2).toBeLessThanOrEqual(W / 2);
        // Поворот с проезда у края на проезд вдоль улицы — дальше, чем встаёт кузов Фуры (21) сразу с улицы.
        expect(y.wall - THROUGH_R).toBeGreaterThan(-H / 2 - LOT_SETBACK + 21 / 2);
        // Навес и островки — между съездами и перед проездом бензовоза; магазинчик и люки — за ним, в участке.
        expect(plan.canopy.x).toBeGreaterThan(y.drive.x + y.drive.w / 2);
        expect(plan.canopy.x + plan.canopy.w).toBeLessThan(y.exit!.x - y.exit!.w / 2);
        expect(plan.canopy.y + plan.canopy.h).toBeLessThan(y.wall - DOCK_TRUCK.w / 2);
        expect(plan.islands.length).toBeGreaterThan(0);
        expect(plan.tanks.y).toBeGreaterThan(y.wall + DOCK_TRUCK.w / 2);
        expect(plan.building.y).toBeGreaterThan(plan.tanks.y + plan.tanks.h);
        expect(plan.building.y + plan.building.h).toBeLessThanOrEqual(H / 2);
        expect(Math.abs(plan.building.x)).toBeLessThanOrEqual(W / 2);
        expect(y.ramp).toBe(plan.tanks);
        if (W < DEPOT_MIN_W) continue;
        const d = depotLot(lot({ form: 'depot', fp }));
        expect(d.yard.kind).toBe('through');
        // Фура у рампы — на прямом проезде между поворотами к краям.
        expect(d.yard.exit!.x - THROUGH_R - (d.yard.drive.x + THROUGH_R)).toBeGreaterThanOrEqual(21 - 1e-6);
        expect(d.hangar.y).toBeGreaterThan(d.yard.wall + DOCK_TRUCK.w / 2);
        expect(d.yard.ramp.y + d.yard.ramp.h).toBeCloseTo(d.hangar.y);
      }
  });

  it('у рынка две рампы: проезды у обоих краёв, ряды и стоянка — между ними', () => {
    for (const W of [45, 57, 70])
      for (const id of [1, 2]) {
        const b = lot({ id, form: 'market', fp: { center: { x: 0, y: 0 }, w: W, h: 48, angle: 0 } });
        const yards = dockYardsOf(b);
        expect(yards.length).toBe(2);
        expect(yards[0].side).toBe(-yards[1].side);
        expect(yards[0].drive.x).toBeCloseTo(-yards[1].drive.x);
        const plan = shopLotOf(b)!;
        for (const y of yards) {
          const drive = { x: y.drive.x - y.drive.w / 2, y: -24, w: y.drive.w, h: y.drive.y1 + 24 };
          for (const s of plan.groups.flatMap((g) => g.stalls)) expect(overlaps(drive, { x: s.x - s.w / 2, y: s.y0, w: s.w, h: s.y1 - s.y0 })).toBe(false);
        }
        expect(plan.groups.flatMap((g) => g.stalls).length).toBeGreaterThanOrEqual(2);
      }
  });
});
