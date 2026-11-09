/**
 * Анализ карты и сети игрока — для генератора сценария, причин событий и оценки выполнимости.
 * Только чтение состояния игры; ничего не меняет.
 */
import { CONSTRUCTION, COST, ECONOMY, MONTH_LENGTH, STATION, TERM_SCALE } from '../config';
import { dist, Vec } from '../core/vec';
import type { Game, MonthRecord } from '../game/game';
import { MODELS } from '../game/transport';
import { CargoType, INDUSTRY_LIST, INDUSTRY_TYPES } from '../world/cargo';
import { obtainable } from '../world/enterprise';
import type { Industry, Station, Town } from '../world/entities';
import { specCost } from '../world/roadTypes';
import type { Ref } from './types';

/** Единица карты — 0.6 м. */
export const KM_PER_UNIT = 0.0006;
export const km = (d: number) => `${(d * KM_PER_UNIT).toFixed(1)} км`;

export type Place = Industry | Town;

export const isIndustry = (x: Place): x is Industry => 'info' in x;
export const refOf = (x: Place): Ref => ({ type: isIndustry(x) ? 'industry' : 'town', id: x.id });
export const posOf = (x: Place): Vec => (isIndustry(x) ? x.fp.center : x.center);

export function resolve(game: Game, ref: Ref): Place | undefined {
  return ref.type === 'industry' ? game.industries.find((i) => i.id === ref.id) : game.towns.find((t) => t.id === ref.id);
}

export function refName(game: Game, ref: Ref): string {
  return resolve(game, ref)?.name ?? '—';
}

export const townById = (game: Game, id: number) => game.towns.find((t) => t.id === id);
export const industryById = (game: Game, id: number) => game.industries.find((i) => i.id === id);

/** Предприятия, что работают или достроятся: заброшенные (режим «Строит игрок») — не в счёт, пока их не восстановят. */
export const live = (game: Game): Industry[] => game.industries.filter((i) => !i.ruin);

/**
 * Груз можно получить на этой карте: сырьё кто-то добывает, а для продукта есть завод
 * и всё его сырьё тоже можно получить (по цепочке). В режиме «Строит игрок» — и то, что можно построить:
 * добычу на месторождениях, заводы видов биома.
 */
export function producible(game: Game, cargo: CargoType, seen: ReadonlySet<CargoType> = new Set()): boolean {
  if (game.enterprises.on) return obtainable(cargo, [...live(game).map((i) => i.info), ...game.enterprises.kinds()], seen);
  if (seen.has(cargo)) return false;
  const next = new Set(seen).add(cargo);
  return game.industries.some((i) => i.info.produces === cargo && i.info.accepts.every((c) => producible(game, c, next)));
}

/**
 * Режим «Строит игрок»: сколько работы — получить груз, которого на карте никто не делает: построить завод (или
 * добычу на месторождении) — полторы перевозки, плюс сырьё для него. Нельзя — Infinity.
 */
export function buildEffort(game: Game, cargo: CargoType, seen: ReadonlySet<CargoType> = new Set()): number {
  if (!game.enterprises.on || seen.has(cargo) || seen.size > 3) return Infinity;
  const next = new Set(seen).add(cargo);
  let best = Infinity;
  for (const k of game.enterprises.kinds()) {
    if (k.produces !== cargo) continue;
    let cost = 1.5;
    for (const c of k.accepts) cost += live(game).some((i) => i.info.produces === c) ? 1 : buildEffort(game, c, next);
    best = Math.min(best, cost);
  }
  return best;
}

/** Перевозка дальше полутора километров весит больше одной: дольше строить дорогу, нужно больше машин. */
const LINK_LEN = 2500;

/**
 * Сколько работы — наладить поставки груза получателю to: перевозки самой лёгкой цепочки (сырьё → завод → …
 * → получатель), длинная весит больше одной; уже налаженные (has — туда этот груз уже возили) не в счёт.
 * Получить нельзя — Infinity.
 */
export function supplyEffort(game: Game, cargo: CargoType, to: Place, has: (to: Ref, cargo: CargoType) => boolean, seen: ReadonlySet<CargoType> = new Set()): number {
  if (has(refOf(to), cargo)) return 0;
  if (seen.has(cargo) || seen.size > 3) return Infinity;
  const next = new Set(seen).add(cargo);
  const at = posOf(to);
  const makers = live(game)
    .filter((i) => i.info.produces === cargo)
    .sort((a, b) => dist(a.fp.center, at) - dist(b.fp.center, at))
    .slice(0, 3);
  // Никто не делает — построить (режим «Строит игрок»).
  if (!makers.length) return buildEffort(game, cargo);
  let best = Infinity;
  for (const m of makers) {
    let cost = Math.max(1, dist(m.fp.center, at) / LINK_LEN);
    for (const c of m.info.accepts) cost += supplyEffort(game, c, m, has, next);
    best = Math.min(best, cost);
  }
  return best;
}

/** Кто принимает груз: заводы, которым это сырьё, и города, которым он нужен. */
export function receivers(game: Game, cargo: CargoType): Place[] {
  return [...live(game).filter((i) => i.info.accepts.includes(cargo)), ...game.towns.filter((t) => t.demands.includes(cargo))];
}

/** Есть ли кому сбыть продукцию предприятия. */
export const hasMarket = (game: Game, ind: Industry) => receivers(game, ind.info.produces).length > 0;

/** Предел роста предприятия: событие может поднять его выше обычного. */
export const levelCap = (ind: Industry) => ind.cap ?? ECONOMY.maxLevel;

export interface NetworkInfo {
  /** Станции на маршрутах, где есть транспорт. */
  stations: Station[];
  /** Города, где работает пассажирская станция. */
  towns: Set<number>;
  /** Предприятия, которые обслуживает грузовая станция. */
  industries: Set<number>;
  /** Выручка маршрутов за прошлый месяц: груз и пассажиры — чтобы понять, что выбрал игрок. */
  freight: number;
  pax: number;
}

export function network(game: Game): NetworkInfo {
  const stations = new Map<number, Station>();
  let freight = 0;
  let pax = 0;
  for (const line of game.lines.values()) {
    if (!line.vehicles.length) continue;
    if (game.lineCarries(line) === 'passengers') pax += line.revenueLast;
    else freight += line.revenueLast;
    for (const id of line.stops) {
      const st = game.stations.get(id);
      if (st) stations.set(id, st);
    }
  }
  const towns = new Set<number>();
  const industries = new Set<number>();
  for (const st of stations.values()) {
    if (st.serves.pax) for (const t of st.townIds) towns.add(t);
    if (st.serves.cargo) {
      for (const i of st.industryIds) industries.add(i);
      if (st.industryId !== null) industries.add(st.industryId);
    }
  }
  return { stations: [...stations.values()], towns, industries, freight, pax };
}

/**
 * Что подключено к сети: города — в охвате любой работающей станции (пассажиры или поставки в город),
 * предприятия — у грузовых станций. Для заданий «подключить новые города и предприятия».
 */
export function connected(game: Game): { towns: Set<number>; industries: Set<number> } {
  const info = network(game);
  const towns = new Set(info.towns);
  for (const st of info.stations) if (st.serves.cargo) for (const t of st.townIds) towns.add(t);
  return { towns, industries: info.industries };
}

/**
 * Сколько перевезли маршруты, созданные с момента since (у старых маршрутов отметки нет — не в счёт):
 * в прошлом месяце (last) или уже в этом (current).
 */
export function newRoutesCarried(game: Game, since: number, month: 'last' | 'current' = 'last'): number {
  let sum = 0;
  for (const line of game.lines.values()) {
    if (line.created !== undefined && line.created >= since) sum += month === 'last' ? line.carriedLast : line.carriedMonth;
  }
  return sum;
}

/** До ближайшей работающей станции игрока; сети нет — Infinity. */
export function distToNetwork(info: NetworkInfo, p: Vec): number {
  let best = Infinity;
  for (const st of info.stations) best = Math.min(best, dist(st.fp.center, p));
  return best;
}

/**
 * Сколько стоит начать возить на расстояние d по прямой: дорога (улица в обе стороны, путь длиннее прямой
 * на треть), две станции и транспорт. Грубая, но честная оценка — по ценам игры.
 */
export function routeCost(d: number, vehicles: number, model: 'truck' | 'bus'): number {
  const road = d * 1.3 * specCost({ cls: 'street', lanesF: 1, lanesB: 1 });
  return Math.round(road + 2 * COST.station + vehicles * MODELS[model].price);
}

/** Месячная выручка грузовика на линии длиной d (полный рейс туда, обратно порожняком). */
export function truckIncome(d: number, cargoRate: number): number {
  // ≈ 25 ед. карты в секунду с учётом погрузки и перекрёстков.
  const trip = (2 * d * 1.3) / 25 + 12;
  const trips = MONTH_LENGTH / trip;
  return (trips * MODELS.truck.capacity * cargoRate * ECONOMY.tariff * d) / 100;
}

/** Сколько сырьевое предприятие добудет за months месяцев, если его исправно обслуживать (с ростом уровня). */
export function rawOutput(ind: Industry, months: number): number {
  let level = ind.level ?? 1;
  let total = 0;
  for (let m = 0; m < months; m++) {
    total += ind.info.rate * level;
    // Растёт на шаг каждые growthMonths месяцев исправного вывоза.
    if (m % ECONOMY.growthMonths === ECONOMY.growthMonths - 1) level = Math.min(levelCap(ind), level + ECONOMY.growthStep);
  }
  return total;
}

/** Месяцев на стройку и разгон, прежде чем груз пойдёт (2 мин). */
export const RAMP = 1 * TERM_SCALE;

/** Дорога между точками на d по прямой длиннее на столько (изгибы, объезды). */
export const ROAD_DETOUR = 1.3;

/**
 * «Со строительством»: сколько месяцев строится дорога между точками на d по прямой (улица на земле, темп
 * CONSTRUCTION) — сверх разгона RAMP. «Мгновенно» — 0: дорога готова сразу.
 */
export function roadMonths(game: Game, d: number): number {
  return game.buildMode ? (d * ROAD_DETOUR) / CONSTRUCTION.speed / MONTH_LENGTH : 0;
}

/**
 * «Со строительством»: запас к сроку первых заданий — во столько раз больше прикидки roadMonths. Прикидка — улица у
 * самой базы одной бригадой, а на деле бригада на старте одна и строит дороги по очереди, база не рядом (вдвое
 * медленнее на CONSTRUCTION.reach от неё), магистраль строится в полтора раза дольше улицы (журнал 815481735:
 * линии этапа A пошли только на 6-й и 11-й минуте из 10).
 */
export const BUILD_SLACK = 1.5;
/** Запас на стройку, месяцев: не меньше и не больше (2 и 6 мин). */
export const BUILD_ALLOWANCE = { min: 1 * TERM_SCALE, max: 3 * TERM_SCALE } as const;

/**
 * «Со строительством»: сколько месяцев добавить к сроку заданий, для которых надо построить дороги на ds по прямой
 * (по очереди, одной бригадой) — целыми минутами. «Мгновенно» или дорог нет — 0.
 */
export function buildAllowance(game: Game, ds: readonly number[]): number {
  if (!game.buildMode || !ds.length) return 0;
  const months = ds.reduce((sum, d) => sum + roadMonths(game, d), 0) * BUILD_SLACK;
  return Math.min(BUILD_ALLOWANCE.max, Math.max(BUILD_ALLOWANCE.min, Math.ceil(months)));
}

/** «Со строительством»: на какое расстояние по прямой дорога строится не дольше seconds (для заданий этапа A). */
export function buildReach(seconds: number): number {
  return (seconds * CONSTRUCTION.speed) / ROAD_DETOUR;
}

/**
 * Сколько груза можно привезти к точке за months месяцев: от двух ближайших производителей не дальше maxDist.
 * Продукт завода — не больше, чем ему самому привезут сырья (по самому редкому виду) и чем он переработает.
 */
export function cargoPotential(game: Game, cargo: CargoType, near: Vec, months: number, maxDist = 4200, depth = 0): number {
  const work = Math.max(0, months - RAMP);
  if (work <= 0 || depth > 2) return 0;
  const makers = live(game)
    .filter((i) => i.info.produces === cargo && dist(i.fp.center, near) <= maxDist)
    .sort((a, b) => dist(a.fp.center, near) - dist(b.fp.center, near))
    .slice(0, 2);
  let total = 0;
  for (const ind of makers) {
    // «Со строительством» груз пойдёт, только когда достроят дорогу до производителя.
    const built = game.buildMode ? Math.max(0, work - roadMonths(game, dist(ind.fp.center, near))) : work;
    if (!ind.info.accepts.length) {
      total += rawOutput(ind, built);
      continue;
    }
    // Сырьё до завода идёт на звено раньше: на 2 мин меньше срока.
    const inputs = ind.info.accepts.map((c) => cargoPotential(game, c, ind.fp.center, months - TERM_SCALE, maxDist, depth + 1));
    total += Math.min(Math.min(...inputs), ECONOMY.processRate * (ind.level ?? 1) * built);
  }
  return total;
}

/** Доля жителей города, которую охватит станция в центре. */
function centralCatch(t: Town): number {
  const r = Math.max(120, t.radius);
  return Math.max(0.15, Math.min(0.7, (STATION.catchment / r) ** 2 * 1.6));
}

/** Пассажиров в месяц между двумя городами (в обе стороны), если поставить по станции в центре каждого. */
export function paxPerMonth(a: Town, b: Town): number {
  const perThousand = 1.2 * MONTH_LENGTH;
  return (perThousand * (a.population * centralCatch(a) + b.population * centralCatch(b))) / 1000;
}

export interface TownPair {
  a: Town;
  b: Town;
  d: number;
}

/** Пары городов, ближние — первыми. */
export function townPairs(game: Game): TownPair[] {
  const out: TownPair[] = [];
  game.towns.forEach((a, i) => game.towns.slice(i + 1).forEach((b) => out.push({ a, b, d: dist(a.center, b.center) })));
  return out.sort((x, y) => x.d - y.d);
}

/** Операционная прибыль месяца: перевозки минус содержание транспорта, ремонт и проценты (без стройки и покупок). */
export function operating(m: Pick<MonthRecord, 'ledger'>): { income: number; costs: number; profit: number } {
  const l = m.ledger;
  if (!l) return { income: 0, costs: 0, profit: 0 };
  const costs = l.vehicles + l.roads + l.interest;
  return { income: l.transport, costs, profit: l.transport - costs };
}

/** Поставка сырья на завод: ближайший добытчик и расстояние. */
export interface Supply {
  cargo: CargoType;
  from: Industry;
  to: Industry;
  d: number;
}

/** Все пары «добытчик → завод» по ближайшему добытчику для каждого сырья каждого завода, короткие — первыми. */
export function rawSupplies(game: Game): Supply[] {
  const out: Supply[] = [];
  const all = live(game);
  for (const plant of all) {
    for (const cargo of plant.info.accepts) {
      const from = all
        .filter((i) => i.info.produces === cargo && !i.info.accepts.length)
        .sort((a, b) => dist(a.fp.center, plant.fp.center) - dist(b.fp.center, plant.fp.center))[0];
      if (from) out.push({ cargo, from, to: plant, d: dist(from.fp.center, plant.fp.center) });
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

/** Крупнейшие города. */
export const bigTowns = (game: Game) => [...game.towns].sort((a, b) => b.population - a.population);

/** Сводка по региону — для брифинга и выбора архетипа. */
export interface RegionInfo {
  population: number;
  towns: number;
  bigTowns: number;
  /** Среднее расстояние до ближайшего соседа. */
  spacing: number;
  /** Цепочки «сырьё → завод», где все виды сырья добываются не дальше 3 км. */
  compactChains: number;
  /** Предприятий у крупнейшего города (в радиусе 3 км). */
  hubIndustries: number;
  /** Близких пар крупных городов (до 3.5 км). */
  closeBigPairs: number;
}

export function region(game: Game): RegionInfo {
  const big = game.towns.filter((t) => t.population >= 5000);
  const spacing = game.towns.length
    ? game.towns.reduce((s, t) => s + Math.min(...game.towns.filter((o) => o !== t).map((o) => dist(o.center, t.center))), 0) / game.towns.length
    : 0;
  let compactChains = 0;
  const hub = bigTowns(game)[0];
  let hubIndustries = hub ? game.industries.filter((i) => dist(i.fp.center, hub.center) <= 5000).length : 0;
  if (game.enterprises.on) {
    // «Строит игрок»: заводов почти нет — цепочки считаем по тому, что можно построить у городов: вид завода с
    // продукцией, нужной кому-то, и сырьём (добыча или месторождение) не дальше 5 км от одного города.
    const sources = (c: CargoType): Vec[] => [
      ...live(game).filter((i) => i.info.produces === c).map((i) => i.fp.center),
      ...game.enterprises.deposits.filter((d) => d.used === undefined && INDUSTRY_TYPES[d.kind].produces === c).map((d) => d.center),
    ];
    for (const k of game.enterprises.kinds().filter((x) => x.accepts.length)) {
      if (!receivers(game, k.produces).length) continue;
      if (game.towns.some((t) => k.accepts.every((c) => sources(c).some((p) => dist(p, t.center) <= 5000)))) compactChains++;
    }
    if (hub) hubIndustries += game.enterprises.deposits.filter((d) => d.used === undefined && dist(d.center, hub.center) <= 5000).length;
  } else {
    for (const plant of game.industries.filter((i) => i.info.accepts.length)) {
      const ok = plant.info.accepts.every((c) => game.industries.some((i) => i.info.produces === c && dist(i.fp.center, plant.fp.center) <= 5000));
      if (ok && hasMarket(game, plant)) compactChains++;
    }
  }
  let closeBigPairs = 0;
  big.forEach((a, i) => big.slice(i + 1).forEach((b) => (dist(a.center, b.center) <= 5800 ? closeBigPairs++ : 0)));
  return {
    population: game.towns.reduce((s, t) => s + t.population, 0),
    towns: game.towns.length,
    bigTowns: big.length,
    spacing,
    compactChains,
    hubIndustries,
    closeBigPairs,
  };
}

/** Виды предприятий, которые принимают сырьё. */
export const PLANT_KINDS = INDUSTRY_LIST.filter((t) => t.accepts.length).map((t) => t.kind);
