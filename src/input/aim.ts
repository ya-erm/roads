import { add, dot, len, scale, sub, Vec } from '../core/vec';
import type { Snap } from '../game/build';
import type { Anchor } from '../lanes/edit';
import type { LaneNet } from '../lanes/model';
import type { Network } from '../world/network';

/** Ближе этого к началу конец не прилипает: короткий участок поворачивают свободно. */
const AIM_MIN = 20;
/** На сколько (рад) направление может отличаться от «прямо» или 90°, чтобы прилипнуть. */
const AIM_TOL = 0.1;

/**
 * Прямая от дороги прилипает к её продолжению (180°) или перпендикуляру (90°): конец из p — на ближайшее из
 * направлений refs и их перпендикуляров, если курсор от него не дальше AIM_TOL и дальше AIM_MIN от начала.
 * null — не прилипает (конец — под курсором). Общая для «Дороги», «Ж/д» и их режима «Проект».
 */
export function aimAlong(from: Vec, p: Vec, refs: readonly Vec[]): { pos: Vec; hint: string } | null {
  const d = sub(p, from);
  const l = len(d);
  if (l <= AIM_MIN) return null;
  const dir = scale(d, 1 / l);
  let best: { v: Vec; hint: string; cos: number } | null = null;
  for (const ref of refs) {
    for (const [v, hint] of [
      [ref, 'прямо'],
      [{ x: -ref.y, y: ref.x }, '90°'],
      [{ x: ref.y, y: -ref.x }, '90°'],
    ] as const) {
      const c = dot(dir, v);
      if (c > Math.cos(AIM_TOL) && (!best || c > best.cos)) best = { v, hint, cos: c };
    }
  }
  return best && { pos: add(from, scale(best.v, l * best.cos)), hint: best.hint };
}

/** Направления «прямо» от точки на дорогах: продолжения дорог узла или вдоль полотна в обе стороны. */
export function roadDirs(net: LaneNet, a: Anchor): Vec[] {
  if (a.kind === 'node' && net.nodes.has(a.node)) return net.ends(net.node(a.node)).map((e) => scale(e.away, -1));
  if (a.kind === 'corridor' && net.corridors.has(a.corridor)) {
    const t = net.corridor(a.corridor).lut.tangentAt(a.s);
    return [t, scale(t, -1)];
  }
  return [];
}

/** Направления «прямо» от точки на путях: продолжения путей узла или вдоль разрезаемого пути в обе стороны. */
export function railDirs(net: Network, s: Snap): Vec[] {
  if (s.kind === 'node' && net.nodes.has(s.nodeId)) {
    return net.node(s.nodeId).segments.filter((id) => net.segments.has(id)).map((id) => scale(net.dirFrom(s.nodeId, id), -1));
  }
  if (s.kind === 'split' && net.segments.has(s.segId)) {
    const seg = net.segment(s.segId);
    const t = seg.lut.tangentAt(seg.lut.sAtT(s.t));
    return [t, scale(t, -1)];
  }
  return [];
}
