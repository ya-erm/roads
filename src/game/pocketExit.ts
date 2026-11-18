import { dot, sub, scale, type Vec } from '../core/vec';
import { boxesOverlap, type Box } from '../lanes/curb';
import { lotFrame } from '../world/houseAccess';
import { yardLotOf, yardSpots } from '../world/yardLots';
import type { CarSpot } from './garages';
import { planYardExit } from './yardExit';
import type { Leg } from './lotMoves';

const plans = new WeakMap<CarSpot, Map<string, Leg[] | null>>();

/** Разворот в широком кармане: не пересекает бордюр до начала переднего выезда и не задевает соседние машины. */
export function pocketExit(spot: CarSpot, parked: { pos: Vec; dir: Vec }[], length: number, width: number) {
  const sig = `${JSON.stringify(spot.b.fp)}:${spot.b.face}:${length}:${width}:${parked.map((p) => `${p.pos.x},${p.pos.y}`).join(';')}`;
  let cache = plans.get(spot);
  if (!cache) plans.set(spot, cache = new Map());
  if (cache.has(sig)) return cache.get(sig)!;
  const lot = yardLotOf(spot.b);
  if (!lot) return null;
  const places = yardSpots(spot.b, lot, length);
  const index = -spot.key - 1 - spot.b.id * 64;
  const place = places.spots[index];
  const row = place && lot.rows[place.row];
  if (!row?.direct) return null;
  const at = lotFrame(spot.b);
  const o = at(0, 0);
  const x = sub(at(1, 0), o);
  const y = sub(at(0, 1), o);
  const cy = dot(sub(spot.d.curb, o), y);
  const lo = Math.min(cy, row.pad.y);
  const hi = Math.max(cy, row.pad.y + row.pad.h);
  const obstacles = parked.map((p) => ({ c: sub(p.pos, scale(p.dir, length / 2)), d: p.dir, hl: length / 2 + 0.15, hw: width / 2 + 0.15 }));
  const clear = (box: Box) => {
    for (const a of [-1, 1]) for (const s of [-1, 1]) {
      const p = { x: box.c.x + a * box.d.x * box.hl - s * box.d.y * box.hw, y: box.c.y + a * box.d.y * box.hl + s * box.d.x * box.hw };
      const rel = sub(p, o);
      const u = dot(rel, x);
      const v = dot(rel, y);
      if (u < row.pad.x || u > row.pad.x + row.pad.w || v < lo || v > hi) return false;
    }
    return !obstacles.some((b) => boxesOverlap(b, box));
  };
  const result = planYardExit({ c: spot.spot, h: spot.d.dir }, { c: spot.curbSide, h: scale(spot.d.dir, -1) }, length, width, clear);
  if (cache.size > 16) cache.clear();
  cache.set(sig, result);
  return result;
}
