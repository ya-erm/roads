import { describe, expect, it } from 'vitest';
import { freshGame } from '../game/testkit';
import type { TownBuilding } from './entities';
import { CAR_PLACE, CAR_SIZE, cottagePlan, dachaPlan, drivewayLink, drivewayOf, GARAGE, LOT_SETBACK } from './houseAccess';
import { NEW_GAME_SETTINGS } from './settings';
import { pointInFootprint } from './spatial';

let nextId = 900;
const cottage = (o: Partial<TownBuilding> = {}): TownBuilding => ({
  type: 'building',
  id: nextId++,
  townId: 1,
  fp: { center: { x: 100, y: 50 }, w: 26, h: 26, angle: 0.3 },
  kind: 'res',
  floors: 1,
  people: 4,
  anchor: 0,
  color: '#efe3cf',
  roof: '#b9654d',
  form: 'cottage',
  face: -1,
  ...o,
});

describe('Заезды частных домов', () => {
  it('у половины домов на участке от 20 м — гараж под машину, заезд шире машины и не короче её от края участка до ворот', () => {
    const list = Array.from({ length: 60 }, () => cottage());
    const withGarage = list.filter((b) => cottagePlan(b).garage);
    expect(withGarage.length).toBeGreaterThan(15);
    expect(withGarage.length).toBeLessThan(45);
    for (const b of withGarage) {
      const p = cottagePlan(b);
      expect(p.garage!.w).toBeGreaterThanOrEqual(CAR_SIZE.w + 1);
      expect(p.garage!.h).toBeGreaterThanOrEqual(CAR_SIZE.l + 1);
      expect(p.drive!.w).toBeGreaterThanOrEqual(4.5);
      // Машина перед воротами — на участке, не на тротуаре.
      expect(p.drive!.y1 - p.drive!.y0).toBeGreaterThanOrEqual(CAR_SIZE.l);
      // Гараж — в участке и не на доме.
      const g = p.garage!;
      expect(g.x).toBeGreaterThan(-b.fp.w / 2);
      expect(g.x + g.w).toBeLessThan(b.fp.w / 2);
      expect(g.y + g.h).toBeLessThan(b.fp.h / 2);
      const h = p.house;
      expect(g.x >= h.x + h.w || g.x + g.w <= h.x).toBe(true);
    }
    // Узкий участок — без гаража.
    expect(Array.from({ length: 20 }, () => cottagePlan(cottage({ fp: { center: { x: 0, y: 0 }, w: 18, h: 20, angle: 0 } }))).every((p) => !p.garage)).toBe(true);
  });

  it('у дома без гаража — часто площадка под машину 5,2 × 8,4 м от края участка; доли: гараж ~45 %, площадка ~35 %, ничего ~20 %', () => {
    const list = Array.from({ length: 400 }, () => cottage({ fp: { center: { x: 0, y: 0 }, w: 40, h: 44, angle: 0 } }));
    const plans = list.map((b) => cottagePlan(b));
    const share = (f: (p: (typeof plans)[0]) => boolean) => plans.filter(f).length / plans.length;
    expect(share((p) => !!p.garage)).toBeCloseTo(CAR_PLACE.garage, 1);
    expect(share((p) => !!p.pad)).toBeCloseTo(CAR_PLACE.pad, 1);
    expect(share((p) => !p.garage && !p.pad)).toBeCloseTo(1 - CAR_PLACE.garage - CAR_PLACE.pad, 1);
    for (const [i, p] of plans.entries()) {
      if (!p.pad) continue;
      const b = list[i];
      expect(p.garage).toBeNull();
      // Под машину 7 × 4 с запасом; от края участка, не на доме.
      expect(p.pad.w).toBeGreaterThanOrEqual(CAR_SIZE.w + 1);
      expect(p.pad.h).toBeGreaterThanOrEqual(CAR_SIZE.l + 1);
      expect(p.pad.y).toBeCloseTo(-b.fp.h / 2);
      const h = p.house;
      expect(p.pad.x >= h.x + h.w || p.pad.x + p.pad.w <= h.x).toBe(true);
      expect(p.drive!.x).toBeCloseTo(p.pad.x + p.pad.w / 2);
      const d = drivewayOf(b)!;
      expect(d.garage).toBe(false);
      expect(pointInFootprint(d.spot, b.fp, 0.1)).toBe(true);
    }
    // Дача: площадка у 40 %, у второго ряда — нет.
    const dachas = Array.from({ length: 300 }, () => cottage({ form: 'dacha', fp: { center: { x: 0, y: 0 }, w: 40, h: 44, angle: 0 } }));
    const pads = dachas.filter((b) => dachaPlan(b).pad);
    expect(pads.length / dachas.length).toBeCloseTo(CAR_PLACE.dachaPad, 1);
    for (const b of pads) expect(drivewayOf(b)).not.toBeNull();
    expect(dachas.every((b) => !dachaPlan({ ...b, rear: true }).pad)).toBe(true);
  });

  it('в мире: от бордюра улицы к воротам — внутрь участка, длиной не меньше отступа и машины; дом с другой стороны улицы — повёрнут', () => {
    const b = Array.from({ length: 40 }, () => cottage()).find((x) => cottagePlan(x).garage)!;
    for (const face of [-1, 1] as const) {
      const d = drivewayOf({ ...b, face })!;
      expect(d).not.toBeNull();
      expect(Math.hypot(d.gate.x - d.curb.x, d.gate.y - d.curb.y)).toBeGreaterThanOrEqual(LOT_SETBACK + CAR_SIZE.l);
      expect(pointInFootprint(d.gate, b.fp, 0.1)).toBe(true);
      expect(pointInFootprint(d.spot, b.fp, 0.1)).toBe(true);
      expect(pointInFootprint(d.curb, b.fp)).toBe(false);
      expect(Math.hypot(d.dir.x, d.dir.y)).toBeCloseTo(1);
      expect(d.width).toBeGreaterThanOrEqual(4.5);
      expect(GARAGE.d).toBeGreaterThanOrEqual(CAR_SIZE.l);
    }
    expect(drivewayOf({ ...b, form: 'walkup' })).toBeNull();
  });

  it('мир по seed: заезды частных домов упираются в свою улицу', { timeout: 30_000 }, () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
    const drives = g.towns.flatMap((t) => t.buildings).flatMap((b) => drivewayOf(b) ?? []);
    expect(drives.length).toBeGreaterThan(100);
    let linked = 0;
    for (const d of drives) {
      const link = drivewayLink(g.roads.net, d);
      if (!link) continue;
      linked++;
      const c = g.roads.net.corridor(link.corridor);
      const p = c.lut.pointAt(link.s);
      // Бордюр — у полотна: ближе к оси, чем ворота.
      expect(Math.hypot(d.curb.x - p.x, d.curb.y - p.y)).toBeLessThan(Math.hypot(d.gate.x - p.x, d.gate.y - p.y));
    }
    expect(linked / drives.length).toBeGreaterThan(0.95);
  });
});
