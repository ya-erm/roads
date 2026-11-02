import { circleArc, Cubic, CurveLUT, intersectCurves, straightCubic } from '../core/bezier';
import type { Rng } from '../core/rng';
import { add, angleOf, dist, dot, lerp, norm, scale, sub, Vec } from '../core/vec';
import { edgesAt } from '../lanes/geometry';
import { Corridor, LaneNet, LaneNode, LaneSlot, twoWay } from '../lanes/model';
import { CargoType, INDUSTRY_LIST, TOWN_CARGO } from './cargo';
import type { Industry, Structure, Town, TownBuilding, TownStyle } from './entities';
import type { Network } from './network';
import { isRail, isTrunk, RAIL_HALF, RoadClass, ROAD_MARGIN } from './roadTypes';
import { areaFactor, DEFAULT_SETTINGS, INDUSTRY_DENSITY, townSizes, WorldSettings } from './settings';
import { Footprint, footprintRadius, FootprintIndex, pointInFootprint } from './spatial';
import type { Terrain } from './terrain';

const TOWN_NAMES = [
  'Берёзовка',
  'Озёрск',
  'Заречье',
  'Каменка',
  'Светлогорск',
  'Сосновый Бор',
  'Ольховка',
  'Ясногорск',
  'Майское',
  'Красноборск',
  'Новоселье',
  'Липовец',
  'Белогорье',
  'Ключи',
  'Верхнедольск',
  'Рябиновка',
  'Солнечногорск',
  'Яблоневка',
  'Тихорецк',
  'Медведково',
];

const RES_COLORS: [string, string][] = [
  ['#efe3cf', '#b9654d'],
  ['#e8d6bd', '#9c5a46'],
  ['#f1e7d8', '#8a6a55'],
  ['#e2d2c0', '#a8493b'],
  ['#ece0c8', '#6f7d8c'],
  ['#e9dcc9', '#7d6a8f'],
];
const BLOCK_COLORS: [string, string][] = [
  ['#e4dccf', '#8c7d70'],
  ['#d9d2c6', '#6f6a66'],
];
const COM_COLORS: [string, string][] = [
  ['#d5dde5', '#7d8a99'],
  ['#c9d3dc', '#5f6f80'],
  ['#dfe2e6', '#8f96a0'],
];

/** Профиль городской дороги: класс и полосы. */
interface Profile {
  cls: RoadClass;
  lanes: LaneSlot[];
}
const STREET: Profile = { cls: 'street', lanes: twoWay(1, 1) };
const AVENUE: Profile = { cls: 'avenue', lanes: twoWay(2, 2) };

export interface WorldContext {
  /** Дороги — сеть полос. */
  roads: LaneNet;
  terrain: Terrain;
  index: FootprintIndex<Structure>;
  rng: Rng;
  nextId: () => number;
  /** Ж/д пути: на них (кроме тоннелей) город не строит. */
  rail?: Network;
}

/** Полуширина асфальта полотна в точке s (по большей стороне). */
export function halfAtS(c: Corridor, s: number): number {
  const e = edgesAt(c, s);
  return e ? Math.max(-e[0], e[1]) + ROAD_MARGIN : ROAD_MARGIN;
}

/** Полуширина полотна по всей длине (по самому широкому месту). */
export function corridorHalf(c: Corridor): number {
  let h = 0;
  for (let i = 0; i <= 4; i++) h = Math.max(h, halfAtS(c, (c.length * i) / 4));
  return h;
}

export function generateWorld(ctx: WorldContext, settings: WorldSettings = DEFAULT_SETTINGS): { towns: Town[]; industries: Industry[] } {
  const towns: Town[] = [];
  const names = [...TOWN_NAMES];
  // На тесной карте города ставим ближе друг к другу.
  const gap = settings.size === 'small' ? 600 : 900;
  for (const size of townSizes(settings.towns)) {
    const reach = (size + 1.5) * 110;
    for (let attempt = 0; attempt < 80; attempt++) {
      const c = {
        x: ctx.rng.range(reach + 300, ctx.terrain.width - reach - 300),
        y: ctx.rng.range(reach + 300, ctx.terrain.height - reach - 300),
      };
      if (ctx.terrain.isWater(c, 200)) continue;
      if (towns.some((t) => dist(t.center, c) < t.radius + reach + gap)) continue;
      const name = names.splice(ctx.rng.int(0, names.length), 1)[0];
      const style: TownStyle =
        size === 3
          ? 'radial'
          : size === 2
            ? ctx.rng.pick(['radial', 'organic', 'organic', 'organic'] as const)
            : ctx.rng.pick(['linear', 'linear', 'organic'] as const);
      const town = buildTown(ctx, towns.length + 1, c, name, size, style);
      if (town) {
        towns.push(town);
        break;
      }
      names.push(name);
    }
  }
  assignDemands(towns, ctx.rng);
  const industries = placeIndustries(ctx, towns, INDUSTRY_DENSITY[settings.industries].k * areaFactor(settings));
  // Места для городов и предприятий выбраны по всем улицам; дальше радиус города — по плотной застройке.
  for (const t of towns) measureTown(t);
  return { towns, industries };
}

/** Раздаёт городам потребности так, чтобы каждый груз был нужен хотя бы одному городу. */
function assignDemands(towns: Town[], rng: Rng): void {
  const used = new Map<CargoType, number>(TOWN_CARGO.map((c) => [c, 0]));
  const order = [...towns].sort((a, b) => b.population - a.population);
  for (const t of order) {
    const count = t.population > 2000 ? 3 : 2;
    const pool = [...TOWN_CARGO].sort((a, b) => used.get(a)! - used.get(b)! + rng.range(-0.5, 0.5));
    t.demands = pool.slice(0, count);
    for (const c of t.demands) used.set(c, used.get(c)! + 1);
  }
}

// ---------- Улицы ----------

interface StreetBuilder {
  ctx: WorldContext;
  segs: Corridor[];
}

function nodeAt(sb: StreetBuilder, p: Vec): LaneNode | null {
  const { terrain, roads } = sb.ctx;
  if (!terrain.inBounds(p, 80) || terrain.isWater(p, 36)) return null;
  const near = roads.nodesNear(p, 20).sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
  return near ?? roads.addJunction(p);
}

/** Добавляет улицу, если она не пересекает воду и другие улицы. */
function street(sb: StreetBuilder, a: LaneNode | null, b: LaneNode | null, curve: Cubic | null, profile: Profile): Corridor | null {
  if (!a || !b || a === b) return null;
  const { roads, terrain } = sb.ctx;
  if (a.corridors.some((id) => b.corridors.includes(id))) return null;
  const c = curve ?? straightCubic(a.pos, b.pos);
  const fixed: Cubic = { p0: a.pos, p1: add(c.p1, sub(a.pos, c.p0)), p2: add(c.p2, sub(b.pos, c.p3)), p3: b.pos };
  const lut = new CurveLUT(fixed);
  for (let i = 1; i < 12; i++) if (terrain.isWater(lut.pointAt((lut.length * i) / 12), 22)) return null;
  for (const other of roads.corridorsNear(lerp(a.pos, b.pos, 0.5), lut.length / 2 + 40)) {
    if ([other.a, other.b].some((id) => id === a.id || id === b.id)) continue;
    if (intersectCurves(lut, other.lut).length) return null;
  }
  const seg = roads.addCorridor(a.id, b.id, { cls: profile.cls, lanes: profile.lanes, curve: fixed });
  sb.segs.push(seg);
  return seg;
}

/**
 * Две улицы одного профиля, продолжающие друг друга почти по прямой, сходятся не перекрёстком,
 * а стыком: разметка идёт насквозь. Их концы выравниваются точно по общему направлению.
 */
export function smoothJoins(roads: LaneNet, nodes: Iterable<number>): void {
  for (const id of nodes) {
    const n = roads.nodes.get(id);
    if (!n || n.kind !== 'junction' || n.corridors.length !== 2) continue;
    const [e1, e2] = roads.ends(n);
    if (!e1 || !e2 || e1.corridor === e2.corridor || e1.corridor.cls !== e2.corridor.cls) continue;
    if (dot(e1.away, e2.away) > -Math.cos(0.3)) continue;
    const dir = norm(sub(e2.away, e1.away));
    // Полосы с обеих сторон должны совпасть по положению и направлению.
    const sig = (away: Vec, c: Corridor, end: 'a' | 'b') => {
      const along = dot(end === 'a' ? away : scale(away, -1), dir) >= 0 ? 1 : -1;
      return c.lanes.map((l) => `${Math.round(l.offset * along * 2)}:${l.flow * along > 0}`).sort().join();
    };
    if (sig(e1.away, e1.corridor, e1.end) !== sig(e2.away, e2.corridor, e2.end)) continue;
    n.kind = 'seam';
    n.dir = dir;
    for (const e of [e1, e2]) {
      const side = dot(e.away, dir) >= 0 ? 1 : -1;
      const cv = { ...e.corridor.curve };
      if (e.end === 'a') cv.p1 = add(cv.p0, scale(dir, side * dist(cv.p0, cv.p1)));
      else cv.p2 = add(cv.p3, scale(dir, side * dist(cv.p3, cv.p2)));
      roads.setCurve(e.corridor, cv);
    }
  }
}

/** Отрезок кривой Катмулла-Рома между p1 и p2 с соседями p0 и p3 — плавная улица через узлы. */
function catmull(p0: Vec, p1: Vec, p2: Vec, p3: Vec): Cubic {
  return { p0: p1, p1: add(p1, scale(sub(p2, p0), 1 / 6)), p2: sub(p2, scale(sub(p3, p1), 1 / 6)), p3: p2 };
}

function radialStreets(sb: StreetBuilder, center: Vec, size: number): void {
  const { rng } = sb.ctx;
  const rays = size >= 3 ? 6 : 5;
  const rings = size >= 3 ? 4 : 3;
  const radius = (k: number) => 110 + k * 140;
  const a0 = rng.range(0, Math.PI * 2);
  // На каждом кольце столько лучей, чтобы дуга между ними была не длиннее ~260.
  const counts: number[] = [];
  for (let k = 0; k < rings; k++) {
    let n = k === 0 ? rays : counts[k - 1];
    while ((Math.PI * 2 * radius(k)) / n > 260) n *= 2;
    counts.push(k === rings - 1 && k > 0 ? counts[k - 1] : n);
  }
  const angle = (n: number, i: number) => a0 + (i * Math.PI * 2) / n;
  const nodes = new Map<string, LaneNode | null>();
  const key = (k: number, n: number, i: number) => `${k}:${((i * rays * 8) / n) | 0}`;
  const nodeOn = (k: number, n: number, i: number) => {
    const id = key(k, n, i);
    if (!nodes.has(id)) {
      const a = angle(n, i);
      nodes.set(id, nodeAt(sb, add(center, { x: Math.cos(a) * radius(k), y: Math.sin(a) * radius(k) })));
    }
    return nodes.get(id) ?? null;
  };
  // Кольца.
  for (let k = 0; k < rings; k++) {
    const n = counts[k];
    for (let i = 0; i < n; i++) {
      if (k === rings - 1 && rng.chance(0.15)) continue;
      const arc = circleArc(center, radius(k), angle(n, i), angle(n, i + 1));
      street(sb, nodeOn(k, n, i), nodeOn(k, n, (i + 1) % n), arc, k === 0 ? AVENUE : STREET);
    }
  }
  // Лучи: каждый узел внешнего кольца соединяется с внутренним, если там есть узел под тем же углом.
  for (let k = 0; k < rings - 1; k++) {
    const inner = counts[k];
    const outer = counts[k + 1];
    for (let i = 0; i < outer; i++) {
      const j = (i * inner) / outer;
      if (!Number.isInteger(j)) continue;
      const isMain = (i * rays) % outer === 0 && ((i * rays) / outer) % 2 === 0;
      street(sb, nodeOn(k, inner, j), nodeOn(k + 1, outer, i), null, isMain && size >= 3 ? AVENUE : STREET);
    }
  }
  // Выезды из города по главным лучам.
  const last = rings - 1;
  for (let i = 0; i < rays; i++) {
    if (!rng.chance(0.6)) continue;
    const n = counts[last];
    const from = nodeOn(last, n, (i * n) / rays);
    if (!from) continue;
    const a = angle(rays, i);
    const p = add(center, { x: Math.cos(a) * (radius(last) + 200), y: Math.sin(a) * (radius(last) + 200) });
    street(sb, from, nodeAt(sb, p), null, size >= 3 && i % 2 === 0 ? AVENUE : STREET);
  }
}

function organicStreets(sb: StreetBuilder, center: Vec, size: number): void {
  const { rng } = sb.ctx;
  const spacing = rng.range(135, 165);
  const rot = rng.range(0, Math.PI / 2);
  const ux = { x: Math.cos(rot), y: Math.sin(rot) };
  const uy = { x: -Math.sin(rot), y: Math.cos(rot) };
  const lobes = rng.int(2, 5);
  const phase = rng.range(0, Math.PI * 2);
  const reach = (i: number, j: number) => (size + 0.5) * (1 + 0.25 * Math.sin(lobes * Math.atan2(j, i) + phase));
  // Плавная деформация всей сетки: улицы изгибаются вместе, без изломов в узлах.
  const amp = spacing * rng.range(0.12, 0.2);
  const wl = spacing * rng.range(3, 4.5);
  const [f1, f2, f3, f4] = [0, 0, 0, 0].map(() => rng.range(0, Math.PI * 2));
  const warp = (x: number, y: number): Vec => ({
    x: amp * Math.sin(y / wl + f1) + amp * 0.5 * Math.sin((x + y) / (wl * 0.8) + f2),
    y: amp * Math.sin(x / wl + f3) + amp * 0.5 * Math.sin((x - y) / (wl * 0.8) + f4),
  });
  const n = size + 1;
  const pos = (i: number, j: number) => {
    const lx = i * spacing;
    const ly = j * spacing;
    const w = warp(lx, ly);
    return add(center, add(scale(ux, lx + w.x), scale(uy, ly + w.y)));
  };
  const inside = (i: number, j: number) => Math.hypot(i, j) <= reach(i, j);
  const grid = new Map<string, LaneNode | null>();
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) if (inside(i, j)) grid.set(`${i}:${j}`, nodeAt(sb, pos(i, j)));
  }
  const connect = (i: number, j: number, di: number, dj: number) => {
    const a = grid.get(`${i}:${j}`);
    const b = grid.get(`${i + di}:${j + dj}`);
    if (!a || !b) return;
    const major = di ? j === 0 : i === 0;
    const curve = catmull(pos(i - di, j - dj), pos(i, j), pos(i + di, j + dj), pos(i + 2 * di, j + 2 * dj));
    street(sb, a, b, curve, major && size >= 2 ? AVENUE : STREET);
  };
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      connect(i, j, 1, 0);
      connect(i, j, 0, 1);
    }
  }
}

function linearStreets(sb: StreetBuilder, center: Vec, size: number): void {
  const { rng } = sb.ctx;
  const dir = rng.range(0, Math.PI * 2);
  const u = { x: Math.cos(dir), y: Math.sin(dir) };
  const nrm = { x: -u.y, y: u.x };
  const K = 2 + size;
  const step = rng.range(150, 180);
  const amp = rng.range(30, 70);
  const ph = rng.range(0, Math.PI * 2);
  const pts: Vec[] = [];
  for (let k = -K; k <= K; k++) pts.push(add(center, add(scale(u, k * step), scale(nrm, amp * Math.sin(k * 0.45 + ph)))));
  const mainNodes = pts.map((p) => nodeAt(sb, p));
  // Главная улица — гладкая кривая через точки.
  for (let i = 0; i < pts.length - 1; i++) {
    const curve = catmull(pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(pts.length - 1, i + 2)]);
    street(sb, mainNodes[i], mainNodes[i + 1], curve, size >= 2 ? AVENUE : STREET);
  }
  // Поперечные улицы и задние улицы, образующие кварталы.
  for (const side of [-1, 1]) {
    let prevEnd: LaneNode | null = null;
    for (let i = 1; i < pts.length - 1; i++) {
      const from = mainNodes[i];
      if (!from || !rng.chance(0.6)) {
        prevEnd = null;
        continue;
      }
      const tangent = norm(sub(pts[i + 1], pts[i - 1]));
      const out = { x: -tangent.y * side, y: tangent.x * side };
      const endPos = add(from.pos, scale(out, rng.range(130, 170)));
      const end = nodeAt(sb, endPos);
      const seg = street(sb, from, end, null, STREET);
      if (seg && end && prevEnd && rng.chance(0.7)) street(sb, prevEnd, end, null, STREET);
      prevEnd = seg ? end : null;
    }
  }
}

export function buildTown(ctx: WorldContext, id: number, center: Vec, name: string, size: number, style: TownStyle): Town | null {
  const { roads } = ctx;
  const sb: StreetBuilder = { ctx, segs: [] };
  if (style === 'radial') radialStreets(sb, center, size);
  else if (style === 'organic') organicStreets(sb, center, size);
  else linearStreets(sb, center, size);

  // Оставляем связную часть вокруг центра.
  const created = new Set<number>();
  for (const s of sb.segs) created.add(s.a).add(s.b);
  let start: LaneNode | null = null;
  for (const nid of created) {
    const n = roads.node(nid);
    if (!start || dist(n.pos, center) < dist(start.pos, center)) start = n;
  }
  const keep = new Set<number>();
  if (start) {
    const queue = [start.id];
    keep.add(start.id);
    while (queue.length) {
      const nid = queue.pop()!;
      for (const sid of roads.node(nid).corridors) {
        const s = roads.corridor(sid);
        const other = s.a === nid ? s.b : s.a;
        if (!keep.has(other)) {
          keep.add(other);
          queue.push(other);
        }
      }
    }
  }
  for (const s of sb.segs) if (!keep.has(s.a)) roads.removeCorridor(s.id);
  for (const nid of created) if (!keep.has(nid) && roads.nodes.has(nid) && !roads.node(nid).corridors.length) roads.removeNode(nid);
  const alive = sb.segs.filter((s) => roads.corridors.has(s.id));
  if (alive.length < 3) {
    for (const s of alive) roads.removeCorridor(s.id);
    return null;
  }
  // Улица, продолжающая другую почти по прямой, — без перекрёстка; одиночные концы — тупики.
  smoothJoins(roads, keep);
  for (const nid of keep) {
    const n = roads.nodes.get(nid);
    if (n?.kind === 'junction' && n.corridors.length === 1) {
      n.kind = 'seam';
      n.dir = scale(roads.ends(n)[0].away, -1);
    }
  }

  let radius = 0;
  let top = center.y;
  for (const s of alive) {
    for (const p of [s.curve.p0, s.curve.p3]) {
      radius = Math.max(radius, dist(p, center));
      top = Math.min(top, p.y);
    }
  }
  const town: Town = {
    id,
    name,
    center,
    radius: radius + 30,
    top: top - 30,
    style,
    population: 0,
    buildings: [],
    streets: alive.map((s) => s.id),
    demands: [],
    supplied: {},
    lastSupplied: {},
    tripAcc: 0,
    growthAcc: 0,
  };
  placeLandmark(ctx, town);
  for (const s of alive) fillStreet(ctx, town, s, style === 'linear' ? 0.75 : 0.88);
  recountPopulation(town);
  return town;
}

/** Ратуша или собор в центре города: повёрнута вдоль ближайшей улицы и не задевает дороги. */
function placeLandmark(ctx: WorldContext, town: Town): void {
  for (const size of [44, 34]) {
    for (let r = 0; r < 240; r += 12) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const center = add(town.center, { x: Math.cos(a) * r, y: Math.sin(a) * r });
        const fp: Footprint = { center, w: size, h: size, angle: streetAngle(ctx, center) };
        if (placeable(ctx, fp, -1) && clearOfRoads(ctx, fp, 3)) {
          addLandmark(ctx, town, fp);
          return;
        }
      }
    }
  }
}

/** Направление ближайшей улицы — чтобы здание стояло ровно вдоль неё. */
function streetAngle(ctx: WorldContext, p: Vec): number {
  let best = Infinity;
  let angle = 0;
  for (const seg of ctx.roads.corridorsNear(p, 200)) {
    const hit = seg.lut.closest(p);
    if (hit.d < best) {
      best = hit.d;
      angle = angleOf(seg.lut.tangentAt(hit.s));
    }
  }
  return angle;
}

/** Точная проверка по контуру: ни одна точка здания не ближе margin к краю дороги. */
function clearOfRoads(ctx: WorldContext, fp: Footprint, margin: number): boolean {
  const c = Math.cos(fp.angle);
  const s = Math.sin(fp.angle);
  const pts: Vec[] = [];
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const lx = (i / 4 - 0.5) * fp.w;
      const ly = (j / 4 - 0.5) * fp.h;
      pts.push({ x: fp.center.x + lx * c - ly * s, y: fp.center.y + lx * s + ly * c });
    }
  }
  for (const seg of ctx.roads.corridorsNear(fp.center, footprintRadius(fp) + 60)) {
    const hw = corridorHalf(seg) + margin;
    if (pts.some((q) => seg.lut.closest(q).d < hw)) return false;
  }
  return true;
}

/** Узел, откуда выезжают и куда приезжают машины жителей дома: ближайший перекрёсток или тупик. */
export function anchorFor(roads: LaneNet, p: Vec): number {
  for (const r of [150, 400, 1200]) {
    const near = roads
      .nodesNear(p, r)
      .filter((n) => n.kind === 'junction' || roads.isDeadEnd(n))
      .sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
    if (near) return near.id;
  }
  return 0;
}

function addLandmark(ctx: WorldContext, town: Town, fp: Footprint): void {
  const b: TownBuilding = {
    type: 'building',
    id: ctx.nextId(),
    townId: town.id,
    fp,
    kind: 'landmark',
    floors: 4,
    anchor: anchorFor(ctx.roads, fp.center),
    color: '#efe6d2',
    roof: '#5c7fa3',
  };
  ctx.index.add(b);
  town.buildings.push(b);
}

/**
 * Застраивает улицу домами по обеим сторонам. density — доля занятых мест;
 * reach — дальше этого от центра города домов не ставим.
 */
export function fillStreet(ctx: WorldContext, town: Town, seg: Corridor, density: number, limit = Infinity, reach = Infinity): number {
  const { rng } = ctx;
  const hw = corridorHalf(seg);
  let added = 0;
  for (const side of [-1, 1]) {
    let s = 26;
    while (s < seg.length - 26 && added < limit) {
      const p0 = seg.lut.pointAt(s);
      const closeness = 1 - Math.min(1, dist(p0, town.center) / Math.max(1, town.radius));
      const big = closeness > 0.55 && rng.chance(0.55);
      const width = big ? rng.range(26, 36) : rng.range(16, 24);
      const depth = big ? rng.range(22, 28) : rng.range(15, 22);
      const at = s + width / 2;
      if (at + width / 2 > seg.length - 22) break;
      s += width + rng.range(3, 7);
      if (rng.next() > density || dist(p0, town.center) > reach) continue;
      const p = seg.lut.pointAt(at);
      const t = seg.lut.tangentAt(at);
      const normal = { x: -t.y * side, y: t.x * side };
      const center = add(p, scale(normal, hw + 5 + depth / 2));
      const fp: Footprint = { center, w: width, h: depth, angle: Math.atan2(t.y, t.x) };
      if (!placeable(ctx, fp, seg.id)) continue;
      const kind: 'res' | 'com' = closeness > 0.6 && rng.chance(0.6) ? 'com' : rng.chance(0.1) ? 'com' : 'res';
      const [color, roof] = rng.pick(kind === 'com' ? COM_COLORS : big ? BLOCK_COLORS : RES_COLORS);
      const floors = kind === 'com' ? rng.int(2, 6) : big ? rng.int(3, 6) : rng.int(1, 3);
      const b: TownBuilding = {
        type: 'building',
        id: ctx.nextId(),
        townId: town.id,
        fp,
        kind,
        floors,
        anchor: anchorFor(ctx.roads, p),
        color,
        roof,
      };
      ctx.index.add(b);
      town.buildings.push(b);
      added++;
      // Второй ряд домов в глубине квартала — чаще ближе к центру.
      if (added < limit && rng.chance(0.2 + 0.5 * closeness)) {
        const d2 = rng.range(15, 22);
        const rear: Footprint = {
          center: add(p, scale(normal, hw + 5 + depth + 5 + d2 / 2)),
          w: width * rng.range(0.75, 1),
          h: d2,
          angle: fp.angle,
        };
        if (placeable(ctx, rear, seg.id)) {
          const [rc, rr] = rng.pick(RES_COLORS);
          const back: TownBuilding = { ...b, id: ctx.nextId(), fp: rear, kind: 'res', floors: rng.int(1, 3), color: rc, roof: rr };
          ctx.index.add(back);
          town.buildings.push(back);
          added++;
        }
      }
    }
  }
  return added;
}

/** Магистраль или съезд развязки: город к ним не пристраивается. */
export const isHighway = (c: Corridor) => isTrunk(c.cls) || (c.cls !== 'street' && c.lanes.every((l) => l.flow === c.lanes[0]?.flow));
/** Сколько свободного места оставляют дома до магистрали или съезда. */
const HIGHWAY_BUFFER = 50;

/** Полотно — часть развязки или магистрали: само магистральное или примыкает к ней в узле. */
export function nearHighway(roads: LaneNet, seg: Corridor): boolean {
  if (isHighway(seg)) return true;
  return [seg.a, seg.b].some((id) => roads.node(id).corridors.some((sid) => isHighway(roads.corridor(sid))));
}

/** Сколько свободного места оставляют дома до насыпи путей. */
const RAIL_BUFFER = 4;

/** Насыпь путей (кроме тоннелей) с запасом margin задевает здание. */
export function onRail(rail: Network | undefined, fp: Footprint, margin: number): boolean {
  if (!rail) return false;
  const r = footprintRadius(fp) + RAIL_HALF + margin;
  for (const seg of rail.segmentsNear(fp.center, r)) {
    if (!isRail(seg.spec)) continue;
    const hit = seg.lut.closest(fp.center);
    if (hit.d > r) continue;
    for (let s = Math.max(0, hit.s - r); s <= Math.min(seg.length, hit.s + r); s += 3) {
      if (rail.levelAt(seg, s) < -0.75) continue;
      if (pointInFootprint(seg.lut.pointAt(s), fp, RAIL_HALF + margin)) return true;
    }
  }
  return false;
}

/** Ось путей (кроме тоннелей) ближе d к точке. */
export function railNear(rail: Network | undefined, p: Vec, d: number): boolean {
  if (!rail) return false;
  for (const seg of rail.segmentsNear(p, d)) {
    if (!isRail(seg.spec)) continue;
    const hit = seg.lut.closest(p);
    if (hit.d < d && rail.levelAt(seg, hit.s) >= -0.75) return true;
  }
  return false;
}

/** Можно ли поставить здание: не в воде, не на дороге, не на путях и не на другом здании. */
export function placeable(ctx: WorldContext, fp: Footprint, ownSeg: number): boolean {
  const { roads, terrain, index } = ctx;
  if (!terrain.inBounds(fp.center, 30) || terrain.isWater(fp.center, footprintRadius(fp) + 4)) return false;
  if (index.overlaps(fp, 2)) return false;
  if (onRail(ctx.rail, fp, RAIL_BUFFER)) return false;
  const r = footprintRadius(fp);
  for (const seg of roads.corridorsNear(fp.center, r + 30 + HIGHWAY_BUFFER)) {
    if (seg.id === ownSeg) continue;
    const hit = seg.lut.closest(fp.center);
    const hw = halfAtS(seg, hit.s);
    if (hit.d < hw + r - 3) return false;
    if (isHighway(seg) && hit.d < hw + r + HIGHWAY_BUFFER) return false;
  }
  if (roads.nodesNear(fp.center, r + 12).length) return false;
  return true;
}

export function recountPopulation(town: Town): void {
  town.population = town.buildings.reduce((sum, b) => sum + (b.kind === 'res' ? b.floors * 14 : b.kind === 'com' ? b.floors * 4 : 0), 0);
}

/**
 * Край плотной застройки — расстояние от центра: идём от середины застройки наружу, пока кольцо
 * шириной 80 м застроено хотя бы впятеро реже ядра. Длинные улицы с редкими домами в поле за ним не в счёт.
 */
export function coreRadius(town: Town): number {
  const ds = town.buildings.map((b) => dist(b.fp.center, town.center)).sort((a, b) => a - b);
  if (!ds.length) return 0;
  const W = 80;
  let r = Math.max(60, ds[Math.floor(ds.length / 2)]);
  let i = 0;
  while (i < ds.length && ds[i] <= r) i++;
  const core = i / (Math.PI * r * r);
  let j = i;
  for (;;) {
    while (j < ds.length && ds[j] <= r + W) j++;
    if (j - i < core * 0.2 * Math.PI * ((r + W) ** 2 - r ** 2)) break;
    r += 20;
    while (i < ds.length && ds[i] <= r) i++;
  }
  return Math.min(ds[ds.length - 1], r + W / 2);
}

/**
 * Радиус города — по плотной застройке (круг на миникарте, подписи, охват);
 * extent — до самого дальнего дома (отрисовка, охват станций).
 */
export function measureTown(town: Town): void {
  if (!town.buildings.length) return;
  let far = 0;
  for (const b of town.buildings) far = Math.max(far, dist(b.fp.center, town.center) + footprintRadius(b.fp));
  town.radius = Math.max(100, coreRadius(town) + 30);
  town.extent = Math.max(town.radius, far + 10);
}

function placeIndustries(ctx: WorldContext, towns: Town[], density: number): Industry[] {
  const { rng, terrain, index } = ctx;
  const result: Industry[] = [];
  for (const info of INDUSTRY_LIST) {
    // Каждого типа хотя бы одно, чтобы все цепочки были замкнуты.
    const count = Math.max(1, Math.round(info.count * density));
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < 120; attempt++) {
        const center = { x: rng.range(300, terrain.width - 300), y: rng.range(300, terrain.height - 300) };
        const fp: Footprint = { center, w: info.w, h: info.h, angle: rng.range(-0.6, 0.6) };
        if (terrain.isWater(center, footprintRadius(fp) + 30)) continue;
        if (towns.some((t) => dist(t.center, center) < t.radius + 280)) continue;
        if (result.some((i) => dist(i.fp.center, center) < 520)) continue;
        if (index.overlaps(fp, 20)) continue;
        const nearest = towns.reduce<Town | null>((best, t) => (!best || dist(t.center, center) < dist(best.center, center) ? t : best), null);
        const industry: Industry = {
          type: 'industry',
          id: ctx.nextId(),
          info,
          name: nearest ? `${info.name} (${nearest.name})` : info.name,
          fp,
          stock: {},
          output: 0,
          producedMonth: 0,
          producedLast: 0,
          prodAcc: 0,
        };
        index.add(industry);
        result.push(industry);
        if (info.kind === 'forest') terrain.addForest(center, 220, rng);
        break;
      }
    }
  }
  return result;
}

export function normalTowards(seg: Corridor, s: number, p: Vec): Vec {
  const t = seg.lut.tangentAt(s);
  const n = { x: -t.y, y: t.x };
  const d = sub(p, seg.lut.pointAt(s));
  return norm(d.x * n.x + d.y * n.y >= 0 ? n : scale(n, -1));
}
