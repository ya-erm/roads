import { describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { dist, type Vec } from '../core/vec';
import { advise } from './advisor';
import { type Brigade, convoyOffset, type CrewHost, Crews, type Site } from './crews';
import { Game } from './game';
import { anchorOf, road, runSeconds, STREET, withoutCitizens } from './testkit';
import { projectBadges } from '../render/projectBadges';
import { projectCardHtml } from '../ui/projectCard';
import type { WorldSettings } from '../world/settings';

/**
 * Бригады без игры: проекты, узлы подъезда, края работ и пути вдоль стройки — вручную; доехать по дорогам — как скажет
 * reach, выехать машиной — как скажет drive.
 */
function bench(drive: CrewHost['drive'] = () => 42, reach: CrewHost['reach'] = () => true) {
  const sites = new Map<number, Site>();
  const paths = new Map<number, Vec[]>();
  /** Проекты, которым нужны бригады (нет в списке — на паузе). */
  const paused = new Set<number>();
  const host = {
    time: 0,
    crewProjects: () => [...sites.keys()].filter((id) => !paused.has(id)),
    site: (id: number) => sites.get(id) ?? null,
    path: (id: number) => paths.get(id) ?? null,
    reach,
    drive,
    park: () => {},
    onRoad: (node: number) => node >= 0,
  };
  const crews = new Crews(host);
  // База у дороги: ворота — узел 1.
  crews.bases.set(100, { type: 'base', id: 100, fp: { center: { x: 0, y: 0 }, w: 36, h: 24, angle: 0 }, nodeId: 1, paid: 0 });
  crews.firstUsed = true;
  const b = crews.hire(100)!;
  /** Такты по 0.1 с, пока время не дойдёт до t. */
  const until = (t: number) => {
    while (host.time < t - 1e-9) {
      host.time = Math.round((host.time + 0.1) * 10) / 10;
      crews.tick();
    }
  };
  return { host, crews, sites, paths, paused, b, until };
}

const near = (a: Vec | undefined, b: Vec) => {
  expect(a).toBeDefined();
  expect(dist(a!, b)).toBeLessThan(1e-6);
};

/** Проект 7: подъезд — узел 571 в (600, 0), край работ — в 300 м вдоль стройки к северу. */
function site7(t: ReturnType<typeof bench>) {
  const node = { x: 600, y: 0 };
  const front = { x: 600, y: -300 };
  t.sites.set(7, { node: 571, pos: front });
  t.paths.set(7, [node, { x: 600, y: -150 }, front]);
  return { node, front };
}

describe('Бригады: только по дорогам и вдоль стройки', () => {
  it('до узла подъезда по дорогам не доехать — бригада не едет и по полю не ездит', () => {
    const t = bench(() => null, () => false);
    site7(t);
    t.until(5);
    expect(t.b.state).toBe('idle');
    expect(t.b.convoy).toBeUndefined();
    expect(t.b.eta).toBeUndefined();
    expect(t.b.trip).toBeUndefined();
    expect(t.crews.working(7)).toEqual([]);
  });

  it('путь есть, но на выезде нет места — колонна ждёт и выезжает по одной машине', () => {
    let tries = 0;
    const cars: number[] = [];
    const t = bench((_b, _from, _to, car) => {
      if (++tries < 3) return 'busy';
      cars.push(car);
      return 40 + car;
    });
    site7(t);
    t.crews.tick();
    t.crews.tick();
    expect(t.b.state).toBe('going');
    expect(t.crews.lead(t.b)).toBeUndefined();
    expect(t.b.convoy?.cars).toEqual([{ wait: true }, { wait: true }, { wait: true }]);
    t.crews.tick();
    expect(t.crews.lead(t.b)).toBe(40);
    // Остальные — по одной за такт, по порядку: самосвал, грейдер, каток.
    t.crews.tick();
    t.crews.tick();
    expect(cars).toEqual([0, 1, 2]);
    expect(t.b.convoy?.cars).toEqual([{ sim: 40 }, { sim: 41 }, { sim: 42 }]);
    expect(t.b.eta).toBeUndefined();
  });

  it('доехавшие машины колонны ждут остальных там, где встали; бригада на месте — когда доехала последняя', () => {
    const t = bench((_b, _from, _to, car) => 40 + car);
    const { node } = site7(t);
    for (let i = 0; i < 3; i++) t.crews.tick();
    t.crews.arrive(t.b, { node: 571, pos: node, dir: { x: 1, y: 0 } }, 40);
    t.crews.arrive(t.b, { node: 571, pos: { x: 590, y: 0 }, dir: { x: 1, y: 0 } }, 41);
    expect(t.b.convoy).toBeDefined();
    expect(t.b.eta).toBeUndefined();
    expect(t.crews.carsAt(t.b).map((m) => m.car)).toEqual([0, 1]);
    expect(t.crews.owns(t.b, 42)).toBe(true);
    t.crews.arrive(t.b, { node: 571, pos: { x: 578, y: 0 }, dir: { x: 1, y: 0 } }, 42);
    // Все на месте — колонной вдоль стройки: головная впереди, остальные — позади на свою длину с зазором.
    expect(t.b.convoy).toBeUndefined();
    expect(t.b.trip).toBeDefined();
    t.until(5);
    const along = t.crews.carsAt(t.b);
    expect(along.map((m) => m.car)).toEqual([0, 1, 2]);
    expect(dist(along[0].pos, along[1].pos)).toBeCloseTo(convoyOffset(1), 6);
    expect(dist(along[1].pos, along[2].pos)).toBeCloseTo(convoyOffset(2) - convoyOffset(1), 6);
  });

  it('машиной до узла подъезда, оттуда — вдоль стройки к краю работ: видно, где едет; сохранение посреди пути', () => {
    const t = bench();
    const { node, front } = site7(t);
    t.crews.tick();
    expect(t.crews.lead(t.b)).toBe(42);
    // Колонна доехала до узла подъезда (Game.onArrive).
    t.crews.arrive(t.b, { node: 571, pos: node });
    expect(t.b.state).toBe('going');
    expect(t.b.at).toBe(571);
    expect(t.b.trip?.path).toEqual(t.paths.get(7));
    const eta = t.b.eta!;
    expect(eta).toBeCloseTo(300 / CONSTRUCTION.onSite, 9);
    near(t.crews.walkAt(t.b)?.pos, node);
    expect(t.crews.walkAt(t.b)?.dir).toEqual({ x: 0, y: -1 });
    t.until(eta / 2);
    near(t.crews.walkAt(t.b)?.pos, { x: 600, y: (-300 * t.host.time) / eta });
    // Сохранение и загрузка посреди пути: та же поездка и та же точка.
    const save = JSON.parse(JSON.stringify(t.crews.toSave()));
    const other = bench();
    other.host.time = t.host.time;
    site7(other);
    other.crews.load(save);
    const twin = other.crews.brigades.get(t.b.id)!;
    expect(other.crews.walkAt(twin)).toEqual(t.crews.walkAt(t.b));
    t.until(eta + 0.2);
    other.until(eta + 0.2);
    expect(t.b.state).toBe('working');
    near(t.b.pos, front);
    expect(other.crews.toSave()).toEqual(t.crews.toSave());
    expect(t.crews.walkAt(t.b)).toBeNull();
  });

  it('уже у узла подъезда, а край работ у самого узла — сразу за работу', () => {
    const t = bench();
    t.sites.set(7, { node: 1, pos: { x: 0, y: 0 } });
    t.paths.set(7, [{ x: 0, y: 0 }]);
    t.crews.tick();
    expect(t.b.state).toBe('working');
    expect(t.b.convoy).toBeUndefined();
  });

  it('проект на паузе — назад вдоль стройки к дороге, оттуда машиной домой', () => {
    let cars = 0;
    const t = bench(() => ++cars);
    const { node, front } = site7(t);
    t.crews.tick();
    t.crews.arrive(t.b, { node: 571, pos: node });
    t.until(t.b.eta! + 0.2);
    expect(t.b.state).toBe('working');
    t.paused.add(7);
    t.crews.tick();
    expect(t.b.state).toBe('back');
    expect(t.b.trip?.back).toBe(true);
    near(t.crews.walkAt(t.b)?.pos, front);
    t.until(t.host.time + 300 / CONSTRUCTION.onSite + 0.3);
    // Доехала до дороги — домой колонной от узла подъезда к воротам базы.
    expect(t.b.trip).toBeUndefined();
    expect(t.b.convoy).toMatchObject({ from: 571, to: 1 });
    expect(t.crews.lead(t.b)).toBeDefined();
    t.crews.arrive(t.b, { node: 1, pos: { x: 0, y: 0 } });
    expect(t.b.state).toBe('idle');
    expect(t.b.pos).toBeUndefined();
  });

  it('машину бригады потеряли (дорогу снесли) — бригада на базе и выезжает оттуда заново', () => {
    const t = bench();
    site7(t);
    t.crews.tick();
    expect(t.crews.lead(t.b)).toBe(42);
    t.crews.lost(t.b);
    expect(t.b.convoy).toBeUndefined();
    expect(t.b.pos).toBeUndefined();
    expect(t.b.at).toBeUndefined();
    t.crews.tick();
    expect(t.crews.lead(t.b)).toBe(42);
  });

  it('старое сохранение: ехала по полю (trip from → to) — открывается, бригада на базе и едет по дороге', () => {
    const t = bench();
    site7(t);
    t.host.time = 10;
    t.crews.load({
      bases: [...t.crews.bases.values()],
      brigades: [
        { id: 5, base: 100, state: 'going', project: 7, pos: { x: 50, y: 50 }, eta: 30, trip: { from: { x: 0, y: 0 }, to: { x: 600, y: -300 }, t0: 0 } } as unknown as Omit<Brigade, 'convoy'>,
        { id: 6, base: 100, state: 'back', pos: { x: 70, y: 70 }, eta: 20 } as Omit<Brigade, 'convoy'>,
      ],
      nextBrigade: 7,
      firstUsed: true,
    });
    const a = t.crews.brigades.get(5)!;
    const b = t.crews.brigades.get(6)!;
    expect(a).toEqual({ id: 5, base: 100, state: 'going', project: 7 });
    expect(b).toEqual({ id: 6, base: 100, state: 'idle' });
    expect(t.crews.walkAt(a)).toBeNull();
    t.crews.tick();
    expect(t.crews.lead(a)).toBe(42);
  });
});

describe('Бригады в игре: нет подъезда', () => {
  const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

  /** Первая база — у улиц самого большого города. */
  function townBase(game: Game): void {
    const town = [...game.towns].sort((a, b) => b.population - a.population || a.id - b.id)[0];
    for (const k of [1, 0.75, 1.3, 0.5, 1.7]) {
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const p = { x: town.center.x + Math.cos(a) * town.radius * k, y: town.center.y + Math.sin(a) * town.radius * k };
        const plan = game.basePlan(p);
        if (plan.ok && !plan.demolish.length && game.buildBase(p) === null) return;
      }
    }
    throw new Error('нет места для базы');
  }

  /** Узел дороги в точке p (в пределах метра). */
  const nodeAt = (game: Game, p: Vec) => [...game.roads.net.nodes.values()].find((n) => dist(n.pos, p) < 1)?.id ?? null;

  /** Проект улицей от a до b (как рисует игрок). */
  const project = (game: Game, a: number | Vec, b: number | Vec) => {
    const end = (x: number | Vec) => anchorOf(game, typeof x === 'number' ? x : { free: x });
    const plan = game.roadBuilder.road(end(a), end(b), STREET, { project: true });
    return plan.ok && game.roadBuilder.apply(plan);
  };

  /** Место в поле, далеко от городов: ровная полоса в len метров вдоль x. */
  function field(game: Game, len: number): Vec {
    for (let y = 400; y < game.terrain.height - 400; y += 120) {
      for (let x = 300; x < game.terrain.width - len - 300; x += 160) {
        if (game.towns.some((t) => dist({ x: x + len / 2, y }, t.center) < t.radius + len)) continue;
        // Вдали от дорог (и стартовых просёлков): новая дорога ни с чем не пересекается.
        if (game.roads.net.corridorsInBox(x - 80, y - 200, x + len + 80, y + 200).length) continue;
        const plan = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + len, y } }), STREET);
        if (plan.ok && !plan.demolish.length) return { x, y };
      }
    }
    throw new Error('нет места');
  }

  it('проект от отдельной дороги в поле: бригада не едет; видно «нет подъезда» — плашка, карточка, советник; база рядом — строит', () => {
    const game = withoutCitizens(new Game(WORLD));
    townBase(game);
    const crews = game.construction.crews;
    const b = [...crews.brigades.values()][0];
    const at = field(game, 900);
    // Отдельная готовая дорога (с городом её ничто не связывает) и проект от её конца в поле.
    expect(road(game, { free: at }, { free: { x: at.x + 300, y: at.y } })).toBe(true);
    const end = nodeAt(game, { x: at.x + 300, y: at.y })!;
    const id = game.construction.peekId();
    expect(project(game, end, { x: at.x + 900, y: at.y })).toBe(true);
    runSeconds(game, 10);
    expect(b.state).toBe('idle');
    expect(b.eta).toBeUndefined();
    expect(game.siteCrewLooks()).toEqual([]);
    const info = game.construction.info(id)!;
    expect(info.access).toBe(false);
    expect(info.done).toBe(0);
    expect(game.construction.site(id)).toBeNull();
    // Почему стоит — на плашке, в карточке и у советника.
    expect(projectBadges(game, 1).find((x) => x.id === id)?.text).toContain('нет подъезда');
    const card = projectCardHtml(game, id);
    expect(card).toContain('Нет подъезда');
    expect(card).toContain('data-action="base-place"');
    const tip = advise(game).find((a) => a.kind === 'buildNoAccess');
    expect(tip?.title).toBe('Нет подъезда к стройке');
    expect(tip?.fix).toEqual({ kind: 'base' });
    // База у этой дороги: её ворота — узел той же дороги, бригада доезжает и строит.
    expect(game.buildBase({ x: at.x + 150, y: at.y - 40 })).toBeNull();
    expect(game.construction.info(id)!.access).toBe(true);
    for (let t = 0; t < 60 && !game.construction.info(id)!.done; t += 0.5) runSeconds(game, 0.5);
    expect(game.construction.info(id)!.done).toBeGreaterThan(0);
    expect(advise(game).some((a) => a.kind === 'buildNoAccess')).toBe(false);
  });

  it('проект от тупика готовой дороги в поле к отдельной дороге: работы — от тупика, бригада к дальнему концу не едет', () => {
    const game = withoutCitizens(new Game(WORLD));
    const at = field(game, 1500);
    // Своя дорога с базой (её тупик — в at.x + 300) и отдельная дорога дальше по полю, к которой подъезда нет.
    expect(road(game, { free: at }, { free: { x: at.x + 300, y: at.y } })).toBe(true);
    expect(road(game, { free: { x: at.x + 1200, y: at.y } }, { free: { x: at.x + 1500, y: at.y } })).toBe(true);
    expect(game.buildBase({ x: at.x + 120, y: at.y - 40 })).toBeNull();
    const deadEnd = nodeAt(game, { x: at.x + 300, y: at.y })!;
    const far = nodeAt(game, { x: at.x + 1200, y: at.y })!;
    const base = [...game.construction.crews.bases.values()][0];
    expect(game.reach(base.nodeId, deadEnd)).toBe(true);
    expect(game.reach(base.nodeId, far)).toBe(false);
    // Проект рисуют от дальнего конца к тупику: прежде стройка начиналась у дальнего (он тоже у готовой дороги).
    const id = game.construction.peekId();
    expect(project(game, far, deadEnd)).toBe(true);
    expect(game.construction.corridorsOf(id).length).toBeGreaterThan(0);
    const site = game.construction.site(id)!;
    expect(site.node).toBe(deadEnd);
    const crews = game.construction.crews;
    const b = [...crews.brigades.values()][0];
    const farPos = game.roads.net.node(far).pos;
    const deadPos = game.roads.net.node(deadEnd).pos;
    let closest = Infinity;
    for (let t = 0; t < 40; t += 0.2) {
      runSeconds(game, 0.2);
      const where = game.brigadeWhere(b.id)!.pos;
      closest = Math.min(closest, dist(where, farPos));
    }
    expect(b.state).toBe('working');
    const info = game.construction.info(id)!;
    expect(info.done).toBeGreaterThan(0);
    // Край работ — от тупика к дальнему концу; бригада к дальнему концу не ездила.
    expect(dist(info.front!, deadPos)).toBeLessThan(dist(info.front!, farPos));
    expect(closest).toBeGreaterThan(dist(farPos, deadPos) - dist(info.front!, deadPos) - 50);
  });

  it('сохранение, пока вторая бригада едет по стройке к ушедшему вперёд краю: после загрузки — там же, и дальше всё одинаково', () => {
    const game = withoutCitizens(new Game(WORLD));
    const at = field(game, 900);
    expect(road(game, { free: at }, { free: { x: at.x + 300, y: at.y } })).toBe(true);
    expect(game.buildBase({ x: at.x + 120, y: at.y - 40 })).toBeNull();
    const deadEnd = nodeAt(game, { x: at.x + 300, y: at.y })!;
    expect(project(game, deadEnd, { x: at.x + 900, y: at.y })).toBe(true);
    const crews = game.construction.crews;
    const [first] = [...crews.brigades.values()];
    // Работает первая — вторая (нанятая позже) поедет от узла по своей полосе вдоль стройки к ушедшему вперёд краю.
    for (let t = 0; t < 60 && first.state !== 'working'; t += 0.1) runSeconds(game, 0.1);
    runSeconds(game, 20);
    expect(game.hireBrigade(first.base)).toBeNull();
    const second = [...crews.brigades.values()][1];
    // Вся колонна сошла на стройку (поток не сохраняется), а машины ещё едут к своим местам.
    for (let t = 0; t < 60 && (!second.lane || second.convoy); t += 0.1) runSeconds(game, 0.1);
    expect(second.lane).toBeDefined();
    expect(second.convoy).toBeUndefined();
    runSeconds(game, 0.3);
    expect(crews.placed(second)).toEqual([false, false, false]);
    const loaded = withoutCitizens(new Game(WORLD, JSON.parse(JSON.stringify(game.toSave()))));
    const twin = loaded.construction.crews.brigades.get(second.id)!;
    expect(loaded.construction.crews.carsAt(twin)).toEqual(crews.carsAt(second));
    expect(loaded.siteCrewLooks().map((v) => v.pos)).toEqual(game.siteCrewLooks().map((v) => v.pos));
    expect(game.brigadeWhere(second.id)!.text).toContain('строит');
    // По стройке едет вся колонна — три машины (и три машины первой бригады работают у края, той же техникой);
    // клик по любой — карточка её базы.
    const looks = game.siteCrewLooks();
    expect(looks.map((v) => v.body)).toEqual(['crewEarth', 'crewPave', 'crewMarks', 'crewEarth', 'crewPave', 'crewMarks']);
    for (const v of looks) expect(game.crewBaseAt({ x: v.pos.x - v.dir.x * 2, y: v.pos.y - v.dir.y * 2 })).toBe(second.base);
    for (const g of [game, loaded]) runSeconds(g, 30);
    expect(loaded.construction.crews.toSave()).toEqual(game.construction.crews.toSave());
    expect(loaded.money).toBe(game.money);
    expect(JSON.stringify(loaded.roads.net.toJSON())).toBe(JSON.stringify(game.roads.net.toJSON()));
  });
});
