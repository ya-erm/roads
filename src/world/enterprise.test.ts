import { describe, expect, it } from 'vitest';
import { ENTERPRISE } from '../config';
import { INDUSTRY_LIST, INDUSTRY_TYPES, type IndustryKind } from './cargo';
import {
  allocateWorkers,
  buildCost,
  buildTime,
  commuteShare,
  depositAt,
  depositRadius,
  growthFactor,
  harmClass,
  harmTo,
  inTown,
  laborPool,
  obtainable,
  staffShare,
  townEdge,
  townFor,
  townHarm,
  townSlots,
  workersNeeded,
} from './enterprise';
import type { Deposit, Industry, Town } from './entities';

const town = (id: number, x: number, population: number, radius = 300): Town =>
  ({ id, name: `Т${id}`, center: { x, y: 0 }, radius, extent: radius, population, buildings: [], demands: [] }) as unknown as Town;

const industry = (id: number, kind: IndustryKind, x: number, extra: Partial<Industry> = {}): Industry => {
  const info = INDUSTRY_TYPES[kind];
  return { type: 'industry', id, info, name: info.name, fp: { center: { x, y: 0 }, w: info.w, h: info.h, angle: 0 }, stock: {}, output: 0, producedMonth: 0, producedLast: 0, prodAcc: 0, ...extra };
};

/** Центр участка на зазоре gap от черты города t (по оси x, справа). */
const at = (t: Town, kind: IndustryKind, gap: number) => {
  const info = INDUSTRY_TYPES[kind];
  return t.center.x + townEdge(t) + Math.hypot(info.w, info.h) / 4 + gap;
};

describe('цена, время и рабочие', () => {
  it('добыча дешевле завода, завод на два сырья — дороже; заброшенное — вдвое дешевле и быстрее', () => {
    expect(buildCost(INDUSTRY_TYPES.farm)).toBe(ENTERPRISE.cost.raw);
    expect(buildCost(INDUSTRY_TYPES.sawmill)).toBe(ENTERPRISE.cost.plant);
    expect(buildCost(INDUSTRY_TYPES.steelmill)).toBe(ENTERPRISE.cost.plant2);
    expect(buildCost(INDUSTRY_TYPES.sawmill, true)).toBe(ENTERPRISE.cost.plant / 2);
    expect(buildTime(INDUSTRY_TYPES.sawmill, true)).toBe(buildTime(INDUSTRY_TYPES.sawmill) / 2);
    expect(workersNeeded(INDUSTRY_TYPES.farm)).toBeLessThan(workersNeeded(INDUSTRY_TYPES.sawmill));
    expect(workersNeeded(INDUSTRY_TYPES.sawmill)).toBeLessThan(workersNeeded(INDUSTRY_TYPES.factory));
  });

  it('у каждого вида класс вредности 0–3: фермы и пищевые чистые, металлургия — 3', () => {
    for (const t of INDUSTRY_LIST) expect([0, 1, 2, 3]).toContain(harmClass(t.kind));
    expect(harmClass('farm')).toBe(0);
    expect(harmClass('foodplant')).toBe(0);
    expect(harmClass('coalmine')).toBe(2);
    expect(harmClass('steelmill')).toBe(3);
  });

  it('рабочие доходят сами до near, дальше меньше, за far — никто', () => {
    const { near, far } = ENTERPRISE.commute;
    expect(commuteShare(0)).toBe(1);
    expect(commuteShare(near)).toBe(1);
    expect(commuteShare((near + far) / 2)).toBeCloseTo(0.5);
    expect(commuteShare(far)).toBe(0);
  });

  it('завод у города укомплектован сам, далёкий — нет: недостачу можно привезти автобусом', () => {
    const t = town(1, 0, 4000);
    const near = industry(10, 'sawmill', at(t, 'sawmill', 200));
    const far = industry(11, 'sawmill', at(t, 'sawmill', ENTERPRISE.commute.far + 500));
    const { staff, employed } = allocateWorkers([t], [near, far]);
    expect(staff.get(10)!.local).toBe(1);
    expect(staff.get(10)!.from).toEqual([{ town: 1, n: workersNeeded(near.info) }]);
    expect(staff.get(11)!.local).toBe(0);
    expect(staff.get(11)!.bus).toBe(workersNeeded(far.info));
    expect(employed.get(1)).toBe(workersNeeded(near.info));
    // Привезли столько, сколько не хватает, — работает в полную силу.
    expect(staffShare({ crew: staff.get(11)!.bus }, staff.get(11))).toBe(1);
    expect(staffShare({ crew: staff.get(11)!.bus / 2 }, staff.get(11))).toBeCloseTo(0.5);
  });

  it('маленький город не прокормит рабочими несколько заводов: позже построенные — без рабочих', () => {
    const t = town(1, 0, 2500);
    const pool = laborPool(t);
    const a = industry(10, 'sawmill', at(t, 'sawmill', 100));
    const b = industry(11, 'foodplant', at(t, 'foodplant', 100) + 400);
    const { staff } = allocateWorkers([t], [b, a]);
    expect(staff.get(10)!.local).toBe(1);
    expect(staff.get(11)!.local).toBeCloseTo((pool - workersNeeded(a.info)) / workersNeeded(b.info));
  });

  it('заброшенное и строящееся рабочих не берут', () => {
    const t = town(1, 0, 4000);
    const ruin = industry(10, 'sawmill', at(t, 'sawmill', 100), { ruin: true });
    const site = industry(11, 'farm', at(t, 'farm', 100) + 300, { build: { done: 0.5, cost: 1, paid: 0, time: 60 } });
    const { employed } = allocateWorkers([t], [ruin, site]);
    expect(employed.get(1)).toBe(0);
  });
});

describe('черта города, места и вред', () => {
  it('участок, что задевает застройку, — в черте города', () => {
    const t = town(1, 0, 3000);
    const inside = industry(10, 'foodplant', townEdge(t) - 10);
    const outside = industry(11, 'foodplant', at(t, 'foodplant', 50));
    expect(inTown(t, inside.fp)).toBe(true);
    expect(inTown(t, outside.fp)).toBe(false);
    expect(townFor([t], inside.fp)).toBe(t);
    expect(townFor([t], outside.fp)).toBeNull();
  });

  it('мест в черте: с 2500 жителей одно, дальше каждые 4500 ещё одно, не больше четырёх', () => {
    expect(townSlots({ population: 2000 })).toBe(0);
    expect(townSlots({ population: 2500 })).toBe(1);
    expect(townSlots({ population: 7000 })).toBe(2);
    expect(townSlots({ population: 11500 })).toBe(3);
    expect(townSlots({ population: 99000 })).toBe(ENTERPRISE.slots.max);
  });

  it('вредное у города режет рост: вплотную — класс × 20%, за радиусом вреда — ничего; чистое не вредит', () => {
    const t = town(1, 0, 5000);
    const fp = industry(10, 'steelmill', at(t, 'steelmill', 0)).fp;
    expect(harmTo(t, 'steelmill', fp)).toBeCloseTo(3 * ENTERPRISE.harm.growth);
    expect(harmTo(t, 'steelmill', industry(11, 'steelmill', at(t, 'steelmill', 3 * ENTERPRISE.harm.reach + 10)).fp)).toBe(0);
    expect(harmTo(t, 'foodplant', fp)).toBe(0);
    // Две металлургии вплотную — город почти не растёт; рабочие места — прибавляют.
    const two = townHarm(t, [industry(10, 'steelmill', at(t, 'steelmill', 0)), industry(11, 'steelmill', at(t, 'steelmill', 0))]);
    expect(two.total).toBeCloseTo(1.2);
    expect(growthFactor(two.total, 1)).toBe(0);
    expect(growthFactor(0, 1)).toBeCloseTo(1 + ENTERPRISE.jobs);
    expect(growthFactor(0.4, 0)).toBeCloseTo(0.6);
  });
});

describe('что можно получить', () => {
  it('продукт получить можно, если вид завода есть и сырьё можно получить по цепочке', () => {
    const kinds = [INDUSTRY_TYPES.forest, INDUSTRY_TYPES.sawmill, INDUSTRY_TYPES.factory];
    expect(obtainable('planks', kinds)).toBe(true);
    // Товарам нужен ещё металл — его не получить.
    expect(obtainable('goods', kinds)).toBe(false);
    expect(obtainable('goods', [...kinds, INDUSTRY_TYPES.steelmill, INDUSTRY_TYPES.coalmine, INDUSTRY_TYPES.ironmine])).toBe(true);
  });
});

describe('клик по месторождению', () => {
  const dep = (id: number, x: number, size: 0 | 1 | 2, used?: number): Deposit => ({ id, kind: 'coalmine', center: { x, y: 0 }, angle: 0, size, used });

  it('пятно больше у богатого; под точкой — ближайшее к центру свободное, занятое не выбирается', () => {
    expect(depositRadius({ size: 2 })).toBeGreaterThan(depositRadius({ size: 0 }));
    const list = [dep(1, 0, 1), dep(2, 120, 2), dep(3, 1000, 2, 99)];
    expect(depositAt(list, { x: 10, y: 0 })?.id).toBe(1);
    expect(depositAt(list, { x: 110, y: 0 })?.id).toBe(2);
    // Занятое (на нём предприятие) — не месторождение для клика.
    expect(depositAt(list, { x: 1000, y: 0 })).toBeNull();
    // За краем пятна — нет; с запасом под значок — да.
    const edge = depositRadius({ size: 1 }) + 5;
    expect(depositAt([list[0]], { x: 0, y: edge })).toBeNull();
    expect(depositAt([list[0]], { x: 0, y: edge }, 10)?.id).toBe(1);
  });
});
