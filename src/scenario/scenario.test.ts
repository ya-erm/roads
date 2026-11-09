import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH, TERM_SCALE } from '../config';
import { dist } from '../core/vec';
import { Game } from '../game/game';
import { connectStations as connect, stationAtIndustry, withoutCitizens } from '../game/testkit';
import { twoWay } from '../lanes/model';
import { DEFAULT_SETTINGS, WorldSettings } from '../world/settings';
import { industryById, producible, receivers, refOf } from './analysis';
import { ARCHETYPES, EVENT_INFO, EVENT_RULES } from './content';
import { NO_MODS } from './effects';
import { activeEvents, forceEvent, runEvents } from './events';
import { assess } from './feasibility';
import { Scenario } from './manager';
import type { Difficulty, Objective } from './types';

const scenario = (seed: number, difficulty: Difficulty = 'normal', extra: Partial<WorldSettings> = {}): WorldSettings => ({
  ...DEFAULT_SETTINGS,
  ...extra,
  seed,
  scenario: { difficulty, challenge: false },
});

/** months месяцев — и ещё кадр, чтобы точно пересечь границу месяца (время копится шагами симуляции). */
function runMonths(game: Game, months: number, until?: () => boolean): void {
  game.speed = 1;
  for (let t = 0; t < months * MONTH_LENGTH + 0.1; t += 0.1) {
    game.update(0.1);
    if (until?.()) return;
  }
}

/** Номер месяца игры напрямую — чтобы прогнать месячную логику сценария без долгой симуляции движения. */
function setMonth(game: Game, month: number): void {
  (game as unknown as { month: number }).month = month;
  game.time = month * MONTH_LENGTH;
}

/** Все задания должны проходить проверку выполнимости и не требовать груза, которого не получить. */
function checkObjective(game: Game, o: Objective): void {
  const p = o.params;
  if (p.kind === 'deliver') {
    expect(producible(game, p.cargo), o.title).toBe(true);
    expect(receivers(game, p.cargo).length, o.title).toBeGreaterThan(0);
  }
  if (o.retryOf) return;
  const months = o.months ?? (o.deadline !== null ? o.deadline - o.created : 24 * TERM_SCALE);
  const verdict = assess(game, p, months);
  expect(verdict.ok, `${o.title}: ${verdict.reason}`).toBe(true);
}

/** Пропустить этап: главная цель засчитана, следующий этап создаётся по нынешнему миру. */
function skipPhase(sc: Scenario): void {
  const main = sc.state.objectives.filter((o) => o.phase === sc.state.phase && o.role === 'main').pop()!;
  main.status = 'done';
  expect(sc.advancePhase()).toBe(true);
}

describe('Сценарий: генерация', { timeout: 120_000 }, () => {
  it('создаётся на разных случайных картах и сложностях: архетип, капитал, цели этапа A, брифинг', () => {
    const archetypes = new Set<string>();
    for (const seed of [3, 11, 25, 58, 101, 777]) {
      for (const difficulty of ['easy', 'normal', 'hard'] as const) {
        if (difficulty !== 'normal' && seed > 25) continue;
        const game = new Game(scenario(seed, difficulty));
        const sc = game.scenario!;
        expect(sc).toBeTruthy();
        archetypes.add(sc.state.archetype);
        expect(ARCHETYPES[sc.state.archetype]).toBeDefined();
        expect(game.money).toBeGreaterThanOrEqual(200_000);
        expect(sc.state.brief.facts.length).toBeGreaterThan(2);
        const phaseA = sc.state.objectives.filter((o) => o.phase === 0);
        expect(phaseA.filter((o) => o.role === 'main')).toHaveLength(1);
        expect(phaseA.length).toBeGreaterThanOrEqual(2);
        for (const o of phaseA) expect(o.deadline).toBeGreaterThan(game.monthIndex);
        // Главная цель критическая только на сложном уровне.
        expect(phaseA.find((o) => o.role === 'main')!.critical).toBe(difficulty === 'hard');
      }
    }
    // Разные карты — разные регионы.
    expect(archetypes.size).toBeGreaterThanOrEqual(2);
  });

  it('не выдаёт заданий с недоступными грузами: и на старте, и на этапах B и C', () => {
    for (const seed of [5, 42, 99, 314]) {
      const game = new Game(scenario(seed));
      const sc = game.scenario!;
      for (const o of sc.state.objectives) checkObjective(game, o);
      skipPhase(sc);
      expect(sc.state.phase).toBe(1);
      for (const o of sc.state.objectives.filter((x) => x.phase === 1)) checkObjective(game, o);
      skipPhase(sc);
      expect(sc.state.phase).toBe(2);
      const phaseC = sc.state.objectives.filter((x) => x.phase === 2);
      expect(phaseC.some((o) => o.role === 'main')).toBe(true);
      for (const o of phaseC) checkObjective(game, o);
    }
  });

  it('проверка выполнимости отсекает невозможное', () => {
    const game = new Game(scenario(42));
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    const town = game.towns[0];
    // Комбинат не принимает доски, город не растёт в 10 раз за год, 100 000 зерна регион не даст.
    expect(assess(game, { kind: 'deliver', cargo: 'planks', amount: 10, to: refOf(plant) }, 12).ok).toBe(false);
    expect(assess(game, { kind: 'population', town: town.id, amount: town.population * 10 }, 12).ok).toBe(false);
    expect(assess(game, { kind: 'deliver', cargo: 'grain', amount: 100_000, to: refOf(plant) }, 12).ok).toBe(false);
    expect(assess(game, { kind: 'industry', industry: plant.id, level: 4 }, 6).ok).toBe(false);
    expect(assess(game, { kind: 'deliver', cargo: 'grain', amount: 50, to: refOf(plant) }, 12).ok).toBe(true);
  });

  it('один и тот же seed — та же карта и тот же сценарий; генератор сценария не зависит от остальных случайностей', () => {
    const a = new Game(scenario(2024));
    const b = new Game(scenario(2024));
    expect(b.settings).toEqual(a.settings);
    expect(b.towns.map((t) => [t.name, t.population])).toEqual(a.towns.map((t) => [t.name, t.population]));
    expect(b.money).toBe(a.money);
    expect(b.scenario!.state).toEqual(a.scenario!.state);
    // Игровой генератор ушёл вперёд (жители, пассажиры) — сценарий на той же карте всё равно тот же.
    for (let i = 0; i < 1000; i++) b.rng.next();
    const again = Scenario.create(b);
    expect(again.state.objectives.map((o) => o.params)).toEqual(a.scenario!.state.objectives.map((o) => o.params));
    // Другие seed — другие регионы или другие цели.
    const others = [7, 8, 9].map((seed) => new Game(scenario(seed)).scenario!.state);
    const distinct = new Set(others.map((s) => `${s.archetype}|${s.objectives.map((o) => o.title).join(';')}`));
    expect(distinct.size).toBe(3);
  });

  it('песочница работает без сценария, и её карта та же, что до сценариев', () => {
    const game = new Game(1);
    expect(game.scenario).toBeNull();
    expect(game.mods).toBe(NO_MODS);
    expect(game.settings.scenario).toBeUndefined();
    // Население городов seed 1 — генерация песочницы не зависит от сценариев (числа — с улицами как у настоящих городов).
    expect(game.towns.map((t) => t.population).sort((x, y) => y - x)).toEqual([12768, 9580, 4344, 3818, 3604, 3058, 2532, 2362, 2142, 2118]);
    // Прежние 32 предприятия — те же, предприятия новых цепочек расставлены после них.
    expect(game.industries).toHaveLength(41);
    expect(game.industries.slice(32).map((i) => i.info.kind)).toEqual(['ranch', 'ranch', 'ranch', 'sandpit', 'sandpit', 'meatplant', 'glassworks', 'furniture', 'cement']);
    expect(game.loanMax).toBe(1_000_000);
    runMonths(game, 1);
    expect(game.monthIndex).toBe(1);
    expect(game.toSave().scenario).toBeUndefined();
  });
});

describe('Сценарий: задания по реальной симуляции', { timeout: 180_000 }, () => {
  it('поставка засчитывается фактической доставкой, а не постройкой; выполненный контракт платит награду', () => {
    // Трасса — своя сеть в стороне от городов: машины жителей на неё не попадают, без них счёт в разы быстрее.
    const game = withoutCitizens(new Game(scenario(42)));
    const sc = game.scenario!;
    game.money = 5_000_000;
    const supplies = game.industries
      .filter((i) => i.info.kind === 'farm')
      .flatMap((f) => game.industries.filter((i) => i.info.kind === 'foodplant').map((p) => ({ f, p, d: dist(f.fp.center, p.fp.center) })))
      .sort((x, y) => x.d - y.d);
    const { f, p } = supplies[0];
    const order = sc.addObjective(
      { kind: 'deliver', cargo: 'grain', amount: 30, to: refOf(p) },
      { role: 'contract', phase: null, months: 12, why: 'тест', reward: { money: 77_000 } },
    );
    const sA = stationAtIndustry(game, f, p.fp.center)!;
    const sB = stationAtIndustry(game, p, f.fp.center)!;
    expect(connect(game, sA, sB, { cls: 'highway', lanes: twoWay(1, 1) })).toBe(true);
    const line = game.createLine([sA.id, sB.id])!;
    for (let i = 0; i < 3; i++) game.buyVehicle(line.id, 'truck');
    // Построено всё, но ничего не довезли — прогресса нет.
    runMonths(game, 0.05);
    expect(order.progress).toBe(0);
    expect(order.status).toBe('active');
    const grants = () => game.history.reduce((s, m) => s + (m.ledger?.grants ?? 0), 0) + (game.ledger.grants ?? 0);
    // Ждём первую доставку: прогресс равен тому, что действительно выгрузили на комбинате.
    runMonths(game, 6, () => sc.state.stats.to[`industry:${p.id}:grain`] > 0);
    const delivered = sc.state.stats.to[`industry:${p.id}:grain`];
    expect(delivered).toBeGreaterThan(0);
    expect(line.revenueTotal).toBeGreaterThan(0);
    runMonths(game, 0.05);
    expect(order.progress).toBe(Math.min(order.target, sc.state.stats.to[`industry:${p.id}:grain`]));
    // Довозим до цели — задание выполнено, награда пришла отдельной статьёй.
    runMonths(game, 10, () => order.status === 'done');
    expect(order.status).toBe('done');
    expect(grants()).toBeGreaterThanOrEqual(77_000);
  });

  it('дедлайны идут по единому игровому времени при любой скорости', () => {
    for (const speed of [1, 4]) {
      // Сроки — по игровому времени, жители ни при чём: месяц без их машин.
      const game = withoutCitizens(new Game(scenario(42)));
      const sc = game.scenario!;
      const o = sc.addObjective(
        { kind: 'passengers', amount: 1_000_000, towns: null },
        { role: 'contract', phase: null, months: 1, why: 'тест', reward: {}, fail: { money: 5000 } },
      );
      expect(o.deadline).toBe(1);
      game.speed = speed;
      // Чуть меньше месяца игрового времени — задание ещё идёт, сколько бы кадров ни прошло.
      while (game.time < MONTH_LENGTH - 1) game.update(0.05);
      expect(o.status).toBe('active');
      expect(sc.monthsLeft(o)!).toBeLessThan(0.1);
      while (game.time < MONTH_LENGTH + 0.5) game.update(0.05);
      // Срок вышел — просрочка: ещё 2 месяца (не меньше LATE.min) можно доделать, штрафа пока нет.
      expect(o.status).toBe('active');
      expect(o.lateUntil).toBe(1 + 2);
      expect(game.ledger.fines).toBe(0);
      expect(sc.secondsLeft(o)).toBeCloseTo(3 * MONTH_LENGTH - game.time, 5);
      // Не успели и к концу просрочки — провал; штраф — в начале месяца конца просрочки, в его статьях.
      setMonth(game, o.lateUntil! - 1);
      sc.monthEnd();
      expect(o.status).toBe('failed');
      expect(o.closedAt).toBe(2);
      expect(game.ledger.fines).toBe(5000);
    }
  });

  it('главная цель не выполнена — «последний шанс», провал и его — конец сценария с оценкой', () => {
    const game = new Game(scenario(42));
    const sc = game.scenario!;
    const main = sc.state.objectives.find((o) => o.role === 'main')!;
    setMonth(game, main.deadline! - 1);
    sc.monthEnd();
    expect(main.status).toBe('failed');
    const retry = sc.state.objectives.find((o) => o.retryOf === main.id)!;
    expect(retry.critical).toBe(true);
    expect(sc.running).toBe(true);
    setMonth(game, retry.deadline! - 1);
    sc.monthEnd();
    expect(sc.state.status).toBe('lost');
    expect(sc.state.score!.won).toBe(false);
    // Шесть показателей и седьмой — быстрые сроки, если они были у заданий.
    const fast = sc.state.objectives.some((o) => o.fast !== undefined);
    expect(sc.state.score!.parts.map((p) => p.id)).toEqual(['objectives', 'contracts', 'deadlines', ...(fast ? ['fast'] : []), 'finance', 'quality', 'region']);
  });
});

describe('Сценарий: экономические события', { timeout: 120_000 }, () => {
  it('события меняют состояние мира: мощность, производство, рост, потребности, цены — и эффекты истекают', () => {
    const game = new Game(scenario(42));
    const sc = game.scenario!;
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    farm.level = 4;
    const rate = game.industryRate(farm);
    const exp = forceEvent(sc, 'expansion', refOf(farm))!;
    expect(exp).toBeTruthy();
    expect(farm.cap).toBe(5);
    expect(farm.level).toBe(4.5);
    expect(game.mods.industry(farm.id)).toBeCloseTo(1.2);
    expect(game.industryRate(farm)).toBeGreaterThan(rate * 1.3);

    const town = game.towns.find((t) => t.demands.length < 4)!;
    const needs = town.demands.length;
    forceEvent(sc, 'boom', refOf(town));
    expect(game.mods.growth(town.id)).toBeGreaterThanOrEqual(1.8);
    expect(game.mods.pax(town.id)).toBeCloseTo(1.3);
    expect(town.demands.length).toBe(needs + 1);

    forceEvent(sc, 'demand', null, 'food');
    expect(game.mods.price('food')).toBeCloseTo(1.3);

    // Лесопилка без своего задания: на занятую заданием контракт на восстановление не выдают.
    const open = (o: Objective) => o.status === 'active' || o.status === 'offered';
    const tasked = (id: number) =>
      sc.state.objectives.some((o) => open(o) && ((o.params.kind === 'deliver' && o.params.to?.type === 'industry' && o.params.to.id === id) || (o.params.kind === 'industry' && o.params.industry === id)));
    const plant = game.industries.find((i) => i.info.kind === 'sawmill' && !tasked(i.id))!;
    plant.level = 2;
    const dec = forceEvent(sc, 'decline', refOf(plant))!;
    expect(plant.level).toBe(1.5);
    expect(game.mods.industry(plant.id)).toBeCloseTo(0.6);
    // Контракт на восстановление: выполнили — спад снят и уровень вернулся.
    const fix = sc.objective(dec.contract!)!;
    expect(fix.reward.clear).toBe(dec.id);
    sc.accept(fix.id);
    sc.onDelivered('logs', fix.target, refOf(plant), 1);
    sc.tick(1);
    expect(fix.status).toBe('done');
    expect(game.mods.industry(plant.id)).toBe(1);
    expect(plant.level).toBe(2);

    // Временные эффекты кончаются: через полгода цены и производство — как были.
    setMonth(game, 7);
    sc.monthEnd();
    expect(game.mods.price('food')).toBe(1);
    expect(game.mods.industry(farm.id)).toBe(1);
    // А рост мощности остаётся — он часть экономики, а не временный эффект.
    expect(farm.cap).toBe(5);
  });

  it('цепочка: дефицит → контракт выполнен → завод расширяется → заказ на сырьё и развитие города', () => {
    const game = new Game(scenario(42));
    const sc = game.scenario!;
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    const town = game.towns.reduce((best, t) => (dist(t.center, plant.fp.center) < dist(best.center, plant.fp.center) ? t : best));
    const short = forceEvent(sc, 'shortage', refOf(plant))!;
    expect(short).toBeTruthy();
    const contract = sc.objective(short.contract!)!;
    expect(contract.status).toBe('offered');
    expect(sc.accept(contract.id)).toBe(true);
    sc.onDelivered('grain', contract.target, refOf(plant), 1.2);
    sc.tick(1);
    expect(contract.status).toBe('done');
    // В конце месяца — расширение, выросшее из дефицита.
    sc.monthEnd();
    const expansion = sc.state.events.find((e) => e.type === 'expansion')!;
    expect(expansion).toBeTruthy();
    expect(expansion.parent).toBe(short.id);
    expect(plant.cap).toBe(5);
    // Дальше по цепочке: заказ на сырьё для завода и развитие ближайшего города.
    expect(sc.state.queue.some((q) => q.event === 'order' && q.subject?.id === plant.id && q.cargo === 'grain')).toBe(true);
    expect(sc.state.queue.some((q) => q.event === 'boom' && q.subject?.id === town.id)).toBe(true);
    setMonth(game, 2);
    sc.monthEnd();
    const order = sc.state.events.find((e) => e.type === 'order' && e.parent === expansion.id);
    expect(order).toBeTruthy();
    expect(sc.objective(order!.contract!)!.params).toMatchObject({ kind: 'deliver', cargo: 'grain', to: refOf(plant) });
  });

  it('отказ от контракта — другой путь: завод сокращает выпуск, регион теряет активность', () => {
    const game = new Game(scenario(42));
    const sc = game.scenario!;
    const plant = game.industries.find((i) => i.info.kind === 'sawmill')!;
    plant.level = 2;
    const short = forceEvent(sc, 'shortage', refOf(plant))!;
    const rep = sc.state.reputation;
    expect(sc.decline(short.contract!)).toBe(true);
    expect(sc.state.reputation).toBeLessThan(rep);
    sc.monthEnd();
    const decline = sc.state.events.find((e) => e.type === 'decline')!;
    expect(decline.parent).toBe(short.id);
    expect(plant.level).toBe(1.5);
    expect(game.mods.industry(plant.id)).toBeLessThan(1);
  });

  it('события не повторяются бесконечно: память, паузы, предел активных и предел роста', () => {
    const game = new Game(scenario(42));
    const sc = game.scenario!;
    sc.state.phase = 1;
    const fired: { type: string; key: string; month: number }[] = [];
    for (let m = 0; m < 120; m++) {
      setMonth(game, m);
      // Причины держим всё время: заводы простаивают, склады ломятся, предприятия на пределе.
      for (const i of game.industries) {
        sc.state.watch[i.id] = { low: 5, idle: 5, active: true };
        if (i.info.accepts.length) {
          i.level = Math.max(i.level ?? 1, 2);
          for (const c of i.info.accepts) i.stock[c] = 400;
        } else {
          i.level = i.cap ?? 4;
          i.streak = 3;
          i.producedLast = 100;
        }
      }
      const before = sc.state.events.length;
      const active = activeEvents(sc, m);
      runEvents(sc);
      for (const e of sc.state.events.slice(before)) {
        fired.push({ type: e.type, key: e.key!, month: m });
        // Новое случайное событие — только если активных меньше предела.
        expect(active).toBeLessThan(sc.difficulty.maxActive);
      }
      // Не больше одного случайного события за месяц.
      expect(sc.state.events.length - before).toBeLessThanOrEqual(1);
    }
    // Даже когда причины есть всегда, события случаются не каждый месяц.
    expect(fired.length).toBeGreaterThan(3);
    expect(fired.length).toBeLessThan(120 * 0.8);
    // То же событие с тем же предприятием — не чаще, чем раз в EVENT_RULES.memory месяцев.
    const last = new Map<string, number>();
    for (const f of fired) {
      const prev = last.get(f.key);
      if (prev !== undefined) expect(f.month - prev).toBeGreaterThanOrEqual(EVENT_RULES.memory);
      last.set(f.key, f.month);
    }
    // Крупные события — с паузой.
    const majors = fired.filter((f) => EVENT_INFO[f.type as keyof typeof EVENT_INFO].importance === 'major');
    for (let i = 1; i < majors.length; i++) expect(majors[i].month - majors[i - 1].month).toBeGreaterThanOrEqual(EVENT_RULES.majorGap);
    // Предел роста предприятий не уходит в бесконечность.
    for (const i of game.industries) expect(i.cap ?? 4).toBeLessThanOrEqual(6);
  });
});

describe('Сценарий: сохранение', { timeout: 120_000 }, () => {
  it('сохранение и загрузка не сбрасывают задания, прогресс, сроки, эффекты, историю и генератор', () => {
    // Состояние сценария от машин жителей не зависит: полмесяца — без них.
    const game = withoutCitizens(new Game(scenario(42)));
    const sc = game.scenario!;
    const offer = sc.offers[0];
    expect(offer).toBeTruthy();
    sc.accept(offer.id);
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    forceEvent(sc, 'expansion', refOf(plant));
    sc.onPassengers(game.towns[0].id, game.towns[1].id, 25, 1.1);
    runMonths(game, 0.6);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(save.settings, save);
    const a = game.scenario!.toSave();
    const b = loaded.scenario!.toSave();
    expect(b).toEqual(a);
    expect(b.objectives.find((o) => o.id === offer.id)!.status).toBe('active');
    expect(b.effects.length).toBeGreaterThan(0);
    expect(loaded.mods.industry(plant.id)).toBeCloseTo(game.mods.industry(plant.id));
    expect(industryById(loaded, plant.id)!.cap).toBe(5);
    expect(loaded.scenario!.monthsLeft(loaded.scenario!.objective(offer.id)!)).toBeCloseTo(sc.monthsLeft(offer)!);
    expect(loaded.scenario!.rng.seedState).toBe(sc.rng.seedState);
    expect(loaded.loanMax).toBe(game.loanMax);
  });
});
