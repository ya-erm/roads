import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { angleDiff, angleOf, dist, dot, sub, type Vec } from '../core/vec';
import type { Vehicle } from '../sim/vehicle';
import type { Town } from '../world/entities';
import { Game } from './game';
import type { GarageHome, GarageSlot } from './garages';
import { freshGame, runSeconds, withoutCitizens } from './testkit';

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#888888' };
const WORLD: [number, number, number, number] = [-1e6, -1e6, 1e6, 1e6];

/** Дом с гаражом, к которому можно подъехать (slotOf), — первый подходящий. */
function garageHome(game: Game, ok: (h: GarageHome) => boolean): { town: Town; home: GarageHome; slot: GarageSlot } {
  for (const town of game.towns)
    for (const b of town.buildings) {
      const home = b.kind === 'res' ? game.garages.homeOf(b) : null;
      const slot = home && ok(home) ? game.garages.slotOf(home) : null;
      if (home && slot) return { town, home, slot };
    }
  throw new Error('нет дома с гаражом');
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

/** Один такт игры (update копит время — на всякий случай допускаем и два такта за вызов). */
const step = (game: Game) => game.update(SIM_DT);

/**
 * Следит за машиной дома на манёвре (а после — за её машиной в потоке, simId): нос не прыгает (за такт — не больше,
 * чем она проедет), курс не дёргается, кузов не налезает ни на одну машину в потоке.
 */
function watch(game: Game, building: number) {
  let prev: { pos: Vec; dir: Vec; v: number } | null = null;
  let maxJump = 0;
  let maxTurn = 0;
  let overlaps = 0;
  return {
    frame(sim?: Vehicle) {
      const m = game.garages.moveOf(building);
      const car = m ? { pos: m.pos, dir: m.dir, v: m.sim ? 0 : 6 } : sim && game.traffic.vehicles.has(sim.id) ? { pos: sim.pos, dir: sim.dir, v: sim.v } : null;
      if (!car) {
        prev = null;
        return;
      }
      if (prev) {
        const allowed = 2 * SIM_DT * Math.max(6, prev.v, car.v) + 0.05;
        maxJump = Math.max(maxJump, dist(prev.pos, car.pos) / allowed);
        maxTurn = Math.max(maxTurn, Math.abs(angleDiff(angleOf(prev.dir), angleOf(car.dir))));
      }
      prev = { ...car, pos: { ...car.pos }, dir: { ...car.dir } };
      const own = m?.sim ?? sim;
      for (const o of game.traffic.vehicles.values()) if (o !== own && overlap({ ...CAR, ...car }, o)) overlaps++;
    },
    get maxJump() {
      return maxJump;
    },
    get maxTurn() {
      return maxTurn;
    },
    get overlaps() {
      return overlaps;
    },
  };
}

describe('Гаражи частных домов', { timeout: 60_000 }, () => {
  it('выезд: задним ходом до бордюра, ждёт, пока проедет подъезжающая машина, встаёт на полосу и уезжает', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, home, slot } = garageHome(game, (h) => h.parks);
    const traffic = game.traffic;
    const target = slot.link.toNode!;
    // Машины у гаражей вблизи: эта стоит у ворот.
    const near = () => game.garageLooks(WORLD, true).filter((l) => dist(l.look.pos, home.spot) < home.d.width + 4);
    expect(near().length).toBe(1);
    game.garages.leave(home, town, target, { from: home.b, to: home.b });
    const w = watch(game, home.b.id);
    let sim: Vehicle | undefined;
    let other: Vehicle | null = null;
    let joinedAfter = -1;
    let waited = 0;
    for (let i = 0; i < 30 * 40 && !(sim && !game.garages.moveOf(home.b.id) && sim.v > 5); i++) {
      step(game);
      const m = game.garages.moveOf(home.b.id);
      if (m?.phase === 'wait') {
        waited += SIM_DT;
        // Доехала до бордюра — а сзади по полосе подъезжает машина: ей не хватило бы места спокойно остановиться.
        if (!other) {
          other = traffic.placeOnLane({ ...CAR, targetNode: target }, slot.lane.id, Math.max(0, slot.zone[0] - 30))!;
          other.v = 15;
          expect(traffic.clearToJoin(slot.lane.id, slot.zone[0], slot.zone[1])).toBe(false);
        }
      }
      if (m?.sim && !sim) {
        sim = m.sim;
        // Встаёт в поток, только когда подъезжавшая уже проехала заезд.
        const o = other!;
        joinedAfter = traffic.vehicles.has(o.id) && o.lane === slot.lane.id && !o.onMovement ? o.s - o.length - slot.zone[1] : Infinity;
      }
      w.frame(sim);
    }
    expect(sim).toBeDefined();
    expect(joinedAfter).toBeGreaterThan(0);
    expect(waited).toBeGreaterThan(1.5);
    expect(w.maxJump).toBeLessThanOrEqual(1);
    expect(w.maxTurn).toBeLessThan(0.15);
    expect(w.overlaps).toBe(0);
    // Едет по своей полосе носом по ходу, дом её ждёт обратно.
    expect(traffic.vehicles.has(sim!.id)).toBe(true);
    expect(game.roads.graph.lanes.get(sim!.lane)!.link).toBe(slot.link.id);
    expect(dot(sim!.dir, slot.f)).toBeGreaterThan(0.95);
    expect(game.tripOf(sim!.id)?.from).toBe(home.b);
    expect(town.garageAway).toContain(home.b.id);
    // Уехала — у ворот пусто.
    expect(near().length).toBe(0);
  });

  it.each([
    ['перед воротами', true],
    ['в гараж', false],
  ])('въезд %s: встаёт напротив заезда с поворотником, сворачивает передом, едущая следом ждёт', (_name, parks) => {
    const game = withoutCitizens(freshGame(7));
    const { town, home, slot } = garageHome(game, (h) => h.parks === parks);
    const traffic = game.traffic;
    town.garageAway = [home.b.id];
    const from = slot.link.fromNode!;
    const route = game.garages.routeHome(from, slot)!;
    expect(route[route.length - 1]).toBe(slot.link.id);
    const sim = traffic.spawn({ ...CAR, color: home.color, targetNode: slot.link.toNode!, route })!;
    game.citizenCars++;
    game.garages.homeward(sim, home, town, slot);
    const arrivals = traffic.arrivals;
    const w = watch(game, home.b.id);
    let follower: Vehicle | null = null;
    let blinked = false;
    let done = false;
    for (let i = 0; i < 30 * 60 && !done; i++) {
      step(game);
      // Следом — машина к концу той же улицы: у заезда ждёт, пока передняя свернёт.
      if (i === 45) follower = traffic.spawn({ ...CAR, targetNode: slot.link.toNode!, route: [...route] });
      if (sim.holdDist !== undefined && sim.blinker === 1) blinked = true;
      w.frame(sim);
      done = !game.garages.moveOf(home.b.id) && !traffic.vehicles.has(sim.id) && !game.garages.homingOf(sim.id);
    }
    expect(done).toBe(true);
    expect(blinked).toBe(true);
    expect(follower).not.toBeNull();
    expect(w.maxJump).toBeLessThanOrEqual(1);
    expect(w.maxTurn).toBeLessThan(0.15);
    expect(w.overlaps).toBe(0);
    // Поездка засчитана, машина дома.
    expect(traffic.arrivals).toBe(arrivals + 1);
    expect(town.garageAway).not.toContain(home.b.id);
    const atHome = game.garageLooks(WORLD, true).filter((l) => dist(l.look.pos, home.spot) < home.d.width + 4);
    expect(atHome.length).toBe(parks ? 1 : 0);
  });

  it('въезд в гараж: линия маршрута — до ворот, машина проезжает в открытые ворота и пропадает, ворота закрыты', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, home, slot } = garageHome(game, (h) => h.kind === 'garage' && !h.parks);
    const traffic = game.traffic;
    // Дома машины не видно: она в гараже.
    const near = () => game.garageLooks(WORLD, true).filter((l) => dist(l.look.pos, home.d.gate) < 12);
    expect(near().length).toBe(0);
    town.garageAway = [home.b.id];
    const route = game.garages.routeHome(slot.link.fromNode!, slot)!;
    const sim = traffic.spawn({ ...CAR, color: home.color, targetNode: slot.link.toNode!, route })!;
    game.citizenCars++;
    game.garages.homeward(sim, home, town, slot);
    // Маршрут выбранной машины кончается у ворот (носом в гараже), а не на улице в конце полосы у дома.
    const g = game.roads.graph;
    const laneEnd = g.lanePose(slot.lane, slot.lane.length).pos;
    const end = (pts: Vec[]) => pts[pts.length - 1];
    let ahead = game.vehicleAhead(sim.id)!;
    expect(dist(end(ahead.pts), home.d.gate)).toBeLessThan(CAR.length + 1);
    expect(dist(end(ahead.pts), laneEnd)).toBeGreaterThan(15);
    expect(ahead.left).toBeLessThan(traffic.routeLeft(sim) + 40);
    let gateSeen = false;
    let lastPos: Vec | null = null;
    let turning = false;
    for (let i = 0; i < 30 * 60; i++) {
      step(game);
      if (traffic.vehicles.has(sim.id) && game.garages.moveOf(home.b.id)?.sim) {
        // Уже сворачивает: линия — только поворот и заезд, тоже до ворот.
        ahead = game.vehicleAhead(sim.id)!;
        expect(dist(end(ahead.pts), home.d.gate)).toBeLessThan(CAR.length + 1);
        turning = true;
      }
      const look = near()[0];
      if (look?.gate) {
        gateSeen = true;
        lastPos = look.look.pos;
      }
      if (!game.garages.moveOf(home.b.id) && !traffic.vehicles.has(sim.id) && game.garages.homingOf(sim.id) === undefined) break;
    }
    expect(turning).toBe(true);
    // Во дворе — с открытыми воротами (их рисует renderer поверх гаража), последней — уже за ними.
    expect(gateSeen).toBe(true);
    expect(dot(sub(lastPos!, home.d.gate), home.d.dir)).toBeGreaterThan(CAR.length / 2);
    expect(near().length).toBe(0);
    expect(town.garageAway).not.toContain(home.b.id);
  });

  it('дом с площадкой: машина стоит на площадке, выезжает с неё задним ходом и возвращается на неё', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, home, slot } = garageHome(game, (h) => h.kind === 'pad');
    expect(home.parks).toBe(true);
    expect(home.d.garage).toBe(false);
    const near = () => game.garageLooks(WORLD, true).filter((l) => dist(l.look.pos, home.spot) < 8);
    // Дома: машина на площадке, носом от улицы, без ворот.
    expect(near().length).toBe(1);
    expect(near()[0].gate).toBeUndefined();
    expect(dot(near()[0].look.dir, home.d.dir)).toBeGreaterThan(0.99);
    game.garages.leave(home, town, slot.link.toNode!, { from: home.b, to: home.b });
    let backed = false;
    for (let i = 0; i < 30 * 60 && !(town.garageAway?.includes(home.b.id) && !game.garages.moveOf(home.b.id)); i++) {
      step(game);
      const m = game.garages.moveOf(home.b.id);
      // Задним ходом: нос смотрит во двор, а едет к улице.
      if (m?.phase === 'yard' && dot(m.dir, home.d.dir) > 0.95) backed = true;
    }
    expect(backed).toBe(true);
    expect(town.garageAway).toContain(home.b.id);
    expect(near().length).toBe(0);
  });

  it('частота: на улице из 12 домов с машиной за 30 с — хотя бы один выезд или въезд (в среднем больше)', { timeout: 120_000 }, () => {
    const game = freshGame(7);
    let homes = 0;
    for (const t of game.towns)
      for (const b of t.buildings) {
        const h = b.kind === 'res' ? game.garages.homeOf(b) : null;
        if (h && game.garages.slotOf(h)) homes++;
      }
    runSeconds(game, 60);
    const seen = new Set<object>();
    let events = 0;
    const T = 90;
    runSeconds(game, T, () => {
      for (const m of game.garages.moves) {
        if (seen.has(m) || m.home.key < 0) continue;
        seen.add(m);
        events++;
      }
    });
    // Выезд или въезд на дом — раз в столько секунд; на 12 домах за 30 с — столько.
    const perHome = T / (events / homes);
    const per30on12 = (30 * 12) / perHome;
    // Хотя бы один (seed 7 — 1,14: у магазинов с проездом к рампе мест на стоянке меньше, больше машин жителей в
    // потоке у их предела, и поездок из гаражей чуть меньше; до проезда было 1,25).
    expect(per30on12).toBeGreaterThan(1);
  });

  it('по seed: одна и та же партия — те же выезды и возвращения; сохранение несёт уехавшие машины', () => {
    const a = freshGame(7);
    let outs = 0;
    let ins = 0;
    const seen = new Set<number>();
    let counted = true;
    runSeconds(a, 100, () => {
      // Машина во дворе — ещё не в потоке и не в счёте машин жителей.
      counted &&= a.citizenCars + a.serviceCars === a.traffic.vehicles.size;
      for (const t of a.towns)
        for (const id of t.garageAway ?? []) {
          const m = a.garages.moveOf(id);
          if (m && !seen.has(id * 2 + (m.kind === 'in' ? 1 : 0))) {
            seen.add(id * 2 + (m.kind === 'in' ? 1 : 0));
            if (m.kind === 'in') ins++;
            else outs++;
          }
        }
    });
    const state = (g: Game) => g.towns.map((t) => [t.garageTrips ?? 0, [...(t.garageAway ?? [])]]);
    // За полторы минуты из гаражей выезжали и в них возвращались (первые возвращения — к концу первой минуты).
    expect(counted).toBe(true);
    expect(outs).toBeGreaterThan(5);
    expect(ins).toBeGreaterThan(0);
    // Сохранение: уехавшие — те же, у ворот стоят ровно машины домов, чья машина дома.
    const save = JSON.stringify(a.toSave());
    const c = new Game(structuredClone(a.settings), JSON.parse(save));
    const d = new Game(structuredClone(a.settings), JSON.parse(save));
    expect(state(c)).toEqual(state(a));
    let want = 0;
    for (const t of c.towns) {
      const out = new Set(t.garageAway ?? []);
      for (const h of t.buildings) {
        const home = h.kind === 'res' ? c.garages.homeOf(h) : null;
        if (home?.parks && !out.has(h.id)) want++;
      }
    }
    expect(c.garages.looks(c.towns, WORLD, true).length).toBe(want);
    // Две загрузки одного сохранения дальше идут одинаково.
    runSeconds(c, 20);
    runSeconds(d, 20);
    expect(state(c)).toEqual(state(d));
    expect(c.traffic.arrivals).toBe(d.traffic.arrivals);
  });
});
