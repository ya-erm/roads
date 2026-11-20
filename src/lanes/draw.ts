import { add, closestOnSegment, cubicBezier, dist, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { isDirt, LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { arrowAt, arrowShape } from './arrowShape';
import { bridgeLook, deckAlong, nodeDeck } from './deck';
import { awaySign, edgesAt, junctionCuts, laneShare, paintedEdges, plateOutline, pointOff, sFrom, stations } from './geometry';
import { Corridor, CorridorEnd, End, LaneNet, LaneNode, LAT_EPS, laneWidth, layerOf } from './model';
import { noseParapet, PARAPET, parapetLine, parapetWidth } from './parapet';
import { onPrefs, prefOn } from '../ui/prefs';
import { insidePoly, type JunctionMarks, junctionMarks } from './junctionMarks';
import { autoSolids, centreLine, solidLength } from './solid';
import { walkGeo, walksOn } from './crosswalk';
import { junctionRuts } from './dirtRuts';

export { layerOf };
export const ROAD_ASPHALT = '#646b76';

const C = {
  road: ROAD_ASPHALT,
  roadEdge: '#4b525c',
  dash: 'rgba(245, 243, 230, 0.85)',
  divider: 'rgba(240, 205, 96, 0.9)',
  axis: 'rgba(47, 128, 237, 0.8)',
  /** Мосты и эстакады: тень на земле (одной плотности — на стыках полотен без ступенек), бетонное ограждение по краям. */
  shadow: 'rgba(20, 30, 20, 0.28)',
  rail: '#d6d1c4',
  /** Грунтовая дорога: пыльная охра без кромки, край размыт, по середине каждой полосы — мягкая колея. */
  dirt: '#c4b99c',
  rut: 'rgba(150, 135, 105, 0.2)',
};

/** Размытый край грунтовки: полупрозрачные линии цвета полотна по краю, широкая и уже — (цвет, ширина в м). */
const DIRT_SOFT: [string, number][] = [
  ['rgba(196, 185, 156, 0.28)', 7],
  ['rgba(196, 185, 156, 0.55)', 3.6],
];
/** Ширина колеи, м. */
const RUT_W = 1.6;

type LineStyle = 'dash' | 'solid' | 'yellow' | 'barrier' | 'rut';
interface Mark {
  pts: Vec[];
  style: LineStyle;
}

interface CorridorGeo {
  poly: Vec[];
  left: Vec[];
  right: Vec[];
  /**
   * У каждой точки left/right — куда от неё тень: мост поднят на экране (bridgeLook().lift) на свою высоту
   * над землёй (deckAlong), тень — на земле, сдвинута по той же высоте; на земле — ноль. Сдвиг вдоль полотна
   * меняется плавно, поэтому тень — та же кривая, что кромки.
   */
  shade: Vec[];
  /** Куски над водой на земле [i0, i1] (индексы точек left/right): рисуются мостом. */
  wet: [number, number][];
  /**
   * Где у моста ограждение — [i0, i1] (индексы точек) по левой и по правой кромке; i1 < i0 — нигде. Нет его там, где
   * кромка общая с соседним полотном стыка — до носа островка (bareEdges).
   */
  walls: [[number, number], [number, number]];
  marks: Mark[];
  /** Контуры стрелок «прямо» на односторонней дороге (в мире). */
  arrows: Vec[][];
  /** Грунтовая: земля вместо асфальта, колеи вместо разметки. */
  dirt: boolean;
}

/** Стрелка «прямо» — как перед перекрёстками. */
const STRAIGHT = arrowShape(['straight']);

/** Мост на земле над рекой — низкий (м над водой): тень на воде совсем рядом. */
const LOW_BRIDGE = 2.4;
/** Мост над рекой начинается и кончается на берегу — на столько от воды. */
const BRIDGE_LAND = 10;
/** «Крылья» у концов моста: ограждение расходится в стороны — вдоль дороги и вбок. */
const WING = { along: 6, out: 4 };

/** Островок между соседними полотнами одной стороны стыка. */
export interface GoreGeo {
  /** Асфальт от стыка до носа и сам нос (бордюр). */
  asphalt: Vec[];
  nose: Vec[];
  /** Контур краской — на кромках полос (по нему же клип «ёлочки»). */
  paint: Vec[];
  /**
   * Что из контура рисуется линией: нос и кромки, которые полотно не красит само (paintedEdges) — иначе по кромке
   * односторонней петли или магистрали шли бы две линии одна на другой, ярче и толще кромки другого полотна.
   */
  lines: Vec[][];
  /**
   * «Ёлочка»: штрихи (рисуются в клипе по контуру). Вершины — на средней линии островка между кромками, шаг —
   * вдоль неё, плечи — под 60° к её касательной в этой точке: на изогнутом стыке ёлочка идёт по дуге, а не по хорде.
   */
  hatch: Vec[][];
  start: Vec;
  axis: Vec;
  armLen: number;
  length: number;
  /** Расходятся от стыка (съезд) — «ёлочка» вершинами к стыку; сходятся (въезд) — наоборот. */
  diverge: boolean;
  /** Между грунтовками: земля без бордюра и без «ёлочки». */
  dirt?: boolean;
}

interface PlateGeo {
  poly: Vec[];
  curbs: Vec[][];
  /** Все подъезды — грунтовые: площадка тоже земляная. */
  dirt?: boolean;
}

/** Разворот тупика; dirt — на конце грунтовой дороги. */
interface CapGeo {
  poly: Vec[];
  arc: Vec[];
  dirt?: boolean;
}

// Перед развилкой полос в разные полотна, после вливания и на последних метрах перед перекрёстком пунктир между
// попутными полосами становится сплошным — где и какой длины, задаёт `autoSolids` (src/lanes/solid.ts): там же
// машинам и запрещено перестраиваться.
/** Нос островка — там, где нарисованные кромки разошлись на столько (или не дальше NOSE_MAX от стыка). */
const NOSE_GAP = 9;
const NOSE_MAX = 110;
/** Галочка «ёлочки» — вершиной не ближе стольких метров к контуру носа (линии разметки шириной около метра). */
const HATCH_NOSE_CLEAR = 2;
/** Галочки — только где островок между кромками шире стольких метров (линии контура сами около метра). */
const HATCH_MIN_W = 2.5;

/** Подъём на экране точки полотна c на расстоянии s по оси (мост, пандус); на земле — ноль. */
type Lift = (c: Corridor, s: number) => Vec;
const NO_LIFT: Lift = () => ({ x: 0, y: 0 });

/** Кусок цепочки кромки: полотно c от конца end, на расстояниях [d0, d0 + c.length] от стыка островка. */
interface EdgeRun {
  c: Corridor;
  end: End;
  d0: number;
}

/**
 * Кромка островка от стыка — по цепочке полотен: от конца e и дальше через простые стыки (одно полотно сзади, одно
 * спереди, кромка продолжается без ступеньки). Пологий съезд расходится с дорогой дольше, чем длится короткое
 * полотно у стыка (эстакада, разрезанная узлом уровня), — островок и нос ложатся на следующее.
 * side — кромка справа (1) или слева (−1) от направления «от стыка».
 */
class EdgeChain {
  readonly runs: EdgeRun[];
  readonly total: number;
  constructor(
    net: LaneNet,
    e: CorridorEnd,
    readonly side: number,
  ) {
    const runs: EdgeRun[] = [{ c: e.corridor, end: e.end, d0: 0 }];
    let total = e.corridor.length;
    while (total < NOSE_MAX / 0.9 && runs.length < 8) {
      const last = runs[runs.length - 1];
      const far = net.node(last.end === 'a' ? last.c.b : last.c.a);
      if (far.kind !== 'seam' || net.isDeadEnd(far)) break;
      const ends = net.ends(far);
      if (ends.length !== 2) break;
      const next = ends.find((x) => x.corridor !== last.c);
      if (!next || runs.some((r) => r.c === next.corridor)) break;
      // Кромка продолжается тем же краем, без ступеньки (иначе это уже другой стык — развилка, сужение).
      const run: EdgeRun = { c: next.corridor, end: next.end, d0: total };
      if (dist(this.edgeOn(last, last.c.length, 0), this.edgeOn(run, 0, 0)) > 0.3) break;
      runs.push(run);
      total += next.corridor.length;
    }
    this.runs = runs;
    this.total = total;
  }

  /** Кусок цепочки и s на нём в d м от стыка (за концом цепочки — последний кусок, s у его дальнего конца). */
  at(d: number): { run: EdgeRun; s: number } {
    let run = this.runs[0];
    for (const r of this.runs) if (d >= r.d0) run = r;
    return { run, s: sFrom(run.c, run.end, Math.max(0, Math.min(run.c.length, d - run.d0))) };
  }

  private edgeOn(run: EdgeRun, x: number, extra: number): Vec {
    const s = sFrom(run.c, run.end, x);
    const ed = edgesAt(run.c, s) ?? [0, 0];
    return pointOff(run.c, s, this.side * awaySign(run.end) > 0 ? ed[1] + extra : ed[0] - extra);
  }

  /** Точка кромки в d м от стыка (без подъёма); extra — наружу от полотна. */
  edge(d: number, extra = 0): Vec {
    const { run } = this.at(d);
    return this.edgeOn(run, Math.max(0, Math.min(run.c.length, d - run.d0)), extra);
  }

  /** Направление «от стыка» вдоль цепочки в d м от него. */
  tangent(d: number): Vec {
    const { run, s } = this.at(d);
    return scale(run.c.lut.tangentAt(s), awaySign(run.end));
  }
}

/** Соседние в стыке полотна с общей кромкой: X левее, Y правее (на стороне side), их обращённые кромки, нос. */
interface SharedEdge {
  X: CorridorEnd;
  Y: CorridorEnd;
  side: 1 | -1;
  cx: EdgeChain;
  cy: EdgeChain;
  d: number;
}

/**
 * Нос островка между цепочками кромок X и Y: в скольких метрах от стыка они разошлись на NOSE_GAP (или NOSE_MAX);
 * -1 — так и не разошлись.
 */
function noseAt(X: EdgeChain, Y: EdgeChain): number {
  const maxD = Math.min(X.total, Y.total) * 0.9;
  for (let d = 2; d <= maxD; d += 2) if (dist(X.edge(d), Y.edge(d)) >= NOSE_GAP || d >= NOSE_MAX) return d;
  return -1;
}

/** Ближе ли точка p к ломаной pts, чем r. */
function nearLine(p: Vec, pts: Vec[], r: number): boolean {
  for (let i = 0; i + 1 < pts.length; i++) if (closestOnSegment(p, pts[i], pts[i + 1]).d < r) return true;
  return false;
}
/** Полотна в стыке чуть заходят друг на друга — без светлого шва между заливками. */
const SEAM_OVERLAP = 0.8;

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Всё, что рисуется у узла: островки стыка, площадка перекрёстка, развороты тупика. */
/** Разметка площадки большого перекрёстка (настройка `junctionMarks`): островки со штриховкой и направляющий пунктир. */
interface JunctionMarkGeo {
  islands: Vec[][];
  /** Штрихи поперёк рамки островков (рисуются в клипе по ним). */
  hatch: Vec[][];
  /** Линии по площадке: пунктир 1.7 — уже нарезанный, сплошные между разведёнными потоками — целиком. */
  dashes: Vec[][];
}

interface NodeGeo {
  gores: GoreGeo[];
  plate: PlateGeo | null;
  marks?: JunctionMarkGeo | null;
  /** Колеи по земляной площадке перекрёстка — по траекториям поворотов (dirtRuts.ts). */
  ruts?: Vec[][];
  caps: CapGeo[];
  /** Узел моста: куда от поднятой площадки её тень (bridgeLook — как у концов его полотен). */
  shade: Vec;
  /** Пешеходные переходы на подъездах (src/lanes/crosswalk.ts): асфальт до стоп-линии и полосы зебры. */
  walks?: { cover: Vec[]; stripes: Vec[][] }[];
}

/**
 * Всё у узла моста — выше на экране на d. Кроме островков: их seamGores поднимает по точкам вместе с кромками
 * полотен — на пандусе от стыка до носа подъём заметно меняется.
 */
function liftNode(geo: NodeGeo, d: Vec): NodeGeo {
  const up = (pts: Vec[]) => pts.map((p) => add(p, d));
  return {
    ...geo,
    plate: geo.plate && { ...geo.plate, poly: up(geo.plate.poly), curbs: geo.plate.curbs.map(up) },
    caps: geo.caps.map((c) => ({ ...c, poly: up(c.poly), arc: up(c.arc) })),
    marks: geo.marks && { islands: geo.marks.islands.map(up), hatch: geo.marks.hatch.map(up), dashes: geo.marks.dashes.map(up) },
    ruts: geo.ruts?.map(up),
  };
}

/** Шаг штриховки островков на перекрёстке, м. */
const HATCH_STEP = 4;

/** Разметка перекрёстка для отрисовки: штрихи через рамку островков, пунктир нарезан (короткие штрихи 1.7). */
function markGeo(m: JunctionMarks): JunctionMarkGeo {
  const b = bboxOf(m.islands);
  const c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  const R = Math.hypot(b.x1 - b.x0, b.y1 - b.y0) / 2 + HATCH_STEP;
  const u = rightNormal(m.hatch);
  const hatch: Vec[][] = [];
  if (m.islands.length) {
    for (let t = -R; t <= R; t += HATCH_STEP) {
      const p = add(c, scale(u, t));
      hatch.push([add(p, scale(m.hatch, -R)), add(p, scale(m.hatch, R))]);
    }
  }
  // Пунктир 1.7 — короткими штрихами, сплошная (потоки разведены) — целиком.
  return { islands: m.islands, hatch, dashes: m.guides.flatMap((g) => (g.solid ? [g.pts] : cutDashes(g.pts, 1.6, 4))) };
}

interface Cached<T> {
  /** Номер полотна или узла. */
  id: number;
  key: string;
  geo: T;
  bbox: BBox;
  /** Слой по высоте (layerOf). */
  layer: number;
  /** Отпечаток нарисованного (shapeOf): та же картинка — тот же отпечаток, даже если ревизии новые (предпросмотр). */
  shape: string;
}

/** Отпечаток точек (с точностью 1/64 м) и прочего, от чего зависит картинка, — строкой. */
function shapeOf(lists: Vec[][], extra: string): string {
  let a = 0x811c9dc5 | 0;
  let b = 0x1b873593 | 0;
  for (const pts of lists) {
    a = Math.imul(a ^ pts.length, 16777619);
    for (const p of pts) {
      const x = Math.round(p.x * 64);
      const y = Math.round(p.y * 64);
      a = Math.imul(Math.imul(a ^ x, 16777619) ^ y, 16777619);
      b = Math.imul(b ^ (x * 31 + y), 0x5bd1e995);
    }
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}|${extra}`;
}

function bboxOf(lists: Vec[][]): BBox {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const pts of lists) {
    for (const p of pts) {
      b.x0 = Math.min(b.x0, p.x);
      b.y0 = Math.min(b.y0, p.y);
      b.x1 = Math.max(b.x1, p.x);
      b.y1 = Math.max(b.y1, p.y);
    }
  }
  return b;
}

/**
 * Что из сети рисует draw (по умолчанию — всё): только полотна и узлы с этими номерами; marks: false — без
 * разметки и стрелок (покрытие строящейся дороги до разметки); shadow: 'skip' — без тени мостов на земле, 'only' —
 * только она (у проекта стройки тень готового и неготового — разной плотности, src/render/constructionArt.ts).
 */
export interface DrawPick {
  corridor?: (id: number) => boolean;
  node?: (id: number) => boolean;
  marks?: boolean;
  shadow?: 'skip' | 'only';
}

/**
 * Отрисовка сети из полос: асфальт и бордюры, островки, перекрёстки, тупики, разметка, стрелки.
 * Геометрия кэшируется по каждому полотну и узлу отдельно (ключ — ревизии и соседи), поэтому
 * предпросмотр на копии большой сети пересчитывает только изменённое; рисуется только видимое.
 * scope — только часть сети (например, строящиеся полотна): геометрия и кэш — лишь у этих полотен и их узлов,
 * вышедшее из неё (достроили, отменили) из кэша уходит.
 */
export class LaneRenderer {
  constructor(private readonly scope?: (c: Corridor) => boolean) {}

  private net: LaneNet | null = null;
  private version = -1;
  private cuts = new Map<number, [number, number]>();
  /** Где у полотен нет ограждения моста — общая с соседом по стыку кромка до носа островка (bareEdges). */
  private bare = new Map<number, [[number, number], [number, number]]>();
  private corridorCache = new Map<number, Cached<CorridorGeo>>();
  private nodeCache = new Map<number, Cached<NodeGeo>>();
  private corridors: Cached<CorridorGeo>[] = [];
  private nodes: Cached<NodeGeo>[] = [];
  /** Вода на карте: дорога над ней на земле рисуется мостом. Нет — воды нет (лаборатория). */
  water: ((p: Vec) => boolean) | null = null;
  /** Точка внутри карты; тупик на краю (дорога уходит за край карты) — без разворота. Нет — всё внутри. */
  inMap: ((p: Vec) => boolean) | null = null;
  /** Настройку «Разметка перекрёстков» переключили — геометрию узлов заново, чтобы было видно сразу. Вызов — отписка. */
  readonly unprefs = onPrefs(() => {
    this.net = null;
    this.version = -1;
    this.nodeCache.clear();
  });

  /** Новая карта: кэш геометрии (в нём и куски над водой) — заново, и вода — уже другой карты. */
  reset(): void {
    this.water = null;
    this.inMap = null;
    this.net = null;
    this.version = -1;
    this.corridorCache.clear();
    this.nodeCache.clear();
  }

  /** Есть ли что рисовать в слое высоты layer. */
  hasLayer(net: LaneNet, layer: number): boolean {
    this.refresh(net);
    return this.corridors.some((x) => x.layer === layer) || this.nodes.some((x) => x.layer === layer);
  }

  /** Есть ли что рисовать в слое высоты layer в рамке view (по рамкам полотен и узлов; тень моста — в пределах 40 м). */
  layerIn(net: LaneNet, layer: number, view: BBox): boolean {
    this.refresh(net);
    const hit = (x: Cached<unknown>) => x.layer === layer && !(x.bbox.x1 < view.x0 || x.bbox.x0 > view.x1 || x.bbox.y1 < view.y0 || x.bbox.y0 > view.y1);
    return this.corridors.some(hit) || this.nodes.some(hit);
  }

  /**
   * Всё, что рисует сеть, — для кэша карты (src/render/tileCache.ts): полотна и узлы с отпечатком нарисованного
   * (shapeOf — не ревизии: предпросмотр стройки, пересобранный без изменений, не меняет его) и рамкой — по смене
   * отпечатка понятно, что и где перерисовать.
   */
  eachItem(net: LaneNet, fn: (kind: 'corridor' | 'node', id: number, sig: string, box: BBox) => void): void {
    this.refresh(net);
    for (const [id, x] of this.corridorCache) fn('corridor', id, x.shape, x.bbox);
    for (const [id, x] of this.nodeCache) fn('node', id, x.shape, x.bbox);
  }

  /** Рисует сеть; layer — только этот слой высоты (тоннели, земля, мосты, эстакады), без него — всё; pick — что из неё. */
  draw(ctx: CanvasRenderingContext2D, net: LaneNet, zoom: number, debug = false, view?: BBox, layer?: number, pick?: DrawPick): void {
    this.refresh(net);
    const seen = (b: BBox) => !view || !(b.x1 < view.x0 || b.x0 > view.x1 || b.y1 < view.y0 || b.y0 > view.y1);
    const mine = (x: Cached<unknown>) => layer === undefined || x.layer === layer;
    const corridors = this.corridors.filter((x) => mine(x) && seen(x.bbox) && (!pick?.corridor || pick.corridor(x.id))).map((x) => x.geo);
    const nodes = this.nodes.filter((x) => mine(x) && seen(x.bbox) && (!pick?.node || pick.node(x.id))).map((x) => x.geo);
    const plates = nodes.flatMap((n) => (n.plate ? [n.plate] : []));
    const caps = nodes.flatMap((n) => n.caps);
    const gores = nodes.flatMap((n) => n.gores);
    ctx.lineJoin = 'round';
    const elevated = layer !== undefined && layer > 0;
    // Низкие мосты над рекой — в слое земли (и всё сразу, если слой не задан).
    const ground = layer === undefined || layer === 0;
    const shadows = pick?.shadow !== 'skip';
    if (elevated && shadows) {
      // Мост или эстакада: тень со сдвигом по высоте над землёй в каждой точке — у конца пандуса на земле она под
      // самой дорогой; выше мост — дальше тень.
      ctx.fillStyle = C.shadow;
      for (const g of corridors) this.fill(ctx, this.shadowPoly(g, 0, g.left.length - 1));
      for (const n of nodes) {
        if (n.plate) this.fill(ctx, n.plate.poly.map((q) => add(q, n.shade)));
        for (const cap of n.caps) this.fill(ctx, cap.poly.map((q) => add(q, n.shade)));
      }
    }
    if (ground && shadows) {
      const low = bridgeLook(LOW_BRIDGE).shadow;
      ctx.fillStyle = C.shadow;
      for (const g of corridors) for (const [i0, i1] of g.wet) this.fill(ctx, this.shadowPoly(g, i0, i1, low));
    }
    if (pick?.shadow === 'only') return;
    // Бордюры под асфальтом: заливка соседнего полотна закрывает их там, где полотна сходятся.
    // Грунтовые — землёй без кромки: край размыт полупрозрачными линиями цвета полотна (их тоже закрывает асфальт).
    const surface = (dirt?: boolean) => (dirt ? C.dirt : C.road);
    ctx.lineCap = 'round';
    for (const [color, width] of DIRT_SOFT) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const g of corridors) if (g.dirt) (this.path(ctx, g.left), this.path(ctx, g.right));
      for (const p of plates) if (p.dirt) for (const c of p.curbs) this.path(ctx, c);
      for (const cap of caps) if (cap.dirt) this.path(ctx, cap.arc);
      for (const g of gores) if (g.dirt) this.path(ctx, g.nose);
      ctx.stroke();
    }
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = C.roadEdge;
    for (const g of corridors) {
      if (g.dirt) continue;
      this.stroke(ctx, g.left);
      this.stroke(ctx, g.right);
    }
    for (const p of plates) if (!p.dirt) for (const c of p.curbs) this.stroke(ctx, c);
    for (const cap of caps) if (!cap.dirt) this.stroke(ctx, cap.arc);
    for (const g of corridors) {
      ctx.fillStyle = surface(g.dirt);
      this.fill(ctx, g.poly);
    }
    for (const p of plates) {
      ctx.fillStyle = surface(p.dirt);
      this.fill(ctx, p.poly);
    }
    for (const cap of caps) {
      ctx.fillStyle = surface(cap.dirt);
      this.fill(ctx, cap.poly);
    }
    // Шов между земляной площадкой (разворотом) и полотном: без бордюра под ним просвечивал бы светлой чертой.
    ctx.strokeStyle = C.dirt;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const p of plates) if (p.dirt) (this.path(ctx, p.poly), ctx.closePath());
    for (const cap of caps) if (cap.dirt) (this.path(ctx, cap.poly), ctx.closePath());
    ctx.stroke();
    // Островки: асфальт до носа, нос — тонким бордюром; между грунтовками — земля без бордюра; на мосту нос
    // обводит стенка ограждения — бордюр под ней лёг бы тёмной каймой по асфальту.
    for (const g of gores) {
      ctx.fillStyle = surface(g.dirt);
      this.fill(ctx, g.asphalt);
      if (g.dirt || elevated) continue;
      ctx.strokeStyle = C.roadEdge;
      ctx.lineWidth = 1.6;
      this.stroke(ctx, g.nose);
    }
    // Бетонный парапет по краям моста — снаружи асфальта, вплотную к кромке (полосы не сужает); на земле — только над водой.
    const wall = parapetWidth(zoom);
    const parapets: Vec[][] = [];
    for (const g of corridors) {
      if (elevated) {
        // Кромка, общая с соседом по стыку, — без стенки до носа островка (CorridorGeo.walls).
        const [[l0, l1], [r0, r1]] = g.walls;
        if (l1 > l0) parapets.push(parapetLine(g.left.slice(l0, l1 + 1), g.right.slice(l0, l1 + 1), wall / 2));
        if (r1 > r0) parapets.push(parapetLine(g.right.slice(r0, r1 + 1), g.left.slice(r0, r1 + 1), wall / 2));
      } else if (ground) for (const [i0, i1] of g.wet) parapets.push(...this.wings(g, i0, i1, wall / 2));
    }
    // Нос островка на мосту — стенкой: она соединяет стенки двух полотен там, где их кромки разошлись. Концы —
    // круглые: стык со стенкой полотна под углом без щели (тёмная кромка и светлый верх — каждый своим проходом).
    const noses = elevated ? gores.filter((g) => !g.dirt).map((g) => noseParapet(g.nose, wall / 2)) : [];
    if (parapets.length || noses.length) {
      for (const [color, width] of [
        ['#8c877c', wall],
        [C.rail, wall * PARAPET.top],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'butt';
        for (const pts of parapets) this.stroke(ctx, pts);
        ctx.lineCap = 'round';
        for (const pts of noses) this.stroke(ctx, pts);
      }
      ctx.lineCap = 'butt';
    }
    if (zoom >= 0.35 && pick?.marks !== false) {
      this.drawMarks(ctx, corridors, nodes);
      for (const g of gores) if (!g.dirt) this.drawGorePaint(ctx, g);
      for (const n of nodes) if (n.marks) this.drawJunctionMarks(ctx, n.marks);
      this.drawArrows(ctx, corridors);
      this.drawWalks(ctx, nodes, zoom);
    }
    if (debug) this.drawDebug(ctx, net, zoom);
  }

  /**
   * Пешеходные переходы: разметка полос от обреза до стоп-линии стёрта (асфальт поверх), полосы зебры — белым с зума
   * 0,5 (издали — только сдвинутая стоп-линия); вблизи (с 2) — тонкая кромка полос.
   */
  private drawWalks(ctx: CanvasRenderingContext2D, nodes: NodeGeo[], zoom: number): void {
    const walks = nodes.flatMap((n) => n.walks ?? []);
    if (!walks.length) return;
    ctx.fillStyle = C.road;
    for (const w of walks) this.fill(ctx, w.cover);
    if (zoom < 0.5) return;
    ctx.fillStyle = 'rgba(244, 243, 236, 0.92)';
    ctx.beginPath();
    for (const w of walks) {
      for (const q of w.stripes) {
        ctx.moveTo(q[0].x, q[0].y);
        for (let i = 1; i < q.length; i++) ctx.lineTo(q[i].x, q[i].y);
        ctx.closePath();
      }
    }
    ctx.fill();
    if (zoom < 2) return;
    ctx.strokeStyle = 'rgba(200, 198, 188, 0.7)';
    ctx.lineWidth = 0.25;
    ctx.stroke();
  }

  /**
   * Ограждение моста над рекой [i0, i1] по обоим краям — оси стенок, сдвинутые от кромок асфальта наружу на d;
   * на концах — «крылья», расходящиеся в стороны от дороги.
   */
  private wings(g: CorridorGeo, i0: number, i1: number, d: number): Vec[][] {
    if (i1 <= i0) return [];
    return [g.left, g.right].map((side, k) => {
      const other = (k === 0 ? g.right : g.left).slice(i0, i1 + 1);
      const edge = parapetLine(side.slice(i0, i1 + 1), other, d);
      const n = edge.length - 1;
      const out = (i: number) => norm(sub(edge[i], other[i]));
      const back = norm(sub(edge[0], edge[1]));
      const fwd = norm(sub(edge[n], edge[n - 1]));
      const wing = (i: number, dir: Vec) => add(edge[i], add(scale(dir, WING.along), scale(out(i), WING.out)));
      return [wing(0, back), ...edge, wing(n, fwd)];
    });
  }

  /** Тень куска полотна [i0, i1]: каждая точка сдвинута по своей высоте (or — один сдвиг на всё). */
  private shadowPoly(g: CorridorGeo, i0: number, i1: number, or?: Vec): Vec[] {
    const at = (p: Vec, i: number) => add(p, or ?? g.shade[i]);
    const l = g.left.slice(i0, i1 + 1).map((p, k) => at(p, i0 + k));
    const r = g.right.slice(i0, i1 + 1).map((p, k) => at(p, i0 + k));
    return [...l, ...r.reverse()];
  }

  /** Обрыв полотен у перекрёстков — для движения и подсказок. */
  cutsOf(net: LaneNet): Map<number, [number, number]> {
    this.refresh(net);
    return this.cuts;
  }

  /** Контур асфальта площадки перекрёстка id (как рисуется, без подъёма моста); не перекрёсток — null. */
  plateOf(net: LaneNet, id: number): Vec[] | null {
    this.refresh(net);
    const n = net.nodes.get(id);
    return n && n.kind === 'junction' ? (this.plateGeo(net, n)?.poly ?? null) : null;
  }

  // ---------- Кэш геометрии ----------

  private refresh(net: LaneNet): void {
    if (this.net === net && this.version === net.version) return;
    this.net = net;
    this.version = net.version;
    // Часть сети (scope): её полотна и их узлы; обрезы — только у этих узлов.
    const scope = this.scope;
    const inScope = scope ? [...net.corridors.values()].filter(scope) : null;
    const nodeList = inScope ? [...new Set(inScope.flatMap((c) => [c.a, c.b]))].map((id) => net.node(id)) : [...net.nodes.values()];
    this.cuts = inScope ? junctionCuts(net, inScope, nodeList) : junctionCuts(net);
    // Подпись узла: всё, от чего зависит геометрия вокруг него.
    const sigs = new Map<number, string>();
    for (const n of nodeList) {
      // Обрез подъезда — только у этого узла: обрез на другом конце полотна геометрию узла не меняет (иначе правка у
      // перекрёстка пересчитывала бы и соседние перекрёстки с их разметкой, и их полотна).
      const arms = n.corridors
        .map((id) => {
          const c = net.corridor(id);
          const cut = this.cuts.get(id);
          return `${id}.${c.rev}.${c.a === n.id ? cut?.[0] : ''}/${c.b === n.id ? cut?.[1] : ''}`;
        })
        .join(',');
      const corners = n.corners ? Object.entries(n.corners).join(';') : '';
      // Запреты и связи полос меняют траектории — а по ним разметка площадки.
      const turns = `${n.bans?.join(';') ?? ''}|${n.lanes?.join(';') ?? ''}`;
      // Пешеходные переходы — зебры на подъездах.
      const walks = n.walks ? Object.entries(n.walks).map(([k, w]) => `${k}${w.on ? '+' : '-'}`).join() : '';
      // Открытый конец (ворота большой площадки) — тупик без разворота: сменился — геометрия только этого узла.
      const open = n.open ? 'o' : '';
      sigs.set(n.id, `${n.kind}:${n.level}:${n.deck ?? ''}:${n.pos.x},${n.pos.y}:${n.dir.x},${n.dir.y}:${arms}:${corners}:${turns}:${walks}:${open}`);
    }
    // Островки стыков: где у полотен нет ограждения (и через простые стыки дальше — EdgeChain), из каких полотен
    // островок у каждого стыка — по ним и пересчёт геометрии, даже если полотно не у самого узла.
    const { bare, chains } = this.bareEdges(net, nodeList);
    this.bare = bare;
    const corridors: Cached<CorridorGeo>[] = [];
    for (const c of inScope ?? net.corridors.values()) {
      const key = `${c.rev}|${this.cuts.get(c.id)?.join('/')}|${sigs.get(c.a)}|${sigs.get(c.b)}|${bare.get(c.id)?.join(';') ?? ''}`;
      let item = this.corridorCache.get(c.id);
      if (!item || item.key !== key) {
        const geo = this.corridorGeo(net, c);
        const la = net.node(c.a).level;
        const lb = net.node(c.b).level;
        const layer = layerOf(Math.min(la, lb), Math.max(la, lb));
        // Отпечаток: всё, что рисуется, и то, от чего зависят знаки и скорости (класс, полосы, ограничение).
        const shape = shapeOf(
          [geo.poly, geo.left, geo.right, geo.shade, ...geo.marks.map((m) => m.pts), ...geo.arrows],
          `${layer}|${la}|${lb}|${geo.marks.map((m) => m.style).join(',')}|${geo.wet.join(';')}|${geo.walls.join(';')}|${c.cls}|${c.limit ?? ''}|${c.ring ?? ''}|${JSON.stringify(c.lanes)}`,
        );
        item = { id: c.id, key, geo, bbox: bboxOf([geo.poly]), layer, shape };
        this.corridorCache.set(c.id, item);
      }
      corridors.push(item);
    }
    // Ушедшее из сети (или из её части scope) — из кэша.
    const has = (ids: Cached<unknown>[]) => new Set(ids.map((x) => x.id));
    const liveC = has(corridors);
    for (const id of this.corridorCache.keys()) if (!liveC.has(id)) this.corridorCache.delete(id);
    const nodes: Cached<NodeGeo>[] = [];
    for (const n of nodeList) {
      const key = `${sigs.get(n.id)!}|${chains.get(n.id) ?? ''}`;
      let item = this.nodeCache.get(n.id);
      if (!item || item.key !== key) {
        let geo: NodeGeo = { gores: [], plate: null, caps: [], shade: { x: 0, y: 0 } };
        if (n.kind === 'junction') {
          geo.plate = this.plateGeo(net, n);
          // Земляная площадка: колеи по всем поворотам, белой разметки нет.
          if (geo.plate?.dirt) geo.ruts = junctionRuts(net, n, this.cuts);
          // Разметка площадки большого перекрёстка — если включена в настройках.
          else if (geo.plate && prefOn('junctionMarks')) {
            const m = junctionMarks(net, n, geo.plate.poly, this.cuts);
            geo.marks = m && markGeo(m);
          }
          // Зебры — только на асфальте (на грунтовке перехода не бывает: walkArms).
          const walks = geo.plate ? walksOn(net, n, this.cuts).map((arm) => walkGeo(arm)) : [];
          if (walks.length) geo.walks = walks.map((w) => ({ cover: w.cover, stripes: w.stripes }));
        } else if (net.isDeadEnd(n)) geo.caps = (this.inMap && !this.inMap(n.pos)) || n.open ? [] : net.ends(n).map((e) => this.capGeo(e));
        // Островок на мосту или пандусе — поднят по точкам, как кромки полотен, у которых лежит (liftNode его не трогает).
        else geo.gores = this.seamGores(net, n, (c, s) => (Math.max(net.node(c.a).level, net.node(c.b).level) > 0 ? bridgeLook(deckAlong(net, c, s)).lift : { x: 0, y: 0 }));
        // Узел моста — поднят на свою высоту, как концы его полотен; тень — на земле под ним.
        const look = bridgeLook(n.level > 0 ? nodeDeck(n) : 0);
        if (look.lift.y !== 0) geo = liftNode(geo, look.lift);
        geo.shade = sub(look.shadow, look.lift);
        const bbox = bboxOf([geo.plate?.poly ?? [], ...geo.caps.map((c) => c.poly), ...geo.gores.map((g) => g.asphalt), ...(geo.walks ?? []).map((w) => w.cover), [n.pos]]);
        const layer = layerOf(n.level, n.level);
        const shape = shapeOf(
          [
            geo.plate?.poly ?? [],
            ...(geo.plate?.curbs ?? []),
            ...geo.caps.flatMap((c) => [c.poly, c.arc]),
            ...geo.gores.flatMap((g) => [g.asphalt, g.nose, g.paint, ...g.lines, ...g.hatch, [g.start, g.axis]]),
            ...(geo.marks ? [...geo.marks.islands, ...geo.marks.hatch, ...geo.marks.dashes] : []),
            ...(geo.ruts ?? []),
            ...(geo.walks ?? []).flatMap((w) => [w.cover, ...w.stripes]),
            [geo.shade, n.pos],
          ],
          // Запреты и связи полос — стрелки и стоп-линии перекрёстка.
          // Грунт или асфальт площадки и разворотов — перестроенный просёлок той же ширины перерисуется.
          `${layer}|${n.kind}|${n.roundabout ?? ''}|${geo.gores.map((g) => `${g.diverge}${g.dirt ? 'd' : ''}`).join()}|${n.bans?.join(';') ?? ''}|${n.lanes?.join(';') ?? ''}|${geo.plate?.dirt ? 'd' : ''}${geo.caps.map((c) => (c.dirt ? 'd' : 'a')).join('')}`,
        );
        item = { id: n.id, key, geo, bbox, layer, shape };
        this.nodeCache.set(n.id, item);
      }
      nodes.push(item);
    }
    const liveN = has(nodes);
    for (const id of this.nodeCache.keys()) if (!liveN.has(id)) this.nodeCache.delete(id);
    this.corridors = corridors;
    this.nodes = nodes;
  }

  private corridorGeo(net: LaneNet, c: Corridor): CorridorGeo {
    const [ca, cb] = this.cuts.get(c.id)!;
    const s0 = ca;
    const s1 = c.length - cb;
    const ss = stations(c, s0, s1, 3);
    const L = solidLength(c);
    for (const x of [L, c.length - L, s0 + L, s1 - L]) if (x > s0 && x < s1) ss.push(x);
    // Мост и пандус к нему: сколько под полотном высоты в каждой точке — на столько оно поднято на экране.
    const raised = Math.max(net.node(c.a).level, net.node(c.b).level) > 0;
    // Ограждение моста — не по кромке, общей с соседом по стыку: начинается у носа островка, там и точка.
    const bare = raised ? this.bare.get(c.id) : undefined;
    if (bare) for (const [fromA, fromB] of bare) for (const x of [fromA, c.length - fromB]) if (x > s0 && x < s1) ss.push(x);
    ss.sort((x, y) => x - y);
    const memo = new Map<number, ReturnType<typeof bridgeLook>>();
    const look = (s: number) => {
      let v = memo.get(s);
      if (!v) memo.set(s, (v = bridgeLook(raised ? deckAlong(net, c, s) : 0)));
      return v;
    };
    const up = (s: number, off: number): Vec => (raised ? add(pointOff(c, s, off), look(s).lift) : pointOff(c, s, off));
    const left: Vec[] = [];
    const right: Vec[] = [];
    const shade: Vec[] = [];
    const at: number[] = [];
    const over: boolean[] = [];
    for (const s of ss) {
      const e = edgesAt(c, s);
      if (!e) continue;
      left.push(up(s, e[0] - ROAD_MARGIN));
      right.push(up(s, e[1] + ROAD_MARGIN));
      const v = look(s);
      shade.push(sub(v.shadow, v.lift));
      const h = net.heightAt(c, s);
      at.push(s);
      over.push(Math.abs(h) < 0.25 && !!this.water?.(pointOff(c, s, (e[0] + e[1]) / 2)));
    }
    // Над водой на земле — мост: куски подряд, начинается и кончается на берегу, на BRIDGE_LAND от воды.
    const wet: [number, number][] = [];
    for (let i = 0; i < over.length; i++) {
      if (!over[i]) continue;
      let j = i;
      while (j + 1 < over.length && over[j + 1]) j++;
      let i0 = i;
      while (i0 > 0 && at[i] - at[i0 - 1] <= BRIDGE_LAND) i0--;
      let i1 = j;
      while (i1 < over.length - 1 && at[i1 + 1] - at[j] <= BRIDGE_LAND) i1++;
      const last = wet[wet.length - 1];
      if (last && i0 <= last[1]) last[1] = i1;
      else wet.push([i0, i1]);
      i = j;
    }
    // В стыке заливка чуть заходит за край — к соседнему полотну без шва.
    const l = [...left];
    const r = [...right];
    if (net.node(c.a).kind === 'seam' && l.length) {
      const t = scale(c.lut.tangentAt(0), -SEAM_OVERLAP);
      l.unshift(add(l[0], t));
      r.unshift(add(r[0], t));
    }
    if (net.node(c.b).kind === 'seam' && l.length) {
      const t = scale(c.lut.tangentAt(c.length), SEAM_OVERLAP);
      l.push(add(l[l.length - 1], t));
      r.push(add(r[r.length - 1], t));
    }
    const wallOf = ([fromA, fromB]: [number, number]): [number, number] => {
      const i0 = at.findIndex((s) => s >= fromA - 1e-6);
      let i1 = at.length - 1;
      while (i1 >= 0 && at[i1] > c.length - fromB + 1e-6) i1--;
      return i0 < 0 ? [0, -1] : [i0, i1];
    };
    return {
      poly: [...l, ...r.reverse()],
      left,
      right,
      shade,
      wet,
      walls: bare ? [wallOf(bare[0]), wallOf(bare[1])] : [
        [0, left.length - 1],
        [0, left.length - 1],
      ],
      marks: isDirt(c.cls) ? this.ruts(c, ss, up) : this.corridorMarks(net, c, ss, s0, s1, up),
      // Односторонняя — со стрелками и на грунтовке: иначе не понять, куда по ней ехать.
      arrows: this.corridorArrows(c, s0, s1, up),
      dirt: isDirt(c.cls),
    };
  }

  /** Колеи грунтовой дороги вместо разметки: по одной посередине каждой полосы — где ездят машины. */
  private ruts(c: Corridor, ss: number[], at: (s: number, off: number) => Vec): Mark[] {
    const marks: Mark[] = [];
    for (const l of c.lanes) {
      const pts = ss.filter((s) => s >= l.from && s <= l.to).map((s) => at(s, l.offset));
      if (pts.length > 1) marks.push({ pts, style: 'rut' });
    }
    return marks;
  }

  /**
   * Разметка полотна: границы соседних полос, барьер на разделительной, кромки. [s0, s1] — асфальт между обрезами у перекрёстков.
   * at — точка на оси s со смещением off (у моста — поднятая вместе с полотном).
   */
  private corridorMarks(net: LaneNet, c: Corridor, ss: number[], s0: number, s1: number, at: (s: number, off: number) => Vec): Mark[] {
    const marks: Mark[] = [];
    /** Куски линии со смещением off там, где style(s) не null; стиль внутри куска один. */
    const runs = (off: number, style: (s: number) => LineStyle | null) => {
      let cur: Mark | null = null;
      for (const s of ss) {
        const st = style(s);
        const p = at(s, off);
        if (cur && st === cur.style) {
          cur.pts.push(p);
          continue;
        }
        if (cur && cur.pts.length > 1) marks.push(cur);
        // Сплошная сменила пунктир: новый кусок начинается там же, где кончился прежний.
        const joined: Vec[] = cur ? [cur.pts[cur.pts.length - 1], p] : [p];
        cur = st ? { style: st, pts: joined } : null;
      }
      if (cur && cur.pts.length > 1) marks.push(cur);
    };
    // Полосы стоянки — без линий: между ней и полосой движения линии нет, места размечены буквой «Т» от края движения до
    // бордюра (их рисует игра: места знают заезды и остановки, game/curbParking.ts). Полоса движения на участке стоянки
    // (полоса поворота — retypeLaneSpan) — соседка полосы изнутри, через стоянку на том же месте.
    const order = c.lanes
      .map((_, i) => i)
      .filter((i) => !c.lanes[i].park)
      .sort((x, y) => c.lanes[x].offset - c.lanes[y].offset);
    for (let k = 0; k + 1 < order.length; k++) {
      const i = order[k];
      const j = order[k + 1];
      const A = c.lanes[i];
      const B = c.lanes[j];
      const both = (s: number) => laneShare(c, A, s) > 0.02 && laneShare(c, B, s) > 0.02;
      const gap = B.offset - A.offset;
      const mid = (A.offset + B.offset) / 2;
      if (Math.abs(gap - LANE_W) < 0.3) {
        const same = A.flow === B.flow;
        // Сплошная сама — у развилки полос в разные полотна, после вливания и у самого перекрёстка (autoSolids).
        const auto = same ? autoSolids(net, c, i, j, s0, s1) : [];
        // Осевая между встречными (centreLine): у проспекта — жёлтая сплошная; у улицы 1+1 — пунктир, но у перекрёстка —
        // сплошная. По ней же решается, можно ли повернуть налево через встречку (game/garages.ts).
        runs(mid, (s) => {
          if (!both(s)) return null;
          if (!same) return centreLine(net, c, s, s0, s1);
          return A.solid || auto.some(([u, v]) => s >= u - 1e-6 && s <= v + 1e-6) ? 'solid' : 'dash';
        });
      } else if (gap > LANE_W + 0.3) {
        // Разделительная полоса: барьер посередине, сплошные у полос.
        runs(mid, (s) => (both(s) ? 'barrier' : null));
        runs(A.offset + LANE_W / 2, (s) => (laneShare(c, A, s) > 0.02 ? 'solid' : null));
        runs(B.offset - LANE_W / 2, (s) => (laneShare(c, B, s) > 0.02 ? 'solid' : null));
      }
    }
    if (paintedEdges(c)) {
      // Кромки — по краю крайних полос, на отгоне идут по скосу. Вдоль полосы стоянки кромки нет: там машины у бордюра.
      for (const side of [0, 1] as const) {
        let pts: Vec[] = [];
        const flush = () => {
          if (pts.length > 1) marks.push({ pts, style: 'solid' });
          pts = [];
        };
        for (const s of ss) {
          const e = edgesAt(c, s);
          if (c.lanes.some((l) => l.park && (side ? l.offset > 0 : l.offset < 0) && laneShare(c, l, s) > 0.02)) flush();
          else if (e) pts.push(at(s, e[side]));
        }
        flush();
      }
    }
    return marks.flatMap((m) => (m.style === 'dash' ? cutDashes(m.pts).map((pts) => ({ pts, style: m.style })) : [m]));
  }

  /** Стрелки направления — только на односторонней дороге: посередине полосы, на длинной — две. */
  private corridorArrows(c: Corridor, s0: number, s1: number, at: (s: number, off: number) => Vec): Vec[][] {
    if (!c.lanes.length || !c.lanes.every((l) => l.flow === c.lanes[0].flow)) return [];
    const res: Vec[][] = [];
    for (const l of c.lanes) {
      if (l.park) continue;
      const a = Math.max(l.from, s0 + 8);
      const b = Math.min(l.to, s1 - 8);
      if (b - a < 40) continue;
      for (const f of b - a > 260 ? [0.25, 0.75] : [0.5]) {
        const s = a + (b - a) * f;
        res.push(...arrowAt(STRAIGHT, at(s, l.offset), scale(c.lut.tangentAt(s), l.flow)));
      }
    }
    return res;
  }

  /**
   * Соседние полотна стыка с общей кромкой (между ними островок): с каждой стороны — те, чьи кромки в стыке
   * совпадают; X левее в стыке, Y правее, d — где их кромки разошлись на NOSE_GAP (нос островка, -1 — не разошлись).
   */
  private sharedEdges(net: LaneNet, n: LaneNode): SharedEdge[] {
    const res: SharedEdge[] = [];
    for (const side of [1, -1] as const) {
      const list = net
        .ends(n)
        .filter((e) => e.side === side)
        .map((e) => {
          const reach = e.corridor.lanes.filter((l) => net.reaches(e.corridor, l, e.end));
          const lats = reach.map((l) => net.laneAtSeam(e, l).lat);
          return { e, lo: Math.min(...lats.map((x, i) => x - laneWidth(reach[i]) / 2)), hi: Math.max(...lats.map((x, i) => x + laneWidth(reach[i]) / 2)) };
        })
        .filter((x) => Number.isFinite(x.lo))
        .sort((x, y) => x.lo - y.lo);
      for (let k = 0; k + 1 < list.length; k++) {
        if (Math.abs(list[k].hi - list[k + 1].lo) > LAT_EPS) continue;
        const X = list[k].e;
        const Y = list[k + 1].e;
        // Обращённые друг к другу кромки: у X — правая по `dir` стыка, у Y — левая; от стыка — side и −side.
        const cx = new EdgeChain(net, X, side);
        const cy = new EdgeChain(net, Y, -side);
        res.push({ X, Y, side, cx, cy, d: noseAt(cx, cy) });
      }
    }
    return res;
  }

  /**
   * Островки между соседними полотнами стыка: с каждой стороны — между теми, чьи кромки в стыке совпадают.
   * lift — подъём на экране точки полотна (мост, пандус): островок поднят вместе с кромками, у которых лежит.
   */
  seamGores(net: LaneNet, n: LaneNode, lift: Lift = NO_LIFT): GoreGeo[] {
    const res: GoreGeo[] = [];
    for (const pair of this.sharedEdges(net, n)) {
      const g = this.goreGeo(net, pair, lift);
      if (g) res.push(isDirt(pair.X.corridor.cls) && isDirt(pair.Y.corridor.cls) ? { ...g, dirt: true } : g);
    }
    return res;
  }

  /**
   * Где по кромкам полотен нет ограждения моста: id полотна → [левая, правая] × [от конца a, от конца b], м. Кромка,
   * общая с соседним полотном той же стороны стыка, — внутри асфальта: от стыка до носа островка между ними
   * сплошное полотно, и стенки обоих легли бы на него крест-накрест. Ограждение начинается у носа (его обводит
   * стенка островка — GoreGeo.nose); короткое полотно у стыка — по цепочке кромки и на следующих (EdgeChain).
   * chains — какие полотна (с ревизиями) у каждого стыка ушли в его островки: от них зависит его геометрия.
   */
  private bareEdges(net: LaneNet, nodes: LaneNode[]): { bare: Map<number, [[number, number], [number, number]]>; chains: Map<number, string> } {
    const bare = new Map<number, [[number, number], [number, number]]>();
    const chains = new Map<number, string>();
    for (const n of nodes) {
      if (n.kind !== 'seam' || net.isDeadEnd(n) || n.corridors.length < 3) continue;
      const pairs = this.sharedEdges(net, n);
      if (!pairs.length) continue;
      const used: string[] = [];
      for (const { cx, cy, d } of pairs) {
        const len = d > 0 ? d : Math.min(cx.total, cy.total) * 0.9;
        for (const [chain, away] of [
          [cx, cx.side],
          [cy, cy.side],
        ] as const) {
          for (const r of chain.runs) {
            used.push(`${r.c.id}.${r.c.rev}`);
            if (r.d0 >= len) continue;
            const k = away * awaySign(r.end) > 0 ? 1 : 0;
            const at = r.end === 'a' ? 0 : 1;
            const res = bare.get(r.c.id) ?? [
              [0, 0],
              [0, 0],
            ];
            res[k][at] = Math.max(res[k][at], Math.min(r.c.length, len - r.d0));
            bare.set(r.c.id, res);
          }
        }
      }
      chains.set(n.id, used.join(','));
    }
    return { bare, chains };
  }

  /**
   * Островок между X (левее в стыке) и Y (правее) на стороне side: их кромки (по цепочкам cx, cy) в стыке совпадают,
   * дальше расходятся; нос — где разошлись на NOSE_GAP (d, noseAt).
   */
  private goreGeo(net: LaneNet, { X, side, cx, cy, d: d1 }: SharedEdge, lift: Lift): GoreGeo | null {
    // Точка кромки — поднята, как полотно в этом месте (на пандусе подъём меняется вдоль островка).
    const edge = (chain: EdgeChain, d: number, extra: number): Vec => {
      const { run, s } = chain.at(d);
      return add(chain.edge(d, extra), lift(run.c, s));
    };
    if (d1 < 12) return null;
    const axisAt = (d: number) => norm(add(cx.tangent(d), cy.tangent(d)));
    /** Контур: вдоль кромки X от стыка, «U» носом к стыку, обратно вдоль кромки Y. */
    const outline = (extra: number, end: number) => {
      const steps = Math.max(4, Math.ceil(end / 3));
      const ds = Array.from({ length: steps + 1 }, (_, i) => (end * i) / steps);
      const px = ds.map((d) => edge(cx, d, extra));
      const py = ds.map((d) => edge(cy, d, extra));
      const e1 = px[px.length - 1];
      const e2 = py[py.length - 1];
      const w = dist(e1, e2);
      // От каждой кромки нос уходит назад вдоль неё самой: по общей оси островка у носа на крутом съезде (кромки
      // там уже под углом) дуга от кромки X загибалась крючком за неё и перечёркивала её.
      const c1 = sub(e1, scale(cx.tangent(end), w * 0.6));
      const c2 = sub(e2, scale(cy.tangent(end), w * 0.6));
      const nose: Vec[] = [];
      for (let i = 0; i <= 12; i++) nose.push(cubicBezier(e1, c1, c2, e2, i / 12));
      const back = [...py].reverse();
      // Линией — нос и кромки, которые полотно не красит само (по цепочке — у каждого куска своё).
      const own = (chain: EdgeChain, d: number) => paintedEdges(chain.at(d).run.c);
      const open: { p: Vec; keep: boolean }[] = [
        ...px.slice(0, -1).map((p, i) => ({ p, keep: !own(cx, ds[i]) })),
        ...nose.map((p) => ({ p, keep: true })),
        ...back.slice(1).map((p, i) => ({ p, keep: !own(cy, ds[steps - 1 - i]) })),
      ];
      const lines: Vec[][] = [];
      let cur: Vec[] = [];
      for (let i = 0; i < open.length; i++) {
        // Отрезок рисуется, если оба его конца — не на кромке, которую красит само полотно.
        const seg = i + 1 < open.length && open[i].keep && open[i + 1].keep;
        if (seg) {
          if (!cur.length) cur.push(open[i].p);
          cur.push(open[i + 1].p);
        } else if (cur.length) {
          lines.push(cur);
          cur = [];
        }
      }
      if (cur.length > 1) lines.push(cur);
      return { pts: [...px, ...nose.slice(1, -1), ...back], nose, lines };
    };
    const asphalt = outline(ROAD_MARGIN, d1);
    const paint = outline(0, d1 - 5);
    // Едут ли по крайней к островку полосе X от стыка.
    const facing = X.corridor.lanes
      .filter((l) => net.reaches(X.corridor, l, X.end))
      .reduce((a, b) => (net.laneAtSeam(X, b).lat > net.laneAtSeam(X, a).lat ? b : a));
    const forward = net.laneAtSeam(X, facing).forward;
    const diverge = (forward ? 1 : -1) * side > 0;
    const armLen = dist(edge(cx, d1, 0), edge(cy, d1, 0)) + 4;
    // «Ёлочка» по средней линии островка (посередине между кромками): вершины — с шагом вдоль неё, плечи — под 60° к
    // её касательной в этой точке; за стыком и за носом линия продолжается по касательной (там штрихи срежет контур).
    const mid = (d: number) => scale(add(edge(cx, d, 0), edge(cy, d, 0)), 0.5);
    const back = diverge ? 1 : -1;
    const hatch: Vec[][] = [];
    for (let t = -4; t <= d1 + 8; t += 5) {
      const d = Math.max(0, Math.min(d1, t));
      const tan = norm(sub(mid(Math.min(d1, d + 1.5)), mid(Math.max(0, d - 1.5))));
      const apex = add(mid(d), scale(tan, t - d));
      // Вершина у самого носа или за ним: плечи легли бы на контур носа или пересекли соседние галочки — «крест»;
      // там, где островок уже HATCH_MIN_W, от галочки остаётся излом поперёк линий контура.
      if (t > 0 && (!insidePoly(apex, paint.pts) || nearLine(apex, paint.nose, HATCH_NOSE_CLEAR))) continue;
      if (t > 0 && dist(edge(cx, d, 0), edge(cy, d, 0)) < HATCH_MIN_W) continue;
      const v = rightNormal(tan);
      for (const k of [1, -1]) hatch.push([apex, add(apex, scale(add(scale(tan, back * 0.5), scale(v, k * 0.87)), armLen))]);
    }
    return {
      asphalt: asphalt.pts,
      nose: asphalt.nose,
      paint: paint.pts,
      lines: paint.lines,
      hatch,
      // Точка стыка, где кромки X и Y совпадают.
      start: add(net.portPos(X.node, net.laneAtSeam(X, facing).lat + laneWidth(facing) / 2), lift(X.corridor, cx.at(0).s)),
      axis: axisAt(0),
      armLen,
      length: d1,
      diverge,
    };
  }

  /** Площадка перекрёстка: края подъездов, между соседними — плавный угол. */
  private plateGeo(net: LaneNet, n: LaneNode): PlateGeo | null {
    // Контур — общий с тротуарами вдоль бордюра (plateOutline).
    const plate = plateOutline(net, n, this.cuts);
    if (!plate) return null;
    const dirt = net.ends(n).every((e) => isDirt(e.corridor.cls));
    const poly = plate.poly;
    const curbs = plate.curbs.map((k) => k.pts);
    return dirt ? { poly, curbs, dirt } : { poly, curbs };
  }

  /** Тупик: полукруглый разворот на конце полотна. */
  private capGeo(e: CorridorEnd): CapGeo {
    const c = e.corridor;
    const s = e.end === 'a' ? 0 : c.length;
    const ed = edgesAt(c, s) ?? [-3.5, 3.5];
    const a = pointOff(c, s, ed[0] - ROAD_MARGIN);
    const b = pointOff(c, s, ed[1] + ROAD_MARGIN);
    const mid = scale(add(a, b), 0.5);
    const r = dist(a, b) / 2;
    const out = scale(e.away, -1);
    const side = sub(a, mid);
    const arc: Vec[] = [];
    for (let i = 0; i <= 16; i++) {
      const ang = (Math.PI * i) / 16;
      arc.push(add(mid, add(scale(norm(side), Math.cos(ang) * r), scale(out, Math.sin(ang) * r))));
    }
    return isDirt(c.cls) ? { poly: [...arc, mid], arc, dirt: true } : { poly: [...arc, mid], arc };
  }

  // ---------- Рисование ----------

  private drawMarks(ctx: CanvasRenderingContext2D, corridors: CorridorGeo[], nodes: NodeGeo[]): void {
    // Колеи полотен и площадок — одной линией: где сходятся и пересекаются, прозрачность не копится.
    ctx.lineCap = 'round';
    ctx.strokeStyle = C.rut;
    ctx.lineWidth = RUT_W;
    ctx.beginPath();
    for (const g of corridors) for (const m of g.marks) if (m.style === 'rut') this.path(ctx, m.pts);
    for (const n of nodes) for (const pts of n.ruts ?? []) this.path(ctx, pts);
    ctx.stroke();
    ctx.lineCap = 'butt';
    for (const [color, width] of [
      ['#9aa1aa', 4],
      ['#e8ebee', 1.6],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const g of corridors) for (const m of g.marks) if (m.style === 'barrier') this.path(ctx, m.pts);
      ctx.stroke();
    }
    for (const style of ['dash', 'solid', 'yellow'] as const) {
      ctx.strokeStyle = style === 'yellow' ? C.divider : C.dash;
      ctx.lineWidth = style === 'yellow' ? 1.4 : 1;
      ctx.beginPath();
      for (const g of corridors) for (const m of g.marks) if (m.style === style) this.path(ctx, m.pts);
      ctx.stroke();
    }
  }

  private drawGorePaint(ctx: CanvasRenderingContext2D, g: GoreGeo): void {
    ctx.save();
    ctx.beginPath();
    this.path(ctx, g.paint);
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = C.dash;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    // Плечи под 60° к средней линии островка: чёткие «галочки» по дуге стыка (GoreGeo.hatch).
    for (const [a, b] of g.hatch) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = C.dash;
    ctx.lineWidth = 1;
    for (const pts of g.lines) this.stroke(ctx, pts);
  }

  /**
   * Разметка площадки перекрёстка — тем же языком, что «ёлочка» у стыков: островки (1.16) — штрихи в клипе по их
   * контуру и сам контур, направляющие (1.7) — короткими штрихами.
   */
  private drawJunctionMarks(ctx: CanvasRenderingContext2D, m: JunctionMarkGeo): void {
    if (m.islands.length) {
      ctx.save();
      ctx.beginPath();
      for (const loop of m.islands) {
        this.path(ctx, loop);
        ctx.closePath();
      }
      ctx.clip('evenodd');
      ctx.strokeStyle = C.dash;
      ctx.lineWidth = 1.1;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      for (const s of m.hatch) this.path(ctx, s);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = C.dash;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const loop of m.islands) {
        this.path(ctx, loop);
        ctx.closePath();
      }
      ctx.stroke();
    }
    if (m.dashes.length) {
      ctx.strokeStyle = C.dash;
      ctx.lineWidth = 1;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      for (const d of m.dashes) this.path(ctx, d);
      ctx.stroke();
    }
  }

  /** Стрелки одной заливкой: контуры обходятся в одну сторону — без двойной прозрачности. */
  private drawArrows(ctx: CanvasRenderingContext2D, corridors: CorridorGeo[]): void {
    ctx.fillStyle = C.dash;
    ctx.beginPath();
    for (const g of corridors) {
      for (const poly of g.arrows) {
        this.path(ctx, poly);
        ctx.closePath();
      }
    }
    ctx.fill();
  }

  /** Оси полотен, стыки (направление и сдвиги) и перекрёстки. */
  private drawDebug(ctx: CanvasRenderingContext2D, net: LaneNet, zoom: number): void {
    ctx.strokeStyle = C.axis;
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.beginPath();
    for (const c of net.corridors.values()) this.path(ctx, c.lut.offsetPolyline(0, 0, c.length, 6));
    ctx.stroke();
    ctx.setLineDash([]);
    for (const n of net.nodes.values()) {
      ctx.fillStyle = n.kind === 'seam' ? '#2f80ed' : '#e8483f';
      ctx.beginPath();
      ctx.arc(n.pos.x, n.pos.y, 3 / zoom, 0, Math.PI * 2);
      ctx.fill();
      if (n.kind !== 'seam') continue;
      // Поперечное сечение стыка и его направление.
      const ports = net.ends(n).map((e) => e.port);
      const r = rightNormal(n.dir);
      const lo = Math.min(0, ...ports) - 14;
      const hi = Math.max(0, ...ports) + 14;
      ctx.beginPath();
      ctx.moveTo(n.pos.x + r.x * lo, n.pos.y + r.y * lo);
      ctx.lineTo(n.pos.x + r.x * hi, n.pos.y + r.y * hi);
      ctx.moveTo(n.pos.x, n.pos.y);
      ctx.lineTo(n.pos.x + n.dir.x * 12, n.pos.y + n.dir.y * 12);
      ctx.strokeStyle = '#2f80ed';
      ctx.stroke();
    }
  }

  private path(ctx: CanvasRenderingContext2D, pts: Vec[]): void {
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  }

  private stroke(ctx: CanvasRenderingContext2D, pts: Vec[]): void {
    if (pts.length < 2) return;
    ctx.beginPath();
    this.path(ctx, pts);
    ctx.stroke();
  }

  private fill(ctx: CanvasRenderingContext2D, pts: Vec[]): void {
    if (pts.length < 3) return;
    ctx.beginPath();
    this.path(ctx, pts);
    ctx.closePath();
    ctx.fill();
  }
}

/** Пунктир с ровным шагом: на концах — по половине пробела, тогда на стыках шаг не сбивается. */
function cutDashes(pts: Vec[], dash = 5, period = 11): Vec[][] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const L = cum[cum.length - 1];
  if (L < dash) return [];
  const k = Math.max(1, Math.round(L / period));
  const p = L / k;
  const d = (p * dash) / period;
  let j = 1;
  const at = (u: number): Vec => {
    while (j < cum.length - 1 && cum[j] < u) j++;
    const seg = cum[j] - cum[j - 1] || 1;
    const f = Math.max(0, Math.min(1, (u - cum[j - 1]) / seg));
    return { x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * f, y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * f };
  };
  const out: Vec[][] = [];
  for (let i = 0; i < k; i++) {
    const u0 = i * p + (p - d) / 2;
    const u1 = u0 + d;
    const piece = [at(u0)];
    for (let q = j; q < cum.length - 1 && cum[q] < u1; q++) if (cum[q] > u0) piece.push(pts[q]);
    piece.push(at(u1));
    out.push(piece);
  }
  return out;
}
