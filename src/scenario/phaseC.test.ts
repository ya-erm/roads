import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { stationAtIndustry } from '../game/testkit';
import { DEFAULT_SETTINGS } from '../world/settings';
import { connected, newRoutesCarried } from './analysis';
import { PHASES } from './content';
import { assess } from './feasibility';
import { liveProgress, makerKey, monthOk, titleOf } from './objectives';
import type { Objective } from './types';

const scenarioGame = (seed = 42) => new Game({ ...DEFAULT_SETTINGS, seed, scenario: { difficulty: 'normal', challenge: false } });

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
