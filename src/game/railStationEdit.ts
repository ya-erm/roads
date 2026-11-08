import { MIN_SEGMENT_LEN, RAIL_STATION } from '../config';
import { Cubic, CurveLUT, reverseCubic, splitBezier, straightCubic } from '../core/bezier';
import { add, cross, dist, dot, norm, scale, sub, Vec } from '../core/vec';
import type { Station } from '../world/entities';
import type { Network, Segment } from '../world/network';
import { isRail, RAIL_HALF } from '../world/roadTypes';
import type { Footprint } from '../world/spatial';

/**
 * Правка построенного ж/д вокзала: ещё один путь с платформой («Достроить путь») и разбор станции перед
 * переносом (пути станции прочь, главный путь — снова цельный, как до неё). Здесь только геометрия
 * и сеть путей; цену, помехи и деньги считает Game (railTrackPlan, stationMovePlan, railExtendPlan).
 */

/** Как устроен построенный вокзал: главная платформа, её концы, стрелки горловин, сторона боковых путей. */
export interface StationShape {
  main: Segment;
  /** Концы главной платформы: у проходной — к обеим горловинам; у конечной — [начало платформы, упор]. */
  ends: [number, number];
  /** Стрелки горловин за концами главной платформы; у упора конечной — null. */
  switches: [number | null, number | null];
  /** Вдоль платформ: от ends[0] к ends[1]. */
  t: Vec;
  /** Поперёк — в сторону боковых путей и здания. */
  n: Vec;
}

/** Узел на другом конце участка. */
const other = (s: Segment, from: number): number => (s.a === from ? s.b : s.a);

export function stationShape(net: Network, st: Station): StationShape | null {
  const main = net.segments.get(st.platforms[0]);
  if (!main) return null;
  const dead = (id: number) => net.node(id).segments.length === 1;
  const ends: [number, number] = st.terminal && dead(main.a) ? [main.b, main.a] : [main.a, main.b];
  // Стрелка за концом платформы: на другом конце единственного участка главного пути, что идёт от него.
  const switchOf = (end: number): number | null => {
    const away = net.node(end).segments.filter((sid) => sid !== main.id && net.isRailSeg(sid));
    return away.length === 1 ? other(net.segment(away[0]), end) : null;
  };
  const switches: [number | null, number | null] = [switchOf(ends[0]), st.terminal ? null : switchOf(ends[1])];
  if (switches[0] === null || (!st.terminal && switches[1] === null)) return null;
  const a = net.node(ends[0]).pos;
  const b = net.node(ends[1]).pos;
  if (dist(a, b) < 1) return null;
  const t = norm(sub(b, a));
  const mid = main.lut.pointAt(main.length / 2);
  const n = stationNormal(net, st, mid, t);
  return { main, ends, switches, t, n };
}

/**
 * Поперёк путей вокзала — в сторону здания и боковых путей. У проходной — по зданию (оно сбоку, за крайним путём
 * своей стороны; пути могут быть и по другую сторону от главного). У конечной здание в торце — по второму пути,
 * а у конечной на один путь — по зданию. mid — середина главной платформы, t — вдоль неё.
 */
export function stationNormal(net: Network, st: Station, mid: Vec, t: Vec): Vec {
  const next = st.terminal && st.platforms.length > 1 ? net.segments.get(st.platforms[1]) : undefined;
  const toward = next ? next.lut.pointAt(next.length / 2) : st.fp.center;
  return cross(t, sub(toward, mid)) >= 0 ? { x: -t.y, y: t.x } : { x: t.y, y: -t.x };
}

/** Где пути вокзала поперёк: смещение середины каждой платформы от главной вдоль n (главная — 0), по порядку st.platforms. */
export function trackOffsets(net: Network, st: Station, shape: StationShape): number[] {
  const mid = shape.main.lut.pointAt(shape.main.length / 2);
  return st.platforms.map((id, i) => {
    const s = net.segments.get(id);
    return i === 0 || !s ? 0 : dot(sub(s.lut.pointAt(s.length / 2), mid), shape.n);
  });
}

/** Длина съезда на k-й путь (1 — второй): чем дальше путь от главного, тем длиннее, чтобы стрелка была пологой. */
export const switchLenFor = (tracks: number): number => RAIL_STATION.switchLen + 45 * (tracks - 2);

/** Откуда пойдёт съезд нового пути: от существующей стрелки или от новой — дальше по главному пути. */
export interface TrackBranch {
  /** Узел стрелки, если ветвимся от неё. */
  node?: number;
  /** Новая стрелка: разрезать участок seg на расстоянии s от его начала. */
  split?: { seg: number; s: number };
  pos: Vec;
}

/** Ещё один путь вокзала: съезд, платформа и (у проходной) съезд обратно; здание — на новом месте. */
export interface ExtraTrack {
  branches: TrackBranch[];
  /** Кривые: [съезд, платформа] или [съезд, платформа, съезд обратно]. */
  curves: Cubic[];
  fp: Footprint;
  /** Длина платформы, м. */
  platform: number;
}

/** С какой стороны от путей вокзала новый путь: 1 — со стороны здания (n), -1 — с другой. */
export type TrackSide = 1 | -1;

/**
 * Где ляжет следующий путь вокзала: на расстоянии spacing от крайнего пути стороны side. Со стороны здания
 * (side = 1) здание отодвигается: у проходной — на путь дальше; с другой стороны (side = -1) здание стоит, где
 * стояло, а платформа нового пути — островная, между ним и соседним. У конечной здание в торце становится шире —
 * поперёк всех путей. Съезд — от стрелки горловины, а если главный путь за ней прямой и достаточно длинный —
 * от новой стрелки дальше, чтобы съезд на дальний путь был таким же пологим, как у вокзала, построенного сразу
 * на столько путей.
 */
export function extraTrackGeom(net: Network, st: Station, shape: StationShape, side: TrackSide = 1): ExtraTrack {
  const R = RAIL_STATION;
  const { t, n, ends, switches, main } = shape;
  const offs = trackOffsets(net, st, shape);
  const lo = Math.min(...offs);
  const hi = Math.max(...offs);
  // Новый путь — за крайним своей стороны; съезд — как у вокзала, где он столько же путей от главного.
  const d = side > 0 ? hi + R.spacing : lo - R.spacing;
  const want = switchLenFor(1 + Math.round(Math.abs(d) / R.spacing));
  const branchAt = (sw: number, end: number, sign: 1 | -1): TrackBranch => {
    const at = net.node(sw).pos;
    const have = Math.abs(dot(sub(net.node(end).pos, at), t));
    const extra = want - have;
    if (extra < 1) return { node: sw, pos: at };
    // Участок главного пути за стрелкой (от станции): не съезд к платформе и не путь самой станции.
    const outer = net
      .node(sw)
      .segments.map((sid) => net.segment(sid))
      .filter((s) => isRail(s.spec) && s.platform === undefined && other(s, sw) !== end && net.node(other(s, sw)).buildingId === null);
    if (outer.length !== 1) return { node: sw, pos: at };
    const o = outer[0];
    const from = o.a === sw ? extra : o.length - extra;
    if (!net.isFlat(o) || extra < MIN_SEGMENT_LEN || o.length - extra < MIN_SEGMENT_LEN + 4) return { node: sw, pos: at };
    const p = o.lut.pointAt(from);
    // Новая стрелка — на прямом продолжении главного пути.
    const away = scale(t, -sign);
    const off = sub(p, at);
    if (Math.abs(cross(t, off)) > 1.5 || dot(off, away) < extra - 2) return { node: sw, pos: at };
    if (Math.abs(dot(o.lut.tangentAt(from), t)) < Math.cos(0.06)) return { node: sw, pos: at };
    return { split: { seg: o.id, s: from }, pos: p };
  };
  const a = add(net.node(ends[0]).pos, scale(n, d));
  const b = add(net.node(ends[1]).pos, scale(n, d));
  const b0 = branchAt(switches[0]!, ends[0], 1);
  const h0 = Math.abs(dot(sub(a, b0.pos), t)) * 0.4;
  const curves: Cubic[] = [{ p0: b0.pos, p1: add(b0.pos, scale(t, h0)), p2: sub(a, scale(t, h0)), p3: a }, straightCubic(a, b)];
  const branches = [b0];
  let fp: Footprint;
  if (!st.terminal) {
    const b1 = branchAt(switches[1]!, ends[1], -1);
    const h1 = Math.abs(dot(sub(b1.pos, b), t)) * 0.4;
    curves.push({ p0: b, p1: add(b, scale(t, h1)), p2: sub(b1.pos, scale(t, h1)), p3: b1.pos });
    branches.push(b1);
    fp = side > 0 ? { ...st.fp, center: add(st.fp.center, scale(n, R.spacing)) } : { ...st.fp };
  } else {
    // Здание в торце — поперёк всех путей: от крайнего с другой стороны до боковой платформы у крайнего со стороны n.
    const across = { lo: Math.min(lo, d) - (RAIL_HALF + 4), hi: Math.max(hi, d) + RAIL_HALF + 8 };
    const buffer = net.node(ends[1]).pos;
    fp = {
      ...st.fp,
      center: add(add(buffer, scale(t, R.concourse + st.fp.h / 2)), scale(n, (across.lo + across.hi) / 2)),
      w: Math.max(36, across.hi - across.lo),
    };
  }
  return { branches, curves, fp, platform: main.length };
}

/**
 * Две половины, разрезанные когда-то из одной кривой (c1 кончается там, где начинается c2), — снова одна.
 * Половины, разрезанные де Кастельжо, склеиваются точно; иначе — только если обе на одной прямой.
 */
export function joinCubics(c1: Cubic, c2: Cubic): Cubic | null {
  const m = c1.p3;
  if (dist(m, c2.p0) > 0.01) return null;
  const d1 = dist(c1.p2, m);
  const d2 = dist(m, c2.p1);
  if (d1 > 1e-6 && d2 > 1e-6 && Math.abs(dist(c1.p2, c2.p1) - d1 - d2) < 0.02) {
    const t = d1 / (d1 + d2);
    const whole: Cubic = {
      p0: c1.p0,
      p1: add(c1.p0, scale(sub(c1.p1, c1.p0), 1 / t)),
      p2: add(c2.p3, scale(sub(c2.p2, c2.p3), 1 / (1 - t))),
      p3: c2.p3,
    };
    const [x, y] = splitBezier(whole, t);
    const near = (u: Cubic, v: Cubic) => dist(u.p1, v.p1) < 0.3 && dist(u.p2, v.p2) < 0.3 && dist(u.p3, v.p3) < 0.3;
    if (near(x, c1) && near(y, c2)) return whole;
  }
  // Обе на прямой от начала до конца — прямой путь.
  const ab = sub(c2.p3, c1.p0);
  const L = Math.hypot(ab.x, ab.y);
  if (L < 1) return null;
  const u = scale(ab, 1 / L);
  const pts = [c1.p1, c1.p2, m, c2.p1, c2.p2];
  if (pts.every((p) => Math.abs(cross(u, sub(p, c1.p0))) < 0.3) && dot(sub(m, c1.p0), u) > 0 && dot(sub(m, c1.p0), u) < L) return straightCubic(c1.p0, c2.p3);
  return null;
}

/**
 * Узел посреди пути, где сходятся ровно два участка (стык от разреза), — прочь: участки сливаются в один.
 * Не трогаем узлы станций, стрелки, сигналы, перепады уровня и изломы. Возвращает новый участок или null.
 */
export function healRailNode(net: Network, id: number): Segment | null {
  const node = net.nodes.get(id);
  if (!node || node.buildingId !== null || node.signals?.length || node.oneWay?.length) return null;
  const sids = [...new Set(node.segments)];
  if (sids.length !== 2 || node.segments.length !== 2) return null;
  const [s1, s2] = sids.map((sid) => net.segment(sid));
  if (!isRail(s1.spec) || !isRail(s2.spec) || s1.platform !== undefined || s2.platform !== undefined) return null;
  if (JSON.stringify(s1.spec) !== JSON.stringify(s2.spec)) return null;
  const p = other(s1, id);
  const q = other(s2, id);
  if (p === q || p === id || q === id) return null;
  if (net.node(p).level !== node.level || net.node(q).level !== node.level) return null;
  const c1 = s1.b === id ? s1.curve : reverseCubic(s1.curve);
  const c2 = s2.a === id ? s2.curve : reverseCubic(s2.curve);
  const whole = joinCubics(c1, c2);
  if (!whole) return null;
  const spec = s1.spec;
  net.deleteNode(id);
  const seg = net.addSegment(p, q, whole, spec);
  // Сигналы на дальних концах ссылались на половины — теперь на целый участок.
  const rename = (nid: number, from: number) => {
    const n = net.node(nid);
    if (n.signals) n.signals = n.signals.map((x) => (x === from ? seg.id : x));
    if (n.oneWay) n.oneWay = n.oneWay.map((x) => (x === from ? seg.id : x));
  };
  rename(p, s1.id);
  rename(q, s2.id);
  return seg;
}

/**
 * Разбирает пути вокзала: боковые пути со съездами — прочь, платформы и узлы — больше не станции.
 * Главный путь остаётся. Возвращает, сколько стоили снесённые участки (cost — цена участка, пока он ещё в сети),
 * и узлы главного пути, где станция его резала (их можно срастить — healCuts).
 */
export function stripRailStation(net: Network, st: Station, cost: (s: Segment) => number = () => 0): { worth: number; cuts: number[] } {
  const shape = stationShape(net, st);
  const cuts = shape ? [shape.switches[0], shape.ends[0], ...(st.terminal ? [] : [shape.ends[1], shape.switches[1]])].filter((x): x is number => x !== null) : [];
  const segs = st.platforms.map((id) => net.segments.get(id));
  for (const seg of segs) {
    if (!seg) continue;
    seg.platform = undefined;
    for (const nid of [seg.a, seg.b]) {
      const n = net.nodes.get(nid);
      if (n?.buildingId === st.id) n.buildingId = null;
    }
  }
  const remove = new Set<number>();
  for (const loop of segs.slice(1)) {
    if (!loop) continue;
    remove.add(loop.id);
    for (const nid of [loop.a, loop.b]) for (const sid of net.nodes.get(nid)?.segments ?? []) if (net.isRailSeg(sid)) remove.add(sid);
  }
  let worth = 0;
  for (const sid of remove) {
    const seg = net.segments.get(sid);
    if (seg) worth += cost(seg);
    net.removeSegment(sid);
  }
  return { worth, cuts };
}

/** Срастить главный путь в узлах, где его резала станция (те, что остались стыками двух участков). */
export function healCuts(net: Network, cuts: number[]): void {
  for (const id of cuts) healRailNode(net, id);
}

/**
 * Удлинение платформ вокзала: какие узлы куда встают и какие участки получают новую форму. Узлы и участки — те же
 * (поезда на них остаются, длины подстроятся), меняются только их места.
 */
export interface PlatformExtend {
  /** Новые места узлов: концов платформ с удлиняемой стороны, стрелок горловины, отодвинутых узлов главного пути. */
  moves: Map<number, Vec>;
  /** Новые формы участков, что касаются подвинутых узлов. */
  curves: Map<number, Cubic>;
  /** Что легло на новое место (платформы, съезды, продолжение тупика) — его проверяют на помехи. */
  fresh: Cubic[];
  /** Участки, которые удлинение двигает или укорачивает: себе они не мешают. */
  own: Set<number>;
  /** Здание на новом месте. */
  fp: Footprint;
  /** Длина платформ после удлинения, м. */
  platform: number;
  /** На сколько метров стало больше путей (цена). */
  added: number;
}

/** Сдвинутая кривая. */
const shiftCubic = (c: Cubic, d: Vec): Cubic => ({ p0: add(c.p0, d), p1: add(c.p1, d), p2: add(c.p2, d), p3: add(c.p3, d) });

/** Участок прямой и идёт вдоль t (с допуском на неточность разрезов). */
function straightAlong(s: Segment, t: Vec): boolean {
  const c = s.curve;
  const ab = sub(c.p3, c.p0);
  const L = Math.hypot(ab.x, ab.y);
  if (L < 1) return false;
  const u = scale(ab, 1 / L);
  if (Math.abs(cross(u, t)) > Math.sin(0.06)) return false;
  return [c.p1, c.p2].every((p) => Math.abs(cross(u, sub(p, c.p0))) < 0.5);
}

/**
 * Платформы вокзала длиннее: shift[0] — на сколько метров отодвинуть конец ends[0] (наружу, против t), shift[1] —
 * конец ends[1] (по t). С удлиняемой стороны вместе с концами платформ отъезжают и стрелки горловины со съездами
 * (съезды не меняют форму), а главный путь за последней стрелкой укорачивается; он короткий — дальше отодвигаются
 * и узлы за ним (стыки на прямой), а тупик просто продлевается. У конечной сторона упоров (ends[1]) — только концы
 * платформ и здание в торце. Не выходит (к стрелкам примыкают чужие пути, главный путь за горловиной изогнут или
 * сразу упирается в другую стрелку) — причина строкой.
 */
export function extendGeom(net: Network, st: Station, shape: StationShape, shift: [number, number]): PlatformExtend | string {
  const R = RAIL_STATION;
  const { t, ends, switches, main } = shape;
  const owned = (id: number) => net.nodes.get(id)?.buildingId === st.id;
  const mid = main.lut.pointAt(main.length / 2);
  const moves = new Map<number, Vec>();
  /** Участки главного пути за горловиной, что отъезжают вдоль себя (у них нового места нет, кроме продолжения тупика). */
  const along = new Set<number>();
  const fresh: Cubic[] = [];
  const stationNodes = [...net.nodes.values()].filter((n) => n.buildingId === st.id);
  for (const k of [0, 1] as const) {
    const d = shift[k];
    if (d <= 0) continue;
    const u = k === 0 ? scale(t, -d) : scale(t, d);
    const go = (id: number) => moves.set(id, add(net.node(id).pos, u));
    for (const n of stationNodes) if ((dot(sub(n.pos, mid), t) < 0 ? 0 : 1) === k) go(n.id);
    // Упоры конечной: за ними — только перрон и здание.
    if (st.terminal && k === 1) continue;
    let prev = ends[k];
    let cur = switches[k];
    if (cur === null) return 'Пути станции перестроены — платформы не удлинить';
    for (let guard = 0; ; guard++) {
      go(cur);
      const here = cur;
      const back = prev;
      const out = net.node(here).segments.filter((sid) => {
        const o = other(net.segment(sid), here);
        return o !== back && !owned(o);
      });
      if (out.length !== 1) return 'К стрелке горловины примыкают другие пути';
      const s = net.segment(out[0]);
      const next = other(s, here);
      // Дальше по главному пути — ещё стрелка станции (съезд на дальний путь): отъезжает и она.
      const feeds = net.node(next).segments.some((sid) => owned(other(net.segment(sid), next)));
      if (feeds && guard < 6) {
        prev = here;
        cur = next;
        continue;
      }
      // Главный путь за горловиной: укорачивается первый участок, что достаточно длинный; короткие перед ним — отъезжают целиком.
      let seg = s;
      let from = here;
      for (let j = 0; ; j++) {
        if (seg.build) return 'Путь за горловиной ещё строится';
        if (!straightAlong(seg, t) || !net.isFlat(seg)) return 'Путь за горловиной изогнут — стрелку не отодвинуть';
        if (seg.length - d >= MIN_SEGMENT_LEN + 4) break;
        const far = other(seg, from);
        const fn = net.node(far);
        if (fn.buildingId !== null || fn.level !== net.node(from).level || j >= 6) return 'За горловиной нет места — стрелку некуда отодвинуть';
        along.add(seg.id);
        if (fn.segments.length === 1) {
          // Тупик — путь просто продлевается.
          fresh.push(straightCubic(fn.pos, add(fn.pos, u)));
          go(far);
          break;
        }
        if (fn.segments.length !== 2) return 'За горловиной сразу стрелка — горловину не отодвинуть';
        go(far);
        from = far;
        seg = net.segment(fn.segments.find((x) => x !== seg.id)!);
      }
      break;
    }
  }
  // Новые формы участков у подвинутых узлов: оба конца сдвинуты одинаково — участок едет целиком (съезд), иначе —
  // прямая между новыми концами (платформа, укороченный главный путь).
  const curves = new Map<number, Cubic>();
  const own = new Set<number>();
  let added = 0;
  for (const nid of moves.keys()) {
    for (const sid of net.node(nid).segments) {
      if (curves.has(sid)) continue;
      const s = net.segment(sid);
      if (s.build) return 'Пути станции ещё строятся';
      const pa = net.node(s.a).pos;
      const pb = net.node(s.b).pos;
      const ma = moves.get(s.a);
      const mb = moves.get(s.b);
      const da = ma ? sub(ma, pa) : { x: 0, y: 0 };
      const db = mb ? sub(mb, pb) : { x: 0, y: 0 };
      let c: Cubic;
      if (dist(da, db) < 1e-6) c = shiftCubic(s.curve, da);
      else if (straightAlong(s, t)) c = straightCubic(ma ?? pa, mb ?? pb);
      else return 'К путям станции примыкают другие пути';
      curves.set(sid, c);
      own.add(sid);
      const L = new CurveLUT(c).length;
      added += L - s.length;
      // Главный путь за горловиной лёг на себя же; укороченный — тоже: новое место — только у путей станции.
      const shortened = !ma !== !mb && s.platform === undefined;
      if (!along.has(sid) && !shortened) fresh.push(c);
    }
  }
  // Свои пути у стрелок горловины (съезды, главный путь) тоже не помеха.
  for (const n of stationNodes) for (const sid of n.segments) own.add(sid);
  const platform = main.length + shift[0] + shift[1];
  let fp: Footprint;
  if (st.terminal) fp = { ...st.fp, center: add(st.fp.center, scale(t, shift[1])) };
  else {
    // Здание проходной — посередине платформ; у короткой платформы оно было короче — теперь может стать длиннее.
    const w = Math.max(st.fp.w, Math.min(R.size.w, Math.max(36, platform - 10)));
    fp = { ...st.fp, w, center: add(st.fp.center, scale(t, (shift[1] - shift[0]) / 2)) };
  }
  return { moves, curves, fresh, own, fp, platform, added: Math.max(0, added) };
}
