/**
 * Как выглядят вагоны поезда: груз занимает их по порядку от головы, на стоянке
 * вагоны наполняются и пустеют по очереди — в темпе погрузки, а не скачком.
 * Пассажиры — во всех вагонах сразу и поровну.
 */

/** Единиц груза в секунду: стоянка длится 0.1 с на каждую погруженную или выгруженную единицу. */
export const WAGON_RATE = 10;

const EPS = 1e-6;

/**
 * Доли заполнения вагонов (0..1) от головы к хвосту: amount из capacity делится поровну
 * на wagons вагонов. 60 из 120 на 4 вагона — [1, 1, 0, 0]; 70 из 120 — [1, 1, 0.33, 0].
 */
export function wagonFills(amount: number, capacity: number, wagons: number): number[] {
  const n = Math.max(0, Math.floor(wagons));
  const out: number[] = new Array(n).fill(0);
  if (!n || !(capacity > 0) || !(amount > 0)) return out;
  const per = capacity / n;
  for (let i = 0; i < n; i++) {
    const f = (amount - i * per) / per;
    out[i] = f >= 1 - EPS ? 1 : f <= EPS ? 0 : f;
  }
  return out;
}

/**
 * Доли заполнения вагонов состава kind по доле вместимости fill: груз — по порядку от головы (wagonFills),
 * пассажиры рассаживаются по всем вагонам поровну — входят и выходят во все двери сразу.
 */
export function trainWagonFills(fill: number, wagons: number, kind: 'freight' | 'passenger'): number[] {
  if (kind === 'freight') return wagonFills(fill, 1, wagons);
  const f = Math.max(0, Math.min(1, Number.isFinite(fill) ? fill : 0));
  return new Array(Math.max(0, Math.floor(wagons))).fill(f <= EPS ? 0 : f >= 1 - EPS ? 1 : f);
}

/** Вид вагонов поезда; хранится в самом поезде. */
export interface WagonLook {
  /** Цвет груза в вагонах; пустые и пассажирские — нет. */
  load?: string;
  /** Насколько заполнен состав на вид: доля вместимости 0..1. Нет — ещё не показывали. */
  fill?: number;
  /** До какой доли вагоны сперва пустеют (выгрузка на остановке), прежде чем начнётся погрузка. */
  dip?: number;
}

/**
 * Шаг анимации за dt секунд: вид догоняет настоящую загрузку target (доля вместимости capacity)
 * с грузом цвета color — WAGON_RATE единиц в секунду на каждый из streams потоков (пассажирский поезд —
 * по потоку на вагон, см. handlingStreams). Сначала выгрузка до dip, другой груз выгружается целиком,
 * потом погрузка. dt = Infinity (поезд в пути) — сразу как есть.
 */
export function stepWagons(look: WagonLook, target: number, color: string | undefined, capacity: number, dt: number, streams = 1): void {
  const goal = Math.max(0, Math.min(1, Number.isFinite(target) ? target : 0));
  if (look.fill === undefined || !Number.isFinite(dt) || !(capacity > 0)) {
    look.fill = goal;
    look.load = color;
    delete look.dip;
    return;
  }
  let left = (WAGON_RATE * Math.max(1, streams) * Math.max(0, dt)) / capacity;
  let fill = look.fill;
  /** Выгружает до доли to, сколько успеет; true — успела. */
  const empty = (to: number): boolean => {
    const go = Math.min(left, Math.max(0, fill - to));
    fill -= go;
    left -= go;
    return fill <= to + EPS;
  };
  if (look.dip !== undefined) {
    if (!empty(Math.max(0, look.dip))) {
      look.fill = fill;
      return;
    }
    delete look.dip;
  }
  if (look.load !== color) {
    if (!empty(0)) {
      look.fill = fill;
      return;
    }
    look.load = color;
  }
  look.fill = goal > fill ? Math.min(goal, fill + left) : Math.max(goal, fill - left);
}
