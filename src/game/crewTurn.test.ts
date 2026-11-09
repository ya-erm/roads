import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION, SIM_DT } from '../config';
import { dist, dot, rightNormal, sub, type Vec } from '../core/vec';
import { edgesAt } from '../lanes/geometry';
import type { Corridor } from '../lanes/model';
import { hitchOf } from '../sim/body';
import { ROAD_MARGIN } from '../world/roadTypes';
import type { BuildBase } from '../world/entities';
import type { WorldSettings } from '../world/settings';
import { CREW_UNITS, type CrewLane, crewSpacing, lanePose, laneCarPose, laneTrail, planTurn, TURN_SPEED, turnRoom, U_TURN } from './crewLane';
import { Game } from './game';
import { anchorOf, AVENUE, clearStrip, road, runSeconds, STREET, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

/** Самый резкий поворот корпуса за такт, градусы: на развороте — не больше. */
const MAX_TURN_PER_TICK = 4;

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff' };

const angle = (a: Vec, b: Vec) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;

function nodeAt(game: Game, p: Vec): number | null {
  return [...game.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - p.x, n.pos.y - p.y) < 1)?.id ?? null;
}

/** Готовая улица 1+1 длиной len на восток с подъездом от базы с запада и куском улицы за дальним концом (как в rebuild.test.ts). */
function scene(len = 600): { game: Game; c: Corridor; at: Vec; base: BuildBase } {
  const game = withoutCitizens(new Game(WORLD));
  let at: Vec | null = null;
  for (let y = 400; y < game.terrain.height - 400 && !at; y += 120) {
    for (let x = 300; x < game.terrain.width - len - 300 && !at; x += 160) {
      if (!clearStrip(game, { x: x - 120, y }, { x: x + len + 100, y }, 200)) continue;
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x: x - 90, y } }), anchorOf(game, { free: { x: x + len, y } }), STREET);
      if (plan.ok && !plan.demolish.length) at = { x, y };
    }
  }
  if (!at) throw new Error('нет места');
  const gate = { x: at.x - 90, y: at.y };
  expect(road(game, { free: gate }, { free: at })).toBe(true);
  expect(road(game, nodeAt(game, at)!, { free: { x: at.x + len, y: at.y } })).toBe(true);
  expect(road(game, nodeAt(game, { x: at.x + len, y: at.y })!, { free: { x: at.x + len + 90, y: at.y } })).toBe(true);
  const crews = game.construction.crews;
  const base: BuildBase = { type: 'base', id: 990_000, fp: { center: { x: gate.x, y: gate.y + 40 }, w: 36, h: 24, angle: 0 }, nodeId: nodeAt(game, gate)! };
  crews.bases.set(base.id, base);
  crews.hire(base.id);
  const c = [...game.roads.net.corridors.values()].find((k) => Math.abs(k.lut.pointAt(k.length / 2).x - (at.x + len / 2)) < 2)!;
  return { game, c, at, base };
}

const live = (game: Game, id: number) => game.roads.net.corridors.get(id)!;

/** Точки машины, что не должны выходить за полотно: нос, углы первой части, шарнир, задняя ось второй части. */
function bodyPoints(m: { car: number; pos: Vec; dir: Vec; s?: number }, lane: CrewLane): Vec[] {
  const spec = CREW_UNITS[m.car];
  const h = hitchOf(spec.body);
  const n = rightNormal(m.dir);
  const w = spec.width / 2;
  const front = (h ? h.front : 1) * spec.length;
  const at = (back: number, side: number): Vec => ({ x: m.pos.x - m.dir.x * back + n.x * side, y: m.pos.y - m.dir.y * back + n.y * side });
  const pts = [at(0, -w), at(0, w), at(front, -w), at(front, w)];
  if (h && m.s !== undefined) {
    const j = at(h.joint * spec.length, 0);
    pts.push(j, laneTrail(lane, m.s, m.pos, m.dir, h.joint * spec.length, h.tail * spec.length, m.car));
  }
  return pts;
}

describe('Разворот бригады на второй проход «с проездом»', () => {
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });

  it('дугой через обе половины, курс — плавно, машины по очереди тем же путём, в очистку реверса, не за полотном', () => {
    const { game, c, at } = scene();
    expect(game.roadBuilder.apply(game.roadBuilder.rebuild(c.id, { cls: AVENUE.cls, lanes: AVENUE.lanes }))).toBe(true);
    const id = live(game, c.id).build!.project;
    const crews = game.construction.crews;
    // Машины в обе стороны всё время, пока идёт проход и разворот.
    const gate = nodeAt(game, { x: at.x - 90, y: at.y })!;
    const far = nodeAt(game, { x: at.x + c.length + 90, y: at.y })!;
    const spawn = () => {
      for (const [from, to] of [
        [gate, far],
        [far, gate],
      ]) {
        const route = game.roads.route(from, to);
        if (route) game.traffic.spawn({ ...CAR, targetNode: to, route });
      }
    };
    // До конца первого прохода.
    let t = 0;
    for (; t < 600; t += 0.5) {
      runSeconds(game, 0.5);
      const b = live(game, c.id).build!;
      if (b.done > 0 && Math.round(t * 2) % 8 === 0) spawn();
      if (b.done > 0 && b.stages && b.stages[2] >= c.length - 1e-6) break;
    }
    const b1 = live(game, c.id).build!;
    expect(b1.pass).toBeUndefined();
    expect(b1.stages![2]).toBeGreaterThanOrEqual(c.length - 1e-6);
    const crew = crews.working(id)[0];
    expect(crew.lane?.turn).toBeTruthy();
    const turn = crew.lane!.turn!;
    // Колонна стоит так, что весь разворот — на участке под реверсом, до дальней стоп-линии.
    const sig0 = game.workSignals.list.get(c.id)!;
    expect(sig0).toBeTruthy();
    // Дальше — такт за тактом.
    const prev = new Map<number, Vec>();
    let worst = 0;
    let outside = 0;
    let released = -1;
    let redWhileTurning = true;
    let inZone = 0;
    let order = true;
    let earthEarly = false;
    const fromB2 = !b1.fromB;
    const t0turn = game.time;
    const L = c.length;
    for (let i = 0; i < 30 * 200; i++) {
      const t0 = game.time;
      game.speed = 1;
      game.update(SIM_DT);
      const ticks = Math.max(1, Math.round((game.time - t0) / SIM_DT));
      const lane = crew.lane!;
      const k = live(game, c.id);
      const cars = crews.carsAt(crew);
      if (released < 0 && !lane.turn?.wait) released = game.time;
      for (const m of cars) {
        const was = prev.get(m.car);
        if (was) worst = Math.max(worst, angle(was, m.dir) / ticks);
        prev.set(m.car, m.dir);
        for (const p of bodyPoints(m, lane)) {
          const hit = k.lut.closest(p);
          const e = edgesAt(k, hit.s) ?? [-14, 14];
          const lat = dot(sub(p, k.lut.pointAt(hit.s)), rightNormal(k.lut.tangentAt(hit.s)));
          if (lat < e[0] - ROAD_MARGIN - 0.05 || lat > e[1] + ROAD_MARGIN + 0.05) outside++;
        }
      }
      if (i % 120 === 0) spawn();
      // На развороте — красный обеим сторонам, и между стоп-линиями никого.
      const s = cars.map((m) => m.s ?? 0);
      const sig = game.workSignals.list.get(c.id);
      if (lane.turn && !lane.turn.wait && s.some((x) => x < lane.turn!.end && x > lane.turn!.lead - 1) && sig) {
        if (sig.state.go !== 0) redWhileTurning = false;
        for (const link of game.roads.graph.corridorLinks(c.id))
          for (const l of link.lanes) for (const v of l.vehicles) if (v.centerS > sig.stops[0] && v.centerS < sig.stops[1]) inZone++;
      }
      // Следом друг за другом, не ближе своей длины с зазором.
      if (s[1] > s[0] - crewSpacing(0) + 0.01 || s[2] > s[1] - crewSpacing(1) + 0.01) order = false;
      // Отсыпка второго прохода — не раньше, чем грейдер доехал до своего места за разворотом.
      if (k.build?.pass === 2 && (k.build.stages?.[0] ?? 0) > 0 && s[0] < turn.end) earthEarly = true;
      if (k.build?.pass === 2 && (k.build.stages?.[0] ?? 0) > 30) break;
    }
    const b2 = live(game, c.id).build!;
    expect(b2.pass).toBe(2);
    expect(!!b2.fromB).toBe(fromB2);
    expect(released).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(MAX_TURN_PER_TICK);
    expect(outside).toBe(0);
    expect(redWhileTurning).toBe(true);
    expect(inZone).toBe(0);
    // Ждали очистки участка — не дольше зелёного и очистки.
    expect(released - t0turn).toBeLessThan(CONSTRUCTION.rebuild.reverse.green[1] + 60);
    expect(order).toBe(true);
    expect(earthEarly).toBe(false);
    // Машины после разворота — в ряду второго прохода, носом навстречу первому.
    const cars = crews.carsAt(crew);
    const axis = live(game, c.id).lut.tangentAt(L / 2);
    for (const m of cars) expect(dot(m.dir, axis) * (fromB2 ? -1 : 1)).toBeGreaterThan(0.99);
  });
});

describe('Разворот: геометрия (planTurn)', () => {
  /** Прямая полоса по оси x: прежний путь — на восток в ряду row справа, новая — на запад. */
  function straight(row: number, room: number) {
    const old = (s: number) => ({ pos: { x: s, y: row }, dir: { x: 1, y: 0 } });
    const next: CrewLane = { path: [{ x: 300, y: 0 }, { x: -300, y: 0 }], legs: [{ corridor: 1, fromB: true, at: 0 }], shifts: [{ at: -1e4, to: row }] };
    const cars = [100, 100 - crewSpacing(0), 100 - crewSpacing(0) - crewSpacing(1)];
    const plan = planTurn(old, row, cars, next, room);
    const lane: CrewLane = { ...next, turn: plan.turn, from: plan.from, t0: 0, t: plan.from.map(() => 0) };
    return { lane, plan, cars };
  }

  /** Курс и место носа машины car по ходу времени с TURN_SPEED: самый резкий поворот за такт и самый дальний вынос от оси. */
  function drive(lane: CrewLane, car: number) {
    let worst = 0;
    let far = 0;
    let ahead = -Infinity;
    let was: Vec | null = null;
    const s0 = lane.from![car];
    for (let s = s0; s < lane.turn!.end + 30; s += TURN_SPEED * SIM_DT) {
      const p = laneCarPose(lane, car, s);
      if (was) worst = Math.max(worst, angle(was, p.dir));
      was = p.dir;
      far = Math.max(far, Math.abs(p.pos.y));
      ahead = Math.max(ahead, p.pos.x);
    }
    return { worst, far, ahead, end: laneCarPose(lane, car, lane.turn!.end + 30) };
  }

  it('широко — одной дугой радиусом с полуширину, не дальше от оси, чем можно; в конце — в ряду навстречу', () => {
    const room = turnRoom([-7, 7]);
    expect(room).toBeGreaterThan(U_TURN.min);
    const { lane, plan, cars } = straight(3.5, room);
    expect(plan.turn.back).toBeUndefined();
    // Машины — на своих местах прежнего пути.
    cars.forEach((s, k) => {
      expect(dist(lanePose(lane, plan.from[k]).pos, { x: s, y: 3.5 })).toBeLessThan(0.01);
    });
    for (let k = 0; k < 3; k++) {
      const r = drive(lane, k);
      expect(r.worst).toBeLessThanOrEqual(MAX_TURN_PER_TICK / 2);
      expect(r.far).toBeLessThanOrEqual(room + 0.05);
      expect(r.end.pos.y).toBeCloseTo(-3.5, 1);
      expect(r.end.dir.x).toBeCloseTo(-1, 3);
      // Все — одним путём: дальше всех вперёд — там же, где головная.
      expect(r.ahead).toBeCloseTo(drive(lane, 0).ahead, 3);
    }
  });

  it('узко — в три приёма: вперёд, назад, вперёд; курс плавный, нос не дальше от оси, чем можно', () => {
    const room = 2.4;
    const { lane, plan } = straight(0, room);
    expect(plan.turn.back).toBeTruthy();
    const [b0, b1] = plan.turn.back!;
    expect(b1).toBeGreaterThan(b0);
    // Задним ходом нос идёт против курса.
    const mid = (b0 + b1) / 2;
    const p0 = lanePose(lane, mid - 0.2).pos;
    const p1 = lanePose(lane, mid + 0.2).pos;
    expect(dot(sub(p1, p0), lanePose(lane, mid).dir)).toBeLessThan(0);
    for (let k = 0; k < 3; k++) {
      const r = drive(lane, k);
      expect(r.worst).toBeLessThanOrEqual(MAX_TURN_PER_TICK);
      expect(r.far).toBeLessThanOrEqual(room + 0.05);
      expect(r.end.dir.x).toBeCloseTo(-1, 3);
    }
  });
});
