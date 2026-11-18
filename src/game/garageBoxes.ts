import { add, scale, sub, type Vec } from '../core/vec';
import type { TownBuilding } from '../world/entities';
import { CAR_SIZE, lotFrame } from '../world/houseAccess';
import { garagesPlan, yardLotOf, yardSpots } from '../world/yardLots';
import { carSpot, type CarSpot } from './garages';
import { path, reversed, type Leg } from './lotMoves';

export interface GarageBoxAccess {
  index: number;
  spot: CarSpot;
  center: Vec;
  dir: Vec;
  via: Vec[];
  exit: Leg[];
}

const cache = new WeakMap<TownBuilding, { fp: TownBuilding['fp']; face: TownBuilding['face']; list: GarageBoxAccess[] }>();

/** К каждому боксу — через общий въезд, по проезду и к его собственным воротам. */
export function garageBoxes(b: TownBuilding): GarageBoxAccess[] {
  const hit = cache.get(b);
  if (hit?.fp === b.fp && hit.face === b.face) return hit.list;
  const lot = yardLotOf(b);
  const entrance = lot?.boxes ? yardSpots(b, lot, CAR_SIZE.l).gate : null;
  if (!lot || !entrance) return [];
  const p = garagesPlan(b);
  const at = lotFrame(b);
  const o = at(0, 0);
  const down = sub(at(0, 1), o);
  const two = p.rows.length === 2;
  const aisle = two ? (p.rows[0].y + p.bd + p.rows[1].y) / 2 : (-b.fp.h / 2 + p.rows[0].y) / 2;
  const list: GarageBoxAccess[] = [];
  for (const [rowIndex, row] of p.rows.entries()) for (const x of row.xs) {
    const front = two && rowIndex === 0;
    const dir = scale(down, front ? -1 : 1);
    const door = at(x + p.bw / 2, front ? row.y + p.bd : row.y);
    const center = add(door, scale(dir, CAR_SIZE.l / 2 + 0.3));
    // Двоичные дроби не пересекаются с целыми ключами домов/стоянок; стабильны при загрузке.
    const key = b.id + (list.length + 1) / 256;
    const spot = carSpot(key, b, entrance, false, '#888888', CAR_SIZE.l);
    spot.inside = center;
    spot.spot = sub(door, scale(dir, CAR_SIZE.l / 2 + 0.4));
    spot.renderGate = { pos: door, dir, width: p.bw - 0.8 };
    spot.hideBox = { c: at(x + p.bw / 2, row.y + p.bd / 2), d: down, hl: p.bd / 2, hw: p.bw / 2 };
    const cx = x + p.bw / 2;
    const approach = sub(door, scale(dir, 5));
    const entryY = two ? p.rows[0].y + p.bd + 4 : -b.fp.h / 2 + 2;
    const via = Math.abs(cx - p.gate.x) < 9 && !front
      ? [spot.curbSide, at(p.gate.x, entryY), approach, center]
      : [spot.curbSide, at(p.gate.x, aisle), at(cx, aisle), approach, center];
    const incoming = path(via, 4.5, false, 5);
    list.push({ index: list.length, spot, center, dir, via, exit: [reversed(incoming, false, 6)] });
  }
  for (const box of list) box.spot.groupKeys = list.filter((other) => other !== box).map((other) => other.spot.key);
  cache.set(b, { fp: b.fp, face: b.face, list });
  return list;
}
