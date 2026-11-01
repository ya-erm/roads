import { add, rightNormal, scale, Vec } from '../core/vec';
import { isTrunk, LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { Corridor, End, LaneNet, LaneNode, LaneSlot, taperLen } from './model';

export const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** Доля полной ширины полосы на s: 1 — полная, 0 — нет; на отгоне — плавно. */
export function laneShare(c: Corridor, l: LaneSlot, s: number): number {
  const T = Math.max(1, taperLen(c.cls));
  if (s < l.from - 1e-6) return smooth((s - (l.from - T)) / T);
  if (s > l.to + 1e-6) return smooth((l.to + T - s) / T);
  return 1;
}

/**
 * Поперечный отрезок полосы на s — [lo, hi] в смещениях от оси, или null, если её там нет.
 * На отгоне полоса сужается к оси полотна: у правой неподвижна левая кромка, у левой — правая.
 */
export function laneBand(c: Corridor, l: LaneSlot, s: number): [number, number] | null {
  const w = laneShare(c, l, s) * LANE_W;
  if (w < 0.05) return null;
  const h = LANE_W / 2;
  if (l.offset > 0.01) return [l.offset - h, l.offset - h + w];
  if (l.offset < -0.01) return [l.offset + h - w, l.offset + h];
  return [-w / 2, w / 2];
}

/** Крайние кромки полос на s: [левая, правая] в смещениях от оси; null — полос нет. */
export function edgesAt(c: Corridor, s: number): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const l of c.lanes) {
    const b = laneBand(c, l, s);
    if (!b) continue;
    lo = Math.min(lo, b[0]);
    hi = Math.max(hi, b[1]);
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Точка на s, смещённая вправо от оси на off. */
export function pointOff(c: Corridor, s: number, off: number): Vec {
  const p = c.lut.pointAt(s);
  return off ? add(p, scale(rightNormal(c.lut.tangentAt(s)), off)) : p;
}

/** Отметки вдоль оси на [s0, s1]: с шагом не больше step и все места, где меняется профиль. */
export function stations(c: Corridor, s0: number, s1: number, step = 4): number[] {
  const res: number[] = [];
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  for (let i = 0; i <= n; i++) res.push(s0 + ((s1 - s0) * i) / n);
  const T = taperLen(c.cls);
  for (const l of c.lanes) {
    for (const x of [l.from - T, l.from, l.to, l.to + T]) if (x > s0 + 0.1 && x < s1 - 0.1) res.push(x);
  }
  return res.sort((x, y) => x - y);
}

/** У магистралей и односторонних кромки нарисованы краской; у улиц — только бордюр. */
export const paintedEdges = (c: Corridor) => isTrunk(c.cls) || c.lanes.every((l) => l.flow === c.lanes[0].flow);

/** Знак «вправо от направления от узла» в смещениях полотна. */
export const awaySign = (end: End) => (end === 'a' ? 1 : -1);
/** s на расстоянии d от конца end. */
export const sFrom = (c: Corridor, end: End, d: number) => (end === 'a' ? d : c.length - d);
/** Направление «от узла» на расстоянии d от конца. */
export const awayAt = (c: Corridor, end: End, d: number): Vec => scale(c.lut.tangentAt(sFrom(c, end, d)), awaySign(end));

/** Полуширина асфальта на конце полотна (по большей стороне). */
export function halfAt(c: Corridor, end: End): number {
  const e = edgesAt(c, end === 'a' ? 0 : c.length);
  return e ? Math.max(-e[0], e[1]) + ROAD_MARGIN : 0;
}

/** Запас радиуса перекрёстка сверх ширины дорог — на скругление углов. */
const CORNER = 8;

/** Радиус перекрёстка: полотна подходят к нему не ближе, чтобы их края не налезали и углы были скруглены. */
export function junctionRadius(net: LaneNet, n: LaneNode): number {
  const ends = net.ends(n);
  if (n.kind !== 'junction' || ends.length < 2) return 0;
  const half = ends.map((e) => halfAt(e.corridor, e.end));
  let r = Math.max(...half) + CORNER;
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const cos = Math.max(-1, Math.min(1, ends[i].away.x * ends[j].away.x + ends[i].away.y * ends[j].away.y));
      const theta = Math.acos(cos);
      if (theta < Math.PI - 0.05) r = Math.max(r, (half[i] + half[j]) / 2 / Math.tan(theta / 2) + CORNER);
    }
  }
  const shortest = Math.min(...ends.map((e) => e.corridor.length));
  return Math.min(r, 80, shortest * 0.45);
}
