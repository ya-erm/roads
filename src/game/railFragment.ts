import { MIN_SEGMENT_LEN } from '../config';
import { Cubic, CurveLUT } from '../core/bezier';
import { add, angleDiff, angleOf, dist, sub, Vec } from '../core/vec';
import { type Fragment, frameOf, placer, type RailFragment } from '../lanes/fragment';
import { Network, type Segment } from '../world/network';
import { isRail } from '../world/roadTypes';
import type { RoadRequest, Snap } from './build';

/**
 * Ж/д пути в куске для копирования и своих шаблонов: копия путей рамкой (задетые краем режутся по нему)
 * и вставка — пути под рамкой сносятся, тупики куска примыкают к срезам, участки проверяет и оценивает
 * обычный строитель путей.
 */

/** Тупик вставки примыкает к концу пути не дальше этого (срез пути под краем рамки). */
const JOIN = 12;

type Inside = (p: Vec) => boolean;
type RailSeg = RailFragment['segs'][number];

/** Куски оси участка внутри области, [s0, s1]; просветы короче MIN_SEGMENT_LEN (путь вдоль края) — не разрезаем. */
function runsInside(seg: { lut: CurveLUT; length: number }, inside: Inside): [number, number][] {
  const step = 2;
  // Граница между s0 и s1 (внутри и снаружи) — делением пополам.
  const edge = (s0: number, s1: number) => {
    const in0 = inside(seg.lut.pointAt(s0));
    for (let k = 0; k < 12; k++) {
      const m = (s0 + s1) / 2;
      if (inside(seg.lut.pointAt(m)) === in0) s0 = m;
      else s1 = m;
    }
    return (s0 + s1) / 2;
  };
  const runs: [number, number][] = [];
  const push = (a: number, b: number) => {
    const last = runs[runs.length - 1];
    if (last && a - last[1] < MIN_SEGMENT_LEN) last[1] = b;
    else runs.push([a, b]);
  };
  let start: number | null = null;
  let prev = 0;
  for (let s = 0; ; s += step) {
    const at = Math.min(s, seg.length);
    const isIn = inside(seg.lut.pointAt(at));
    if (isIn && start === null) start = at > 0 ? edge(prev, at) : 0;
    if (!isIn && start !== null) {
      push(start, edge(prev, at));
      start = null;
    }
    prev = at;
    if (at >= seg.length) break;
  }
  if (start !== null) push(start, seg.length);
  return runs.filter(([a, b]) => b - a > 1);
}

/**
 * Режет участок по кускам runs и отдаёт куски в piece — с конца к началу: разрез у бо́льшего s не сдвигает
 * меньшие. Обрезки короче minLen пропускаются (участок целиком — нет).
 */
function cut(net: Network, seg: Segment, runs: [number, number][], piece: (s: Segment) => void, minLen = 0): void {
  let rest: Segment | null = seg;
  for (const [sa, sb] of [...runs].reverse()) {
    if (!rest) break;
    const whole = sa <= 1 && sb >= rest.length - 1;
    if (!whole && sb - sa < minLen) continue;
    let p: Segment = rest;
    let before: Segment | null = null;
    if (sb < p.length - 1) p = net.splitSegmentDetailed(p.id, p.lut.tAt(sb)).first;
    if (sa > 1) {
      const r = net.splitSegmentDetailed(p.id, p.lut.tAt(sa));
      before = r.first;
      p = r.second;
    }
    piece(p);
    rest = before;
  }
}

/** Копия сети путей — для проверки вставки, не трогая настоящую (те же номера и счётчики). */
export function cloneNetwork(net: Network): Network {
  const copy = new Network();
  copy.load(structuredClone(net.serialize()));
  return copy;
}

// ---------- Копирование ----------

/** Пути в рамке (без платформ вокзалов): задетые краем режутся по нему. Координаты — от центра рамки; null — путей нет. */
export function copyRails(net: Network, x0: number, y0: number, x1: number, y1: number): RailFragment | null {
  const inside = (p: Vec) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const segs = net
    .segmentsInBox(x0, y0, x1, y1)
    .filter((s) => isRail(s.spec) && s.platform === undefined && runsInside(s, inside).length)
    .sort((a, b) => a.id - b.id);
  if (!segs.length) return null;
  // Рабочая сеть из задетых участков: режем её, настоящая сеть не меняется.
  const segIds = new Set(segs.map((s) => s.id));
  const nodeIds = [...new Set(segs.flatMap((s) => [s.a, s.b]))];
  const work = new Network();
  work.load(
    structuredClone({
      nextNodeId: Math.max(...nodeIds) + 1,
      nextSegId: Math.max(...segIds) + 1,
      nodes: nodeIds.map((id) => {
        const n = net.node(id);
        return { id, pos: n.pos, level: n.level, buildingId: null, signals: n.signals?.filter((x) => segIds.has(x)) };
      }),
      segments: segs.map((s) => ({ id: s.id, a: s.a, b: s.b, curve: s.curve, spec: s.spec })),
    }),
  );
  const keep = new Set<number>();
  for (const s of segs) cut(work, work.segment(s.id), runsInside(work.segment(s.id), inside), (p) => keep.add(p.id), MIN_SEGMENT_LEN);
  for (const s of [...work.segments.values()]) if (!keep.has(s.id)) work.removeSegment(s.id);
  if (!work.segments.size) return null;

  const center = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  const rel = (p: Vec) => sub(p, center);
  return {
    nodes: [...work.nodes.values()].map((n) => {
      const signals = n.signals?.filter((x) => work.segments.get(x) && (work.segment(x).a === n.id || work.segment(x).b === n.id));
      return { id: n.id, pos: rel(n.pos), level: n.level, ...(signals?.length ? { signals } : {}) };
    }),
    segs: [...work.segments.values()].map((s) => ({
      id: s.id,
      a: s.a,
      b: s.b,
      curve: { p0: rel(s.curve.p0), p1: rel(s.curve.p1), p2: rel(s.curve.p2), p3: rel(s.curve.p3) },
      spec: { ...s.spec },
    })),
  };
}

// ---------- Вставка ----------

/**
 * Вставка путей куска (центр — в at, поворот angle) по шагам: clear — снести пути под рамкой, requests —
 * участки куска запросами строителю путей (для проверки и цены), lay — положить их. Шаги на одинаковой
 * сети дают одинаковые номера узлов и участков: план считают на копии сети, строят — тем же кодом на настоящей.
 */
export class RailPaste {
  private readonly place: (p: Vec) => Vec;
  private readonly inside: Inside;
  private readonly box: [number, number, number, number];
  /** Тупики куска, примкнувшие к путям сети: узел куска → узел сети. */
  private readonly joined = new Map<number, number>();
  private reqs: { seg: RailSeg; req: RoadRequest }[] | null = null;

  constructor(
    private readonly net: Network,
    private readonly frag: Fragment,
    at: Vec,
    angle: number,
  ) {
    this.place = placer(at, angle).place;
    const back = placer({ x: 0, y: 0 }, -angle).turn;
    const { half } = frag;
    this.inside = (p) => {
      const q = back(sub(p, at));
      return Math.abs(q.x) <= half.x && Math.abs(q.y) <= half.y;
    };
    const frame = frameOf(frag, at, angle);
    const xs = frame.map((p) => p.x);
    const ys = frame.map((p) => p.y);
    this.box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  private get rail(): RailFragment {
    return this.frag.rail ?? { nodes: [], segs: [] };
  }

  /** Сколько сигналов ставит кусок. */
  get signals(): number {
    return this.rail.nodes.reduce((k, n) => k + (n.signals?.length ?? 0), 0);
  }

  /** Сносит пути под рамкой (задетые краем — режутся по нему); price — цена снесённого куска (за неё возврат). */
  clear(price: (seg: Segment) => number): { reason?: string; refund: number } {
    const [x0, y0, x1, y1] = this.box;
    const hits = this.net
      .segmentsInBox(x0, y0, x1, y1)
      .filter((s) => isRail(s.spec))
      .sort((a, b) => a.id - b.id)
      .map((s) => ({ s, runs: runsInside(s, this.inside) }))
      .filter((h) => h.runs.length);
    // Вокзал под рамкой не сносим.
    for (const { s } of hits) {
      if (s.platform !== undefined || [s.a, s.b].some((id) => this.net.node(id).buildingId !== null && this.inside(this.net.node(id).pos))) {
        return { reason: 'Мешает станция', refund: 0 };
      }
    }
    let refund = 0;
    for (const { s, runs } of hits) {
      cut(this.net, s, runs, (piece) => {
        refund += price(piece);
        this.net.removeSegment(piece.id);
      });
    }
    return { refund };
  }

  /** Участки куска — запросами строителю путей; тупик у конца пути сети (срез под краем рамки) примыкает к нему. */
  requests(): { seg: RailSeg; req: RoadRequest }[] {
    if (this.reqs) return this.reqs;
    const { nodes, segs } = this.rail;
    const degree = new Map<number, number>();
    for (const s of segs) for (const id of [s.a, s.b]) degree.set(id, (degree.get(id) ?? 0) + 1);
    const snapOf = new Map<number, Snap>();
    const used = new Set<number>();
    for (const n of nodes) {
      const pos = this.place(n.pos);
      let snap: Snap = { kind: 'free', pos, level: n.level };
      if (degree.get(n.id) === 1) {
        const near = this.net
          .nodesNear(pos, JOIN)
          .filter((o) => !used.has(o.id) && o.buildingId === null && o.segments.length > 0 && Math.abs(o.level - n.level) < 0.25)
          .sort((a, b) => dist(a.pos, pos) - dist(b.pos, pos) || a.id - b.id)[0];
        if (near) {
          used.add(near.id);
          this.joined.set(n.id, near.id);
          snap = { kind: 'node', nodeId: near.id, pos: { ...near.pos }, level: near.level };
        }
      }
      snapOf.set(n.id, snap);
    }
    this.reqs = segs.map((seg) => {
      const start = snapOf.get(seg.a)!;
      const end = snapOf.get(seg.b)!;
      const c = seg.curve;
      const p0 = this.place(c.p0);
      const p3 = this.place(c.p3);
      // Конец, примкнувший к пути сети, — точно в его узле: перо сдвигается вместе с концом.
      const curve: Cubic = { p0: start.pos, p1: add(this.place(c.p1), sub(start.pos, p0)), p2: add(this.place(c.p2), sub(end.pos, p3)), p3: end.pos };
      return { seg, req: { start, end, spec: seg.spec, mode: 'straight', curve } };
    });
    return this.reqs;
  }

  /** Кладёт участки куска (после clear) со стрелками, высотой и сигналами. Возвращает новые участки. */
  lay(): number[] {
    const reqs = this.requests();
    const nodeOf = new Map<number, number>();
    for (const n of this.rail.nodes) nodeOf.set(n.id, this.joined.get(n.id) ?? this.net.addNode(this.place(n.pos), n.level).id);
    const segOf = new Map<number, number>();
    for (const { seg, req } of reqs) segOf.set(seg.id, this.net.addSegment(nodeOf.get(seg.a)!, nodeOf.get(seg.b)!, req.curve!, seg.spec).id);
    for (const n of this.rail.nodes) {
      const more = (n.signals ?? []).map((id) => segOf.get(id)).filter((id): id is number => id !== undefined);
      if (!more.length) continue;
      const node = this.net.node(nodeOf.get(n.id)!);
      node.signals = [...(node.signals ?? []), ...more];
      this.net.touch(node.id);
    }
    return [...segOf.values()];
  }
}

// ---------- Прилипание ----------

type Axis = { p: Vec; dir: Vec; level: number };
const axes = new WeakMap<Fragment, Axis | null>();

/**
 * Главный путь куска — сквозной: от края рамки до края без поворотов на стрелках (самый длинный такой),
 * а нет сквозного — самый длинный участок. Точка у центра, направление там и высота.
 */
function railAxis(frag: Fragment): Axis | null {
  if (axes.has(frag)) return axes.get(frag)!;
  const rail = frag.rail ?? { nodes: [], segs: [] };
  const luts = new Map(rail.segs.map((s) => [s.id, new CurveLUT(s.curve)]));
  const node = new Map(rail.nodes.map((n) => [n.id, n]));
  const arms = new Map<number, RailSeg[]>();
  for (const s of rail.segs) for (const id of [s.a, s.b]) arms.set(id, [...(arms.get(id) ?? []), s]);
  // Направление участка из узла.
  const out = (s: RailSeg, from: number) => {
    const lut = luts.get(s.id)!;
    const t = s.a === from ? lut.tangentAt(0) : lut.tangentAt(lut.length);
    return s.a === from ? t : { x: -t.x, y: -t.y };
  };
  const onEdge = (id: number) => {
    const p = node.get(id)?.pos;
    return !!p && arms.get(id)?.length === 1 && (Math.abs(Math.abs(p.x) - frag.half.x) < 1 || Math.abs(Math.abs(p.y) - frag.half.y) < 1);
  };
  let best: { segs: RailSeg[]; len: number } | null = null;
  // Из каждого конца у края — вперёд по путям, на стрелке — только плавно (как поедет поезд).
  const walk = (at: number, came: RailSeg, path: RailSeg[], len: number) => {
    const next = at === came.a ? came.b : came.a;
    if (onEdge(next) && (!best || len > best.len)) best = { segs: path, len };
    const dir = out(came, next);
    for (const s of arms.get(next) ?? []) {
      if (s === came || path.includes(s)) continue;
      const d = out(s, next);
      if (d.x * dir.x + d.y * dir.y > -0.85) continue;
      walk(next, s, [...path, s], len + luts.get(s.id)!.length);
    }
  };
  for (const n of rail.nodes) {
    const first = onEdge(n.id) ? arms.get(n.id)![0] : null;
    if (first) walk(n.id, first, [first], luts.get(first.id)!.length);
  }
  const found = best as { segs: RailSeg[]; len: number } | null;
  const longest = rail.segs.reduce<RailSeg | null>((m, x) => (!m || luts.get(x.id)!.length > luts.get(m.id)!.length ? x : m), null);
  const pool = found?.segs ?? (longest ? [longest] : []);
  let axis: Axis | null = null;
  for (const s of pool) {
    const lut = luts.get(s.id)!;
    const hit = lut.closest({ x: 0, y: 0 });
    if (axis && dist(axis.p, { x: 0, y: 0 }) <= hit.d) continue;
    const levels = [node.get(s.a)?.level ?? 0, node.get(s.b)?.level ?? 0];
    axis = { p: hit.point, dir: lut.tangentAt(hit.s), level: (levels[0] + levels[1]) / 2 };
  }
  axes.set(frag, axis);
  return axis;
}

/**
 * Вставка ложится на путь: если у главного пути куска рядом (radius) путь на той же высоте, кусок
 * поворачивается вдоль него (из двух направлений — ближе к angle) и сдвигается на его ось.
 */
export function snapRails(net: Network, frag: Fragment, at: Vec, angle: number, radius: number): { at: Vec; angle: number; snapped: boolean } {
  const axis = railAxis(frag);
  if (!axis) return { at, angle, snapped: false };
  const onAxis = () => placer(at, angle).place(axis.p);
  const q0 = onAxis();
  let host: Segment | null = null;
  let bestD = radius;
  for (const s of net.segmentsNear(q0, radius)) {
    if (!isRail(s.spec) || s.platform !== undefined) continue;
    const hit = s.lut.closest(q0);
    if (hit.d < bestD && Math.abs(net.levelAt(s, hit.s) - axis.level) < 0.25) {
      bestD = hit.d;
      host = s;
    }
  }
  if (!host) return { at, angle, snapped: false };
  // Дважды: на изогнутом пути касательная в новой точке — уже чуть другая.
  for (let k = 0; k < 2; k++) {
    const hit = host.lut.closest(onAxis());
    const base = angleOf(host.lut.tangentAt(hit.s)) - angleOf(axis.dir);
    angle = Math.abs(angleDiff(angle, base)) <= Math.PI / 2 ? base : base + Math.PI;
    const q = onAxis();
    at = add(at, sub(host.lut.closest(q).point, q));
  }
  return { at, angle, snapped: true };
}
