import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH, TERM_SCALE } from '../config';
import { Game } from '../game/game';
import { stationAtIndustry } from '../game/testkit';
import { TOWN_NEED } from '../world/entities';
import { DEFAULT_SETTINGS } from '../world/settings';
import { newRoutesCarried, refOf } from './analysis';
import { FAST } from './content';
import { eventCandidates, forceEvent } from './events';
import { connectable, connectGoal } from './feasibility';
import { fastMonths, supplyNeedsFor } from './generator';
import { fastBonus } from './manager';
import { monthOk, receiverKey, titleOf } from './objectives';
import { computeScore } from './score';
import type { Objective } from './types';

const scenarioGame = (seed = 42) => new Game({ ...DEFAULT_SETTINGS, seed, scenario: { difficulty: 'normal', challenge: false } });

/** Главная цель текущего этапа выполнена — переходим на следующий досрочно (посреди месяца). */
function advance(game: Game): void {
  const sc = game.scenario!;
  const main = sc.state.objectives.filter((o) => o.phase === sc.state.phase && o.role === 'main').pop()!;
  main.status = 'done';
  expect(sc.advancePhase()).toBe(true);
}

/** Маршрут ферма → ближайший пищекомбинат со станциями у обоих и грузовиком. */
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

describe('Задания, выданные в итогах месяца, не теряют месяц', () => {
  it('этап C, начатый в конце месяца, идёт с нового месяца: полный срок, а маршруты прошлого месяца — старые', () => {
    const game = scenarioGame();
    advance(game);
    const sc = game.scenario!;
    const m = sc.month;
    // Главная цель B выполнена, остальные цели этапа проваливаются по сроку в итогах месяца — и сразу этап C.
    for (const o of sc.state.objectives.filter((x) => x.phase === 1)) {
      if (o.role === 'main') o.status = 'done';
      else o.deadline = m + 1;
    }
    sc.monthEnd();
    expect(sc.state.phase).toBe(2);
    expect(sc.state.phaseStart).toBe(m + 1);
    const main = sc.state.objectives.find((o) => o.phase === 2 && o.role === 'main')!;
    expect(main.created).toBe(m + 1);
    expect(main.deadline).toBe(m + 1 + main.months!);
    expect(main.params.kind === 'newRoutes' && main.params.since).toBe(m + 1);
  });

  it('новые маршруты считаются с момента начала этапа, а не с начала месяца', () => {
    const game = scenarioGame();
    const { line } = farmLine(game);
    line.carriedLast = 300;
    // Маршрут построен в конце прошлого месяца этапа B, этап C начался с нового — не в счёт.
    line.created = 9.9;
    expect(newRoutesCarried(game, 10)).toBe(0);
    // Этап C начался посреди месяца: маршрут, построенный за минуту до того, — старый, после — новый.
    expect(newRoutesCarried(game, 10.4)).toBe(0);
    line.created = 10.45;
    expect(newRoutesCarried(game, 10.4)).toBe(300);
    // Маршрут помнит момент создания с долей месяца.
    game.time = 3.5 * MONTH_LENGTH;
    const again = farmLine(game).line;
    expect(again.created).toBeCloseTo(3.5);
  });
});

describe('«Подключить новые города»: просим меньше, а не снимаем цель', () => {
  it('вне сети осталось столько же, сколько задумано, — просим на одного меньше; остался один — цели нет', () => {
    const game = scenarioGame();
    const ids = game.towns.map((t) => t.id);
    expect(connectable(game, 'town', [])).toBe(game.towns.length);
    // Вне сети — два города, задумано два: просим один (как в журнале 295499027).
    expect(connectGoal(game, 'town', ids.slice(2), 2)).toBe(1);
    expect(connectGoal(game, 'town', ids.slice(1), 2)).toBe(0);
    expect(connectGoal(game, 'town', [], 2)).toBe(2);
  });
});

describe('Дефицит сырья', () => {
  it('контракт не предлагают заводу, куда уже везут по заданию; спад после отказа — только если завод и правда стоит', () => {
    const game = scenarioGame();
    const sc = game.scenario!;
    const { plant } = farmLine(game);
    sc.state.watch[plant.id] = { low: 2, idle: 0, active: true };
    const isCandidate = () => eventCandidates(sc, 'shortage').some((c) => c.subject?.type === 'industry' && c.subject.id === plant.id);
    expect(isCandidate()).toBe(true);
    // Главная цель везёт на этот завод — контракт-дубль не нужен.
    const task = sc.addObjective({ kind: 'deliver', cargo: 'grain', amount: 100, to: refOf(plant) }, { role: 'goal', phase: sc.state.phase, months: 4, why: '', reward: {} });
    expect(isCandidate()).toBe(false);
    task.status = 'failed';
    expect(isCandidate()).toBe(true);

    // Контракт предложили и не приняли, но сырьё заводу возят (в прошлом месяце работал) — спада нет.
    const declineAfter = (producedLast: number) => {
      const rec = forceEvent(sc, 'shortage', refOf(plant))!;
      expect(rec).not.toBeNull();
      plant.level = 2;
      plant.producedLast = producedLast;
      sc.decline(rec.contract!, true);
      sc.monthEnd();
      return sc.state.events.find((e) => e.type === 'decline' && e.related.some((r) => r.id === plant.id));
    };
    expect(declineAfter(40)).toBeUndefined();
    expect(plant.level).toBe(2);
    // Завод стоит без сырья — спад.
    sc.state.memory = {};
    sc.state.objectives = sc.state.objectives.filter((o) => o.role !== 'contract');
    expect(declineAfter(0)).toBeDefined();
    expect(plant.level).toBe(1.5);
  });
});

describe('Снабжение города: часть потребностей', () => {
  it('просим закрыть часть потребностей по сложности; засчитывается, когда закрыто не меньше нужного', () => {
    expect(supplyNeedsFor(5, 'easy')).toBe(3);
    expect(supplyNeedsFor(5, 'normal')).toBe(3);
    expect(supplyNeedsFor(5, 'hard')).toBe(4);
    expect(supplyNeedsFor(2, 'normal')).toBe(2);
    expect(supplyNeedsFor(1, 'easy')).toBe(1);

    const game = scenarioGame();
    const town = [...game.towns].sort((a, b) => b.demands.length - a.demands.length)[0];
    const total = town.demands.length;
    expect(total).toBeGreaterThanOrEqual(2);
    const p = { kind: 'supply' as const, town: town.id, months: 1, needs: total - 1 };
    expect(titleOf(p, game)).toBe(`Снабжать город ${town.name}: закрыть ${total - 1} из ${total} потребностей`);
    // Закрыто всё, кроме одной, — хватает для «N−1 из N», но не для «всем необходимым».
    town.lastSupplied = Object.fromEntries(town.demands.slice(1).map((c) => [c, TOWN_NEED]));
    expect(monthOk(p, game, undefined as never)).toBe(true);
    expect(monthOk({ kind: 'supply', town: town.id, months: 1 }, game, undefined as never)).toBe(false);
    // Старое задание без needs — по-прежнему все потребности.
    expect(titleOf({ kind: 'supply', town: town.id, months: 1 }, game)).toBe(`Снабжать город ${town.name} всем необходимым`);
  });

  it('на этапах B и C у цели «снабжать» — часть потребностей, а не все', () => {
    let seen = 0;
    for (const seed of [42, 7, 295499027]) {
      const game = scenarioGame(seed);
      advance(game);
      advance(game);
      const supplies = game.scenario!.state.objectives.filter((o) => o.params.kind === 'supply');
      for (const o of supplies) {
        if (o.params.kind !== 'supply') continue;
        const town = game.towns.find((t) => t.id === (o.params as { town: number }).town)!;
        expect(o.params.needs, o.title).toBe(supplyNeedsFor(town.demands.length, 'normal'));
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('После победы — дополнительные задания', () => {
  it('выдаются без сроков, на оценку не влияют, прогресс идёт и после победы; старое сохранение получает их при загрузке', () => {
    const game = scenarioGame();
    const sc = game.scenario!;
    advance(game);
    advance(game);
    advance(game);
    expect(sc.state.status).toBe('won');
    expect(sc.state.extras).toBe(true);
    const extras = () => sc.state.objectives.filter((o) => o.role === 'extra');
    expect(extras().length).toBeGreaterThanOrEqual(2);
    for (const o of extras()) {
      expect(o.status).toBe('active');
      expect(o.deadline).toBeNull();
      expect(o.fast).toBeUndefined();
      expect(o.points).toBe(0);
    }
    expect(computeScore(sc).total).toBe(sc.state.score!.total);
    // Подключили предприятия — прогресс дополнительного задания идёт и после победы.
    const industries = extras().find((o) => o.params.kind === 'connect' && o.params.what === 'industry')!;
    expect(industries).toBeDefined();
    farmLine(game);
    sc.tick(1);
    expect(industries.progress).toBe(2);
    // Пройденный сценарий из старого сохранения: заданий нет — выдаются на первом шаге.
    sc.state.objectives = sc.state.objectives.filter((o) => o.role !== 'extra');
    delete sc.state.extras;
    sc.tick(1);
    expect(extras().length).toBeGreaterThanOrEqual(2);
  });
});

describe('Быстрый срок', () => {
  it('у доставки получателю и пассажиров между городами — раньше обычного хотя бы на 2 мин; у остальных — нет', () => {
    for (const seed of [42, 7, 295499027]) {
      const game = scenarioGame(seed);
      const sc = game.scenario!;
      const withFast = sc.state.objectives.filter((o) => o.fast !== undefined);
      expect(withFast.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const o of withFast) {
        expect(['deliver', 'passengers']).toContain(o.params.kind);
        expect(o.fast!).toBeLessThanOrEqual(o.deadline! - TERM_SCALE);
        expect(o.fast!).toBeGreaterThan(sc.month);
      }
      const profit = sc.state.objectives.find((o) => o.params.kind === 'profit');
      if (profit) expect(profit.fast).toBeUndefined();
    }
  });

  it('прикидка учитывает дорогу: дальний получатель — срок позже, а впритык к обычному сроку быстрого нет', () => {
    const game = scenarioGame();
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const plants = game.industries
      .filter((i) => i.info.accepts.includes('grain'))
      .sort((a, b) => Math.hypot(a.fp.center.x - farm.fp.center.x, a.fp.center.y - farm.fp.center.y) - Math.hypot(b.fp.center.x - farm.fp.center.x, b.fp.center.y - farm.fp.center.y));
    // Обычный срок — 24 месяца (24 мин); быстрый — не раньше, чем через 2 мин, и хотя бы на 2 мин раньше обычного.
    const months = 12 * TERM_SCALE;
    const near = fastMonths(game, { kind: 'deliver', cargo: 'grain', amount: 100, to: refOf(plants[0]) }, months, 'normal')!;
    expect(near).toBeGreaterThanOrEqual(TERM_SCALE);
    const big = fastMonths(game, { kind: 'deliver', cargo: 'grain', amount: 600, to: refOf(plants[0]) }, months, 'normal')!;
    expect(big).toBeGreaterThan(near);
    expect(big).toBeLessThanOrEqual(months - TERM_SCALE);
    expect(fastMonths(game, { kind: 'deliver', cargo: 'grain', amount: 100, to: refOf(plants[0]) }, near + 1, 'normal')).toBeNull();
    expect(fastMonths(game, { kind: 'profit', amount: 1000, months: TERM_SCALE }, months, 'normal')).toBeNull();
  });

  it('успели к быстрому сроку — надбавка к награде и очки; не успели — только обычная награда', () => {
    // Карта, где у заданий старта есть доставка получателю с быстрым сроком.
    const seed = [42, 7, 11, 23, 295499027].find((s) =>
      scenarioGame(s).scenario!.state.objectives.some((x) => x.fast !== undefined && x.params.kind === 'deliver' && x.params.to),
    );
    expect(seed).toBeDefined();
    const run = (late: boolean) => {
      const game = scenarioGame(seed);
      const sc = game.scenario!;
      const o = sc.state.objectives.find((x) => x.fast !== undefined && x.params.kind === 'deliver' && x.params.to) as Objective;
      if (o.params.kind !== 'deliver' || !o.params.to) throw new Error('не доставка');
      if (late) game.time = o.fast! * MONTH_LENGTH + 1;
      const money = game.money;
      sc.state.stats.to[receiverKey(o.params.to, o.params.cargo)] = o.base + o.target;
      sc.tick(1);
      expect(o.status).toBe('done');
      return { o, got: game.money - money };
    };
    const quick = run(false);
    const slow = run(true);
    expect(quick.o.quick).toBe(true);
    expect(slow.o.quick).toBeUndefined();
    expect(quick.got - slow.got).toBe(fastBonus(quick.o));
    expect(fastBonus(quick.o)).toBe(Math.round(((quick.o.reward.money ?? 0) * FAST.money) / 1000) * 1000);
  });

  it('у контракта быстрый срок отсчитывается с момента, как приняли', () => {
    const game = scenarioGame();
    const sc = game.scenario!;
    // Предложение: пассажиры между двумя ближайшими городами.
    const [a, b] = [...game.towns].sort((x, y) => x.center.x - y.center.x);
    const offer = sc.addObjective({ kind: 'passengers', amount: 60, towns: [a.id, b.id] }, { role: 'contract', phase: null, months: 12, offer: true, why: '', reward: { money: 40_000 } });
    expect(offer.fastMonths).toBeDefined();
    expect(offer.fast).toBeUndefined();
    game.time = 0.5 * MONTH_LENGTH;
    expect(sc.accept(offer.id)).toBe(true);
    expect(offer.fast).toBeCloseTo(0.5 + offer.fastMonths!);
  });
});
