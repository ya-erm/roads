import { add, dist, dot, rightNormal, scale, sub } from '../core/vec';
import type { Corridor, LaneNet } from '../lanes/model';
import type { TownBuilding } from './entities';
import { LOT_SETBACK } from './houseAccess';
import { lotClearOfRoads } from './lotClear';
import { isTrunk, WALK_EDGE } from './roadTypes';
import { FootprintIndex, type Footprint } from './spatial';
import { anchorFor, halfAtS, placeable, streetFace, type WorldContext } from './worldgen';

/** Какой интервал кривой прежнего полотна занял новый участок. */
export interface StreetPart {
  old: Corridor;
  next: Corridor;
  from: number;
  to: number;
}

export interface HouseMove {
  id: number;
  fp: Footprint;
  anchor: number;
  face: 1 | -1;
}

function frontage(net: LaneNet, b: TownBuilding) {
  const axis = { x: Math.cos(b.fp.angle), y: Math.sin(b.fp.angle) };
  const away = scale(rightNormal(axis), -(b.face ?? streetFace(net, b.fp)));
  const front = add(b.fp.center, scale(away, -b.fp.h / 2));
  let best: { street: Corridor; t: number; side: 1 | -1; gap: number } | undefined;
  for (const street of net.corridorsNear(front, 55)) {
    if (!groundStreet(net, street)) continue;
    const hit = street.lut.closest(front);
    if (hit.s < 1 || hit.s > street.length - 1) continue;
    const tangent = street.lut.tangentAt(hit.s);
    if (Math.abs(dot(axis, tangent)) < 0.9 || dot(sub(front, hit.point), away) <= 0) continue;
    const side = dot(away, rightNormal(tangent)) > 0 ? 1 : -1;
    const gap = hit.d - halfAtS(street, hit.s);
    if (gap < -2 || gap > LOT_SETBACK + 10 || (best && best.gap <= gap)) continue;
    best = { street, t: hit.t, side, gap };
  }
  return best;
}

function groundStreet(net: LaneNet, c: Corridor): boolean {
  return !c.ring && !isTrunk(c.cls) && net.node(c.a).level === 0 && net.node(c.b).level === 0;
}

/**
 * Принадлежность дома определяем по фасаду до правки. Сначала освобождаем прежние места всех переносимых домов,
 * затем занимаем новые по порядку вдоль улицы. Готовые контуры и снос входят в тот же план, что и изменение дороги.
 */
export function planStreetHouses(
  ctx: WorldContext,
  before: LaneNet,
  parts: readonly StreetPart[],
  demolish: Set<number>,
  reserved: readonly Footprint[],
  blocked: (fp: Footprint) => boolean,
): HouseMove[] {
  const { roads, index } = ctx;
  const byStreet = new Map<number, StreetPart[]>();
  const candidates = new Set<TownBuilding>();
  for (const part of parts) {
    const siblings = byStreet.get(part.old.id);
    if (siblings) {
      siblings.push(part);
      continue;
    }
    byStreet.set(part.old.id, [part]);
    for (const b of index.near(part.old.lut.pointAt(part.old.length / 2), part.old.length / 2 + 100)) {
      if (b.type === 'building' && b.kind !== 'landmark' && !b.rear) candidates.add(b);
    }
  }
  const eligible = [...candidates].flatMap((b) => {
    const own = frontage(before, b);
    if (!own) return [];
    const streetParts = byStreet.get(own.street.id);
    const part = streetParts?.find(({ from, to }) => own.t >= from && own.t <= to);
    if (!part) return [];
    const prior = own.street.lut.frameAt(own.street.lut.sAtT(own.t));
    const s = part.next.lut.sAtT((own.t - part.from) / (part.to - part.from));
    const next = part.next.lut.frameAt(s);
    // Поделили на участки на месте или поменяли только профиль: домом занимается обычная перестройка улицы.
    if (dist(prior.point, next.point) < 0.35 && dot(prior.tangent, next.tangent) > 0.9999) return [];
    // Участок всё ещё вдоль той же оси, если дорогу лишь продлили или изменили её перья по прямой.
    const hit = part.next.lut.closest(prior.point);
    const room = b.fp.w / 2;
    if (hit.d < 0.35 && hit.s >= room && hit.s <= part.next.length - room && dot(prior.tangent, part.next.lut.tangentAt(hit.s)) > 0.9999) return [];
    return [{ b, part, own, s }];
  });
  eligible.sort((a, b) => a.part.next.id - b.part.next.id || a.own.side - b.own.side || a.s - b.s || a.b.id - b.b.id);
  const moving = new Set(eligible.map(({ b }) => b.id));
  const occupied = new FootprintIndex<{ fp: Footprint }>();
  for (const fp of reserved) occupied.add({ fp });
  const moves: HouseMove[] = [];
  for (const { b, part, own, s } of eligible) {
    const parts = byStreet.get(own.street.id)!;
    const nearby = parts.filter((p) => p !== part).sort((a, b) => Math.abs(own.t - (a.from + a.to) / 2) - Math.abs(own.t - (b.from + b.to) / 2));
    let fp: Footprint | null = null;
    for (const p of [part, ...nearby]) {
      const c = p.next;
      if (!groundStreet(roads, c)) continue;
      const fits = (fp: Footprint) =>
        !occupied.overlaps(fp, 2) &&
        placeable(ctx, fp, c.id, (item) => moving.has(item.id) || demolish.has(item.id)) &&
        lotClearOfRoads(roads, fp, WALK_EDGE) &&
        !blocked(fp);
      const at = p === part ? s : p.from > own.t ? 0 : c.length;
      fp = placeAlong(c, b.fp, at, own.side, Math.max(LOT_SETBACK, own.gap), fits);
      if (fp) break;
    }
    if (!fp) {
      demolish.add(b.id);
      continue;
    }
    occupied.add({ fp });
    demolish.delete(b.id);
    moves.push({ id: b.id, fp, anchor: anchorFor(roads, fp.center), face: own.side === 1 ? -1 : 1 });
  }
  return moves;
}

function placeAlong(street: Corridor, fp: Footprint, s: number, side: 1 | -1, gap: number, fits: (fp: Footprint) => boolean): Footprint | null {
  const start = fp.w / 2 + 1;
  const end = street.length - start;
  if (start > end) return null;
  const preferred = Math.min(end, Math.max(start, s));
  const at = (span: number): Footprint | null => {
    const { point, tangent } = street.lut.frameAt(span);
    const away = scale(rightNormal(tangent), side);
    const front = add(point, scale(away, halfAtS(street, span) + gap));
    let clearance = 0;
    for (const along of [-fp.w / 2, fp.w / 2]) {
      const hit = street.lut.closest(add(front, scale(tangent, along)));
      clearance = Math.max(clearance, halfAtS(street, hit.s) + WALK_EDGE + 0.3 - hit.d);
    }
    // На внутренней стороне изгиба, чтобы углы участка оставались за тротуаром.
    if (clearance > LOT_SETBACK) return null;
    const center = add(front, scale(away, fp.h / 2 + clearance));
    return { ...fp, center, angle: Math.atan2(tangent.y, tangent.x) };
  };
  const first = at(preferred);
  if (first && fits(first)) return first;
  const step = 4;
  for (let offset = step; preferred - offset > start || preferred + offset < end; offset += step) {
    for (const span of [preferred - offset, preferred + offset]) {
      if (span <= start || span >= end) continue;
      const candidate = at(span);
      if (candidate && fits(candidate)) return candidate;
    }
  }
  for (const span of [start, end]) {
    if (span === preferred) continue;
    const candidate = at(span);
    if (candidate && fits(candidate)) return candidate;
  }
  return null;
}
