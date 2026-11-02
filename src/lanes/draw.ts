import { add, cubicBezier, dist, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { awayAt, awaySign, edgesAt, junctionCuts, laneShare, paintedEdges, pointOff, sFrom, stations } from './geometry';
import { Corridor, CorridorEnd, End, LaneNet, LaneNode, LAT_EPS } from './model';

const C = {
  road: '#646b76',
  roadEdge: '#4b525c',
  dash: 'rgba(245, 243, 230, 0.85)',
  divider: 'rgba(240, 205, 96, 0.9)',
  axis: 'rgba(47, 128, 237, 0.8)',
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
  marks: Mark[];
  arrows: { pos: Vec; dir: Vec }[];
}

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

/** Перед развилкой полос в разные полотна пунктир между ними становится сплошным. */
const SPLIT_SOLID = 60;
/** Нос островка — там, где нарисованные кромки разошлись на столько (или не дальше NOSE_MAX от стыка). */
const NOSE_GAP = 9;
const NOSE_MAX = 110;
/** Полотна в стыке чуть заходят друг на друга — без светлого шва между заливками. */
const SEAM_OVERLAP = 0.8;

/** Отрисовка сети из полос: асфальт и бордюры, островки, перекрёстки, тупики, разметка, стрелки. */
export class LaneRenderer {
  private net: LaneNet | null = null;
  private version = -1;
  private cuts = new Map<number, [number, number]>();
  private corridors: CorridorGeo[] = [];
  private gores: GoreGeo[] = [];
  private plates: PlateGeo[] = [];
  private caps: { poly: Vec[]; arc: Vec[] }[] = [];

  draw(ctx: CanvasRenderingContext2D, net: LaneNet, zoom: number, debug = false): void {
    this.refresh(net);
    ctx.lineJoin = 'round';
    // Бордюры под асфальтом: заливка соседнего полотна закрывает их там, где полотна сходятся.
    ctx.strokeStyle = C.roadEdge;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    for (const g of this.corridors) {
      this.stroke(ctx, g.left);
      this.stroke(ctx, g.right);
    }
    for (const p of this.plates) for (const c of p.curbs) this.stroke(ctx, c);
    for (const cap of this.caps) this.stroke(ctx, cap.arc);
    ctx.fillStyle = C.road;
    for (const g of this.corridors) this.fill(ctx, g.poly);
    for (const p of this.plates) this.fill(ctx, p.poly);
    for (const cap of this.caps) this.fill(ctx, cap.poly);
    // Островки: асфальт до носа, нос — тонким бордюром.
    for (const g of this.gores) {
      ctx.fillStyle = C.road;
      this.fill(ctx, g.asphalt);
      ctx.strokeStyle = C.roadEdge;
      ctx.lineWidth = 1.6;
      this.stroke(ctx, g.nose);
    }
    if (zoom >= 0.35) {
      this.drawMarks(ctx);
      for (const g of this.gores) this.drawGorePaint(ctx, g);
      this.drawArrows(ctx);
    }
    if (debug) this.drawDebug(ctx, net, zoom);
  }

  // ---------- Кэш геометрии ----------

  private refresh(net: LaneNet): void {
    if (this.net === net && this.version === net.version) return;
    this.net = net;
    this.version = net.version;
    this.cuts = junctionCuts(net);
    this.corridors = [...net.corridors.values()].map((c) => this.corridorGeo(net, c));
    this.gores = [];
    this.plates = [];
    this.caps = [];
    for (const n of net.nodes.values()) {
      if (n.kind === 'junction') {
        const plate = this.plateGeo(net, n);
        if (plate) this.plates.push(plate);
      } else if (net.isDeadEnd(n)) {
        for (const e of net.ends(n)) this.caps.push(this.capGeo(e));
      } else this.gores.push(...this.seamGores(net, n));
    }
  }

  private corridorGeo(net: LaneNet, c: Corridor): CorridorGeo {
    const [ca, cb] = this.cuts.get(c.id)!;
    const s0 = ca;
    const s1 = c.length - cb;
    const ss = stations(c, s0, s1, 3);
    for (const x of [SPLIT_SOLID, c.length - SPLIT_SOLID]) if (x > s0 && x < s1) ss.push(x);
    ss.sort((x, y) => x - y);
    const left: Vec[] = [];
    const right: Vec[] = [];
    for (const s of ss) {
      const e = edgesAt(c, s);
      if (!e) continue;
      left.push(pointOff(c, s, e[0] - ROAD_MARGIN));
      right.push(pointOff(c, s, e[1] + ROAD_MARGIN));
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
    return { poly: [...l, ...r.reverse()], left, right, marks: this.corridorMarks(net, c, ss), arrows: this.corridorArrows(c, s0, s1) };
  }

  /** Разметка полотна: границы соседних полос, барьер на разделительной, кромки. */
  private corridorMarks(net: LaneNet, c: Corridor, ss: number[]): Mark[] {
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
        runs(mid, (s) => {
          if (!both(s)) return null;
          if (!same) return c.lanes.length > 2 ? 'yellow' : 'dash';
          // Сплошная — если так задано, и перед развилкой полос в разные полотна.
          return A.solid || (splitA && s <= SPLIT_SOLID) || (splitB && s >= c.length - SPLIT_SOLID) ? 'solid' : 'dash';
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

  private corridorArrows(c: Corridor, s0: number, s1: number): { pos: Vec; dir: Vec }[] {
    const res: { pos: Vec; dir: Vec }[] = [];
    for (const l of c.lanes) {
      const a = Math.max(l.from, s0 + 8);
      const b = Math.min(l.to, s1 - 8);
      if (b - a < 40) continue;
      for (const f of b - a > 260 ? [0.25, 0.75] : [0.5]) {
        const s = a + (b - a) * f;
        res.push({ pos: pointOff(c, s, l.offset), dir: scale(c.lut.tangentAt(s), l.flow) });
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

  private drawMarks(ctx: CanvasRenderingContext2D): void {
    ctx.lineCap = 'butt';
    for (const [color, width] of [
      ['#9aa1aa', 4],
      ['#e8ebee', 1.6],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const g of this.corridors) for (const m of g.marks) if (m.style === 'barrier') this.path(ctx, m.pts);
      ctx.stroke();
    }
    for (const style of ['dash', 'solid', 'yellow'] as const) {
      ctx.strokeStyle = style === 'yellow' ? C.divider : C.dash;
      ctx.lineWidth = style === 'yellow' ? 1.4 : 1;
      ctx.beginPath();
      for (const g of this.corridors) for (const m of g.marks) if (m.style === style) this.path(ctx, m.pts);
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

  private drawArrows(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = C.dash;
    for (const g of this.corridors) {
      for (const { pos: c, dir: d } of g.arrows) {
        const n = rightNormal(d);
        ctx.beginPath();
        ctx.moveTo(c.x + d.x * 3.5, c.y + d.y * 3.5);
        ctx.lineTo(c.x - d.x * 2 + n.x * 2, c.y - d.y * 2 + n.y * 2);
        ctx.lineTo(c.x - d.x * 2 - n.x * 2, c.y - d.y * 2 - n.y * 2);
        ctx.fill();
      }
    }
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
