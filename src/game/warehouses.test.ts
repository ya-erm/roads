import { describe, expect, it } from 'vitest';
import { COST, STORAGE } from '../config';
import { add, scale, type Vec } from '../core/vec';
import type { Station } from '../world/entities';
import { DEFAULT_SETTINGS } from '../world/settings';
import { footprintRadius } from '../world/spatial';
import { Game } from './game';
import { freshGame, stationAtIndustry, withoutCitizens } from './testkit';
import { storageSlots, warehouseZone } from './warehouses';

/** Автостанция у сырьевого предприятия. */
function setup() {
  const game = withoutCitizens(freshGame({ ...DEFAULT_SETTINGS, seed: 42 }));
  game.money = 5_000_000;
  const raw = game.industries.find((i) => !i.info.accepts.length)!;
  const st = stationAtIndustry(game, raw, { x: raw.fp.center.x + 600, y: raw.fp.center.y })!;
  return { game, st };
}

/** Первое место вокруг станции, где склад ставится (по кругу на расстоянии d от центра). */
function freeSpot(game: Game, st: Station, d = footprintRadius(st.fp) + 22): Vec {
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    const p = add(st.fp.center, scale({ x: Math.cos(a), y: Math.sin(a) }, d));
    if (game.warehousePlan(st.id, p).ok) return p;
  }
  throw new Error('Нет места под склад');
}

describe('Склады-здания станции', () => {
  it('ставится в зоне вокруг станции: +мест на складе, деньги списаны, здание на карте', () => {
    const { game, st } = setup();
    const money = game.money;
    const p = freeSpot(game, st);
    expect(game.buildWarehouse(st.id, p)).toBeNull();
    expect(st.warehouses).toHaveLength(1);
    expect(storageSlots(st)).toBe(1);
    expect(game.stationStorage(st)).toBe(STORAGE.base + STORAGE.per);
    expect(game.money).toBe(money - STORAGE.cost);
    // Здание — в пространственном индексе: его видно под курсором, по оси станции.
    const w = game.structureAt(p);
    expect(w).toMatchObject({ type: 'warehouse', stationId: st.id });
    expect(st.warehouses![0].fp.angle).toBe(st.fp.angle);
  });

  it('вне зоны, на станции, на другом складе, на дороге — нельзя, с понятной причиной', () => {
    const { game, st } = setup();
    const far = add(st.fp.center, { x: warehouseZone(st) + 40, y: 0 });
    expect(game.warehousePlan(st.id, far)).toMatchObject({ ok: false, reason: 'Склад — только рядом со станцией' });
    expect(game.warehousePlan(st.id, st.fp.center)).toMatchObject({ ok: false, reason: 'Мешает станция' });
    const p = freeSpot(game, st);
    expect(game.buildWarehouse(st.id, p)).toBeNull();
    expect(game.warehousePlan(st.id, add(p, { x: 3, y: 2 }))).toMatchObject({ ok: false, reason: 'Мешает склад' });
    // Выезд станции — дорога.
    const gate = game.roads.net.nodes.get(st.nodeId)!;
    expect(game.warehousePlan(st.id, gate.pos).reason).toMatch(/Мешает (дорога|станция)/);
    // Склад мешает и дальше: на его месте ничего не построить (он в индексе).
    expect(game.blocked(p, 2)).toBe(true);
  });

  it('складов вместе с пристройками — не больше STORAGE.max', () => {
    const { game, st } = setup();
    st.depots = STORAGE.max;
    expect(game.warehousePlan(st.id, freeSpotIgnoringMax(game, st)).reason).toBe(`Больше ${STORAGE.max} складов нельзя`);
  });

  it('снос: часть цены вернётся, места меньше; груз не помещается на меньший склад — нельзя', () => {
    const { game, st } = setup();
    const p = freeSpot(game, st);
    game.buildWarehouse(st.id, p);
    const w = st.warehouses![0];
    st.cargo.grain = STORAGE.base + 20;
    expect(game.removeWarehouse(w)).toMatch(/не поместится/);
    st.cargo = {};
    const money = game.money;
    expect(game.removeWarehouse(w)).toBeNull();
    expect(game.money).toBe(money + Math.round(STORAGE.cost * COST.refundRatio));
    expect(st.warehouses).toEqual([]);
    expect(game.stationStorage(st)).toBe(STORAGE.base);
    expect(game.structureAt(p)?.type).not.toBe('warehouse');
  });

  it('Ctrl+Z убирает поставленный склад вместе с местом на карте и возвращает деньги', () => {
    const { game, st } = setup();
    const money = game.money;
    const p = freeSpot(game, st);
    game.buildWarehouse(st.id, p);
    expect(game.undo()).toBe('склад станции');
    const live = game.stations.get(st.id)!;
    expect(live.warehouses ?? []).toEqual([]);
    expect(game.structureAt(p)?.type).not.toBe('warehouse');
    expect(game.money).toBe(money);
  });

  it('сохраняется в партии; старое сохранение без складов — та же вместимость', () => {
    const { game, st } = setup();
    const p = freeSpot(game, st);
    game.buildWarehouse(st.id, p);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = withoutCitizens(new Game(game.settings, save));
    const ls = loaded.stations.get(st.id)!;
    expect(ls.warehouses).toHaveLength(1);
    expect(loaded.stationStorage(ls)).toBe(STORAGE.base + STORAGE.per);
    expect(loaded.structureAt(p)).toMatchObject({ type: 'warehouse', stationId: st.id });
    // Старое сохранение: поля нет вовсе, у пристроек — прежняя прибавка.
    const old = JSON.parse(JSON.stringify(game.toSave()));
    for (const s of old.stations) {
      delete s.warehouses;
      if (s.id === st.id) s.depots = 1;
    }
    const was = withoutCitizens(new Game(game.settings, old));
    expect(was.stationStorage(was.stations.get(st.id)!)).toBe(STORAGE.base + STORAGE.per);
  });

  it('станцию снесли — её склады тоже, и за них возвращается часть цены', () => {
    const one = setup();
    const two = setup();
    two.game.buildWarehouse(two.st.id, freeSpot(two.game, two.st));
    const p = two.st.warehouses![0].fp.center;
    const back = (g: Game, st: Station) => {
      const m = g.money;
      expect(g.removeStation(st)).toBe(true);
      return g.money - m;
    };
    // Та же станция без склада и со складом: разница возврата — за склад.
    expect(back(two.game, two.st) - back(one.game, one.st)).toBe(Math.round(STORAGE.cost * COST.refundRatio));
    expect(two.game.structureAt(p)).toBeNull();
  });
});

/** Место, свободное от построек, — даже когда складов уже максимум (проверяем только причину отказа). */
function freeSpotIgnoringMax(game: Game, st: Station): Vec {
  const depots = st.depots;
  st.depots = 0;
  const p = freeSpot(game, st);
  st.depots = depots;
  return p;
}
