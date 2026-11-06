/**
 * Длина месяца партии в сохранении и пересчёт старых партий под нынешнюю (MONTH_LENGTH).
 *
 * Сохранение помнит длину своего месяца (SaveData.monthLength); в старых её нет — тогда это 120 с (а в самых
 * старых — 40 с: такую узнаём по тому, что номер месяца совпадает с временем партии при 40-секундном месяце).
 * Пересчёт сохраняет дату и реальное время:
 * - календарь тот же: время партии сжимается во столько же, во сколько короче месяц, — номер месяца и доля
 *   прошедшего месяца прежние; отметки времени машин и линий сдвигаются вместе с ним (сколько прошло — столько же);
 * - месячные суммы текущего и прошлого месяца (доходы, выпуск, снабжение, перевезено, условия месячных
 *   заданий) — в нынешних месяцах, как MONTH_SCALE у норм;
 * - сроки, которые ещё идут (дедлайны, предложения, эффекты, события и продолжения цепочек), — те же минуты
 *   от сегодняшнего месяца; сроки и серии в месяцах («месяцы подряд», рост предприятий) — в нынешних месяцах;
 * - модели транспорта выходят по реальному времени: реального времени прошло больше, чем показывает календарь
 *   при нынешнем месяце, — на столько месяцев раньше (SaveData.paceShift, Game.modelYear).
 * Прошлое (история по месяцам, журнал, кадры таймлапса, закрытые задания) не трогаем: это месяцы календаря.
 */
import { MONTH_LENGTH } from '../config';
import { durationText } from '../core/timeText';
import type { EffectSpec, Objective, ObjectiveParams, Reward, ScenarioState } from '../scenario/types';
import type { SaveData } from './game';

/** Длины месяца сохранений без SaveData.monthLength: 120 с, а до того — 40 с. */
const LEGACY_LENGTHS = [120, 40];

/** Длина месяца, с которой сохранена партия. */
export function saveMonthLength(save: Pick<SaveData, 'time' | 'month' | 'monthLength'>): number {
  if (save.monthLength) return save.monthLength;
  return LEGACY_LENGTHS.find((len) => Math.floor(save.time / len + 1e-9) === save.month) ?? LEGACY_LENGTHS[0];
}

/** Месячное задание: условие на каждый месяц и серия «N месяцев подряд». */
const MONTHLY = new Set<ObjectiveParams['kind']>(['profit', 'supply', 'quality', 'throughput', 'newRoutes']);

const round10 = (n: number) => Math.max(10, Math.round(n / 10) * 10);

/**
 * Сохранение под нынешнюю длину месяца. Уже такое — возвращается как есть; иначе — пересчитанная копия
 * (журнал и кадры таймлапса — те же массивы: в них месяцы календаря, они не меняются).
 */
export function repaceSave(save: SaveData): SaveData {
  const from = saveMonthLength(save);
  if (from === MONTH_LENGTH) return save.monthLength === MONTH_LENGTH ? save : { ...save, monthLength: MONTH_LENGTH };
  const { journal, timelapse, ...rest } = save;
  const s: SaveData = { ...structuredClone(rest), journal, timelapse, monthLength: MONTH_LENGTH };
  /** Секунды и месячные суммы: месяц короче (меньше) во столько раз. */
  const k = MONTH_LENGTH / from;
  /** Сроки в месяцах: их больше во столько раз. */
  const r = from / MONTH_LENGTH;
  const time = save.time * k;
  /** Отметка времени (секунды игры) — столько же секунд назад, сколько было. */
  const at = (t: number | undefined) => (t === undefined ? t : t + time - save.time);
  const sum = (n: number) => n * k;
  s.time = time;
  // Реального времени прошло больше, чем месяцев нынешнего темпа в календаре: модели выходят по реальному времени.
  s.paceShift = Math.max(0, Math.round(((save.paceShift ?? 0) * r + (save.time / from) * (r - 1)) * 100) / 100) || undefined;
  // Выручка перевозок месяца — за месяц вдвое короче; стройка, покупки, продажи, награды — разовые, как были
  // (содержание, ремонт и проценты списываются в конце месяца — в идущем месяце их ещё нет).
  if (s.ledger) {
    const transport = s.ledger.transport;
    s.ledger.transport = sum(transport);
    s.incomeMonth -= transport - s.ledger.transport;
  }
  for (const line of s.lines) {
    line.revenueMonth = sum(line.revenueMonth);
    line.costMonth = sum(line.costMonth);
    line.carriedMonth = Math.round(sum(line.carriedMonth));
    line.revenueLast = sum(line.revenueLast);
    line.costLast = sum(line.costLast);
    line.carriedLast = Math.round(sum(line.carriedLast));
    line.departedAt = at(line.departedAt);
    line.statsFrom = at(line.statsFrom);
    if (line.auto?.sell !== undefined) line.auto.sell = at(line.auto.sell);
  }
  for (const v of s.fleet) {
    v.loadedTime = at(v.loadedTime);
    v.lapAt = at(v.lapAt);
    v.holdFrom = at(v.holdFrom);
    v.holdUntil = at(v.holdUntil);
    for (const g of v.passengers) g.at = at(g.at);
    v.profitMonth = sum(v.profitMonth);
    v.profitLast = sum(v.profitLast);
  }
  for (const ind of s.industries) {
    ind.producedMonth = Math.round(sum(ind.producedMonth));
    ind.producedLast = Math.round(sum(ind.producedLast));
    if (ind.piledMonth !== undefined) ind.piledMonth *= k;
    if (ind.streak !== undefined) ind.streak = Math.round(ind.streak * r);
  }
  const amounts = (o: Partial<Record<string, number>>) => {
    for (const c of Object.keys(o)) o[c] = Math.round(sum(o[c] ?? 0));
  };
  for (const t of s.towns) {
    amounts(t.supplied);
    amounts(t.lastSupplied);
  }
  if (s.scenario) repaceScenario(s.scenario, { month: s.month, now: time / MONTH_LENGTH, from, k, r });
  return s;
}

interface Pace {
  /** Номер текущего месяца и сейчас — в месяцах с долей. */
  month: number;
  now: number;
  /** Прежняя длина месяца, с. */
  from: number;
  k: number;
  r: number;
}

/** Состояние сценария под нынешнюю длину месяца (см. repaceSave). */
function repaceScenario(sc: ScenarioState, p: Pace): void {
  const { month, now, k, r } = p;
  const months = (n: number) => Math.max(1, Math.round(n * r));
  /** Срок впереди (номер месяца) — те же минуты от сегодняшнего месяца; прошедший — как был. */
  const ahead = (m: number) => (m > month ? month + Math.round((m - month) * r) : m);
  const text = (s: string) => minutesText(s, p.from);
  for (const o of sc.objectives) {
    if (o.status !== 'active' && o.status !== 'offered') continue;
    if (o.deadline !== null) o.deadline = ahead(o.deadline);
    if (o.offerUntil !== undefined) o.offerUntil = ahead(o.offerUntil);
    if (o.fast !== undefined && o.fast > now) o.fast = Math.round((now + (o.fast - now) * r) * 100) / 100;
    if (o.months !== undefined) o.months = months(o.months);
    if (o.fastMonths !== undefined) o.fastMonths = months(o.fastMonths);
    repaceParams(o, k, r);
    repaceReward(o.reward, r);
    repaceReward(o.fail, r);
    o.why = text(o.why);
  }
  for (const e of sc.effects) {
    e.until = ahead(e.until);
    e.months = months(e.months);
  }
  for (const e of sc.events) {
    e.until = ahead(e.until);
    e.cause = text(e.cause);
    e.effects = e.effects.map(text);
  }
  for (const q of sc.queue) {
    q.at = ahead(q.at);
    q.delay = Math.round(q.delay * r);
  }
  sc.brief.months = Math.round(sc.brief.months * r);
  for (const w of Object.values(sc.watch)) {
    w.low = Math.round(w.low * r);
    w.idle = Math.round(w.idle * r);
  }
  sc.bankrupt = Math.round(sc.bankrupt * r);
  const st = sc.stats;
  st.units *= k;
  if (st.paxUnits !== undefined) st.paxUnits *= k;
  st.speedSum *= k;
  for (const m of st.months) {
    m.units *= k;
    if (m.pax !== undefined) m.pax *= k;
    m.income *= k;
    m.costs *= k;
  }
}

/** Месячное задание: условие на месяц — в нынешних месяцах, серия «N месяцев подряд» — в нынешних месяцах. */
function repaceParams(o: Objective, k: number, r: number): void {
  const p = o.params;
  if (!MONTHLY.has(p.kind)) return;
  if (p.kind === 'profit') p.amount = Math.max(100, Math.round((p.amount * k) / 100) * 100);
  if (p.kind === 'quality') p.volume = round10(p.volume * k);
  if (p.kind === 'throughput' || p.kind === 'newRoutes') p.amount = round10(p.amount * k);
  if ('months' in p) {
    p.months = Math.max(1, Math.round(p.months * r));
    o.target = p.months;
  }
  o.streak = Math.round(o.streak * r);
  o.progress = o.streak;
}

/** Эффекты и продолжения цепочек награды или провала: сроки — в нынешних месяцах. */
function repaceReward(rw: Reward, r: number): void {
  const fx = (e: EffectSpec) => (e.months = Math.max(1, Math.round(e.months * r)));
  rw.effects?.forEach(fx);
  for (const f of rw.follow ?? []) f.delay = Math.round(f.delay * r);
}

/** «за 3 мес.» в текстах событий и заданий — теми же минутами: «за 6 мин» (месяц был from секунд). */
export function minutesText(s: string, from: number): string {
  return s.replace(/(\d+(?:[.,]\d+)?)\s?мес\./g, (_, n: string) => durationText(Number(n.replace(',', '.')) * from));
}
