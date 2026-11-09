/**
 * Перекрытие дороги на время перестройки (режим «Со строительством», src/game/rebuild.ts): что из прежней дороги
 * открыто для движения, пока её перестраивают.
 *
 * - Работы не начаты (бригада ещё не дошла, done = 0) — прежняя дорога открыта целиком, как была.
 * - Начаты, перекрытие целиком — полотна нет в сети движения: машины объезжают (как у новой дороги в стройке).
 * - Начаты, по полосам (CorridorWas.part) на широкой (2+2 и шире) — открыта часть прежних полос (keptLanes, половина в
 *   каждую сторону) со скоростью зоны работ (CONSTRUCTION.rebuild.zone).
 * - Дорогу перенесли (moved) — прежней на месте уже нет: перекрыта сразу и целиком.
 * - Узкая двусторонняя (1+1, 2+1: половина полос оставила бы одно направление, reversible) «с проездом» (laneWise) —
 *   бригада перекладывает полотно половинами: первым проходом — правую по ходу заполнения, вторым (навстречу) —
 *   другую. Вне участка у бригады обе стороны открыты (за ней — уже новая половина, впереди — прежняя), на участке
 *   (reverseZone: куски по reverse.chunk м) — одна полоса открытой половины, по ней — по очереди в обе стороны
 *   (reverseLanes), светофоры на концах (src/game/workSignals.ts).
 */
import { CONSTRUCTION } from '../config';
import { nodeCuts } from './geometry';
import { type Corridor, type CorridorBuild, type End, type LaneNet, type LaneSlot, taperLen } from './model';

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
  // Пристройка полосы с краю — прежние полосы все на месте: перекрыто только место новой.
  if (w.edge) return fitLanes(w.lanes, w.len, c.length);
  // «С проездом» на узкой — открытая половина (на участке под реверсом по ней едут по очереди в обе стороны).
  if (laneWise(c.build)) {
    const side = workSide(c.build!);
    return fitLanes(w.lanes, w.len, c.length).filter((l) => l.offset * side <= 0.01);
  }
  const dead = (net.nodes.get(c.a)?.corridors.length ?? 0) < 2 || (net.nodes.get(c.b)?.corridors.length ?? 0) < 2;
  return keptLanes(fitLanes(w.lanes, w.len, c.length), dead);
}

/** Скорость по открытым полосам в зоне работ, км/ч: не выше прежней. */
export function zoneLimit(limit: number | undefined, classLimit: number): number {
  return Math.min(limit ?? classLimit, CONSTRUCTION.rebuild.zone);
}

// ---------- «С проездом» на узкой дороге: по половине полотна, реверс со светофорами ----------

/**
 * Двусторонняя дорога, где половина полос (keptLanes) оставила бы одно направление: 1+1, 2+1. Её «◐ с проездом» —
 * реверс по одной полосе, а не одностороннее движение с объездом обратно.
 */
export function reversible(lanes: readonly LaneSlot[]): boolean {
  if (!lanes.some((l) => l.flow > 0) || !lanes.some((l) => l.flow < 0)) return false;
  const kept = keptLanes(lanes);
  return !(kept.some((l) => l.flow > 0) && kept.some((l) => l.flow < 0));
}

/** Стройка — перестройка «с проездом» узкой дороги (◐ на 1+1, 2+1): полотно — половинами, по другой — реверс. */
export function laneWise(b: CorridorBuild | undefined): boolean {
  const w = b?.was;
  return !!w && !!w.part && !w.moved && !w.edge && reversible(w.lanes);
}

/**
 * Какую половину полотна перекладывают сейчас — знак смещения от оси: правую по ходу заполнения (бригада идёт по
 * своей стороне, как поток). Второй проход идёт навстречу первому (fromB наоборот) — и половина другая.
 */
export function workSide(b: CorridorBuild): 1 | -1 {
  return b.fromB ? -1 : 1;
}

/** Готовое «в метрах» у стройки «с проездом» (0…L, как платится): work — готовое нынешнего прохода; проход — половина. */
export function laneDone(pass2: boolean, work: number, L: number): number {
  return Math.min(L, (pass2 ? L / 2 : 0) + Math.max(0, work) / 2);
}

/** Обрезы полотна c у перекрёстков на концах a и b, м (площадка узла; у стыка и тупика — 0), как у отрисовки дорог. */
export function endCuts(net: LaneNet, c: Corridor): [number, number] {
  const cut = (id: number, end: End) => {
    const n = net.nodes.get(id);
    if (!n) return 0;
    const ends = net.ends(n);
    const cuts = nodeCuts(net, n, ends);
    let d = 0;
    ends.forEach((e, i) => {
      if (e.corridor.id === c.id && e.end === end) d = Math.max(d, cuts[i]);
    });
    return d;
  };
  return [cut(c.a, 'a'), cut(c.b, 'b')];
}

/** От края площадки узла до участка под реверсом: половина отгона прежней дороги (там съезжают на открытую половину) и место для машины перед стоп-линией. */
export const zoneMargin = (b: CorridorBuild) => taperLen(b.was!.cls) / 2 + 15;

/**
 * Участок под реверсом на полотне c («с проездом», laneWise), [s0, s1] по оси от a. Своё у полотна (без площадок
 * узлов, cuts — endCuts) за вычетом zoneMargin с каждой стороны делится на равные куски не длиннее reverse.chunk;
 * участок — куски, на которых сейчас разрыто (от разметки до отсыпки нынешнего прохода, с запасом 5 м). Не начато —
 * первый кусок по ходу заполнения. Короткое полотно — 20 м посередине.
 */
export function reverseZone(c: Corridor, b: CorridorBuild, cuts: [number, number]): [number, number] {
  const K = CONSTRUCTION.rebuild.reverse;
  const L = c.length;
  const lo0 = Math.max(0, cuts[0]);
  const hi0 = L - Math.max(0, cuts[1]);
  const m = zoneMargin(b);
  let e0 = lo0 + m;
  let e1 = hi0 - m;
  if (e1 - e0 < 20) {
    const mid = (lo0 + hi0) / 2;
    e0 = Math.max(Math.min(1, L / 2), mid - 10);
    e1 = Math.min(Math.max(L - 1, L / 2), mid + 10);
  }
  const n = Math.max(1, Math.ceil((e1 - e0) / K.chunk - 1e-6));
  const size = (e1 - e0) / n;
  const st = b.stages ?? [0, 0, 0];
  const clamp = (x: number) => Math.max(0, Math.min(L, x));
  // Разрыто — от разметки (позади) до отсыпки (впереди), по ходу заполнения; в осях от a.
  const along = (x: number) => (b.fromB ? L - clamp(x) : clamp(x));
  const t0 = Math.min(along(st[2]), along(st[0]));
  const t1 = Math.max(along(st[2]), along(st[0]));
  const idx = (s: number) => Math.max(0, Math.min(n - 1, Math.floor((s - e0) / size)));
  const k0 = idx(t0 - 5);
  const k1 = idx(t1 + 5);
  return [e0 + k0 * size, e0 + (k1 + 1) * size];
}

/**
 * Полосы прежней дороги «с проездом» (laneWise) для движения при участке под реверсом zone: открытая половина —
 * целиком, на перекладываемой половине — полосы до участка и после него, и полоса встречных на участке — по ближней к
 * оси полосе открытой половины, в сторону закрытых (туда и обратно — по очереди, по светофорам; съезд на неё и назад —
 * отгоном, как у «кармашка»). Карта рисует прежнюю дорогу целиком, но только там, где её ещё не разрыли
 * (constructionArt, drawOldRoad).
 */
export function reverseLanes(c: Corridor, b: CorridorBuild, zone: [number, number]): LaneSlot[] {
  const w = b.was!;
  const old = fitLanes(w.lanes, w.len, c.length);
  const side = workSide(b);
  const onWork = (l: LaneSlot) => l.offset * side > 0.01;
  const open = old.filter((l) => !onWork(l));
  const out: LaneSlot[] = open.map((l) => ({ ...l }));
  const [z0, z1] = zone;
  for (const l of old.filter(onWork)) {
    const bare = { offset: l.offset, flow: l.flow };
    if (Math.min(l.to, z0) - l.from >= 5) out.push({ ...bare, from: l.from, to: Math.min(l.to, z0) });
    if (l.to - Math.max(l.from, z1) >= 5) out.push({ ...bare, from: Math.max(l.from, z1), to: l.to });
  }
  const inner = [...open].sort((p, q) => Math.abs(p.offset) - Math.abs(q.offset))[0];
  const flows = [...new Set(old.filter(onWork).map((l) => l.flow))];
  if (inner) for (const flow of flows) out.push({ offset: inner.offset, flow, from: z0, to: z1 });
  return out;
}

/**
 * Стоп-линии светофоров реверса по оси от a: [для идущих по оси (a→b), для идущих против]. Перед съездом на открытую
 * половину (половина отгона и 3 м) — с обеих сторон участка.
 */
export function reverseStops(c: Corridor, b: CorridorBuild, zone: [number, number]): [number, number] {
  const d = taperLen(b.was!.cls) / 2 + 3;
  return [Math.max(0.5, zone[0] - d), Math.min(c.length - 0.5, zone[1] + d)];
}
