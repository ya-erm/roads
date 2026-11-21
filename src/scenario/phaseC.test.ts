import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { Game } from '../game/game';
import { freshGame, stationAtIndustry, withoutCitizens } from '../game/testkit';
import type { Line } from '../game/transport';
import { DEFAULT_SETTINGS } from '../world/settings';
import { connected, newRoutesCarried } from './analysis';
import { PHASES } from './content';
import { assess } from './feasibility';
import { liveProgress, makerKey, monthOk, titleOf } from './objectives';
import type { Objective } from './types';

const scenarioGame = (seed = 42) => freshGame({ ...DEFAULT_SETTINGS, seed, scenario: { difficulty: 'normal', challenge: false } });

/** Главная цель текущего этапа выполнена — переходим на следующий. */
function advance(game: Game): void {
  const sc = game.scenario!;
  const main = sc.state.objectives.filter((o) => o.phase === sc.state.phase && o.role === 'main').pop()!;
  main.status = 'done';
  expect(sc.advancePhase()).toBe(true);
}

/** Маршрут ферма → ближайший пищекомбинат со станциями у обоих и грузовиком (дорогу не строим — в сети он и так). */
function farmLine(game: Game) {
  game.money = 5_000_000;
  const farm = game.industries.find((i) => i.info.kind === 'farm')!;
  const plant = game.industries
    .filter((i) => i.info.accepts.includes('grain'))
    .sort((a, b) => Math.hypot(a.fp.center.x - farm.fp.center.x, a.fp.center.y - farm.fp.center.y) - Math.hypot(b.fp.center.x - farm.fp.center.x, b.fp.center.y - farm.fp.center.y))[0];
  const a = stationAtIndustry(game, farm, plant.fp.center)!;
  const b = stationAtIndustry(game, plant, farm.fp.center)!;
  const line = game.createLine([a.id, b.id])!;
  game.buyVehicle(line.id, 'truck');
  return { farm, plant, line };
}

function volumeGoal(game: Game, since = 0) {
  return game.scenario!.addObjective({ kind: 'newRoutes', amount: 80, since, months: 2 }, {
    role: 'goal', phase: null, months: 10, why: 'Проверка окна перевозок', reward: {},
  });
}

function volumeGame() {
  const game = withoutCitizens(scenarioGame());
  const { line } = farmLine(game);
  for (const id of [...line.vehicles]) game.sellVehicle(id);
  return { game, line };
}

/** Закрываем настоящий месяц, подставляя только счётчики линий. */
function closeVolumeMonth(game: Game, totals: [Line, number][]): void {
  const next = game.monthIndex + 1;
  for (const [line, units] of totals) line.carriedMonth = units;
  game.time = next * MONTH_LENGTH - 0.05;
  game.speed = 1;
  game.update(0.1);
  game.settleMonth();
  expect(game.monthIndex).toBe(next);
}

describe('Этап C «Освоение региона»', () => {
  it('главная цель — новые маршруты этапа, цели — подключить города и предприятия и снабжать город; без «быстрой доставки» и роста города', () => {
    const game = scenarioGame();
    advance(game);
    advance(game);
    const sc = game.scenario!;
    expect(sc.state.phase).toBe(2);
    expect(PHASES[2].short).toBe('Освоение');
    const phase = sc.state.objectives.filter((o) => o.phase === 2);
    const main = phase.find((o) => o.role === 'main')!;
    expect(main.params.kind).toBe('newRoutes');
    if (main.params.kind === 'newRoutes') {
      expect(main.params.since).toBe(sc.month);
      expect(main.params.amount).toBeGreaterThan(0);
    }
    const kinds = phase.filter((o) => o.role === 'goal').map((o) => (o.params.kind === 'connect' ? `connect:${o.params.what}` : o.params.kind));
    expect(kinds).toEqual(expect.arrayContaining(['connect:town', 'connect:industry']));
    expect(kinds).not.toContain('quality');
    expect(kinds).not.toContain('population');
    for (const o of phase) expect(assess(game, o.params, 8).ok, o.title).toBe(true);
  });

  it('новые маршруты: старые линии не в счёт, построенные с начала этапа — в счёт', () => {
    const game = scenarioGame();
    const { line } = farmLine(game);
    // Линия создана в месяце 0; этап начался в месяце 3 — её груз не считается.
    line.carriedLast = 500;
    const p = { kind: 'newRoutes' as const, amount: 200, since: 3, months: 1 };
    expect(newRoutesCarried(game, 3)).toBe(0);
    expect(monthOk(p, game, undefined as never)).toBe(false);
    // Старое сохранение: месяца создания нет — тоже старая линия.
    delete line.created;
    expect(newRoutesCarried(game, 0)).toBe(0);
    line.created = 3;
    expect(newRoutesCarried(game, 3)).toBe(500);
    expect(monthOk(p, game, undefined as never)).toBe(true);
    expect(titleOf(p, game)).toBe('Новые маршруты этапа: перевозить от 200 ед. в месяц');
  });

  it('подключить новые: считаются только те, кого не было в сети, когда задание появилось', () => {
    const game = scenarioGame();
    const before = connected(game);
    expect(before.industries.size).toBe(0);
    const { farm, plant } = farmLine(game);
    const now = connected(game);
    expect(now.industries.has(farm.id) && now.industries.has(plant.id)).toBe(true);
    const o = { params: { kind: 'connect', what: 'industry', amount: 2, known: [] }, streak: 0, base: 0 } as unknown as Objective;
    expect(liveProgress(o, game.scenario!.state, game)).toBe(2);
    // Ферма уже была в сети — новое только одно.
    o.params = { kind: 'connect', what: 'industry', amount: 2, known: [farm.id] };
    expect(liveProgress(o, game.scenario!.state, game)).toBe(1);
    expect(titleOf(o.params, game)).toBe('Подключить к сети 2 новых предприятия');
    expect(titleOf({ kind: 'connect', what: 'town', amount: 1, known: [] }, game)).toBe('Подключить к сети 1 новый город');
    // Выполнимо, только если вне сети осталось больше, чем нужно подключить.
    expect(assess(game, { kind: 'connect', what: 'town', amount: game.towns.length, known: [] }, 8).ok).toBe(false);
  });
});

describe('Этап B: какой завод растить', () => {
  it('завод, которому всё уже возят и у которого вывозят продукцию, не берётся — растёт сам; берётся тот, где чего-то не хватает', () => {
    const game = scenarioGame(7);
    const sc = game.scenario!;
    const plants = game.industries.filter((i) => i.info.accepts.length === 1 && i.info.kind === 'foodplant');
    expect(plants.length).toBeGreaterThanOrEqual(2);
    const [full, lacking] = plants;
    // Обоим возят сырьё; у первого продукцию вывозят, у второго — нет.
    for (const p of [full, lacking]) sc.state.stats.to[`industry:${p.id}:grain`] = 100;
    sc.state.stats.from = { ...(sc.state.stats.from ?? {}), [makerKey(full.id, 'food')]: 80 };
    full.level = 2;
    lacking.level = 1.5;
    advance(game);
    const main = sc.state.objectives.find((o) => o.phase === 1 && o.role === 'main')!;
    expect(main.params.kind).toBe('industry');
    if (main.params.kind === 'industry') expect(main.params.industry).toBe(lacking.id);
    expect(main.why).toContain('никто не вывозит');
  });
});

describe('Окно объёма новых маршрутов', () => {
  it('160 и 0 выполняют цель после двух закрытых месяцев', () => {
    const { game, line } = volumeGame();
    const o = volumeGoal(game);
    expect(o.title).toBe('Новые маршруты этапа: перевезти от 160 ед. суммарно за 2 месяца');
    closeVolumeMonth(game, [[line, 160]]);
    expect(o.status).toBe('active');
    expect(o.progress).toBe(160);
    closeVolumeMonth(game, [[line, 0]]);
    expect(o.status).toBe('done');
    expect(o.routeMonths).toEqual([{ month: 0, units: 160 }, { month: 1, units: 0 }]);
  });

  it('140 и 0 недостаточно, объём первого месяца выбывает на третьем', () => {
    const { game, line } = volumeGame();
    const o = volumeGoal(game);
    closeVolumeMonth(game, [[line, 140]]);
    closeVolumeMonth(game, [[line, 0]]);
    expect(o.status).toBe('active');
    expect(o.progress).toBe(140);
    closeVolumeMonth(game, [[line, 30]]);
    expect(o.status).toBe('active');
    expect(o.progress).toBe(30);
    expect(o.routeMonths).toEqual([{ month: 1, units: 0 }, { month: 2, units: 30 }]);
    closeVolumeMonth(game, [[line, 130]]);
    expect(o.status).toBe('done');
  });

  it('в неполном месяце этапа зачтены только поставки линий, созданных после его начала', () => {
    const { game, line } = volumeGame();
    closeVolumeMonth(game, [[line, 900]]);
    game.time = 1.5 * MONTH_LENGTH;
    const o = volumeGoal(game, 1.5);
    game.time = 1.55 * MONTH_LENGTH;
    const added = game.createLine([...line.stops].reverse())!;
    closeVolumeMonth(game, [[line, 900], [added, 90]]);
    expect(o.routeMonths).toEqual([{ month: 1, units: 90 }]);
    expect(o.status).toBe('active');
    closeVolumeMonth(game, [[line, 900], [added, 70]]);
    expect(o.status).toBe('done');
    expect(o.progress).toBe(160);
  });

  it('после загрузки сохранения продолжает окно с того же закрытого месяца', () => {
    const { game, line } = volumeGame();
    const o = volumeGoal(game);
    closeVolumeMonth(game, [[line, 150]]);
    closeVolumeMonth(game, [[line, 0]]);
    const save = structuredClone(game.toSave());
    const loaded = withoutCitizens(new Game(save.settings, save));
    const live = loaded.scenario!.objective(o.id)!;
    expect(live.routeMonths).toEqual(o.routeMonths);
    expect(live.progress).toBe(150);
    closeVolumeMonth(loaded, [[loaded.lines.get(line.id)!, 20]]);
    expect(live.status).toBe('active');
    expect(live.progress).toBe(20);
  });

  it('загружает старую серию и восстанавливает последний закрытый месяц по сохранённым объёмам линий', () => {
    const { game, line } = volumeGame();
    const o = volumeGoal(game);
    closeVolumeMonth(game, [[line, 160]]);
    const save = structuredClone(game.toSave());
    const old = save.scenario!.objectives.find((obj) => obj.id === o.id)!;
    delete old.routeMonths;
    old.title = 'Новые маршруты этапа: перевозить от 80 ед. в месяц, 2 месяца подряд';
    old.progress = old.streak = 1;
    old.target = 2;
    const loaded = withoutCitizens(new Game(save.settings, save));
    const live = loaded.scenario!.objective(o.id)!;
    expect(live.title).toBe(o.title);
    expect(live.target).toBe(160);
    expect(live.progress).toBe(160);
    expect(live.routeMonths).toEqual([{ month: 0, units: 160 }]);
    closeVolumeMonth(loaded, [[loaded.lines.get(line.id)!, 0]]);
    expect(live.status).toBe('done');
  });
});
