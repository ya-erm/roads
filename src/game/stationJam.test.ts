import { describe, expect, it, vi } from 'vitest';
import { dot, sub } from '../core/vec';
import { boxesOverlap } from '../lanes/curb';
import type { VehicleLook } from '../sim/vehicle';
import { vehicleBoxes } from '../sim/body';
import { Game } from './game';
import { type Approach, JAM_DELAY, JAM_REACH, jamShown, nextJam, queuedAt } from './stationJam';
import { fieldSpot, freightRoute, freshGame, road, runUntil, withoutCitizens } from './testkit';
import { DEFAULT_RULE, type FleetVehicle } from './transport';

const at = (station: number, o: Partial<Approach> = {}): Approach => ({ station, line: 1, blocked: false, stopped: false, dist: 50, ...o });

describe('Очередь на въезд: кто ждёт', () => {
  it('та, которой не дали поста, и стоящие за ней на подъезде; едущие и дальние — нет', () => {
    const list = [
      at(7, { blocked: true, dist: 0 }),
      at(7, { stopped: true, dist: 30, line: 2 }),
      at(7, { stopped: true, dist: JAM_REACH + 1 }),
      at(7, { stopped: false, dist: 40 }),
      at(8, { blocked: true }),
    ];
    const q = queuedAt(list, 7);
    expect(q).toHaveLength(2);
    expect(q.map((a) => a.line)).toEqual([1, 2]);
  });

  it('никому не отказали — очереди нет, сколько бы машин ни стояло у въезда (светофор, пробка)', () => {
    expect(queuedAt([at(7, { stopped: true, dist: 5 }), at(7, { stopped: true, dist: 20 })], 7)).toEqual([]);
  });
});

describe('Очередь на въезд: когда предупреждать', () => {
  const q = [at(7, { blocked: true }), at(7, { stopped: true, line: 3 }), at(7, { stopped: true, line: 3 })];

  it('держится с первого замера; линии — без повторов', () => {
    const a = nextJam(undefined, true, q, 100)!;
    expect(a).toEqual({ since: 100, waiting: 3, lines: [1, 3] });
    const b = nextJam(a, true, q.slice(0, 2), 104)!;
    expect(b.since).toBe(100);
    expect(b.waiting).toBe(2);
  });

  it('посты освободились или ждать некому — очередь сброшена и отсчёт пойдёт заново', () => {
    const a = nextJam(undefined, true, q, 100);
    expect(nextJam(a, false, q, 101)).toBeUndefined();
    expect(nextJam(a, true, [], 101)).toBeUndefined();
    expect(nextJam(undefined, true, q, 130)!.since).toBe(130);
  });

  it('короткое заполнение не показываем: только после JAM_DELAY секунд', () => {
    const a = nextJam(undefined, true, q, 100);
    expect(jamShown(a, 100 + JAM_DELAY - 1)).toBe(false);
    expect(jamShown(a, 100 + JAM_DELAY)).toBe(true);
    expect(jamShown(undefined, 1000)).toBe(false);
  });
});

describe('Очередь на въезд в игре', { timeout: 60_000 }, () => {
  it('грузовики ждут на дороге перед маневровой площадкой и не задевают въезжающего', () => {
    const game = withoutCitizens(freshGame(7));
    const { built, line, sB } = freightRoute(game);
    expect(built).toBe(true);
    expect(game.setStationBays(sB.id, 1)).toBeNull();
    game.setStopRule(line.id, 0, { ...DEFAULT_RULE, wait: 'none' });
    game.setStopRule(line.id, 1, { ...DEFAULT_RULE, wait: 'full', maxWait: null });
    const fleet = Array.from({ length: 3 }, () => game.buyVehicle(line.id, 'truck')!);
    let waiting = false;
    const arrived = runUntil(game, 180, () => waiting && sB.occupied.some((id) => !game.fleet.get(id)?.enter), () => {
      const yard = game.bayLooks(sB).flatMap((p) => vehicleBoxes(p.pos, p.dir, p.length, p.width, p.body, p.trail));
      for (const v of fleet) {
        const sim = v.stop === 1 ? game.fleetSim(v) : undefined;
        if (!sim || sim.onMovement || sim.routeIndex !== sim.route.length - 1) continue;
        const lane = game.roads.graph.lanes.get(sim.lane)!;
        const body = vehicleBoxes(sim.pos, sim.dir, sim.length, sim.width, sim.body, sim.trail);
        expect(yard.some((a) => body.some((b) => boxesOverlap(a, b)))).toBe(false);
        if (game.bayWait(v) <= 0 || sim.v > 0.2 || lane.length < 18) continue;
        expect(lane.length - sim.s).toBeGreaterThanOrEqual(17.5);
        waiting = true;
      }
    });
    expect(arrived).toBe(true);
  });

  it('свободный пост принимает грузовик во время другого манёвра на том же дворе', () => {
    const game = withoutCitizens(freshGame(7));
    const { built, line, sB } = freightRoute(game);
    expect(built).toBe(true);
    game.setStopRule(line.id, 0, { ...DEFAULT_RULE, wait: 'none' });
    game.setStopRule(line.id, 1, { ...DEFAULT_RULE, wait: 'none' });
    for (let i = 0; i < 6; i++) expect(game.buyVehicle(line.id, 'truck')).not.toBeNull();

    expect(runUntil(game, 180, () => {
      const fleet = sB.occupied.map((id) => game.fleet.get(id)!);
      return fleet.some((v) => v.enter) && fleet.some((v) => v.yardExit);
    })).toBe(true);
    expect(game.stationJam(sB)).toBe(0);
  });

  it('четыре фуры начинают выезжать с постов и по очереди вливаются в один выезд', () => {
    const game = withoutCitizens(freshGame(7));
    const { built, line, sB } = freightRoute(game);
    expect(built).toBe(true);
    expect(game.setStationBays(sB.id, 8)).toBeNull();
    const ready = [4, 5, 6, 7];
    const fleet = Array.from({ length: 8 }, (_, bay) => {
      const v = game.buyVehicle(line.id, 'truck')!;
      v.model = 'truck3';
      v.stop = 1;
      v.state = ready.includes(bay) ? 'departing' : 'loading';
      v.timer = ready.includes(bay) ? 0 : 500;
      v.inBay = true;
      v.bay = bay;
      if (v.state === 'departing') v.yardReadyAt = game.time - bay;
      sB.occupied.push(v.id);
      return v;
    });
    const departing = ready.map((bay) => fleet[bay]);
    const finished: number[] = [];
    let simultaneous = 0;
    const allLeft = runUntil(game, 120, () => finished.length === 4, () => {
      simultaneous = Math.max(simultaneous, departing.filter((v) => v.yardExit).length);
      for (const v of departing) if (v.state === 'driving' && !finished.includes(v.id)) finished.push(v.id);
      const park = game.bayLooks(sB).map((p) => vehicleBoxes(p.pos, p.dir, p.length, p.width, p.body, p.trail));
      for (const [index, body] of park.entries()) {
        expect(park.slice(index + 1).some((other) => body.some((a) => other.some((b) => boxesOverlap(a, b))))).toBe(false);
      }
    });
    expect(allLeft, JSON.stringify({ yard: sB.fp, simultaneous, finished, positions: departing.map((v) => [v.id, v.bay, v.state, v.yardExit]) })).toBe(true);
    expect(finished[0]).toBe(fleet[7].id);
    expect(simultaneous).toBe(4);
  });

  it.each([1, 6])('фуры с двух сторон одновременно сдают назад в проезд и ждут просвета поперёк постов, первым готов пост %i', (firstBay) => {
    const game = withoutCitizens(freshGame(7));
    const { built, line, sA, sB } = freightRoute(game);
    expect(built).toBe(true);
    expect(game.setStationBays(sB.id, 8)).toBeNull();
    const readyBays = [1, 6];
    const departing: FleetVehicle[] = [];
    for (let bay = 0; bay < 8; bay++) {
      const ready = readyBays.includes(bay);
      const v = game.buyVehicle(line.id, 'truck')!;
      v.model = 'truck3';
      v.stop = 1;
      v.state = ready ? 'departing' : 'loading';
      v.timer = ready ? 0 : 500;
      v.inBay = true;
      v.bay = bay;
      if (bay === firstBay) v.yardReadyAt = game.time - 1;
      if (ready) departing.push(v);
      sB.occupied.push(v.id);
    }
    const out = game.roads.route(sB.nodeId, sA.nodeId)![0];
    const spawnPoint = game.traffic.spawnPoint.bind(game.traffic);
    const gap = vi.spyOn(game.traffic, 'spawnPoint').mockImplementation((route, advance, length, target, preview, fits) =>
      route[0] === out && !target && !preview ? null : spawnPoint(route, advance, length, target, preview, fits),
    );
    const across = { x: Math.cos(sB.fp.angle), y: Math.sin(sB.fp.angle) };
    const previous = new Map<number, VehicleLook>();
    let bothBacking = 0;
    try {
      expect(runUntil(game, 30, () => departing.every((v) => {
        const look = game.fleetLook(v);
        return v.yardExit?.stage === 'turn' && v.timer > 0 && look && Math.abs(dot(look.dir, across)) > 0.95;
      }), () => {
        let backing = 0;
        for (const v of departing) {
          const now = game.fleetLook(v);
          const before = previous.get(v.id);
          if (now && before && dot(sub(now.pos, before.pos), now.dir) < -0.04) backing++;
          if (now) previous.set(v.id, now);
        }
        if (backing === 2) bothBacking++;
        const park = game.bayLooks(sB).map((p) => vehicleBoxes(p.pos, p.dir, p.length, p.width, p.body, p.trail));
        for (const [index, body] of park.entries()) {
          expect(park.slice(index + 1).some((other) => body.some((a) => other.some((b) => boxesOverlap(a, b))))).toBe(false);
        }
      })).toBe(true);
      expect(bothBacking).toBeGreaterThan(10);
    } finally {
      gap.mockRestore();
    }
    expect(runUntil(game, 50, () => departing.every((v) => !sB.occupied.includes(v.id)))).toBe(true);
  });

  it('занятый дорожный выезд не блокирует свободные посты, а сам манёвр не считается затором', () => {
    const game = withoutCitizens(freshGame(7));
    const { built, line, sA, sB } = freightRoute(game);
    expect(built).toBe(true);
    expect(sB.industryId).not.toBeNull();
    const out = game.roads.route(sB.nodeId, sA.nodeId)![0];
    const spawnPoint = game.traffic.spawnPoint.bind(game.traffic);
    let blocked = true;
    const gap = vi.spyOn(game.traffic, 'spawnPoint').mockImplementation((route, ...args) =>
      blocked && route[0] === out ? null : spawnPoint(route, ...args),
    );
    try {
      const trucks = [game.buyVehicle(line.id, 'truck')!, game.buyVehicle(line.id, 'truck')!];
      expect(runUntil(game, 180, () => trucks.every((v) => v.inBay && v.stop === 1 && game.departWait(v) > 0))).toBe(true);
      expect(sB.occupied).toHaveLength(2);
      expect(trucks.every((v) => !v.yardExit)).toBe(true);

      blocked = false;
      expect(runUntil(game, 2, () => trucks.some((v) => !!v.yardExit))).toBe(true);
      const leaving = trucks.find((v) => !!v.yardExit)!;
      expect(game.departWait(leaving)).toBe(0);
      expect(runUntil(game, 45, () => trucks.every((v) => v.state === 'driving' && v.stop === 0))).toBe(true);
      expect(sB.occupied).toHaveLength(0);
    } finally {
      gap.mockRestore();
    }
  });

  it('все посты заняты автобусами, остальные ждут у въезда — станция и маршрут предупреждают; пост добавили — очередь ушла', () => {
    const game = withoutCitizens(new Game(42));
    game.money = 5_000_000;
    const a = fieldSpot(game, 500);
    expect(road(game, { free: a }, { free: { x: a.x + 500, y: a.y } })).toBe(true);
    const sA = game.placeStation({ x: a.x + 120, y: a.y - 30 }, 14)!;
    const sB = game.placeStation({ x: a.x + 380, y: a.y - 30 }, 14)!;
    const line = game.createLine([sA.id, sB.id])!;
    // На второй станции ждут полной загрузки, а пассажиров в поле нет: занявшие посты стоят там всё время.
    game.setStopRule(line.id, 1, { ...DEFAULT_RULE, wait: 'full', maxWait: null });
    for (let i = 0; i < sB.bays + 2; i++) expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    game.speed = 1;
    let firstSeen: number | null = null;
    let queueSince: number | null = null;
    for (let t = 0; t < 240 && firstSeen === null; t += 0.1) {
      game.update(0.1);
      if (queueSince === null && sB.occupied.length >= sB.bays && [...game.fleet.values()].some((v) => game.bayWait(v) > 0)) queueSince = game.time;
      if (game.stationJam(sB) > 0) firstSeen = game.time;
    }
    expect(sB.occupied).toHaveLength(sB.bays);
    expect(queueSince).not.toBeNull();
    expect(firstSeen).not.toBeNull();
    // Не сразу, а когда очередь продержалась порог.
    expect(firstSeen! - queueSince!).toBeGreaterThanOrEqual(JAM_DELAY - 1);
    // Ждут двое: одной не дали поста, другая стоит за ней.
    expect(game.stationJam(sB)).toBe(2);
    expect(game.stationJam(sA)).toBe(0);
    expect(game.lineJams(line)).toEqual([{ station: sB, waiting: 2 }]);
    // Постов хватает всем — предупреждение пропало.
    expect(game.setStationBays(sB.id, sB.bays + 2)).toBeNull();
    for (let t = 0; t < 40; t += 0.1) game.update(0.1);
    expect(game.stationJam(sB)).toBe(0);
    expect(game.lineJams(line)).toEqual([]);
  });
});
