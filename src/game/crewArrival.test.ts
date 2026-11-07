import { describe, expect, it } from 'vitest';
import { dist, dot, scale, sub, type Vec } from '../core/vec';
import { hitchOf } from '../sim/body';
import type { WorldSettings } from '../world/settings';
import { CREW_UNITS, lanePose, laneTrail } from './crewLane';
import type { Brigade } from './crews';
import { Game } from './game';
import { anchorOf, fieldSpot, road, runSeconds, STREET, withoutCitizens } from './testkit';

/**
 * Техника бригады от выезда с базы до работы и обратно — одним непрерывным путём: машины колонны не накладываются,
 * не перескакивают (ни у подъезда, ни при переходе «приехали → работают», ни при выезде с готовой дороги) и едут
 * только по своему курсу — ни боком, ни по диагонали.
 */
describe('Бригада: от подъезда к работе без скачков и без езды боком', () => {
  const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

  /** Машина бригады: нос, курс, вторая часть (по её следу), в потоке ли она. */
  interface Pose {
    pos: Vec;
    dir: Vec;
    trail?: Vec;
    sim: boolean;
  }

  /** Где сейчас машины бригады (по номеру; нет — не видно: на базе или не выехала). */
  function poses(game: Game, b: Brigade): (Pose | null)[] {
    const crews = game.construction.crews;
    const out: (Pose | null)[] = [null, null, null];
    b.convoy?.cars.forEach((c, k) => {
      const v = 'sim' in c ? game.traffic.vehicles.get(c.sim) : undefined;
      if (v) out[k] = { pos: { ...v.pos }, dir: { ...v.dir }, trail: v.trail ? { ...v.trail } : undefined, sim: true };
    });
    for (const m of crews.carsAt(b)) {
      const h = hitchOf(CREW_UNITS[m.car].body);
      const L = CREW_UNITS[m.car].length;
      const trail = h && b.lane && m.s !== undefined ? laneTrail(b.lane, m.s, m.pos, m.dir, h.joint * L, h.tail * L) : undefined;
      out[m.car] = { pos: { ...m.pos }, dir: { ...m.dir }, trail, sim: false };
    }
    return out;
  }

  /** Части кузова машины k прямоугольниками: центр, курс, полудлина и полуширина (с запасом внутрь). */
  function boxes(k: number, p: Pose): { c: Vec; d: Vec; hl: number; hw: number }[] {
    const u = CREW_UNITS[k];
    const L = u.length;
    const hw = u.width / 2 - 0.4;
    const h = hitchOf(u.body);
    if (!h) return [{ c: sub(p.pos, scale(p.dir, L / 2)), d: p.dir, hl: L / 2 - 0.4, hw }];
    const front = { c: sub(p.pos, scale(p.dir, (h.front * L) / 2)), d: p.dir, hl: (h.front * L) / 2 - 0.4, hw };
    const joint = sub(p.pos, scale(p.dir, h.joint * L));
    let td = p.dir;
    if (p.trail) {
      const v = sub(joint, p.trail);
      const l = Math.hypot(v.x, v.y);
      if (l > 1e-6) td = scale(v, 1 / l);
    }
    const x0 = (h.back - h.joint) * L;
    const x1 = (1 - h.joint) * L;
    const rear = { c: sub(joint, scale(td, (x0 + x1) / 2)), d: td, hl: (x1 - x0) / 2 - 0.4, hw };
    return [front, rear];
  }

  /** Пересекаются ли два прямоугольника (по разделяющим осям). */
  function overlap(a: { c: Vec; d: Vec; hl: number; hw: number }, b: { c: Vec; d: Vec; hl: number; hw: number }): boolean {
    const axes = [a.d, { x: -a.d.y, y: a.d.x }, b.d, { x: -b.d.y, y: b.d.x }];
    const r = (q: typeof a, ax: Vec) => Math.abs(dot(q.d, ax)) * q.hl + Math.abs(dot({ x: -q.d.y, y: q.d.x }, ax)) * q.hw;
    for (const ax of axes) if (Math.abs(dot(sub(a.c, b.c), ax)) > r(a, ax) + r(b, ax)) return false;
    return true;
  }

  /**
   * Две улицы с запада на восток (через 300 м) и перемычка между ними на востоке; база у западного конца северной.
   * Проект — улица с юга на север посередине, от северной улицы к южной (как на записях игрока: стройка от
   * Т-перекрёстка, кончается у готовой дороги): колонна приезжает с запада к перекрёстку, съезжает на стройку с
   * поворотом, а достроив — выезжает на южную улицу и едет домой по кругу.
   */
  function scene() {
    const game = withoutCitizens(new Game(WORLD));
    const at = fieldSpot(game, 1000, 320);
    const south = at.y + 300;
    expect(road(game, { free: at }, { free: { x: at.x + 1000, y: at.y } })).toBe(true);
    expect(road(game, { free: { x: at.x, y: south } }, { free: { x: at.x + 1000, y: south } })).toBe(true);
    expect(road(game, { x: at.x + 1000, y: at.y }, { x: at.x + 1000, y: south })).toBe(true);
    expect(game.buildBase({ x: at.x + 120, y: at.y - 40 })).toBeNull();
    const id = game.construction.peekId();
    const plan = game.roadBuilder.road(anchorOf(game, { x: at.x + 500, y: at.y }), anchorOf(game, { x: at.x + 500, y: south }), STREET, { project: true });
    expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
    const b = [...game.construction.crews.brigades.values()][0];
    return { game, at, id, b };
  }

  it('у подъезда машины встают друг за другом, съезжают на стройку на свои места и работают — без скачков, курсом вперёд; выезжают с готовой дороги так же', () => {
    const { game, id, b } = scene();
    let prev: (Pose | null)[] = poses(game, b);
    let maxStep = 0;
    let where = '';
    let whereSite = '';
    let worstSite = 1;
    let worstSim = 1;
    let worked = 0;
    let gathered = false;
    let after = -1;
    const done = () => !game.construction.projects.has(id);
    for (let t = 0; t < 400; t += 0.1) {
      runSeconds(game, 0.1);
      const now = poses(game, b);
      if (b.state === 'working') worked++;
      if (b.lane) gathered = true;
      for (let k = 0; k < 3; k++) {
        const p = prev[k];
        const q = now[k];
        if (!p || !q) continue;
        const step = dist(p.pos, q.pos);
        if (step > maxStep) where = `машина ${k} в ${t.toFixed(1)} с (${p.sim ? 'в потоке' : 'вне потока'} → ${q.sim ? 'в потоке' : 'вне потока'})`;
        maxStep = Math.max(maxStep, step);
        // Курс корпуса — туда же, куда машина едет: вне потока — строго (по оси, на повороте — по дуге), в потоке —
        // как у любой машины симуляции (корпус догоняет нос на повороте).
        if (step > 0.3) {
          // Курс за шаг — средний (на дуге хорда идёт по среднему курсу, а не по конечному).
          const mid = { x: p.dir.x + q.dir.x, y: p.dir.y + q.dir.y };
          const along = dot(scale(sub(q.pos, p.pos), 1 / step), scale(mid, 1 / Math.max(1e-9, Math.hypot(mid.x, mid.y))));
          if (q.sim) worstSim = Math.min(worstSim, along);
          else {
            if (along < worstSite) whereSite = `машина ${k} в ${t.toFixed(1)} с, ${b.state}, ${p.sim ? 'из потока' : ''} ход ${(q.pos.x - p.pos.x).toFixed(2)},${(q.pos.y - p.pos.y).toFixed(2)} курс ${q.dir.x.toFixed(2)},${q.dir.y.toFixed(2)}`;
            worstSite = Math.min(worstSite, along);
          }
        }
      }
      // Машины не наезжают друг на друга.
      for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
          const p = now[i];
          const q = now[j];
          if (!p || !q) continue;
          for (const x of boxes(i, p)) for (const y of boxes(j, q)) expect(overlap(x, y), `машины ${i} и ${j} в ${t.toFixed(1)} с`).toBe(false);
        }
      }
      prev = now;
      // Достроили, и вся колонна выехала в поток с мест — ещё 10 с (съезжают в полосу и уезжают), и хватит.
      if (done() && after < 0 && b.convoy?.cars.every((c) => 'sim' in c)) after = t;
      if (after >= 0 && t - after > 10) break;
    }
    const left = after >= 0;
    expect(gathered).toBe(true);
    expect(worked).toBeGreaterThan(50);
    expect(done()).toBe(true);
    expect(left).toBe(true);
    // За шаг 0,1 с — не дальше 3 м (быстрее 30 м/с техника не ездит): нигде ни скачка.
    expect(maxStep, where).toBeLessThan(3);
    // Вне потока — не больше 12° между курсом и ходом; в потоке — не больше 45°.
    expect(worstSite, whereSite).toBeGreaterThan(Math.cos((12 * Math.PI) / 180));
    expect(worstSim).toBeGreaterThan(Math.cos((45 * Math.PI) / 180));
  });

  it('доехавшие машины ждут у подъезда друг за другом, а не в одной точке; места на полосе совпадают с местами в колонне этапов', () => {
    const { game, b } = scene();
    for (let t = 0; t < 120 && !b.lane; t += 0.1) runSeconds(game, 0.1);
    expect(b.lane).toBeDefined();
    const lane = b.lane!;
    // Колонна собралась в потоке друг за другом: машины стояли на своих местах на полосе, от хвоста к голове.
    expect(lane.from).toBeDefined();
    const from = lane.from!;
    expect(from[0] - from[1]).toBeGreaterThan(CREW_UNITS[0].length);
    expect(from[1] - from[2]).toBeGreaterThan(CREW_UNITS[1].length);
    // Головная собралась у начала участка (у стоп-линии перед перекрёстком), остальные — за ней на подъезде.
    expect(Math.abs(from[0] - lane.legs[0].at)).toBeLessThan(8);
    // Поехали — и встали на места в колонне этапов на той же полосе: доезжают и дальше идут вместе с ними.
    let settled = false;
    for (let t = 0; t < 30 && !settled; t += 0.1) {
      runSeconds(game, 0.1);
      const slots = game.construction.crewSlots(b);
      settled = !!slots && game.construction.crews.carsAt(b).every((m, k) => Math.abs(m.s! - slots[k]) < 1e-6);
    }
    expect(settled).toBe(true);
    expect(b.state).toBe('working');
    // Колонна этапов — на оси участка: начало заполнения — на полосе у перекрёстка, к нему и съехали.
    const c = game.construction.current(game.construction.list()[0].project.id)!;
    expect(dist(lanePose(lane, lane.legs[0].at + 30).pos, c.lut.pointAt(c.build!.fromB ? c.length - 30 : 30))).toBeLessThan(0.5);
  });
});
