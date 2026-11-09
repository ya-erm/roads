import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { Game, type SaveData } from '../game/game';
import { freshGame, withoutCitizens } from '../game/testkit';
import { DEFAULT_SETTINGS } from '../world/settings';
import { LATE, POINTS, REPUTATION } from './content';
import { lateMonths, lateReward, type Scenario } from './manager';
import type { Difficulty, Objective } from './types';

/** Партия-сценарий без предложений контрактов: их истечение не меняет репутацию посреди проверки. */
function newGame(difficulty: Difficulty = 'normal'): Game {
  const game = withoutCitizens(freshGame({ ...DEFAULT_SETTINGS, seed: 42, scenario: { difficulty, challenge: false } }));
  for (const o of game.scenario!.offers) game.scenario!.decline(o.id);
  return game;
}

/** Номер месяца игры напрямую — чтобы прогнать месячную логику сценария без долгой симуляции движения. */
function setMonth(game: Game, month: number): void {
  (game as unknown as { month: number }).month = month;
  game.time = month * MONTH_LENGTH;
}

/** Итоги месяца, после которых начинается месяц month (сроки сверяются с его началом). */
function endMonthBefore(game: Game, month: number): void {
  setMonth(game, month - 1);
  game.scenario!.monthEnd();
}

/** Цель «перевезти пассажиров» — её выполнение легко подстроить счётчиком сценария. */
function paxGoal(sc: Scenario, months: number, extra: Partial<Parameters<Scenario['addObjective']>[1]> = {}): Objective {
  return sc.addObjective(
    { kind: 'passengers', amount: 100, towns: null },
    { role: 'goal', phase: null, months, why: 'тест', reward: { money: 40_000, reputation: 4 }, fail: { money: 5000, reputation: -7 }, ...extra },
  );
}

/** Довезти пассажиров цели и проверить прогресс (раз в секунду игры). */
function finish(sc: Scenario): void {
  sc.onPassengers(undefined, undefined, 100, 1);
  sc.tick(1);
}

describe('Просроченное задание: можно выполнить с опозданием за меньшую награду', { timeout: 120_000 }, () => {
  it('срок вышел — просрочка на половину срока (не меньше 2 мин), без штрафа; выполнили — половина денег, репутации и очков, без надбавки ⚡', () => {
    const game = newGame();
    const sc = game.scenario!;
    const o = paxGoal(sc, 8, { fast: 2 });
    expect(lateMonths(o)).toBe(4);
    expect(lateMonths({ ...o, deadline: o.started! + 1 })).toBe(LATE.min);

    endMonthBefore(game, o.deadline!);
    expect(o.status).toBe('active');
    expect(o.lateUntil).toBe(o.deadline! + 4);
    expect(game.ledger.fines).toBe(0);
    expect(sc.state.log.at(-1)!.kind).toBe('late');
    expect(game.journal.entries.some((e) => e.k === 'late' && e.id === o.id && e.until === o.lateUntil)).toBe(true);
    // Остаток времени — до конца просрочки.
    expect(sc.secondsLeft(o)).toBeCloseTo(o.lateUntil! * MONTH_LENGTH - game.time, 5);

    const money = game.money;
    const rep = sc.state.reputation;
    finish(sc);
    expect(o.status).toBe('done');
    expect(o.late).toBe(true);
    expect(o.quick).toBeUndefined();
    expect(lateReward(o)).toMatchObject({ money: 20_000, reputation: 2 });
    expect(game.money - money).toBe(20_000);
    expect(sc.state.reputation - rep).toBe(Math.round(REPUTATION.done * LATE.reward) + 2);
    expect(game.journal.entries.some((e) => e.k === 'done' && e.id === o.id && e.late === true && e.$ === 20_000)).toBe(true);
  });

  it('не успели и в просрочку — провал со штрафом и всеми последствиями', () => {
    const game = newGame();
    const sc = game.scenario!;
    const o = paxGoal(sc, 4);
    endMonthBefore(game, o.deadline!);
    expect(o.lateUntil).toBe(o.deadline! + 2);
    const rep = sc.state.reputation;
    endMonthBefore(game, o.lateUntil! - 1);
    expect(o.status).toBe('active');
    endMonthBefore(game, o.lateUntil!);
    expect(o.status).toBe('failed');
    expect(o.late).toBeUndefined();
    expect(game.ledger.fines).toBe(5000);
    expect(sc.state.reputation).toBe(rep - 7);
  });

  it('главная цель — «последний шанс», критическое — сразу провал: у них просрочки нет', () => {
    const game = newGame();
    const sc = game.scenario!;
    const main = sc.state.objectives.find((o) => o.role === 'main')!;
    expect(lateMonths(main)).toBeNull();
    endMonthBefore(game, main.deadline!);
    expect(main.status).toBe('failed');
    expect(main.lateUntil).toBeUndefined();
    const retry = sc.state.objectives.find((o) => o.retryOf === main.id)!;
    expect(lateMonths(retry)).toBeNull();
    // Другие цели этапа A с тем же сроком — в просрочке.
    for (const o of sc.state.objectives.filter((x) => x.phase === 0 && x.role === 'goal' && x.deadline === main.deadline)) {
      expect(o.status).toBe('active');
      expect(o.lateUntil).toBeGreaterThan(o.deadline!);
    }

    const hard = newGame('hard');
    const crit = paxGoal(hard.scenario!, 4, { critical: true });
    expect(lateMonths(crit)).toBeNull();
    endMonthBefore(hard, crit.deadline!);
    expect(crit.status).toBe('failed');
    expect(hard.scenario!.state.status).toBe('lost');
  });

  it('цель этапа в просрочке держит этап, пока её не выполнят; выполнили — этап закрывается', () => {
    const game = newGame();
    const sc = game.scenario!;
    const phaseA = sc.state.objectives.filter((o) => o.phase === 0 && o.status === 'active');
    const goal = paxGoal(sc, 4, { phase: 0 });
    for (const o of phaseA) {
      o.status = 'done';
      o.closedAt = 0;
    }
    endMonthBefore(game, goal.deadline!);
    expect(goal.lateUntil).toBeDefined();
    expect(sc.state.phase).toBe(0);
    expect(sc.canAdvance).toBe(true);
    finish(sc);
    expect(goal.status).toBe('done');
    expect(goal.late).toBe(true);
    expect(sc.state.phase).toBe(1);
  });

  it('оценка: цель с опозданием — половина очков; просроченный контракт в конце сценария — сорван', () => {
    const game = newGame();
    const sc = game.scenario!;
    const goal = paxGoal(sc, 4, { phase: 0, points: POINTS.goal });
    const contract = sc.addObjective(
      { kind: 'passengers', amount: 10_000_000, towns: null },
      { role: 'contract', phase: null, months: 4, offer: true, why: 'тест', reward: { money: 30_000 } },
    );
    // Предложение: просрочка — от срока после принятия.
    expect(lateMonths(contract)).toBe(2);
    expect(sc.accept(contract.id)).toBe(true);
    endMonthBefore(game, goal.deadline!);
    expect(contract.lateUntil).toBeDefined();
    finish(sc);
    expect(goal.late).toBe(true);
    sc.lose('тест');
    expect(contract.status).toBe('failed');
    const part = (id: string) => sc.state.score!.parts.find((p) => p.id === id)!;
    expect(part('contracts').note).toContain('сорвано 1');
    expect(part('objectives').note).toContain('с опозданием 1');
    // Выполнена только эта цель, и с опозданием — половина её очков от возможных.
    const possible = sc.state.objectives.filter((o) => (o.role === 'main' || o.role === 'goal') && !o.retryOf).reduce((s, o) => s + o.points, 0);
    expect(sc.state.objectives.filter((o) => o.status === 'done')).toEqual([goal]);
    expect(part('objectives').value).toBe(Math.round((400 * POINTS.goal * LATE.points) / possible));
  });

  it('контракт с опозданием в оценке — 15 очков вместо 30', () => {
    const game = newGame();
    const sc = game.scenario!;
    const c =sc.addObjective({ kind: 'passengers', amount: 100, towns: null }, { role: 'contract', phase: null, months: 4, why: 'тест', reward: { money: 30_000 } });
    endMonthBefore(game, c.deadline!);
    finish(sc);
    expect(c.late).toBe(true);
    sc.lose('тест');
    expect(sc.state.score!.parts.find((p) => p.id === 'contracts')!.value).toBe(15);
  });

  it('просрочка сохраняется с партией; старое сохранение без неё открывается как прежде', () => {
    const game = newGame();
    const sc = game.scenario!;
    const o = paxGoal(sc, 4);
    endMonthBefore(game, o.deadline!);
    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    const loaded = withoutCitizens(new Game(save.settings, save));
    const back = loaded.scenario!.objective(o.id)!;
    expect(back.lateUntil).toBe(o.lateUntil);
    expect(loaded.scenario!.secondsLeft(back)).toBeCloseTo(sc.secondsLeft(o)!, 5);

    // Старое сохранение: задание в сроке, полей просрочки нет — срок выйдет, и оно уйдёт в просрочку.
    const fresh = newGame();
    const g = paxGoal(fresh.scenario!, 4);
    const old = JSON.parse(JSON.stringify(fresh.toSave())) as SaveData;
    const raw = old.scenario!.objectives.find((x) => x.id === g.id)!;
    expect('lateUntil' in raw).toBe(false);
    const reopened = withoutCitizens(new Game(old.settings, old));
    const r = reopened.scenario!.objective(g.id)!;
    endMonthBefore(reopened, r.deadline!);
    expect(r.status).toBe('active');
    expect(r.lateUntil).toBe(r.deadline! + 2);
  });
});
