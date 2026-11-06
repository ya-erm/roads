import { add, cubicBezier, dist, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { arrowAt, arrowShape } from './arrowShape';
import { bridgeLook, deckAlong, nodeDeck } from './deck';
import { awayAt, awaySign, cornerCurb, edgesAt, junctionCuts, laneShare, paintedEdges, pointOff, sFrom, stations } from './geometry';
import { Corridor, CorridorEnd, LaneNet, LaneNode, LAT_EPS, layerOf } from './model';
import { PARAPET, parapetLine, parapetWidth } from './parapet';
import { onPrefs, prefOn } from '../ui/prefs';
import { type JunctionMarks, junctionMarks } from './junctionMarks';
import { autoSolids, solidLength } from './solid';

export { layerOf };

const C = {
  road: '#646b76',
  roadEdge: '#4b525c',
  dash: 'rgba(245, 243, 230, 0.85)',
  divider: 'rgba(240, 205, 96, 0.9)',
  axis: 'rgba(47, 128, 237, 0.8)',
  /** Мосты и эстакады: тень на земле (одной плотности — на стыках полотен без ступенек), бетонное ограждение по краям. */
  shadow: 'rgba(20, 30, 20, 0.28)',
  rail: '#d6d1c4',
};

type LineStyle = 'dash' | 'solid' | 'yellow' | 'barrier';
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
  /** Ось на земле (без подъёма) в тех же точках и подъём полотна там — чтобы поднять и машины на мосту. */
  axis: Vec[];
  lifts: Vec[];
  /** Куски над водой на земле [i0, i1] (индексы точек left/right): рисуются мостом. */
  wet: [number, number][];
  marks: Mark[];
  /** Контуры стрелок «прямо» на односторонней дороге (в мире). */
  arrows: Vec[][];
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
  /** Контур краской — на кромках полос. */
  paint: Vec[];
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
}

interface PlateGeo {
  poly: Vec[];
  curbs: Vec[][];
}

// Перед развилкой полос в разные полотна, после вливания и на последних метрах перед перекрёстком пунктир между
// попутными полосами становится сплошным — где и какой длины, задаёт `autoSolids` (src/lanes/solid.ts): там же
// машинам и запрещено перестраиваться.
/** Нос островка — там, где нарисованные кромки разошлись на столько (или не дальше NOSE_MAX от стыка). */
const NOSE_GAP = 9;
const NOSE_MAX = 110;
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
  caps: { poly: Vec[]; arc: Vec[] }[];
  /** Узел моста: куда от поднятой площадки её тень (bridgeLook — как у концов его полотен). */
  shade: Vec;
}

/** Всё у узла моста — выше на экране на d (направление оси островка не меняется). */
function liftNode(geo: NodeGeo, d: Vec): NodeGeo {
  const up = (pts: Vec[]) => pts.map((p) => add(p, d));
  return {
    ...geo,
    plate: geo.plate && { poly: up(geo.plate.poly), curbs: geo.plate.curbs.map(up) },
    caps: geo.caps.map((c) => ({ poly: up(c.poly), arc: up(c.arc) })),
    gores: geo.gores.map((g) => ({ ...g, asphalt: up(g.asphalt), nose: up(g.nose), paint: up(g.paint), hatch: g.hatch.map(up), start: add(g.start, d) })),
    marks: geo.marks && { islands: geo.marks.islands.map(up), hatch: geo.marks.hatch.map(up), dashes: geo.marks.dashes.map(up) },
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
 * Отрисовка сети из полос: асфальт и бордюры, островки, перекрёстки, тупики, разметка, стрелки.
 * Геометрия кэшируется по каждому полотну и узлу отдельно (ключ — ревизии и соседи), поэтому
 * предпросмотр на копии большой сети пересчитывает только изменённое; рисуется только видимое.
 */
export class LaneRenderer {
  private net: LaneNet | null = null;
  private version = -1;
  private cuts = new Map<number, [number, number]>();
  private corridorCache = new Map<number, Cached<CorridorGeo>>();
  private nodeCache = new Map<number, Cached<NodeGeo>>();
  private corridors: Cached<CorridorGeo>[] = [];
  private nodes: Cached<NodeGeo>[] = [];
  /** Вода на карте: дорога над ней на земле рисуется мостом. Нет — воды нет (лаборатория). */
  water: ((p: Vec) => boolean) | null = null;
  /** Настройку «Разметка перекрёстков» переключили — геометрию узлов заново, чтобы было видно сразу. Вызов — отписка. */
  readonly unprefs = onPrefs(() => {
    this.net = null;
    this.version = -1;
    this.nodeCache.clear();
  });

  /** Новая карта: кэш геометрии (в нём и куски над водой) — заново, и вода — уже другой карты. */
  reset(): void {
    this.water = null;
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

  /** Рисует сеть; layer — только этот слой высоты (тоннели, земля, мосты, эстакады), без него — всё. */
  draw(ctx: CanvasRenderingContext2D, net: LaneNet, zoom: number, debug = false, view?: BBox, layer?: number): void {
    this.refresh(net);
    const seen = (b: BBox) => !view || !(b.x1 < view.x0 || b.x0 > view.x1 || b.y1 < view.y0 || b.y0 > view.y1);
    const mine = (x: Cached<unknown>) => layer === undefined || x.layer === layer;
    const corridors = this.corridors.filter((x) => mine(x) && seen(x.bbox)).map((x) => x.geo);
    const nodes = this.nodes.filter((x) => mine(x) && seen(x.bbox)).map((x) => x.geo);
    const plates = nodes.flatMap((n) => (n.plate ? [n.plate] : []));
    const caps = nodes.flatMap((n) => n.caps);
    const gores = nodes.flatMap((n) => n.gores);
    ctx.lineJoin = 'round';
    const elevated = layer !== undefined && layer > 0;
    // Низкие мосты над рекой — в слое земли (и всё сразу, если слой не задан).
    const ground = layer === undefined || layer === 0;
    if (elevated) {
      // Мост или эстакада: тень со сдвигом по высоте над землёй в каждой точке — у конца пандуса на земле она под
      // самой дорогой; выше мост — дальше тень.
      ctx.fillStyle = C.shadow;
      for (const g of corridors) this.fill(ctx, this.shadowPoly(g, 0, g.left.length - 1));
      for (const n of nodes) {
        if (n.plate) this.fill(ctx, n.plate.poly.map((q) => add(q, n.shade)));
        for (const cap of n.caps) this.fill(ctx, cap.poly.map((q) => add(q, n.shade)));
      }
    }
    if (ground) {
      const low = bridgeLook(LOW_BRIDGE).shadow;
      ctx.fillStyle = C.shadow;
      for (const g of corridors) for (const [i0, i1] of g.wet) this.fill(ctx, this.shadowPoly(g, i0, i1, low));
    }
    // Бордюры под асфальтом: заливка соседнего полотна закрывает их там, где полотна сходятся.
    ctx.strokeStyle = C.roadEdge;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    for (const g of corridors) {
      this.stroke(ctx, g.left);
      this.stroke(ctx, g.right);
    }
    for (const p of plates) for (const c of p.curbs) this.stroke(ctx, c);
    for (const cap of caps) this.stroke(ctx, cap.arc);
    ctx.fillStyle = C.road;
    for (const g of corridors) this.fill(ctx, g.poly);
    for (const p of plates) this.fill(ctx, p.poly);
    for (const cap of caps) this.fill(ctx, cap.poly);
    // Островки: асфальт до носа, нос — тонким бордюром.
    for (const g of gores) {
      ctx.fillStyle = C.road;
      this.fill(ctx, g.asphalt);
      ctx.strokeStyle = C.roadEdge;
      ctx.lineWidth = 1.6;
      this.stroke(ctx, g.nose);
    }
    // Бетонный парапет по краям моста — снаружи асфальта, вплотную к кромке (полосы не сужает); на земле — только над водой.
    const wall = parapetWidth(zoom);
    const parapets: Vec[][] = [];
    for (const g of corridors) {
      if (elevated) parapets.push(parapetLine(g.left, g.right, wall / 2), parapetLine(g.right, g.left, wall / 2));
      else if (ground) for (const [i0, i1] of g.wet) parapets.push(...this.wings(g, i0, i1, wall / 2));
    }
    if (parapets.length) {
      ctx.lineCap = 'butt';
      for (const [color, width] of [
        ['#8c877c', wall],
        [C.rail, wall * PARAPET.top],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        for (const pts of parapets) this.stroke(ctx, pts);
      }
    }
    if (zoom >= 0.35) {
      this.drawMarks(ctx, corridors);
      for (const g of gores) this.drawGorePaint(ctx, g);
      for (const n of nodes) if (n.marks) this.drawJunctionMarks(ctx, n.marks);
      this.drawArrows(ctx, corridors);
    }
    if (debug) this.drawDebug(ctx, net, zoom);
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

  /**
   * На сколько поднят на экране мост в точке p (машина на нём едет вместе с полотном): ближайшая точка оси
   * моста или пандуса не дальше 15 м; не на мосту — ноль.
   */
  liftAt(net: LaneNet, p: Vec): Vec {
    this.refresh(net);
    let best: Vec = { x: 0, y: 0 };
    let bd = 15 * 15;
    for (const x of this.corridors) {
      const b = x.bbox;
      if (x.layer < 1 || p.x < b.x0 - 15 || p.x > b.x1 + 15 || p.y < b.y0 - 15 || p.y > b.y1 + 15) continue;
      const { axis, lifts } = x.geo;
      for (let i = 0; i < axis.length; i++) {
        const d = (axis[i].x - p.x) ** 2 + (axis[i].y - p.y) ** 2;
        if (d < bd) [bd, best] = [d, lifts[i]];
      }
    }
    return best;
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
    this.cuts = junctionCuts(net);
    // Подпись узла: всё, от чего зависит геометрия вокруг него.
    const sigs = new Map<number, string>();
    for (const n of net.nodes.values()) {
      const arms = n.corridors.map((id) => `${id}.${net.corridor(id).rev}.${this.cuts.get(id)?.join('/')}`).join(',');
      const corners = n.corners ? Object.entries(n.corners).join(';') : '';
      // Запреты и связи полос меняют траектории — а по ним разметка площадки.
      const turns = `${n.bans?.join(';') ?? ''}|${n.lanes?.join(';') ?? ''}`;
      sigs.set(n.id, `${n.kind}:${n.level}:${n.deck ?? ''}:${n.pos.x},${n.pos.y}:${n.dir.x},${n.dir.y}:${arms}:${corners}:${turns}`);
    }
    const corridors: Cached<CorridorGeo>[] = [];
    for (const c of net.corridors.values()) {
      const key = `${c.rev}|${this.cuts.get(c.id)?.join('/')}|${sigs.get(c.a)}|${sigs.get(c.b)}`;
      let item = this.corridorCache.get(c.id);
      if (!item || item.key !== key) {
        const geo = this.corridorGeo(net, c);
        const la = net.node(c.a).level;
        const lb = net.node(c.b).level;
        const layer = layerOf(Math.min(la, lb), Math.max(la, lb));
        // Отпечаток: всё, что рисуется, и то, от чего зависят знаки и скорости (класс, полосы, ограничение).
        const shape = shapeOf(
          [geo.poly, geo.left, geo.right, geo.shade, geo.lifts, ...geo.marks.map((m) => m.pts), ...geo.arrows],
          `${layer}|${la}|${lb}|${geo.marks.map((m) => m.style).join(',')}|${geo.wet.join(';')}|${c.cls}|${c.limit ?? ''}|${c.ring ?? ''}|${JSON.stringify(c.lanes)}`,
        );
        item = { key, geo, bbox: bboxOf([geo.poly]), layer, shape };
        this.corridorCache.set(c.id, item);
      }
      corridors.push(item);
    }
    for (const id of this.corridorCache.keys()) if (!net.corridors.has(id)) this.corridorCache.delete(id);
    const nodes: Cached<NodeGeo>[] = [];
    for (const n of net.nodes.values()) {
      const key = sigs.get(n.id)!;
      let item = this.nodeCache.get(n.id);
      if (!item || item.key !== key) {
        let geo: NodeGeo = { gores: [], plate: null, caps: [], shade: { x: 0, y: 0 } };
        if (n.kind === 'junction') {
          geo.plate = this.plateGeo(net, n);
          // Разметка площадки большого перекрёстка — если включена в настройках.
          if (geo.plate && prefOn('junctionMarks')) {
            const m = junctionMarks(net, n, geo.plate.poly, this.cuts);
            geo.marks = m && markGeo(m);
          }
        } else if (net.isDeadEnd(n)) geo.caps = net.ends(n).map((e) => this.capGeo(e));
        else geo.gores = this.seamGores(net, n);
        // Узел моста — поднят на свою высоту, как концы его полотен; тень — на земле под ним.
        const look = bridgeLook(n.level > 0 ? nodeDeck(n) : 0);
        if (look.lift.y !== 0) geo = liftNode(geo, look.lift);
        geo.shade = sub(look.shadow, look.lift);
        const bbox = bboxOf([geo.plate?.poly ?? [], ...geo.caps.map((c) => c.poly), ...geo.gores.map((g) => g.asphalt), [n.pos]]);
        const layer = layerOf(n.level, n.level);
        const shape = shapeOf(
          [
            geo.plate?.poly ?? [],
            ...(geo.plate?.curbs ?? []),
            ...geo.caps.flatMap((c) => [c.poly, c.arc]),
            ...geo.gores.flatMap((g) => [g.asphalt, g.nose, g.paint, ...g.hatch, [g.start, g.axis]]),
            ...(geo.marks ? [...geo.marks.islands, ...geo.marks.hatch, ...geo.marks.dashes] : []),
            [geo.shade, n.pos],
          ],
          // Запреты и связи полос — стрелки и стоп-линии перекрёстка.
          `${layer}|${n.kind}|${n.roundabout ?? ''}|${geo.gores.map((g) => `${g.diverge}`).join()}|${n.bans?.join(';') ?? ''}|${n.lanes?.join(';') ?? ''}`,
        );
        item = { key, geo, bbox, layer, shape };
        this.nodeCache.set(n.id, item);
      }
      nodes.push(item);
    }
    for (const id of this.nodeCache.keys()) if (!net.nodes.has(id)) this.nodeCache.delete(id);
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
    ss.sort((x, y) => x - y);
    // Мост и пандус к нему: сколько под полотном высоты в каждой точке — на столько оно поднято на экране.
    const raised = Math.max(net.node(c.a).level, net.node(c.b).level) > 0;
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
    const axis: Vec[] = [];
    const lifts: Vec[] = [];
    const at: number[] = [];
    const over: boolean[] = [];
    for (const s of ss) {
      const e = edgesAt(c, s);
      if (!e) continue;
      left.push(up(s, e[0] - ROAD_MARGIN));
      right.push(up(s, e[1] + ROAD_MARGIN));
      const v = look(s);
      shade.push(sub(v.shadow, v.lift));
      axis.push(pointOff(c, s, 0));
      lifts.push(v.lift);
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
    return {
      poly: [...l, ...r.reverse()],
      left,
      right,
      shade,
      axis,
      lifts,
      wet,
      marks: this.corridorMarks(net, c, ss, s0, s1, up),
      arrows: this.corridorArrows(c, s0, s1, up),
    };
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
    const L = solidLength(c);
    const order = c.lanes.map((_, i) => i).sort((x, y) => c.lanes[x].offset - c.lanes[y].offset);
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
        // Осевая между встречными: у проспекта — жёлтая сплошная; у улицы 1+1 — пунктир, но у перекрёстка — сплошная.
        const jA = !c.ring && net.node(c.a).kind === 'junction';
        const jB = !c.ring && net.node(c.b).kind === 'junction';
        runs(mid, (s) => {
          if (!both(s)) return null;
          if (!same) {
            if (c.lanes.length > 2) return 'yellow';
            return (jA && s <= s0 + L) || (jB && s > s1 - L) ? 'solid' : 'dash';
          }
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
      // Кромки — по краю крайних полос, на отгоне идут по скосу.
      for (const side of [0, 1] as const) {
        const pts: Vec[] = [];
        for (const s of ss) {
          const e = edgesAt(c, s);
          if (e) pts.push(at(s, e[side]));
        }
        if (pts.length > 1) marks.push({ pts, style: 'solid' });
      }
    }
    return marks.flatMap((m) => (m.style === 'dash' ? cutDashes(m.pts).map((pts) => ({ pts, style: m.style })) : [m]));
  }

  /** Стрелки направления — только на односторонней дороге: посередине полосы, на длинной — две. */
  private corridorArrows(c: Corridor, s0: number, s1: number, at: (s: number, off: number) => Vec): Vec[][] {
    if (!c.lanes.length || !c.lanes.every((l) => l.flow === c.lanes[0].flow)) return [];
    const res: Vec[][] = [];
    for (const l of c.lanes) {
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

  /** Островки между соседними полотнами стыка: с каждой стороны — между теми, чьи кромки в стыке совпадают. */
  seamGores(net: LaneNet, n: LaneNode): GoreGeo[] {
    const res: GoreGeo[] = [];
    for (const side of [1, -1] as const) {
      const list = net
        .ends(n)
        .filter((e) => e.side === side)
        .map((e) => {
          const lats = e.corridor.lanes.filter((l) => net.reaches(e.corridor, l, e.end)).map((l) => net.laneAtSeam(e, l).lat);
          return { e, lo: Math.min(...lats) - LANE_W / 2, hi: Math.max(...lats) + LANE_W / 2 };
        })
        .filter((x) => Number.isFinite(x.lo))
        .sort((x, y) => x.lo - y.lo);
      for (let k = 0; k + 1 < list.length; k++) {
        if (Math.abs(list[k].hi - list[k + 1].lo) > LAT_EPS) continue;
        const g = this.goreGeo(net, list[k].e, list[k + 1].e, side);
        if (g) res.push(g);
      }
    }
    return res;
  }

  /**
   * Островок между X (левее в стыке) и Y (правее) на стороне side: их кромки в стыке совпадают,
   * дальше расходятся; нос — где разошлись на NOSE_GAP.
   */
  private goreGeo(net: LaneNet, X: CorridorEnd, Y: CorridorEnd, side: 1 | -1): GoreGeo | null {
    // Обращённые друг к другу кромки: у X — правая по `dir` стыка, у Y — левая. В смещениях полотна:
    const sx = side * awaySign(X.end);
    const sy = -side * awaySign(Y.end);
    const edge = (e: CorridorEnd, sign: number, d: number, extra: number): Vec => {
      const s = sFrom(e.corridor, e.end, d);
      const ed = edgesAt(e.corridor, s) ?? [0, 0];
      return pointOff(e.corridor, s, sign > 0 ? ed[1] + extra : ed[0] - extra);
    };
    const maxD = Math.min(X.corridor.length, Y.corridor.length) * 0.9;
    let d1 = -1;
    for (let d = 2; d <= maxD; d += 2) {
      if (dist(edge(X, sx, d, 0), edge(Y, sy, d, 0)) >= NOSE_GAP || d >= NOSE_MAX) {
        d1 = d;
        break;
      }
    }
    if (d1 < 12) return null;
    const axisAt = (d: number) => norm(add(awayAt(X.corridor, X.end, d), awayAt(Y.corridor, Y.end, d)));
    const u = axisAt(d1);
    /** Контур: вдоль кромки X от стыка, «U» носом к стыку, обратно вдоль кромки Y. */
    const outline = (extra: number, end: number) => {
      const steps = Math.max(4, Math.ceil(end / 3));
      const px = Array.from({ length: steps + 1 }, (_, i) => edge(X, sx, (end * i) / steps, extra));
      const py = Array.from({ length: steps + 1 }, (_, i) => edge(Y, sy, (end * i) / steps, extra));
      const e1 = px[px.length - 1];
      const e2 = py[py.length - 1];
      const w = dist(e1, e2);
      const c1 = sub(e1, scale(u, w * 0.6));
      const c2 = sub(e2, scale(u, w * 0.6));
      const nose: Vec[] = [];
      for (let i = 0; i <= 12; i++) nose.push(cubicBezier(e1, c1, c2, e2, i / 12));
      return { pts: [...px, ...nose.slice(1, -1), ...py.reverse()], nose };
    };
    const asphalt = outline(ROAD_MARGIN, d1);
    const paint = outline(0, d1 - 5);
    // Едут ли по крайней к островку полосе X от стыка.
    const facing = X.corridor.lanes
      .filter((l) => net.reaches(X.corridor, l, X.end))
      .reduce((a, b) => (net.laneAtSeam(X, b).lat > net.laneAtSeam(X, a).lat ? b : a));
    const forward = net.laneAtSeam(X, facing).forward;
    const diverge = (forward ? 1 : -1) * side > 0;
    const armLen = dist(edge(X, sx, d1, 0), edge(Y, sy, d1, 0)) + 4;
    // «Ёлочка» по средней линии островка (посередине между кромками): вершины — с шагом вдоль неё, плечи — под 60° к
    // её касательной в этой точке; за стыком и за носом линия продолжается по касательной (там штрихи срежет контур).
    const mid = (d: number) => scale(add(edge(X, sx, d, 0), edge(Y, sy, d, 0)), 0.5);
    const back = diverge ? 1 : -1;
    const hatch: Vec[][] = [];
    for (let t = -4; t <= d1 + 8; t += 5) {
      const d = Math.max(0, Math.min(d1, t));
      const tan = norm(sub(mid(Math.min(d1, d + 1.5)), mid(Math.max(0, d - 1.5))));
      const apex = add(mid(d), scale(tan, t - d));
      const v = rightNormal(tan);
      for (const k of [1, -1]) hatch.push([apex, add(apex, scale(add(scale(tan, back * 0.5), scale(v, k * 0.87)), armLen))]);
    }
    return {
      asphalt: asphalt.pts,
      nose: asphalt.nose,
      paint: paint.pts,
      hatch,
      // Точка стыка, где кромки X и Y совпадают.
      start: net.portPos(X.node, net.laneAtSeam(X, facing).lat + LANE_W / 2),
      axis: axisAt(0),
      armLen,
      length: d1,
      diverge,
    };
  }

  /** Площадка перекрёстка: края подъездов, между соседними — плавный угол. */
  private plateGeo(net: LaneNet, n: LaneNode): PlateGeo | null {
    const arms = net
      .ends(n)
      .map((e) => {
        const c = e.corridor;
        const r = this.cuts.get(c.id)![e.end === 'a' ? 0 : 1];
        const s = sFrom(c, e.end, r);
        const ed = edgesAt(c, s) ?? [0, 0];
        const sign = awaySign(e.end);
        // Края подъезда: слева и справа, если смотреть от перекрёстка.
        const lOff = sign > 0 ? ed[0] - ROAD_MARGIN : -(ed[1] + ROAD_MARGIN);
        const rOff = sign > 0 ? ed[1] + ROAD_MARGIN : -(ed[0] - ROAD_MARGIN);
        const p = c.lut.pointAt(s);
        const away = awayAt(c, e.end, r);
        const nr = rightNormal(away);
        return { angle: Math.atan2(away.y, away.x), away, L: add(p, scale(nr, lOff)), R: add(p, scale(nr, rOff)) };
      })
      .sort((x, y) => x.angle - y.angle);
    if (arms.length < 2) return null;
    const poly: Vec[] = [];
    const curbs: Vec[][] = [];
    arms.forEach((a, i) => {
      const b = arms[(i + 1) % arms.length];
      poly.push(a.L, a.R);
      // Угол между подъездами: дуга, касательная к их краям, до ближнего обреза (почти прямые — просто отрезок).
      // Повороты вдоль угла идут по дуге с тем же центром (`cornerCurb`, `filletPath`) — с асфальта не съезжают.
      // Внешняя сторона излома (больше развёрнутого) — плавная кривая.
      let gap = b.angle - a.angle;
      if (gap <= 0) gap += Math.PI * 2;
      const corner = cornerCurb(a.R, a.away, b.L, b.away, arms.length === 2 && gap > Math.PI).pts;
      poly.push(...corner);
      curbs.push([a.R, ...corner, b.L]);
    });
    return { poly, curbs };
  }

  /** Тупик: полукруглый разворот на конце полотна. */
  private capGeo(e: CorridorEnd): { poly: Vec[]; arc: Vec[] } {
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
    return { poly: [...arc, mid], arc };
  }

  // ---------- Рисование ----------

  private drawMarks(ctx: CanvasRenderingContext2D, corridors: CorridorGeo[]): void {
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
    ctx.beginPath();
    this.path(ctx, g.paint);
    ctx.closePath();
    ctx.stroke();
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
