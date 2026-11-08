import { describe, expect, it } from 'vitest';
import { add, scale, type Vec } from '../core/vec';
import { WAGON_RATE } from '../sim/wagons';
import { RAIL_SPEC } from '../world/roadTypes';
import { Game } from './game';
import { runSeconds, withoutCitizens } from './testkit';
import { carsOf, type FleetVehicle, handlingStreams, handlingTime, HANDLING_PER_UNIT, vehicleCapacity } from './transport';

const vehicle = (model: FleetVehicle['model'], cars?: number) => ({ model, cars }) as FleetVehicle;

/** Прямой путь 2400 м в чистом поле и два вокзала у его концов (как в rail.test.ts). */
function railWorld(): { game: Game; a: number; b: number } {
  const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry' }));
  const len = 2400;
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      for (const angle of [0, 0.3, -0.3]) {
        const dir = { x: Math.cos(angle), y: Math.sin(angle) };
        const from: Vec = { x, y };
        const req = { start: { kind: 'free' as const, pos: from, level: 0 }, end: { kind: 'free' as const, pos: add(from, scale(dir, len)), level: 0 }, spec: RAIL_SPEC, mode: 'straight' as const };
        if (!game.builder.plan(req).ok) continue;
        game.builder.build(req);
        const n = { x: -dir.y, y: dir.x };
        const pa = add(add(from, scale(dir, 400)), scale(n, 40));
        const pb = add(add(from, scale(dir, len - 400)), scale(n, 40));
        if (game.stationPlan(pa, 14, 'rail').ok && game.stationPlan(pb, 14, 'rail').ok) {
          return { game, a: game.placeStation(pa, 14, 'rail')!.id, b: game.placeStation(pb, 14, 'rail')!.id };
        }
        game.builder.bulldoze(add(from, scale(dir, len / 2)), 4);
      }
    }
  }
  throw new Error('Нет места для пути');
}

describe('Посадка в пассажирский поезд', () => {
  it('пассажиры входят и выходят через все вагоны сразу; грузовые поезда и автобусы — одним потоком', () => {
    // Пассажирский: 5 единиц состава — локомотив и 4 вагона.
    expect(handlingStreams(vehicle('passengerTrain'))).toBe(4);
    expect(handlingStreams(vehicle('passengerTrain2'))).toBe(5);
    // Вагонов прицепили больше или меньше — и потоков столько же; меньше одного не бывает.
    expect(handlingStreams(vehicle('passengerTrain', 8))).toBe(7);
    expect(handlingStreams(vehicle('passengerTrain', 1))).toBe(1);
    for (const m of ['freightTrain', 'freightTrain2', 'bus', 'bus2', 'bus3', 'truck'] as const) expect(handlingStreams(vehicle(m))).toBe(1);
    // Полный поезд (180) выходит и столько же садится: было 36 с, стало 9 с.
    expect(handlingTime(vehicle('passengerTrain'), 360)).toBeCloseTo(9, 9);
    expect(handlingTime(vehicle('freightTrain'), 120)).toBeCloseTo(120 * HANDLING_PER_UNIT, 9);
    expect(handlingTime(vehicle('bus'), 30)).toBeCloseTo(30 * HANDLING_PER_UNIT, 9);
  });

  it('полный поезд высаживает пассажиров вчетверо быстрее, вагоны пустеют все сразу в том же темпе', { timeout: 30_000 }, () => {
    const { game, a, b } = railWorld();
    const line = game.createLine([a, b])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    const v = game.buyVehicle(line.id, 'passengerTrain')!;
    runSeconds(game, 0.5);
    const cap = vehicleCapacity(v);
    const streams = carsOf(v) - 1;
    // Полный поезд пассажиров до второго вокзала.
    v.passengers = [{ from: a, to: b, count: cap, at: game.time }];
    let arrived: number | null = null;
    let timer = 0;
    for (let t = 0; t < 300 && arrived === null; t += 0.1) {
      game.update(0.1);
      if (v.state === 'loading' && v.stop === 1) {
        arrived = game.time;
        timer = v.timer;
      }
    }
    expect(arrived).not.toBeNull();
    expect(v.passengers).toHaveLength(0);
    // Стоянка: 2 с плюс 0.1 с на пассажира, деленные на число вагонов (раньше — 2 + 18 с).
    expect(timer).toBeGreaterThan(2 + (cap * HANDLING_PER_UNIT) / streams - 0.25);
    expect(timer).toBeLessThanOrEqual(2 + (cap * HANDLING_PER_UNIT) / streams + 1e-9);
    // Вид вагонов догоняет в том же темпе: за 2 с вышло 2 · 10 · 4 = 80 из 180.
    const train = game.fleetTrain(v)!;
    const before = train.fill!;
    runSeconds(game, 2);
    expect(before - train.fill!).toBeCloseTo((2 * WAGON_RATE * streams) / cap, 1);
    // Через 6.5 с от прибытия все вышли — и поезд уже уходит (раньше стоял бы 20 с).
    runSeconds(game, 5);
    expect(train.fill).toBe(0);
    expect(v.state === 'departing' || v.state === 'driving').toBe(true);
  });
});
