import { describe, expect, it } from 'vitest';
import { TOWN_SCALE } from '../config';
import type { Vec } from '../core/vec';
import { freshGame } from '../game/testkit';
import { Game, type SaveData } from '../game/game';
import type { HouseForm, Town, TownBuilding } from './entities';
import { NEW_GAME_SETTINGS } from './settings';
import {
  flatsOf,
  formOf,
  growTier,
  inDistrict,
  LEGACY_TIER,
  mergeBlocks,
  mergeTowers,
  pickPublic,
  placeForm,
  RES_PER_FLOOR,
  residentsOf,
  SETTLE_RULE,
  storeysOf,
  tierOfSize,
  towerQuota,
  townTier,
  TOWN_TIER,
  villageFlats,
  zoneTown,
} from './townForms';
import { recountPopulation } from './worldgen';

let nextId = 100;
/** Размеры участков в тесте — в прежних метрах, умноженных на масштаб застройки (config.TOWN_SCALE). */
const S = TOWN_SCALE;
/** Участок w × h (прежние метры) с серединой в p. */
const lot = (p: Vec, w: number, h: number) => ({ center: p, w: w * S, h: h * S, angle: 0 });

function house(x: number, y: number, o: Partial<TownBuilding> = {}): TownBuilding {
  return {
    type: 'building',
    id: nextId++,
    townId: 1,
    fp: lot({ x, y }, 20, 18),
    kind: 'res',
    floors: 2,
    anchor: 0,
    color: '#efe3cf',
    roof: '#b9654d',
    face: -1,
    ...o,
  };
}

function town(population: number, buildings: TownBuilding[] = [], o: Partial<Town> = {}): Town {
  return {
    id: 1,
    name: 'Тест',
    center: { x: 0, y: 0 },
    radius: 400,
    top: 0,
    style: 'organic',
    population,
    buildings,
    streets: [],
    demands: [],
    supplied: {},
    lastSupplied: {},
    tripAcc: 0,
    growthAcc: 0,
    ...o,
  };
}

const at = (p: Vec, o: Partial<TownBuilding> = {}) => house(p.x, p.y, o);

describe('Типы застройки по месту в городе', () => {
  it('ярус — свой у города: новый — по размеру генерации, растёт по населению и не убывает; без него — по прежним порогам', () => {
    // Старое сохранение и тестовые сцены без яруса — по населению и прежним порогам; кольцевой город — не село.
    expect(townTier({ population: 1500, style: 'linear' })).toBe('village');
    expect(townTier({ population: LEGACY_TIER.town, style: 'organic' })).toBe('town');
    expect(townTier({ population: 1500, style: 'radial' })).toBe('town');
    expect(townTier({ population: LEGACY_TIER.city, style: 'organic' })).toBe('city');
    // Новый город — по размеру генерации.
    expect([1, 2, 3].map((s) => tierOfSize(s, 'organic'))).toEqual(['village', 'town', 'city']);
    expect(tierOfSize(1, 'radial')).toBe('town');
    // Свой ярус — важнее населения; дорос — выше, убыло — не ниже.
    expect(townTier({ population: 100, style: 'organic', tier: 'town' })).toBe('town');
    const t = town(TOWN_TIER.town - 1, [], { tier: 'village' });
    growTier(t);
    expect(t.tier).toBe('village');
    t.population = TOWN_TIER.town;
    growTier(t);
    expect(t.tier).toBe('town');
    t.population = TOWN_TIER.city;
    growTier(t);
    expect(t.tier).toBe('city');
    t.population = 10;
    growTier(t);
    expect(t.tier).toBe('city');
  });

  it('в селе — частные дома с участками и сельский магазин, в центре — храм', () => {
    const t = town(1800, [], { style: 'linear' });
    expect(placeForm(t, at({ x: 10, y: 0 }))).toBe('cottage');
    expect(placeForm(t, at({ x: 380, y: 0 }))).toBe('cottage');
    expect(placeForm(t, at({ x: 50, y: 0 }, { kind: 'com' }))).toBe('store');
    expect(placeForm(t, at({ x: 0, y: 0 }, { kind: 'landmark' }))).toBe('temple');
  });

  it('в городе: у центра — старый центр, на краю — частный сектор, гаражи и склады; ратуша', () => {
    const t = town(4000);
    expect(placeForm(t, at({ x: 60, y: 0 }))).toBe('townhouse');
    expect(placeForm(t, at({ x: 60, y: 0 }, { fp: lot({ x: 60, y: 0 }, 36, 30), floors: 4 }))).toBe('courtyard');
    expect(placeForm(t, at({ x: 300, y: 0 }))).toBe('cottage');
    expect(['garages', 'warehouse']).toContain(placeForm(t, at({ x: 330, y: 0 }, { kind: 'com' })));
    expect(placeForm(t, at({ x: 0, y: 0 }, { kind: 'landmark' }))).toBe('hall');
    // Дачи — только одноэтажные дома за краем плотной застройки.
    const far = Array.from({ length: 40 }, (_, i) => placeForm(t, at({ x: 420 + i, y: 0 }, { floors: 1 })));
    expect(far).toContain('dacha');
    expect(far.every((f) => f === 'dacha' || f === 'cottage')).toBe(true);
  });

  it('в новом районе — панельные дома и магазины', () => {
    const district = { x: 0, y: 0, angle: 0.4, u0: 150, u1: 350, v0: -100, v1: 100 };
    const t = town(5000, [], { district });
    const p = { x: Math.cos(0.4) * 250, y: Math.sin(0.4) * 250 };
    expect(inDistrict(district, p)).toBe(true);
    expect(inDistrict(district, { x: 0, y: 0 })).toBe(false);
    expect(placeForm(t, at(p, { fp: lot(p, 36, 30), floors: 4 }))).toBe('slab');
    expect(placeForm(t, at(p, { kind: 'com' }))).toBe('shop');
    // У села рамка нового района не в счёт.
    expect(placeForm(town(1500, [], { district, style: 'linear' }), at(p))).toBe('cottage');
  });

  it('без выбранного типа — по виду и размеру (тестовые сцены)', () => {
    expect(formOf(house(0, 0))).toBe('cottage');
    expect(formOf(house(0, 0, { floors: 3 }))).toBe('townhouse');
    expect(formOf(house(0, 0, { fp: lot({ x: 0, y: 0 }, 36, 30) }))).toBe('courtyard');    expect(formOf(house(0, 0, { kind: 'com' }))).toBe('shop');
    expect(formOf(house(0, 0, { kind: 'landmark' }))).toBe('hall');
    expect(formOf(house(0, 0, { form: 'school' }))).toBe('school');
  });
});

describe('Общественные здания', () => {
  const shops = () => Array.from({ length: 12 }, (_, i) => house(30 * i, 40, { kind: 'com', form: i % 2 ? 'office' : 'shop' }));

  it('городу — рынок, школа, больница; большому — ещё школы и церковь; уже стоящие — в счёт', () => {
    const t = town(4000, shops());
    pickPublic(t);
    const count = (f: HouseForm) => t.buildings.filter((b) => b.form === f).length;
    expect([count('market'), count('school'), count('hospital')]).toEqual([1, 1, 1]);
    const before = t.buildings.map((b) => b.form);
    pickPublic(t);
    expect(t.buildings.map((b) => b.form)).toEqual(before);
    const city = town(13000, shops());
    pickPublic(city);
    expect(city.buildings.filter((b) => b.form === 'school').length).toBe(3);
    expect(city.buildings.filter((b) => b.form === 'church').length).toBe(1);
  });

  it('селу — только школа; жилые дома под общественные не отдаются', () => {
    const t = town(1500, [...shops().slice(0, 3), house(0, 0), house(30, 0)], { style: 'linear' });
    zoneTown(t);
    expect(t.buildings.filter((b) => b.form === 'school').length).toBe(1);
    expect(t.buildings.filter((b) => b.kind === 'res').every((b) => b.form === 'cottage' || b.form === 'walkup')).toBe(true);
    expect(t.buildings.some((b) => b.form === 'market' || b.form === 'hospital')).toBe(false);
  });
});

describe('Жители по домам', () => {
  /** Село: улица вдоль оси x, дома по обе стороны (участки 26 × 24 прежних метров), у каждого — 1–3 этажа генерации. */
  function village(n: number): Town {
    const list: TownBuilding[] = [];
    for (let i = 0; i < n; i++) {
      const p = { x: (-n * 15 + i * 30) * S, y: (i % 2 ? 22 : -22) * S };
      list.push(house(p.x, p.y, { floors: 1 + (i % 3), face: i % 2 ? -1 : 1, fp: lot(p, 26, 24) }));
    }
    const t = town(0, list, { style: 'linear', radius: n * 15 * S, tier: 'village' });
    recountPopulation(t);
    return t;
  }

  it('село — частные дома на 3–6 человек и у большого села 1–3 двухэтажных многоквартирных у центра; жители — сумма по домам', () => {
    expect([20, 40, 60, 90].map(villageFlats)).toEqual([0, 1, 2, 3]);
    const t = village(60);
    zoneTown(t);
    recountPopulation(t);
    expect(t.buildings.every((b) => b.people !== undefined)).toBe(true);
    expect(t.population).toBe(t.buildings.reduce((s, b) => s + residentsOf(b), 0));
    const cottages = t.buildings.filter((b) => b.form === 'cottage');
    const flats = t.buildings.filter((b) => b.form === 'walkup');
    expect(flats.length).toBe(villageFlats(60));
    expect(cottages.length).toBe(60 - flats.length);
    for (const b of cottages) {
      expect(residentsOf(b)).toBeGreaterThanOrEqual(3);
      expect(residentsOf(b)).toBeLessThanOrEqual(6);
      expect(storeysOf(b)).toBeLessThanOrEqual(2);
    }
    for (const b of flats) {
      expect(storeysOf(b)).toBe(2);
      expect(residentsOf(b)).toBeGreaterThan(14);
      expect(residentsOf(b)).toBeLessThan(60);
      // У самого центра.
      expect(Math.abs(b.fp.center.x)).toBeLessThan(t.radius * 0.45);
    }
    // Квартир — по жильцам, у частного дома — одна семья.
    expect(flatsOf(cottages[0])).toBe(1);
    expect(flatsOf(flats[0])).toBeGreaterThan(4);
    // Сельчан — по жильцам: в разы меньше прежних 14 на этаж генерации.
    expect(t.population * 3).toBeLessThan(t.buildings.reduce((s, b) => s + b.floors * RES_PER_FLOOR, 0));
  });

  it('старое сохранение: многоквартирные дома села сверх 1–3 — снова частные; новые дома растущего села — частные; расселённые не меняются', () => {
    const t = village(40);
    for (const b of t.buildings.slice(10, 30)) b.form = 'walkup';
    zoneTown(t);
    recountPopulation(t);
    expect(t.buildings.filter((b) => b.form === 'walkup').length).toBe(villageFlats(40));
    const forms = new Map(t.buildings.map((b) => [b.id, `${b.form}|${b.people}`]));
    const pop = t.population;
    const fresh = [house(700 * S, 22 * S, { floors: 2 }), house(730 * S, 22 * S, { floors: 2 })];
    t.buildings.push(...fresh);
    zoneTown(t);
    recountPopulation(t);
    expect(fresh.every((b) => b.form === 'cottage' && residentsOf(b) <= 6)).toBe(true);
    expect(t.population).toBe(pop + fresh.reduce((s, b) => s + residentsOf(b), 0));
    for (const b of t.buildings) if (forms.has(b.id)) expect(`${b.form}|${b.people}`).toBe(forms.get(b.id));
  });

  it('город: многоквартирный дом — по вместимости корпуса на проектных этажах; тесный участок — не многоквартирный', () => {
    const t = town(4000, [], { tier: 'town' });
    const big = house(0, 0, { form: 'walkup', floors: 2, fp: lot({ x: 0, y: 0 }, 28, 26) });
    const small = house(0, 0, { form: 'walkup', floors: 2, fp: lot({ x: 0, y: 0 }, 28, 26) });
    t.buildings.push(big, small);
    zoneTown(t);
    expect(residentsOf(big)).toBeGreaterThan(20);
    expect(residentsOf(big)).toBeLessThan(40);
    // В среднем кольце узкий участок (второй ряд) — частный дом, а не тесный многоквартирный.
    const mid = { x: 0.48 * t.radius, y: 0 };
    const narrow = house(mid.x, mid.y, { floors: 2, fp: lot(mid, 18, 20) });
    const forms = Array.from({ length: 30 }, (_, i) => placeForm(t, { ...narrow, id: 5000 + i }));
    expect(forms).not.toContain('walkup');
    expect(SETTLE_RULE).toBeGreaterThan(1);
  });

  it('этажи многоквартирного дома — по жильцам, но не ниже проекта; у старых и тестовых домов без жильцов — по этажам генерации', () => {
    const slab = house(0, 0, { form: 'slab', floors: 5, fp: lot({ x: 0, y: 0 }, 80, 30) });
    expect(residentsOf(slab)).toBe(5 * RES_PER_FLOOR);
    expect(storeysOf(slab)).toBe(5);
    expect(storeysOf({ ...slab, people: 1000 })).toBeGreaterThan(5);
    expect(storeysOf({ ...slab, people: 100_000 })).toBeLessThanOrEqual(16);
    expect(storeysOf(house(0, 0, { form: 'walkup', floors: 2, people: 20 }))).toBe(2);
    expect(residentsOf(house(0, 0, { kind: 'com', floors: 3 }))).toBe(0);
  });
});

describe('Панельные дома нового района', () => {
  /** Ряд участков вдоль улицы (ось x), у каждого второго — дом второго ряда; улица — со стороны −y. */
  function row(n: number, floors = 2): TownBuilding[] {
    const out: TownBuilding[] = [];
    for (let i = 0; i < n; i++) {
      out.push(house(i * 25 * S, 0, { floors }));
      if (i % 2) out.push(house(i * 25 * S, 24 * S, { floors: 1, fp: lot({ x: i * 25 * S, y: 24 * S }, 18, 16) }));
    }
    return out;
  }
  const ops = (fits = () => true) => ({ eligible: () => true, fits, remove: () => {}, add: () => {} });

  it('соседние участки сливаются в дома ~5 этажей: этажей и жителей ровно столько же, id и сторона улицы — у первого', () => {
    const list = row(6);
    const t = town(0, list);
    recountPopulation(t);
    const pop = t.population;
    const firstId = list[0].id;
    expect(mergeBlocks(t, ops())).toBeGreaterThan(0);
    recountPopulation(t);
    expect(t.population).toBe(pop);
    expect(t.buildings.length).toBeLessThan(list.length);
    const slabs = t.buildings.filter((b) => b.form === 'slab');
    expect(slabs.length).toBeGreaterThan(0);
    expect(slabs[0].id).toBe(firstId);
    expect(slabs.every((b) => b.face === -1 && b.floors >= 3 && b.floors <= 8)).toBe(true);
    // Длинный корпус: вдоль улицы длиннее, чем вглубь.
    expect(slabs.every((b) => b.fp.w > b.fp.h)).toBe(true);
  });

  it('нет места под общий контур — дома остаются как были', () => {
    const list = row(4);
    const t = town(0, [...list]);
    expect(mergeBlocks(t, ops(() => false))).toBe(0);
    expect(t.buildings).toEqual(list);
  });

  it('офис посреди ряда его разрывает; дома на другой стороне улицы — отдельный ряд', () => {
    const a = house(0, 0);
    const shop = house(25 * S, 0, { kind: 'com', floors: 3 });
    const b = house(50 * S, 0);
    const c = house(75 * S, 0);
    const across = house(0, -40 * S, { face: 1 });
    const t = town(0, [a, shop, b, c, across]);
    mergeBlocks(t, ops());
    expect(t.buildings).toContain(shop);
    expect(t.buildings).toContain(a);
    expect(t.buildings).toContain(across);
    expect(t.buildings.find((x) => x.id === b.id)?.form).toBe('slab');
    expect(t.buildings.find((x) => x.id === b.id)?.floors).toBe(4);
  });
});

describe('Высотки: два дома квартала спиной к спине', () => {
  const district = { x: 0, y: 0, angle: 0, u0: -500, u1: 500, v0: -500, v1: 500 };
  /** Дом у улицы с юга (y = −30) и дом у улицы с севера (y = 30): задние стороны — друг к другу. */
  const pair = () => [
    house(0, -18 * S, { form: 'slab', floors: 5, fp: lot({ x: 0, y: -18 * S }, 60, 20), face: -1 }),
    house(5 * S, 18 * S, { form: 'slab', floors: 6, fp: lot({ x: 5 * S, y: 18 * S }, 55, 20), face: 1 }),
  ];
  const ops = (fronted = true, fits = true) => ({ fits: () => fits, fronted: () => fronted, remove: () => {}, add: () => {} });

  it('в новом районе большого города сливаются в одну башню: этажей — сумма, участок — от улицы до улицы', () => {
    const t = town(9000, pair(), { district, id: 4 });
    const [a] = t.buildings;
    expect(mergeTowers(t, ops())).toBe(1);
    expect(t.buildings).toHaveLength(1);
    expect(t.buildings[0]).toMatchObject({ id: a.id, form: 'tower', floors: 11, face: -1 });
    expect(t.buildings[0].fp.h).toBeCloseTo(56 * S);
  });

  it('не сливаются: улица осталась бы пустой, участок задел бы улицу, дома стоят лицом друг к другу, мало этажей', () => {
    expect(mergeTowers(town(9000, pair(), { district }), ops(false))).toBe(0);
    expect(mergeTowers(town(9000, pair(), { district }), ops(true, false))).toBe(0);
    const facing = pair().map((b) => ({ ...b, face: (b.face === 1 ? -1 : 1) as 1 | -1 }));
    expect(mergeTowers(town(9000, facing, { district }), ops())).toBe(0);
    expect(mergeTowers(town(9000, pair().map((b) => ({ ...b, floors: 3 })), { district }), ops())).toBe(0);
    expect(mergeTowers(town(9000, pair()), ops())).toBe(0);
  });

  it('сколько на город: у большого 1–3, у города 0–1, у села нет', () => {
    for (let id = 1; id < 40; id++) {
      expect(towerQuota({ id, population: 9000, style: 'radial' })).toBeGreaterThanOrEqual(1);
      expect(towerQuota({ id, population: 9000, style: 'radial' })).toBeLessThanOrEqual(3);
      expect(towerQuota({ id, population: 4000, style: 'organic' })).toBeLessThanOrEqual(1);
      expect(towerQuota({ id, population: 2000, style: 'linear' })).toBe(0);
    }
  });
});

describe('Застройка в партии', () => {
  it('мир по seed: у всех домов есть тип, сторона улицы и жильцы; ярусы — по размеру; сёла — частные дома, в городах — панельные', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
    const all = g.towns.flatMap((t) => t.buildings);
    expect(all.every((b) => b.form && b.face)).toBe(true);
    for (const t of g.towns) {
      const pop = t.population;
      recountPopulation(t);
      expect(t.population).toBe(pop);
      expect(t.tier).toBeTruthy();
      expect(t.settled).toBe(SETTLE_RULE);
      // Село — частные дома, многоквартирных — не больше трёх; сельчан — меньше порога города.
      if (t.tier === 'village') {
        expect(t.buildings.filter((b) => b.form === 'walkup').length).toBeLessThanOrEqual(3);
        expect(t.population).toBeLessThan(TOWN_TIER.town);
      }
    }
    const res = all.filter((b) => b.kind === 'res');
    expect(res.every((b) => b.people !== undefined)).toBe(true);
    expect(res.filter((b) => b.form === 'cottage').every((b) => b.people! >= 3 && b.people! <= 6 && storeysOf(b) <= 2)).toBe(true);
    // В панельном доме — сотни жильцов.
    expect(Math.max(...res.filter((b) => b.form === 'slab').map((b) => b.people!))).toBeGreaterThan(150);
    const forms = new Set(all.map((b) => b.form));
    for (const f of ['cottage', 'walkup', 'townhouse', 'courtyard', 'slab', 'shop', 'school', 'market', 'hall'] as const) expect(forms).toContain(f);
    const withDistrict = g.towns.find((t) => t.district && t.buildings.some((b) => b.form === 'slab'));
    expect(withDistrict).toBeTruthy();
  });

  it('старое сохранение без яруса, типов и жильцов: всё — при загрузке; население — по жильцам, ярус — по прежнему населению', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 2 });
    const save = JSON.parse(JSON.stringify(g.toSave())) as SaveData;
    const tiers = g.towns.map((t) => t.tier);
    for (const t of save.towns) {
      delete t.district;
      delete t.tier;
      delete t.settled;
      for (const b of t.buildings) {
        delete b.form;
        delete b.face;
        delete b.people;
        delete b.rear;
      }
      // Население старого сохранения — прежнее, по 14 жителей на этаж каждого дома.
      t.population = t.buildings.reduce((s, b) => s + (b.kind === 'res' ? b.floors * RES_PER_FLOOR : b.kind === 'com' ? b.floors * 4 : 0), 0);
    }
    const old = save.towns.map((t) => t.population);
    const loaded = new Game(structuredClone(g.settings), save);
    for (const [i, t] of loaded.towns.entries()) {
      expect(t.population).toBe(t.buildings.reduce((s, b) => s + (b.kind === 'res' ? residentsOf(b) : b.kind === 'com' ? b.floors * 4 : 0), 0));
      // Сельчан — в разы меньше прежнего (в частном доме 3–6 человек, а не 14 на этаж).
      if (t.tier === 'village') expect(t.population).toBeLessThan(old[i] * 0.6);
      expect(t.settled).toBe(SETTLE_RULE);
      expect(t.tier).toBe(townTier({ population: old[i], style: t.style }));
    }
    // Ярус по прежнему населению — как у генератора (кроме городов на границе порогов).
    expect(loaded.towns.filter((t, i) => t.tier === tiers[i]).length).toBeGreaterThanOrEqual(8);
    // Дома второго ряда — узнаны по расстоянию до улицы.
    const rear = new Set(g.towns.flatMap((t) => t.buildings).filter((b) => b.rear).map((b) => b.id));
    const found = loaded.towns.flatMap((t) => t.buildings).filter((b) => rear.has(b.id) && b.rear).length;
    expect(found / Math.max(1, rear.size)).toBeGreaterThan(0.8);
    const all = loaded.towns.flatMap((t) => t.buildings);
    expect(all.every((b) => b.form && (b.face === 1 || b.face === -1))).toBe(true);
    expect(all.filter((b) => b.kind === 'res').every((b) => b.people !== undefined)).toBe(true);
    expect(all.filter((b) => b.form === 'cottage').every((b) => b.people! <= 6)).toBe(true);
    // Сторона улицы старого дома — та же, что знал генератор.
    const known = new Map(g.towns.flatMap((t) => t.buildings).map((b) => [b.id, b.face]));
    const same = all.filter((b) => b.kind !== 'landmark' && known.get(b.id) === b.face).length;
    expect(same / all.length).toBeGreaterThan(0.9);
  });
});
