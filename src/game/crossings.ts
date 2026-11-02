import { intersectCurves } from '../core/bezier';
import type { Vec } from '../core/vec';
import type { LaneNet } from '../lanes/model';
import type { Network } from '../world/network';
import { isRail } from '../world/roadTypes';

/**
 * Переезд: дорога пересекает путь в одном уровне. Узла здесь нет — дороги и пути в разных сетях;
 * переезд — точка на оси полотна и на пути. Подходит поезд — переезд закрыт, машины ждут перед ним;
 * на переезде машина — поезд тормозит.
 */
export interface LevelCrossing {
  corridor: number;
  /** Где на оси полотна. */
  s: number;
  rail: number;
  /** Где на пути. */
  railS: number;
  pos: Vec;
  closed: boolean;
  busy: boolean;
}

/** Все переезды: пересечения полотен с путями на одной высоте. */
export function findCrossings(roads: LaneNet, rail: Network): LevelCrossing[] {
  const res: LevelCrossing[] = [];
  for (const seg of rail.segments.values()) {
    if (!isRail(seg.spec)) continue;
    const xs = seg.lut.points.map((p) => p.x);
    const ys = seg.lut.points.map((p) => p.y);
    for (const c of roads.corridorsInBox(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))) {
      for (const h of intersectCurves(c.lut, seg.lut)) {
        if (Math.abs(roads.heightAt(c, h.s1) - rail.levelAt(seg, h.s2)) >= 0.3) continue;
        res.push({ corridor: c.id, s: h.s1, rail: seg.id, railS: h.s2, pos: h.point, closed: false, busy: false });
      }
    }
  }
  return res;
}
