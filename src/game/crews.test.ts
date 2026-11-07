import { describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { dist, type Vec } from '../core/vec';
import type { WorldSettings } from '../world/settings';
import { type Brigade, type CrewHost, Crews, type Site } from './crews';
import { Game } from './game';
import { anchorOf, road, runSeconds, STREET, withoutCitizens } from './testkit';

/** Бригады без игры: проекты и края работ — вручную, дорога — как скажет drive. */
function bench(drive: CrewHost['drive'] = () => null) {
  const sites = new Map<number, Site>();
  const host = {
    time: 0,
    crewProjects: () => [...sites.keys()],
    site: (id: number) => sites.get(id) ?? null,
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
  return { host, crews, sites, b, until };
}

const near = (a: Vec | undefined, b: Vec) => {
  expect(a).toBeDefined();
  expect(dist(a!, b)).toBeLessThan(1e-6);
};

describe('Бригады: сеть разорвана', () => {
  it('оба конца у дорог, но пути между ними нет — бригада не ждёт вечно, а едет своим ходом и строит', () => {
    // Как в партии из баг-репорта: ворота базы и край работ — узлы дорог, но в разных кусках сети (их соединит проект).
    const { host, crews, sites, b, until } = bench(() => null);
    const site = { x: 600, y: 0 };
    sites.set(7, { node: 571, pos: site });
    crews.tick();
    expect(b.state).toBe('going');
    expect(b.sim).toBeUndefined();
    expect(b.eta).toBeCloseTo(600 / CONSTRUCTION.offroad, 9);
    expect(b.trip).toEqual({ from: { x: 0, y: 0 }, to: site, t0: 0 });
    until(b.eta! + 0.1);
    expect(b.state).toBe('working');
    expect(crews.working(7)).toEqual([b]);
    expect(host.time).toBeGreaterThan(0);
  });

  it('путь есть, но на выезде нет места — ждёт и выезжает машиной, своим ходом не едет', () => {
    let tries = 0;
    const { crews, sites, b } = bench(() => (++tries < 3 ? 'busy' : 42));
    sites.set(7, { node: 571, pos: { x: 600, y: 0 } });
    crews.tick();
    crews.tick();
    expect(b.sim).toBeUndefined();
    expect(b.eta).toBeUndefined();
    crews.tick();
    expect(b.sim).toBe(42);
    expect(b.eta).toBeUndefined();
  });

  it('домой — так же: пути до ворот нет — своим ходом, место занято — ждёт', () => {
    const { crews, sites, b, until } = bench(() => null);
    sites.set(7, { node: 571, pos: { x: 300, y: 400 } });
    crews.tick();
    until(b.eta! + 0.1);
    expect(b.state).toBe('working');
    sites.delete(7);
    crews.tick();
    expect(b.state).toBe('back');
    expect(b.eta).toBeDefined();
    expect(b.trip?.to).toEqual({ x: 0, y: 0 });
    until(b.eta! + 0.1);
    expect(b.state).toBe('idle');
  });
});

describe('Бригады: своим ходом видно, где едет', () => {
  it('по прямой от места выезда к стройке, по времени выезда и eta; после загрузки — там же', () => {
    const { host, crews, sites, b, until } = bench();
    const site = { x: 900, y: 1200 };
    sites.set(7, { node: null, pos: site });
    crews.tick();
    const eta = b.eta!;
    expect(eta).toBeCloseTo(1500 / CONSTRUCTION.offroad, 9);
    near(crews.offroadAt(b)?.pos, { x: 0, y: 0 });
    expect(crews.offroadAt(b)?.dir.x).toBeCloseTo(0.6, 9);
    expect(crews.offroadAt(b)?.dir.y).toBeCloseTo(0.8, 9);
    until(eta / 2);
    const k = host.time / eta;
    near(crews.offroadAt(b)?.pos, { x: 900 * k, y: 1200 * k });
    // Сохранение и загрузка посреди пути: та же поездка и та же точка.
    const save = JSON.parse(JSON.stringify(crews.toSave()));
    expect(save.brigades[0].trip).toEqual({ from: { x: 0, y: 0 }, to: site, t0: 0 });
    const other = bench();
    other.host.time = host.time;
    other.sites.set(7, { node: null, pos: site });
    other.crews.load(save);
    const twin = other.crews.brigades.get(b.id)!;
    expect(other.crews.offroadAt(twin)).toEqual(crews.offroadAt(b));
    // И дальше — одинаково: доезжают в один такт.
    until(eta + 0.2);
    other.until(eta + 0.2);
    expect(b.state).toBe('working');
    expect(other.crews.toSave()).toEqual(crews.toSave());
    expect(crews.offroadAt(b)).toBeNull();
  });

  it('старое сохранение (eta без trip): тоже видно — от места, где стояла, к стройке', () => {
    const { host, crews, sites } = bench();
    const site = { x: 0, y: 1500 };
    sites.set(7, { node: null, pos: site });
    const eta = 1500 / CONSTRUCTION.offroad;
    host.time = eta / 4;
    crews.load({
      bases: [...crews.bases.values()],
      brigades: [{ id: 5, base: 100, state: 'going', project: 7, eta } as Omit<Brigade, 'sim'>],
      nextBrigade: 6,
      firstUsed: true,
    });
    const b = crews.brigades.get(5)!;
    near(crews.offroadAt(b)?.pos, { x: 0, y: 375 });
  });

  it('проект отменили посреди пути — бригада стоит там, куда доехала, и едет домой оттуда', () => {
    const { host, crews, sites, b, until } = bench();
    sites.set(7, { node: null, pos: { x: 1000, y: 0 } });
    crews.tick();
    until(b.eta! / 2);
    const mid = crews.offroadAt(b)!.pos;
    sites.delete(7);
    crews.tick();
    expect(b.state).toBe('back');
    // Домой — от середины пути, а не прыжком с места выезда.
    expect(dist(b.trip!.from, mid)).toBeLessThan(CONSTRUCTION.offroad * 0.1 + 1e-6);
    expect(b.trip!.to).toEqual({ x: 0, y: 0 });
    expect(b.trip!.t0).toBe(host.time);
  });

  it('машину бригады потеряли (дорогу снесли) — дальше своим ходом от того места, где была машина', () => {
    const { crews, sites, b } = bench(() => 42);
    sites.set(7, { node: 571, pos: { x: 1000, y: 0 } });
    crews.tick();
    expect(b.sim).toBe(42);
    crews.lost(b, { x: 400, y: 30 });
    expect(b.sim).toBeUndefined();
    expect(b.trip?.from).toEqual({ x: 400, y: 30 });
    near(crews.offroadAt(b)?.pos, { x: 400, y: 30 });
  });
});

describe('Бригады в игре: сеть разорвана', () => {
  const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

  /** Партия: база у улиц города, а проект начинается с отдельной дороги в поле, которую с городом ничто не связывает. */
  function setup(): { game: Game; project: number } {
    const game = withoutCitizens(new Game(WORLD));
    const town = [...game.towns].sort((a, b) => b.population - a.population || a.id - b.id)[0];
    let placed = false;
    for (const k of [1, 0.75, 1.3, 0.5, 1.7]) {
      for (let i = 0; i < 24 && !placed; i++) {
        const a = (i / 24) * Math.PI * 2;
        const p = { x: town.center.x + Math.cos(a) * town.radius * k, y: town.center.y + Math.sin(a) * town.radius * k };
        const plan = game.basePlan(p);
        placed = plan.ok && !plan.demolish.length && game.buildBase(p) === null;
      }
    }
    expect(placed).toBe(true);
    const base = [...game.construction.crews.bases.values()][0];
    // Отдельная готовая дорога в поле подальше от города и проект от её конца.
    for (let y = 400; y < game.terrain.height - 400; y += 120) {
      for (let x = 300; x < game.terrain.width - 1200; x += 160) {
        if (dist({ x, y }, town.center) < town.radius + 900) continue;
        const before = new Set(game.roads.net.nodes.keys());
        if (!road(game, { free: { x, y } }, { free: { x: x + 300, y } }, STREET)) continue;
        // Стройка заменяет сеть копией — узлы ищем в новой.
        const end = [...game.roads.net.nodes.values()].filter((n) => !before.has(n.id)).sort((p, q) => q.pos.x - p.pos.x)[0];
        if (!end || !game.onRoad(end.id) || game.roads.route(base.nodeId, end.id)) continue;
        const id = game.construction.peekId();
        const plan = game.roadBuilder.road(anchorOf(game, end.id), anchorOf(game, { free: { x: x + 900, y } }), STREET, { project: true });
        if (plan.ok && game.roadBuilder.apply(plan)) return { game, project: id };
      }
    }
    throw new Error('нет места');
  }

  it('ворота базы и край работ — у дорог, пути нет: бригада едет своим ходом, её видно в пути, проект строится', () => {
    const { game, project } = setup();
    const crews = game.construction.crews;
    const b = [...crews.brigades.values()][0];
    runSeconds(game, 0.2);
    expect(b.state).toBe('going');
    expect(b.project).toBe(project);
    expect(b.eta).toBeDefined();
    // В пути: самосвал на карте и «показать на карте» — там же, между базой и стройкой.
    runSeconds(game, Math.min(5, (b.eta! - game.time) / 2));
    const at = crews.offroadAt(b)!.pos;
    expect(game.offroadCrewLooks().map((v) => v.pos)).toEqual([at]);
    expect(game.brigadeWhere(b.id)).toEqual({ pos: at, text: `едет строить «${game.construction.info(project)!.project.label}» по бездорожью` });
    const base = crews.bases.get(b.base)!;
    const site = game.construction.site(project)!.pos;
    expect(dist(at, base.fp.center)).toBeGreaterThan(1);
    expect(dist(at, site)).toBeLessThan(dist(base.fp.center, site));
    runSeconds(game, b.eta! - game.time + 1);
    expect(b.state).toBe('working');
    runSeconds(game, 5);
    expect(game.construction.info(project)!.done).toBeGreaterThan(0);
  });

  it('сохранение посреди поездки своим ходом: после загрузки — там же, и дальше всё одинаково', () => {
    const { game } = setup();
    runSeconds(game, 3);
    const b = [...game.construction.crews.brigades.values()][0];
    expect(b.trip).toBeDefined();
    const loaded = withoutCitizens(new Game(WORLD, JSON.parse(JSON.stringify(game.toSave()))));
    const twin = loaded.construction.crews.brigades.get(b.id)!;
    expect(loaded.construction.crews.offroadAt(twin)).toEqual(game.construction.crews.offroadAt(b));
    for (const g of [game, loaded]) runSeconds(g, 60);
    expect(loaded.construction.crews.toSave()).toEqual(game.construction.crews.toSave());
    expect(loaded.money).toBe(game.money);
    expect(JSON.stringify(loaded.roads.net.toJSON())).toBe(JSON.stringify(game.roads.net.toJSON()));
  });
});
