import { describe, expect, it } from 'vitest';
import { COST, STORAGE } from '../config';
import { add, scale } from '../core/vec';
import type { TownBuilding } from '../world/entities';
import { DEFAULT_SETTINGS } from '../world/settings';
import { advise } from './advisor';
import { Game } from './game';
import { stationAtIndustry } from './testkit';

/** Песочница: станции у сырья и у завода, маршрут с грузовиком. */
function setup() {
  const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
  game.money = 5_000_000;
  const plant = game.industries.find((i) => i.info.accepts.length === 1)!;
  const input = plant.info.accepts[0];
  const near = (a: { fp: { center: { x: number; y: number } } }) => Math.hypot(a.fp.center.x - plant.fp.center.x, a.fp.center.y - plant.fp.center.y);
  const raw = game.industries.filter((i) => i.info.produces === input).sort((a, b) => near(a) - near(b))[0];
  const a = stationAtIndustry(game, raw, plant.fp.center)!;
  const b = stationAtIndustry(game, plant, raw.fp.center)!;
  const line = game.createLine([a.id, b.id])!;
  for (let i = 0; i < 8; i++) game.buyVehicle(line.id, 'truck');
  return { game, raw, plant, input, a, b, line };
}

describe('Склад станции', () => {
  it('у новой автостанции — 200 мест на все грузы вместе; продукция и груз на пересадку — не больше свободного места', () => {
    const { game, a, raw, input } = setup();
    expect(game.stationStorage(a)).toBe(STORAGE.base);
    expect(STORAGE.base).toBeLessThan(400);
    // Почти полный склад: предприятие кладёт только то, что помещается.
    a.cargo[input] = STORAGE.base - 5;
    raw.output = 50;
    game.speed = 1;
    game.update(0.1);
    expect(game.stationStored(a)).toBeLessThanOrEqual(STORAGE.base);
    expect(game.stationFree(a)).toBeLessThanOrEqual(5);
    expect(game.stationFull(a)).toBe(true);
  });

  it('пристройка-склад: +150 мест, площадка длиннее, посты на месте; Ctrl+Z, сохранение и снос возвращают деньги', () => {
    const { game, a } = setup();
    const w = a.fp.w;
    const area = game.bayArea(a);
    const money = game.money;
    expect(game.setStationDepots(a.id, 1)).toBeNull();
    expect(a.depots).toBe(1);
    expect(a.fp.w).toBeCloseTo(w + STORAGE.width);
    expect(game.stationStorage(a)).toBe(STORAGE.base + STORAGE.per);
    expect(game.money).toBe(money - STORAGE.cost);
    // Посты — в той же части площадки: пристройки по концам.
    expect(game.bayArea(a).w).toBeCloseTo(area.w);
    // Ctrl+Z возвращает и площадку, и деньги.
    expect(game.undo()).toBe('склад станции');
    expect(a.depots ?? 0).toBe(0);
    expect(a.fp.w).toBeCloseTo(w);
    expect(game.money).toBe(money);
    // Пристройки сохраняются.
    expect(game.setStationDepots(a.id, 2)).toBeNull();
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    const la = loaded.stations.get(a.id)!;
    expect(la.depots).toBe(2);
    expect(loaded.stationStorage(la)).toBe(STORAGE.base + 2 * STORAGE.per);
    // Снести пристройку — часть цены вернётся; груз не помещается на меньший склад — нельзя.
    const before = game.money;
    expect(game.setStationDepots(a.id, 1)).toBeNull();
    expect(game.money).toBe(before + Math.round(STORAGE.cost * COST.refundRatio));
    a.cargo.grain = STORAGE.base + STORAGE.per - 10;
    a.cargo.logs = 50;
    expect(game.setStationDepots(a.id, 0)).toMatch(/не поместится/);
    // Больше максимума — нельзя.
    expect(game.stationDepotsPlan(a.id, STORAGE.max + 1).ok).toBe(false);
  });

  it('пристройка занимает место: дом у конца площадки мешает', () => {
    const { game, a } = setup();
    const town = game.towns[0];
    const u = { x: Math.cos(a.fp.angle), y: Math.sin(a.fp.angle) };
    const house: TownBuilding = {
      type: 'building',
      id: 990_001,
      townId: town.id,
      fp: { center: add(a.fp.center, scale(u, a.fp.w / 2 + 6)), w: 8, h: 8, angle: a.fp.angle },
      kind: 'res',
      floors: 2,
      anchor: town.buildings[0]?.anchor ?? 0,
      color: '#d9c9a8',
      roof: '#a0603c',
    };
    town.buildings.push(house);
    game.index.add(house);
    expect(game.stationDepotsPlan(a.id, 1)).toMatchObject({ ok: false, reason: 'Мешает здание' });
  });

  it('склад полон, а завод работает — советник предлагает пристроить склад; полный склад тормозит рост', () => {
    const { game, a, raw, input } = setup();
    raw.producedLast = 60;
    a.cargo[input] = STORAGE.base;
    const advice = advise(game).find((x) => x.kind === 'storage');
    expect(advice).toMatchObject({ level: 'warn', station: a.id, fix: { kind: 'depot', station: a.id } });
    a.depots = STORAGE.max;
    expect(advise(game).find((x) => x.kind === 'storage')?.fix).toBeUndefined();
    a.depots = 0;
    // Полный склад копит «затоваривание» — предприятие не растёт.
    raw.piledMonth = 0;
    game.speed = 1;
    for (let t = 0; t < 2; t += 0.1) game.update(0.1);
    expect(raw.piledMonth ?? 0).toBeGreaterThan(0);
  });
});
