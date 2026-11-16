import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { dist, dot, sub, type Vec } from '../core/vec';
import { twoWay } from '../lanes/model';
import { centreLine } from '../lanes/solid';
import type { Vehicle } from '../sim/vehicle';
import type { Town } from '../world/entities';
import { MEDIAN } from '../world/roadTypes';
import type { Game } from './game';
import { LEFT_TURN, type GarageHome, type GarageSlot } from './garages';
import { freshGame, withoutCitizens } from './testkit';

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#888888' };

/** Дом с машиной на улице 1+1, к которому можно свернуть и направо, и налево, — первый подходящий. */
function leftHome(game: Game, lanes = 1): { town: Town; home: GarageHome; left: GarageSlot; right: GarageSlot } {
  for (const town of game.towns)
    for (const b of town.buildings) {
      const home = b.kind === 'res' ? game.garages.homeOf(b) : null;
      const left = home && game.garages.leftSlotOf(home);
      const right = home && game.garages.slotOf(home);
      const g = game.roads.graph;
      if (!home || !left || !right || left.link.fromNode === null || g.links.get(left.link.id)!.lanes.length !== lanes) continue;
      // Отрезок улицы до дома — не короче 40 м: машина успевает разогнаться и остановиться.
      if (left.mid < 40) continue;
      return { town, home, left, right };
    }
  throw new Error('нет дома, к которому можно свернуть налево');
}

/** Пересекаются ли кузова (нос pos, курс dir), чуть ужатые на shrink с каждой стороны. */
function overlap(a: { pos: Vec; dir: Vec; length: number; width: number }, b: { pos: Vec; dir: Vec; length: number; width: number }, shrink = 0.3): boolean {
  const box = (v: typeof a) => {
    const c = { x: v.pos.x - (v.dir.x * v.length) / 2, y: v.pos.y - (v.dir.y * v.length) / 2 };
    return { c, u: v.dir, n: { x: -v.dir.y, y: v.dir.x }, hl: v.length / 2 - shrink, hw: v.width / 2 - shrink };
  };
  const A = box(a);
  const B = box(b);
  const d = sub(B.c, A.c);
  for (const axis of [A.u, A.n, B.u, B.n]) {
    const ra = A.hl * Math.abs(dot(A.u, axis)) + A.hw * Math.abs(dot(A.n, axis));
    const rb = B.hl * Math.abs(dot(B.u, axis)) + B.hw * Math.abs(dot(B.n, axis));
    if (Math.abs(dot(d, axis)) > ra + rb) return false;
  }
  return true;
}

const step = (game: Game) => game.update(SIM_DT);

/**
 * Стоп-линии встречки, что остались без машины, пересекающей её: должно быть 0 (машины со стоянок магазинов выезжают
 * и без поездок жителей — их стоп-линии на месте, пока они на манёвре).
 */
function strayStops(game: Game): number {
  let n = 0;
  for (const list of game.traffic.turnStops.values()) n += list.length;
  return n - game.garages.moves.filter((m) => m.block).length;
}

/** Машина возвращается домой от начала улицы, где дом слева: путь — к повороту налево (wayHome). */
function sendHome(game: Game, town: Town, home: GarageHome, left: GarageSlot): Vehicle {
  town.garageAway = [home.b.id];
  const way = game.garages.wayHome(left.link.fromNode!, home)!;
  expect(way.slot.cross).toBeDefined();
  expect(way.route[way.route.length - 1]).toBe(left.link.id);
  const sim = game.traffic.spawn({ ...CAR, color: home.color, targetNode: way.slot.link.toNode!, route: way.route })!;
  game.citizenCars++;
  game.garages.homeward(sim, home, town, way.slot);
  return sim;
}

describe('Левый поворот к дому через встречку', { timeout: 60_000 }, () => {
  it('машина к дому слева поворачивает налево с поворотником, а не едет в объезд; линия маршрута — до места', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, home, left, right } = leftHome(game);
    const traffic = game.traffic;
    const sim = sendHome(game, town, home, left);
    // Линия маршрута выбранной машины кончается у места, а не в конце улицы.
    const ahead = game.vehicleAhead(sim.id)!;
    const end = ahead.pts[ahead.pts.length - 1];
    expect(dist(end, home.d.gate)).toBeLessThan(CAR.length + 1);
    expect(ahead.left).toBeLessThan(traffic.routeLeft(sim) + 40);
    const arrivals = traffic.arrivals;
    let blinkedLeft = false;
    let crossed = false;
    let wrongWay = false;
    let overlaps = 0;
    for (let i = 0; i < 30 * 90; i++) {
      step(game);
      if (traffic.vehicles.has(sim.id)) {
        if (sim.route.includes(right.link.id)) wrongWay = true;
        if (sim.holdDist !== undefined && sim.blinker === -1) blinkedLeft = true;
        // Не прижимается к бордюру — стоит посреди своей полосы.
        expect(sim.curb ?? 0).toBe(0);
        for (const o of traffic.vehicles.values()) if (o !== sim && overlap(sim, o)) overlaps++;
      }
      if (game.garages.moveOf(home.b.id)?.phase === 'cross') crossed = true;
      if (!game.garages.moveOf(home.b.id) && !traffic.vehicles.has(sim.id) && game.garages.homingOf(sim.id) === undefined) break;
    }
    expect(blinkedLeft).toBe(true);
    expect(crossed).toBe(true);
    expect(wrongWay).toBe(false);
    expect(overlaps).toBe(0);
    expect(traffic.arrivals).toBe(arrivals + 1);
    expect(town.garageAway).not.toContain(home.b.id);
    expect(strayStops(game)).toBe(0);
  });

  it('ждёт встречную машину: поворачивает, когда та проехала заезд, и та не тормозит резко', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, home, left } = leftHome(game);
    const traffic = game.traffic;
    const sim = sendHome(game, town, home, left);
    const cross = left.cross![0];
    let other: Vehicle | null = null;
    let passedBefore = -Infinity;
    let worstBrake = 0;
    let prevV = 0;
    let overlaps = 0;
    for (let i = 0; i < 30 * 90; i++) {
      step(game);
      const m = game.garages.moveOf(home.b.id);
      if (m?.phase === 'cross' && !other) {
        // Встала с поворотником — а по встречке подъезжает машина: ей не хватило бы места спокойно остановиться.
        other = traffic.placeOnLane({ ...CAR, targetNode: game.roads.graph.links.get(cross.lane.link)!.toNode! }, cross.lane.id, Math.max(1, cross.zone[0] - 35))!;
        other.v = 15;
        prevV = other.v;
        expect(traffic.clearToJoin(cross.lane.id, cross.zone[0], cross.zone[1])).toBe(false);
      }
      if (other && traffic.vehicles.has(other.id)) {
        worstBrake = Math.max(worstBrake, (prevV - other.v) / SIM_DT);
        prevV = other.v;
        if (traffic.vehicles.has(sim.id)) for (const o of [other]) if (overlap(sim, o)) overlaps++;
      }
      // Начала поворачивать: встречная уже за заездом.
      if (m?.phase === 'road' && passedBefore === -Infinity && other) {
        passedBefore = traffic.vehicles.has(other.id) && other.lane === cross.lane.id && !other.onMovement ? other.s - other.length - cross.zone[1] : Infinity;
      }
      if (!m && !traffic.vehicles.has(sim.id) && game.garages.homingOf(sim.id) === undefined) break;
    }
    expect(other).not.toBeNull();
    expect(passedBefore).toBeGreaterThan(0);
    expect(overlaps).toBe(0);
    // Встречная не тормозила (тормоз IDM — 18 м/с² игры).
    expect(worstBrake).toBeLessThan(3);
    expect(town.garageAway).not.toContain(home.b.id);
  });

  it('встречка стоит дольше LEFT_TURN.maxWait — едет в объезд, к повороту направо, и всё равно доезжает', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, home, left, right } = leftHome(game);
    const traffic = game.traffic;
    const sim = sendHome(game, town, home, left);
    const cross = left.cross![0];
    let blocker: Vehicle | null = null;
    let since = 0;
    let detourAfter = -1;
    let t = 0;
    for (let i = 0; i < 30 * 240; i++) {
      step(game);
      t += SIM_DT;
      const m = game.garages.moveOf(home.b.id);
      if (m?.phase === 'cross' && !blocker) {
        // Во встречной полосе на заезде стоит машина (пробка) — просвета нет.
        blocker = traffic.placeOnLane({ ...CAR, targetNode: game.roads.graph.links.get(cross.lane.link)!.toNode! }, cross.lane.id, (cross.zone[0] + cross.zone[1]) / 2 + CAR.length / 2)!;
        traffic.holdAfter(blocker, 0);
        since = t;
      }
      if (blocker && detourAfter < 0 && sim.endLink === right.link.id) {
        detourAfter = t - since;
        // Пробка рассосалась.
        traffic.release(blocker);
      }
      if (!m && !traffic.vehicles.has(sim.id) && game.garages.homingOf(sim.id) === undefined) break;
    }
    expect(detourAfter).toBeGreaterThan(LEFT_TURN.maxWait - 1);
    expect(detourAfter).toBeLessThan(LEFT_TURN.maxWait + 2);
    expect(sim.endLeft).toBeUndefined();
    expect(town.garageAway).not.toContain(home.b.id);
    expect(strayStops(game)).toBe(0);
  });

  it.each([
    ['с разделителем', (game: Game, id: number) => game.roads.net.setLanes(game.roads.net.corridor(id), twoWay(1, 1, MEDIAN))],
    ['шоссе', (game: Game, id: number) => {
      const c = game.roads.net.corridor(id);
      c.cls = 'highway';
      game.roads.net.touch(c);
    }],
  ])('на дороге %s налево не поворачивает — к дому направо', (_name, edit) => {
    const game = withoutCitizens(freshGame(7));
    const { home, left } = leftHome(game);
    const from = left.link.fromNode!;
    edit(game, left.link.corridor);
    game.roads.changed();
    expect(game.garages.leftSlotOf(home)).toBeNull();
    const way = game.garages.wayHome(from, home);
    if (way) expect(way.slot.cross).toBeUndefined();
  });

  it('улица 1+1: по оси у дома — белый пунктир (как нарисовано), через него налево можно', () => {
    const game = withoutCitizens(freshGame(7));
    const { home, left } = leftHome(game);
    const c = game.roads.net.corridor(left.link.corridor);
    const [ca, cb] = game.roads.graph.cutOf(c.id)!;
    const s = c.lut.closest(home.d.curb).s;
    expect(c.lanes).toHaveLength(2);
    expect(centreLine(game.roads.net, c, s, ca, c.length - cb)).toBe('dash');
    expect(left.cross).toHaveLength(1);
  });

  it('проспект 2+2 с жёлтой осевой: налево нельзя — машина едет в объезд и сворачивает к дому направо', () => {
    const game = withoutCitizens(freshGame(7));
    const traffic = game.traffic;
    const g = game.roads.graph;
    // Дом на проспекте, к которому можно свернуть направо, и узел за ним — откуда дом слева, через жёлтую.
    let found: { town: Town; home: GarageHome; right: GarageSlot } | null = null;
    for (const town of game.towns)
      for (const b of town.buildings) {
        const home: GarageHome | null = !found && b.kind === 'res' ? game.garages.homeOf(b) : null;
        const right: GarageSlot | null = home && game.garages.slotOf(home);
        if (!home || !right || g.links.get(right.link.id)!.lanes.length !== 2 || right.link.toNode === null) continue;
        found = { town, home, right };
      }
    expect(found).not.toBeNull();
    const { town, home, right } = found!;
    const c = game.roads.net.corridor(right.link.corridor);
    const [ca, cb] = g.cutOf(c.id)!;
    expect(c.cls).toBe('avenue');
    expect(centreLine(game.roads.net, c, c.lut.closest(home.d.curb).s, ca, c.length - cb)).toBe('yellow');
    expect(game.garages.leftSlotOf(home)).toBeNull();
    // Едет с той стороны, где дом слева: путь — в объезд, к повороту направо.
    town.garageAway = [home.b.id];
    const way = game.garages.wayHome(right.link.toNode!, home)!;
    expect(way.slot.cross).toBeUndefined();
    expect(way.slot.link.id).toBe(right.link.id);
    expect(way.route.length).toBeGreaterThan(1);
    const sim = traffic.spawn({ ...CAR, color: home.color, targetNode: way.slot.link.toNode!, route: way.route })!;
    game.citizenCars++;
    game.garages.homeward(sim, home, town, way.slot);
    let crossed = false;
    let blinkedRight = false;
    for (let i = 0; i < 30 * 240; i++) {
      step(game);
      if (game.garages.moveOf(home.b.id)?.phase === 'cross') crossed = true;
      if (traffic.vehicles.has(sim.id) && sim.holdDist !== undefined && sim.blinker === 1) blinkedRight = true;
      if (!game.garages.moveOf(home.b.id) && !traffic.vehicles.has(sim.id) && game.garages.homingOf(sim.id) === undefined) break;
    }
    expect(crossed).toBe(false);
    expect(blinkedRight).toBe(true);
    expect(town.garageAway).not.toContain(home.b.id);
  });

  it('выезд налево: задним ходом через ближнюю полосу в дальнюю, когда туда ближе', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, home, left } = leftHome(game);
    const traffic = game.traffic;
    // Цель — конец улицы в сторону, куда едут по дальней полосе.
    game.garages.leave(home, town, left.link.toNode!, { from: home.b, to: home.b });
    let sim: Vehicle | undefined;
    let blocked = false;
    for (let i = 0; i < 30 * 60 && !(sim && !game.garages.moveOf(home.b.id)); i++) {
      step(game);
      const m = game.garages.moveOf(home.b.id);
      if (m?.sim && !sim) sim = m.sim;
      if (m?.phase === 'road' && m.kind === 'out' && traffic.turnStops.size) blocked = true;
    }
    expect(sim).toBeDefined();
    expect(blocked).toBe(true);
    expect(strayStops(game)).toBe(0);
    expect(game.roads.graph.lanes.get(sim!.lane)!.link).toBe(left.link.id);
    expect(dot(sim!.dir, left.f)).toBeGreaterThan(0.95);
  });
});
