/**
 * Прогноз накопительного задания — «перевезти N груза или пассажиров к сроку»: сколько будет к сроку, если ничего
 * не менять. Грубо, без моделирования пробок: темп доставок за последние минуты × оставшееся время. Темп каждой
 * линии пересчитывается на её нынешний парк — добавили машину, и прогноз растёт сразу, а не через пару рейсов.
 * У остальных заданий прогноза нет: месячные засчитываются по календарному месяцу (их шкала — уже темп этого
 * месяца), а рост города, уровень предприятия и подключения доставками не прикинуть.
 */
import type { CargoType } from '../world/cargo';
import { makerKey, pairKey, receiverKey } from './objectives';
import type { ObjectiveParams, Ref } from './types';

/** Окно темпа, секунд игры (3 мин): длиннее — прогноз спокойнее, короче — быстрее замечает перемены. */
export const PACE_WINDOW = 180;
/** Наблюдаем меньше минуты — прогноза нет: по паре первых рейсов он скачет. */
export const PACE_MIN = 60;
/**
 * Добавленные машины засчитываются не больше чем вдвое к прежнему парку линии, пока не покажут себя рейсами:
 * груза у предприятия может на всех и не хватить. Окно сдвинется — темп будет уже по ним.
 */
export const PACE_BOOST = 2;

/** Доставка: когда, какой линией (null — неизвестно), сколько и в какие счётчики заданий легла (`paceKey`). */
export interface Arrival {
  t: number;
  line: number | null;
  amount: number;
  keys: readonly string[];
}

/** Замер парка: сколько машин на каждой линии (id → число). */
export interface FleetSample {
  t: number;
  n: ReadonlyMap<number, number>;
}

/** Ключ счётчика задания для темпа — тот же счётчик, что у прогресса (`counterOf`); без прогноза — null. */
export function paceKey(p: ObjectiveParams): string | null {
  if (p.kind === 'deliver') {
    if (p.to) return `to:${receiverKey(p.to, p.cargo)}`;
    if (p.from !== undefined) return `from:${makerKey(p.from, p.cargo)}`;
    return `cargo:${p.cargo}`;
  }
  if (p.kind === 'passengers') return p.towns ? `pair:${pairKey(p.towns[0], p.towns[1])}` : 'pax';
  return null;
}

/** Ключи доставки груза: сам груз, получатель и предприятие, откуда его везли (как в `Scenario.onDelivered`). */
export function cargoKeys(cargo: CargoType, receiver: Ref | null, maker?: number): string[] {
  const keys = [`cargo:${cargo}`];
  if (receiver) keys.push(`to:${receiverKey(receiver, cargo)}`);
  if (maker !== undefined) keys.push(`from:${makerKey(maker, cargo)}`);
  return keys;
}

/** Ключи поездки пассажиров: все пассажиры и пара городов, если ехали между разными (как в `Scenario.onPassengers`). */
export function paxKeys(from: number | undefined, to: number | undefined): string[] {
  return from !== undefined && to !== undefined && from !== to ? ['pax', `pair:${pairKey(from, to)}`] : ['pax'];
}

/** Наблюдения для темпа. */
export interface PaceData {
  readonly arrivals: readonly Arrival[];
  readonly fleet: readonly FleetSample[];
  /** С какого времени идут наблюдения; null — ещё ни одного замера. */
  readonly since: number | null;
}

/**
 * Темп доставок по счётчику key, единиц в секунду: за окно (до PACE_WINDOW, с начала наблюдений), по каждой линии —
 * доставлено за время, пока у неё были машины, на машину × машин сейчас (добавленные — не больше PACE_BOOST к прежнему
 * парку). Наблюдаем меньше PACE_MIN — null.
 */
export function paceOf(key: string, data: PaceData, now: number, fleetNow: (line: number) => number): number | null {
  if (data.since === null) return null;
  const span = Math.min(PACE_WINDOW, now - data.since);
  if (span < PACE_MIN) return null;
  const from = now - span;
  const byLine = new Map<number | null, number>();
  for (const a of data.arrivals) if (a.t > from && a.keys.includes(key)) byLine.set(a.line, (byLine.get(a.line) ?? 0) + a.amount);
  let rate = 0;
  for (const [line, amount] of byLine) {
    if (line === null) {
      rate += amount / span;
      continue;
    }
    // Парк линии за окно — с первого замера, где у неё были машины: новая линия не размывается временем, когда её не было.
    let start: number | null = null;
    let first: number | null = null;
    let sum = 0;
    let count = 0;
    for (const s of data.fleet) {
      if (s.t < from) continue;
      start ??= s.t;
      const n = s.n.get(line) ?? 0;
      if (first === null && n <= 0) continue;
      first ??= s.t;
      sum += n;
      count++;
    }
    const avg = count ? sum / count : 0;
    // Машины были с начала окна — всё окно; появились позже — с тех пор, но не меньше минуты.
    const active = first === null || first === start ? span : Math.max(PACE_MIN, now - first);
    const n = fleetNow(line);
    const k = avg > 0 ? Math.min(n / avg, PACE_BOOST) : n > 0 ? 1 : 0;
    rate += (amount / active) * k;
  }
  return rate;
}

/** Доставки и замеры парка за окно темпа — в памяти, не в сохранении: после загрузки прогноз появится через минуту. */
export class PaceLog implements PaceData {
  readonly arrivals: Arrival[] = [];
  readonly fleet: FleetSample[] = [];
  since: number | null = null;
  /** Время последнего замера — «сейчас» прогноза: он меняется раз в замер, а не каждый кадр. */
  at = 0;

  add(a: Arrival): void {
    this.arrivals.push(a);
    this.prune(a.t);
  }

  sample(t: number, n: ReadonlyMap<number, number>): void {
    this.since ??= t;
    this.at = t;
    this.fleet.push({ t, n });
    this.prune(t);
  }

  rate(key: string, fleetNow: (line: number) => number): number | null {
    return paceOf(key, this, this.at, fleetNow);
  }

  private prune(now: number): void {
    const from = now - PACE_WINDOW;
    dropBefore(this.arrivals, from);
    dropBefore(this.fleet, from);
  }
}

/** Убрать из начала списка (он по времени) то, что не позже from. */
function dropBefore(list: { t: number }[], from: number): void {
  let i = 0;
  while (i < list.length && list[i].t <= from) i++;
  if (i) list.splice(0, i);
}

export interface Forecast {
  /** Сколько будет к сроку (в единицах цели). */
  value: number;
  /** Доля цели к сроку, 0…1 — конец синей части шкалы. */
  fraction: number;
  /** Успеваем: прогноз не меньше цели. */
  reach: boolean;
  /** Темп и сколько нужно в минуту, чтобы успеть (null — срок вышел), единиц в минуту. */
  perMinute: number;
  need: number | null;
}

/** Прогноз к сроку: сделано + темп (единиц в секунду) × оставшиеся секунды. */
export function forecastOf(progress: number, target: number, left: number, rate: number): Forecast {
  const value = progress + Math.max(0, rate) * Math.max(0, left);
  return {
    value,
    fraction: Math.max(0, Math.min(1, value / Math.max(1, target))),
    reach: value >= target,
    perMinute: Math.max(0, rate) * 60,
    need: left > 0 ? (Math.max(0, target - progress) / left) * 60 : null,
  };
}

const num = (n: number) => Math.round(n).toLocaleString('ru-RU');
/** Темп коротко: от 10 — целыми, меньше — с десятыми («2,5»). */
const paceText = (n: number) => (n >= 10 || n === 0 ? num(n) : (Math.round(n * 10) / 10).toLocaleString('ru-RU'));

/** Подсказка к шкале: «Прогноз к сроку: ~N (темп M в мин)» — и успеваем ли, а нет — сколько нужно. */
export function forecastTip(f: Forecast): string {
  const head = `Прогноз к сроку: ~${num(f.value)} (темп ${paceText(f.perMinute)} в мин)`;
  if (f.reach) return `${head} — успеваем`;
  return f.need !== null ? `${head}. Чтобы успеть — ${paceText(f.need)} в мин` : head;
}
