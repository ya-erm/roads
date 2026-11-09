import { describe, expect, it } from 'vitest';
import { dist, dot, scale, sub, type Vec } from '../core/vec';
import { hitchOf } from '../sim/body';
import type { WorldSettings } from '../world/settings';
import { convoyGap, spansOf, stageSpans } from './constructionWork';
import { CREW_UNITS, laneCars, lanePose, laneTrail } from './crewLane';
import type { Brigade } from './crews';
import { Game } from './game';
import { anchorOf, openSpot, road, runSeconds, STREET, withoutCitizens } from './testkit';

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
    // Чистое поле под обе улицы (северную и южную, в 300 м) и проект между ними.
    const at = openSpot(game, [
      [{ x: 0, y: 0 }, { x: 1000, y: 0 }, 120],
      [{ x: 0, y: 300 }, { x: 1000, y: 300 }, 120],
    ]);
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

  it('у подъезда машины сходят на стройку по одной, едут на свои места и работают — без скачков, курсом вперёд, не наезжая друг на друга; выезжают с готовой дороги так же', () => {
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

  it('машины не ждут друг друга у подъезда: первая сходит на стройку и ведёт отсыпку, вторая — покрытие за ней с отставанием, третья — разметку', () => {
    const { game, id, b } = scene();
    const crews = game.construction.crews;
    for (let t = 0; t < 120 && !b.lane; t += 0.1) runSeconds(game, 0.1);
    expect(b.lane).toBeDefined();
    const lane = b.lane!;
    // Сошла одна головная (у начала участка, у стоп-линии перед перекрёстком), остальные ещё едут в потоке.
    expect(laneCars(lane)).toBe(1);
    expect(b.state).toBe('working');
    expect(b.convoy?.cars.slice(1).every((c) => 'sim' in c)).toBe(true);
    expect(Math.abs(lane.from![0] - lane.legs[0].at)).toBeLessThan(8);
    const c = game.construction.current(id)!;
    const L = c.length;
    const gap = convoyGap(L);
    let earthAlone = false;
    let paveBehind = false;
    let settled = false;
    for (let t = 0; t < 60 && !settled; t += 0.1) {
      runSeconds(game, 0.1);
      const [e, p, m] = spansOf(c.build, L);
      const placed = crews.placed(b);
      // Этап, чья машина не на месте, стоит.
      if (!placed[1]) expect(p).toBe(0);
      if (!placed[2]) expect(m).toBe(0);
      if (placed[0] && !placed[1] && e > 0) earthAlone = true;
      // Покрытие — за отсыпкой, не ближе интервала колонны; разметка — так же за покрытием.
      if (p > 0) {
        expect(p).toBeLessThanOrEqual(e - gap + 1e-6);
        paveBehind = true;
      }
      if (m > 0) expect(m).toBeLessThanOrEqual(p - gap + 1e-6);
      // Колонна сошла целиком и машины на своих местах в колонне этапов той же полосы.
      const slots = game.construction.crewSlots(b);
      settled = !b.convoy && !!slots && m > 0 && crews.carsAt(b).every((x, k) => Math.abs(x.s! - slots[k]) < 1e-6);
    }
    expect(earthAlone).toBe(true);
    expect(paveBehind).toBe(true);
    expect(settled).toBe(true);
    expect(laneCars(lane)).toBe(3);
    // Сошедшие следом — на ту же полосу, друг за другом.
    const from = lane.from!;
    expect(lane.t![1]).toBeGreaterThan(lane.t![0]);
    expect(lane.t![2]).toBeGreaterThan(lane.t![1]);
    expect(Math.abs(from[1] - from[0])).toBeLessThan(8);
    // Колонна этапов — на оси участка: начало заполнения — на полосе у перекрёстка, к нему и съехали.
    expect(dist(lanePose(lane, lane.legs[0].at + 30).pos, c.lut.pointAt(c.build!.fromB ? L - 30 : 30))).toBeLessThan(0.5);
  });

  it('деньги — те же: проект стоит столько, сколько стоил при заложении; сохранение, пока часть колонны в пути, открывается и достраивается', () => {
    const { game, id, b } = scene();
    const cost = game.construction.info(id)!.left;
    let spent = 0;
    const spend = game.spend.bind(game);
    game.spend = (x: number, kind) => {
      if (kind !== 'purchases') spent += x;
      spend(x, kind);
    };
    // Головная уже ведёт отсыпку, остальные ещё в пути.
    for (let t = 0; t < 120 && !(b.lane && crews(game).placed(b)[0] && b.convoy); t += 0.1) runSeconds(game, 0.1);
    expect(b.convoy).toBeDefined();
    const save = JSON.parse(JSON.stringify(game.toSave()));
    // Этапы — в сохранении (у каждого свой ход).
    const c = save.roads.corridors.find((k: { build?: { project: number } }) => k.build?.project === id);
    expect(c.build.stages[0]).toBeGreaterThan(0);
    expect(c.build.stages[1]).toBe(0);
    const loaded = withoutCitizens(new Game(WORLD, save));
    const twin = crews(loaded).brigades.get(b.id)!;
    // Поток не сохраняется: машины, что ехали в нём, уже у подъезда — сошли на полосу следом за головной.
    expect(laneCars(twin.lane!)).toBe(3);
    for (let t = 0; t < 300 && loaded.construction.projects.has(id); t += 1) runSeconds(loaded, 1);
    expect(loaded.construction.projects.has(id)).toBe(false);
    for (let t = 0; t < 300 && game.construction.projects.has(id); t += 1) runSeconds(game, 1);
    expect(game.construction.projects.has(id)).toBe(false);
    expect(spent).toBe(cost);
  });

  it('старое сохранение (у участка одно done, этапов нет): этапы — колонной из него, стройка идёт дальше и стоит столько же', () => {
    const { game, id } = scene();
    const cost = game.construction.info(id)!.left;
    for (let t = 0; t < 200 && !(game.construction.info(id)!.stages[2] > 0); t += 0.5) runSeconds(game, 0.5);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const c = save.roads.corridors.find((k: { build?: { project: number } }) => k.build?.project === id);
    const done = c.build.done;
    delete c.build.stages;
    const loaded = withoutCitizens(new Game(WORLD, save));
    const k = loaded.roads.net.corridors.get(c.id)!;
    expect(spansOf(k.build, k.length)).toEqual(stageSpans(done, k.length));
    const paid0 = loaded.construction.projects.get(id)!.spent;
    let spent = 0;
    const spend = loaded.spend.bind(loaded);
    loaded.spend = (x: number, kind) => {
      if (kind !== 'purchases') spent += x;
      spend(x, kind);
    };
    runSeconds(loaded, 3);
    expect(loaded.construction.info(id)!.done).toBeGreaterThan(game.construction.info(id)!.done - 1e-9);
    for (let t = 0; t < 300 && loaded.construction.projects.has(id); t += 1) runSeconds(loaded, 1);
    expect(loaded.construction.projects.has(id)).toBe(false);
    expect(paid0 + spent).toBe(cost);
  });
});

const crews = (g: Game) => g.construction.crews;
