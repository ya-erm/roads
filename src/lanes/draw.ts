import { add, cubicBezier, dist, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { arrowAt, arrowShape } from './arrowShape';
import { awayAt, awaySign, edgesAt, junctionCuts, laneShare, paintedEdges, pointOff, sFrom, stations } from './geometry';
import { Corridor, CorridorEnd, End, LaneNet, LaneNode, LAT_EPS, layerOf } from './model';

export { layerOf };

const C = {
  road: '#646b76',
  roadEdge: '#4b525c',
  dash: 'rgba(245, 243, 230, 0.85)',
  divider: 'rgba(240, 205, 96, 0.9)',
  axis: 'rgba(47, 128, 237, 0.8)',
  /** Мосты и эстакады: тень на земле, бетонное ограждение по краям. */
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
  /** Высота у каждой точки left/right — тень моста сдвинута на столько, сколько под ней высоты. */
  heights: number[];
  /** Куски над водой на земле [i0, i1] (индексы точек left/right): рисуются мостом. */
  wet: [number, number][];
  marks: Mark[];
  /** Контуры стрелок «прямо» на односторонней дороге (в мире). */
  arrows: Vec[][];
}

/** Стрелка «прямо» — как перед перекрёстками. */
const STRAIGHT = arrowShape(['straight']);

/** Сдвиг тени моста на высоте h: на земле — ноль, у моста (1) и эстакады (2) — всё дальше. */
const shadowOff = (h: number): Vec => (h <= 1 ? { x: 9 * h, y: 14 * h } : { x: 9 + 4 * (h - 1), y: 14 + 6 * (h - 1) });
/** Мост на земле над рекой — низкий: тень на воде совсем рядом. */
const LOW_BRIDGE = 0.3;
/** Мост над рекой начинается и кончается на берегу — на столько от воды. */
const BRIDGE_LAND = 10;
/** «Крылья» у концов моста: ограждение расходится в стороны — вдоль дороги и вбок. */
const WING = { along: 6, out: 4 };

/** Островок между соседними полотнами одной стороны стыка. */
interface GoreGeo {
  /** Асфальт от стыка до носа и сам нос (бордюр). */
  asphalt: Vec[];
  nose: Vec[];
  /** Контур краской — на кромках полос. */
  paint: Vec[];
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

/**
 * Перед развилкой полос в разные полотна (и после вливания) пунктир между ними становится сплошным —
 * только у самого стыка, чтобы до него оставалось где перестроиться.
 */
const SPLIT_SOLID = 20;
/** И на последних метрах перед перекрёстком (до обреза у стоп-линии) — между попутными полосами подъезда. */
const APPROACH_SOLID = 20;
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
interface NodeGeo {
  gores: GoreGeo[];
  plate: PlateGeo | null;
  caps: { poly: Vec[]; arc: Vec[] }[];
}

interface Cached<T> {
  key: string;
  geo: T;
  bbox: BBox;
  /** Слой по высоте (layerOf). */
  layer: number;
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
    ctx.fillStyle = C.shadow;
    if (elevated) {
      // Мост или эстакада: тень со сдвигом по высоте в каждой точке — у конца пандуса на земле она под самой дорогой.
      for (const g of corridors) this.fill(ctx, this.shadowPoly(g, 0, g.left.length - 1));
      const off = shadowOff(layer);
      for (const p of plates) this.fill(ctx, p.poly.map((q) => add(q, off)));
      for (const cap of caps) this.fill(ctx, cap.poly.map((q) => add(q, off)));
    }
    if (ground) for (const g of corridors) for (const [i0, i1] of g.wet) this.fill(ctx, this.shadowPoly(g, i0, i1, LOW_BRIDGE));
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
    // Бетонный парапет по краям моста — поверх кромки асфальта; на земле — только над водой.
    const parapets: Vec[][] = [];
    for (const g of corridors) {
      if (elevated) parapets.push(g.left, g.right);
      else if (ground) for (const [i0, i1] of g.wet) parapets.push(...this.wings(g, i0, i1));
    }
    if (parapets.length) {
      ctx.lineCap = 'butt';
      for (const [color, width] of [
        ['#8c877c', 3.2],
        [C.rail, 2],
      ] as const) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        for (const pts of parapets) this.stroke(ctx, pts);
      }
    }
    if (zoom >= 0.35) {
      this.drawMarks(ctx, corridors);
      for (const g of gores) this.drawGorePaint(ctx, g);
      this.drawArrows(ctx, corridors);
    }
    if (debug) this.drawDebug(ctx, net, zoom);
  }

  /** Ограждение моста над рекой [i0, i1] по обоим краям: на концах — «крылья», расходящиеся в стороны от дороги. */
  private wings(g: CorridorGeo, i0: number, i1: number): Vec[][] {
    if (i1 <= i0) return [];
    return [g.left, g.right].map((edge, k) => {
      const other = k === 0 ? g.right : g.left;
      const out = (i: number) => norm(sub(edge[i], other[i]));
      const back = norm(sub(edge[i0], edge[i0 + 1]));
      const fwd = norm(sub(edge[i1], edge[i1 - 1]));
      const wing = (i: number, dir: Vec) => add(edge[i], add(scale(dir, WING.along), scale(out(i), WING.out)));
      return [wing(i0, back), ...edge.slice(i0, i1 + 1), wing(i1, fwd)];
    });
  }

  /** Тень куска полотна [i0, i1]: каждая точка сдвинута по своей высоте (or — одна высота на всё). */
  private shadowPoly(g: CorridorGeo, i0: number, i1: number, or?: number): Vec[] {
    const at = (p: Vec, i: number) => add(p, shadowOff(or ?? Math.max(0, g.heights[i])));
    const l = g.left.slice(i0, i1 + 1).map((p, k) => at(p, i0 + k));
    const r = g.right.slice(i0, i1 + 1).map((p, k) => at(p, i0 + k));
    return [...l, ...r.reverse()];
  }

  /** Обрыв полотен у перекрёстков — для движения и подсказок. */
  cutsOf(net: LaneNet): Map<number, [number, number]> {
    this.refresh(net);
    return this.cuts;
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
      sigs.set(n.id, `${n.kind}:${n.level}:${n.pos.x},${n.pos.y}:${n.dir.x},${n.dir.y}:${arms}`);
    }
    const corridors: Cached<CorridorGeo>[] = [];
    for (const c of net.corridors.values()) {
      const key = `${c.rev}|${this.cuts.get(c.id)?.join('/')}|${sigs.get(c.a)}|${sigs.get(c.b)}`;
      let item = this.corridorCache.get(c.id);
      if (!item || item.key !== key) {
        const geo = this.corridorGeo(net, c);
        const la = net.node(c.a).level;
        const lb = net.node(c.b).level;
        item = { key, geo, bbox: bboxOf([geo.poly]), layer: layerOf(Math.min(la, lb), Math.max(la, lb)) };
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
        const geo: NodeGeo = { gores: [], plate: null, caps: [] };
        if (n.kind === 'junction') geo.plate = this.plateGeo(net, n);
        else if (net.isDeadEnd(n)) geo.caps = net.ends(n).map((e) => this.capGeo(e));
        else geo.gores = this.seamGores(net, n);
        const bbox = bboxOf([geo.plate?.poly ?? [], ...geo.caps.map((c) => c.poly), ...geo.gores.map((g) => g.asphalt), [n.pos]]);
        item = { key, geo, bbox, layer: layerOf(n.level, n.level) };
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
    for (const x of [SPLIT_SOLID, c.length - SPLIT_SOLID, s0 + APPROACH_SOLID, s1 - APPROACH_SOLID]) if (x > s0 && x < s1) ss.push(x);
    ss.sort((x, y) => x - y);
    const left: Vec[] = [];
    const right: Vec[] = [];
    const heights: number[] = [];
    const at: number[] = [];
    const over: boolean[] = [];
    for (const s of ss) {
      const e = edgesAt(c, s);
      if (!e) continue;
      left.push(pointOff(c, s, e[0] - ROAD_MARGIN));
      right.push(pointOff(c, s, e[1] + ROAD_MARGIN));
      const h = net.heightAt(c, s);
      heights.push(h);
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
    return { poly: [...l, ...r.reverse()], left, right, heights, wet, marks: this.corridorMarks(net, c, ss, s0, s1), arrows: this.corridorArrows(c, s0, s1) };
  }

  /** Разметка полотна: границы соседних полос, барьер на разделительной, кромки. [s0, s1] — асфальт между обрезами у перекрёстков. */
  private corridorMarks(net: LaneNet, c: Corridor, ss: number[], s0: number, s1: number): Mark[] {
    const marks: Mark[] = [];
    /** Куски линии со смещением off там, где style(s) не null; стиль внутри куска один. */
    const runs = (off: number, style: (s: number) => LineStyle | null) => {
      let cur: Mark | null = null;
      for (const s of ss) {
        const st = style(s);
        const p = pointOff(c, s, off);
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
    // Разошлись ли полосы i и j в стыке на конце end в разные полотна.
    const splits = (i: number, j: number, end: End) => {
      const n = net.node(end === 'a' ? c.a : c.b);
      if (n.kind !== 'seam' || net.isDeadEnd(n)) return false;
      if (!net.reaches(c, c.lanes[i], end) || !net.reaches(c, c.lanes[j], end)) return false;
      return net.across(c, i, end)?.corridor.id !== net.across(c, j, end)?.corridor.id;
    };
    // Едут ли полосы с направлением flow к перекрёстку на конце end (на кольце — нет: там перестраиваются).
    const toJunction = (flow: number, end: End) => !c.ring && flow === (end === 'b' ? 1 : -1) && net.node(end === 'a' ? c.a : c.b).kind === 'junction';
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
        const splitA = same && splits(i, j, 'a');
        const splitB = same && splits(i, j, 'b');
        const nearA = same && toJunction(A.flow, 'a');
        const nearB = same && toJunction(A.flow, 'b');
        // Осевая между встречными: у проспекта — жёлтая сплошная; у улицы 1+1 — пунктир, но у перекрёстка — сплошная.
        const jA = !c.ring && net.node(c.a).kind === 'junction';
        const jB = !c.ring && net.node(c.b).kind === 'junction';
        runs(mid, (s) => {
          if (!both(s)) return null;
          if (!same) {
            if (c.lanes.length > 2) return 'yellow';
            return (jA && s <= s0 + APPROACH_SOLID) || (jB && s > s1 - APPROACH_SOLID) ? 'solid' : 'dash';
          }
          // Сплошная — если так задано, перед развилкой полос в разные полотна и у самого перекрёстка.
          if (A.solid || (splitA && s <= SPLIT_SOLID) || (splitB && s >= c.length - SPLIT_SOLID)) return 'solid';
          return (nearA && s <= s0 + APPROACH_SOLID) || (nearB && s > s1 - APPROACH_SOLID) ? 'solid' : 'dash';
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
          if (e) pts.push(pointOff(c, s, e[side]));
        }
        if (pts.length > 1) marks.push({ pts, style: 'solid' });
      }
    }
    return marks.flatMap((m) => (m.style === 'dash' ? cutDashes(m.pts).map((pts) => ({ pts, style: m.style })) : [m]));
  }

  /** Стрелки направления — только на односторонней дороге: посередине полосы, на длинной — две. */
  private corridorArrows(c: Corridor, s0: number, s1: number): Vec[][] {
    if (!c.lanes.length || !c.lanes.every((l) => l.flow === c.lanes[0].flow)) return [];
    const res: Vec[][] = [];
    for (const l of c.lanes) {
      const a = Math.max(l.from, s0 + 8);
      const b = Math.min(l.to, s1 - 8);
      if (b - a < 40) continue;
      for (const f of b - a > 260 ? [0.25, 0.75] : [0.5]) {
        const s = a + (b - a) * f;
        res.push(...arrowAt(STRAIGHT, pointOff(c, s, l.offset), scale(c.lut.tangentAt(s), l.flow)));
      }
    }
    return res;
  }

  /** Островки между соседними полотнами стыка: с каждой стороны — между теми, чьи кромки в стыке совпадают. */
  private seamGores(net: LaneNet, n: LaneNode): GoreGeo[] {
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
    return {
      asphalt: asphalt.pts,
      nose: asphalt.nose,
      paint: paint.pts,
      // Точка стыка, где кромки X и Y совпадают.
      start: net.portPos(X.node, net.laneAtSeam(X, facing).lat + LANE_W / 2),
      axis: axisAt(0),
      armLen: dist(edge(X, sx, d1, 0), edge(Y, sy, d1, 0)) + 4,
      length: d1,
      diverge: (forward ? 1 : -1) * side > 0,
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
      // Угол между подъездами: кривая, касательная к их краям (почти прямые — просто отрезок).
      const den = a.away.x * b.away.y - a.away.y * b.away.x;
      const q = sub(b.L, a.R);
      const t = Math.abs(den) > 0.05 ? (q.x * b.away.y - q.y * b.away.x) / den : NaN;
      const corner: Vec[] = [];
      if (Number.isFinite(t) && t < 0) {
        const x = add(a.R, scale(a.away, t));
        for (let k = 1; k < 12; k++) {
          const f = k / 12;
          corner.push(add(add(scale(a.R, (1 - f) * (1 - f)), scale(x, 2 * f * (1 - f))), scale(b.L, f * f)));
        }
      }
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
    const v = rightNormal(g.axis);
    const back = g.diverge ? 1 : -1;
    ctx.strokeStyle = C.dash;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    // Плечи под 60° к оси островка: чёткие «галочки».
    for (let t = -4; t <= g.length + 8; t += 5) {
      const apex = add(g.start, scale(g.axis, t));
      for (const side of [1, -1]) {
        const end = add(apex, scale(add(scale(g.axis, back * 0.5), scale(v, side * 0.87)), g.armLen));
        ctx.moveTo(apex.x, apex.y);
        ctx.lineTo(end.x, end.y);
      }
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
