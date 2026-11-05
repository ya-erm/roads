import { IDM } from '../config';
import type { CurveLUT } from '../core/bezier';
import { angleDiff, angleOf, Vec } from '../core/vec';
import { curveProfile } from '../game/grade';
import type { GLane, LaneGraph } from './graph';

/**
 * Профиль скорости по полосе: на изгибе дороги машина едет не быстрее √(LATERAL·R) и тормозит
 * заранее, а на уклоне тяжёлые машины заметно теряют скорость (легковые — немного).
 */

/** Допустимое боковое ускорение на кривой — как у поворотов на перекрёстке. */
export const LATERAL = 9;
/** Шаг профиля вдоль полосы. */
export const PROFILE_STEP = 6;
/** Уклон, с которого считается профиль полотна по рельефу, — как у строителя дорог. */
const MAX_GRADE = 0.1;

export interface LaneProfile {
  /** Скорость с учётом изгибов и торможения перед ними, через PROFILE_STEP по полосе. */
  v: Float32Array;
  /** Уклон по ходу движения (положителен — в гору). */
  g: Float32Array;
  /** Предел только по изгибу в каждой точке (без торможения заранее) — для знаков на повороте. */
  c: Float32Array;
}

/** Скорость по кривизне на радиусе r. */
export const curveSpeed = (r: number) => Math.sqrt(LATERAL * r);

/** Радиус кривизны оси полотна около s (по повороту касательной на 2h). */
function radiusAt(tangentAt: (s: number) => Vec, s: number, length: number, h = 4): number {
  const a = Math.max(0, s - h);
  const b = Math.min(length, s + h);
  const turn = Math.abs(angleDiff(angleOf(tangentAt(a)), angleOf(tangentAt(b))));
  return turn < 1e-4 ? Infinity : (b - a) / turn;
}

/** Профиль полосы: скорость по изгибам с торможением и уклон по ходу (ground — отметка земли или null). */
export function buildLaneProfile(graph: LaneGraph, lane: GLane, ground: ((p: Vec) => number) | null): LaneProfile {
  const link = graph.links.get(lane.link)!;
  const c = graph.net.corridors.get(link.corridor);
  const n = Math.max(2, Math.ceil(lane.length / PROFILE_STEP) + 1);
  const v = new Float32Array(n);
  const g = new Float32Array(n);
  if (!c) {
    v.fill(lane.speed);
    return { v, g, c: v.slice() };
  }
  const at = (k: number) => graph.axisS(lane, Math.min(lane.length, k * PROFILE_STEP));
  for (let k = 0; k < n; k++) v[k] = Math.min(lane.speed, curveSpeed(radiusAt((s) => c.lut.tangentAt(s), at(k), c.length)));
  const curve = v.slice();
  // Тормозим заранее: к изгибу подъезжаем уже с его скоростью.
  for (let k = n - 2; k >= 0; k--) v[k] = Math.min(v[k], Math.sqrt(v[k + 1] * v[k + 1] + IDM.brake * PROFILE_STEP));
  const ground0 = ground && graph.net.node(c.a).level === 0 && graph.net.node(c.b).level === 0 ? ground : null;
  if (ground0) {
    const prof = curveProfile(c.lut, ground0, MAX_GRADE);
    for (let k = 0; k < n; k++) {
      const s = at(k);
      const i = Math.min(prof.z.length - 2, Math.floor(s / prof.ds));
      g[k] = ((prof.z[i + 1] - prof.z[i]) / prof.ds) * link.flow;
    }
  }
  return { v, g, c: curve };
}

/**
 * Пределы скорости по изгибам вдоль кривой (ось будущей дороги, ещё без полос и графа) — те же, что у полосы
 * (см. buildLaneProfile), без торможения заранее и уклонов: для знаков на поворотах проекта дороги.
 */
export function curveLimits(lut: CurveLUT, speed: number): LaneProfile {
  const n = Math.max(2, Math.ceil(lut.length / PROFILE_STEP) + 1);
  const c = new Float32Array(n);
  for (let k = 0; k < n; k++) c[k] = Math.min(speed, curveSpeed(radiusAt((s) => lut.tangentAt(s), Math.min(lut.length, k * PROFILE_STEP), lut.length)));
  return { v: c.slice(), g: new Float32Array(n), c };
}

/**
 * Участки, где изгиб снижает скорость ниже разрешённой: откуда (по полосе) и до скольки км/ч — шагом 10
 * (как на знаках). Совсем короткие и почти незаметные снижения не в счёт.
 */
export function curveZones(p: LaneProfile, laneSpeed: number, kmhPerUnit: number): { from: number; to: number; kmh: number }[] {
  const out: { from: number; to: number; kmh: number }[] = [];
  const limitKmh = laneSpeed * kmhPerUnit;
  let start = -1;
  let low = Infinity;
  for (let k = 0; k <= p.c.length; k++) {
    const slow = k < p.c.length && p.c[k] * kmhPerUnit < limitKmh - 5;
    if (slow) {
      if (start < 0) start = k;
      low = Math.min(low, p.c[k]);
    } else if (start >= 0) {
      const kmh = Math.max(10, Math.floor((low * kmhPerUnit) / 10) * 10);
      if (kmh < limitKmh) out.push({ from: start * PROFILE_STEP, to: k * PROFILE_STEP, kmh });
      start = -1;
      low = Infinity;
    }
  }
  return out;
}

/** Во сколько раз медленнее на уклоне g: тяжёлые в гору теряют много, легковые — немного; под гору тяжёлые сдерживаются. */
export function gradeFactor(g: number, heavy: boolean): number {
  if (g > 0) return heavy ? Math.max(0.35, 1 - 4 * g) : Math.max(0.6, 1 - 1.5 * g);
  return heavy ? Math.max(0.75, 1 + 1.5 * g) : 1;
}
