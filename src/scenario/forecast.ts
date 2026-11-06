/**
 * Прогноз накопительного задания — «доставить груз», «перевезти пассажиров» к сроку: сколько довезут машины, что
 * уже есть, если ничего не менять. Основа — расписание прибытий каждой машины: где она сейчас (едет гружёная к
 * получателю, пустая за грузом, грузится, только что куплена), когда впервые довезёт груз и как часто будет возить
 * дальше — раз в круг маршрута. Так на длинном маршруте сразу видно, успеет ли машина доехать к сроку хоть раз,
 * а не ноль, пока первая не доехала. Перегоны — по длине пути и скорости модели, с поправкой по замеренному кругу
 * линии, если рейсы уже были; пробки точно не моделируем. Сверху — сколько вообще есть что везти: груз на борту,
 * запас на станциях и выпуск предприятий (поток пассажиров) за оставшееся время.
 * У остальных заданий прогноза нет: месячные засчитываются по календарному месяцу, а рост города, уровень
 * предприятия и подключения доставками не прикинуть.
 * Тот же расчёт — темп маршрута по циклу в его карточке (linePace).
 */
import { MONTH_LENGTH } from '../config';
import { leftText } from '../core/timeText';
import { dist } from '../core/vec';
import type { Game } from '../game/game';
import { runTime, type SpeedChart } from '../game/speedChart';
import { type FleetVehicle, type Line, MODELS, vehicleCapacity } from '../game/transport';
import type { CargoType } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import type { ObjectiveParams, Ref } from './types';

// ---------- Расписание машины (без игры) ----------

/** Круг линии для расписания: перегоны и что на каких остановках происходит с нужным грузом. */
export interface Circuit {
  /** Время перегона от остановки i к следующей (по кругу), секунд. */
  legs: number[];
  /** Стоянка на остановке — выгрузка и погрузка, секунд. */
  dwell: number;
  /** Здесь машина берёт нужный груз (пассажиров) — полной. */
  load: boolean[];
  /** Здесь его выгружают — любому получателю: дальше машина едет без него. */
  sink: boolean[];
  /** Выгрузка здесь — в счёт задания (получатель задания). */
  drop: boolean[];
}

/** Машина для расписания. */
export interface Unit {
  /** Остановка: где стоит или куда едет. */
  stop: number;
  driving: boolean;
  /** Секунд до отправления (стоит) или до приезда (едет). */
  wait: number;
  /** Нужного груза на борту. */
  carrying: number;
  capacity: number;
  /** Стоит на погрузке — уедет с таким грузом (сколько успеет набрать); нет — полной. */
  departs?: number;
}

export interface Trips {
  /** Когда первая доставка в счёт задания, секунд от сейчас; не успевает — null. */
  first: number | null;
  amount: number;
  count: number;
}

/** Предел шагов расписания: перегоны нулевой длины не зациклят его. */
const MAX_STEPS = 400;

/** Круг машины: все перегоны и стоянки. */
export const lapOf = (c: Circuit) => c.legs.reduce((a, b) => a + b, 0) + c.legs.length * c.dwell;

/**
 * Доставки машины в счёт задания за horizon секунд — по кругу маршрута от того места, где она сейчас: приехала —
 * выгрузила (на получателе задания — в счёт), на погрузке взяла полную, постояла, поехала дальше.
 */
export function unitTrips(c: Circuit, u: Unit, horizon: number): Trips {
  const n = c.legs.length;
  const out: Trips = { first: null, amount: 0, count: 0 };
  if (n < 2) return out;
  let i = ((u.stop % n) + n) % n;
  let t = Math.max(0, u.wait);
  let load = u.carrying;
  const arrive = () => {
    if (c.sink[i] && load > 0) {
      if (c.drop[i]) {
        out.first ??= t;
        out.amount += load;
        out.count++;
      }
      load = 0;
    }
    if (c.load[i]) load = Math.max(load, u.capacity);
  };
  if (u.driving) {
    if (t > horizon) return out;
    arrive();
    t += c.dwell;
  } else if (c.load[i]) {
    // Стоит на погрузке — уедет с тем, что наберёт (по умолчанию полной).
    load = u.departs ?? Math.max(load, u.capacity);
  }
  for (let step = 0; step < MAX_STEPS; step++) {
    t += c.legs[i];
    i = (i + 1) % n;
    if (t > horizon) break;
    arrive();
    t += c.dwell;
  }
  return out;
}

/** Погрузка: запас нужного груза на станции и выпуск для неё, ед. в секунду. */
export interface Source {
  stock: number;
  rate: number;
}

/**
 * Сколько пустой грузовик ждёт груз у производителя — как по правилу «авто» в игре (Game.loadingDone): 25 попыток
 * догрузиться, каждая — около 1.1 с.
 */
export const LOAD_PATIENCE = 25;
export const PATIENCE_STEP = 1.1;

/**
 * Машины на одной погрузке набирают груз одновременно, деля запас и выпуск поровну: уезжают, когда набрали полную
 * или кончилось терпение (patience — сколько секунд ещё ждать груз), с тем, что успели взять.
 */
export function queueAt(src: Source, queue: readonly { unit: Unit; patience: number }[]): void {
  if (!queue.length) return;
  const stock = src.stock / queue.length;
  const rate = src.rate / queue.length;
  for (const { unit: u, patience } of queue) {
    const need = Math.max(0, u.capacity - u.carrying);
    const full = rate > 0 ? Math.max(0, (need - stock) / rate) : stock >= need ? 0 : Infinity;
    const depart = Math.max(u.wait, Math.min(full, u.wait + Math.max(0, patience)));
    u.departs = u.carrying + Math.max(0, Math.min(need, stock + rate * depart));
    u.wait = depart;
  }
}

/** Сколько машина такой вместимости довозит за круг, когда рейсы уже идут: второй круг от первой остановки. */
export function lapAmount(c: Circuit, capacity: number): number {
  const lap = lapOf(c);
  if (!(lap > 0)) return 0;
  const u: Unit = { stop: 0, driving: false, wait: 0, carrying: 0, capacity };
  return unitTrips(c, u, 2 * lap).amount - unitTrips(c, u, lap).amount;
}

/** Что машины линий довезут к горизонту и сколько вообще есть что везти. */
export interface Outlook {
  /** Машин на линиях, что возят нужное. */
  vehicles: number;
  /** Довезут по расписанию к горизонту (без предела запасом). */
  amount: number;
  /** Первая доставка, секунд от сейчас; ни одна машина не успеет — null. */
  first: number | null;
  /** Темп по циклу, ед. в секунду (без предела запасом). */
  rate: number;
  /** Сколько есть что везти к горизонту: на борту, на станциях и выпуск; null — не ограничено (склады пересадки). */
  supply: number | null;
  /** Выпуск (поток пассажиров), ед. в секунду; null — не ограничен. */
  supplyRate: number | null;
}

/** Расписание всех машин: доставки к горизонту, первая доставка и темп по циклу. */
export function schedule(lines: readonly { circuit: Circuit; units: readonly Unit[] }[], horizon: number): Pick<Outlook, 'vehicles' | 'amount' | 'first' | 'rate'> {
  let vehicles = 0;
  let amount = 0;
  let first: number | null = null;
  let rate = 0;
  for (const { circuit, units } of lines) {
    const lap = lapOf(circuit);
    for (const u of units) {
      vehicles++;
      const trips = unitTrips(circuit, u, horizon);
      amount += trips.amount;
      if (trips.first !== null) first = first === null ? trips.first : Math.min(first, trips.first);
      if (lap > 0) rate += lapAmount(circuit, u.capacity) / lap;
    }
  }
  return { vehicles, amount, first, rate };
}

// ---------- Прогноз к сроку ----------

export interface Forecast {
  /** Сколько будет к сроку (в единицах цели). */
  value: number;
  /** Доля цели к сроку, 0…1 — конец полупрозрачной части шкалы. */
  fraction: number;
  /** Успеваем: прогноз не меньше цели. */
  reach: boolean;
  /** Темп по циклу, ед. в минуту. */
  perMinute: number;
  /** Первая доставка через столько секунд — если доставок ещё не было; иначе null. */
  first: number | null;
  /** Почему прогноз — только сделанное: возить некому или машины не успеют доехать к сроку. */
  stall: 'idle' | 'late' | null;
}

/** Прогноз к сроку: сделано + что довезут машины до срока, но не больше, чем есть что везти. */
export function forecastOf(progress: number, target: number, o: Outlook): Forecast {
  const value = progress + Math.max(0, Math.min(o.amount, o.supply ?? Infinity));
  return {
    value,
    fraction: Math.max(0, Math.min(1, value / Math.max(1, target))),
    reach: value >= target,
    perMinute: Math.max(0, Math.min(o.rate, o.supplyRate ?? Infinity)) * 60,
    first: progress <= 0 ? o.first : null,
    stall: o.vehicles === 0 ? 'idle' : o.first === null ? 'late' : null,
  };
}

const num = (n: number) => Math.round(n).toLocaleString('ru-RU');
/** Темп коротко: от 10 — целыми, меньше — с десятыми («2,5»). */
export const paceText = (n: number) => (n >= 10 || n === 0 ? num(n) : (Math.round(n * 10) / 10).toLocaleString('ru-RU'));

/**
 * Подсказка к шкале: «Прогноз к сроку: ~N (темп M в мин)», пока доставок не было — «· первая доставка через ~X»;
 * успеваем — «— успеваем»; возить некому или машины не успеют — так и говорит.
 */
export function forecastTip(f: Forecast): string {
  const head = `Прогноз к сроку: ~${num(f.value)}`;
  if (f.stall === 'idle') return `${head} — возить пока некому`;
  if (f.stall === 'late') return `${head} — машины не успеют доехать до срока`;
  const pace = f.first !== null ? ` · первая доставка через ~${leftText(f.first)}` : ` (темп ${paceText(f.perMinute)} в мин)`;
  return `${head}${pace}${f.reach ? ' — успеваем' : ''}`;
}

// ---------- Линии игры ----------

/** Что везти: груз (кому, от какого предприятия) или пассажиров (между какими городами). */
export type Haul = { kind: 'cargo'; cargo: CargoType; to: Ref | null; from?: number } | { kind: 'pax'; towns: [number, number] | null };

/** Что везти по заданию; у заданий без прогноза — null. */
export function haulOf(p: ObjectiveParams): Haul | null {
  if (p.kind === 'deliver') return { kind: 'cargo', cargo: p.cargo, to: p.to, from: p.from };
  if (p.kind === 'passengers') return { kind: 'pax', towns: p.towns };
  return null;
}

/** Стоянка на станции до поправки по кругу, секунд — как в прикидке круга игры (Game.guessLap). */
const DWELL = 10;
/** В пути медленнее предельной скорости: разгон, перекрёстки — как в Game.guessLap. */
const ROAD_PACE = 0.7;
/** Поправка по замеренному кругу — в этих пределах: случайный долгий круг не ломает расписание. */
const CALIBRATE = [0.5, 4] as const;

/** Длины перегонов линии по дорогам или путям — пересчитываются раз в 20 с (дороги перестраивают). */
const legCache = new WeakMap<Line, { sig: string; at: number; lens: number[] }>();

function legLengths(game: Game, line: Line, sts: Station[], rail: boolean): number[] {
  const sig = `${rail ? 'r' : 'a'}:${line.stops.join(',')}`;
  const hit = legCache.get(line);
  if (hit && hit.sig === sig && game.time >= hit.at && game.time - hit.at < 20) return hit.lens;
  const lens = sts.map((a, i) => {
    const b = sts[(i + 1) % sts.length];
    const route = rail ? null : game.roads.route(a.nodeId, b.nodeId);
    return route ? game.roads.routeLength(route) : dist(a.fp.center, b.fp.center) * 1.3;
  });
  legCache.set(line, { sig, at: game.time, lens });
  return lens;
}

/** Перегоны из графика скорости линии: длины и время по свободной дороге (график — в кэше игры, перегоны — здесь). */
const chartCache = new WeakMap<SpeedChart, { lens: number[]; times: number[] }>();

function chartLegs(chart: SpeedChart | null, stops: number): { lens: number[]; times: number[] } | null {
  if (!chart || chart.stops.length !== stops + 1) return null;
  const hit = chartCache.get(chart);
  if (hit) return hit;
  const lens: number[] = [];
  const times: number[] = [];
  let k = 0;
  for (let i = 0; i < stops; i++) {
    const [a, b] = [chart.stops[i], chart.stops[i + 1]];
    while (k < chart.d.length - 1 && chart.d[k] < a) k++;
    let e = k;
    while (e < chart.d.length - 1 && chart.d[e] < b) e++;
    lens.push(b - a);
    times.push(runTime(chart.d.subarray(k, e + 1), chart.v.subarray(k, e + 1)));
    k = e;
  }
  if (times.some((t) => !Number.isFinite(t))) return null;
  const legs = { lens, times };
  chartCache.set(chart, legs);
  return legs;
}

/** Предприятия станции. */
function industriesAt(game: Game, st: Station): Industry[] {
  const ids = new Set(st.industryId !== null ? [st.industryId, ...st.industryIds] : st.industryIds);
  return game.industries.filter((i) => ids.has(i.id));
}

/** Станция обслуживает получателя: предприятие у неё или город в её охвате. */
const serves = (st: Station, to: Ref) => (to.type === 'industry' ? st.industryId === to.id || st.industryIds.includes(to.id) : st.townIds.includes(to.id));

/** Производители нужного груза у станции (у задания «от предприятия» — только оно). */
function makersAt(game: Game, st: Station, haul: Extract<Haul, { kind: 'cargo' }>): Industry[] {
  return industriesAt(game, st).filter((i) => i.info.produces === haul.cargo && (haul.from === undefined || i.id === haul.from));
}

/** Линия под задание: круг для расписания, машины и станции погрузки. */
interface LinePlan {
  circuit: Circuit;
  units: Unit[];
  loads: Station[];
}

/** Круг линии и её машины для расписания; линия не возит нужное — null. */
function linePlan(game: Game, line: Line, haul: Haul): LinePlan | null {
  const sts = line.stops.map((id) => game.stations.get(id));
  if (sts.length < 2 || sts.some((s) => !s)) return null;
  const stations = sts as Station[];
  const carries = haul.kind === 'pax' ? 'passengers' : 'freight';
  const fleet = line.vehicles.map((id) => game.fleet.get(id)).filter((v): v is FleetVehicle => !!v && MODELS[v.model].carries === carries);
  let load: boolean[];
  let sink: boolean[];
  let drop: boolean[];
  if (haul.kind === 'cargo') {
    const c = haul.cargo;
    load = stations.map(
      (st, i) => st.serves.cargo && game.loadable(line, i).has(c) && (makersAt(game, st, haul).length > 0 || (haul.from === undefined && (st.cargo[c] ?? 0) > 0)),
    );
    sink = stations.map((st) => st.serves.cargo && st.accepts.has(c));
    drop = stations.map((st, i) => sink[i] && (!haul.to || serves(st, haul.to)));
  } else {
    const towns = haul.towns;
    const ours = (st: Station) => st.serves.pax && (!towns || st.townIds.some((t) => towns.includes(t)));
    load = stations.map(ours);
    sink = stations.map((st) => st.serves.pax);
    drop = stations.map(ours);
  }
  if (!load.some((x) => x) || !drop.some((x) => x)) return null;
  const loads = stations.filter((_, i) => load[i]);
  // Перегоны — по графику скорости линии (пределы, изгибы, уклоны, разгон и торможение у остановок), а без него —
  // длина ÷ скорость модели; рейсы уже были — с поправкой по замеренному кругу (пробки, светофоры, ожидание груза).
  const chart = chartLegs(game.lineSpeedChart(line), stations.length);
  const model = MODELS[fleet[0]?.model ?? (haul.kind === 'pax' ? 'bus' : 'truck')];
  const rail = model.mode === 'rail';
  const speed = (rail ? model.train.maxSpeed : model.spec.maxSpeed) * ROAD_PACE;
  const lens = chart?.lens ?? legLengths(game, line, stations, rail);
  const drive = chart?.times ?? lens.map((l) => l / speed);
  const guess = drive.reduce((a, b) => a + b, 0) + stations.length * DWELL;
  const k = line.lap ? Math.max(CALIBRATE[0], Math.min(CALIBRATE[1], line.lap / guess)) : 1;
  const circuit: Circuit = { legs: drive.map((d) => d * k), dwell: DWELL * k, load, sink, drop };
  const units = fleet.map((v) => unitOf(game, v, circuit, stations, lens, haul.kind === 'cargo' ? haul.cargo : null));
  if (haul.kind === 'cargo') {
    // Грузовики на погрузке ждут груз: когда уедут и с чем — по запасу станции и выпуску её предприятий.
    stations.forEach((st, i) => {
      if (!load[i]) return;
      const queue = units.flatMap((unit, k) => (!unit.driving && unit.stop === i ? [{ unit, patience: (LOAD_PATIENCE - fleet[k].waited) * PATIENCE_STEP }] : []));
      if (queue.length) queueAt(sourceAt(game, st, haul) ?? { stock: st.cargo[haul.cargo] ?? 0, rate: 0 }, queue);
    });
  }
  return { circuit, units, loads };
}

/** Запас груза на станции и выпуск её предприятий для неё (поровну с другими их станциями); склад без них — null. */
function sourceAt(game: Game, st: Station, haul: Extract<Haul, { kind: 'cargo' }>): Source | null {
  const makers = makersAt(game, st, haul);
  if (!makers.length) return null;
  return { stock: st.cargo[haul.cargo] ?? 0, rate: makers.reduce((s, ind) => s + makerRate(game, ind), 0) };
}

/** Выпуск предприятия, ед. в секунду на одну его грузовую станцию: добыча — по мощности, переработка — за прошлый месяц. */
function makerRate(game: Game, ind: Industry): number {
  const monthly = ind.info.accepts.length ? ind.producedLast : game.industryRate(ind);
  const share = [...game.stations.values()].filter((s) => s.serves.cargo && (s.industryId === ind.id || s.industryIds.includes(ind.id))).length;
  return monthly / MONTH_LENGTH / Math.max(1, share);
}

/** Где машина на круге: стоит или едет, сколько до отправления или приезда, что везёт нужного (cargo; null — пассажиров). */
function unitOf(game: Game, v: FleetVehicle, c: Circuit, sts: Station[], lens: number[], cargo: CargoType | null): Unit {
  const n = sts.length;
  const stop = ((v.stop % n) + n) % n;
  const capacity = vehicleCapacity(v);
  // Нужное на борту: груз задания; пассажиры — те, кто едет на остановки задания.
  const carrying =
    cargo !== null
      ? v.cargo === cargo
        ? v.amount
        : 0
      : v.passengers.reduce((s, g) => s + (c.drop[sts.findIndex((st) => st.id === g.to)] ? g.count : 0), 0);
  if (v.state !== 'driving') {
    // Стоит: грузится, выжидает интервал (новая — свою очередь) или ждёт выезда.
    return { stop, driving: false, wait: Math.max(0, v.timer) + (game.spacingLeft(v) ?? 0), carrying, capacity };
  }
  const prev = (stop - 1 + n) % n;
  return { stop, driving: true, wait: c.legs[prev] * restOfLeg(game, v, sts[prev], sts[stop], lens[prev]), carrying, capacity };
}

/** Какая доля перегона машине ещё осталась: на дороге — остаток маршрута, поезд — по прямой до станции. */
function restOfLeg(game: Game, v: FleetVehicle, from: Station, to: Station, length: number): number {
  const sim = v.simId !== null ? game.traffic.vehicles.get(v.simId) : undefined;
  if (sim) return clamp01((game.roads.routeLength(sim.route.slice(sim.routeIndex)) - sim.s) / Math.max(1, length));
  const spot = game.fleetSpot(v);
  if (spot && !spot.station) return clamp01(dist(spot.pos, to.fp.center) / Math.max(1, dist(from.fp.center, to.fp.center)));
  return 0.5;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0.5));

/**
 * Сколько есть что везти к горизонту: груз на борту, запас на станциях погрузки и выпуск их предприятий (поток
 * пассажиров) — поровну с другими станциями предприятия. Грузят и со склада пересадки — не ограничено (null).
 */
function supplyOf(game: Game, haul: Haul, plans: LinePlan[], horizon: number): Pick<Outlook, 'supply' | 'supplyRate'> {
  const loads = new Map<number, Station>();
  for (const p of plans) for (const st of p.loads) loads.set(st.id, st);
  const aboard = plans.reduce((s, p) => s + p.units.reduce((a, u) => a + u.carrying, 0), 0);
  let stock = 0;
  let rate = 0;
  if (haul.kind === 'cargo') {
    for (const st of loads.values()) {
      const src = sourceAt(game, st, haul);
      if (!src) return { supply: null, supplyRate: null };
      stock += src.stock;
      rate += src.rate;
    }
  } else {
    for (const st of loads.values()) {
      for (const n of st.passengers.values()) stock += n;
      // Пассажиры появляются на станции так же, как в игре (Game.paxArrivals): от жителей в охвате.
      rate += (st.catchPop / 1000) * 1.2 * (st.townIds.length ? game.mods.pax(st.townIds[0]) : 1);
    }
  }
  return { supply: aboard + stock + rate * horizon, supplyRate: rate };
}

/** Что довезут к горизонту машины линий, которые возят нужное (lines — какие линии смотреть; по умолчанию все). */
export function outlookOf(game: Game, haul: Haul, horizon: number, lines: Iterable<Line> = game.lines.values()): Outlook {
  const plans: LinePlan[] = [];
  for (const line of lines) {
    const plan = linePlan(game, line, haul);
    if (plan) plans.push(plan);
  }
  return { ...schedule(plans, horizon), ...supplyOf(game, haul, plans, horizon) };
}

/** Темп маршрута по одному грузу (или пассажирам): ожидаемый по циклу и когда первая доставка. */
export interface LinePace {
  cargo: CargoType | 'passengers';
  /** Ед. в минуту по циклу, не больше выпуска. */
  perMinute: number;
  /** Первая доставка через столько секунд; машин нет или не доедут за CARD_HORIZON — null. */
  first: number | null;
}

/** Горизонт для «первой доставки» в карточке маршрута — 20 минут игры: дольше любого срока задания. */
const CARD_HORIZON = 1200;

/**
 * Темп маршрута по циклу для его карточки — тем же расписанием, что прогноз заданий: по каждому грузу, который он
 * возит от производителя (или со склада) получателю, или по пассажирам.
 */
export function linePace(game: Game, line: Line): LinePace[] {
  const out: LinePace[] = [];
  const add = (cargo: LinePace['cargo'], haul: Haul) => {
    const o = outlookOf(game, haul, CARD_HORIZON, [line]);
    if (!o.vehicles) return;
    out.push({ cargo, perMinute: Math.max(0, Math.min(o.rate, o.supplyRate ?? Infinity)) * 60, first: o.first });
  };
  if (game.lineCarries(line) === 'passengers') {
    add('passengers', { kind: 'pax', towns: null });
    return out;
  }
  const cargos = new Set<CargoType>();
  for (const id of line.stops) {
    const st = game.stations.get(id);
    if (!st?.serves.cargo) continue;
    for (const ind of industriesAt(game, st)) cargos.add(ind.info.produces);
    for (const [c, n] of Object.entries(st.cargo) as [CargoType, number][]) if (n > 0) cargos.add(c);
  }
  for (const c of cargos) add(c, { kind: 'cargo', cargo: c, to: null });
  return out;
}
