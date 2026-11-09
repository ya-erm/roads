/**
 * Сценарий текущей партии: свой генератор случайных чисел, задания этапов и контракты, эффекты событий,
 * счётчики перевозок, победа и поражение. Игра сообщает о доставках и конце месяца, сценарий отвечает
 * множителями экономики (mods), деньгами наград и штрафов и новыми заданиями.
 */
import { ECONOMY, MONTH_LENGTH, TERM_SCALE } from '../config';
import { Rng } from '../core/rng';
import { durationText } from '../core/timeText';
import type { Game } from '../game/game';
import type { ModelTier } from '../game/transport';
import type { CargoType } from '../world/cargo';
import { industryById, levelCap, network, operating } from './analysis';
import { CHALLENGE_BONUS, DIFFICULTY, EVENT_RULES, FAST, LATE, PHASES, POINTS, REPUTATION } from './content';
import { EconomyMods, modsOf } from './effects';
import { runEvents } from './events';
import { assess } from './feasibility';
import { type Forecast, forecastOf, haulOf, outlookOf } from './forecast';
import { extraObjectives, fastMonths, generatePhase, startScenario } from './generator';
import { baseOf, isMonthly, liveProgress, makerKey, monthOk, pairKey, receiverKey, targetOf, titleOf } from './objectives';
import { computeScore } from './score';
import type {
  Consequence,
  Effect,
  EffectSpec,
  EventRecord,
  LogEntry,
  Objective,
  ObjectiveParams,
  ObjectiveRole,
  Ref,
  Reward,
  ScenarioState,
} from './types';

export interface ObjectiveOptions {
  role: ObjectiveRole;
  phase: number | null;
  why: string;
  /** Срок, месяцев от сейчас (для контракта — после принятия). */
  months: number | null;
  reward: Reward;
  fail?: Consequence;
  related?: Ref[];
  source?: string;
  critical?: boolean;
  /** Контракт ждёт решения игрока. */
  offer?: boolean;
  points?: number;
  title?: string;
  /**
   * Быстрый срок: false — без него (последняя попытка); число — через столько месяцев (прежний срок, к которому
   * «Со строительством» добавлен запас на стройку); нет — прикидка generator.fastMonths.
   */
  fast?: false | number;
}

/** Хеш seed для своего генератора: посторонние изменения игры не сдвигают случайности сценария. */
export function mixSeed(seed: number, salt: number): number {
  let h = (seed ^ salt) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export const SCENARIO_SALT = 0x85ebca6b;

/** Надбавка за быстрый срок: доля денег задания, до тысяч. */
export const fastBonus = (o: Objective) => Math.round(((o.reward.money ?? 0) * FAST.money) / 1000) * 1000;

/**
 * Сколько месяцев можно доделывать задание после срока (content.LATE): половина исходного срока, не меньше 2 мин.
 * Без просрочки — null: главная цель (у неё «последний шанс»), критические, сам «последний шанс», без срока и
 * дополнительные после победы.
 */
export function lateMonths(o: Objective): number | null {
  if (o.critical || o.retryOf || o.role === 'main' || o.role === 'extra') return null;
  // Исходный срок: от начала до дедлайна; у предложения контракта — сколько дадут после принятия.
  const span = o.deadline === null ? o.months : o.started !== undefined ? o.deadline - o.started : (o.months ?? o.deadline - o.created);
  return span === undefined ? null : Math.max(LATE.min, Math.ceil(span * LATE.share));
}

/** Награда за выполненное с опозданием: деньги и репутация — доля LATE.reward (деньги — до сотен), остальное — как было. */
export function lateReward(o: Objective): Reward {
  const r = o.reward;
  return {
    ...r,
    money: r.money ? Math.round((r.money * LATE.reward) / 100) * 100 : r.money,
    reputation: r.reputation ? Math.round(r.reputation * LATE.reward) : r.reputation,
  };
}

/** Просрочено: срок вышел, но ещё можно выполнить с меньшей наградой. */
export const isOverdue = (o: Objective) => o.status === 'active' && o.lateUntil !== undefined;

/** Столько месяцев подряд за пределом кредита — и компания банкрот (4 мин; после первого — предупреждение). */
const BANKRUPT_MONTHS = 2 * TERM_SCALE;
/** Задание без срока проверяем на выполнимость за столько месяцев (48 мин). */
const NO_TERM = 24 * TERM_SCALE;
/** Сколько месяцев итогов помнит сценарий (для оценки и заданий новых этапов). */
const STATS_MONTHS = 120 * TERM_SCALE;

export class Scenario {
  readonly rng: Rng;
  readonly mods: EconomyMods;
  /** Секунды до следующей проверки прогресса. */
  private clock = 0;
  /** Идут итоги месяца (monthEnd). */
  private ending = false;
  /** Прогнозы заданий на эту секунду игры и этот парк: шкала меняется не чаще раза в секунду, а не каждый кадр. */
  private forecasts = { at: '', map: new Map<string, Forecast | null>() };

  private constructor(
    readonly game: Game,
    public state: ScenarioState,
  ) {
    this.rng = new Rng(0);
    this.rng.seedState = state.rng;
    this.mods = modsOf(() => this.state.effects);
  }

  /** Новый сценарий на только что созданной карте: архетип по карте, стартовые условия и задания этапа A. */
  static create(game: Game): Scenario {
    const settings = game.settings.scenario!;
    const state: ScenarioState = {
      version: 1,
      settings,
      archetype: settings.archetype ?? 'mixed',
      brief: { region: '', text: '', capital: 0, loan: 0, loanMax: 0, months: 0, facts: [] },
      status: 'running',
      phase: 0,
      phaseStart: game.monthIndex,
      startMonth: game.monthIndex,
      rng: mixSeed(game.seed, SCENARIO_SALT),
      nextId: 1,
      objectives: [],
      events: [],
      effects: [],
      queue: [],
      memory: {},
      lastMajor: -99,
      lastMinor: -99,
      stats: { delivered: {}, to: {}, pax: 0, between: {}, units: 0, speedSum: 0, months: [] },
      watch: {},
      start: { population: 0, levels: 0 },
      reputation: REPUTATION.start,
      bankrupt: 0,
      log: [],
    };
    const sc = new Scenario(game, state);
    startScenario(sc);
    sc.state.rng = sc.rng.seedState;
    const b = sc.state.brief;
    game.journal.add('scenario', {
      archetype: sc.state.archetype,
      planned: settings.archetype !== sc.state.archetype ? settings.archetype : undefined,
      difficulty: settings.difficulty,
      challenge: settings.challenge || undefined,
      capital: b.capital,
      loan: b.loan,
      loanMax: b.loanMax,
      facts: b.facts,
    });
    return sc;
  }

  static restore(game: Game, save: ScenarioState): Scenario {
    return new Scenario(game, structuredClone(save));
  }

  toSave(): ScenarioState {
    this.state.rng = this.rng.seedState;
    return structuredClone(this.state);
  }

  /**
   * Названия идущих месячных заданий — заново по их условиям: после пересчёта старой партии под нынешний месяц
   * (game/monthPace.ts) условие месяца и «N месяцев подряд» другие. «Последний шанс: …» остаётся последним шансом.
   */
  retitle(): void {
    for (const o of this.state.objectives) {
      if ((o.status !== 'active' && o.status !== 'offered') || !isMonthly(o.params)) continue;
      o.title = `${o.retryOf ? 'Последний шанс: ' : ''}${titleOf(o.params, this.game)}`;
    }
  }

  // ---------- Сводка ----------

  get month(): number {
    return this.game.monthIndex;
  }

  /**
   * Месяц, который сейчас идёт, — от него сроки новых заданий. В итогах месяца (monthEnd) счётчик игры ещё
   * на закончившемся месяце, а задания, выданные там (новый этап, контракты событий), начинаются со следующего:
   * иначе они теряли бы месяц срока.
   */
  get today(): number {
    return this.ending ? this.month + 1 : this.month;
  }

  /** Сейчас, в месяцах игры с долей: с этого момента — «новое» (маршруты этапа). В итогах месяца — ровно его конец. */
  get moment(): number {
    return this.ending ? this.month + 1 : this.game.time / MONTH_LENGTH;
  }

  get difficulty() {
    return DIFFICULTY[this.state.settings.difficulty];
  }

  /** Испытание: время не останавливается. */
  get challenge(): boolean {
    return this.state.settings.challenge && this.state.status === 'running';
  }

  get running(): boolean {
    return this.state.status === 'running';
  }

  get loanMax(): number {
    return this.state.brief.loanMax || ECONOMY.loanMax;
  }

  get phaseInfo() {
    return PHASES[this.state.phase];
  }

  /** Множитель итоговой оценки. */
  get multiplier(): number {
    return this.difficulty.score * (this.state.settings.challenge ? CHALLENGE_BONUS : 1);
  }

  /** Задания текущего этапа и принятые контракты — то, что видно игроку. */
  get current(): Objective[] {
    return this.state.objectives.filter((o) => o.status === 'active');
  }

  /** Контракты, ждущие решения. */
  get offers(): Objective[] {
    return this.state.objectives.filter((o) => o.status === 'offered');
  }

  objective(id: string): Objective | undefined {
    return this.state.objectives.find((o) => o.id === id);
  }

  /** Сколько месяцев осталось (дробно), null — без срока. */
  monthsLeft(o: Objective): number | null {
    const left = this.secondsLeft(o);
    return left === null ? null : left / MONTH_LENGTH;
  }

  /**
   * Сколько секунд игры осталось до срока задания (у предложения — до конца предложения, у просроченного — до конца
   * просрочки), null — без срока.
   */
  secondsLeft(o: Objective): number | null {
    const until = o.status === 'offered' ? o.offerUntil : (o.lateUntil ?? o.deadline);
    if (until === undefined || until === null) return null;
    return Math.max(0, until * MONTH_LENGTH - this.game.time);
  }

  /** Сколько секунд игры осталось до быстрого срока; его нет или прошёл — null. */
  fastLeft(o: Objective): number | null {
    if (o.fast === undefined) return null;
    const left = o.fast * MONTH_LENGTH - this.game.time;
    return left > 0 ? left : null;
  }

  /**
   * Прогноз к сроку у накопительного задания (перевезти груз или пассажиров): что довезут машины линий по
   * расписанию прибытий до срока, но не больше, чем есть что везти (scenario/forecast.ts). Без срока или без
   * прогноза по виду задания — null. Пересчитывается раз в секунду игры.
   */
  forecast(o: Objective): Forecast | null {
    if (o.status !== 'active' || !this.running || o.deadline === null || this.blocked(o)) return null;
    const haul = haulOf(o.params);
    if (!haul) return null;
    // Новая секунда, купили или продали машину, построили маршрут (и на паузе) — пересчёт.
    const at = `${Math.floor(this.game.time)}:${this.game.fleet.size}:${this.game.lines.size}`;
    if (this.forecasts.at !== at) this.forecasts = { at, map: new Map() };
    const key = `${o.id}:${o.progress}`;
    if (!this.forecasts.map.has(key)) {
      const left = Math.max(0, (o.lateUntil ?? o.deadline) * MONTH_LENGTH - this.game.time);
      this.forecasts.map.set(key, forecastOf(o.progress, o.target, outlookOf(this.game, haul, left)));
    }
    return this.forecasts.map.get(key) ?? null;
  }

  /** Главная цель этапа выполнена — можно перейти дальше, не дожидаясь остальных целей. */
  get canAdvance(): boolean {
    return this.running && this.phaseMain()?.status === 'done';
  }

  private phaseMain(): Objective | undefined {
    const mains = this.state.objectives.filter((o) => o.phase === this.state.phase && o.role === 'main');
    return mains[mains.length - 1];
  }

  // ---------- Сообщения игры ----------

  /** Груз выгружен получателю (receiver — кто его принял, maker — предприятие, откуда его везли). */
  onDelivered(cargo: CargoType, amount: number, receiver: Ref | null, speed: number, maker?: number): void {
    const s = this.state.stats;
    s.delivered[cargo] = (s.delivered[cargo] ?? 0) + amount;
    if (receiver) s.to[receiverKey(receiver, cargo)] = (s.to[receiverKey(receiver, cargo)] ?? 0) + amount;
    if (maker !== undefined) {
      const from = (s.from ??= {});
      from[makerKey(maker, cargo)] = (from[makerKey(maker, cargo)] ?? 0) + amount;
    }
    s.units += amount;
    s.speedSum += amount * speed;
  }

  /** Пассажиры доехали: из города from в город to (если станции в городах). */
  onPassengers(from: number | undefined, to: number | undefined, count: number, speed: number): void {
    const s = this.state.stats;
    s.pax += count;
    if (from !== undefined && to !== undefined && from !== to) s.between[pairKey(from, to)] = (s.between[pairKey(from, to)] ?? 0) + count;
    s.units += count;
    s.paxUnits = (s.paxUnits ?? 0) + count;
    s.speedSum += count * speed;
  }

  /** Раз в секунду игрового времени — прогресс накопительных заданий: выполнено — сразу награда. */
  tick(dt: number): void {
    if (!this.running && !this.afterWin) return;
    this.clock -= dt;
    if (this.clock > 0) return;
    this.clock = 1;
    // Пройденный сценарий из старого сохранения: дополнительные задания — сейчас.
    if (this.afterWin && !this.state.extras) this.giveExtras();
    for (const o of this.current) {
      if (this.blocked(o)) continue;
      o.progress = liveProgress(o, this.state, this.game);
      if (!isMonthly(o.params) && o.progress >= o.target) this.complete(o);
    }
  }

  /** Конец месяца (после экономики игры): месячные цели, сроки, эффекты, события, этапы и банкротство. */
  monthEnd(): void {
    this.ending = true;
    try {
      this.endMonth();
    } finally {
      this.ending = false;
    }
  }

  private endMonth(): void {
    const s = this.state;
    const now = this.today;
    this.closeMonth();
    if (!this.running) {
      // После победы идут только дополнительные задания: без сроков, событий и банкротства.
      if (this.afterWin) this.monthly();
      s.effects = s.effects.filter((e) => e.until > now);
      return;
    }
    this.monthly();
    this.tick(0);
    this.clock = 1;
    // Сроки: не выполнено к началу месяца-дедлайна — просрочка (можно доделать за меньшую награду) или провал,
    // не выполнено и к концу просрочки — провал; предложения истекают.
    for (const o of [...s.objectives]) {
      if (o.status === 'active' && o.lateUntil !== undefined) {
        if (now >= o.lateUntil) this.failObjective(o);
      } else if (o.status === 'active' && o.deadline !== null && now >= o.deadline) {
        const late = lateMonths(o);
        if (late !== null) this.overdue(o, o.deadline + late);
        else this.failObjective(o);
      } else if (o.status === 'offered' && o.offerUntil !== undefined && now >= o.offerUntil) this.decline(o.id, true);
      if (!this.running) break;
    }
    s.effects = s.effects.filter((e) => e.until > now);
    this.watchIndustries();
    if (this.running) runEvents(this);
    this.checkPhase();
    this.checkBankrupt();
    s.rng = this.rng.seedState;
  }

  /** Месячные цели: условие закрытого месяца выполнено — +1 к серии, нет — серия с нуля. */
  private monthly(): void {
    const month = this.state.stats.months[this.state.stats.months.length - 1];
    for (const o of this.current) {
      if (!isMonthly(o.params) || this.blocked(o)) continue;
      o.streak = monthOk(o.params, this.game, month) ? o.streak + 1 : 0;
      o.progress = o.streak;
      if (o.streak >= o.target) this.complete(o);
    }
  }

  /** Сценарий пройден, а партия идёт дальше — с дополнительными заданиями. */
  get afterWin(): boolean {
    return this.state.status === 'won';
  }

  /** Дополнительные задания после победы — один раз. */
  private giveExtras(): void {
    this.state.extras = true;
    extraObjectives(this);
  }

  /** Итоги месяца по перевозкам и финансам — в историю сценария. */
  private closeMonth(): void {
    const s = this.state.stats;
    const last = this.game.history[this.game.history.length - 1];
    const fin = last ? operating(last) : { income: 0, costs: 0 };
    s.months.push({ month: this.month, units: s.units, pax: s.paxUnits ?? 0, speed: s.units > 0 ? s.speedSum / s.units : 1, income: fin.income, costs: fin.costs });
    if (s.months.length > STATS_MONTHS) s.months.shift();
    s.units = 0;
    s.paxUnits = 0;
    s.speedSum = 0;
  }

  /** Наблюдение за предприятиями: сколько месяцев подряд не хватает сырья и сколько простаивают. */
  private watchIndustries(): void {
    for (const ind of this.game.industries) {
      const w = (this.state.watch[ind.id] ??= { low: 0, idle: 0, active: false });
      const rate = this.game.industryRate(ind);
      w.low = ind.info.accepts.length && ind.producedLast < rate * 0.5 ? w.low + 1 : 0;
      if (ind.producedLast > 0) {
        w.idle = 0;
        w.active = true;
      } else w.idle++;
    }
  }

  private checkBankrupt(): void {
    if (!this.running) return;
    if (this.game.money >= ECONOMY.creditLimit) {
      this.state.bankrupt = 0;
      return;
    }
    this.state.bankrupt++;
    const floor = `−$${Math.abs(ECONOMY.creditLimit).toLocaleString('ru-RU')}`;
    const span = (months: number) => durationText(months * MONTH_LENGTH);
    if (this.state.bankrupt >= BANKRUPT_MONTHS) this.lose(`Компания обанкротилась: ${span(BANKRUPT_MONTHS)} подряд на счёте меньше ${floor}`);
    else this.game.notify(`Сценарий: на счёте меньше ${floor}. Ещё ${span(BANKRUPT_MONTHS - this.state.bankrupt)} — и компания обанкротится`, '#e5534b', { kind: 'money' });
  }

  // ---------- Задания ----------

  nextId(prefix: string): string {
    return `${prefix}${this.state.nextId++}`;
  }

  /** Новое задание (или предложение контракта). Прогресс накопительных — с текущей отметки счётчика. */
  addObjective(params: ObjectiveParams, opts: ObjectiveOptions): Objective {
    const now = this.today;
    const offer = !!opts.offer;
    const fast =
      opts.months === null || opts.fast === false || opts.role === 'extra'
        ? null
        : (opts.fast ?? fastMonths(this.game, params, opts.months, this.state.settings.difficulty));
    const o: Objective = {
      id: this.nextId('o'),
      params,
      role: opts.role,
      phase: opts.phase,
      title: opts.title ?? titleOf(params, this.game),
      why: opts.why,
      critical: !!opts.critical,
      status: offer ? 'offered' : 'active',
      created: now,
      started: offer ? undefined : now,
      deadline: offer || opts.months === null ? null : now + opts.months,
      fast: !offer && fast !== null ? this.fastFrom(fast) : undefined,
      offerUntil: offer ? now + EVENT_RULES.offer : undefined,
      months: opts.months ?? undefined,
      fastMonths: offer && fast !== null ? fast : undefined,
      base: baseOf(this.state, params, this.game),
      progress: 0,
      target: targetOf(params),
      streak: 0,
      reward: opts.reward,
      fail: opts.fail ?? {},
      related: opts.related ?? [],
      source: opts.source,
      points: opts.points ?? POINTS[opts.role],
    };
    o.progress = liveProgress(o, this.state, this.game);
    this.state.objectives.push(o);
    if (offer) this.log('offer', `Предложен контракт: ${o.title}`);
    // В журнал — с оценкой выполнимого за срок: потом видно, можно ли было успеть.
    const verdict = assess(this.game, params, opts.months ?? NO_TERM);
    this.game.journal.add('obj', {
      id: o.id,
      role: o.role,
      phase: o.phase ?? undefined,
      status: o.status,
      title: o.title,
      params,
      target: o.target,
      base: o.base,
      deadline: o.deadline ?? undefined,
      fast: o.fast,
      offerUntil: o.offerUntil,
      months: o.months,
      critical: o.critical || undefined,
      $: o.reward.money,
      est: verdict.estimate,
      check: verdict.ok ? undefined : verdict.reason,
      src: o.source,
      why: o.why,
    });
    return o;
  }

  /** Быстрый срок через months месяцев от этой минуты (месяц игры с долей — прикидка идёт от начала работы). */
  private fastFrom(months: number): number {
    return Math.round((this.moment + months) * 100) / 100;
  }

  /** Задание — только если оно выполнимо (feasibility.assess); иначе null, и вызывающий ищет другое. */
  tryObjective(params: ObjectiveParams, opts: ObjectiveOptions): Objective | null {
    const verdict = assess(this.game, params, opts.months ?? NO_TERM);
    if (!verdict.ok) {
      this.game.journal.add('skip', { role: opts.role, title: titleOf(params, this.game), reason: verdict.reason, est: verdict.estimate });
      return null;
    }
    return this.addObjective(params, opts);
  }

  /** Требования задания ещё не выполнены — прогресс не идёт. */
  private blocked(o: Objective): boolean {
    return !!o.requires?.some((id) => this.objective(id)?.status !== 'done');
  }

  /** Принять контракт: срок пошёл, прогресс — с этой минуты. */
  accept(id: string): boolean {
    const o = this.objective(id);
    if (!o || o.status !== 'offered' || !this.running) return false;
    o.status = 'active';
    o.started = this.month;
    o.deadline = o.months !== undefined ? this.month + o.months : null;
    if (o.fastMonths !== undefined) o.fast = this.fastFrom(o.fastMonths);
    o.base = baseOf(this.state, o.params, this.game);
    o.progress = liveProgress(o, this.state, this.game);
    this.log('offer', `Контракт принят: ${o.title}`);
    this.game.journal.add('accept', { id: o.id, deadline: o.deadline ?? undefined, fast: o.fast, base: o.base, progress: o.progress });
    return true;
  }

  /** Отказаться от контракта (или он истёк): экономика идёт по другому пути. */
  decline(id: string, expired = false): boolean {
    const o = this.objective(id);
    if (!o || o.status !== 'offered') return false;
    o.status = 'declined';
    o.closedAt = this.month;
    this.changeReputation(REPUTATION.declined);
    // Альтернативный путь: то, что было бы при провале, кроме штрафов.
    this.apply({ effects: o.fail.effects, follow: o.fail.follow }, o.source ?? o.id);
    this.log('declined', `${expired ? 'Предложение истекло' : 'Отказ от контракта'}: ${o.title}`);
    this.game.journal.add('decline', { id: o.id, expired: expired || undefined, rep: this.state.reputation });
    return true;
  }

  private complete(o: Objective): void {
    // Просроченное — с опозданием: доля денег, репутации и очков (content.LATE), без надбавки за быстроту.
    const late = o.lateUntil !== undefined;
    const reward = late ? lateReward(o) : o.reward;
    o.status = 'done';
    o.closedAt = this.month;
    o.progress = Math.max(o.progress, o.target);
    if (late) o.late = true;
    const rep = o.role === 'main' ? REPUTATION.main : REPUTATION.done;
    this.changeReputation(late ? Math.round(rep * LATE.reward) : rep);
    this.apply(reward, o.source ?? o.id);
    // Успели к быстрому сроку — надбавка к награде (и очки за быстроту в оценке).
    const bonus = !late && o.fast !== undefined && this.game.time < o.fast * MONTH_LENGTH ? fastBonus(o) : null;
    if (bonus !== null) {
      o.quick = true;
      if (bonus > 0) this.game.grant(bonus);
    }
    this.log('done', `${late ? 'Выполнено с опозданием' : 'Выполнено'}: ${o.title}`);
    this.game.journal.add('done', {
      id: o.id,
      progress: o.progress,
      target: o.target,
      $: reward.money,
      quick: bonus ?? undefined,
      late: late || undefined,
      rep: this.state.reputation,
    });
    const money = (reward.money ?? 0) + (bonus ?? 0);
    const head = o.quick ? '⚡ Быстрее срока' : late ? '⌛ С опозданием' : '✓ Выполнено';
    this.game.notify(`${head}: ${o.title}${money ? ` · +$${money.toLocaleString('ru-RU')}` : ''}${late ? ` (−${Math.round((1 - LATE.reward) * 100)}%)` : ''}`, '#2e9d57', {
      kind: 'goal',
      refs: o.related,
    });
    if (o.phase === this.state.phase) this.checkPhase();
  }

  /**
   * Срок вышел, но задание ещё можно доделать до начала месяца until — с меньшей наградой. Последствия провала —
   * только если не успеют и к нему. Цели этапа в просрочке держат этап, как и до срока: его можно закрыть досрочно.
   */
  private overdue(o: Objective, until: number): void {
    if (until <= this.today) {
      this.failObjective(o);
      return;
    }
    o.lateUntil = until;
    const span = durationText((until - this.today) * MONTH_LENGTH);
    this.log('late', `Срок вышел: ${o.title}`);
    this.game.journal.add('late', { id: o.id, progress: o.progress, target: o.target, until });
    this.game.notify(`⌛ Срок вышел: ${o.title}. Ещё ${span} можно доделать — награда −${Math.round((1 - LATE.reward) * 100)}%`, '#c4662f', {
      kind: 'goal',
      refs: o.related,
    });
  }

  private failObjective(o: Objective): void {
    o.status = 'failed';
    o.closedAt = this.month;
    this.changeReputation(o.fail.reputation ?? (o.role === 'contract' ? REPUTATION.failed : REPUTATION.failed / 2));
    this.apply({ ...o.fail, reputation: undefined }, o.source ?? o.id, true);
    this.log('failed', `Провалено: ${o.title}`);
    this.game.journal.add('fail', { id: o.id, progress: o.progress, target: o.target, critical: o.critical || undefined, rep: this.state.reputation });
    this.game.notify(`✗ Не успели: ${o.title}`, '#e5534b', { kind: 'goal', refs: o.related });
    if (o.critical) {
      this.lose(`Критическое задание провалено: ${o.title}`);
      return;
    }
    // Главная цель этапа — ещё одна попытка, но уже критическая и с меньшей наградой.
    if (o.role === 'main' && o.phase === this.state.phase) this.retry(o);
  }

  /** Восстановительное задание взамен проваленной главной цели: остаток объёма, половина срока. */
  private retry(o: Objective): void {
    const p = { ...o.params } as ObjectiveParams;
    if (p.kind === 'deliver' || p.kind === 'passengers') p.amount = Math.max(10, Math.ceil((o.target - o.progress) / 10) * 10);
    const span = o.deadline !== null && o.started !== undefined ? o.deadline - o.started : 12 * TERM_SCALE;
    const r = this.addObjective(p, {
      role: 'main',
      phase: o.phase,
      why: 'Главная цель этапа не выполнена в срок. Это последняя попытка: провал закончит сценарий.',
      months: Math.max(2 * TERM_SCALE, Math.ceil(span * 0.5)),
      reward: { money: Math.round((o.reward.money ?? 0) / 2), reputation: 0 },
      critical: true,
      fast: false,
      points: Math.round(o.points / 2),
      related: o.related,
      title: `Последний шанс: ${titleOf(p, this.game)}`,
    });
    r.retryOf = o.id;
    o.retry = r.id;
    this.game.notify(`Последний шанс: ${titleOf(p, this.game)}`, '#e5534b', { kind: 'goal', refs: o.related });
  }

  // ---------- Награды, эффекты, репутация ----------

  /** Награда или последствия: деньги, репутация, эффекты, рост мощности, снятие спада, продолжение цепочки. */
  apply(r: Reward, source: string, penalty = false): void {
    if (r.money) {
      if (penalty) this.game.fine(r.money);
      else this.game.grant(Math.round(r.money));
    }
    if (r.reputation) this.changeReputation(r.reputation);
    for (const e of r.effects ?? []) this.addEffect(e, source);
    if (r.level) {
      const ind = industryById(this.game, r.level.industry);
      if (ind) {
        ind.cap = Math.min(6, Math.max(levelCap(ind), (ind.level ?? 1) + r.level.by));
        ind.level = Math.min(levelCap(ind), (ind.level ?? 1) + r.level.by);
      }
    }
    if (r.clear) this.state.effects = this.state.effects.filter((e) => e.source !== r.clear);
    for (const f of r.follow ?? []) this.state.queue.push({ ...f, at: this.month + 1 + f.delay, parent: source });
  }

  addEffect(spec: EffectSpec, source: string): Effect {
    const e: Effect = { ...spec, id: this.nextId('x'), until: this.month + 1 + spec.months, source };
    this.state.effects.push(e);
    return e;
  }

  changeReputation(d: number): void {
    this.state.reputation = Math.max(0, Math.min(100, this.state.reputation + d));
  }

  /** Множитель наград контрактов по репутации. */
  get rewardFactor(): number {
    const R = REPUTATION;
    return R.rewardMin + ((R.rewardMax - R.rewardMin) * this.state.reputation) / 100;
  }

  log(kind: LogEntry['kind'], text: string): void {
    this.state.log.push({ month: this.month, kind, text });
    if (this.state.log.length > 200) this.state.log.shift();
  }

  /** Записать событие: память против повторов, паузы между событиями, журнал и уведомление. */
  addEvent(e: Omit<EventRecord, 'id' | 'month'>, memoryKey: string): EventRecord {
    const rec: EventRecord = { ...e, id: this.nextId('e'), month: this.month, key: memoryKey };
    this.state.events.push(rec);
    if (this.state.events.length > 80) this.state.events.shift();
    this.state.memory[memoryKey] = this.month;
    if (e.importance === 'major') this.state.lastMajor = this.month;
    else this.state.lastMinor = this.month;
    this.log('event', `${e.title}: ${e.cause}`);
    this.game.journal.add('event', {
      id: rec.id,
      type: e.type,
      title: e.title,
      cause: e.cause,
      effects: e.effects,
      related: e.related.map((r) => `${r.type}:${r.id}`),
      parent: e.parent,
      key: memoryKey,
    });
    this.game.notify(`${e.title}. ${e.cause}`, e.importance === 'major' ? '#c4662f' : '#4a8fe7', { kind: 'event', refs: e.related });
    return rec;
  }

  // ---------- Этапы, победа, поражение ----------

  /**
   * Этап завершён, когда главная цель выполнена, а остальные цели этапа закрыты (выполнены или провалены).
   * После этапа C — победа.
   */
  private checkPhase(): void {
    if (!this.running) return;
    const s = this.state;
    const main = this.phaseMain();
    if (main?.status !== 'done') return;
    const open = s.objectives.some((o) => o.phase === s.phase && o.status === 'active');
    if (!open) this.nextPhase();
  }

  /** Перейти к следующему этапу досрочно: незакрытые цели этапа засчитываются как невыполненные. */
  advancePhase(): boolean {
    if (!this.canAdvance) return false;
    const dropped: string[] = [];
    for (const o of this.state.objectives) {
      if (o.phase !== this.state.phase || o.status !== 'active') continue;
      o.status = 'failed';
      o.closedAt = this.month;
      dropped.push(o.id);
    }
    this.game.journal.add('advance', { phase: this.state.phase, dropped });
    this.nextPhase();
    return true;
  }

  private nextPhase(): void {
    const s = this.state;
    if (s.phase >= PHASES.length - 1) {
      this.win();
      return;
    }
    s.phase++;
    s.phaseStart = this.today;
    // Из чего строится следующий этап: сеть игрока и его лучшие месяцы — до заданий этапа.
    const info = network(this.game);
    this.game.journal.add('phase', {
      phase: 'ABC'[s.phase],
      net: { towns: [...info.towns], inds: [...info.industries], stations: info.stations.length, pax$: info.pax, freight$: info.freight },
      best: Math.max(0, ...s.stats.months.slice(-6).map((m) => m.units)),
      months: s.stats.months.slice(-6).map((m) => [m.units, m.pax ?? 0, m.speed]),
    });
    generatePhase(this, s.phase);
    this.log('phase', `Этап ${'ABC'[s.phase]}: ${PHASES[s.phase].name}`);
    this.game.notify(`Новый этап: ${PHASES[s.phase].name}. ${PHASES[s.phase].hint}`, '#7a5cc4', { kind: 'goal' });
    // Каждый этап открывает следующую ступень транспорта: B — Грузовик II и Автобус II, C — Фура и Автобус III.
    this.game.openModelTier(Math.min(3, s.phase + 1) as ModelTier);
  }

  private win(): void {
    this.state.status = 'won';
    this.finish();
    this.log('phase', 'Сценарий пройден');
    this.game.notify(`Сценарий пройден! ${this.state.score!.total} очков`, '#2e9d57', { kind: 'goal' });
    // Оценка уже посчитана — дополнительные задания на неё не влияют.
    this.giveExtras();
    const extras = this.current.length;
    if (extras) this.game.notify(`Дополнительные задания: ${extras} — без сроков, за деньги`, '#7a5cc4', { kind: 'goal' });
  }

  lose(reason: string): void {
    if (!this.running) return;
    this.state.status = 'lost';
    this.state.lostReason = reason;
    this.finish();
    this.log('failed', `Сценарий провален: ${reason}`);
    this.game.notify(`Сценарий провален: ${reason}`, '#e5534b', { kind: 'goal' });
  }

  /**
   * Конец сценария: незакрытые цели этапов — невыполненные, а предложения и контракты, которые ещё шли, просто
   * снимаются (их срок не вышел — в оценке они не считаются сорванными; просроченные — сорваны). Считается оценка.
   */
  private finish(): void {
    for (const o of this.state.objectives) {
      if (o.status === 'offered' || (o.status === 'active' && o.role === 'contract' && o.lateUntil === undefined)) o.status = 'declined';
      if (o.status === 'active') o.status = 'failed';
      if (o.closedAt === undefined && o.status !== 'done') o.closedAt = this.month;
    }
    this.state.score = computeScore(this);
    this.state.seen = false;
    const score = this.state.score;
    this.game.journal.add('end', {
      status: this.state.status,
      reason: this.state.lostReason,
      score: score.total,
      medal: score.medal ?? undefined,
      parts: score.parts.map((p) => [p.id, p.value, p.max, p.note]),
    });
  }
}
