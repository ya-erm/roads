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
import { CurveLUT } from '../core/bezier';
import type { Vec } from '../core/vec';
import { fitLanes } from '../lanes/closure';
import { taperDeadLanes } from '../lanes/edit';
import { edgesAt, laneShare } from '../lanes/geometry';
import type { Corridor, CorridorWas, LaneNet, LaneSlot } from '../lanes/model';

/** Чем новая дорога отличается от прежней. */
export interface RebuildDiff {
  /** Наибольший сдвиг оси от прежней, м. */
  shift: number;
  /** Доля длины, ушедшая с прежней оси дальше CONSTRUCTION.rebuild.shift (0 — дорога на месте). */
  moved: number;
  /** Метров, где полос (или ширины полотна) стало больше. */
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
    const more = lanesAt(c, s) > lanesAt(old, hit.s) + 0.25;
    const wider = !!e && (!o || e[0] < o[0] - 1 || e[1] > o[1] + 1);
    if (more || wider) widened += ds;
  }
  return { shift, moved: far / (n + 1), widened, cls: c.cls !== old.cls, flip };
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
      c.build = { ...c.build!, was };
      net.touch(c);
      lost.splice(i, 1);
      healed++;
      progress = true;
    }
  }
  return healed;
}

/** Полотно в стройке — перестройка готовой дороги (а не новая дорога). */
export function isRebuild(c: Corridor): boolean {
  return !!c.build?.was;
}
