import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import type { HouseForm, Town, TownBuilding } from './entities';
import {
  acceptAt,
  depotCount,
  depotOf,
  fuelCount,
  legacyCargo,
  markDry,
  maxTruck,
  pickReceivers,
  RETAIL,
  type RetailSites,
  receiverDry,
  receiverNeed,
  receiverOf,
  receiverStocked,
  receiverWeight,
  roomFor,
  stockAt,
  stockCap,
  stockedCount,
  stockFill,
  townRoom,
  unloadTime,
  zoneRetail,
} from './retail';
import { townNeed } from './townSupply';

let nextId = 1;
/** Деловой дом вида form в точке (x, y) — участок 40 × 40. */
function com(form: HouseForm, x: number, y: number, floors = 2): TownBuilding {
  return {
    type: 'building',
    id: nextId++,
    townId: 1,
    fp: { center: { x, y }, w: 40, h: 40, angle: 0 },
    kind: 'com',
    floors,
    anchor: 0,
    color: '#ccc',
    roof: '#999',
    form,
  };
}

function town(population: number, demands: Town['demands'], buildings: TownBuilding[]): Town {
  return {
    id: 1,
    name: 'Тест',
    center: { x: 0, y: 0 },
    radius: 600,
    top: -600,
    style: 'radial',
    population,
    buildings,
    streets: [],
    demands,
    supplied: {},
    lastSupplied: {},
    tripAcc: 0,
    growthAcc: 0,
  };
}

/** Город: рынок в центре, 8 продуктовых по кругу, 3 универмага, сельского магазина нет, конторы и склад. */
function city(population: number, demands: Town['demands'] = ['food', 'goods']) {
  const list: TownBuilding[] = [com('market', 0, 0)];
  for (let i = 0; i < 8; i++) list.push(com('shop', Math.cos(i) * 400, Math.sin(i) * 400));
  for (let i = 0; i < 3; i++) list.push(com('shop', Math.cos(i * 2) * 250, Math.sin(i * 2) * 250, 5));
  list.push(com('office', 100, 0), com('office', -300, 200), com('warehouse', 550, 0));
  return town(population, demands, list);
}

describe('Получатели грузов: подбор', () => {
  it('продуктовых — 1 + ⌊жителей/1500⌋, не больше 6, рынок — всегда и с весом 2', () => {
    for (const [pop, want] of [
      [800, 1],
      [2000, 2],
      [4000, 3],
      [10_000, 6],
      [40_000, 6],
    ] as const) {
      const t = city(pop, ['food']);
      const list = pickReceivers(t, 0);
      const food = list.filter((r) => r.cargo.includes('food'));
      expect(food.length).toBe(want);
      const market = t.buildings.find((b) => b.form === 'market')!;
      expect(food.some((r) => r.b === market.id)).toBe(true);
      expect(receiverOf({ receivers: list }, market.id)!.w).toBe(RETAIL.weight.market);
    }
  });

  it('товары — в универмаги (вес 1,5), бумага — в конторы, стройматериалы и стекло — на склад; топливо — некому', () => {
    const t = city(4000, ['food', 'goods', 'paper', 'construction', 'glass', 'fuel']);
    t.receivers = pickReceivers(t, 0);
    const byId = new Map(t.buildings.map((b) => [b.id, b]));
    for (const r of t.receivers) {
      const b = byId.get(r.b)!;
      if (r.cargo.includes('goods')) expect(b.form === 'shop' && b.floors >= 4).toBe(true);
      if (r.cargo.includes('paper')) expect(b.form).toBe('office');
      if (r.cargo.includes('construction')) {
        expect(b.form).toBe('warehouse');
        expect(r.cargo).toContain('glass');
      }
      expect(r.w).toBe(receiverWeight(b));
    }
    // Универмагов 3, а R(goods) при 4000 — 3: все три.
    expect(t.receivers.filter((r) => r.cargo.includes('goods')).length).toBe(3);
    expect(t.receivers.filter((r) => r.cargo.includes('paper')).length).toBe(1);
    // Топливо — АЗС в этом городе нет: город принимает его по-старому.
    expect(legacyCargo(t)).toEqual(['fuel']);
  });

  it('село: один сельский магазин берёт и продукты, и товары', () => {
    const t = town(500, ['food', 'goods'], [com('store', 0, 0), com('store', 300, 0), com('warehouse', 500, 0)]);
    const list = pickReceivers(t, 0);
    expect(list.length).toBe(1);
    expect(list[0].cargo.sort()).toEqual(['food', 'goods']);
  });

  it('получатели — вдали друг от друга; к которым не подъехать — в последнюю очередь', () => {
    const t = city(2000, ['food']);
    const list = pickReceivers(t, 0);
    const ps = list.map((r) => t.buildings.find((b) => b.id === r.b)!.fp.center);
    expect(Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y)).toBeGreaterThan(300);
    // Подъехать можно только к рынку и одному продуктовому — его и берут вторым.
    const ok = t.buildings[3];
    const reach = pickReceivers(t, 0, new Set(), (b) => b.form === 'market' || b === ok);
    expect(reach.map((r) => r.b).sort()).toEqual([t.buildings[0].id, ok.id].sort());
  });

  it('стоящий в маршруте не переназначается, запас прежних сохраняется; новый — наполовину полон', () => {
    const t = city(2000, ['food']);
    t.receivers = pickReceivers(t, 0);
    const shop = t.receivers.find((r) => t.buildings.find((b) => b.id === r.b)!.form === 'shop')!;
    shop.stock.food = 3;
    // Город «уменьшился» до одного продуктового: рынок и стоящий в маршруте магазин остаются.
    t.population = 800;
    const next = pickReceivers(t, 0, new Set([shop.b]));
    expect(next.map((r) => r.b)).toContain(shop.b);
    expect(receiverOf({ receivers: next }, shop.b)!.stock.food).toBeCloseTo(3);
    const market = receiverOf({ receivers: next }, t.buildings[0].id)!;
    expect(market.stock.food).toBeGreaterThan(0);
    // Подбор — без случайных чисел: тот же город — те же получатели.
    expect(pickReceivers(t, 0, new Set([shop.b]))).toEqual(next);
  });
});

describe('Получатели грузов: склад и расход', () => {
  it('доля нормы — по весам, склад — max(8, 2·dᵢ) (таблица RETAIL.md)', () => {
    // 4000 жителей: норма 25, R(food) = 3 — рынок (×2) и два магазина: 12,5 / 6,25 / 6,25, склад 25 / 13 / 13.
    const t = city(4000, ['food']);
    t.receivers = pickReceivers(t, 0);
    expect(townNeed(4000)).toBe(25);
    const [market, ...shops] = [...t.receivers].sort((a, b) => b.w - a.w);
    expect(receiverNeed(t, market, 'food')).toBeCloseTo(12.5);
    expect(stockCap(t, market, 'food')).toBe(25);
    for (const s of shops) {
      expect(receiverNeed(t, s, 'food')).toBeCloseTo(6.25);
      expect(stockCap(t, s, 'food')).toBe(13);
    }
    // Село в 800 жителей: один магазин — вся норма 15, склад 30.
    const v = town(800, ['food'], [com('store', 0, 0)]);
    v.receivers = pickReceivers(v, 0);
    expect(stockCap(v, v.receivers[0], 'food')).toBe(30);
    expect(v.receivers[0].stock.food).toBe(15);
    // Наименьший склад — 8.
    const big = city(10_000, ['furniture']);
    big.receivers = pickReceivers(big, 0);
    expect(stockCap(big, big.receivers[0], 'furniture')).toBeGreaterThanOrEqual(RETAIL.stockMin);
  });

  it('склад пустеет со временем — считается при обращении, без такта; принимает целыми единицами до полного', () => {
    const v = town(800, ['food'], [com('store', 0, 0)]);
    v.receivers = pickReceivers(v, 0);
    const r = v.receivers[0];
    // Полмесяца: расход — доля нормы × consume.
    const half = stockAt(v, r, 'food', MONTH_LENGTH / 2);
    expect(half).toBeCloseTo(15 - (15 * RETAIL.consume) / 2);
    expect(r.at).toBe(0);
    expect(roomFor(v, r, 'food', MONTH_LENGTH / 2)).toBe(Math.floor(30 - half));
    // Привезли 20: влезло 23 − … — сколько есть места, остальное — нет.
    const took = acceptAt(v, r, 'food', 40, MONTH_LENGTH / 2);
    expect(took).toBe(Math.floor(30 - half));
    expect(v.supplied.food).toBe(took);
    expect(stockFill(v, r, 'food', MONTH_LENGTH / 2)).toBeGreaterThan(0.95);
    expect(acceptAt(v, r, 'food', 40, MONTH_LENGTH / 2)).toBe(0);
    // Пустой склад не уходит в минус.
    expect(stockAt(v, r, 'food', MONTH_LENGTH * 10)).toBe(0);
    // Чужой груз не принимает.
    expect(acceptAt(v, r, 'goods', 10, MONTH_LENGTH)).toBe(0);
  });

  it('за месяц город примет норму с запасом и свободное место; точки «●●○» — снабжённые из всех', () => {
    const t = city(4000, ['food']);
    t.receivers = pickReceivers(t, 0);
    const free = t.receivers.reduce((n, r) => n + stockCap(t, r, 'food') - (r.stock.food ?? 0), 0);
    expect(townRoom(t, 'food', 0, 6)).toBeCloseTo(25 * RETAIL.consume * 6 + free);
    expect(townRoom(t, 'goods', 0, 6)).toBeNull();
    expect(stockedCount(t, 'food', 0)).toEqual({ stocked: 3, total: 3 });
    for (const r of t.receivers.slice(1)) r.stock.food = 0;
    expect(stockedCount(t, 'food', 0)).toEqual({ stocked: 1, total: 3 });
  });

  it('у рампы: 6 с и 0,4 с за единицу', () => {
    expect(unloadTime(0)).toBe(6);
    expect(unloadTime(20)).toBeCloseTo(14);
  });
});

describe('Получатели грузов, этап 3: АЗС, оптовая база, рыба, рост', () => {
  /** Место под АЗС и базу — «у выезда» тем лучше, чем дальше от центра (как у игры: у края и трассы). */
  const sites = (keep: number[] = [], fresh?: number[]): RetailSites => ({
    score: (b) => Math.hypot(b.fp.center.x, b.fp.center.y) / 100,
    keep: new Set(keep),
    fresh: fresh ? new Set(fresh) : undefined,
  });

  it('АЗС: 1 + ⌊жителей/6000⌋, не больше 3, — из магазинов, контор и складов у края, вдали друг от друга; топливо — им', () => {
    for (const [pop, want] of [
      [800, 1],
      [6000, 2],
      [13_000, 3],
      [40_000, 3],
    ] as const) {
      const t = city(pop, ['food', 'fuel', 'construction']);
      for (let i = 0; i < 6; i++) t.buildings.push(com('shop', Math.cos(i * 1.1) * 560, Math.sin(i * 1.1) * 560));
      zoneRetail(t, sites());
      const fuel = t.buildings.filter((b) => b.form === 'fuel');
      expect(fuel.length).toBe(want);
      expect(fuelCount(t)).toBe(want);
      // Вдали друг от друга (не ближе полрадиуса).
      for (const a of fuel) for (const b of fuel) if (a !== b) expect(Math.hypot(a.fp.center.x - b.fp.center.x, a.fp.center.y - b.fp.center.y)).toBeGreaterThan(t.radius * 0.5);
      // Стройдвор остаётся: склад — единственный, нужен стройматериалам.
      expect(t.buildings.some((b) => b.form === 'warehouse')).toBe(true);
      t.receivers = pickReceivers(t, 0);
      expect(t.receivers.filter((r) => r.cargo.includes('fuel') && !r.depot).map((r) => r.b).sort()).toEqual(fuel.map((b) => b.id).sort());
      expect(legacyCargo(t)).toEqual([]);
      // Повторно — ничего нового: уже стоящие в счёт.
      expect(zoneRetail(t, sites())).toBe(0);
    }
    // Топливо городу не нужно — АЗС нет.
    const t = city(8000, ['food']);
    zoneRetail(t, sites());
    expect(t.buildings.some((b) => b.form === 'fuel')).toBe(false);
  });

  it('при росте — только из новых домов; стоящие в маршрутах не трогаются', () => {
    const t = city(2000, ['food', 'fuel']);
    const far = t.buildings.find((b) => b.form === 'warehouse')!;
    expect(zoneRetail(t, sites([far.id], []))).toBe(0);
    const fresh = com('shop', 0, 590);
    t.buildings.push(fresh);
    zoneRetail(t, sites([far.id], [fresh.id]));
    expect(fresh.form).toBe('fuel');
    expect(far.form).toBe('warehouse');
  });

  it('оптовая база: одна от 2500 жителей, получатель всего, что просит город, но не потребитель — не в норме, не в «●●○»', () => {
    const small = city(2400, ['food', 'goods']);
    zoneRetail(small, sites());
    expect(small.buildings.some((b) => b.form === 'depot')).toBe(false);
    const t = city(4000, ['food', 'goods']);
    zoneRetail(t, sites());
    const depots = t.buildings.filter((b) => b.form === 'depot');
    expect(depots.length).toBe(1);
    expect(depotCount(t)).toBe(1);
    t.receivers = pickReceivers(t, 0);
    const d = depotOf(t)!;
    expect(d.b).toBe(depots[0].id);
    expect(d.cargo.sort()).toEqual(['food', 'goods']);
    expect(d.w).toBe(0);
    expect(receiverNeed(t, d, 'food')).toBe(0);
    expect(roomFor(t, d, 'food', 0)).toBe(0);
    expect(acceptAt(t, d, 'food', 10, 0)).toBe(0);
    const shopsOnly = t.receivers.filter((r) => r.cargo.includes('food') && !r.depot).length;
    expect(stockedCount(t, 'food', 0).total).toBe(shopsOnly);
    expect(townRoom(t, 'food', 0, 1)).toBeGreaterThan(0);
    // Доля нормы магазинов — та же, что без базы.
    const sum = t.receivers.filter((r) => r.cargo.includes('food')).reduce((s, r) => s + receiverNeed(t, r, 'food'), 0);
    expect(sum).toBeCloseTo(townNeed(4000));
    expect(maxTruck(depots[0])).toBe(RETAIL.maxLength.yard);
  });

  it('рыба на рынке: в счёт продуктов, не больше трети нормы за месяц; в конце месяца счёт — с нуля', () => {
    const t = city(4000, ['food']);
    t.receivers = pickReceivers(t, 0, new Set(), () => true, { fish: true });
    const market = t.receivers.find((r) => t.buildings.find((b) => b.id === r.b)!.form === 'market')!;
    expect(market.cargo).toEqual(['food', 'fish']);
    // Только рынок.
    expect(t.receivers.filter((r) => r.cargo.includes('fish'))).toEqual([market]);
    const third = Math.floor(townNeed(4000) / 3);
    market.stock.fish = 0;
    const took = acceptAt(t, market, 'fish', 100, 0);
    expect(took).toBe(third);
    expect(t.supplied.food).toBe(third);
    expect(t.supplied.fish).toBeUndefined();
    // До конца месяца больше не берёт, даже если склад опустел.
    expect(acceptAt(t, market, 'fish', 100, MONTH_LENGTH * 0.9)).toBe(0);
    markDry(t, MONTH_LENGTH);
    expect(acceptAt(t, market, 'fish', 100, MONTH_LENGTH * 2)).toBe(third);
    // Без рыбаков на карте — рыбы не берёт.
    expect(pickReceivers(city(4000, ['food']), 0).some((r) => r.cargo.includes('fish'))).toBe(false);
  });

  it('пустой склад в конце месяца — в счёт месяцев подряд; привезли — счёт с нуля', () => {
    const t = city(2000, ['food']);
    t.receivers = pickReceivers(t, 0);
    const r = t.receivers[1];
    r.stock.food = 0;
    markDry(t, 0);
    expect(r.dry).toBe(1);
    expect(receiverDry(r)).toBe(false);
    markDry(t, 0);
    expect(receiverDry(r)).toBe(true);
    expect(receiverStocked(t, r, 0)).toBe(false);
    expect(acceptAt(t, r, 'food', 5, 0)).toBe(5);
    expect(r.fed).toBe(true);
    expect(receiverStocked(t, r, 0)).toBe(true);
    markDry(t, 0);
    expect(r.dry).toBeUndefined();
    // Подбор заново сохраняет счёт и отметку «снабжали».
    r.dry = 2;
    const next = pickReceivers(t, 0);
    expect(receiverOf({ receivers: next }, r.b)).toMatchObject({ dry: 2, fed: true });
  });
});
