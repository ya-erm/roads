import { add, cross, norm, sub, type Vec } from '../core/vec';
import { edgesAt, junctionCuts, plateOutline, pointOff } from '../lanes/geometry';
import type { Corridor, CorridorEnd, LaneNet, LaneNode } from '../lanes/model';
import { ROAD_MARGIN } from '../world/roadTypes';
import { type Footprint, pointInFootprint } from '../world/spatial';
import { Art } from './industryArt';
import { type Box, grow } from './tileCache';
import { paths } from './townDecor';

/**
 * Тротуары вдоль улиц городов — только картинка: дорог, узлов, движения и стройки не меняют; рисуются под дорогами
 * (drawSidewalks), в плитки кэша карты. Полоса постоянной ширины вплотную к краю асфальта — по той же геометрии, что
 * асфальт (lanes/geometry: края полос edgesAt + ROAD_MARGIN, обрезы junctionCuts, площадка plateOutline): вдоль
 * полотна — по обеим сторонам, где рядом дома, по его кривой; у перекрёстка тротуары соседних улиц сходятся по
 * бордюру угла площадки (концентрично ему); у стыка (развилка) — скруглением радиуса CURB, на повороте улицы и у
 * тупика — дугой вокруг узла (у тупика — вокруг центра разворота). Концы тротуаров у узла (SidewalkEnd) — там, где
 * тротуар улицы переходит в скругление угла: от конца до конца через улицу ляжет пешеходный переход.
 */

/** Тротуар: от края полотна (from) шириной w, м. Город — мощёный у самого бордюра, село — утоптанная тропинка. */
export const SIDEWALK = { paved: { from: 0.2, w: 3.4 }, path: { from: 0.9, w: 2 } } as const;
/** Точки оси — через step м; тротуар — где ближе houses м есть дом города; короче min — нет; разрывы короче gap — сшить. */
const WALK = { step: 2.5, houses: 40, min: 8, gap: 8 };
/** Радиус скругления тротуара на углу квартала, м; угол острее straight — скругление, тупее — дуга вокруг узла. */
const CURB = 5;
const STRAIGHT = (165 / 180) * Math.PI;

/** Строения вокруг полотна: участки домов города и прочих (станции, предприятия, базы, склады). */
export type Around = { houses: Footprint[]; others: Footprint[] };

/** Где тротуары: дома рядом, вода, в каком городе точка. */
export interface WalkSite {
  /** Строения ближе r к точке (один запрос к индексу на полотно). */
  around(p: Vec, r: number): Around;
  /** Точка в воде. */
  wet(p: Vec): boolean;
  /** Город, в застройке которого точка: мощёный ли тротуар (город) и подпись его застройки (для кэша). */
  townAt(p: Vec): { paved: boolean; key: string } | null;
}

/** Кусок тротуаров для кэша карты: тротуары одного полотна или скругления у одного узла. */
export interface Sidewalk {
  /** `c<id полотна>` или `n<id узла>`. */
  key: string;
  /** Ломаные по оси тротуара (x, y по очереди). */
  paths: number[][];
  paved: boolean;
  box: Box;
  sig: string;
}

/**
 * Конец тротуара улицы у узла: где тротуар полотна corridor со стороны side (1 — слева по направлению a→b, −1 —
 * справа) переходит в скругление угла (или обрывается). Точка — на оси тротуара; (ux, uy) — вдоль улицы к узлу.
 * Пешеходный переход через полотно у узла соединяет концы его сторон 1 и −1.
 */
export interface SidewalkEnd {
  node: number;
  corridor: number;
  side: 1 | -1;
  x: number;
  y: number;
  ux: number;
  uy: number;
  /** Ширина тротуара, м. */
  w: number;
}

export interface SidewalkNet {
  lines: Sidewalk[];
  ends: SidewalkEnd[];
}

/** Концы тротуаров у узла (для пешеходных переходов): по полотнам и сторонам. */
export function sidewalkEnds(net: SidewalkNet, node: number): SidewalkEnd[] {
  return net.ends.filter((e) => e.node === node);
}

const rot = (v: Vec): Vec => ({ x: -v.y, y: v.x });

/**
 * Ось тротуара стороны side полотна c на s — смещение от оси полотна (как pointOff): от края асфальта этой стороны
 * (кромка крайней полосы + ROAD_MARGIN, как рисуется полотно) на from + w/2 — у несимметричного полотна тоже вплотную.
 */
function walkOff(c: Corridor, s: number, side: 1 | -1, paved: boolean): number {
  const spec = paved ? SIDEWALK.paved : SIDEWALK.path;
  const d = ROAD_MARGIN + spec.from + spec.w / 2;
  const e = edgesAt(c, s);
  if (!e) return side * d;
  return side === 1 ? e[1] + d : e[0] - d;
}

/** Полотно с тротуаром: улица, проспект или грунтовка на земле, не строящаяся и не кольцо площади. */
function walkable(roads: LaneNet, c: Corridor): boolean {
  if (c.build || c.ring || (c.cls !== 'avenue' && c.cls !== 'street' && c.cls !== 'dirt')) return false;
  return roads.node(c.a).level === 0 && roads.node(c.b).level === 0;
}

/** Обрезка тротуара полотна у его концов: на сколько метров от узла (a, b) с каждой стороны. */
interface Trim {
  a: Record<string, number>;
  b: Record<string, number>;
}

/**
 * Скругление между тротуарами двух концов у узла: от какого конца к какому (полотно, конец, сторона); угол квартала —
 * кривая через вершину угла via, поворот улицы и тупик — дуга вокруг узла center. Точки — от настоящих концов
 * тротуаров (cornerPts).
 */
interface Corner {
  via: Vec | null;
  center: Vec;
  /** У перекрёстка — бордюр угла площадки (plateOutline): тротуар идёт вдоль него. */
  curb?: Vec[];
  from: { c: number; end: 'a' | 'b'; side: 1 | -1 };
  to: { c: number; end: 'a' | 'b'; side: 1 | -1 };
}

/**
 * Тротуар вдоль бордюра curb (от края одного подъезда к краю другого) — от конца тротуара A до конца B: каждая точка
 * бордюра сдвинута наружу (в сторону A) на столько же, на сколько A от начала бордюра, — по биссектрисе соседних
 * отрезков, поэтому дуга угла — концентрична бордюру. Где бордюр круче радиуса сдвига (внутренний угол), точки,
 * что пошли бы назад, пропускаются — без петли.
 */
function curbPts(curb: Vec[], A: Vec, B: Vec): number[] {
  const n = curb.length;
  const out: Vec[] = [A];
  const d = Math.hypot(A.x - curb[0].x, A.y - curb[0].y);
  const sgn = Math.sign(cross(sub(curb[1], curb[0]), sub(A, curb[0]))) || 1;
  const ahead = (q: Vec, i: number) => {
    const last = out[out.length - 1];
    const t = sub(curb[i], curb[i - 1]);
    return (q.x - last.x) * t.x + (q.y - last.y) * t.y > 1e-3;
  };
  for (let i = 1; i < n - 1; i++) {
    const u = norm(sub(curb[i], curb[i - 1]));
    const v = norm(sub(curb[i + 1], curb[i]));
    const t = norm(add(u, v));
    const k = d / Math.max(0.5, t.x * u.x + t.y * u.y);
    const q = { x: curb[i].x - t.y * sgn * k, y: curb[i].y + t.x * sgn * k };
    if (ahead(q, i)) out.push(q);
  }
  while (out.length > 1 && !ahead(B, n - 1)) out.pop();
  out.push(B);
  return out.flatMap((p) => [p.x, p.y]);
}

/** Точки скругления от конца тротуара A до конца B. */
function cornerPts(k: Corner, A: Vec, B: Vec): number[] {
  if (k.curb) return curbPts(k.curb, A, B);
  const pts: number[] = [];
  if (k.via) {
    const C = k.via;
    for (let i = 0; i <= 8; i++) {
      const s = i / 8;
      const q = 1 - s;
      pts.push(q * q * A.x + 2 * q * s * C.x + s * s * B.x, q * q * A.y + 2 * q * s * C.y + s * s * B.y);
    }
    return pts;
  }
  const c = k.center;
  const a0 = Math.atan2(A.y - c.y, A.x - c.x);
  let a1 = Math.atan2(B.y - c.y, B.x - c.x);
  while (a1 <= a0) a1 += Math.PI * 2;
  const r0 = Math.hypot(A.x - c.x, A.y - c.y);
  const r1 = Math.hypot(B.x - c.x, B.y - c.y);
  const n = Math.max(2, Math.ceil(((a1 - a0) * Math.max(r0, r1)) / 2));
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const a = a0 + (a1 - a0) * s;
    const r = r0 + (r1 - r0) * s;
    pts.push(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
  }
  return pts;
}

/** Сторона полотна, что смотрит налево от направления «от узла» на конце end. */
const leftSide = (end: 'a' | 'b'): 1 | -1 => (end === 'a' ? 1 : -1);

/**
 * Узел: концы полотен по кругу (против часовой), между соседними — угол квартала: обрезка тротуаров у узла и
 * скругление. Только между полотнами с тротуаром; соседнее без него (шоссе) — обрезка до пересечения, без дуги.
 * Перекрёсток — по площадке асфальта (plateOutline): тротуары улиц доходят до обрезов полотен, между ними — вдоль
 * бордюра угла. dOf — от узла до оси тротуара конца e со стороны side.
 */
function nodeCorners(
  roads: LaneNet,
  node: LaneNode,
  dOf: (e: CorridorEnd, side: 1 | -1) => number,
  ok: (c: Corridor) => boolean,
  trims: Map<number, Trim>,
  cuts: Map<number, [number, number]>,
): Corner[] {
  const ends = roads.ends(node).sort((x, y) => Math.atan2(x.away.y, x.away.x) - Math.atan2(y.away.y, y.away.x));
  const out: Corner[] = [];
  const setTrim = (e: CorridorEnd, side: 1 | -1, t: number) => {
    let tr = trims.get(e.corridor.id);
    if (!tr) trims.set(e.corridor.id, (tr = { a: {}, b: {} }));
    tr[e.end][side] = Math.max(tr[e.end][side] ?? 0, t);
  };
  if (node.kind === 'junction' && ends.length >= 2) {
    const plate = plateOutline(roads, node, cuts);
    const cut = (e: CorridorEnd) => cuts.get(e.corridor.id)?.[e.end === 'a' ? 0 : 1] ?? 0;
    for (const k of plate?.curbs ?? []) {
      const si = leftSide(k.from.end);
      const sj = (-leftSide(k.to.end)) as 1 | -1;
      const okI = ok(k.from.corridor);
      const okJ = ok(k.to.corridor);
      if (okI) setTrim(k.from, si, cut(k.from));
      if (okJ) setTrim(k.to, sj, cut(k.to));
      if (!okI || !okJ || k.pts.length < 2) continue;
      out.push({ via: null, center: node.pos, curb: k.pts, from: { c: k.from.corridor.id, end: k.from.end, side: si }, to: { c: k.to.corridor.id, end: k.to.end, side: sj } });
    }
    return out;
  }
  // Тупик: дуга — вокруг центра разворота (середины полотна на конце), как асфальт.
  if (ends.length === 1) {
    const e = ends[0];
    const s = e.end === 'a' ? 0 : e.corridor.length;
    const ed = edgesAt(e.corridor, s);
    const center = ed ? pointOff(e.corridor, s, (ed[0] + ed[1]) / 2) : node.pos;
    if (!ok(e.corridor)) return out;
    const si = leftSide(e.end);
    return [{ via: null, center, from: { c: e.corridor.id, end: e.end, side: si }, to: { c: e.corridor.id, end: e.end, side: (-si) as 1 | -1 } }];
  }
  for (let i = 0; i < ends.length; i++) {
    const ei = ends[i];
    const ej = ends[(i + 1) % ends.length];
    const okI = ok(ei.corridor);
    const okJ = ok(ej.corridor);
    if (!okI && !okJ) continue;
    let theta = Math.atan2(ej.away.y, ej.away.x) - Math.atan2(ei.away.y, ei.away.x);
    if (ends.length === 1 || theta <= 1e-6) theta += Math.PI * 2;
    const si = leftSide(ei.end);
    const sj = (-leftSide(ej.end)) as 1 | -1;
    const ni = rot(ei.away);
    const mj = { x: -rot(ej.away).x, y: -rot(ej.away).y };
    const di = dOf(ei, si);
    const dj = dOf(ej, sj);
    const Pi = { x: ei.pos.x + ni.x * di, y: ei.pos.y + ni.y * di };
    const Pj = { x: ej.pos.x + mj.x * dj, y: ej.pos.y + mj.y * dj };
    if (theta < STRAIGHT) {
      // Угол квартала: прямые тротуаров пересекаются в C — обрезка на отрезок касания скругления радиуса CURB.
      const ax = ei.away.x;
      const ay = ei.away.y;
      const bx = ej.away.x;
      const by = ej.away.y;
      const det = ax * -by - ay * -bx;
      if (Math.abs(det) < 1e-6) continue;
      const rx = Pj.x - Pi.x;
      const ry = Pj.y - Pi.y;
      const t = (rx * -by - ry * -bx) / det;
      const u = (ax * ry - ay * rx) / det;
      const T = Math.min(CURB / Math.tan(theta / 2), 25);
      const ti = Math.max(0, Math.min(t + T, ei.corridor.length * 0.45));
      const uj = Math.max(0, Math.min(u + T, ej.corridor.length * 0.45));
      if (okI) setTrim(ei, si, ti);
      if (okJ) setTrim(ej, sj, uj);
      if (!okI || !okJ || t < -1 || u < -1) continue;
      out.push({ via: { x: Pi.x + ax * t, y: Pi.y + ay * t }, center: node.pos, from: { c: ei.corridor.id, end: ei.end, side: si }, to: { c: ej.corridor.id, end: ej.end, side: sj } });
    } else {
      // Поворот улицы или тупик: тротуары доходят до узла и огибают его дугой снаружи.
      if (!okI || !okJ) continue;
      if (Math.hypot(Pi.x - Pj.x, Pi.y - Pj.y) < 0.3) continue;
      out.push({ via: null, center: node.pos, from: { c: ei.corridor.id, end: ei.end, side: si }, to: { c: ej.corridor.id, end: ej.end, side: sj } });
    }
  }
  return out;
}

/** Тротуары одного полотна: ломаные по сторонам и дошли ли они до концов (с учётом обрезки у узлов). */
interface Run {
  paths: number[][];
  /** Сторона дошла до конца a / b: `a1`, `b-1`… */
  reach: Set<string>;
  ends: { end: 'a' | 'b'; side: 1 | -1; x: number; y: number; ux: number; uy: number }[];
}

function corridorRun(c: Corridor, site: WalkSite, paved: boolean, near: Around, trim: Trim | undefined): Run {
  const spec = paved ? SIDEWALK.paved : SIDEWALK.path;
  const run: Run = { paths: [], reach: new Set(), ends: [] };
  const housed = (q: Vec) => near.houses.some((f) => Math.hypot(f.center.x - q.x, f.center.y - q.y) < WALK.houses + Math.max(f.w, f.h) / 2);
  const blocked = (q: Vec) => near.others.some((f) => pointInFootprint(q, f, spec.w / 2));
  for (const side of [1, -1] as const) {
    const s0 = trim?.a[side] ?? 0;
    const s1 = c.length - (trim?.b[side] ?? 0);
    if (s1 - s0 < WALK.min) continue;
    const n = Math.max(2, Math.ceil((s1 - s0) / WALK.step));
    const pts: { x: number; y: number; ok: boolean }[] = [];
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      const q = pointOff(c, s, walkOff(c, s, side, paved));
      pts.push({ ...q, ok: housed(q) && !blocked(q) && !site.wet(q) });
    }
    // Короткие разрывы — сшить.
    const gapN = Math.round(WALK.gap / ((s1 - s0) / n));
    for (let i = 0; i < pts.length; ) {
      if (pts[i].ok) {
        i++;
        continue;
      }
      let j = i;
      while (j < pts.length && !pts[j].ok) j++;
      if (i > 0 && j < pts.length && j - i <= gapN && pts.slice(i, j).every((p) => !site.wet(p))) for (let k = i; k < j; k++) pts[k].ok = true;
      i = j;
    }
    let cur: number[] = [];
    let first = -1;
    const flush = (last: number) => {
      if (cur.length >= 4 && (cur.length / 2 - 1) * ((s1 - s0) / n) >= WALK.min) {
        run.paths.push(cur);
        if (first === 0) run.reach.add(`a${side}`);
        if (last === n) run.reach.add(`b${side}`);
      }
      cur = [];
      first = -1;
    };
    pts.forEach((p, i) => {
      if (p.ok) {
        if (first < 0) first = i;
        cur.push(p.x, p.y);
      } else flush(i - 1);
    });
    flush(n);
    for (const end of ['a', 'b'] as const) {
      if (!run.reach.has(`${end}${side}`)) continue;
      const p = end === 'a' ? pts[0] : pts[n];
      const t = c.lut.tangentAt(end === 'a' ? s0 : s1);
      const k = end === 'a' ? -1 : 1;
      run.ends.push({ end, side, x: p.x, y: p.y, ux: t.x * k, uy: t.y * k });
    }
  }
  return run;
}

/** Кэш тротуаров по полотнам между пересчётами (sidewalkNet). */
export type SidewalkCache = Map<number, { sig: string; run: Run | null; paved: boolean }>;

/** Рамка ломаных. */
function boxOf(list: readonly number[][]): Box {
  let box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of list) for (let i = 0; i < p.length; i += 2) box = { x0: Math.min(box.x0, p[i]), y0: Math.min(box.y0, p[i + 1]), x1: Math.max(box.x1, p[i]), y1: Math.max(box.y1, p[i + 1]) };
  return grow(box, 4);
}

const sigOf = (list: readonly number[][]) => list.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(';');

/**
 * Тротуары всех улиц городов: по полотнам (где рядом дома) и скругления углов у узлов. cache — между пересчётами:
 * полотно с той же формой, обрезкой у узлов и строениями вокруг считается заново только при их изменении.
 */
export function sidewalkNet(roads: LaneNet, site: WalkSite, cache?: SidewalkCache): SidewalkNet {
  const eligible = new Map<number, { paved: boolean; townKey: string }>();
  for (const c of roads.corridors.values()) {
    if (!walkable(roads, c)) continue;
    const town = site.townAt(c.lut.pointAt(c.length / 2));
    if (town) eligible.set(c.id, { paved: town.paved, townKey: town.key });
  }
  const ok = (c: Corridor) => eligible.has(c.id);
  const dOf = (e: CorridorEnd, side: 1 | -1) =>
    Math.abs(walkOff(e.corridor, e.end === 'a' ? 0 : e.corridor.length, side, eligible.get(e.corridor.id)?.paved !== false));
  // Обрезы полотен у перекрёстков — как у асфальта (lanes/draw.ts): тротуар улицы доходит до площадки.
  const cuts = junctionCuts(roads);
  // Углы кварталов у узлов: обрезка тротуаров и скругления.
  const trims = new Map<number, Trim>();
  const corners = new Map<number, Corner[]>();
  const nodes = new Set<number>();
  for (const id of eligible.keys()) {
    const c = roads.corridor(id);
    nodes.add(c.a).add(c.b);
  }
  for (const nid of nodes) corners.set(nid, nodeCorners(roads, roads.node(nid), dOf, ok, trims, cuts));
  // Тротуары полотен.
  const runs = new Map<number, Run>();
  const lines: Sidewalk[] = [];
  const ends: SidewalkEnd[] = [];
  for (const [id, { paved, townKey }] of eligible) {
    const c = roads.corridor(id);
    const mid = c.lut.pointAt(c.length / 2);
    const near = site.around(mid, c.length / 2 + WALK.houses + 40);
    const tr = trims.get(id);
    const key = `${c.rev}|${townKey}|${paved}|${near.houses.length}:${near.others.length}|${tr ? JSON.stringify(tr) : ''}`;
    let had = cache?.get(id);
    if (had?.sig !== key) {
      had = { sig: key, run: corridorRun(c, site, paved, near, tr), paved };
      cache?.set(id, had);
    }
    const run = had.run;
    if (!run) continue;
    runs.set(id, run);
    for (const e of run.ends) ends.push({ node: e.end === 'a' ? c.a : c.b, corridor: id, side: e.side, x: e.x, y: e.y, ux: e.ux, uy: e.uy, w: (paved ? SIDEWALK.paved : SIDEWALK.path).w });
    if (run.paths.length) lines.push({ key: `c${id}`, paths: run.paths, paved, box: boxOf(run.paths), sig: `${paved}|${sigOf(run.paths)}` });
  }
  // Скругления — где оба тротуара дошли до угла.
  const endOf = (r: { c: number; end: 'a' | 'b'; side: 1 | -1 }) => runs.get(r.c)?.ends.find((e) => e.end === r.end && e.side === r.side) ?? null;
  for (const [nid, list] of corners) {
    const p: number[][] = [];
    for (const k of list) {
      const A = endOf(k.from);
      const B = endOf(k.to);
      if (!A || !B) continue;
      const pts = cornerPts(k, A, B);
      const i = Math.floor(pts.length / 4) * 2;
      if (!site.wet({ x: pts[i], y: pts[i + 1] })) p.push(pts);
    }
    if (!p.length) continue;
    const paved = eligible.get(list[0].from.c)?.paved ?? true;
    lines.push({ key: `n${nid}`, paths: p, paved, box: boxOf(p), sig: `${paved}|${sigOf(p)}` });
  }
  if (cache && cache.size > eligible.size * 2 + 200) for (const id of [...cache.keys()]) if (!eligible.has(id)) cache.delete(id);
  return { lines, ends };
}

/**
 * Цвета тротуаров и всех пешеходных дорожек города (дорожки кварталов, к крыльцам — render/townWalks.ts, houseArt):
 * мощёные (город) и утоптанные (село) — заливка и кромка. Непрозрачные: где дорожка и тротуар сходятся или лежат друг
 * на друге, не темнеет и не просвечивает — одно покрытие.
 */
export const WALK_LOOK = {
  paved: { fill: '#d2cbbf', edge: '#857f6c' },
  path: { fill: '#c1b28b', edge: '#ab9d78' },
} as const;

/**
 * Тротуары в рамке view — под дорогами, в плитки кэша: мощёные и тропинки — по одной обводке на вид; кромка — вблизи.
 * part — только кромки или только заливка (drawTownWalks кладёт дорожки кварталов между ними). Издали (lod 0)
 * тротуаров не видно.
 */
export function drawSidewalks(ctx: CanvasRenderingContext2D, lines: readonly Sidewalk[], view: Box, zoom: number, part: 'edge' | 'fill' | 'both' = 'both'): void {
  if (!lines.length) return;
  const a = new Art(ctx, { id: 0, fp: { center: { x: 0, y: 0 }, w: 1, h: 1, angle: 0 } }, zoom, 0, 0, 'still');
  if (!a.lod) return;
  a.pass = 0;
  for (const paved of [false, true]) {
    const list = lines.filter((l) => l.paved === paved && l.box.x1 >= view.x0 && l.box.x0 <= view.x1 && l.box.y1 >= view.y0 && l.box.y0 <= view.y1).flatMap((l) => l.paths);
    if (!list.length) continue;
    const spec = paved ? SIDEWALK.paved : SIDEWALK.path;
    const look = paved ? WALK_LOOK.paved : WALK_LOOK.path;
    paths(a, list, spec.w, look.fill, look.edge, part);
  }
}
