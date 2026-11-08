import { minRadius } from '../core/bezier';
import { signKmh } from '../lanes/speedHover';
import type { Network, Segment } from '../world/network';
import { halfWidth, KMH_PER_UNIT, specKmh, specSpeed } from '../world/roadTypes';

/**
 * Допустимая скорость на ж/д пути — та же, по которой едут поезда (RailSim.segSpeed): предел пути (120 км/ч, если не
 * задан свой), а на изгибе — ниже, по самому крутому месту участка (v² = 5·R). Подъём и стрелки её не меняют: в гору
 * поезд медленнее сам (по своей тяге), стрелка только решает, куда можно свернуть.
 */

/** Предел скорости на изгибе радиуса r, ед./с. */
export const railCurveSpeed = (r: number) => Math.sqrt(5 * r);

/** Допустимая скорость на участке пути, ед./с. */
export function trackSpeed(s: Pick<Segment, 'spec' | 'curve'>): number {
  return Math.min(specSpeed(s.spec), railCurveSpeed(minRadius(s.curve)));
}

/** Точная допустимая скорость на участке, км/ч — по ней цвет на карте скоростей. */
export const trackKmhExact = (s: Pick<Segment, 'spec' | 'curve'>) => trackSpeed(s) * KMH_PER_UNIT;

/** Допустимая скорость подписью, км/ч — как на знаке у дороги: предел пути, а на изгибе — кратно 10 вниз. */
export const trackKmh = (s: Pick<Segment, 'spec' | 'curve'>) => signKmh(specKmh(s.spec), trackKmhExact(s));

/**
 * Путь под точкой p (верхний, если их там несколько, — его и видно) и на какой он там высоте; не на пути — null.
 * radius — запас к ширине пути.
 */
export function railUnder(net: Network, p: { x: number; y: number }, radius = 1): { seg: Segment; level: number } | null {
  let best: { seg: Segment; level: number } | null = null;
  let bestScore = Infinity;
  for (const seg of net.segmentsNear(p, radius + 40)) {
    if (seg.spec.cls !== 'rail') continue;
    const hit = seg.lut.closest(p);
    if (hit.d > halfWidth(seg.spec) + radius) continue;
    const level = net.levelAt(seg, hit.s);
    const score = hit.d - level * 100;
    if (score < bestScore) {
      bestScore = score;
      best = { seg, level };
    }
  }
  return best;
}

/**
 * Скорости под курсором на карте скоростей: road — дороги там (speedsUnder), к ним — путь под точкой. Путь на мосту или
 * эстакаде — поверх дороги (его и видно); на земле и в тоннеле — дорога поверх пути (переезд, тоннель под улицей).
 */
export function mapSpeedsUnder(net: Network, p: { x: number; y: number }, road: number[]): number[] {
  const rail = railUnder(net, p);
  if (!rail || (road.length && rail.level < 0.5)) return road;
  return [trackKmh(rail.seg)];
}
