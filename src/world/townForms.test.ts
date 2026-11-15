import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { freshGame } from '../game/testkit';
import { Game, type SaveData } from '../game/game';
import type { HouseForm, Town, TownBuilding } from './entities';
import { NEW_GAME_SETTINGS } from './settings';
import { formOf, inDistrict, mergeBlocks, pickPublic, placeForm, townTier, TOWN_TIER, zoneTown } from './townForms';
import { recountPopulation } from './worldgen';

let nextId = 100;

function house(x: number, y: number, o: Partial<TownBuilding> = {}): TownBuilding {
  return {
    type: 'building',
    id: nextId++,
    townId: 1,
    fp: { center: { x, y }, w: 20, h: 18, angle: 0 },
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
  it('село, город, большой город — по населению; кольцевой город — не село', () => {
    expect(townTier({ population: 1500, style: 'linear' })).toBe('village');
    expect(townTier({ population: TOWN_TIER.town, style: 'organic' })).toBe('town');
    expect(townTier({ population: 1500, style: 'radial' })).toBe('town');
    expect(townTier({ population: TOWN_TIER.city, style: 'organic' })).toBe('city');
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
    expect(placeForm(t, at({ x: 60, y: 0 }, { fp: { center: { x: 60, y: 0 }, w: 30, h: 25, angle: 0 }, floors: 4 }))).toBe('courtyard');
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
    expect(placeForm(t, at(p, { fp: { center: p, w: 30, h: 25, angle: 0 }, floors: 4 }))).toBe('slab');
    expect(placeForm(t, at(p, { kind: 'com' }))).toBe('shop');
    // У села рамка нового района не в счёт.
    expect(placeForm(town(1500, [], { district, style: 'linear' }), at(p))).toBe('cottage');
  });

  it('без выбранного типа — по виду и размеру (тестовые сцены)', () => {
    expect(formOf(house(0, 0))).toBe('cottage');
    expect(formOf(house(0, 0, { floors: 3 }))).toBe('townhouse');
    expect(formOf(house(0, 0, { fp: { center: { x: 0, y: 0 }, w: 30, h: 24, angle: 0 } }))).toBe('courtyard');
    expect(formOf(house(0, 0, { kind: 'com' }))).toBe('shop');
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
    expect(t.buildings.filter((b) => b.kind === 'res').every((b) => b.form === 'cottage')).toBe(true);
    expect(t.buildings.some((b) => b.form === 'market' || b.form === 'hospital')).toBe(false);
  });
});

describe('Панельные дома нового района', () => {
  /** Ряд участков вдоль улицы (ось x), у каждого второго — дом второго ряда; улица — со стороны −y. */
  function row(n: number, floors = 2): TownBuilding[] {
    const out: TownBuilding[] = [];
    for (let i = 0; i < n; i++) {
      out.push(house(i * 25, 0, { floors }));
      if (i % 2) out.push(house(i * 25, 24, { floors: 1, fp: { center: { x: i * 25, y: 24 }, w: 18, h: 16, angle: 0 } }));
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
    const shop = house(25, 0, { kind: 'com', floors: 3 });
    const b = house(50, 0);
    const c = house(75, 0);
    const across = house(0, -40, { face: 1 });
    const t = town(0, [a, shop, b, c, across]);
    mergeBlocks(t, ops());
    expect(t.buildings).toContain(shop);
    expect(t.buildings).toContain(a);
    expect(t.buildings).toContain(across);
    expect(t.buildings.find((x) => x.id === b.id)?.form).toBe('slab');
    expect(t.buildings.find((x) => x.id === b.id)?.floors).toBe(4);
  });
});

describe('Застройка в партии', () => {
  it('мир по seed: у всех домов есть тип и сторона улицы, жители — по-прежнему по этажам; панельные дома — в новом районе', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
    const all = g.towns.flatMap((t) => t.buildings);
    expect(all.every((b) => b.form && b.face)).toBe(true);
    for (const t of g.towns) {
      const pop = t.population;
      recountPopulation(t);
      expect(t.population).toBe(pop);
    }
    const forms = new Set(all.map((b) => b.form));
    for (const f of ['cottage', 'townhouse', 'courtyard', 'slab', 'shop', 'school', 'market', 'hall'] as const) expect(forms).toContain(f);
    const withDistrict = g.towns.find((t) => t.district && t.buildings.some((b) => b.form === 'slab'));
    expect(withDistrict).toBeTruthy();
  });

  it('старое сохранение без типов: типы и стороны улиц — при загрузке, жителей столько же', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 2 });
    const save = JSON.parse(JSON.stringify(g.toSave())) as SaveData;
    const pop = save.towns.map((t) => t.population);
    for (const t of save.towns) {
      delete t.district;
      for (const b of t.buildings) {
        delete b.form;
        delete b.face;
      }
    }
    const loaded = new Game(structuredClone(g.settings), save);
    expect(loaded.towns.map((t) => t.population)).toEqual(pop);
    const all = loaded.towns.flatMap((t) => t.buildings);
    expect(all.every((b) => b.form && (b.face === 1 || b.face === -1))).toBe(true);
    // Сторона улицы старого дома — та же, что знал генератор.
    const known = new Map(g.towns.flatMap((t) => t.buildings).map((b) => [b.id, b.face]));
    const same = all.filter((b) => b.kind !== 'landmark' && known.get(b.id) === b.face).length;
    expect(same / all.length).toBeGreaterThan(0.9);
  });
});
