/**
 * График скорости маршрута: по пути круга (А→Б→…→А) — предел скорости в каждой точке (знак, изгиб,
 * манёвр на перекрёстке, подъём) и скорость, с которой по нему проедет машина: с места у остановки
 * разгоняется, перед изгибом и следующей остановкой заранее тормозит. Без пробок и светофоров —
 * как поедет одна машина по свободной дороге.
 */
import type { Vec } from '../core/vec';

/**
 * Участок пути с одним пределом: длина, предел скорости, уклон (положителен — в гору); from/to — где он
 * на карте (точки графика между ними — по прямой), чтобы показать на маршруте место с графика.
 */
export interface TrackPiece {
  length: number;
  cap: number;
  grade: number;
  from?: Vec;
  to?: Vec;
}

/** Участок круга между соседними остановками. */
export interface TrackLeg {
  pieces: TrackPiece[];
}

export interface SpeedChart {
  /** Расстояние от первой остановки до каждой точки. */
  d: Float64Array;
  /** Предел скорости в точке. */
  cap: Float64Array;
  /** Скорость машины в точке. */
  v: Float64Array;
  /** Отметка полотна относительно первой остановки (по уклонам). */
  z: Float64Array;
  /** Где точка на карте (NaN — участок без положения). */
  x: Float64Array;
  y: Float64Array;
  /** Где остановки: расстояние до остановки i; последнее — снова первая, конец круга. */
  stops: number[];
  length: number;
  /** Время в пути за круг (без стоянок). */
  time: number;
  /** Средняя скорость в пути: длина круга / время. */
  avg: number;
}

/** Как едет машина: top — её наибольшая скорость на уклоне, accel — разгон на уклоне, decel — торможение. */
export interface Motion {
  top: (grade: number) => number;
  accel: (grade: number) => number;
  decel: number;
}

/**
 * Скорость по пределам точек на отрезке, где машина в начале и в конце стоит: вперёд — разгон не
 * быстрее accel, назад — торможение не резче decel. a[i] — ускорение на шаге i → i+1.
 */
export function runSpeeds(d: ArrayLike<number>, cap: ArrayLike<number>, accel: ArrayLike<number>, decel: number): Float64Array {
  const n = d.length;
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) v[i] = Math.max(0, cap[i]);
  if (!n) return v;
  v[0] = 0;
  v[n - 1] = 0;
  for (let i = 1; i < n; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * accel[i - 1] * (d[i] - d[i - 1])));
  for (let i = n - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * decel * (d[i + 1] - d[i])));
  return v;
}

/** Время проезда при скорости v в точках d (между точками скорость меняется равномерно по времени). */
export function runTime(d: ArrayLike<number>, v: ArrayLike<number>): number {
  let t = 0;
  for (let i = 1; i < d.length; i++) {
    const ds = d[i] - d[i - 1];
    const vm = v[i] + v[i - 1];
    if (ds > 0) t += vm > 1e-6 ? (2 * ds) / vm : Infinity;
  }
  return t;
}

/** Шаг точек графика по пути. */
export const CHART_STEP = 6;

/** Круг по участкам между остановками: точки через CHART_STEP, на каждой остановке скорость — ноль. */
export function speedChart(legs: TrackLeg[], motion: Motion, step = CHART_STEP): SpeedChart | null {
  const d: number[] = [];
  const cap: number[] = [];
  const v: number[] = [];
  const z: number[] = [];
  const px: number[] = [];
  const py: number[] = [];
  const stops: number[] = [];
  let at = 0;
  let height = 0;
  for (const leg of legs) {
    stops.push(at);
    const ld: number[] = [0];
    const lc: number[] = [];
    const lg: number[] = [];
    const lz: number[] = [height];
    const start = leg.pieces.find((p) => p.length > 0)?.from;
    const lp: Vec[] = [start ?? NO_POS];
    // Каждый участок — точками через step; предел точки — участка, на котором она стоит.
    let s = 0;
    for (const p of leg.pieces) {
      if (!(p.length > 0)) continue;
      const k = Math.max(1, Math.round(p.length / step));
      for (let j = 1; j <= k; j++) {
        lc.push(p.cap);
        lg.push(p.grade);
        ld.push(s + (p.length * j) / k);
        height += (p.grade * p.length) / k;
        lz.push(height);
        lp.push(p.from && p.to ? lerp(p.from, p.to, j / k) : NO_POS);
      }
      s += p.length;
    }
    if (ld.length < 2) return null;
    // Предел в точке — по участку, который в неё входит; в начале — по первому. Машина едет не быстрее
    // и своей наибольшей скорости на этом уклоне.
    const lcap = [lc[0], ...lc];
    const grades = [lg[0], ...lg];
    const top = lcap.map((c, i) => Math.min(c, motion.top(grades[i])));
    const accel = lg.map((g) => motion.accel(g));
    const lv = runSpeeds(ld, top, accel, motion.decel);
    // Стык участков: последняя точка одного — первая следующего (остановка), её не повторяем.
    for (let i = d.length ? 1 : 0; i < ld.length; i++) {
      d.push(at + ld[i]);
      cap.push(lcap[i]);
      v.push(lv[i]);
      z.push(lz[i]);
      px.push(lp[i].x);
      py.push(lp[i].y);
    }
    at += s;
  }
  if (!legs.length || at <= 0) return null;
  stops.push(at);
  const D = Float64Array.from(d);
  const V = Float64Array.from(v);
  const time = runTime(D, V);
  return {
    d: D,
    cap: Float64Array.from(cap),
    v: V,
    z: Float64Array.from(z),
    x: Float64Array.from(px),
    y: Float64Array.from(py),
    stops,
    length: at,
    time,
    avg: Number.isFinite(time) && time > 0 ? at / time : 0,
  };
}

const NO_POS: Vec = { x: NaN, y: NaN };
const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Точка графика ближе всего к расстоянию d от первой остановки (d — по кругу). */
export function chartIndexAt(chart: SpeedChart, d: number): number {
  const { d: ds } = chart;
  let lo = 0;
  let hi = ds.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ds[mid] <= d) lo = mid;
    else hi = mid;
  }
  return Math.abs(ds[hi] - d) < Math.abs(d - ds[lo]) ? hi : lo;
}
