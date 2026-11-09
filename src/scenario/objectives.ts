/**
 * Система заданий: тексты, прогресс и проверка выполнения — по реальному состоянию симуляции
 * (доставки, производство, население, финансы месяца), а не по факту постройки.
 */
import { ENTERPRISE } from '../config';
import type { Game } from '../game/game';
import { CARGO, type CargoType, INDUSTRY_TYPES } from '../world/cargo';
import { isActive, townGap } from '../world/enterprise';
import type { Industry, Town } from '../world/entities';
import { monthTownNeed, townNeed } from '../world/townSupply';
import { connected, industryById, newRoutesCarried, operating, refName, townById } from './analysis';
import type { MonthStat, Objective, ObjectiveParams, Ref, ScenarioState, ScenarioStats } from './types';

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

/**
 * Новые предприятия задания «построить»: не из known, достроенные и работающие, с нужной продукцией и у нужного
 * города (не дальше, чем доходят рабочие, ENTERPRISE.commute.far от его черты).
 */
export function builtFor(game: Game, p: Extract<ObjectiveParams, { kind: 'build' }>): Industry[] {
  const known = new Set(p.known);
  const town = p.town !== undefined ? townById(game, p.town) : undefined;
  return game.industries.filter(
    (i) =>
      !known.has(i.id) &&
      isActive(i) &&
      (!p.what || i.info.kind === p.what) &&
      (!p.cargo || i.info.produces === p.cargo) &&
      (p.town === undefined || (!!town && townGap(town, i.fp) < ENTERPRISE.commute.far)),
  );
}

/** Прогресс задания «построить»: сколько новых построено или (produce) сколько они выпустили. */
function buildProgress(game: Game, p: Extract<ObjectiveParams, { kind: 'build' }>): number {
  const list = builtFor(game, p);
  return p.produce ? list.reduce((s, i) => s + (i.made ?? 0), 0) : list.length;
}

/** Сколько потребностей города надо закрыть: needs, а в старых заданиях — все. */
export function supplyNeeds(p: Extract<ObjectiveParams, { kind: 'supply' }>, t: Town): number {
  return Math.min(p.needs ?? t.demands.length, t.demands.length);
}

/** Сколько потребностей города закрыто: за прошлый месяц (last) или уже за этот. */
export function closedNeeds(t: Town, month: 'last' | 'current' = 'last'): CargoType[] {
  const got = month === 'last' ? t.lastSupplied : t.supplied;
  const need = monthTownNeed(t, month);
  return t.demands.filter((c) => (got[c] ?? 0) >= need);
}

/** Чьи счётчики перевозок: сценария или заданий без сроков (scenario/ideas.ts) — у обоих одинаковые. */
export type Counters = Pick<ScenarioState, 'stats'>;

/** Груз выгружен получателю (receiver — кто принял, maker — предприятие, откуда везли): в счётчики. */
export function countDelivery(s: ScenarioStats, cargo: CargoType, amount: number, receiver: Ref | null, speed: number, maker?: number): void {
  s.delivered[cargo] = (s.delivered[cargo] ?? 0) + amount;
  if (receiver) s.to[receiverKey(receiver, cargo)] = (s.to[receiverKey(receiver, cargo)] ?? 0) + amount;
  if (maker !== undefined) {
    const from = (s.from ??= {});
    from[makerKey(maker, cargo)] = (from[makerKey(maker, cargo)] ?? 0) + amount;
  }
  s.units += amount;
  s.speedSum += amount * speed;
}

/** Пассажиры доехали из города from в город to (если станции в городах): в счётчики. */
export function countPassengers(s: ScenarioStats, from: number | undefined, to: number | undefined, count: number, speed: number): void {
  s.pax += count;
  if (from !== undefined && to !== undefined && from !== to) s.between[pairKey(from, to)] = (s.between[pairKey(from, to)] ?? 0) + count;
  s.units += count;
  s.paxUnits = (s.paxUnits ?? 0) + count;
  s.speedSum += count * speed;
}

/**
 * Отметка на старте задания: накопительный счётчик (доставки, пассажиры), население города для роста;
 * у остальных — 0.
 */
export function baseOf(s: Counters, p: ObjectiveParams, game: Game): number {
  if (p.kind === 'population') return townById(game, p.town)?.population ?? 0;
  return counterOf(s, p);
}

/** Накопительный счётчик задания (доставки, пассажиры); у остальных — 0. */
export function counterOf(s: Counters, p: ObjectiveParams): number {
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
    case 'build':
      return p.produce ?? p.count;
    default:
      return p.months;
  }
}

/** Задание держится по месяцам (выполняется в конце месяца), а не по накоплению. */
export const isMonthly = (p: ObjectiveParams) =>
  p.kind === 'profit' || p.kind === 'supply' || p.kind === 'quality' || p.kind === 'throughput' || p.kind === 'newRoutes';

/** Текущий прогресс в единицах цели. */
export function liveProgress(o: Pick<Objective, 'params' | 'base' | 'streak'>, s: Counters, game: Game): number {
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
    case 'build':
      return buildProgress(game, p);
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

/**
 * Месячное задание в текущем месяце — то же, что проверится в его конце (monthOk): засчитывается
 * календарный месяц, поэтому и шкала — по нему, а не по скользящим 30 дням.
 */
export interface MonthNow {
  /** Перевезено в этом месяце: груз и пассажиры. */
  units: number;
  /** Средняя надбавка за скорость по объёму; доставок нет — 1. */
  speed: number;
  /** Выручка перевозок и расходы (содержание транспорта, ремонт дорог, проценты) за этот месяц. */
  income: number;
  costs: number;
  /** Перевезли в этом месяце маршруты этапа (newRoutes). */
  newRoutes: number;
  /** Снабжение города (supply): закрыто потребностей, сколько нужно закрыть, доля привезённого 0…1. */
  closed: number;
  needs: number;
  supplied: number;
}

/**
 * Шкала месячного задания: какая доля условия месяца уже набрана, подпись «312 / 470 ед.» и второе условие,
 * если оно есть (расходы у «перевозить при расходах», объём у «быстрой доставки») — с отметкой, выполнено ли.
 */
export interface MonthGauge {
  fraction: number;
  text: string;
  extra?: { text: string; ok: boolean };
}

const share = (v: number, target: number) => Math.max(0, Math.min(1, v / Math.max(1, target)));
const signedMoney = (n: number) => (n < 0 ? `−${moneyText(-n)}` : moneyText(n));

/** Шкала месячного задания по показателю текущего месяца; у остальных заданий — null. */
export function monthGauge(p: ObjectiveParams, now: MonthNow): MonthGauge | null {
  switch (p.kind) {
    case 'throughput': {
      const ratio = now.income > 0 ? now.costs / now.income : null;
      return {
        fraction: share(now.units, p.amount),
        text: `${fmt(now.units)} / ${fmt(p.amount)} ед.`,
        extra: ratio !== null ? { text: `расходы ${Math.round(ratio * 100)}% / ${Math.round(p.costRatio * 100)}%`, ok: ratio <= p.costRatio } : undefined,
      };
    }
    case 'newRoutes':
      return { fraction: share(now.newRoutes, p.amount), text: `${fmt(now.newRoutes)} / ${fmt(p.amount)} ед.` };
    case 'quality': {
      // Нужны оба условия — шкала по тому, что дальше от цели.
      const speed = Math.max(0, Math.min(1, (now.speed - 1) / Math.max(0.01, p.speed - 1)));
      return {
        fraction: Math.min(speed, share(now.units, p.volume)),
        text: `×${now.speed.toFixed(2)} / ×${p.speed}`,
        extra: { text: `${fmt(now.units)} / ${fmt(p.volume)} ед.`, ok: now.units >= p.volume },
      };
    }
    case 'profit': {
      const profit = now.income - now.costs;
      return { fraction: share(profit, p.amount), text: `${signedMoney(profit)} / ${moneyText(p.amount)}` };
    }
    case 'supply':
      return { fraction: Math.max(0, Math.min(1, now.supplied)), text: `закрыто ${now.closed} / ${now.needs}` };
    default:
      return null;
  }
}

/** Показатели текущего месяца для шкалы месячного задания (monthGauge). */
export function monthNow(game: Game, s: ScenarioState, p: ObjectiveParams): MonthNow {
  const st = s.stats;
  const fin = operating({ ledger: game.ledger });
  const now: MonthNow = { units: st.units, speed: st.units > 0 ? st.speedSum / st.units : 1, income: fin.income, costs: fin.costs, newRoutes: 0, closed: 0, needs: 0, supplied: 0 };
  if (p.kind === 'newRoutes') now.newRoutes = newRoutesCarried(game, p.since, 'current');
  if (p.kind === 'supply') {
    const t = townById(game, p.town);
    if (t?.demands.length) {
      now.needs = supplyNeeds(p, t);
      now.closed = closedNeeds(t, 'current').length;
      // Доля — по самым близким к норме потребностям: сколько из нужных уже привезли.
      const need = townNeed(t.population);
      const parts = t.demands.map((c) => Math.min(1, (t.supplied[c] ?? 0) / need)).sort((a, b) => b - a);
      now.supplied = parts.slice(0, now.needs).reduce((a, b) => a + b, 0) / Math.max(1, now.needs);
    }
  }
  return now;
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
    case 'build': {
      // «Построить пищевой комбинат у Берёзовки и выпустить 200 ед. «Продукты»», «Построить 2 новых предприятия».
      const named = p.what ? INDUSTRY_TYPES[p.what].name.toLowerCase() : null;
      const what = named
        ? p.count === 1
          ? named
          : `${fmt(p.count)} × ${named}`
        : p.cargo
          ? `${newPlaces(p.count, 'industry').replace(/^1 /, '')} с продукцией «${CARGO[p.cargo].name}»`
          : newPlaces(p.count, 'industry');
      const where = p.town !== undefined ? ` у города ${townById(game, p.town)?.name ?? '—'}` : '';
      const made = p.produce && p.cargo ? ` и выпустить ${fmt(p.produce)} ед. «${CARGO[p.cargo].name}»` : '';
      return `Построить ${what}${where}${made}`;
    }
  }
}

/** Прогресс для полоски: «120 / 300», «×1.75 / ×2.5», «1 / 3 мес.». */
export function progressText(o: Pick<Objective, 'params' | 'progress' | 'target'>): string {
  const p = o.params;
  if (p.kind === 'industry') return `×${o.progress.toFixed(2).replace(/\.?0+$/, '')} / ×${p.level}`;
  if (isMonthly(p)) return `${o.progress} / ${o.target} мес.`;
  return `${fmt(Math.min(o.progress, o.target))} / ${fmt(o.target)}`;
}

/** Доля выполнения 0…1. Уровень предприятия считается от 1. */
export function fraction(o: Pick<Objective, 'params' | 'progress' | 'target' | 'base' | 'status'>): number {
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
