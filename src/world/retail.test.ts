import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import type { HouseForm, Town, TownBuilding } from './entities';
import {
  acceptAt,
  legacyCargo,
  pickReceivers,
  RETAIL,
  receiverNeed,
  receiverOf,
  receiverWeight,
  roomFor,
  stockAt,
  stockCap,
  stockedCount,
  stockFill,
  townRoom,
  unloadTime,
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
    // Топливо — до АЗС (этап 3) некому: город принимает его по-старому.
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
