import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { add, dist, dot, norm, rightNormal, scale, sub, type Vec } from '../core/vec';
import type { WorldSettings } from '../world/settings';
import { type BodyLook, type Box, bodyBoxes, boxesOverlap, LOOP, loopPose, planLoop } from './crewLoop';
import { CREW_UNITS } from './crewLane';
import type { Game } from './game';
import { anchorOf, freshGame, road, roadPlan, runUntil, stationAtIndustry, stationExit, STREET, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 50_000_000, water: 'dry', construction: 'build' };

const anyOverlap = (a: readonly Box[], b: readonly Box[]) => a.some((x) => b.some((y) => boxesOverlap(x, y)));

/** Угол между курсами, рад. */
const turnOf = (a: Vec, b: Vec) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

describe('Петля разворота техники бригады (геометрия)', () => {
  it('курс — по следу задней оси: меняется не быстрее, чем позволяет радиус, без поворота на месте; в конце — во встречной полосе носом назад', () => {
    for (const unit of CREW_UNITS) {
      const spec = { length: unit.length, width: unit.width, body: unit.body };
      // Прямая дорога вдоль x, всё вокруг свободно; встречная полоса — на 7 м левее (по курсу налево — к −y).
      const plan = planLoop({ pos: { x: 0, y: 0 }, dir: { x: 1, y: 0 } }, spec, 7, () => 0)!;
      expect(plan, unit.body).toBeTruthy();
      let prev = loopPose(plan, 0);
      for (let s = 0.1; s <= plan.len; s += 0.1) {
        const p = loopPose(plan, s);
        // Нос идёт по окружности радиуса не меньше LOOP.r (задняя ось — ровно по нему): курс — не круче пути носа / r.
        expect(turnOf(prev.dir, p.dir), `${unit.body} на ${s.toFixed(1)} м`).toBeLessThanOrEqual(dist(prev.pos, p.pos) / LOOP.r + 1e-3);
        prev = p;
      }
      const end = loopPose(plan, plan.len);
      expect(end.dir.x).toBeCloseTo(-1, 2);
      // Задняя ось в конце — на встречной полосе (нос с ней на одной прямой вдоль полосы).
      expect(end.pos.y).toBeCloseTo(-7, 0);
    }
  });
});

/** Машина на карте и откуда она (бригада.машина или грузовик). */
interface Seen extends BodyLook {
  key: string;
}

/**
 * Предприятие со станцией в чистом поле; готовая улица подходит к выезду станции не до конца — последние 150 м до него
 * проект «Со строительством» (короткая улица 1+1 кончается у станции, дальше — только её выезд, тупик у ворот).
 * База бригады — у готовой улицы; на линии со второй станцией три грузовика ждут на постах, пока улицу не достроят.
 */
function stationScene() {
  const game = withoutCitizens(freshGame(WORLD));
  const directions = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
  const approach = (() => {
    for (const industry of game.industries) for (const dir of directions) {
      const st = stationAtIndustry(game, industry, add(industry.fp.center, dir));
      if (!st) continue;
      const exit = stationExit(game, st.nodeId);
      const away = norm(sub(exit.pos, game.roads.net.node(st.nodeId).pos));
      const near = add(exit.pos, scale(away, 150));
      const far = add(exit.pos, scale(away, 450));
      if (roadPlan(game, { free: near }, exit.id, STREET).ok && road(game, { free: far }, { free: near }, STREET)) {
        return { st, exit, away, near, far };
      }
      game.removeStation(st);
    }
    throw new Error('нет свободной полосы для подъезда к грузовой станции');
  })();
  const { st, exit, away, near, far } = approach;
  const side = rightNormal(away);
  const base = [0, 75, 125].flatMap((back) => [-40, 40].map((off) => add(add(far, scale(away, -back)), scale(side, off))))
    .find((p) => game.basePlan(p).ok);
  expect(base).toBeTruthy();
  expect(game.buildBase(base!)).toBeNull();
  let other = null;
  for (const along of [120, 200, 80, 250]) for (const off of [-40, 40, -60, 60]) other ??= game.placeStation(add(add(near, scale(away, along)), scale(side, off)), 60);
  expect(other).toBeTruthy();
  const line = game.createLine([st.id, other!.id])!;
  for (let i = 0; i < 3; i++) expect(game.buyVehicle(line.id, 'truck')).toBeTruthy();
  const id = game.construction.peekId();
  const plan = game.roadBuilder.road(anchorOf(game, near), anchorOf(game, exit.id), STREET, { project: true });
  expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
  return { game, id, st: game.stations.get(st.id)! };
}

/** Машины бригад (на стройке, на местах и в потоке) и грузовики линии (в потоке и на постах станции st). */
function seen(game: Game, stationId: number): { crews: Seen[]; trucks: Seen[] } {
  const crews: Seen[] = [];
  const c = game.construction.crews;
  for (const b of c.brigades.values()) {
    for (const m of c.carsAt(b)) {
      const u = CREW_UNITS[m.car];
      crews.push({ key: `${b.id}.${m.car}`, length: u.length, width: u.width, body: u.body, pos: m.pos, dir: m.dir });
    }
    b.convoy?.cars.forEach((car, k) => {
      const v = 'sim' in car ? game.traffic.vehicles.get(car.sim) : undefined;
      if (v) crews.push({ key: `${b.id}.${k}`, ...v });
    });
  }
  const trucks: Seen[] = [];
  for (const v of game.fleet.values()) {
    const sim = v.simId !== null ? game.traffic.vehicles.get(v.simId) : undefined;
    if (sim) trucks.push({ key: `грузовик ${v.id}`, ...sim });
  }
  game.bayLooks(game.stations.get(stationId)!).forEach((look, i) => trucks.push({ key: `на посту ${i}`, ...look }));
  return { crews, trucks };
}

describe('Техника бригады у грузовой станции в конце стройки', () => {
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });

  it('разворачивается петлёй у дороги по одной, не заезжая на станцию: без поворота на месте, не задевая друг друга и грузовики', () => {
    const { game, id, st } = stationScene();
    expect(runUntil(game, 200, () => !game.construction.projects.has(id))).toBe(true);
    const at = st.fp.center;
    // Станция с площадкой перед постами (ворота — в 5 м от постов).
    const yard: Box = { c: at, d: { x: Math.cos(st.fp.angle), y: Math.sin(st.fp.angle) }, hl: st.fp.w / 2 + 5, hw: st.fp.h / 2 + 5 };
    const looped = new Set<number>();
    const prev = new Map<string, { pos: Vec; dir: Vec }>();
    let fast = '';
    let hit = '';
    let onYard = '';
    const gone = runUntil(game, 150, () => {
      for (const a of game.crewLoops.active()) looped.add(a.sim);
      const { crews, trucks } = seen(game, st.id);
      const near = crews.filter((m) => dist(m.pos, at) < 150);
      for (const m of near) {
        const w = prev.get(m.key);
        // Курс за такт — не круче, чем нос проехал по окружности радиуса чуть меньше петли (запас — на съезд в полосу).
        if (w && !fast && turnOf(w.dir, m.dir) > dist(w.pos, m.pos) / (LOOP.r - 1) + 0.01) fast = `${m.key}: ${dist(w.pos, m.pos).toFixed(2)} м, ${((turnOf(w.dir, m.dir) * 180) / Math.PI).toFixed(1)}°`;
        prev.set(m.key, { pos: { ...m.pos }, dir: { ...m.dir } });
        const own = bodyBoxes(m, -0.3);
        if (!onYard && anyOverlap(own, [yard])) onYard = m.key;
        for (const o of [...near, ...trucks]) if (!hit && o.key !== m.key && anyOverlap(own, bodyBoxes(o, -0.3))) hit = `${m.key} и ${o.key}`;
      }
      // Все бригады — в потоке и отъехали от станции (или уже дома).
      return [...game.construction.crews.brigades.values()].every(
        (b) => b.state === 'idle' || (!!b.convoy && b.convoy.cars.every((c) => 'sim' in c && dist(game.traffic.vehicles.get(c.sim)!.pos, at) > 150)),
      );
    });
    expect.soft(fast).toBe('');
    expect.soft(hit).toBe('');
    expect.soft(onYard).toBe('');
    expect(gone).toBe(true);
    expect(looped.size).toBe(3);
  });
});
