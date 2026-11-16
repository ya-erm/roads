import { bezPoint, Cubic, CurveLUT, minRadius } from '../core/bezier';
import { add, dot, len, norm, scale, sub, Vec } from '../core/vec';
import { LANE_W, ROAD_CLASSES } from '../world/roadTypes';
import { EditError, handlePoints, smoothCorner, splitCorridor } from './edit';
import { Corridor, CorridorEnd, laneKey, LaneNet, LaneNode, LaneSlot, LAT_EPS, parseLaneKey, renameArm } from './model';

/**
 * Узел на построенной дороге и обратно: разделить полотно стыком в точке (форма та же, дальше узел можно
 * тянуть и к нему примыкать) и убрать стык между двумя полотнами, чьи полосы продолжают друг друга, —
 * они сливаются в одно полотно той же формы (одна кривая с теми же касательными на концах).
 */

/** Ближе к концу полотна узел не ставим (короче полотно не бывает). */
const SPLIT_MARGIN = 10;
/** Насколько одна кривая может отойти от двух прежних, м: дальше — форма заметно изменится, узел нужен. */
const MERGE_TOLERANCE = 3;

/** Почему полотно c нельзя разделить узлом в точке s (вдоль оси); null — можно. */
export function splitProblem(net: LaneNet, c: Corridor, s: number): string | null {
  if (c.ring) return 'Кольцо узлом не делится';
  if (net.node(c.a).level !== net.node(c.b).level) return 'На пандусе узел не поставить — здесь меняется высота';
  if (s < SPLIT_MARGIN || s > c.length - SPLIT_MARGIN) return 'Слишком близко к узлу';
  return null;
}

/** Делит полотно id узлом-стыком в точке s вдоль оси: форма и полосы те же. Нельзя — EditError. */
export function splitRoad(net: LaneNet, id: number, s: number): LaneNode {
  const c = net.corridors.get(id);
  if (!c) throw new EditError('Дороги уже нет');
  const why = splitProblem(net, c, s);
  if (why) throw new EditError(why);
  return splitCorridor(net, c, s, 'seam').node;
}

/**
 * Два полотна узла, по ходу будущего: первое приходит в узел, второе уходит из него. kink — узел — излом двух дорог
 * (перекрёсток из двух полотен, чьи полосы продолжают друг друга): сольются одной плавной кривой.
 */
function mergeEnds(net: LaneNet, n: LaneNode): { first: CorridorEnd; second: CorridorEnd; kink: boolean } | string {
  if ((n.roundabout ?? null) !== null) return 'Узел кольца не убрать';
  const ends = net.ends(n);
  const kink = n.kind === 'junction';
  if (kink && ends.length !== 2) return 'Перекрёсток не убрать — к нему сходятся дороги';
  if (net.isDeadEnd(n)) return 'Тупик не убрать — здесь кончается дорога';
  if (ends.length !== 2 || ends.some((e) => Math.abs(e.port) >= LAT_EPS)) return 'Здесь примыкает съезд или полоса — узел нужен';
  const [x, y] = ends;
  if (x.corridor.id === y.corridor.id) return 'Дорога замкнута сама на себя — узел нужен';
  if (kink && !smoothCorner(net, { corridor: x.corridor.id, end: x.end }, false)) return 'Полосы двух дорог не продолжают друг друга — узел нужен';
  const far = (e: CorridorEnd) => (e.end === 'a' ? e.corridor.b : e.corridor.a);
  if (far(x) === far(y)) return 'Две дороги между одними узлами — узел нужен';
  const A = net.node(far(x));
  const B = net.node(far(y));
  if (A.level !== n.level || B.level !== n.level || (n.deck ?? null) !== (A.deck ?? null) || (n.deck ?? null) !== (B.deck ?? null)) {
    return 'Узел пандуса не убрать — здесь меняется высота';
  }
  if (x.corridor.cls !== y.corridor.cls || x.corridor.limit !== y.corridor.limit) return 'Дороги разного типа или скорости — узел нужен';
  return { first: x, second: y, kink };
}

/** Полосы полотна в ходе «к узлу» (forward) или против него: смещение, направление и отрезок — по новому ходу. */
function lanesAlong(c: Corridor, forward: boolean, shift: number): LaneSlot[] {
  const L = c.length;
  return c.lanes.map((l) => {
    const to = Math.min(l.to, L);
    if (forward) return { ...l, from: shift + l.from, to: shift + to };
    // Против хода смещения — с обратным знаком: сплошная к соседу с бо́льшим смещением теперь у той полосы,
    // что была соседом с меньшим.
    const below = c.lanes.find((m) => Math.abs(m.offset - (l.offset - LANE_W)) < 0.5);
    const out: LaneSlot = { ...l, offset: -l.offset, flow: -l.flow as LaneSlot['flow'], from: shift + L - to, to: shift + L - l.from };
    if (below?.solid) out.solid = true;
    else delete out.solid;
    return out;
  });
}

/**
 * Кривая от p0 (касательная t0) до p3 (приходит по t3), ближайшая к точкам pts (по порядку): длины перьев —
 * наименьшими квадратами, параметр точек уточняется по самой кривой.
 */
function fitCubic(p0: Vec, t0: Vec, p3: Vec, t3: Vec, pts: Vec[]): Cubic {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const L = cum[cum.length - 1] || 1;
  let ts = cum.map((s) => s / L);
  let best: Cubic = { p0, p1: add(p0, scale(t0, L / 3)), p2: sub(p3, scale(t3, L / 3)), p3 };
  for (let pass = 0; pass < 3; pass++) {
    let uu = 0;
    let uw = 0;
    let ww = 0;
    let ur = 0;
    let wr = 0;
    pts.forEach((q, i) => {
      const t = ts[i];
      const m = 1 - t;
      const b0 = m * m * m;
      const b1 = 3 * m * m * t;
      const b2 = 3 * m * t * t;
      const b3 = t * t * t;
      const r = sub(q, add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
      const u = scale(t0, b1);
      const w = scale(t3, -b2);
      uu += dot(u, u);
      uw += dot(u, w);
      ww += dot(w, w);
      ur += dot(u, r);
      wr += dot(w, r);
    });
    const det = uu * ww - uw * uw;
    if (Math.abs(det) < 1e-9) break;
    const clamp = (h: number) => Math.max(1, Math.min(L, h));
    const h0 = clamp((ur * ww - uw * wr) / det);
    const h3 = clamp((uu * wr - uw * ur) / det);
    best = { p0, p1: add(p0, scale(t0, h0)), p2: sub(p3, scale(t3, h3)), p3 };
    const lut = new CurveLUT(best);
    ts = pts.map((q) => lut.closest(q).t);
  }
  return best;
}

/**
 * Одно полотно вместо двух у стыка n: от дальнего конца первого до дальнего конца второго, с теми же
 * касательными на концах; полосы — их общие продолжения (и те, что кончаются раньше узла); настройки
 * перекрёстков на концах — на новое полотно. dev — насколько новая кривая отходит от прежних, м.
 */
function mergeShape(net: LaneNet, n: LaneNode): { curve: Cubic; dev: number; first: CorridorEnd; second: CorridorEnd; kink: boolean } | string {
  const ends = mergeEnds(net, n);
  if (typeof ends === 'string') return ends;
  const { first, second, kink } = ends;
  const c1 = first.corridor;
  const c2 = second.corridor;
  // Стройку не сливаем: готовое и не готовое в одном полотне не помещается.
  if (c1.build || c2.build) return 'Идёт стройка — узел нужен';
  // Точки прежней оси по новому ходу: c1 — к узлу, c2 — от узла.
  const pts: Vec[] = [];
  const steps = (c: Corridor) => Math.max(4, Math.ceil(c.length / 6));
  const k1 = steps(c1);
  for (let i = 0; i <= k1; i++) pts.push(c1.lut.pointAt(((first.end === 'b' ? i : k1 - i) / k1) * c1.length));
  const k2 = steps(c2);
  for (let i = 1; i <= k2; i++) pts.push(c2.lut.pointAt(((second.end === 'a' ? i : k2 - i) / k2) * c2.length));
  const p0 = pts[0];
  const p3 = pts[pts.length - 1];
  const t0 = first.end === 'b' ? c1.lut.tangentAt(0) : scale(c1.lut.tangentAt(c1.length), -1);
  const t3 = second.end === 'a' ? c2.lut.tangentAt(c2.length) : scale(c2.lut.tangentAt(0), -1);
  const old = [c1, c2];
  const fit = fitCubic(p0, t0, p3, t3, pts);
  if (!kink) return { curve: fit, dev: deviation(fit, pts, old), first, second, kink };
  // Излом: кривая срезает угол. Из ближайшей к прежней оси (fit) и кривых с перьями разной длины (доли расстояний
  // от концов до узла) — ближайшая к прежней оси из тех, где поворот не круче, чем можно этому типу дороги; таких
  // нет — самая пологая (её отвергнет проверка дороги или mergeProblem — с радиусом).
  const need = ROAD_CLASSES[c1.cls].minRadius;
  const L0 = Math.hypot(n.pos.x - p0.x, n.pos.y - p0.y);
  const L3 = Math.hypot(p3.x - n.pos.x, p3.y - n.pos.y);
  const cands = [fit];
  for (const a of KINK_ARMS) for (const b of KINK_ARMS) cands.push({ p0, p1: add(p0, scale(t0, a * L0)), p2: sub(p3, scale(t3, b * L3)), p3 });
  let best: { curve: Cubic; r: number; dev: number } | null = null;
  for (const curve of cands) {
    const r = minRadius(curve);
    if (r >= need) {
      const dev = deviation(curve, pts, old);
      if (!best || best.r < need || dev < best.dev) best = { curve, r, dev };
    } else if (!best || (best.r < need && r > best.r)) best = { curve, r, dev: Infinity };
  }
  const curve = best!.curve;
  return { curve, dev: Number.isFinite(best!.dev) ? best!.dev : deviation(curve, pts, old), first, second, kink };
}

/** Доли расстояния от конца до узла излома — длины перьев кривых-кандидатов. */
const KINK_ARMS = [0.25, 0.4, 0.55, 0.7, 0.85, 1];

/** Насколько кривая отходит от прежней оси (точки pts на ней, полотна old), м. */
function deviation(curve: Cubic, pts: Vec[], old: Corridor[]): number {
  const lut = new CurveLUT(curve);
  let dev = 0;
  for (const q of pts) dev = Math.max(dev, lut.closest(q).d);
  // И сама кривая не уходит от прежней оси между точками.
  for (let i = 1; i < 16; i++) {
    const q = bezPoint(curve, i / 16);
    dev = Math.max(dev, Math.min(...old.map((c) => c.lut.closest(q).d)));
  }
  return dev;
}

/** Почему форма слияния не годится; null — годится. Излом срезается кривой, но не круче, чем можно этому типу дороги. */
function shapeProblem(shape: { curve: Cubic; dev: number; first: CorridorEnd; kink: boolean }): string | null {
  if (!shape.kink) return shape.dev > MERGE_TOLERANCE ? 'Одной кривой так не выйдет — узел нужен' : null;
  const cls = ROAD_CLASSES[shape.first.corridor.cls];
  // Тот же порог, что у проверки дороги при стройке.
  const min = cls.minRadius * 0.7;
  const r = minRadius(shape.curve);
  return r < min ? `Излом слишком крутой: плавно выйдет поворот радиусом ${Math.floor(r)} м, а типу «${cls.name}» нужно от ${Math.ceil(min)} м` : null;
}

/** Плавная кривая, которой сольются две дороги у излома id (для подсказки); null — узел не излом или слить нельзя. */
export function mergePreview(net: LaneNet, id: number): Cubic | null {
  const n = net.nodes.get(id);
  if (!n || n.kind !== 'junction') return null;
  const shape = mergeShape(net, n);
  return typeof shape === 'string' || shapeProblem(shape) ? null : shape.curve;
}

/** Почему узел n нельзя убрать; null — можно (два полотна сольются в одно; излом — одной плавной кривой). */
export function mergeProblem(net: LaneNet, id: number): string | null {
  const n = net.nodes.get(id);
  if (!n) return 'Узла уже нет';
  const shape = mergeShape(net, n);
  if (typeof shape === 'string') return shape;
  return shapeProblem(shape);
}

/** Убирает узел id: два полотна — одно той же формы (излом — срезан плавной кривой). Нельзя — EditError с причиной. */
export function mergeAtNode(net: LaneNet, id: number): Corridor {
  const n = net.nodes.get(id);
  if (!n) throw new EditError('Узла уже нет');
  const shape = mergeShape(net, n);
  if (typeof shape === 'string') throw new EditError(shape);
  const why = shapeProblem(shape);
  if (why) throw new EditError(why);
  const { first, second, curve } = shape;
  const c1 = first.corridor;
  const c2 = second.corridor;
  const fwd1 = first.end === 'b';
  const fwd2 = second.end === 'a';
  const A = fwd1 ? c1.a : c1.b;
  const B = fwd2 ? c2.b : c2.a;
  const portA = fwd1 ? c1.portA : c1.portB;
  const portB = fwd2 ? c2.portB : c2.portA;
  const L1 = c1.length;
  const total = L1 + c2.length;
  // Полосы по новому ходу: у узла полоса первого продолжается полосой второго (то же смещение и направление).
  const l1 = lanesAlong(c1, fwd1, 0);
  const l2 = lanesAlong(c2, fwd2, L1);
  const at1 = new Map<number, number>();
  const at2 = new Map<number, number>();
  const lanes: LaneSlot[] = [];
  l1.forEach((l, i) => {
    at1.set(i, lanes.length);
    lanes.push(l);
  });
  l2.forEach((l, j) => {
    const k = l.from <= L1 + 0.01 ? lanes.findIndex((m) => m.to >= L1 - 0.01 && m.flow === l.flow && Math.abs(m.offset - l.offset) < LAT_EPS) : -1;
    if (k >= 0) {
      lanes[k] = { ...lanes[k], to: l.to };
      at2.set(j, k);
    } else {
      at2.set(j, lanes.length);
      lanes.push(l);
    }
  });
  // Отрезки полос — по длине новой оси (она почти та же).
  const merged = net.addCorridor(A, B, { cls: c1.cls, limit: c1.limit, lanes: [], portA, portB, curve });
  const k = merged.length / total;
  net.setLanes(
    merged,
    lanes.map((l) => ({ ...l, from: Math.max(0, l.from * k), to: l.to >= total - 0.01 ? merged.length : Math.min(merged.length, l.to * k) })),
  );
  // Связи полос и настройки перекрёстков на концах — на новое полотно (номера его полос — свои).
  const remap = (node: LaneNode, old: Corridor, map: Map<number, number>) => {
    if (node.lanes) {
      node.lanes = node.lanes.map((key) => {
        const l = parseLaneKey(key);
        if (!l) return key;
        const from = l.from === old.id ? { from: merged.id, i: map.get(l.i) ?? l.i } : { from: l.from, i: l.i };
        const to = l.to === old.id ? { to: merged.id, j: map.get(l.j) ?? l.j } : { to: l.to, j: l.j };
        return laneKey({ ...from, ...to });
      });
    }
    renameArm(node, old.id, merged.id);
  };
  remap(net.node(A), c1, at1);
  remap(net.node(B), c2, at2);
  net.removeCorridor(c1.id, true);
  net.removeCorridor(c2.id, true);
  net.removeNode(n.id);
  return merged;
}

/** Правка: узел на полотне id в точке s. */
export function splitEdit(id: number, s: number): (net: LaneNet) => boolean | void {
  return (net) => {
    splitRoad(net, id, s);
  };
}

/** Правка: убрать узел id (стык или излом двух дорог). */
export function mergeEdit(id: number): (net: LaneNet) => boolean | void {
  return (net) => {
    mergeAtNode(net, id);
  };
}

// ---------- Излом ↔ гладкий ----------

/**
 * Узел двух дорог id для двойного клика: 'smooth' — гладкий стык (станет изломом), 'kink' — излом (станет гладким);
 * иначе — почему не переключить.
 */
export function jointOf(net: LaneNet, id: number): 'smooth' | 'kink' | string {
  const n = net.nodes.get(id);
  if (!n) return 'Узла уже нет';
  if ((n.roundabout ?? null) !== null) return 'Узел кольца — излом не сделать';
  if (net.isDeadEnd(n)) return 'Тупик — здесь кончается дорога';
  const ends = net.ends(n);
  if (n.kind === 'junction' && ends.length !== 2) return 'Перекрёсток — к нему сходятся дороги';
  if (ends.length !== 2 || ends.some((e) => Math.abs(e.port) >= LAT_EPS)) return 'Здесь примыкает съезд или полоса';
  const [x] = ends;
  if (x.corridor.id === ends[1].corridor.id) return 'Дорога замкнута сама на себя';
  if (n.kind === 'seam') return 'smooth';
  return smoothCorner(net, { corridor: x.corridor.id, end: x.end }, false) ? 'kink' : 'Полосы двух дорог не продолжают друг друга';
}

/**
 * Излом двух дорог id — гладкий стык: общая касательная — посередине между прежними (биссектриса угла), перья
 * обеих дорог поворачивают к ней на равный угол, длины перьев прежние.
 */
export function smoothJoint(net: LaneNet, id: number): void {
  if (jointOf(net, id) !== 'kink') throw new EditError('Узел не излом');
  const [x, y] = net.ends(net.node(id));
  const hx = handlePoints(x.corridor, x.end);
  const hy = handlePoints(y.corridor, y.end);
  // Перо x смотрит в сторону дороги x, перо y — в сторону y: общая ось — от y через узел к x.
  const axis = sub(norm(sub(hx.pos, hx.anchor)), norm(sub(hy.pos, hy.anchor)));
  if (len(axis) < 1e-3) throw new EditError('Дороги сходятся в одну сторону — гладко не выйдет');
  const d = norm(axis);
  const cv = { ...x.corridor.curve };
  const arm = add(hx.anchor, scale(d, Math.max(2, len(sub(hx.pos, hx.anchor)))));
  if (x.end === 'a') cv.p1 = arm;
  else cv.p2 = arm;
  net.setCurve(x.corridor, cv);
  // Перо y — на одну прямую с x; узел — стык (настройки перекрёстка прочь).
  smoothCorner(net, { corridor: x.corridor.id, end: x.end });
}

/** Гладкий стык двух дорог id — излом: перья дорог в нём дальше тянут порознь (форма та же). */
export function kinkJoint(net: LaneNet, id: number): void {
  if (jointOf(net, id) !== 'smooth') throw new EditError('Узел не гладкий стык');
  const n = net.node(id);
  n.kind = 'junction';
  // Форма та же, но узел другой: обе дороги — заново в отрисовку.
  for (const c of n.corridors) net.touch(net.corridor(c));
}

/** Правка: двойной клик по узлу id — излом ↔ гладкий. Нельзя — EditError с причиной. */
export function toggleJointEdit(id: number): (net: LaneNet) => boolean | void {
  return (net) => {
    const j = jointOf(net, id);
    if (j === 'smooth') kinkJoint(net, id);
    else if (j === 'kink') smoothJoint(net, id);
    else throw new EditError(j);
  };
}
