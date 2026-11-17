import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { dist, dot, scale, sub, type Vec } from '../core/vec';
import type { WorldSettings } from '../world/settings';
import { CREW_UNITS } from './crewLane';
import type { Brigade } from './crews';
import { Game } from './game';
import { anchorOf, freshGame, HIGHWAY, openSpot, road, runSeconds, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 50_000_000, water: 'dry', construction: 'build' };

/** Машина бригады на карте: нос и курс, и откуда она видна (полоса бригады, место стоянки или поток). */
interface Car {
  key: string;
  crew: number;
  car: number;
  pos: Vec;
  dir: Vec;
}

/** Все машины бригад: на стройке и стоящие (carsAt) и в потоке. */
function cars(game: Game): Car[] {
  const crews = game.construction.crews;
  const out: Car[] = [];
  const add = (b: Brigade, car: number, pos: Vec, dir: Vec) => out.push({ key: `${b.id}.${car}`, crew: b.id, car, pos: { ...pos }, dir: { ...dir } });
  for (const b of crews.brigades.values()) {
    for (const m of crews.carsAt(b)) add(b, m.car, m.pos, m.dir);
    b.convoy?.cars.forEach((c, k) => {
      const v = 'sim' in c ? game.traffic.vehicles.get(c.sim) : undefined;
      if (v) add(b, k, v.pos, v.dir);
    });
  }
  return out;
}

/** Кузов машины прямоугольником (с запасом внутрь): центр, курс, полудлина, полуширина. */
function box(m: Car) {
  const u = CREW_UNITS[m.car];
  return { c: sub(m.pos, scale(m.dir, u.length / 2)), d: m.dir, hl: u.length / 2 - 0.6, hw: u.width / 2 - 0.4 };
}

function overlap(a: ReturnType<typeof box>, b: ReturnType<typeof box>): boolean {
  const axes = [a.d, { x: -a.d.y, y: a.d.x }, b.d, { x: -b.d.y, y: b.d.x }];
  const r = (q: typeof a, ax: Vec) => Math.abs(dot(q.d, ax)) * q.hl + Math.abs(dot({ x: -q.d.y, y: q.d.x }, ax)) * q.hw;
  for (const ax of axes) if (Math.abs(dot(sub(a.c, b.c), ax)) > r(a, ax) + r(b, ax)) return false;
  return true;
}

/**
 * Проект — шоссе 1+1 в поле от тупика готового шоссе, кончается тупиком; n бригад с одной базы выезжают разом, у
 * начала съезжают на стройку по очереди.
 */
function scene(n: number) {
  const game = withoutCitizens(freshGame(WORLD));
  const at = openSpot(game, [[{ x: -250, y: 0 }, { x: 700, y: 0 }, 150]]);
  expect(road(game, { free: { x: at.x - 250, y: at.y } }, { free: at }, HIGHWAY)).toBe(true);
  expect(game.buildBase({ x: at.x - 200, y: at.y - 40 })).toBeNull();
  const crews = game.construction.crews;
  const base = [...crews.bases.values()][0];
  for (let i = 1; i < n; i++) crews.hire(base.id);
  const id = game.construction.peekId();
  const plan = game.roadBuilder.road(anchorOf(game, at), anchorOf(game, { free: { x: at.x + 400, y: at.y } }), HIGHWAY, { project: true });
  expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
  return { game, id };
}

describe('Бригады у начала и у тупика в конце проекта', () => {
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });

  it('проект кончился тупиком: машины выезжают в поток с мест, разворачиваются в тупике — без скачка и без поворота на месте', () => {
    // Две бригады: вторая работает в ряду над встречной — раньше её машины выезжали от узла тупика носом назад.
    const { game, id } = scene(2);
    const prev = new Map<string, Car & { t: number }>();
    let maxStep = 0;
    let maxTurn = 0;
    let where = '';
    let done = -1;
    let gone = false;
    for (let t = 0; t < 300; t += 0.1) {
      runSeconds(game, 0.1);
      if (done < 0 && !game.construction.projects.has(id)) done = t;
      const now = cars(game);
      for (const m of now) {
        const w = prev.get(m.key);
        if (w && w.t > t - 0.15) {
          const step = dist(w.pos, m.pos);
          const turn = (Math.acos(Math.max(-1, Math.min(1, dot(w.dir, m.dir)))) * 180) / Math.PI;
          if (step > maxStep || turn > maxTurn) where = `машина ${m.key} в ${t.toFixed(1)} с: ${step.toFixed(1)} м, ${turn.toFixed(0)}°`;
          maxStep = Math.max(maxStep, step);
          maxTurn = Math.max(maxTurn, turn);
        }
        prev.set(m.key, { ...m, t });
      }
      // Все в потоке и отъехали от тупика.
      if (done >= 0 && t > done + 5 && [...game.construction.crews.brigades.values()].every((b) => b.convoy?.cars.every((c) => 'sim' in c) ?? b.state === 'idle')) {
        gone = true;
        if (t > done + 25) break;
      }
    }
    expect(done).toBeGreaterThan(0);
    expect(gone).toBe(true);
    // За 0,1 с — не дальше 3,5 м и курс не больше чем на 20° (разворот в тупике — дугой, как у всех машин).
    expect(maxStep, where).toBeLessThan(3.5);
    expect(maxTurn, where).toBeLessThan(20);
  });

  it('три бригады съезжают на стройку по очереди: следующая проходит мимо стоящих, а не сквозь них', () => {
    const { game, id } = scene(3);
    let hit = '';
    const rooms = new Map<number, number>();
    let worked = 0;
    for (let t = 0; t < 300 && game.construction.projects.has(id); t += 0.1) {
      runSeconds(game, 0.1);
      const now = cars(game);
      if (game.construction.crews.working(id).length === 3) worked++;
      // Первые две съезжают, зная, что за ними едут ещё (ждут подальше), последняя — нет.
      for (const b of game.construction.crews.brigades.values()) if (b.lane && !rooms.has(b.id)) rooms.set(b.id, b.lane.room ?? 0);
      for (let i = 0; i < now.length && !hit; i++)
        for (let j = i + 1; j < now.length; j++)
          if (now[i].crew !== now[j].crew && overlap(box(now[i]), box(now[j]))) {
            hit = `${now[i].key} и ${now[j].key} в ${t.toFixed(1)} с`;
            break;
          }
    }
    expect(worked).toBeGreaterThan(100);
    expect(hit).toBe('');
    expect([...rooms.values()].filter((r) => r > 0).length).toBe(2);
    expect(rooms.size).toBe(3);
  });
});
