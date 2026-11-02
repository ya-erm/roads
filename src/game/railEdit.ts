import { Cubic, offsetCubic, splitBezier } from '../core/bezier';
import { add, cross, dist, dot, len, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import type { Network, Segment } from '../world/network';
import { TRACK_GAP } from '../world/roadTypes';
import type { TrackEdit } from './build';

/**
 * Правка путей инструментом «Двигать» (узел, перо, изгиб за середину) и место для второго пути рядом
 * с первым. Здесь только геометрия: новые формы участков. Проверяет, считает цену и строит — Builder.reshape.
 */

export type TrackEnd = 'a' | 'b';

/** Перо — управляющая точка участка у конца end: тянешь — меняется направление пути в узле. */
export interface TrackHandle {
  seg: number;
  end: TrackEnd;
}

/** Где перо: конец участка (anchor) и управляющая точка (pos). */
export function trackHandlePoints(s: { curve: Cubic }, end: TrackEnd): { anchor: Vec; pos: Vec } {
  return end === 'a' ? { anchor: s.curve.p0, pos: s.curve.p1 } : { anchor: s.curve.p3, pos: s.curve.p2 };
}

/** Концы участков в узле: какой участок и каким концом (петля — обоими). */
function endsAt(net: Network, id: number): { seg: Segment; end: TrackEnd }[] {
  const res: { seg: Segment; end: TrackEnd }[] = [];
  for (const sid of new Set(net.node(id).segments)) {
    const s = net.segment(sid);
    if (s.a === id) res.push({ seg: s, end: 'a' });
    if (s.b === id) res.push({ seg: s, end: 'b' });
  }
  return res;
}

/**
 * Узел станции или её горловины: подъезд вокзала, конец платформы или стрелка, от которой идёт путь
 * к платформе. Такие узлы не двигают и не поворачивают — их двигают вместе со станцией.
 */
export function stationLocked(net: Network, id: number): boolean {
  const n = net.node(id);
  if (n.buildingId !== null) return true;
  return n.segments.some((sid) => {
    const s = net.segment(sid);
    return s.platform !== undefined || net.node(s.a === id ? s.b : s.a).buildingId !== null;
  });
}

/** Участок станции: платформа или съезд к ней — его не гнут. */
export function stationSeg(net: Network, s: Segment): boolean {
  return s.platform !== undefined || net.node(s.a).buildingId !== null || net.node(s.b).buildingId !== null;
}

/** Станции, к путям которых примыкают участки правки (их контур путям у горловины не мешает). */
export function stationsNear(net: Network, ids: Iterable<number>): Set<number> {
  const res = new Set<number>();
  for (const id of ids) {
    const s = net.segments.get(id);
    if (!s) continue;
    for (const end of [s.a, s.b]) {
      for (const sid of net.node(end).segments) {
        const o = net.segment(sid);
        for (const m of [o.a, o.b]) {
          const b = net.node(m).buildingId;
          if (b !== null) res.add(b);
        }
      }
    }
  }
  return res;
}

/** Прямой участок: управляющие точки на хорде, по порядку. */
function isStraight(c: Cubic): boolean {
  const d = sub(c.p3, c.p0);
  const l = len(d);
  if (l < 1e-6) return false;
  const off = (q: Vec) => Math.abs(cross(d, sub(q, c.p0))) / l;
  return off(c.p1) < 0.05 && off(c.p2) < 0.05 && dot(sub(c.p1, c.p0), d) >= 0 && dot(sub(c.p3, c.p2), d) >= 0;
}

/** Поворот, переводящий направление from в направление to. */
function rotation(from: Vec, to: Vec): (v: Vec) => Vec {
  const th = Math.atan2(cross(from, to), dot(from, to));
  const c = Math.cos(th);
  const s = Math.sin(th);
  return (v) => ({ x: v.x * c - v.y * s, y: v.x * s + v.y * c });
}

/** Перья участка (кроме концов у станций) и, в его узлах, перья остальных путей — они поворачивают следом (partner). */
export function trackHandles(net: Network, segId: number): (TrackHandle & { partner: boolean })[] {
  const s = net.segments.get(segId);
  if (!s || stationSeg(net, s)) return [];
  const res: (TrackHandle & { partner: boolean })[] = [];
  for (const end of ['a', 'b'] as const) {
    const id = end === 'a' ? s.a : s.b;
    if (stationLocked(net, id)) continue;
    res.push({ seg: segId, end, partner: false });
    for (const e of endsAt(net, id)) if (e.seg.id !== segId) res.push({ seg: e.seg.id, end: e.end, partner: true });
  }
  return res;
}

/**
 * Перенос узла в pos, пути — следом. В стрелке и стыке направление пути в узле сохраняется (перья
 * сдвигаются вместе с ним) — поезда проходят как раньше; у тупика прямой путь остаётся прямым
 * (от стрелки на дальнем конце — плавно выгибается к узлу), изогнутый держит форму.
 */
export function moveTrackNode(net: Network, id: number, pos: Vec): TrackEdit {
  const n = net.node(id);
  const delta = sub(pos, n.pos);
  const pinned = (m: number) => endsAt(net, m).length >= 2;
  const curves = new Map<number, Cubic>();
  for (const { seg, end } of endsAt(net, id)) {
    if (seg.a === seg.b) {
      const c = seg.curve;
      curves.set(seg.id, { p0: add(c.p0, delta), p1: add(c.p1, delta), p2: add(c.p2, delta), p3: add(c.p3, delta) });
      continue;
    }
    const cv = { ...(curves.get(seg.id) ?? seg.curve) };
    const atA = end === 'a';
    const farPt = atA ? cv.p3 : cv.p0;
    const farCtl = atA ? cv.p2 : cv.p1;
    let nearCtl: Vec;
    if (pinned(id) || !isStraight(seg.curve)) nearCtl = add(atA ? cv.p1 : cv.p2, delta);
    else if (!pinned(atA ? seg.b : seg.a)) {
      // Прямая между тупиками так и остаётся прямой: управляющие точки — на трети хорды.
      const third = scale(sub(farPt, pos), 1 / 3);
      nearCtl = add(pos, third);
      if (atA) cv.p2 = sub(farPt, third);
      else cv.p1 = sub(farPt, third);
    } else nearCtl = add(pos, scale(sub(farCtl, pos), 0.5));
    if (atA) {
      cv.p0 = { ...pos };
      cv.p1 = nearCtl;
    } else {
      cv.p3 = { ...pos };
      cv.p2 = nearCtl;
    }
    curves.set(seg.id, cv);
  }
  return { curves, node: { id, pos: { ...pos } } };
}

/**
 * Тянет перо в p. У тупика меняется только этот путь. Стрелка и стык поворачиваются целиком — углы
 * между путями в узле те же, перья остальных путей идут следом; only (Shift) — только этот путь.
 */
export function dragTrackHandle(net: Network, h: TrackHandle, p: Vec, only = false): TrackEdit | null {
  const seg = net.segments.get(h.seg);
  if (!seg) return null;
  const id = h.end === 'a' ? seg.a : seg.b;
  const { anchor, pos } = trackHandlePoints(seg, h.end);
  const to = sub(p, anchor);
  if (len(to) < 2) return null;
  const curves = new Map<number, Cubic>();
  const setCtl = (s: Segment, end: TrackEnd, q: Vec) => {
    const cv = { ...(curves.get(s.id) ?? s.curve) };
    if (end === 'a') cv.p1 = q;
    else cv.p2 = q;
    curves.set(s.id, cv);
  };
  const ends = endsAt(net, id);
  if (only || ends.length < 2) {
    setCtl(seg, h.end, { ...p });
    return { curves };
  }
  const rot = rotation(sub(pos, anchor), to);
  for (const e of ends) {
    const hp = trackHandlePoints(e.seg, e.end);
    const mine = e.seg.id === seg.id && e.end === h.end;
    setCtl(e.seg, e.end, mine ? { ...p } : add(hp.anchor, rot(sub(hp.pos, hp.anchor))));
  }
  return { curves };
}

/**
 * Участок, выгнутый через точку target (концы на месте). Стык на конце поворачивается вслед за ним —
 * соседний путь тоже; у стрелки и станции направление сохраняется, меняется только длина пера.
 */
export function bendTrack(net: Network, segId: number, target: Vec): TrackEdit | null {
  const seg = net.segments.get(segId);
  if (!seg || seg.a === seg.b) return null;
  const { p0, p3 } = seg.curve;
  const q = sub(scale(target, 2), scale(add(p0, p3), 0.5));
  const want = { a: add(p0, scale(sub(q, p0), 2 / 3)), b: add(p3, scale(sub(q, p3), 2 / 3)) };
  // У стрелки и станции направление пути в узле прежнее (главный путь не поворачивает): там меняется только
  // длина пера, а другой конец подбирается так, чтобы середина пути прошла через target (B(½) = (p0 + 3p1 + 3p2 + p3) / 8).
  const fixed = (end: TrackEnd) => {
    const id = end === 'a' ? seg.a : seg.b;
    const ends = endsAt(net, id);
    return ends.length >= 3 || (ends.length === 2 && stationLocked(net, id));
  };
  const dirOf = (end: TrackEnd) => {
    const { anchor, pos } = trackHandlePoints(seg, end);
    return norm(sub(pos, anchor));
  };
  const along = (from: Vec, t: Vec, want: Vec) => add(from, scale(t, Math.max(8, dot(sub(want, from), t))));
  const rest = sub(scale(target, 8), add(p0, p3));
  if (fixed('a') && fixed('b')) {
    // Обе длины по прямым направлениям: 3·ta·la + 3·tb·lb = 8·target − 4·(p0 + p3).
    const ta = dirOf('a');
    const tb = dirOf('b');
    const r = scale(sub(rest, scale(add(p0, p3), 3)), 1 / 3);
    const det = cross(ta, tb);
    if (Math.abs(det) > 0.05) {
      want.a = add(p0, scale(ta, Math.max(8, cross(r, tb) / det)));
      want.b = add(p3, scale(tb, Math.max(8, cross(ta, r) / det)));
    } else {
      want.a = along(p0, ta, want.a);
      want.b = along(p3, tb, want.b);
    }
  } else if (fixed('a')) {
    want.a = along(p0, dirOf('a'), want.a);
    want.b = scale(sub(rest, scale(want.a, 3)), 1 / 3);
  } else if (fixed('b')) {
    want.b = along(p3, dirOf('b'), want.b);
    want.a = scale(sub(rest, scale(want.b, 3)), 1 / 3);
  }
  const curves = new Map<number, Cubic>();
  const cv = { ...seg.curve };
  for (const end of ['a', 'b'] as const) {
    const id = end === 'a' ? seg.a : seg.b;
    const { anchor, pos } = trackHandlePoints(seg, end);
    const ctl = want[end];
    const others = endsAt(net, id).filter((e) => e.seg.id !== seg.id);
    if (others.length && !fixed(end)) {
      const rot = rotation(sub(pos, anchor), sub(ctl, anchor));
      for (const e of others) {
        const oc = { ...(curves.get(e.seg.id) ?? e.seg.curve) };
        const hp = trackHandlePoints({ curve: oc }, e.end);
        const moved = add(hp.anchor, rot(sub(hp.pos, hp.anchor)));
        if (e.end === 'a') oc.p1 = moved;
        else oc.p2 = moved;
        curves.set(e.seg.id, oc);
      }
    }
    if (end === 'a') cv.p1 = ctl;
    else cv.p2 = ctl;
  }
  curves.set(seg.id, cv);
  return { curves };
}

// ---------- Второй путь рядом ----------

/** Место рядом с путём на междупутье. */
export interface Beside {
  pos: Vec;
  /** Направление соседнего пути здесь (по ходу его участка a→b): новый путь пойдёт вдоль него. */
  axis: Vec;
  /** Точка соседнего пути напротив. */
  from: Vec;
  seg: number;
  /** Где напротив на участке (длина от a) и с какой стороны (по нормали к ходу a→b). */
  s: number;
  side: 1 | -1;
  /** Ровно напротив тупика. */
  end: boolean;
}

/**
 * Куда прилипнет точка p у соседнего пути той же высоты: у тупика — ровно напротив него (на междупутье
 * сбоку), иначе — сбоку от ближайшей точки пути. tol — насколько можно промахнуться; место, занятое
 * другим путём, не годится. null — рядом с путём не прилипает.
 */
export function besideTrack(net: Network, p: Vec, level: number, tol: number, gap = TRACK_GAP): Beside | null {
  const free = (q: Vec) => !net.segmentsNear(q, gap).some((s) => s.lut.closest(q).d < gap * 0.6);
  let best: Beside | null = null;
  // Напротив тупика — прилипает сильнее: второй путь начнётся (или кончится) ровно рядом с концом первого.
  let bestErr = tol * 1.5;
  for (const n of net.nodesNear(p, gap + bestErr)) {
    if (n.segments.length !== 1 || n.buildingId !== null || Math.abs(n.level - level) > 0.25) continue;
    const seg = net.segment(n.segments[0]);
    if (seg.platform !== undefined || seg.a === seg.b) continue;
    const atA = seg.a === n.id;
    const t = seg.lut.tangentAt(atA ? 0 : seg.length);
    for (const side of [1, -1] as const) {
      const pos = add(n.pos, scale(rightNormal(t), side * gap));
      const err = dist(p, pos);
      if (err < bestErr && free(pos)) {
        bestErr = err;
        best = { pos, axis: t, from: { ...n.pos }, seg: seg.id, s: atA ? 0 : seg.length, side, end: true };
      }
    }
  }
  if (best) return best;
  bestErr = tol;
  for (const seg of net.segmentsNear(p, gap + tol + 10)) {
    if (seg.platform !== undefined) continue;
    const hit = seg.lut.closest(p);
    if (hit.s < 1 || hit.s > seg.length - 1 || Math.abs(net.levelAt(seg, hit.s) - level) > 0.25) continue;
    const t = seg.lut.tangentAt(hit.s);
    const d = dot(sub(p, hit.point), rightNormal(t));
    const err = Math.abs(Math.abs(d) - gap);
    if (err >= bestErr) continue;
    const side = d >= 0 ? 1 : -1;
    const pos = add(hit.point, scale(rightNormal(t), side * gap));
    if (!free(pos)) continue;
    bestErr = err;
    best = { pos, axis: t, from: hit.point, seg: seg.id, s: hit.s, side, end: false };
  }
  return best;
}

/** Каким ляжет второй путь рядом: копия соседнего участка сбоку длиной до length (у тупика — вглубь пути). */
export function besideGhost(net: Network, b: Beside, length = 60, gap = TRACK_GAP): Cubic | null {
  const seg = net.segments.get(b.seg);
  if (!seg) return null;
  const L = Math.min(length, seg.length);
  const [s0, s1] = b.end ? (b.s < seg.length / 2 ? [0, L] : [seg.length - L, seg.length]) : [Math.max(0, b.s - L / 2), Math.min(seg.length, b.s + L / 2)];
  if (s1 - s0 < 1) return null;
  const t0 = seg.lut.tAt(s0);
  const t1 = seg.lut.tAt(s1);
  let piece = seg.curve;
  if (t1 < 1) piece = splitBezier(piece, t1)[0];
  if (t0 > 0) piece = splitBezier(piece, t0 / t1)[1];
  return offsetCubic(piece, b.side * gap);
}
