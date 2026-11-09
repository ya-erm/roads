/**
 * Перекрытие дороги на время перестройки (режим «Со строительством», src/game/rebuild.ts): что из прежней дороги
 * открыто для движения, пока её перестраивают.
 *
 * - Работы не начаты (бригада ещё не дошла, done = 0) — прежняя дорога открыта целиком, как была.
 * - Начаты, перекрытие целиком — полотна нет в сети движения: машины объезжают (как у новой дороги в стройке).
 * - Начаты, по полосам (CorridorWas.part) — открыта часть прежних полос (keptLanes) со скоростью зоны работ
 *   (CONSTRUCTION.rebuild.zone): на 1+1 — одна полоса в одну сторону, обратно — объезд.
 * - Дорогу перенесли (moved) — прежней на месте уже нет: перекрыта сразу и целиком.
 */
import { CONSTRUCTION } from '../config';
import type { Corridor, CorridorBuild, LaneNet, LaneSlot } from './model';

/** Что открыто на полотне в стройке: old — прежняя дорога целиком, part — часть её полос, closed — ничего. */
export type Closure = 'old' | 'part' | 'closed';

/** Что открыто на строящемся полотне со стройкой b; не перестройка (новая дорога) — null: её в сети движения нет. */
export function closureOf(b: CorridorBuild | undefined): Closure | null {
  const w = b?.was;
  if (!w) return null;
  if (w.moved) return 'closed';
  if (b.done <= 0) return 'old';
  return w.part ? 'part' : 'closed';
}

/** Перекрытие активно: работы идут, и часть дороги (или вся) закрыта. */
export function closed(b: CorridorBuild | undefined): boolean {
  const k = closureOf(b);
  return k === 'part' || k === 'closed';
}

/**
 * Полосы прежней дороги, открытые при перекрытии по полосам: в каждую сторону — половина (вверх) у оси, если полос
 * в эту сторону две и больше; сторона с одной полосой закрыта. Не осталось ни одной — одна полоса той стороны, где
 * полос больше (поровну — по ходу оси a→b), ближняя к оси: на 1+1 — движение в одну сторону. both — дорога в тупик
 * (развернуться негде): в каждую сторону, где были полосы, остаётся хоть одна.
 */
export function keptLanes(lanes: readonly LaneSlot[], both = false): LaneSlot[] {
  const keep = new Set<LaneSlot>();
  const sides = ([1, -1] as const).map((flow) => lanes.filter((l) => l.flow === flow).sort((p, q) => Math.abs(p.offset) - Math.abs(q.offset)));
  for (const side of sides) if (side.length >= 2 || (both && side.length)) for (const l of side.slice(0, Math.ceil(side.length / 2))) keep.add(l);
  if (!keep.size) {
    const side = sides[1].length > sides[0].length ? sides[1] : sides[0];
    if (side[0]) keep.add(side[0]);
  }
  return lanes.filter((l) => keep.has(l));
}

/**
 * Полосы, заданные на полотне длиной from, — на полотне длиной to: как у setCurve, полоса от самого начала (до самого
 * конца) остаётся от начала (до конца), остальное растягивается.
 */
export function fitLanes(lanes: readonly LaneSlot[], from: number, to: number): LaneSlot[] {
  const k = from > 0 ? to / from : 1;
  return lanes.map((l) => ({ ...l, from: l.from <= 0.01 ? 0 : l.from * k, to: l.to >= from - 0.01 ? to : l.to * k }));
}

/**
 * Прежние полосы перестраиваемого полотна c (в сети net), открытые при перекрытии по полосам: keptLanes, а у улицы в
 * тупик — в обе стороны.
 */
export function partLanes(net: LaneNet, c: Corridor): LaneSlot[] {
  const w = c.build?.was;
  if (!w) return [];
  const dead = (net.nodes.get(c.a)?.corridors.length ?? 0) < 2 || (net.nodes.get(c.b)?.corridors.length ?? 0) < 2;
  return keptLanes(fitLanes(w.lanes, w.len, c.length), dead);
}

/** Скорость по открытым полосам в зоне работ, км/ч: не выше прежней. */
export function zoneLimit(limit: number | undefined, classLimit: number): number {
  return Math.min(limit ?? classLimit, CONSTRUCTION.rebuild.zone);
}
