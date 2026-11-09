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
 *   (reverseLanes), светофоры на концах (src/game/workSignals.ts). Бригада у самого узла — участок до конца полотна,
 *   съезд на открытую половину — на соседе за стыком (reverseSite, approachLanes) или перед перекрёстком.
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

/**
 * Перестройка оставляет прежнее полотно (c — полотно в стройке): тот же класс на той же оси — это расширение
 * («Перестроить» в больше полос, «Полоса»): прежний асфальт остаётся, стройка (отсыпка, покрытие) — только на
 * прибавке ширины за его кромкой, разметка — потом по всему полотну. Другой класс (переукладка: цена — работа по всей
 * длине, rebuildCost) и перенос — полотно перекладывают целиком. Не перестройка — false.
 */
export function keepsPavement(c: Corridor): boolean {
  const w = c.build?.was;
  return !!w && !w.moved && w.cls === c.cls;
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
 * первый кусок по ходу заполнения. Короткое полотно — 20 м посередине. Разрыто и в запасе у конца (бригада у самого
 * узла: в начале и в конце прохода) — участок до самого конца полотна (0 или длина): съезд на открытую половину тогда
 * — до узла (на соседе за стыком, reverseSite; у перекрёстка ждут перед ним).
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
  // Разрыто в запасе у конца — участок до конца полотна: иначе там, под техникой, ехали бы по прежней полосе.
  return [t0 - 5 < e0 + 1e-6 ? 0 : e0 + k0 * size, t1 + 5 > e1 - 1e-6 ? L : e0 + (k1 + 1) * size];
}

/** На столько метров участок под реверсом заходит на соседа за стыком (reverseSite): там уже одна полоса открытой половины. */
export const REACH = 5;

/**
 * Сосед за стыком, на котором съезжают на открытую половину, когда участок под реверсом дошёл до конца полотна:
 * его полотно и конец у стыка; k — ход его оси относительно оси перестраиваемого (1 — туда же, −1 — навстречу);
 * смещение вправо по его оси = base + k × смещение по оси перестраиваемого (как сходятся полосы в стыке).
 */
export interface Approach {
  corridor: Corridor;
  end: End;
  k: 1 | -1;
  base: number;
}

/** Сколько соседу нужно длины под съезд: заход участка, половина отгона (съезд) и место под очередь у стоп-линии. */
const approachLen = (n: Corridor) => REACH + taperLen(n.cls) / 2 + 20;

/** Перестройка «с проездом», где сейчас идут работы (перекрытие по полосам): у неё реверс. */
const reversing = (c: Corridor | undefined) => !!c && closureOf(c.build) === 'part' && laneWise(c.build);

/**
 * Сосед за стыком на конце end полотна c, где съезжают на открытую половину перед участком под реверсом, дошедшим до
 * стыка: стык ровно двух полотен (прямое продолжение), сосед открыт для движения (готов или его перестройка не начата)
 * и достаточно длинный (с реверсом и на другом его конце — вдвое). Нет такого — null: съезд и стоп-линия — у самого
 * узла (у стыка с другим соседом это направление на время работ у узла перекрыто — машины объезжают).
 */
export function approachAt(net: LaneNet, c: Corridor, end: End): Approach | null {
  const n = net.nodes.get(end === 'a' ? c.a : c.b);
  if (!n || n.kind !== 'seam' || net.isDeadEnd(n)) return null;
  const ends = net.ends(n);
  if (ends.length !== 2) return null;
  const me = ends.find((e) => e.corridor.id === c.id && e.end === end);
  const o = ends.find((e) => e !== me);
  if (!me || !o || o.corridor.id === c.id || o.side === me.side) return null;
  const other = o.corridor;
  if (other.build && closureOf(other.build) !== 'old') return null;
  const far = net.nodes.get(o.end === 'a' ? other.b : other.a);
  const twice = !!far && far.corridors.some((id) => id !== other.id && reversing(net.corridors.get(id)));
  if (other.length < approachLen(other) * (twice ? 2 : 1)) return null;
  return { corridor: other, end: o.end, k: (me.along * o.along) as 1 | -1, base: (me.port - o.port) * o.along };
}

/**
 * Реверс на полотне c («с проездом», laneWise) целиком: участок (reverseZone) и стоп-линии по оси c, и соседи за
 * стыками на концах, куда участок заходит, если дошёл до конца полотна (reach: [у a, у b]). Тогда участок и стоп-линия
 * той стороны — за концом полотна (меньше 0 или больше длины): по оси соседа (siteSpot). Карта, движение и светофоры
 * берут реверс отсюда.
 */
export interface ReverseSite {
  zone: [number, number];
  stops: [number, number];
  reach: [Approach | null, Approach | null];
}

export function reverseSite(net: LaneNet, c: Corridor, b: CorridorBuild): ReverseSite {
  const z = reverseZone(c, b, endCuts(net, c));
  const reach: [Approach | null, Approach | null] = [z[0] <= 0 ? approachAt(net, c, 'a') : null, z[1] >= c.length ? approachAt(net, c, 'b') : null];
  const zone: [number, number] = [reach[0] ? -REACH : z[0], reach[1] ? c.length + REACH : z[1]];
  return { zone, stops: reverseStops(c, b, zone, reach), reach };
}

/**
 * Точка оси c на s (за концами — на соседе за стыком из reach): полотно, место на его оси, ход его оси относительно c
 * и пересчёт смещения (смещение по его оси = base + k × смещение по c). Соседа там нет — конец полотна c.
 */
export function siteSpot(c: Corridor, reach: ReverseSite['reach'], s: number): { corridor: Corridor; s: number; k: 1 | -1; base: number } {
  const L = c.length;
  const r = s < 0 ? reach[0] : s > L ? reach[1] : null;
  if (!r) return { corridor: c, s: Math.max(0, Math.min(L, s)), k: 1, base: 0 };
  const d = Math.min(r.corridor.length, s < 0 ? -s : s - L);
  return { corridor: r.corridor, s: r.end === 'a' ? d : r.corridor.length - d, k: r.k, base: r.base };
}

/** Место sN на оси соседа r (у конца at полотна c) — по оси c (за её концом). */
export function siteS(c: Corridor, r: Approach, at: End, sN: number): number {
  const d = r.end === 'a' ? sN : r.corridor.length - sN;
  return at === 'a' ? -d : c.length + d;
}

/** Перекладываемая половина и полоса встречных на участке: какие полосы прежней дороги закрыты и куда съезжают. */
function reverseParts(c: Corridor, b: CorridorBuild): { side: 1 | -1; open: LaneSlot[]; work: LaneSlot[]; inner: LaneSlot | undefined; flows: (1 | -1)[] } {
  const w = b.was!;
  const old = fitLanes(w.lanes, w.len, c.length);
  const side = workSide(b);
  const onWork = (l: LaneSlot) => l.offset * side > 0.01;
  const open = old.filter((l) => !onWork(l));
  const work = old.filter(onWork);
  const inner = [...open].sort((p, q) => Math.abs(p.offset) - Math.abs(q.offset))[0];
  return { side, open, work, inner, flows: [...new Set(work.map((l) => l.flow))] };
}

/**
 * Полосы прежней дороги «с проездом» (laneWise) для движения при участке под реверсом zone: открытая половина —
 * целиком, на перекладываемой половине — полосы до участка и после него, и полоса встречных на участке — по ближней к
 * оси полосе открытой половины, в сторону закрытых (туда и обратно — по очереди, по светофорам; съезд на неё и назад —
 * отгоном, как у «кармашка»). Карта рисует прежнюю дорогу целиком, но только там, где её ещё не разрыли
 * (constructionArt, drawOldRoad).
 *
 * Съезд — до участка, а не на нём: граф движения (graph.ts) держит полосу ещё половину отгона за её концом, поэтому
 * закрытая полоса кончается на половину отгона раньше участка — на участок по ней не заехать (и съехать назад на неё
 * можно только за участком). Участок до конца полотна (zone за его концами — съезд на соседе) — закрытых полос у того
 * конца нет совсем.
 */
export function reverseLanes(c: Corridor, b: CorridorBuild, zone: [number, number]): LaneSlot[] {
  const { open, work, inner, flows } = reverseParts(c, b);
  const h = taperLen(b.was!.cls) / 2;
  const L = c.length;
  const out: LaneSlot[] = open.map((l) => ({ ...l }));
  const [z0, z1] = zone;
  for (const l of work) {
    const bare = { offset: l.offset, flow: l.flow };
    if (z0 > 0 && Math.min(l.to, z0 - h) - l.from >= 5) out.push({ ...bare, from: l.from, to: Math.min(l.to, z0 - h) });
    if (z1 < L && l.to - Math.max(l.from, z1 + h) >= 5) out.push({ ...bare, from: Math.max(l.from, z1 + h), to: l.to });
  }
  if (inner) for (const flow of flows) out.push({ offset: inner.offset, flow, from: Math.max(0, z0), to: Math.min(L, z1) });
  return out;
}

/**
 * Полосы соседа r за стыком на конце at перестраиваемого c (участок под реверсом zone заходит на него): полосы, что у
 * стыка продолжают перекладываемую половину, кончаются за половину отгона до захода участка, а у стыка — полоса
 * встречных по ближней к оси полосе открытой половины (туда съезжают перед стыком и с неё — после). lanes — полосы
 * соседа в сети движения.
 */
export function approachLanes(c: Corridor, b: CorridorBuild, zone: [number, number], r: Approach, at: End, lanes: readonly LaneSlot[]): LaneSlot[] {
  const { side, inner, flows } = reverseParts(c, b);
  const n = r.corridor;
  const LN = n.length;
  const h = taperLen(n.cls) / 2;
  const depth = Math.min(LN, at === 'a' ? -zone[0] : zone[1] - c.length);
  const out: LaneSlot[] = [];
  for (const l of lanes) {
    // Смещение по оси c: на перекладываемой ли половине.
    if ((l.offset - r.base) * r.k * side <= 0.01) {
      out.push({ ...l });
      continue;
    }
    if (r.end === 'a') {
      const from = Math.max(l.from, depth + h);
      if (l.to - from >= 5) out.push({ ...l, from });
    } else {
      const to = Math.min(l.to, LN - depth - h);
      if (to - l.from >= 5) out.push({ ...l, to });
    }
  }
  if (inner) {
    const offset = r.base + r.k * inner.offset;
    for (const flow of flows) out.push({ offset, flow: (flow * r.k) as 1 | -1, from: r.end === 'a' ? 0 : LN - depth, to: r.end === 'a' ? depth : LN });
  }
  return out;
}

/**
 * Стоп-линии светофоров реверса по оси от a: [для идущих по оси (a→b), для идущих против]. Перед съездом на открытую
 * половину (половина отгона и 3 м) — с обеих сторон участка; съезд на соседе за стыком (reach) — на соседе (за концом
 * оси c), участок до конца полотна без соседа — у самого узла (0 или длина).
 */
export function reverseStops(c: Corridor, b: CorridorBuild, zone: [number, number], reach: ReverseSite['reach'] = [null, null]): [number, number] {
  const d = (r: Approach | null) => taperLen(r ? r.corridor.cls : b.was!.cls) / 2 + 3;
  const s0 = zone[0] - d(reach[0]);
  const s1 = zone[1] + d(reach[1]);
  return [reach[0] ? s0 : Math.max(0, s0), reach[1] ? s1 : Math.min(c.length, s1)];
}
