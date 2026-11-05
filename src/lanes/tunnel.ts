/**
 * Въезды в тоннели: где полотно уходит под землю (узел на земле, полотно от него — в слое тоннелей), стоит
 * портал. Машина, которая через него проезжает, рисуется по частям: что до портала — как на земле, что
 * за ним — под землёй (бледно), граница — ровно по линии портала, а не скачком всей машиной.
 */
import { add, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import { ROAD_MARGIN } from '../world/roadTypes';
import { edgesAt } from './geometry';
import { type LaneNet, layerOf } from './model';

export interface Portal {
  /** Середина линии портала (на оси полотна) и направление внутрь тоннеля. */
  pos: Vec;
  dir: Vec;
  /** Края проезда поперёк, м: вправо от dir (левый край — отрицательный), с обочиной. */
  left: number;
  right: number;
}

/** Порталы тоннелей сети: у каждого конца полотна-тоннеля, который выходит на землю. */
export function tunnelPortals(net: LaneNet): Portal[] {
  const res: Portal[] = [];
  for (const c of net.corridors.values()) {
    const la = net.node(c.a).level;
    const lb = net.node(c.b).level;
    if (layerOf(Math.min(la, lb), Math.max(la, lb)) !== -1) continue;
    for (const end of ['a', 'b'] as const) {
      if ((end === 'a' ? la : lb) < -0.25) continue;
      const s = end === 'a' ? 0 : c.length;
      const t = c.lut.tangentAt(s);
      const e = edgesAt(c, s) ?? edgesAt(c, end === 'a' ? Math.min(c.length, 1) : Math.max(0, c.length - 1));
      if (!e) continue;
      // Поперёк — вправо от направления внутрь: у конца b оно против оси, края меняются местами.
      const [l, r] = end === 'a' ? e : [-e[1], -e[0]];
      res.push({ pos: c.lut.pointAt(s), dir: end === 'a' ? t : scale(t, -1), left: l - ROAD_MARGIN, right: r + ROAD_MARGIN });
    }
  }
  return res;
}

/**
 * Где кузов машины относительно портала: nose — нос, heading — куда смотрит, length — длина кузова.
 * 'split' — кузов на линии портала (часть уже под землёй), 'in' / 'out' — целиком за порталом или до него,
 * null — машина не на этом проезде (сбоку или далеко).
 */
export function portalSide(p: Portal, nose: Vec, heading: Vec, length: number): 'split' | 'in' | 'out' | null {
  const n = rightNormal(p.dir);
  const rear = sub(nose, scale(heading, length));
  const mid = scale(add(nose, rear), 0.5);
  const lat = dot(sub(mid, p.pos), n);
  if (lat < p.left - 1 || lat > p.right + 1) return null;
  const dn = dot(sub(nose, p.pos), p.dir);
  const dr = dot(sub(rear, p.pos), p.dir);
  if (Math.min(dn, dr) > length + 30 || Math.max(dn, dr) < -(length + 30)) return null;
  if (dn > 0 && dr > 0) return 'in';
  if (dn <= 0 && dr <= 0) return 'out';
  return 'split';
}

/**
 * Как рисовать машину у порталов — по её кузову, а не по слою движения (тот переключается с запасом, и на кадр-другой
 * машина целиком под землёй рисовалась бы яркой): 'split' — по частям по линии портала, 'in' — целиком под землёй,
 * 'out' — на земле. null — ни у одного портала (рисуют по слою). Из нескольких порталов — тот, где кузов на
 * линии, иначе ближайший.
 */
export function atPortals(portals: Portal[], nose: Vec, heading: Vec, length: number): { portal: Portal; side: 'split' | 'in' | 'out' } | null {
  let best: { portal: Portal; side: 'split' | 'in' | 'out' } | null = null;
  let bd = Infinity;
  for (const p of portals) {
    const side = portalSide(p, nose, heading, length);
    if (!side) continue;
    if (side === 'split') return { portal: p, side };
    const d = Math.abs(dot(sub(nose, p.pos), p.dir));
    if (d < bd) [bd, best] = [d, { portal: p, side }];
  }
  return best;
}

/**
 * Половина проезда у портала — для обрезки машины: side 1 — внутрь тоннеля, −1 — наружу; на depth метров от
 * линии портала и с запасом по бокам.
 */
export function portalHalf(p: Portal, side: 1 | -1, depth = 40): Vec[] {
  const n = rightNormal(p.dir);
  const a = add(p.pos, scale(n, p.left - 4));
  const b = add(p.pos, scale(n, p.right + 4));
  const d = scale(p.dir, side * depth);
  return [a, b, add(b, d), add(a, d)];
}
