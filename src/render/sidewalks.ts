import { add, cross, dist, norm, sub, type Vec } from '../core/vec';
import type { Game } from '../game/game';
import { edgesAt, junctionCuts, plateOutline, pointOff } from '../lanes/geometry';
import type { Corridor, CorridorEnd, LaneNet, LaneNode } from '../lanes/model';
import { ROAD_MARGIN } from '../world/roadTypes';
import { type Footprint, footprintRadius, pointInFootprint } from '../world/spatial';
import { townTier } from '../world/townForms';
import { Art } from './industryArt';
import { type Box, grow } from './tileCache';
import { paths } from './townDecor';

/**
 * Тротуары вдоль улиц городов — только картинка: дорог, узлов, движения и стройки не меняют; рисуются под дорогами
 * (drawSidewalks), в плитки кэша карты. Полоса постоянной ширины вплотную к краю асфальта — по той же геометрии, что
 * асфальт (lanes/geometry: края полос edgesAt + ROAD_MARGIN, обрезы junctionCuts, площадка plateOutline): вдоль
 * полотна — по обеим сторонам, где рядом дома, по его кривой; у перекрёстка тротуары соседних улиц сходятся по
 * всему бордюру угла площадки (концентрично ему; есть тротуар хотя бы у одной из двух улиц — угол обходится целиком, до
 * прямого края другой); у стыка (развилка) — скруглением радиуса CURB, на повороте улицы и у
 * тупика — дугой вокруг узла (у тупика — вокруг центра разворота). Концы тротуаров у узла (SidewalkEnd) — там, где
 * тротуар улицы переходит в скругление угла: от конца до конца через улицу ляжет пешеходный переход.
 */

/** Тротуар: от края полотна (from) шириной w, м. Город — мощёный у самого бордюра, село — утоптанная тропинка. */
export const SIDEWALK = { paved: { from: 0.2, w: 3.4 }, path: { from: 0.9, w: 2 } } as const;
/**
 * Точки оси — через step м; тротуар — где ближе houses м есть участок дома, парка или сквера города (до его края, а не
 * до середины: участки в масштабе застройки, TOWN_SCALE, длинные и глубокие); короче min — нет; разрывы короче gap —
 * сшить, короче hole (около ширины участка: пустой участок, газон между домами) — тоже, если там не станция и не
 * предприятие; не дошёл до конца полотна меньше end м — дотянуть до конца (до угла перекрёстка, где его подхватит
 * скругление); к углу, где тротуар есть у соседней улицы (или у продолжения этой за швом), — дотянуть и с pull м.
 */
const WALK = { step: 2.5, houses: 40, min: 8, gap: 8, hole: 50, end: 25, pull: 60 };
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

/**
 * Где тротуары в партии: дома — все строения городов (и ратуша с площадью), а ещё парки и скверы — вдоль них тоже
 * тротуар; прочие — станции, предприятия, базы; город — в черте его застройки (extent) с запасом 20 м.
 */
export function walkSite(game: Pick<Game, 'index' | 'terrain' | 'towns'>): WalkSite {
  return {
    around: (p, r) => {
      const houses: Footprint[] = [];
      const others: Footprint[] = [];
      for (const s of game.index.near(p, r)) (s.type === 'building' ? houses : others).push(s.fp);
      for (const t of game.towns) {
        if (dist(p, t.center) > (t.extent ?? t.radius) + r) continue;
        for (const k of t.parks ?? []) if (dist(p, k.fp.center) < r + footprintRadius(k.fp)) houses.push(k.fp);
      }
      return { houses, others };
    },
    wet: (p) => game.terrain.isWater(p, 0.6),
    townAt: (p) => {
      const t = game.towns.find((x) => dist(p, x.center) < (x.extent ?? x.radius) + 20);
      if (!t) return null;
      const tier = townTier(t);
      return { paved: tier !== 'village', key: `${t.id}:${tier}` };
    },
  };
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

/**
 * Участок оси полотна, вдоль которого со стороны side идёт тротуар: s0…s1, м; дошедший до узла — от самого узла (0 или
 * длина полотна), а не от обреза площадки.
 */
export interface SidewalkSpan {
  side: 1 | -1;
  s0: number;
  s1: number;
}

export interface SidewalkNet {
  lines: Sidewalk[];
  ends: SidewalkEnd[];
  /** Где вдоль полотна тротуары: по id полотна (откосы там не рисуются — улица в городе спланирована). */
  spans: Map<number, SidewalkSpan[]>;
}

/** Расстояние от точки до прямоугольника участка f, м (внутри — 0). */
function toLot(q: Vec, f: Footprint): number {
  const dx = q.x - f.center.x;
  const dy = q.y - f.center.y;
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  const lx = Math.abs(dx * c + dy * s) - f.w / 2;
  const ly = Math.abs(-dx * s + dy * c) - f.h / 2;
  return Math.hypot(Math.max(0, lx), Math.max(0, ly));
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
  /** Прямой шов (тротуары сходятся в одной точке): дуги нет, только стык — для дотягивания (sidewalkNet). */
  seam?: boolean;
  from: { c: number; end: 'a' | 'b'; side: 1 | -1 };
  to: { c: number; end: 'a' | 'b'; side: 1 | -1 };
}

/**
 * Тротуар вдоль всего бордюра curb (от края одного подъезда к краю другого) — от конца тротуара A до конца B: каждая
 * точка бордюра сдвинута наружу на d (ось тротуара от края асфальта) по биссектрисе соседних отрезков, поэтому дуга
 * угла — концентрична бордюру. Нет тротуара у одной из улиц (A или B — null) — дуга всё равно обходит весь угол и
 * кончается на прямом краю той улицы, сразу за скруглением. Где бордюр круче радиуса сдвига (внутренний угол), точки,
 * что пошли бы назад, пропускаются — без петли.
 */
function curbPts(raw: Vec[], A: Vec | null, B: Vec | null, d: number): number[] {
  // Совпадающие соседние точки (скругление кончается там же, где край подъезда) — одной: у отрезка нулевой длины нет
  // направления.
  const curb = raw.filter((p, i) => i === 0 || Math.hypot(p.x - raw[i - 1].x, p.y - raw[i - 1].y) > 1e-3);
  if (curb.length < 2) return [];
  const n = curb.length;
  // Наружу — в сторону тротуара улицы (от площадки).
  const sgn = A
    ? Math.sign(cross(sub(curb[1], curb[0]), sub(A, curb[0]))) || 1
    : B
      ? Math.sign(cross(sub(curb[n - 1], curb[n - 2]), sub(B, curb[n - 1]))) || 1
      : 1;
  const off = (p: Vec, a: Vec, b: Vec): Vec => {
    const t = norm(sub(b, a));
    return { x: p.x - t.y * sgn * d, y: p.y + t.x * sgn * d };
  };
  const start = A ?? off(curb[0], curb[0], curb[1]);
  const end = B ?? off(curb[n - 1], curb[n - 2], curb[n - 1]);
  const out: Vec[] = [start];
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
  while (out.length > 1 && !ahead(end, n - 1)) out.pop();
  out.push(end);
  return out.flatMap((p) => [p.x, p.y]);
}

/** Точки скругления от конца тротуара A до конца B. */
function cornerPts(k: Corner, A: Vec, B: Vec): number[] {
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
      // Угол обходится, если тротуар может быть хотя бы у одной из двух улиц (нет у обеих — сборка его пропустит).
      if ((!okI && !okJ) || k.pts.length < 2) continue;
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
      // Прямой шов: тротуары сходятся в одной точке — без дуги, но тротуар одного полотна дотянется к другому.
      const seam = Math.hypot(Pi.x - Pj.x, Pi.y - Pj.y) < 0.3;
      out.push({ via: null, center: node.pos, seam, from: { c: ei.corridor.id, end: ei.end, side: si }, to: { c: ej.corridor.id, end: ej.end, side: sj } });
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
  spans: SidewalkSpan[];
}

/**
 * Тротуары полотна c. pull — концы сторон (`a1`, `b-1`…), что тянутся к углу, куда тротуар дошёл с другой улицы: их
 * не дошедший конец дотягивается до узла и с WALK.pull м.
 */
function corridorRun(c: Corridor, site: WalkSite, paved: boolean, near: Around, trim: Trim | undefined, pull?: ReadonlySet<string>): Run {
  const spec = paved ? SIDEWALK.paved : SIDEWALK.path;
  const run: Run = { paths: [], reach: new Set(), ends: [], spans: [] };
  const housed = (q: Vec) => near.houses.some((f) => toLot(q, f) < WALK.houses);
  const blocked = (q: Vec) => near.others.some((f) => pointInFootprint(q, f, spec.w / 2));
  for (const side of [1, -1] as const) {
    const s0 = trim?.a[side] ?? 0;
    const s1 = c.length - (trim?.b[side] ?? 0);
    // Короткое полотно (перемычка между близкими узлами, почти всё — под площадками): тротуар по нему — целиком, если
    // у домов, иначе между углами соседних узлов остался бы разрыв.
    const short = s1 - s0 < WALK.min;
    if (s1 - s0 < 0.5) continue;
    const n = Math.max(2, Math.ceil((s1 - s0) / WALK.step));
    const pts: { x: number; y: number; ok: boolean }[] = [];
    for (let i = 0; i <= n; i++) {
      const s = s0 + ((s1 - s0) * i) / n;
      const q = pointOff(c, s, walkOff(c, s, side, paved));
      pts.push({ ...q, ok: housed(q) && !blocked(q) && !site.wet(q) });
    }
    if (short) {
      if (!pts.some((p) => p.ok) || pts.some((p) => site.wet(p) || blocked(p))) continue;
      for (const p of pts) p.ok = true;
    }
    // Короткие разрывы — сшить; не дошёл до конца полотна чуть-чуть — дотянуть: у угла его подхватит скругление.
    const gapN = Math.round(WALK.gap / ((s1 - s0) / n));
    const endN = Math.round(WALK.end / ((s1 - s0) / n));
    const pullN = Math.round(WALK.pull / ((s1 - s0) / n));
    const holeN = Math.round(WALK.hole / ((s1 - s0) / n));
    for (let i = 0; i < pts.length; ) {
      if (pts[i].ok) {
        i++;
        continue;
      }
      let j = i;
      while (j < pts.length && !pts[j].ok) j++;
      // Разрыв посреди улицы — сшить: короткий — всегда, длиной с участок — если там не станция и не предприятие.
      const inner = i > 0 && j < pts.length && (j - i <= gapN || (j - i <= holeN && pts.slice(i, j).every((p) => !blocked(p)))) && pts.slice(i, j).every((p) => !site.wet(p));
      const lim = pull?.has(`${i === 0 ? 'a' : 'b'}${side}`) ? Math.max(endN, pullN) : endN;
      const edge = (i === 0) !== (j === pts.length) && j - i <= lim && pts.slice(i, j).every((p) => !site.wet(p) && !blocked(p));
      if (inner || edge) for (let k = i; k < j; k++) pts[k].ok = true;
      i = j;
    }
    let cur: number[] = [];
    let first = -1;
    const flush = (last: number) => {
      if (cur.length >= 4 && (short || (cur.length / 2 - 1) * ((s1 - s0) / n) >= WALK.min)) {
        run.paths.push(cur);
        if (first === 0) run.reach.add(`a${side}`);
        if (last === n) run.reach.add(`b${side}`);
        run.spans.push({ side, s0: first === 0 ? 0 : s0 + ((s1 - s0) * first) / n, s1: last === n ? c.length : s0 + ((s1 - s0) * last) / n });
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

/**
 * Кэш тротуаров по полотнам между пересчётами (sidewalkNet): run — как есть (null — ещё не считали), pulled — с концами,
 * дотянутыми к углам (pull — какие).
 */
export type SidewalkCache = Map<number, { sig: string; run: Run | null; paved: boolean; pulled?: { pull: string; run: Run } }>;

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
  // Тротуары полотен; pull — концы сторон, что дотягиваются к углу (ниже).
  const near = new Map<number, Around>();
  const runOf = (id: number, pull = ''): Run => {
    const { paved, townKey } = eligible.get(id)!;
    const c = roads.corridor(id);
    let around = near.get(id);
    if (!around) near.set(id, (around = site.around(c.lut.pointAt(c.length / 2), c.length / 2 + WALK.houses + 40)));
    const tr = trims.get(id);
    const key = `${c.rev}|${townKey}|${paved}|${around.houses.length}:${around.others.length}|${tr ? JSON.stringify(tr) : ''}`;
    let had = cache?.get(id);
    if (had?.sig !== key) {
      had = { sig: key, run: null, paved };
      cache?.set(id, had);
    }
    if (!pull) return (had.run ??= corridorRun(c, site, paved, around, tr));
    if (had.pulled?.pull !== pull) had.pulled = { pull, run: corridorRun(c, site, paved, around, tr, new Set(pull.split(','))) };
    return had.pulled.run;
  };
  const runs = new Map<number, Run>();
  for (const id of eligible.keys()) runs.set(id, runOf(id));
  const endOf = (r: { c: number; end: 'a' | 'b'; side: 1 | -1 }) => runs.get(r.c)?.ends.find((e) => e.end === r.end && e.side === r.side) ?? null;
  // Угол, куда тротуар не дошёл, хотя у той улицы с этой стороны он есть, но кончился раньше: дотягивается до угла —
  // без обрыва тротуара у самого перекрёстка. У перекрёстка — с любой стороны угла; на повороте улицы и на шве — если
  // по другую сторону узла тротуар до него дошёл (иначе два дотягивания сшили бы пустырь).
  const pulls = new Map<number, Set<string>>();
  for (const list of corners.values()) {
    for (const k of list) {
      for (const [r, other] of [
        [k.from, k.to],
        [k.to, k.from],
      ] as const) {
        if (endOf(r) || (!k.curb && !endOf(other)) || !runs.get(r.c)?.spans.some((s) => s.side === r.side)) continue;
        let set = pulls.get(r.c);
        if (!set) pulls.set(r.c, (set = new Set()));
        set.add(`${r.end}${r.side}`);
      }
    }
  }
  for (const [id, set] of pulls) runs.set(id, runOf(id, [...set].sort().join(',')));
  const lines: Sidewalk[] = [];
  const ends: SidewalkEnd[] = [];
  const spans = new Map<number, SidewalkSpan[]>();
  for (const [id, run] of runs) {
    const c = roads.corridor(id);
    const paved = eligible.get(id)!.paved;
    for (const e of run.ends) ends.push({ node: e.end === 'a' ? c.a : c.b, corridor: id, side: e.side, x: e.x, y: e.y, ux: e.ux, uy: e.uy, w: (paved ? SIDEWALK.paved : SIDEWALK.path).w });
    if (run.paths.length) lines.push({ key: `c${id}`, paths: run.paths, paved, box: boxOf(run.paths), sig: `${paved}|${sigOf(run.paths)}` });
    if (run.spans.length) spans.set(id, run.spans);
  }
  // Скругления — где оба тротуара дошли до угла; у перекрёстка — где дошёл хотя бы один: угол обходится по всему
  // бордюру (curbPts).
  for (const [nid, list] of corners) {
    const p: number[][] = [];
    let paved: boolean | null = null;
    for (const k of list) {
      const A = endOf(k.from);
      const B = endOf(k.to);
      if (k.seam || (!A && !B)) continue;
      if (!k.curb && (!A || !B)) continue;
      const pv = eligible.get((A ? k.from : k.to).c)?.paved ?? true;
      paved ??= pv;
      const spec = pv ? SIDEWALK.paved : SIDEWALK.path;
      const pts = k.curb ? curbPts(k.curb, A, B, spec.from + spec.w / 2) : cornerPts(k, A!, B!);
      const i = Math.floor(pts.length / 4) * 2;
      if (pts.length >= 4 && !site.wet({ x: pts[i], y: pts[i + 1] })) p.push(pts);
    }
    if (!p.length) continue;
    lines.push({ key: `n${nid}`, paths: p, paved: paved ?? true, box: boxOf(p), sig: `${paved}|${sigOf(p)}` });
  }
  if (cache && cache.size > eligible.size * 2 + 200) for (const id of [...cache.keys()]) if (!eligible.has(id)) cache.delete(id);
  return { lines, ends, spans };
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
