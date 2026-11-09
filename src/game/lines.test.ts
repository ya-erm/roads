import { describe, expect, it } from 'vitest';
import { CARGO } from '../world/cargo';
import type { Station } from '../world/entities';
import { ECONOMY } from '../config';
import { dist } from '../core/vec';
import { Game } from './game';
import { freshGame, stationAtIndustry, townStreets } from './testkit';
import { LINE_COLORS, type FleetVehicle, type Line } from './transport';

// Авто-парк и равномерный выпуск машин (симуляции на месяцы) — в autoFleet.test.ts.

/** Станция у улицы самого большого города — склад для пересадки. */
function townStation(game: Game): Station {
  const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
  for (const seg of townStreets(game, town.id)) {
    const p = seg.lut.pointAt(seg.length / 2);
    const t = seg.lut.tangentAt(seg.length / 2);
    const st = game.placeStation({ x: p.x - t.y * 40, y: p.y + t.x * 40 }, 14, 'road', { pax: false, cargo: true });
    if (st) return st;
  }
  throw new Error('нет места для станции');
}

type Internals = { handleStop(v: FleetVehicle, st: Station, line: Line): void };

describe('Маршруты и склады', () => {
  it('маршрут редактируется: станции добавляются, переставляются и удаляются', () => {
    const game = freshGame(7);
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    const a = stationAtIndustry(game, farm, plant.fp.center)!;
    const b = stationAtIndustry(game, plant, farm.fp.center)!;
    const hub = townStation(game);
    const line = game.createLine([a.id, b.id])!;
    expect(game.addLineStop(line.id, hub.id)).toBeNull();
    expect(line.stops).toEqual([a.id, b.id, hub.id]);
    expect(game.moveLineStop(line.id, 2, -1)).toBeNull();
    expect(line.stops).toEqual([a.id, hub.id, b.id]);
    expect(game.removeLineStop(line.id, 0)).toBeNull();
    expect(line.stops).toEqual([hub.id, b.id]);
    // Меньше двух станций нельзя.
    expect(game.removeLineStop(line.id, 0)).not.toBeNull();
    expect(line.stops).toHaveLength(2);
  });

  it('склад: груз выгружается на пересадке и оплачивается при доставке от первой станции', () => {
    const game = freshGame(7);
    game.money = 5_000_000;
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    const a = stationAtIndustry(game, farm, plant.fp.center)!;
    const b = stationAtIndustry(game, plant, farm.fp.center)!;
    const hub = townStation(game);
    expect(hub.accepts.has('grain')).toBe(false);
    // Первая линия довозит зерно до склада, вторая — со склада на комбинат.
    const l1 = game.createLine([a.id, hub.id])!;
    game.setStopRule(l1.id, 1, { wait: 'none', maxWait: null, load: 'auto', unload: 'all' });
    const l2 = game.createLine([hub.id, b.id])!;
    const t1 = game.buyVehicle(l1.id, 'truck')!;
    const t2 = game.buyVehicle(l2.id, 'truck')!;
    const g = game as unknown as Internals;

    // Грузовик первой линии берёт зерно на ферме.
    a.cargo.grain = 40;
    t1.stop = 0;
    g.handleStop(t1, a, l1);
    expect(t1.cargo).toBe('grain');
    expect(t1.amount).toBe(16);
    // На складе выгружает всё, денег пока нет.
    const before = l1.revenueTotal;
    t1.stop = 1;
    g.handleStop(t1, hub, l1);
    expect(t1.amount).toBe(0);
    expect(hub.cargo.grain).toBe(16);
    expect(hub.cargoOrigin?.grain).toBe(a.id);
    expect(l1.revenueTotal).toBe(before);

    // Вторая линия забирает со склада и везёт на комбинат.
    t2.cargo = null;
    t2.amount = 0;
    t2.stop = 0;
    g.handleStop(t2, hub, l2);
    expect(t2.cargo).toBe('grain');
    expect(t2.loadedAt).toBe(a.id);
    t2.stop = 1;
    const r0 = l2.revenueTotal;
    g.handleStop(t2, b, l2);
    const expected = Math.round((16 * CARGO.grain.rate * ECONOMY.tariff * dist(a.fp.center, b.fp.center)) / 100);
    expect(l2.revenueTotal - r0).toBe(expected);
  });

  it('прокладываемый маршрут — цветом будущей линии: грузовой — цветом груза, пассажирский — свободным цветом', () => {
    const game = freshGame(7);
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    const a = stationAtIndustry(game, farm, plant.fp.center)!;
    const b = stationAtIndustry(game, plant, farm.fp.center)!;
    expect(game.newLineColor([a.id, b.id])).toBe(CARGO.grain.color);
    expect(game.createLine([a.id, b.id])!.color).toBe(CARGO.grain.color);

    const h1 = townStation(game);
    const h2 = townStation(game);
    game.setStationServes(h1.id, { pax: true, cargo: false });
    game.setStationServes(h2.id, { pax: true, cargo: false });
    const draft = game.newLineColor([h1.id, h2.id]);
    expect(draft).toBe(LINE_COLORS[0]);
    expect(game.createLine([h1.id, h2.id])!.color).toBe(draft);
    // Следующий пассажирский — уже другим цветом.
    expect(game.newLineColor([h2.id, h1.id])).toBe(LINE_COLORS[1]);
  });

  it('станция только для груза не набирает пассажиров', () => {
    const game = freshGame(7);
    const hub = townStation(game);
    expect(hub.serves.pax).toBe(false);
    expect(hub.catchPop).toBe(0);
    game.setStationServes(hub.id, { pax: true, cargo: false });
    expect(hub.catchPop).toBeGreaterThan(0);
    expect(hub.accepts.size).toBe(0);
    // Хотя бы что-то одно остаётся включённым.
    game.setStationServes(hub.id, { pax: false, cargo: false });
    expect(hub.serves.pax).toBe(true);
  });
});
