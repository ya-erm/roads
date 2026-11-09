/**
 * Перестройка готовой дороги в режиме «Со строительством» (числа — CONSTRUCTION.rebuild в config.ts, правила —
 * docs/DESIGN.md, «Перестройка и перекрытия»).
 *
 * Правка готовой дороги («Перестроить», «Полоса», «Двигать», проект с правками) сравнивается с прежней дорогой
 * (rebuildDiff). Небольшая — сразу, как в «Мгновенно»: ось сдвинулась не дальше shift (ширина полосы), полос не
 * прибавилось (меньше полос, другая разметка, скорость — это снос и знаки). Существенная (substantial) — проект стройки:
 * полотно получает Corridor.build с прежней дорогой (CorridorWas) — её строят бригады, как новую дорогу:
 * - цена (rebuildCost) — разница цен новой и прежней (как «Мгновенно») и работа: на месте — rework от цены новой за
 *   затронутые метры, перенесённое — relay от цены новой; платится по готовым метрам;
 * - время — доля work времени новой дороги: на месте inPlace за затронутую долю, перенос — целиком, не меньше minWork;
 *   перекрытие по полосам — ×partial; узкая (1+1, 2+1) «с проездом» — два прохода по половине полотна, каждый — ×pass,
 *   и бригада одна;
 * - движение (src/lanes/closure.ts, open.ts): до начала работ — по прежней дороге; работы идут — перекрыта целиком
 *   (объезд) или по полосам (половина прежних, скорость зоны работ; узкая — реверс по полосе у бригады со светофорами,
 *   src/game/workSignals.ts); перенесённая — перекрыта сразу;
 * - отмена проекта (revertRebuild) возвращает прежнюю дорогу (и узлы на прежние места), заплаченное — назад.
 */
import { CONSTRUCTION } from '../config';
import { CurveLUT, type Cubic } from '../core/bezier';
import type { Vec } from '../core/vec';
import { fitLanes } from '../lanes/closure';
import { splitCorridor, taperDeadLanes } from '../lanes/edit';
import { edgesAt, laneShare } from '../lanes/geometry';
import { type Corridor, type CorridorWas, type LaneNet, type LaneSlot, taperLen } from '../lanes/model';
import { LANE_W } from '../world/roadTypes';

/** Чем новая дорога отличается от прежней. */
export interface RebuildDiff {
  /** Наибольший сдвиг оси от прежней, м. */
  shift: number;
  /** Доля длины, ушедшая с прежней оси дальше CONSTRUCTION.rebuild.shift (0 — дорога на месте). */
  moved: number;
  /**
   * Метров, где полос (или ширины полотна) стало больше, — но не больше, чем прибавилось полосы (прибавка ширины в
   * полосах по длине): продлённый на 30 м конец полосы — 30 м, хоть отгон и сдвинулся вместе с ним.
   */
  widened: number;
  /** Другой класс дороги. */
  cls: boolean;
  /** Полотно смотрит навстречу прежнему (кусок разрезанной дороги): полосы прежней — зеркально. */
  flip: boolean;
}

/** Сколько полос на s (отгон — долей). */
function lanesAt(c: Corridor, s: number): number {
  return c.lanes.reduce((k, l) => k + laneShare(c, l, s), 0);
}

/** Новая дорога c против прежней old (на той же или близкой оси; old — с прежними полосами и классом). */
export function rebuildDiff(old: Corridor, c: Corridor): RebuildDiff {
  const K = CONSTRUCTION.rebuild;
  const n = Math.max(4, Math.ceil(c.length / 8));
  const mid = old.lut.closest(c.lut.pointAt(c.length / 2));
  const t = c.lut.tangentAt(c.length / 2);
  const to = old.lut.tangentAt(mid.s);
  const flip = t.x * to.x + t.y * to.y < 0;
  let shift = 0;
  let far = 0;
  let widened = 0;
  let added = 0;
  const ds = c.length / n;
  for (let i = 0; i <= n; i++) {
    const s = Math.min(c.length, i * ds);
    const hit = old.lut.closest(c.lut.pointAt(s));
    shift = Math.max(shift, hit.d);
    if (hit.d > K.shift) {
      far++;
      continue;
    }
    // Концы — площадки узлов: по ним ширину не сравниваем (отгон к соседу там другой).
    if (i === 0 || i === n) continue;
    const e = edgesAt(c, s);
    const o0 = edgesAt(old, hit.s);
    const o = o0 && (flip ? ([-o0[1], -o0[0]] as [number, number]) : o0);
    const k = lanesAt(c, s) - lanesAt(old, hit.s);
    const more = k > 0.25;
    const wider = !!e && (!o || e[0] < o[0] - 1 || e[1] > o[1] + 1);
    if (more || wider) widened += ds;
    const grow = e ? (e[1] - e[0] - (o ? o[1] - o[0] : 0)) / LANE_W : 0;
    added += Math.max(0, k, grow) * ds;
  }
  return { shift, moved: far / (n + 1), widened: Math.min(widened, added), cls: c.cls !== old.cls, flip };
}

/** Правка существенная — перестройка проектом стройки, а не сразу. */
export function substantial(d: RebuildDiff): boolean {
  const K = CONSTRUCTION.rebuild;
  return d.cls || d.shift > K.shift || d.widened >= K.widen;
}

/** Дорогу перенесли: ось ушла дальше порога — прежней на месте нет. */
export function isMoved(d: RebuildDiff): boolean {
  return d.shift > CONSTRUCTION.rebuild.shift;
}

/**
 * Цена перестройки, $, и доля времени новой дороги: full — цена новой дороги целиком, value — прежней, L — длина.
 * Разница цен (дороже — доплата, как «Мгновенно»; дешевле — без возврата) и работа: затронутое на месте — rework от
 * цены новой, перенесённое — relay. Время — inPlace за затронутую долю на месте и целиком за перенесённую.
 */
export function rebuildCost(full: number, value: number, d: RebuildDiff, L: number): { price: number; work: number } {
  const K = CONSTRUCTION.rebuild;
  const f = isMoved(d) ? Math.max(d.moved, 0.05) : 0;
  const stay = 1 - f;
  const touched = d.cls ? stay : Math.min(stay, L > 0 ? d.widened / L : 0);
  const price = Math.round(Math.max(0, full - value) + full * (K.rework * touched + K.relay * f));
  const work = Math.max(K.minWork, Math.min(1, K.inPlace * touched + f));
  return { price, work };
}

/** Прежняя дорога полотна в стройке — полотном (для сравнения с правкой): её класс, полосы и ось. */
export function wasCorridor(c: Corridor, w: CorridorWas): Corridor {
  const curve = w.curve ?? c.curve;
  const lut = w.curve ? new CurveLUT(curve) : c.lut;
  const o: Corridor = { ...c, curve, lut, length: lut.length, cls: w.cls, lanes: fitLanes(w.lanes, w.len, lut.length) };
  delete o.build;
  if (w.limit === undefined) delete o.limit;
  else o.limit = w.limit;
  return o;
}

/**
 * Прежняя дорога для записи в стройку: old — полотно до правки (в сети before), c — после, d — их разница. Кусок
 * разрезанной дороги (другой номер, flip) — полосы прежней, что есть посреди куска, во всю его длину.
 */
export function wasOf(before: LaneNet, next: LaneNet, old: Corridor, c: Corridor, d: RebuildDiff, money: { value: number; price: number; work: number }): CorridorWas {
  const same = old.id === c.id;
  let lanes: LaneSlot[];
  let len: number;
  if (same && !d.flip) {
    lanes = old.lanes.map((l) => ({ ...l }));
    len = old.length;
  } else {
    const at = old.lut.closest(c.lut.pointAt(c.length / 2)).s;
    lanes = old.lanes
      .filter((l) => laneShare(old, l, at) > 0.5)
      .map((l) => ({ ...l, from: 0, to: c.length, ...(d.flip ? { offset: -l.offset, flow: -l.flow as 1 | -1 } : {}) }));
    len = c.length;
  }
  const w: CorridorWas = { cls: old.cls, lanes, len, value: money.value, price: money.price, work: money.work };
  if (old.limit !== undefined) w.limit = old.limit;
  if (isMoved(d)) {
    w.moved = true;
    if (same && old.a === c.a && old.b === c.b) {
      w.curve = { p0: { ...old.curve.p0 }, p1: { ...old.curve.p1 }, p2: { ...old.curve.p2 }, p3: { ...old.curve.p3 } };
      w.portA = old.portA;
      w.portB = old.portB;
      const nodes: { id: number; pos: Vec }[] = [];
      for (const id of new Set([c.a, c.b])) {
        const p = before.nodes.get(id)?.pos;
        const q = next.nodes.get(id)?.pos;
        if (p && q && Math.hypot(p.x - q.x, p.y - q.y) > 0.01) nodes.push({ id, pos: { ...p } });
      }
      if (nodes.length) w.nodes = nodes;
    }
  } else w.part = true;
  return w;
}

/**
 * Отмена перестройки (Game.cancelProject): полотна ids — снова прежней дорогой: узлы — на прежние места, ось, класс,
 * полосы и скорость — как были; стройки на них больше нет. Полосы соседей у стыков — отгоном, как после перестройки.
 */
export function revertRebuild(net: LaneNet, ids: readonly number[]): void {
  const nodes = new Map<number, Vec>();
  for (const id of ids) for (const n of net.corridors.get(id)?.build?.was?.nodes ?? []) nodes.set(n.id, n.pos);
  for (const [id, pos] of nodes) if (net.nodes.has(id)) net.moveNode(id, pos);
  const ends: number[] = [];
  for (const id of ids) {
    const c = net.corridors.get(id);
    const w = c?.build?.was;
    if (!c || !w) continue;
    if (w.curve) {
      if (w.portA !== undefined) c.portA = w.portA;
      if (w.portB !== undefined) c.portB = w.portB;
      net.setCurve(c, w.curve);
    }
    c.cls = w.cls;
    if (w.limit === undefined) delete c.limit;
    else c.limit = w.limit;
    delete c.build;
    net.setLanes(c, fitLanes(w.lanes, w.len, c.length));
    ends.push(c.a, c.b);
  }
  if (ends.length) taperDeadLanes(net, ends);
}

/**
 * Починка сохранений: до исправления бригада, выбрав конец не начатого участка перестройки, записывала стройку заново
 * без was — полотно становилось новой дорогой, прежнюю закрывали сразу, и маршруты по ней вставали («Нет дороги»).
 * Такое полотно (не начато, проект из ids — перестройка) снова получает прежнюю дорогу — как у соседнего
 * перестраиваемого полотна (класс, полосы, скорость, перекрытие; цена — по длине). Соседа с was нет — остаётся как
 * есть. Ответ — сколько полотен починено.
 */
export function healLostWas(net: LaneNet, ids: ReadonlySet<number>): number {
  const lost = [...net.corridors.values()].filter((c) => c.build && !c.build.was && c.build.done <= 0 && ids.has(c.build.project));
  let healed = 0;
  for (let progress = true; progress && lost.length; ) {
    progress = false;
    for (let i = lost.length - 1; i >= 0; i--) {
      const c = lost[i];
      const donor = [c.a, c.b]
        .flatMap((n) => net.nodes.get(n)?.corridors ?? [])
        .map((id) => net.corridors.get(id))
        .find((d) => d && d.id !== c.id && d.build?.was && !d.build.was.moved);
      if (!donor) continue;
      const w = donor.build!.was!;
      // Сосед, что продолжает полотно (его конец — наше начало или наоборот), смотрит туда же; иначе — навстречу.
      const flip = donor.b !== c.a && donor.a !== c.b;
      const mid = w.len / 2;
      const lanes = w.lanes
        .filter((l) => l.from <= mid && l.to >= mid)
        .map((l) => ({ ...l, from: 0, to: c.length, ...(flip ? { offset: -l.offset, flow: -l.flow as 1 | -1 } : {}) }));
      const k = donor.length > 0 ? c.length / donor.length : 1;
      const was: CorridorWas = { cls: w.cls, lanes, len: c.length, value: Math.round(w.value * k), price: Math.round(w.price * k), work: w.work };
      if (w.limit !== undefined) was.limit = w.limit;
      if (w.part) was.part = true;
      if (w.edge) was.edge = true;
      c.build = { ...c.build!, was };
      net.touch(c);
      lost.splice(i, 1);
      healed++;
      progress = true;
    }
  }
  return healed;
}

// ---------- Пристройка «Полосой»: стройка — только там, где полотно стало шире ----------

/** Кусок полотна, отрезанный под стройку пристройки: его номер, где он начинается на прежнем полотне и прежняя дорога на нём. */
export interface EdgePiece {
  id: number;
  s0: number;
  old: Corridor;
}

/** Куски короче этого по краям изменённого не отрезаем: стройка доходит до конца полотна. */
const PIECE_MIN = 20;

function sameCurve(a: Cubic, b: Cubic): boolean {
  const eq = (p: Vec, q: Vec) => Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6;
  return eq(a.p0, b.p0) && eq(a.p1, b.p1) && eq(a.p2, b.p2) && eq(a.p3, b.p3);
}

/** Где полотно c (на той же оси, что old) шире прежнего или с бо́льшим числом полос: [s0, s1] по оси; нигде — null. */
export function widenedSpan(old: Corridor, c: Corridor): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  const n = Math.max(2, Math.ceil(c.length));
  for (let i = 0; i <= n; i++) {
    const s = (c.length * i) / n;
    const e = edgesAt(c, s);
    const o = edgesAt(old, s);
    const wider = !!e && (!o || e[0] < o[0] - 0.05 || e[1] > o[1] + 0.05);
    if (!wider && lanesAt(c, s) <= lanesAt(old, s) + 0.01) continue;
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  return lo <= hi ? [lo, hi] : null;
}

/** Полосы lanes полотна, обрезанные по куску [a, b] (как у splitCorridor): на куске длиной len. */
function clipLanes(lanes: readonly LaneSlot[], a: number, b: number, len: number): LaneSlot[] {
  return lanes
    .filter((l) => l.from < b - 0.5 && l.to > a + 0.5)
    .map((l) => ({ ...l, from: l.from <= a + 0.01 ? 0 : l.from - a, to: l.to >= b - 0.01 ? len : l.to - a }));
}

/**
 * Пристройка «Полосой» (новая полоса, продлённый конец) на готовом полотне c — правка того же полотна old (та же ось):
 * стройкой становится не всё полотно, а кусок, где оно стало шире. Полотно в сети next режется стыками по краям
 * изменённого (с отгоном новой полосы); место разреза не попадает на отгон ни прежних, ни новых полос — иначе отгон
 * разрезало бы стыком (разрез отодвигается за него). Кусок у конца короче PIECE_MIN не отрезается. Ответ — куски
 * полотна по порядку от a с прежней дорогой на каждом (полосы old по куску); резать нечего — null.
 */
export function splitWidened(next: LaneNet, old: Corridor, c: Corridor): EdgePiece[] | null {
  if (c.ring || c.a === c.b || !sameCurve(old.curve, c.curve)) return null;
  const span = widenedSpan(old, c);
  if (!span) return null;
  const L = c.length;
  const T = taperLen(c.cls);
  const zones: [number, number][] = [];
  for (const l of [...old.lanes, ...c.lanes]) {
    if (l.to < L - 0.01) zones.push([l.to - 2, l.to + T + 2]);
    if (l.from > 0.01) zones.push([l.from - T - 2, l.from + 2]);
  }
  // Место разреза у s — не на отгоне: сдвигаем в сторону dir (от изменённого), пока не выйдет.
  const clear = (s: number, dir: 1 | -1): number | null => {
    for (let k = 0; k < 50; k++) {
      const z = zones.find(([a, b]) => s > a && s < b);
      if (!z) return s >= PIECE_MIN && s <= L - PIECE_MIN ? s : null;
      s = dir > 0 ? z[1] + 3 : z[0] - 3;
    }
    return null;
  };
  const hi = clear(span[1] + 2, 1);
  const lo = clear(span[0] - 2, -1);
  if (hi === null && lo === null) return null;
  const cuts = [0, ...(lo !== null ? [lo] : []), ...(hi !== null ? [hi] : []), L];
  // С конца к началу: разрез у бо́льшего s не сдвигает координаты меньших.
  const ids: number[] = [];
  let rest = c;
  for (let i = cuts.length - 2; i >= 1; i--) {
    const r = splitCorridor(next, rest, cuts[i], 'seam');
    ids.unshift(r.second.id);
    rest = r.first;
  }
  ids.unshift(rest.id);
  return ids.map((id, i) => {
    const p = next.corridor(id);
    const o: Corridor = { ...p, cls: old.cls, lanes: clipLanes(old.lanes, cuts[i], cuts[i + 1], p.length) };
    delete o.build;
    if (old.limit === undefined) delete o.limit;
    else o.limit = old.limit;
    return { id, s0: cuts[i], old: o };
  });
}

/** Полотно в стройке — перестройка готовой дороги (а не новая дорога). */
export function isRebuild(c: Corridor): boolean {
  return !!c.build?.was;
}
