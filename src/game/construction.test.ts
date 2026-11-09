import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION, ECONOMY } from '../config';
import type { Vec } from '../core/vec';
import { splitBuild } from '../lanes/edit';
import type { BuildBase } from '../world/entities';
import type { WorldSettings } from '../world/settings';
import { projectName } from './construction';
import { convoyGap, frontOf, spansOf, stageSpans } from './constructionWork';
import { Game } from './game';
import { anchorOf, type End, road, runSeconds, STREET, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' };

/** «Со строительством», баз нет — первую игрок ставит сам. */
function bareGame(extra: Partial<WorldSettings> = {}): Game {
  return withoutCitizens(new Game({ ...WORLD, construction: 'build', ...extra }));
}

/**
 * Первая база — как поставил бы игрок: у улиц самого большого города, первое место по кругу, где площадка встаёт
 * без сноса домов.
 */
function firstBase(game: Game): BuildBase {
  const town = [...game.towns].sort((a, b) => b.population - a.population || a.id - b.id)[0];
  for (const k of [1, 0.75, 1.3, 0.5, 1.7]) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const p = { x: town.center.x + Math.cos(a) * town.radius * k, y: town.center.y + Math.sin(a) * town.radius * k };
      const plan = game.basePlan(p);
      if (plan.ok && !plan.demolish.length && game.buildBase(p) === null) return [...game.construction.crews.bases.values()][0];
    }
  }
  throw new Error('нет места для базы');
}

/** «Со строительством» и первая база у самого большого города. */
function buildGame(extra: Partial<WorldSettings> = {}): Game {
  const game = bareGame(extra);
  firstBase(game);
  return game;
}

/** Узел дороги в точке p (в пределах метра), если есть. */
function nodeAt(game: Game, p: Vec): number | null {
  return [...game.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - p.x, n.pos.y - p.y) < 1)?.id ?? null;
}

/**
 * Дорога проектом — как рисует игрок (план с project). Свободная точка, где уже кончается дорога (подъезд gateAt), —
 * этот узел: проект начинается от тупика подъезда.
 */
function project(game: Game, a: End, b: End): boolean {
  const snap = (x: End): End => (typeof x === 'object' && 'free' in x ? (nodeAt(game, x.free) ?? x) : x);
  const plan = game.roadBuilder.road(anchorOf(game, snap(a)), anchorOf(game, snap(b)), STREET, { project: true });
  return plan.ok && game.roadBuilder.apply(plan);
}

/**
 * Подъезд к точке p: короткая готовая улица, что кончается тупиком в p (с запада — тогда проект на восток от p идёт её
 * продолжением, — иначе с юга или севера). Ответ — узел на другом её конце (ворота базы).
 */
function gateAt(game: Game, p: Vec): number {
  for (const d of [
    { x: -90, y: 0 },
    { x: 0, y: 90 },
    { x: 0, y: -90 },
  ]) {
    const from = { x: p.x + d.x, y: p.y + d.y };
    if (!road(game, { free: from }, { free: p })) continue;
    const gate = nodeAt(game, from);
    if (gate !== null && nodeAt(game, p) !== null) return gate;
  }
  throw new Error('нет места для подъезда');
}

/** Свободное место для прямой дороги длиной len вдоль x: первое, где она строится. */
function freeSpot(game: Game, len: number): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 160) {
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + len, y } }), STREET);
      if (plan.ok && !plan.demolish.length) return { x, y };
    }
  }
  throw new Error('нет места');
}

/**
 * Своя база в точке pos — и бригады только её (бригаду первой, бесплатной базы распускаем). По полю бригады не ездят:
 * ворота базы — узел gate или конец подъезда (gateAt) к точке gate (по умолчанию — к pos): проект, нарисованный от
 * этой точки, начинается от тупика подъезда, и бригада доезжает до него по дороге.
 */
function crewAt(game: Game, pos: Vec, n = 1, gate: number | Vec = pos): BuildBase {
  const crews = game.construction.crews;
  crews.brigades.clear();
  const nodeId = typeof gate === 'number' ? gate : gateAt(game, gate);
  const base: BuildBase = { type: 'base', id: 990_000 + crews.bases.size, fp: { center: { ...pos }, w: 36, h: 24, angle: 0 }, nodeId };
  crews.bases.set(base.id, base);
  for (let i = 0; i < n; i++) crews.hire(base.id);
  return base;
}

/**
 * Игра вперёд, пока на каком-нибудь проекте не заработает бригада всеми машинами — каждая на своём месте (машины
 * сходят на стройку по одной, Crews.placed; не дольше limit секунд).
 */
function untilWorking(game: Game, limit = 120): number {
  let t = 0;
  const crews = game.construction.crews;
  while (t < limit && ![...crews.brigades.values()].some((b) => crews.placed(b).every(Boolean))) {
    runSeconds(game, 0.1);
    t += 0.1;
  }
  return t;
}

const building = (game: Game) => [...game.roads.net.corridors.values()].filter((c) => c.build);
const linksOf = (game: Game, id: number) => game.roads.graph.corridorLinks(id).length;

describe('Стройка дорог: части', () => {
  it('разрез строящегося полотна делит готовое по месту разреза (от a и от b)', () => {
    expect(splitBuild({ project: 1, done: 30 }, 100, 40)).toEqual([
      { project: 1, done: 30 },
      { project: 1, done: 0 },
    ]);
    expect(splitBuild({ project: 1, done: 70 }, 100, 40)).toEqual([
      { project: 1, done: 40 },
      { project: 1, done: 30 },
    ]);
    // От конца b: сначала готов второй кусок, потом первый — от места разреза.
    expect(splitBuild({ project: 2, done: 70, fromB: true }, 100, 40)).toEqual([
      { project: 2, done: 10, fromB: true },
      { project: 2, done: 60, fromB: true },
    ]);
  });

  it('этапы участка: земляные работы, покрытие, разметка — колонной, работа — по долям этапов', () => {
    const w = CONSTRUCTION.stages;
    const L = 100;
    const gap = convoyGap(L);
    expect(gap).toBe(25);
    expect(convoyGap(1000)).toBe(CONSTRUCTION.convoyGap);
    expect(stageSpans(0, L)).toEqual([0, 0, 0]);
    expect(stageSpans(L, L)).toEqual([L, L, L]);
    let prev = [0, 0, 0];
    let together = false;
    for (let i = 0; i <= 1000; i++) {
      const done = (L * i) / 1000;
      const [e, p, m] = stageSpans(done, L);
      // Работа — сумма долей этапов по пройденному ими, каждый этап только вперёд.
      expect(w[0] * e + w[1] * p + w[2] * m).toBeCloseTo(done, 6);
      expect(e).toBeGreaterThanOrEqual(prev[0] - 1e-9);
      expect(p).toBeGreaterThanOrEqual(prev[1] - 1e-9);
      expect(m).toBeGreaterThanOrEqual(prev[2] - 1e-9);
      prev = [e, p, m];
      // Колонна: покрытие — на gap за отсыпкой, разметка — на gap за покрытием (пока впереди есть кого догонять).
      if (e < L) expect(p).toBeCloseTo(Math.max(0, e - gap), 6);
      if (p < L) expect(m).toBeCloseTo(Math.max(0, p - gap), 6);
      if ([e, p, m].every((s) => s > 0 && s < L)) together = true;
    }
    // Все три этапа идут одновременно — техника видна колонной.
    expect(together).toBe(true);
    // Край работ — голова колонны: отсыпка, пока не дошла до конца, потом покрытие, потом разметка.
    expect(frontOf(10, L)).toEqual({ s: stageSpans(10, L)[0], stage: 0 });
    expect(frontOf(90, L).stage).toBe(1);
    expect(frontOf(99.9, L).stage).toBe(2);
  });
});

describe('Стройка дорог: режим «Мгновенно»', () => {
  it('дорога строится сразу, проектов и баз нет', () => {
    const game = withoutCitizens(new Game(WORLD));
    const at = freeSpot(game, 600);
    const money = game.money;
    expect(project(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
    expect(building(game)).toEqual([]);
    expect(game.construction.projects.size).toBe(0);
    expect(game.construction.crews.bases.size).toBe(0);
    expect(game.money).toBeLessThan(money);
    expect(game.toSave().construction).toBeUndefined();
  });
});

describe('Стройка дорог: «Со строительством»', () => {
  // Темп без поправки на расстояние до базы: ровно CONSTRUCTION.speed (её проверяет отдельный тест).
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });

  it('дорога — проект: денег сразу не берут, по ней не ездят, каждый этап идёт 1 км за 90 с, платится по метрам', () => {
    const km = 1000 / CONSTRUCTION.speed;
    expect(km).toBeCloseTo(90, 6);
    const game = buildGame();
    const at = freeSpot(game, 1000);
    crewAt(game, at);
    const money = game.money;
    // Плата за стройку — отдельно от содержания бригады (оно идёт каждый месяц, а стройка теперь дольше месяца).
    let paid = 0;
    const spend = game.spend.bind(game);
    game.spend = (amount, kind) => {
      if (kind !== 'purchases') paid += amount;
      spend(amount, kind);
    };
    expect(project(game, { free: at }, { free: { x: at.x + 1000, y: at.y } })).toBe(true);
    expect(game.money).toBe(money);
    const cs = building(game);
    expect(cs.length).toBe(1);
    const c = cs[0];
    const full = Math.round(1000 * 7 * 2);
    expect(game.construction.projects.size).toBe(1);
    expect(linksOf(game, c.id)).toBe(0);
    const info0 = game.construction.list()[0];
    expect(info0.done).toBe(0);
    // Участок готов, когда разметка дошла до конца: она идёт тем же темпом, что отсыпка, но на два интервала колонны
    // позади.
    const total = (c.length + 2 * convoyGap(c.length)) / CONSTRUCTION.speed;
    expect(info0.seconds).toBeCloseTo(total, 0);
    untilWorking(game);
    // Половина времени — половина работы и половина денег.
    runSeconds(game, km / 2);
    const half = game.construction.list()[0];
    expect(half.done).toBeGreaterThan(0.45);
    expect(half.done).toBeLessThan(0.55);
    expect(paid).toBeGreaterThan(full * 0.45);
    expect(paid).toBeLessThan(full * 0.55);
    expect(linksOf(game, c.id)).toBe(0);
    // К концу разметки (длина чуть больше 1000 — с запасом) дорога готова и открыта.
    runSeconds(game, total - km / 2 + 3);
    expect(building(game)).toEqual([]);
    expect(game.construction.projects.size).toBe(0);
    expect(linksOf(game, c.id)).toBeGreaterThan(0);
    expect(paid).toBeGreaterThan(full * 0.98);
    expect(paid).toBeLessThan(full * 1.03);
  });

  it('без бригады стройка не идёт: проект ждёт, советник говорит «Проект давно не запущен»', async () => {
    const { advise } = await import('./advisor');
    const game = buildGame();
    const at = freeSpot(game, 600);
    // База с подъездом к проекту, но без бригад.
    crewAt(game, at, 0);
    expect(project(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
    runSeconds(game, CONSTRUCTION.idleWarn + 2);
    expect(game.construction.list()[0].done).toBe(0);
    const tip = advise(game).find((a) => a.kind === 'buildIdle');
    expect(tip?.title).toBe('Проект давно не запущен');
    expect(tip?.detail).toContain('нет бригад');
  });

  it('участки открываются по одному: готовый — сразу для движения', () => {
    const game = buildGame();
    const at = freeSpot(game, 1200);
    // Готовая поперечная улица посередине: проект режется перекрёстком на два участка.
    expect(road(game, { free: { x: at.x + 400, y: at.y - 200 } }, { free: { x: at.x + 400, y: at.y + 200 } })).toBe(true);
    // Ворота базы — южный конец поперечной улицы: по ней бригада доезжает до перекрёстка с проектом.
    crewAt(game, { x: at.x + 400, y: at.y + 40 }, 1, nodeAt(game, { x: at.x + 400, y: at.y + 200 })!);
    expect(project(game, { free: at }, { free: { x: at.x + 1200, y: at.y } })).toBe(true);
    const cs = building(game);
    expect(cs.length).toBe(2);
    untilWorking(game);
    // Сначала — участок, примыкающий к готовой улице.
    runSeconds(game, 3);
    const started = building(game).find((c) => c.build!.done > 0)!;
    expect(started).toBeDefined();
    const first = started.id;
    runSeconds(game, 500 / CONSTRUCTION.speed);
    expect(game.roads.net.corridors.get(first)?.build).toBeUndefined();
    expect(linksOf(game, first)).toBeGreaterThan(0);
    expect(building(game).length).toBe(1);
  });

  it('нет денег — стройка стоит и есть совет; деньги появились — идёт дальше', async () => {
    const { advise } = await import('./advisor');
    const game = buildGame();
    const at = freeSpot(game, 600);
    crewAt(game, at);
    expect(project(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
    untilWorking(game);
    game.money = ECONOMY.creditLimit;
    const before = game.construction.list()[0].done;
    runSeconds(game, 3);
    const info = game.construction.list()[0];
    expect(info.done - before).toBeLessThan(0.002);
    expect(info.project.stalled).toBeDefined();
    expect(advise(game).some((a) => a.kind === 'buildMoney' && a.title === 'Стройка стоит: не хватает денег')).toBe(true);
    game.money = 1_000_000;
    runSeconds(game, 3);
    expect(game.construction.list()[0].done - before).toBeGreaterThan(0.03);
    expect(game.construction.list()[0].project.stalled).toBeUndefined();
  });

  it('пауза держит проект на месте; отмена сносит недостроенное и возвращает за него деньги', () => {
    const game = buildGame();
    const at = freeSpot(game, 600);
    crewAt(game, at);
    expect(project(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
    const id = game.construction.list()[0].project.id;
    untilWorking(game);
    runSeconds(game, 5);
    game.pauseProject(id, true);
    const done = game.construction.list()[0].done;
    runSeconds(game, 5);
    expect(game.construction.list()[0].done).toBe(done);
    // На паузе бригада свободна — едет домой.
    expect(game.construction.crews.working(id).length).toBe(0);
    const money = game.money;
    const corridors = game.roads.net.corridors.size;
    expect(game.cancelProject(id)).toBe(true);
    expect(game.construction.projects.size).toBe(0);
    expect(game.roads.net.corridors.size).toBe(corridors - 1);
    // Заплаченное за недостроенный участок — назад целиком.
    expect(game.money).toBeGreaterThan(money);
    expect(game.money).toBeLessThan(5_000_000 + 1);
    // Ctrl+Z возвращает отменённый проект — с готовым, как было, и деньги снова за него.
    expect(game.undo()).toBe('отмена стройки');
    expect(game.construction.projects.size).toBe(1);
    expect(game.money).toBe(money);
    expect(game.construction.list()[0].done).toBeCloseTo(done, 6);
  });

  it('Ctrl+Z: не начатый проект отменяется целиком, начатый — как «Отмена» (готовое остаётся)', () => {
    const game = buildGame();
    const at = freeSpot(game, 1200);
    expect(road(game, { free: { x: at.x + 400, y: at.y - 200 } }, { free: { x: at.x + 400, y: at.y + 200 } })).toBe(true);
    // Ворота базы — южный конец поперечной улицы: по ней бригада доезжает до перекрёстка с проектом.
    crewAt(game, { x: at.x + 400, y: at.y + 40 }, 1, nodeAt(game, { x: at.x + 400, y: at.y + 200 })!);
    const corridors = game.roads.net.corridors.size;
    game.checkpoint('дорога');
    expect(project(game, { free: at }, { free: { x: at.x + 1200, y: at.y } })).toBe(true);
    game.commit();
    expect(game.undo()).toBe('дорога');
    expect(game.construction.projects.size).toBe(0);
    expect(game.roads.net.corridors.size).toBe(corridors);

    game.checkpoint('дорога');
    expect(project(game, { free: at }, { free: { x: at.x + 1200, y: at.y } })).toBe(true);
    game.commit();
    untilWorking(game);
    runSeconds(game, 16);
    const opened = [...game.roads.net.corridors.values()].filter((c) => !c.build).length;
    expect(game.undo()).toBe('дорога');
    expect(game.construction.projects.size).toBe(0);
    expect(building(game)).toEqual([]);
    // Готовый участок остался дорогой.
    expect([...game.roads.net.corridors.values()].length).toBe(opened);
    expect(opened).toBeGreaterThan(corridors);
  });

  it('сохранение посреди стройки: та же стройка, базы и бригады после загрузки, и дальше всё одинаково', () => {
    const game = buildGame();
    const at = freeSpot(game, 900);
    crewAt(game, at);
    expect(project(game, { free: at }, { free: { x: at.x + 900, y: at.y } })).toBe(true);
    untilWorking(game);
    runSeconds(game, 7);
    const id = game.construction.list()[0].project.id;
    game.pauseProject(id, true);
    runSeconds(game, 0.5);
    game.pauseProject(id, false);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    expect(save.construction.projects.length).toBe(1);
    expect(save.construction.crews.bases.length).toBe(2);
    const loaded = withoutCitizens(new Game(save.settings, save));
    const a = game.construction.list()[0];
    const b = loaded.construction.list()[0];
    expect(b.done).toBeCloseTo(a.done, 9);
    expect(b.project).toEqual(a.project);
    expect(loaded.construction.nextId).toBe(game.construction.nextId);
    expect(loaded.construction.crews.toSave()).toEqual(game.construction.crews.toSave());
    // База — препятствие и после загрузки: на её место дорогу не построить.
    const base = [...loaded.construction.crews.bases.values()][0];
    expect(loaded.structureAt(base.fp.center)?.type).toBe('base');
    for (const g of [game, loaded]) runSeconds(g, 900 / CONSTRUCTION.speed + 10);
    expect(loaded.money).toBe(game.money);
    expect(building(loaded)).toEqual([]);
    expect(JSON.stringify(loaded.roads.net.toJSON())).toBe(JSON.stringify(game.roads.net.toJSON()));
  });

  it('одни и те же действия дважды — один и тот же результат', () => {
    const run = () => {
      const game = buildGame();
      const at = freeSpot(game, 800);
      project(game, { free: at }, { free: { x: at.x + 800, y: at.y } });
      project(game, { free: { x: at.x + 400, y: at.y - 300 } }, { free: { x: at.x + 400, y: at.y + 300 } });
      runSeconds(game, 40);
      return { money: game.money, net: JSON.stringify(game.roads.net.toJSON()), save: JSON.stringify(game.construction.toSave()) };
    };
    expect(run()).toEqual(run());
  });

  it('снос недостроенного — по обычным правилам: возврат половины заплаченного, проект исчезает без «готово»', () => {
    const game = buildGame();
    const at = freeSpot(game, 600);
    crewAt(game, at);
    expect(project(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
    untilWorking(game);
    runSeconds(game, 6);
    const c = building(game)[0];
    const paid = game.construction.list()[0].project.spent;
    expect(paid).toBeGreaterThan(0);
    const plan = game.roadBuilder.bulldoze([c.id]);
    expect(plan.refund).toBe(paid);
    const money = game.money;
    game.roadBuilder.apply({ ...plan, ok: true });
    expect(game.money - money).toBe(Math.round(paid * 0.5));
    const notices = game.notices.length;
    runSeconds(game, 1);
    expect(game.construction.projects.size).toBe(0);
    expect(game.notices.length).toBe(notices);
  });

  it('станция у строящейся дороги: маршрут заработает, когда дорогу достроят', () => {
    const game = buildGame();
    const at = freeSpot(game, 600);
    crewAt(game, at);
    expect(project(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
    // Пока строится — по ней не проехать: в графе движения нет ни связей проекта, ни его дальнего узла (ближний —
    // тупик подъезда).
    const c = building(game)[0];
    expect(game.roads.graph.outLinks.get(c.b)).toBeUndefined();
    expect(game.roads.graph.corridorLinks(c.id).length).toBe(0);
    expect(game.roads.route(c.a, c.b)).toBeNull();
    untilWorking(game);
    runSeconds(game, (c.length + 2 * convoyGap(c.length)) / CONSTRUCTION.speed + 8);
    expect(building(game)).toEqual([]);
    expect(game.roads.route(c.a, c.b)).not.toBeNull();
  });

  it('мост строится дольше дороги на земле', async () => {
    const { workFactor } = await import('./constructionWork');
    const game = buildGame();
    const at = freeSpot(game, 600);
    expect(project(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
    const c = building(game)[0];
    const net = game.roads.net;
    const flat = workFactor(net, c, () => false);
    expect(flat).toBeCloseTo(1, 6);
    net.node(c.a).level = 1;
    net.node(c.b).level = 1;
    expect(workFactor(net, c, () => false)).toBeCloseTo(CONSTRUCTION.bridge, 6);
  });
});

describe('Стройка дорог: базы и бригады', () => {
  it('первую базу ставит игрок, где хочет, — бесплатно и с бригадой; новая стоит денег', async () => {
    const { advise } = await import('./advisor');
    const game = bareGame();
    const crews = game.construction.crews;
    // Сама база не появляется: советник зовёт поставить, плата — ноль.
    expect(crews.bases.size).toBe(0);
    expect(game.firstBase).toBe(true);
    expect(advise(game).find((a) => a.kind === 'noBase')?.fix).toEqual({ kind: 'base' });
    const base = firstBase(game);
    expect(crews.bases.size).toBe(1);
    expect(crews.brigades.size).toBe(CONSTRUCTION.base.brigades);
    expect(game.firstBase).toBe(false);
    expect(advise(game).some((a) => a.kind === 'noBase')).toBe(false);
    expect(game.money).toBe(WORLD.money);
    // Ворота базы — узел дороги, куда можно доехать.
    expect(game.onRoad(base.nodeId)).toBe(true);
    // Вторая база — у той же дороги чуть дальше, за деньги.
    const plan = game.basePlan(game.roads.net.node(base.nodeId).pos);
    if (plan.ok) {
      const money = game.money;
      expect(game.buildBase(game.roads.net.node(base.nodeId).pos)).toBeNull();
      expect(money - game.money).toBe(plan.cost);
      expect(plan.cost).toBeGreaterThanOrEqual(CONSTRUCTION.base.cost);
    }
  });

  it('название базы — по ближайшему городу, вторая там же — с номером; переименовать и вернуть', () => {
    const game = buildGame();
    const base = [...game.construction.crews.bases.values()][0];
    const town = [...game.towns].sort((a, b) => b.population - a.population || a.id - b.id)[0];
    expect(game.baseName(base.id)).toBe(town.name);
    const second = crewAt(game, { ...base.fp.center }, 1, base.nodeId);
    expect(game.baseName(second.id)).toBe(`${town.name} 2`);
    game.renameBase(base.id, '  Северная  ');
    expect(game.baseName(base.id)).toBe('Северная');
    // Первая переименована — вторая у города теперь одна по имени города.
    expect(game.baseName(second.id)).toBe(town.name);
    // Название уходит в сохранение и возвращается.
    const loaded = new Game(WORLD, game.toSave());
    expect(loaded.baseName(base.id)).toBe('Северная');
    game.renameBase(base.id, '   ');
    expect(game.baseName(base.id)).toBe(town.name);
  });

  it('название проекта: своё вместо автоматического, пустое — снова автоматическое; уходит в сохранение', async () => {
    const { advise } = await import('./advisor');
    const { baseCrewText } = await import('../ui/baseCard');
    const game = buildGame();
    const at = freeSpot(game, 900);
    expect(project(game, { free: at }, { free: { x: at.x + 900, y: at.y } })).toBe(true);
    const p = game.construction.list()[0].project;
    const auto = p.label;
    expect(projectName(p)).toBe(auto);
    game.renameProject(p.id, '  Объездная у рынка  ');
    expect(p.name).toBe('Объездная у рынка');
    expect(p.label).toBe(auto);
    expect(projectName(p)).toBe('Объездная у рынка');
    expect(game.journal.entries.at(-1)).toMatchObject({ k: 'project-name', id: p.id, name: 'Объездная у рынка' });
    // Не длиннее 40 знаков.
    game.renameProject(p.id, 'Очень длинное название проекта объездной дороги у рынка');
    expect(p.name).toBe('Очень длинное название проекта объездной дороги у рынка'.slice(0, 40));
    game.renameProject(p.id, 'Объездная');
    // Своё название — и в советах, и у бригады, и в уведомлении о конце стройки.
    expect(advise(game).some((a) => a.detail.includes('«Объездная»'))).toBe(true);
    game.projectEvent('done', p);
    expect(game.notices.at(-1)?.text).toBe('🚧 Стройка закончена: Объездная');
    // Клик по уведомлению ведёт к улице: место — середина рамки полотен проекта.
    const go = game.notices.at(-1)?.at;
    expect(p.area).toBeDefined();
    expect(go?.pos.x).toBeCloseTo((p.area![0] + p.area![2]) / 2, 6);
    expect(go!.r).toBeGreaterThanOrEqual(80);
    const brigade = [...game.construction.crews.brigades.values()][0];
    expect(baseCrewText(game, { ...brigade, state: 'working', project: p.id })).toBe('строит «Объездная»');
    // Название уходит в сохранение и возвращается.
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = withoutCitizens(new Game(save.settings, save));
    expect(projectName(loaded.construction.projects.get(p.id)!)).toBe('Объездная');
    // Старое сохранение (без name) открывается с автоматическим названием.
    delete save.construction.projects[0].name;
    const old = withoutCitizens(new Game(save.settings, save));
    expect(projectName(old.construction.projects.get(p.id)!)).toBe(auto);
    // Пустое — снова автоматическое; Esc-значение (то же название) ничего не пишет.
    game.renameProject(p.id, '   ');
    expect(p.name).toBeUndefined();
    expect(projectName(p)).toBe(auto);
    const n = game.journal.entries.length;
    game.renameProject(p.id, auto);
    expect(p.name).toBeUndefined();
    expect(game.journal.entries.length).toBe(n);
    expect(() => game.renameProject(999_999, 'Пусто')).not.toThrow();
  });

  it('где бригада: свободная — на базе, на стройке — у края работ', () => {
    const game = buildGame();
    const at = freeSpot(game, 900);
    const base = crewAt(game, { x: at.x - 50, y: at.y }, 1, at);
    const id = game.construction.crews.of(base.id)[0].id;
    expect(game.brigadeWhere(id)).toEqual({ pos: base.fp.center, text: 'свободна, стоит на базе' });
    project(game, { free: at }, { free: { x: at.x + 900, y: at.y } });
    untilWorking(game, 600);
    const info = game.construction.list()[0];
    const where = game.brigadeWhere(id)!;
    expect(where.text).toBe(`строит «${info.project.label}»`);
    expect(where.pos).toEqual(info.front ?? info.at);
    expect(game.brigadeWhere(-1)).toBeNull();
  });

  it('бригада едет к стройке по дороге — машиной в общем потоке, и строит, когда доехала', () => {
    const game = buildGame();
    const crews = game.construction.crews;
    const base = [...crews.bases.values()][0];
    // Проект от ворот базы в поле: край работ — у дороги, бригада едет туда по дороге.
    const gate = game.roads.net.node(base.nodeId);
    const out = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ x: gate.pos.x + Math.cos((k * Math.PI) / 4) * 500, y: gate.pos.y + Math.sin((k * Math.PI) / 4) * 500 }));
    // Стройка — от узла дороги подальше от ворот: ближайший к воротам перекрёсток или тупик в 150+ м.
    const far = [...game.roads.open.nodes.values()]
      .filter((n) => game.onRoad(n.id) && Math.hypot(n.pos.x - gate.pos.x, n.pos.y - gate.pos.y) > 150)
      .sort((a, b) => Math.hypot(a.pos.x - gate.pos.x, a.pos.y - gate.pos.y) - Math.hypot(b.pos.x - gate.pos.x, b.pos.y - gate.pos.y));
    let built = false;
    for (const n of far.slice(0, 12)) {
      for (const q of out) {
        const end = { x: n.pos.x + (q.x - gate.pos.x), y: n.pos.y + (q.y - gate.pos.y) };
        if (project(game, n.id, { free: end })) {
          built = true;
          break;
        }
      }
      if (built) break;
    }
    expect(built).toBe(true);
    const id = game.construction.list()[0].project.id;
    let drove = false;
    const bodies = new Set<string | undefined>();
    // Пока бригада не на работе и пока с базы не выехала вся колонна: до близкой стройки головная машина доезжает
    // раньше, чем с базы выедет последняя.
    for (let t = 0; t < 60 && (!crews.working(id).length || bodies.size < 3); t += 0.1) {
      runSeconds(game, 0.1);
      const b = [...crews.brigades.values()][0];
      for (const car of b.convoy?.cars ?? []) {
        if (!('sim' in car) || !game.traffic.vehicles.has(car.sim)) continue;
        drove = true;
        bodies.add(game.traffic.vehicles.get(car.sim)!.body);
        // Любая машина колонны узнаётся как техника этой бригады (карточка — «Строительная бригада», не «машина жителя»).
        expect(game.crewOfSim(car.sim)).toBe(b.id);
      }
    }
    expect(drove).toBe(true);
    // По дороге едет вся бригада — та же техника, что работает на стройке: отсыпка, покрытие, разметка.
    expect([...bodies].sort()).toEqual(['crewEarth', 'crewMarks', 'crewPave']);
    expect(crews.working(id).length).toBe(1);
    runSeconds(game, 3);
    expect(game.construction.list()[0].done).toBeGreaterThan(0);
  });

  it('две бригады строят быстрее одной, но не вдвое; далёкая база — медленнее, и советник это видит', async () => {
    const { advise } = await import('./advisor');
    const pace = (n: number, far: number) => {
      const game = buildGame();
      const at = freeSpot(game, 900);
      // База далеко (темп — по расстоянию от неё), а подъезд — у самого проекта.
      crewAt(game, { x: at.x - far, y: at.y }, n, at);
      project(game, { free: at }, { free: { x: at.x + 900, y: at.y } });
      // Бригады выезжают с ворот по одной, а машина берётся за свой этап, только доехав до своего места: опоздавшая
      // бригада догоняла бы ушедший вперёд край. Темп меряем честно: проект стоит без денег, пока на места не встанут
      // все машины всех бригад, потом — деньги, и меряем, когда идут все этапы (в начале участка покрытие и разметка
      // ждут, пока отсыпка уйдёт вперёд).
      const id = game.construction.list()[0].project.id;
      const crews = game.construction.crews;
      const money = game.money;
      game.money = ECONOMY.creditLimit;
      const placed = () => crews.working(id).length >= n && crews.working(id).every((b) => crews.placed(b).every(Boolean));
      for (let t = 0; t < 1200 && !placed(); t += 0.1) runSeconds(game, 0.1);
      expect(placed()).toBe(true);
      game.money = money;
      const marks = () => game.construction.fronts(id).some((c) => spansOf(c.build, c.length)[2] > 0);
      for (let t = 0; t < 600 && !marks(); t += 0.1) runSeconds(game, 0.1);
      const done0 = game.construction.list()[0].done;
      runSeconds(game, 6);
      return { done: game.construction.list()[0].done - done0, advice: advise(game) };
    };
    // Колонны бригад выезжают с ворот по одной машине — когда на месте все, край уже ушёл от базы на разное
    // расстояние: доли бригад сравниваем без поправки на расстояние.
    const reach = CONSTRUCTION.reach;
    CONSTRUCTION.reach = 1e12;
    const [one, two, three] = [1, 2, 3].map((n) => pace(n, 0));
    CONSTRUCTION.reach = reach;
    // Вторая бригада прибавляет долю crewShare[1], третья — crewShare[2]: вместе мешают друг другу.
    const [, s2, s3] = CONSTRUCTION.crewShare;
    expect(two.done).toBeGreaterThan(one.done * (1 + s2) * 0.93);
    expect(two.done).toBeLessThan(one.done * (1 + s2) * 1.07);
    expect(three.done).toBeGreaterThan(one.done * (1 + s2 + s3) * 0.93);
    expect(three.done).toBeLessThan(one.done * 3 * 0.8);
    const far = pace(1, CONSTRUCTION.reach * 1.5);
    expect(far.done).toBeLessThan(one.done * 0.5);
    expect(far.advice.some((a) => a.kind === 'buildFar' && a.title === 'Бригада далеко от базы')).toBe(true);
    expect(one.advice.some((a) => a.kind === 'buildFar')).toBe(false);
  });

  it('содержание бригад — каждый месяц; нанять и распустить', () => {
    // Две одинаковые партии, в одной — бригадой больше: за месяц разница — её цена и содержание.
    const a = buildGame();
    const b = buildGame();
    const base = [...b.construction.crews.bases.values()][0];
    expect(b.hireBrigade(base.id)).toBeNull();
    expect(a.money - b.money).toBe(CONSTRUCTION.brigade.cost);
    expect(b.construction.crews.of(base.id).length).toBe(CONSTRUCTION.base.brigades + 1);
    for (const g of [a, b]) runSeconds(g, 61);
    expect(a.money - b.money).toBe(CONSTRUCTION.brigade.cost + Math.round(CONSTRUCTION.brigade.upkeep));
    expect(b.dismissBrigade(base.id)).toBe(true);
    expect(b.construction.crews.of(base.id).length).toBe(CONSTRUCTION.base.brigades);
  });
});
