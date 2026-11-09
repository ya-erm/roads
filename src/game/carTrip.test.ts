import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import { carTripHtml } from '../ui/carTrip';
import { Game } from './game';
import { SERVICES } from './services';
import { runSeconds } from './testkit';

/** Куда едет машина жителя и спецмашина: откуда и куда (здания и города), маршрут до цели, сколько ещё. */

const WORLD = { seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry' } as const;

describe('Поездка машины жителя и спецмашины', { timeout: 60_000 }, () => {
  it('машина жителя знает, из какого дома и куда едет; маршрут — от неё до цели, сколько ещё — по маршруту', () => {
    const game = new Game(WORLD);
    runSeconds(game, 15);
    const cars = [...game.traffic.vehicles.values()].filter((v) => game.tripOf(v.id) && !game.serviceOfSim(v.id));
    expect(cars.length).toBeGreaterThan(0);
    for (const v of cars) {
      const trip = game.tripOf(v.id)!;
      // Едут из жилого дома — туда, где цель маршрута.
      expect(trip.from.kind).toBe('res');
      expect(v.targetNode).toBe(trip.to.anchor);
      expect(game.towns.some((t) => t.id === trip.from.townId)).toBe(true);
    }
    const v = cars.find((c) => game.vehicleAhead(c.id) && game.traffic.routeLeft(c) > 100)!;
    expect(v).toBeDefined();
    const ahead = game.vehicleAhead(v.id)!;
    expect(ahead.pts[0]).toEqual(v.pos);
    expect(ahead.left).toBeCloseTo(game.traffic.routeLeft(v), 6);
    expect(ahead.eta).toBeGreaterThan(0);
    expect(ahead.goal).toEqual(game.tripOf(v.id)!.to.fp.center);
    // Линия по маршруту — примерно его длины и кончается у цели.
    let len = 0;
    for (let i = 1; i < ahead.pts.length; i++) len += dist(ahead.pts[i - 1], ahead.pts[i]);
    // Остаток пути (routeLeft) — по связям, без проездов перекрёстков, а линия идёт и через них: в частой сетке
    // улиц линия длиннее на пятую-четверть.
    expect(Math.abs(len - ahead.left)).toBeLessThan(ahead.left * 0.3 + 30);
    expect(dist(ahead.pts[ahead.pts.length - 1], ahead.goal)).toBeLessThan(120);
    // Карточка: откуда → куда значками, город — кнопкой к городу, сколько ещё и примерно когда.
    const trip = game.tripOf(v.id)!;
    const html = carTripHtml(game, v.id);
    expect(html).toContain('🏠');
    expect(html).toContain(`data-action="focus" data-type="town" data-id="${trip.to.townId}"`);
    expect(html).toContain(game.towns.find((t) => t.id === trip.from.townId)!.name);
    expect(html).toContain('📏');
    expect(html).toContain('⏳ ≈');
    expect(html).not.toContain('title=');
    // Машина проехала дальше — линия снова от неё.
    const id = v.id;
    runSeconds(game, 2);
    const moved = game.traffic.vehicles.get(id);
    if (moved && game.vehicleAhead(id)) expect(game.vehicleAhead(id)!.pts[0]).toEqual(moved.pos);
  });

  it('спецмашина: вызов откуда и куда в своём городе, маршрут — её цветом в карточке и на карте', () => {
    const game = new Game(WORLD);
    const town = game.towns.find((t) => t.buildings.filter((b) => b.kind === 'res').length > 5)!;
    const homes = town.buildings.filter((b) => b.kind === 'res');
    const from = homes[0];
    const to = homes.filter((b) => b.anchor !== from.anchor).sort((a, b) => dist(b.fp.center, from.fp.center) - dist(a.fp.center, from.fp.center))[0];
    const sim = game.spawnService('ambulance', true, from.anchor, to.anchor, { from, to })!;
    expect(sim).not.toBeNull();
    expect(game.tripOf(sim.id)).toEqual({ from, to });
    expect(game.serviceOfSim(sim.id)).toBe('ambulance');
    const ahead = game.vehicleAhead(sim.id)!;
    expect(ahead.left).toBeGreaterThan(0);
    const html = carTripHtml(game, sim.id);
    expect(html).toContain(SERVICES.ambulance.icon);
    expect(html).toContain(`data-id="${town.id}"`);
    // Вызов в своём городе — город назван один раз.
    expect(html.split(`>${town.name}<`).length - 1).toBe(1);
    // Спецмашина без поездки (как после загрузки) — карточка без «откуда → куда», но со сколько ещё.
    const bare = game.spawnService('police', false, to.anchor, from.anchor);
    if (bare) {
      expect(game.tripOf(bare.id)).toBeNull();
      expect(carTripHtml(game, bare.id)).toContain('📏');
    }
  });

  it('выезды спецмашин сами запоминают вызов: откуда и куда', () => {
    const game = new Game(WORLD);
    let seen = 0;
    runSeconds(game, 120, () => {
      for (const v of game.traffic.vehicles.values()) {
        if (!game.serviceOfSim(v.id)) continue;
        const trip = game.tripOf(v.id);
        expect(trip).not.toBeNull();
        expect(v.targetNode).toBe(trip!.to.anchor);
        seen++;
      }
    });
    expect(seen).toBeGreaterThan(0);
  });
});
