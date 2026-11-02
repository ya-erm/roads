import { MIN_SEGMENT_LEN } from '../config';
import { arcCubic, Cubic, CurveLUT, intersectCurves, minRadius, polylineMinDistance, quadToCubic, splitBezier, straightCubic } from '../core/bezier';
import { add, cross, dist, dot, scale, sub, Vec } from '../core/vec';
import type { Network, RoadNode, Segment } from '../world/network';
import { halfWidth, RAIL_LEVEL_RUN, RAIL_SWITCH_ANGLE, ROAD_CLASSES, RoadSpec, sameSpec, specCost } from '../world/roadTypes';

/**
 * Строитель железной дороги: пути на сети `Network` (автодороги строит `RoadBuilder` на сети полос).
 */

export type DrawMode = 'straight' | 'arc' | 'curve';
/** Что прокладывает инструмент: автодорогу или ж/д путь. */
export type NetKind = 'road' | 'rail';

export type Snap =
  | { kind: 'node'; nodeId: number; pos: Vec; level: number }
  | { kind: 'split'; segId: number; t: number; pos: Vec; level: number }
  | { kind: 'free'; pos: Vec; level: number };

/** То, что строитель знает об игре. Game реализует этот интерфейс. */
export interface BuildContext {
  readonly net: Network;
  /** Сколько можно потратить с учётом кредитного лимита. */
  readonly budget: number;
  isWater(p: Vec, margin?: number): boolean;
  inBounds(p: Vec, margin?: number): boolean;
  /** Строения в точке: id и можно ли снести их ради пути. */
  obstaclesAt(p: Vec, radius: number): { id: number; demolishable: boolean }[];
  demolishCost(id: number): number;
  demolish(ids: number[]): void;
  spend(amount: number): void;
  refund(amount: number): void;
  networkChanged(): void;
  /** Что не так у нового пути (кривая lut, высота levelAt, полуширина hw) с дорогами. */
  roadConflict?(lut: CurveLUT, levelAt: (s: number) => number, hw: number): string | undefined;
}

export interface RoadRequest {
  start: Snap;
  end: Snap;
  spec: RoadSpec;
  mode: DrawMode;
  /** Касательная в начале для режима дуги. */
  tangent?: Vec | null;
  /** Контрольная точка для режима кривой. */
  control?: Vec | null;
  /** Готовая форма (например, S-образный съезд к вокзалу). */
  curve?: Cubic;
  /** Участки и узлы, которые заменяются этим путём, — их не проверяем на пересечения. */
  exclude?: { segs: number[]; nodes: number[] };
}

export interface Crossing {
  segId: number;
  /** Параметр на существующем сегменте. */
  t: number;
  /** Расстояние вдоль нового пути. */
  s: number;
  point: Vec;
}

export interface Plan {
  ok: boolean;
  reason?: string;
  cost: number;
  curve: Cubic | null;
  lut: CurveLUT | null;
  levelA: number;
  levelB: number;
  spec: RoadSpec;
  crossings: Crossing[];
  /** Здания, которые придётся снести (их цена уже в cost). */
  demolish: number[];
}

/** Множитель цены в точке: мосты, эстакады и тоннели дороже земли. */
function structureFactor(h: number, water: boolean): number {
  if (water && h > -0.5) return 4;
  if (h > 0.25) return 1 + 1.5 * Math.min(h, 1) + 0.6 * Math.max(0, h - 1);
  if (h < -0.25) return 1 + 3 * Math.min(-h, 1) + (water ? 1 : 0);
  return 1;
}

export class Builder {
  constructor(private readonly ctx: BuildContext) {}

  private get net(): Network {
    return this.ctx.net;
  }

  /** Привязка к узлу или участку пути; платформы вокзалов и подъезды не разрезаются. */
  snap(p: Vec, level: number, radius: number, exclude?: RoadRequest['exclude']): Snap {
    const skipNodes = new Set(exclude?.nodes ?? []);
    const skipSegs = new Set(exclude?.segs ?? []);
    const node = this.net.findNodeNear(p, radius, (n) => !skipNodes.has(n.id) && n.buildingId === null && n.segments.every((id) => this.net.isRailSeg(id)));
    if (node) return { kind: 'node', nodeId: node.id, pos: node.pos, level: node.level };
    const hit = this.net.findSegmentNear(p, radius * 0.3, (s) => !skipSegs.has(s.id) && s.platform === undefined && this.net.isFlat(s) && this.net.isRailSeg(s.id));
    if (hit) {
      const s = hit.seg;
      // Конец отрезка у исключённого узла привязывать некуда — разрезаем ближе к середине.
      if (hit.s < MIN_SEGMENT_LEN) return skipNodes.has(s.a) ? { kind: 'free', pos: { ...p }, level } : this.nodeSnap(s.a);
      if (s.length - hit.s < MIN_SEGMENT_LEN) return skipNodes.has(s.b) ? { kind: 'free', pos: { ...p }, level } : this.nodeSnap(s.b);
      return { kind: 'split', segId: s.id, t: hit.t, pos: hit.point, level: this.net.node(s.a).level };
    }
    return { kind: 'free', pos: { ...p }, level };
  }

  private nodeSnap(id: number): Snap {
    const n = this.net.node(id);
    return { kind: 'node', nodeId: id, pos: n.pos, level: n.level };
  }

  /** Касательная для продолжения пути из тупика. */
  continuationTangent(s: Snap): Vec | null {
    if (s.kind !== 'node') return null;
    const n = this.net.node(s.nodeId);
    if (n.segments.length !== 1) return null;
    return scale(this.net.dirFrom(n.id, n.segments[0]), -1);
  }

  /** Направление, в котором путь должен прийти в тупик, чтобы гладко продолжить его. */
  arrivalTangent(s: Snap): Vec | null {
    if (s.kind !== 'node') return null;
    const n = this.net.node(s.nodeId);
    if (n.segments.length !== 1) return null;
    return this.net.dirFrom(n.id, n.segments[0]);
  }

  /** Для стрелки: касательная пути в точке разреза, повёрнутая к точке toward. */
  private switchTangent(s: Snap, toward: Vec): Vec | null {
    if (s.kind !== 'split' || !this.net.isRailSeg(s.segId)) return null;
    const seg = this.net.segment(s.segId);
    const t = seg.lut.tangentAt(seg.lut.sAtT(s.t));
    return dot(t, sub(toward, s.pos)) >= 0 ? t : scale(t, -1);
  }

  buildCurve(req: RoadRequest): Cubic | null {
    const a = req.start.pos;
    const b = req.end.pos;
    if (req.curve) return req.curve;
    if (req.mode === 'curve' && req.control) return quadToCubic(a, req.control, b);
    if (req.mode === 'arc') {
      // Ответвление от пути начинается по касательной — так получается стрелка.
      const tA = req.tangent ?? this.switchTangent(req.start, b);
      const chord = dist(a, b);
      // Если тупик смотрит в другую сторону, гладко не подключить — обычная дуга.
      const intoSwitch = this.switchTangent(req.end, a);
      const arrival = this.arrivalTangent(req.end) ?? (intoSwitch && scale(intoSwitch, -1));
      const tB = arrival && dot(arrival, sub(b, a)) > chord * 0.2 ? arrival : null;
      if (tA && tB) {
        // Гладко с обеих сторон: касательные и в начале, и в конце.
        const h = chord * 0.4;
        return { p0: a, p1: add(a, scale(tA, h)), p2: sub(b, scale(tB, h)), p3: b };
      }
      if (tA) return arcCubic(a, tA, b);
      if (tB) {
        // Дуга, гладко входящая в существующий путь: строим её от конца и разворачиваем.
        const rev = arcCubic(b, scale(tB, -1), a);
        return rev && { p0: rev.p3, p1: rev.p2, p2: rev.p1, p3: rev.p0 };
      }
    }
    return straightCubic(a, b);
  }

  plan(req: RoadRequest): Plan {
    const { start, end, spec } = req;
    const levelA = start.level;
    const levelB = end.level;
    const base: Plan = { ok: false, cost: 0, curve: null, lut: null, levelA, levelB, spec, crossings: [], demolish: [] };
    const curve = this.buildCurve(req);
    if (!curve) return { ...base, reason: 'Слишком крутой поворот' };
    const lut = new CurveLUT(curve);
    const length = lut.length;
    const withGeom: Plan = { ...base, curve, lut };
    const fail = (reason: string, cost = withGeom.cost): Plan => ({ ...withGeom, reason, cost });
    const hw = halfWidth(spec);
    const levelAt = (s: number) => levelA + (levelB - levelA) * (s / length);

    // Цена считается заранее, чтобы показывать её даже для недопустимого пути.
    const step = 4;
    const samples = Math.max(2, Math.ceil(length / step));
    let cost = 0;
    const pts: { p: Vec; h: number; wet: boolean }[] = [];
    for (let i = 0; i <= samples; i++) {
      const s = (length * i) / samples;
      const p = lut.pointAt(s);
      const h = levelAt(s);
      const wet = this.ctx.isWater(p, 2);
      pts.push({ p, h, wet });
      if (i > 0) cost += (length / samples) * specCost(spec) * structureFactor(h, wet);
    }
    withGeom.cost = Math.round(cost);

    if (length < MIN_SEGMENT_LEN) return fail('Слишком коротко');
    if (start.kind === 'node' && end.kind === 'node') {
      if (start.nodeId === end.nodeId) return fail('Слишком коротко');
      // Заменяемый участок (exclude) — не дубль: его форму и меняем.
      const twin = this.net.segmentBetween(start.nodeId, end.nodeId);
      if (twin && !req.exclude?.segs.includes(twin.id)) return fail('Путь уже есть');
    }
    if (start.kind === 'split' && end.kind === 'split' && start.segId === end.segId) return fail('Путь уже есть');
    if (pts.some((x) => !this.ctx.inBounds(x.p, hw))) return fail('За краем карты');
    if (minRadius(curve) < ROAD_CLASSES[spec.cls].minRadius) return fail('Слишком крутой поворот');
    if (Math.abs(levelA - levelB) > 2) return fail('Слишком большой перепад');
    if (Math.abs(levelA - levelB) * RAIL_LEVEL_RUN > length) return fail('Слишком крутой подъём');
    for (const s of [start, end]) {
      if (s.kind === 'free' && s.level === 0 && this.ctx.isWater(s.pos, hw * 0.5)) return fail('Опора в воде — нужен мост');
    }
    // Дома на пути сносятся за доплату; предприятия и станции не сносятся.
    const demolish = new Set<number>();
    for (const x of pts) {
      if (x.wet && x.h < -0.25 && x.h > -0.75) return fail('Въезд в тоннель в воде');
      if (x.h <= -0.75) continue;
      for (const ob of this.ctx.obstaclesAt(x.p, hw)) {
        if (!ob.demolishable) return fail('Мешает предприятие или станция');
        if (!demolish.has(ob.id)) {
          demolish.add(ob.id);
          withGeom.cost += this.ctx.demolishCost(ob.id);
        }
      }
    }
    withGeom.demolish = [...demolish];

    const endpointNodes = new Set<number>(req.exclude?.nodes ?? []);
    const ignoreSegs = new Set<number>(req.exclude?.segs ?? []);
    for (const s of [start, end]) {
      if (s.kind === 'node') endpointNodes.add(s.nodeId);
      if (s.kind === 'split') ignoreSegs.add(s.segId);
    }

    // Примыкание к путям: продолжение или стрелка — поезд не повернёт под большим углом.
    const tStart = lut.tangentAt(0);
    const tEnd = scale(lut.tangentAt(length), -1);
    for (const [s, out] of [
      [start, tStart],
      [end, tEnd],
    ] as const) {
      if (s.kind === 'node') {
        // Переносимый участок (exclude) не в счёт: новый заменит его.
        const segs = this.net.node(s.nodeId).segments.filter((sid) => !ignoreSegs.has(sid));
        for (const sid of segs) {
          const angle = Math.acos(Math.max(-1, Math.min(1, dot(this.net.dirFrom(s.nodeId, sid), out))));
          if (angle < 0.12) return fail('Слишком острый угол');
        }
        if (segs.length && !segs.some((sid) => dot(this.net.dirFrom(s.nodeId, sid), out) < -Math.cos(RAIL_SWITCH_ANGLE))) {
          return fail('Путь примыкает только плавно, как стрелка');
        }
      } else if (s.kind === 'split') {
        const seg = this.net.segment(s.segId);
        const segDir = seg.lut.tangentAt(seg.lut.sAtT(s.t));
        if (Math.abs(cross(segDir, out)) > Math.sin(RAIL_SWITCH_ANGLE)) return fail('Путь примыкает только плавно, как стрелка');
      }
    }

    // Пересечения («крестовины») и близость к другим путям.
    const crossings: Crossing[] = [];
    const pad = hw + 40;
    const box = {
      x0: Math.min(curve.p0.x, curve.p1.x, curve.p2.x, curve.p3.x) - pad,
      y0: Math.min(curve.p0.y, curve.p1.y, curve.p2.y, curve.p3.y) - pad,
      x1: Math.max(curve.p0.x, curve.p1.x, curve.p2.x, curve.p3.x) + pad,
      y1: Math.max(curve.p0.y, curve.p1.y, curve.p2.y, curve.p3.y) + pad,
    };
    for (const seg of this.net.segmentsInBox(box.x0, box.y0, box.x1, box.y1)) {
      if (ignoreSegs.has(seg.id)) continue;
      const adjacent = endpointNodes.has(seg.a) || endpointNodes.has(seg.b);
      const hwOld = halfWidth(seg.spec);
      const hits = adjacent ? [] : intersectCurves(lut, seg.lut);
      for (const hit of hits) {
        const dh = Math.abs(levelAt(hit.s1) - this.net.levelAt(seg, hit.s2));
        if (dh >= 0.75) continue;
        if (dh >= 0.3) return fail('Мало места по высоте');
        if (levelA !== levelB || !this.net.isFlat(seg)) return fail('Пересечение на подъёме');
        if (seg.platform !== undefined) return fail('Нельзя пересекать платформу');
        // Пересечение — узел на обоих путях: под пологим углом (меньше угла стрелки) поезда переходят с пути
        // на путь, как по стрелке (так пристыковывают путь к соседнему); круче — просто «крестовина».
        const sin = Math.abs(cross(seg.lut.tangentAt(hit.s2), lut.tangentAt(hit.s1)));
        if (sin < Math.sin(0.12)) return fail('Пути пересекаются слишком остро');
        if (hit.s2 < MIN_SEGMENT_LEN || seg.length - hit.s2 < MIN_SEGMENT_LEN) return fail('Слишком близко к стрелке');
        crossings.push({ segId: seg.id, t: hit.t2, s: hit.s1, point: hit.point });
      }
      if (hits.length || adjacent) continue;
      // Параллельные пути на той же высоте не должны слипаться.
      const la = this.net.node(seg.a).level;
      const lb = this.net.node(seg.b).level;
      const overlap = Math.min(levelA, levelB) - 0.5 < Math.max(la, lb) && Math.max(levelA, levelB) + 0.5 > Math.min(la, lb);
      if (!overlap) continue;
      const c = seg.curve;
      const reach = hw + hwOld + 4;
      if (Math.max(c.p0.x, c.p1.x, c.p2.x, c.p3.x) + reach < Math.min(curve.p0.x, curve.p1.x, curve.p2.x, curve.p3.x)) continue;
      if (Math.min(c.p0.x, c.p1.x, c.p2.x, c.p3.x) - reach > Math.max(curve.p0.x, curve.p1.x, curve.p2.x, curve.p3.x)) continue;
      if (Math.max(c.p0.y, c.p1.y, c.p2.y, c.p3.y) + reach < Math.min(curve.p0.y, curve.p1.y, curve.p2.y, curve.p3.y)) continue;
      if (Math.min(c.p0.y, c.p1.y, c.p2.y, c.p3.y) - reach > Math.max(curve.p0.y, curve.p1.y, curve.p2.y, curve.p3.y)) continue;
      if (polylineMinDistance(lut.points, seg.lut.points) < (hw + hwOld) * 0.85) return fail('Слишком близко к пути');
    }
    const boxCenter = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
    for (const n of this.net.nodesNear(boxCenter, Math.hypot(box.x1 - box.x0, box.y1 - box.y0) / 2)) {
      if (endpointNodes.has(n.id)) continue;
      const near = lut.closest(n.pos);
      if (near.d < hw + 3 && Math.abs(levelAt(near.s) - n.level) < 0.75) return fail('Проходит через узел');
    }
    crossings.sort((x, y) => x.s - y.s);
    const marks = [0, ...crossings.map((c) => c.s), length];
    for (let i = 1; i < marks.length; i++) {
      if (marks[i] - marks[i - 1] < MIN_SEGMENT_LEN) return fail('Слишком близко к стрелке');
    }
    // Дороги — в своей сети: путь пересекает их переездом, мостом или тоннелем.
    const road = this.ctx.roadConflict?.(lut, levelAt, hw);
    if (road) return fail(road);
    if (withGeom.cost > this.ctx.budget) return { ...fail('Не хватает денег'), crossings };
    return { ...withGeom, ok: true, crossings };
  }

  private resolve(s: Snap): number {
    if (s.kind === 'node') return s.nodeId;
    if (s.kind === 'split') return this.net.splitSegment(s.segId, s.t).id;
    return this.net.addNode(s.pos, s.level).id;
  }

  /** Строит путь. Возвращает конечный узел и касательную для продолжения. */
  build(req: RoadRequest): { endNode: number; tangent: Vec } | null {
    const plan = this.plan(req);
    if (!plan.ok || !plan.curve || !plan.lut) return null;

    // Делим пересекаемые сегменты; один сегмент может пересекаться несколько раз.
    const bySeg = new Map<number, Crossing[]>();
    for (const c of plan.crossings) {
      if (!bySeg.has(c.segId)) bySeg.set(c.segId, []);
      bySeg.get(c.segId)!.push(c);
    }
    if (plan.demolish.length) this.ctx.demolish(plan.demolish);
    const nodeAt = new Map<Crossing, RoadNode>();
    for (const [segId, list] of bySeg) {
      list.sort((x, y) => y.t - x.t);
      let current = segId;
      let scaleT = 1;
      for (const c of list) {
        const res = this.net.splitSegmentDetailed(current, c.t / scaleT);
        nodeAt.set(c, res.node);
        current = res.first.id;
        scaleT = c.t;
      }
    }
    const a = this.resolve(req.start);
    const b = this.resolve(req.end);
    const chain = [a, ...plan.crossings.map((c) => nodeAt.get(c)!.id), b];

    // Делим новую кривую в точках пересечений.
    const pieces: Cubic[] = [];
    let rest = plan.curve;
    let consumed = 0;
    for (const c of plan.crossings) {
      const t = plan.lut.tAt(c.s);
      const local = (t - consumed) / (1 - consumed);
      const [p1, p2] = splitBezier(rest, local);
      pieces.push(p1);
      rest = p2;
      consumed = t;
    }
    pieces.push(rest);
    let last: Cubic = pieces[0];
    for (let i = 0; i < pieces.length; i++) {
      const from = this.net.node(chain[i]).pos;
      const to = this.net.node(chain[i + 1]).pos;
      const p = pieces[i];
      const fixed: Cubic = {
        p0: from,
        p1: add(p.p1, sub(from, p.p0)),
        p2: add(p.p2, sub(to, p.p3)),
        p3: to,
      };
      this.net.addSegment(chain[i], chain[i + 1], fixed, req.spec);
      last = fixed;
    }
    this.ctx.spend(plan.cost);
    this.ctx.networkChanged();
    const lut = new CurveLUT(last);
    return { endNode: b, tangent: lut.tangentAt(lut.length) };
  }

  segmentCost(seg: Segment): number {
    let cost = 0;
    const n = Math.max(2, Math.ceil(seg.length / 6));
    for (let i = 1; i <= n; i++) {
      const s = (seg.length * (i - 0.5)) / n;
      const p = seg.lut.pointAt(s);
      cost += (seg.length / n) * specCost(seg.spec) * structureFactor(this.net.levelAt(seg, s), this.ctx.isWater(p, 2));
    }
    return Math.round(cost);
  }

  pickSegment(p: Vec, radius = 4): Segment | null {
    let best: Segment | null = null;
    let bestScore = Infinity;
    for (const seg of this.net.segmentsNear(p, radius + 40)) {
      const hit = seg.lut.closest(p);
      if (hit.d > halfWidth(seg.spec) + radius) continue;
      // Верхние уровни перекрывают нижние.
      const score = hit.d - this.net.levelAt(seg, hit.s) * 100;
      if (score < bestScore) {
        bestScore = score;
        best = seg;
      }
    }
    return best;
  }

  bulldoze(p: Vec, radius = 4): boolean {
    const seg = this.pickSegment(p, radius);
    return !!seg && this.bulldozeSegments([seg.id]) > 0;
  }

  /** Сносит участки по списку (платформы — только вместе с вокзалом); лишние узлы потом сливаются. */
  bulldozeSegments(ids: number[]): number {
    const ends = new Set<number>();
    let removed = 0;
    for (const id of ids) {
      const seg = this.net.segments.get(id);
      if (!seg || seg.platform !== undefined) continue;
      ends.add(seg.a);
      ends.add(seg.b);
      this.ctx.refund(this.segmentCost(seg));
      this.net.removeSegment(seg.id);
      removed++;
    }
    for (const id of ends) this.tryMerge(id);
    if (removed) this.ctx.networkChanged();
    return removed;
  }

  /** Сливает два прямых соосных участка, если узел между ними стал лишним. */
  private tryMerge(nodeId: number): void {
    const n = this.net.nodes.get(nodeId);
    // Узел с сигналом — граница блока, его не сливаем.
    if (!n || n.segments.length !== 2 || n.buildingId !== null || n.signals?.length) return;
    const [s1, s2] = n.segments.map((id) => this.net.segment(id));
    if (!sameSpec(s1.spec, s2.spec) || s1.platform !== undefined || s2.platform !== undefined) return;
    if (!this.net.isFlat(s1) || !this.net.isFlat(s2)) return;
    const isStraight = (s: Segment) => minRadius(s.curve) > 1e5;
    if (!isStraight(s1) || !isStraight(s2)) return;
    if (dot(this.net.dirFrom(n.id, s1.id), this.net.dirFrom(n.id, s2.id)) > -0.9995) return;
    const a = s1.a === n.id ? s1.b : s1.a;
    const b = s2.a === n.id ? s2.b : s2.a;
    if (this.net.segmentBetween(a, b)) return;
    this.net.removeSegment(s1.id, false);
    this.net.removeSegment(s2.id, false);
    this.net.deleteNode(n.id);
    this.net.addSegment(a, b, straightCubic(this.net.node(a).pos, this.net.node(b).pos), s1.spec);
  }
}
