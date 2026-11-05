/**
 * Система заданий: тексты, прогресс и проверка выполнения — по реальному состоянию симуляции
 * (доставки, производство, население, финансы месяца), а не по факту постройки.
 */
import type { Game } from '../game/game';
import { CARGO, type CargoType } from '../world/cargo';
import { TOWN_NEED, type Town } from '../world/entities';
import { connected, industryById, newRoutesCarried, operating, refName, townById } from './analysis';
import type { MonthStat, Objective, ObjectiveParams, Ref, ScenarioState } from './types';

/** Ключ пары городов: меньший id первым. */
export const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
export const receiverKey = (ref: Ref, cargo: string) => `${ref.type}:${ref.id}:${cargo}`;
export const makerKey = (industry: number, cargo: string) => `${industry}:${cargo}`;

const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
export const moneyText = (n: number) => `$${fmt(n)}`;
const monthsText = (n: number) => `${n} ${n === 1 ? 'месяц' : n < 5 ? 'месяца' : 'месяцев'}`;
/** «1 новый город», «2 новых города», «5 новых предприятий». */
function newPlaces(n: number, what: 'town' | 'industry'): string {
  const d = n % 10;
  const dd = n % 100;
  const one = d === 1 && dd !== 11;
  const few = d >= 2 && d <= 4 && (dd < 12 || dd > 14);
  const noun = what === 'town' ? (one ? 'город' : few ? 'города' : 'городов') : one ? 'предприятие' : few ? 'предприятия' : 'предприятий';
  return `${fmt(n)} ${one ? (what === 'town' ? 'новый' : 'новое') : 'новых'} ${noun}`;
}

/** Сколько городов или предприятий подключено к сети сверх тех, что были в ней, когда задание появилось. */
function newlyConnected(game: Game, p: Extract<ObjectiveParams, { kind: 'connect' }>): number {
  const now = connected(game)[p.what === 'town' ? 'towns' : 'industries'];
  const known = new Set(p.known);
  let n = 0;
  for (const id of now) if (!known.has(id)) n++;
  return n;
}
const inRow = (n: number) => (n > 1 ? `, ${monthsText(n)} подряд` : '');

/** Сколько потребностей города надо закрыть: needs, а в старых заданиях — все. */
export function supplyNeeds(p: Extract<ObjectiveParams, { kind: 'supply' }>, t: Town): number {
  return Math.min(p.needs ?? t.demands.length, t.demands.length);
}

/** Сколько потребностей города закрыто: за прошлый месяц (last) или уже за этот. */
export function closedNeeds(t: Town, month: 'last' | 'current' = 'last'): CargoType[] {
  const got = month === 'last' ? t.lastSupplied : t.supplied;
  return t.demands.filter((c) => (got[c] ?? 0) >= TOWN_NEED);
}

/**
 * Отметка на старте задания: накопительный счётчик (доставки, пассажиры), население города для роста;
 * у остальных — 0.
 */
export function baseOf(s: ScenarioState, p: ObjectiveParams, game: Game): number {
  if (p.kind === 'population') return townById(game, p.town)?.population ?? 0;
  return counterOf(s, p);
}

/** Накопительный счётчик задания (доставки, пассажиры); у остальных — 0. */
export function counterOf(s: ScenarioState, p: ObjectiveParams): number {
  if (p.kind === 'deliver') {
    if (p.to) return s.stats.to[receiverKey(p.to, p.cargo)] ?? 0;
    if (p.from !== undefined) return s.stats.from?.[makerKey(p.from, p.cargo)] ?? 0;
    return s.stats.delivered[p.cargo] ?? 0;
  }
  if (p.kind === 'passengers') return p.towns ? (s.stats.between[pairKey(p.towns[0], p.towns[1])] ?? 0) : s.stats.pax;
  return 0;
}

/** Цель задания в его единицах: объём, уровень, жители или месяцы подряд. */
export function targetOf(p: ObjectiveParams): number {
  switch (p.kind) {
    case 'deliver':
    case 'passengers':
    case 'population':
    case 'connect':
      return p.amount;
    case 'industry':
      return p.level;
    default:
      return p.months;
  }
}

/** Задание держится по месяцам (выполняется в конце месяца), а не по накоплению. */
export const isMonthly = (p: ObjectiveParams) =>
  p.kind === 'profit' || p.kind === 'supply' || p.kind === 'quality' || p.kind === 'throughput' || p.kind === 'newRoutes';

/** Текущий прогресс в единицах цели. */
export function liveProgress(o: Objective, s: ScenarioState, game: Game): number {
  const p = o.params;
  switch (p.kind) {
    case 'deliver':
    case 'passengers':
      return Math.max(0, counterOf(s, p) - o.base);
    case 'industry':
      return industryById(game, p.industry)?.level ?? 1;
    case 'population':
      return townById(game, p.town)?.population ?? 0;
    case 'connect':
      return newlyConnected(game, p);
    default:
      return o.streak;
  }
}

/** Выполнено ли месячное условие в только что закрытом месяце. */
export function monthOk(p: ObjectiveParams, game: Game, month: MonthStat): boolean {
  switch (p.kind) {
    case 'profit': {
      const last = game.history[game.history.length - 1];
      return !!last && operating(last).profit >= p.amount;
    }
    case 'supply': {
      const t = townById(game, p.town);
      return !!t && t.demands.length > 0 && closedNeeds(t).length >= supplyNeeds(p, t);
    }
    case 'quality':
      return month.units >= p.volume && month.speed >= p.speed;
    case 'throughput':
      return month.units >= p.amount && month.income > 0 && month.costs <= p.costRatio * month.income;
    case 'newRoutes':
      return newRoutesCarried(game, p.since) >= p.amount;
    default:
      return false;
  }
}

/** Значение месячного показателя закрытого месяца — для подсказки «сейчас …». */
export function monthValue(p: ObjectiveParams, game: Game, month: MonthStat | undefined): string | null {
  if (!month) return null;
  switch (p.kind) {
    case 'profit': {
      const last = game.history[game.history.length - 1];
      return last ? `в прошлом месяце ${moneyText(operating(last).profit)}` : null;
    }
    case 'supply': {
      const t = townById(game, p.town);
      if (!t) return null;
      return `в прошлом месяце закрыто ${closedNeeds(t).length} из ${t.demands.length}`;
    }
    case 'quality':
      return `в прошлом месяце ×${month.speed.toFixed(2)} при объёме ${fmt(month.units)}`;
    case 'throughput': {
      const ratio = month.income > 0 ? Math.round((month.costs / month.income) * 100) : null;
      return `в прошлом месяце ${fmt(month.units)}${ratio !== null ? `, расходы ${ratio}% выручки` : ''}`;
    }
    case 'newRoutes':
      return `в прошлом месяце ${fmt(newRoutesCarried(game, p.since))} ед. на новых маршрутах`;
    default:
      return null;
  }
}

/** Название задания для игрока. */
export function titleOf(p: ObjectiveParams, game: Game): string {
  switch (p.kind) {
    case 'deliver': {
      const what = `${fmt(p.amount)} ед. «${CARGO[p.cargo].name}»`;
      if (!p.to && p.from !== undefined) return `Вывезти ${what}: ${industryById(game, p.from)?.name ?? '—'} → получателям`;
      if (!p.to) return `Доставить ${what} получателям`;
      return p.to.type === 'town' ? `Привезти ${what} в город ${refName(game, p.to)}` : `Доставить ${what}: ${refName(game, p.to)}`;
    }
    case 'passengers':
      return p.towns
        ? `Перевезти ${fmt(p.amount)} пассажиров между городами ${townById(game, p.towns[0])?.name ?? '—'} и ${townById(game, p.towns[1])?.name ?? '—'}`
        : `Перевезти ${fmt(p.amount)} пассажиров`;
    case 'profit':
      return `Операционная прибыль от ${moneyText(p.amount)} в месяц${inRow(p.months)}`;
    case 'supply': {
      const t = townById(game, p.town);
      const total = t?.demands.length ?? 0;
      if (p.needs === undefined || p.needs >= total) return `Снабжать город ${t?.name ?? '—'} всем необходимым${inRow(p.months)}`;
      return `Снабжать город ${t?.name ?? '—'}: закрыть ${p.needs} из ${total} потребностей${inRow(p.months)}`;
    }
    case 'industry':
      return `Довести производство: ${industryById(game, p.industry)?.name ?? '—'} — до ×${p.level}`;
    case 'population':
      return `Город ${townById(game, p.town)?.name ?? '—'} вырос до ${fmt(p.amount)} жителей`;
    case 'quality':
      return `Быстрая доставка: надбавка за скорость от ×${p.speed} при ${fmt(p.volume)} ед. в месяц${inRow(p.months)}`;
    case 'throughput':
      return `Перевозить от ${fmt(p.amount)} ед. в месяц при расходах не больше ${Math.round(p.costRatio * 100)}% выручки${inRow(p.months)}`;
    case 'newRoutes':
      return `Новые маршруты этапа: перевозить от ${fmt(p.amount)} ед. в месяц${inRow(p.months)}`;
    case 'connect':
      return `Подключить к сети ${newPlaces(p.amount, p.what)}`;
  }
}

/** Прогресс для полоски: «120 / 300», «×1.75 / ×2.5», «1 / 3 мес.». */
export function progressText(o: Objective): string {
  const p = o.params;
  if (p.kind === 'industry') return `×${o.progress.toFixed(2).replace(/\.?0+$/, '')} / ×${p.level}`;
  if (isMonthly(p)) return `${o.progress} / ${o.target} мес.`;
  return `${fmt(Math.min(o.progress, o.target))} / ${fmt(o.target)}`;
}

/** Доля выполнения 0…1. Уровень предприятия считается от 1. */
export function fraction(o: Objective): number {
  if (o.status === 'done') return 1;
  if (o.params.kind === 'industry') return Math.max(0, Math.min(1, (o.progress - 1) / Math.max(0.01, o.target - 1)));
  // Население — от того, сколько было, когда задание появилось.
  if (o.params.kind === 'population') return Math.max(0, Math.min(1, (o.progress - o.base) / Math.max(1, o.target - o.base)));
  return Math.max(0, Math.min(1, o.progress / Math.max(1, o.target)));
}

/** Награда текстом: «$80 000 · репутация +6 · производство растёт». */
export function rewardText(o: Objective): string {
  const r = o.reward;
  const parts: string[] = [];
  if (r.money) parts.push(moneyText(r.money));
  if (r.level) parts.push('рост производства');
  if (r.clear) parts.push('спад прекратится');
  if (r.effects?.length) parts.push('развитие региона');
  if (r.reputation) parts.push(`репутация +${r.reputation}`);
  return parts.join(' · ') || '—';
}

/** Последствия провала текстом. */
export function failText(o: Objective): string {
  const f = o.fail;
  const parts: string[] = [];
  if (o.critical) parts.push('сценарий будет провален');
  if (f.money) parts.push(`штраф ${moneyText(f.money)}`);
  if (f.reputation) parts.push(`репутация ${f.reputation}`);
  if (f.follow?.length) parts.push('экономика региона ухудшится');
  if (f.effects?.length) parts.push('спад в регионе');
  if (!o.critical && o.role !== 'contract') parts.push('меньше очков');
  return parts.join(' · ') || 'награда не будет получена';
}
