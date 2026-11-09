/**
 * Предприятия строит игрок (WorldSettings.industryMode 'player', docs/INDUSTRIES.md): цена и время стройки, рабочие
 * (сами из городов рядом или автобусом), вред городу, черта города и места в ней. Только расчёты — без Game:
 * постройку, подвоз рабочих и рост городов делает Game по этим правилам. Числа — ENTERPRISE в config.ts.
 */
import { ENTERPRISE } from '../config';
import { dist, type Vec } from '../core/vec';
import { INDUSTRY_LIST, type CargoType, type IndustryKind, type IndustryType } from './cargo';
import type { Deposit, Industry, Town } from './entities';
import { type Footprint, footprintRadius } from './spatial';

/** Класс вредности вида предприятия: 0 — чистое, 3 — металлургия и химия. Нет в таблице — 0. */
export const HARM: Partial<Record<IndustryKind, 1 | 2 | 3>> = {
  sawmill: 1,
  meatplant: 1,
  coalmine: 2,
  ironmine: 2,
  quarry: 2,
  oilwell: 2,
  sandpit: 2,
  claypit: 2,
  goldmine: 2,
  gemmine: 2,
  coppermine: 2,
  gasfield: 2,
  buildmat: 2,
  glassworks: 2,
  cement: 2,
  brickworks: 2,
  steelmill: 3,
  refinery: 3,
  smelter: 3,
  papermill: 3,
  gasplant: 3,
};

export const harmClass = (kind: IndustryKind): number => HARM[kind] ?? 0;

/** Сырьевое: добывает, ничего не перерабатывает — ставится только на месторождение. */
export const isRaw = (info: Pick<IndustryType, 'accepts'>): boolean => !info.accepts.length;

/** Сколько стоит построить (восстановить заброшенное — ruin). */
export function buildCost(info: Pick<IndustryType, 'accepts'>, ruin = false): number {
  const C = ENTERPRISE.cost;
  const full = isRaw(info) ? C.raw : info.accepts.length > 1 ? C.plant2 : C.plant;
  return ruin ? Math.round((full * ENTERPRISE.ruinShare) / 1000) * 1000 : full;
}

/** Сколько секунд строится «Со строительством» (восстановление — быстрее). */
export function buildTime(info: Pick<IndustryType, 'accepts'>, ruin = false): number {
  const t = isRaw(info) ? ENTERPRISE.buildTime.raw : ENTERPRISE.buildTime.plant;
  return ruin ? t * ENTERPRISE.ruinShare : t;
}

/** Сколько рабочих в месяц нужно предприятию. */
export function workersNeeded(info: Pick<IndustryType, 'accepts'>): number {
  const W = ENTERPRISE.workers;
  return isRaw(info) ? W.raw : info.accepts.length > 1 ? W.plant2 : W.plant;
}

/** Работает ли предприятие: не заброшено и достроено. Только такие берут рабочих, производят и вредят. */
export const isActive = (ind: Pick<Industry, 'ruin' | 'build'>): boolean => !ind.ruin && !ind.build;

// ---------- Черта города ----------

/** Черта города: от центра до края застройки (Town.extent) с запасом. */
export function townEdge(t: Pick<Town, 'radius' | 'extent'>): number {
  return (t.extent ?? t.radius) + ENTERPRISE.townMargin;
}

/** Зазор от участка до черты города (по полуширине участка): меньше нуля — участок задевает город. */
export function townGap(t: Pick<Town, 'center' | 'radius' | 'extent'>, fp: Footprint): number {
  return dist(fp.center, t.center) - townEdge(t) - footprintRadius(fp) / 2;
}

/** Участок в черте города — городское предприятие (занимает место, townSlots). */
export const inTown = (t: Pick<Town, 'center' | 'radius' | 'extent'>, fp: Footprint): boolean => townGap(t, fp) < 0;

/** В черте какого города участок (ближайшего, если задевает несколько); null — за городом. */
export function townFor(towns: readonly Town[], fp: Footprint): Town | null {
  let best: Town | null = null;
  let gap = 0;
  for (const t of towns) {
    const g = townGap(t, fp);
    if (g < gap) {
      gap = g;
      best = t;
    }
  }
  return best;
}

/** Сколько мест под предприятия в черте города: по населению (ENTERPRISE.slots). */
export function townSlots(t: Pick<Town, 'population'>): number {
  const S = ENTERPRISE.slots;
  if (t.population < S.firstPop) return 0;
  return Math.min(S.max, 1 + Math.floor((t.population - S.firstPop) / S.perPop));
}

/** Предприятия в черте города (и заброшенные, и строящиеся — место занято). */
export function townIndustries(t: Town, towns: readonly Town[], industries: readonly Industry[]): Industry[] {
  return industries.filter((i) => townFor(towns, i.fp) === t);
}

// ---------- Рабочие ----------

/** Какая доля нужных рабочих доходит сама с зазора gap до черты города: до near — все, за far — никто. */
export function commuteShare(gap: number): number {
  const { near, far } = ENTERPRISE.commute;
  if (gap <= near) return 1;
  if (gap >= far) return 0;
  return 1 - (gap - near) / (far - near);
}

/** Сколько рабочих в месяц город отдаёт на предприятия. */
export const laborPool = (t: Pick<Town, 'population'>): number => t.population * ENTERPRISE.labor;

/** Рабочие предприятия: сколько нужно, какая доля приходит сама и откуда, сколько не хватает (везти автобусом). */
export interface Staffing {
  need: number;
  /** Доля, что приходит сама: 0…1. */
  local: number;
  /** Откуда приходят: город → рабочих в месяц. */
  from: { town: number; n: number }[];
  /** Не хватает рабочих в месяц: их можно привезти автобусом. */
  bus: number;
}

export interface Workforce {
  staff: Map<number, Staffing>;
  /** Сколько рабочих каждого города занято на предприятиях. */
  employed: Map<number, number>;
}

/**
 * Раздаёт рабочих городов предприятиям — по очереди постройки (меньший id раньше): каждому из ближних городов
 * сколько доходит (commuteShare) и сколько у города осталось свободных. Заброшенные и строящиеся рабочих не берут.
 */
export function allocateWorkers(towns: readonly Town[], industries: readonly Industry[]): Workforce {
  const free = new Map(towns.map((t) => [t.id, laborPool(t)]));
  const employed = new Map<number, number>(towns.map((t) => [t.id, 0]));
  const staff = new Map<number, Staffing>();
  for (const ind of [...industries].sort((a, b) => a.id - b.id)) {
    const need = workersNeeded(ind.info);
    if (!isActive(ind)) {
      staff.set(ind.id, { need, local: 0, from: [], bus: 0 });
      continue;
    }
    let left = need;
    const from: Staffing['from'] = [];
    const near = towns.map((t) => ({ t, gap: townGap(t, ind.fp) })).sort((a, b) => a.gap - b.gap);
    for (const { t, gap } of near) {
      if (left <= 1e-6) break;
      const share = commuteShare(gap);
      if (share <= 0) break;
      const n = Math.min(left, need * share, free.get(t.id)!);
      if (n <= 1e-6) continue;
      left -= n;
      free.set(t.id, free.get(t.id)! - n);
      employed.set(t.id, employed.get(t.id)! + n);
      from.push({ town: t.id, n });
    }
    staff.set(ind.id, { need, local: (need - left) / need, from, bus: Math.max(0, left) });
  }
  return { staff, employed };
}

/** Обеспеченность рабочими 0…1: сами пришли и привезённые автобусом (crew). Нет данных — 1. */
export function staffShare(ind: Pick<Industry, 'crew'>, s: Staffing | undefined): number {
  if (!s) return 1;
  return Math.max(0, Math.min(1, s.local + (ind.crew ?? 0) / s.need));
}

// ---------- Вред и рост города ----------

/** Радиус вреда предприятия класса cls — от края участка до черты города. */
export const harmReach = (cls: number): number => cls * ENTERPRISE.harm.reach;

/** Сколько роста города t срезает предприятие (вида kind на участке fp): 0…0.6. */
export function harmTo(t: Pick<Town, 'center' | 'radius' | 'extent'>, kind: IndustryKind, fp: Footprint): number {
  const cls = harmClass(kind);
  if (!cls) return 0;
  const gap = townGap(t, fp);
  const close = gap <= 0 ? 1 : Math.max(0, 1 - gap / harmReach(cls));
  return cls * ENTERPRISE.harm.growth * close;
}

/** Вред городу от работающих предприятий: сколько роста срезано всего и кем. */
export function townHarm(t: Town, industries: readonly Industry[]): { total: number; from: { id: number; cut: number }[] } {
  const from: { id: number; cut: number }[] = [];
  let total = 0;
  for (const ind of industries) {
    if (!isActive(ind)) continue;
    const cut = harmTo(t, ind.info.kind, ind.fp);
    if (cut <= 0) continue;
    from.push({ id: ind.id, cut });
    total += cut;
  }
  return { total, from: from.sort((a, b) => b.cut - a.cut) };
}

/** Доля занятых рабочих города 0…1. */
export function jobsShare(t: Town, employed: ReadonlyMap<number, number>): number {
  const pool = laborPool(t);
  return pool > 0 ? Math.min(1, (employed.get(t.id) ?? 0) / pool) : 0;
}

/** Множитель роста города: вред срезает (не ниже нуля), занятость прибавляет (до ×1+jobs). */
export function growthFactor(harm: number, jobs: number): number {
  return Math.max(0, 1 - harm) * (1 + ENTERPRISE.jobs * jobs);
}

// ---------- Что можно построить ----------

/** Виды, которые можно построить в мире: те, что есть в биоме (allowed). Добыча — если есть её месторождения. */
export function buildableKinds(allowed: (kind: IndustryKind) => boolean, deposits: readonly Deposit[]): IndustryType[] {
  const kinds = new Set(deposits.map((d) => d.kind));
  return INDUSTRY_LIST.filter((t) => allowed(t.kind) && (!isRaw(t) || kinds.has(t.kind)));
}

/**
 * Груз можно получить: его делает предприятие на карте или вид, который можно построить, — и всё сырьё для него
 * тоже можно получить (по цепочке).
 */
export function obtainable(cargo: CargoType, kinds: readonly Pick<IndustryType, 'produces' | 'accepts'>[], seen: ReadonlySet<CargoType> = new Set()): boolean {
  if (seen.has(cargo)) return false;
  const next = new Set(seen).add(cargo);
  return kinds.some((k) => k.produces === cargo && k.accepts.every((c) => obtainable(c, kinds, next)));
}

/** Свободные месторождения вида (без предприятия на них), ближние к точке — первыми. */
export function freeDeposits(deposits: readonly Deposit[], kind: IndustryKind, near?: Vec): Deposit[] {
  const list = deposits.filter((d) => d.kind === kind && d.used === undefined);
  return near ? list.sort((a, b) => dist(a.center, near) - dist(b.center, near)) : list;
}

/** Множитель добычи месторождения по его размеру. */
export const depositRichness = (d: Pick<Deposit, 'size'>): number => ENTERPRISE.deposits.sizes[d.size].k;

/** Участок предприятия вида info на месторождении: ровно по центру и повороту участка. */
export function depositFootprint(d: Deposit, info: Pick<IndustryType, 'w' | 'h'>): Footprint {
  return { center: { ...d.center }, w: info.w, h: info.h, angle: d.angle };
}
