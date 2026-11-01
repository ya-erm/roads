import { COST, MIN_SEGMENT_LEN } from '../config';
import {
  arcCubic,
  circleArc,
  Cubic,
  CurveLUT,
  intersectCurves,
  minRadius,
  polylineMinDistance,
  quadToCubic,
  reverseCubic,
  splitBezier,
  straightCubic,
} from '../core/bezier';
import { add, angleOf, closestOnSegment, cross, dist, dot, norm, scale, sub, Vec } from '../core/vec';
import type { Traffic } from '../sim/traffic';
import type { Network, RoadNode, Segment } from '../world/network';
import {
  halfWidth,
  isDivided,
  isOneWay,
  isRail,
  LANE_W,
  LEVEL_RUN,
  RAIL_LEVEL_RUN,
  RAIL_SWITCH_ANGLE,
  ROAD_CLASSES,
  RoadSpec,
  sameSpec,
  specCost,
  specKmh,
} from '../world/roadTypes';

export type DrawMode = 'straight' | 'arc' | 'curve';
/** Что строим: автодорогу или железнодорожный путь. */
export type NetKind = 'road' | 'rail';

export type Snap =
  | { kind: 'node'; nodeId: number; pos: Vec; level: number }
  | { kind: 'split'; segId: number; t: number; pos: Vec; level: number }
  | { kind: 'free'; pos: Vec; level: number };

/** То, что строитель знает об игре. Game реализует этот интерфейс. */
export interface BuildContext {
  readonly net: Network;
  readonly traffic: Traffic;
  /** Сколько можно потратить с учётом кредитного лимита. */
  readonly budget: number;
  readonly roundaboutCenters: Map<number, Vec>;
  isWater(p: Vec, margin?: number): boolean;
  inBounds(p: Vec, margin?: number): boolean;
  /** Занята ли точка зданием (с запасом radius). */
  blocked(p: Vec, radius: number): boolean;
  /** Строения в точке: id и можно ли снести их ради дороги. */
  obstaclesAt(p: Vec, radius: number): { id: number; demolishable: boolean }[];
  demolishCost(id: number): number;
  demolish(ids: number[]): void;
  spend(amount: number): void;
  refund(amount: number): void;
  networkChanged(): void;
  /** Дорогу перестроили (могла стать шире): дома, на которые она налезла, отодвинуть. */
  roadWidened?(segId: number): void;
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
  /** Участки и узлы, которые заменяются этой дорогой, — их не проверяем на пересечения. */
  exclude?: { segs: number[]; nodes: number[] };
}

export interface Crossing {
  segId: number;
  /** Параметр на существующем сегменте. */
  t: number;
  /** Расстояние вдоль новой дороги. */
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

/** Перенос узла: новые формы всех его участков и итог по деньгам. */
export interface NodeMovePlan {
  ok: boolean;
  reason?: string;
  /** Итог для игрока: новая дорога и снос минус возврат за старые участки (меньше нуля — вернут деньги). */
  cost: number;
  /** Сколько потратим на новую дорогу и снос. */
  spend: number;
  /** Цена старых участков: вернётся её доля, как при сносе. */
  refund: number;
  /** id участков узла и их новые формы (plans[i] — для segs[i]); недопустимые — красным в предпросмотре. */
  segs: number[];
  plans: Plan[];
  demolish: number[];
}

const MIN_JOIN_ANGLE = 0.25;
/** Съезд (односторонняя дорога) примыкает почти по касательной: островок со штриховкой нарисует рендер. */
const RAMP_JOIN_ANGLE = 0.035;

/** Прямой участок: при переносе узла остаётся прямым. */
const isStraightCurve = (c: Cubic) => minRadius(c) > 1e5;

/** Размер кольца: радиус оси (если примыкающие дороги шире, кольцо будет больше). */
export type RingSize = 'small' | 'medium' | 'large';
export const RING_SIZES: Record<RingSize, number> = { small: 30, medium: 46, large: 66 };

export interface RingOptions {
  lanes: number;
  size: RingSize;
}

export const DEFAULT_RING: RingOptions = { lanes: 1, size: 'small' };
/** Замена знака ограничения скорости на участке. */
const SIGN_COST = 400;

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

  /**
   * Привязка к узлу или сегменту. Дороги цепляются только к дорогам, рельсы — к рельсам;
   * платформы вокзалов и кольца разрезать нельзя.
   */
  snap(p: Vec, level: number, radius: number, kind: NetKind = 'road', exclude?: RoadRequest['exclude']): Snap {
    const rail = kind === 'rail';
    const skipNodes = new Set(exclude?.nodes ?? []);
    const skipSegs = new Set(exclude?.segs ?? []);
    const node = this.net.findNodeNear(
      p,
      radius,
      (n) =>
        !skipNodes.has(n.id) &&
        (rail
          ? n.buildingId === null && n.segments.every((id) => this.net.isRailSeg(id))
          : n.segments.every((id) => !this.net.isRailSeg(id))),
    );
    if (node) return { kind: 'node', nodeId: node.id, pos: node.pos, level: node.level };
    const hit = this.net.findSegmentNear(
      p,
      radius * 0.3,
      (s) => !skipSegs.has(s.id) && !s.ring && s.platform === undefined && this.net.isFlat(s) && isRail(s.spec) === rail,
    );
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

  /** Касательная для продолжения дороги из тупика. */
  continuationTangent(s: Snap): Vec | null {
    if (s.kind !== 'node') return null;
    const n = this.net.node(s.nodeId);
    if (n.segments.length !== 1) return null;
    return scale(this.net.dirFrom(n.id, n.segments[0]), -1);
  }

  /** Направление, в котором дорога должна прийти в тупик, чтобы гладко продолжить его. */
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
        // Дуга, гладко входящая в существующую дорогу: строим её от конца и разворачиваем.
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

    // Цена считается заранее, чтобы показывать её даже для недопустимой дороги.
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
      if (twin && !req.exclude?.segs.includes(twin.id)) return fail('Дорога уже есть');
    }
    if (start.kind === 'split' && end.kind === 'split' && start.segId === end.segId) return fail('Дорога уже есть');
    if (pts.some((x) => !this.ctx.inBounds(x.p, hw))) return fail('За краем карты');
    const rail = isRail(spec);
    if (minRadius(curve) < ROAD_CLASSES[spec.cls].minRadius) return fail('Слишком крутой поворот');
    if (Math.abs(levelA - levelB) > 2) return fail('Слишком большой перепад');
    if (Math.abs(levelA - levelB) * (rail ? RAIL_LEVEL_RUN : LEVEL_RUN) > length) return fail('Слишком крутой подъём');
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

    // Углы примыкания к существующим дорогам.
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
          const d = this.net.dirFrom(s.nodeId, sid);
          const angle = Math.acos(Math.max(-1, Math.min(1, dot(d, out))));
          // Съезд (односторонняя) может отходить от дороги почти по касательной — как настоящий.
          const ramp = isOneWay(spec) || isOneWay(this.net.segment(sid).spec);
          if (angle < (rail ? 0.12 : ramp ? RAMP_JOIN_ANGLE : MIN_JOIN_ANGLE)) return fail('Слишком острый угол');
        }
        // Рельсы продолжают путь или отходят стрелкой — поезд не повернёт под большим углом.
        if (rail && segs.length && !segs.some((sid) => dot(this.net.dirFrom(s.nodeId, sid), out) < -Math.cos(RAIL_SWITCH_ANGLE))) {
          return fail('Путь примыкает только плавно, как стрелка');
        }
      } else if (s.kind === 'split') {
        const seg = this.net.segment(s.segId);
        const segDir = seg.lut.tangentAt(seg.lut.sAtT(s.t));
        const sin = Math.abs(cross(segDir, out));
        if (rail) {
          if (sin > Math.sin(RAIL_SWITCH_ANGLE)) return fail('Путь примыкает только плавно, как стрелка');
        } else if (sin < Math.sin(isOneWay(spec) ? RAMP_JOIN_ANGLE : MIN_JOIN_ANGLE)) return fail('Слишком острый угол');
      }
    }

    // Пересечения и близость к другим дорогам.
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
        const hNew = levelAt(hit.s1);
        const hOld = this.net.levelAt(seg, hit.s2);
        const dh = Math.abs(hNew - hOld);
        if (dh >= 0.75) continue;
        if (dh >= 0.3) return fail('Мало места по высоте');
        if (isDivided(spec) || isDivided(seg.spec)) return fail('Автомагистраль пересекается только мостом или тоннелем');
        if (levelA !== levelB || !this.net.isFlat(seg)) return fail('Перекрёсток на подъёме');
        if (seg.ring) return fail('Нельзя пересекать кольцо');
        if (seg.platform !== undefined) return fail('Нельзя пересекать платформу');
        const dOld = seg.lut.tangentAt(hit.s2);
        const dNew = lut.tangentAt(hit.s1);
        const sin = Math.abs(cross(dOld, dNew));
        // Пересечения с рельсами (переезды и «крестовины») — только под заметным углом.
        const withRail = rail || isRail(seg.spec);
        if (withRail && sin < 0.5) return fail(rail && isRail(seg.spec) ? 'Пути пересекаются слишком остро' : 'Переезд только под углом от 30°');
        if (sin < Math.sin(MIN_JOIN_ANGLE)) return fail('Слишком острый угол');
        if (hit.s2 < MIN_SEGMENT_LEN || seg.length - hit.s2 < MIN_SEGMENT_LEN) return fail('Слишком близко к перекрёстку');
        crossings.push({ segId: seg.id, t: hit.t2, s: hit.s1, point: hit.point });
      }
      if (hits.length || adjacent) continue;
      // Параллельные дороги на той же высоте не должны слипаться.
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
      if (polylineMinDistance(lut.points, seg.lut.points) < (hw + hwOld) * 0.85) return fail('Слишком близко к дороге');
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
      if (marks[i] - marks[i - 1] < MIN_SEGMENT_LEN) return fail('Слишком близко к перекрёстку');
    }
    if (withGeom.cost > this.ctx.budget) return { ...fail('Не хватает денег'), crossings };
    return { ...withGeom, ok: true, crossings };
  }

  private resolve(s: Snap): number {
    if (s.kind === 'node') return s.nodeId;
    if (s.kind === 'split') return this.net.splitSegment(s.segId, s.t).id;
    return this.net.addNode(s.pos, s.level).id;
  }

  /** Строит дорогу. Возвращает конечный узел и касательную для продолжения. */
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

  // ---------- Перенос конца участка ----------

  /** Тупик, за который можно взять участок: узел с одним участком, не подъезд и не кольцо. */
  pickDeadEnd(p: Vec, radius: number, kind: NetKind = 'road'): RoadNode | null {
    return this.net.findNodeNear(p, radius, (n) => this.isDeadEnd(n, kind));
  }

  private isDeadEnd(n: RoadNode, kind: NetKind): boolean {
    if (n.segments.length !== 1 || n.buildingId !== null || n.roundabout !== null) return false;
    const s = this.net.segment(n.segments[0]);
    return isRail(s.spec) === (kind === 'rail') && !s.ring && s.platform === undefined;
  }

  /**
   * Участок от его второго конца до новой точки: та же дорога, по касательной
   * к прежнему направлению, если второй конец продолжает другую дорогу.
   */
  moveEndRequest(nodeId: number, target: Snap): RoadRequest | null {
    const n = this.net.nodes.get(nodeId);
    if (!n || n.segments.length !== 1) return null;
    const s = this.net.segment(n.segments[0]);
    const otherId = s.a === nodeId ? s.b : s.a;
    const other = this.net.node(otherId);
    // Направление полос сохраняем: от второго конца к тупику.
    const spec = s.a === otherId ? s.spec : { ...s.spec, lanesF: s.spec.lanesB, lanesB: s.spec.lanesF };
    const keepsGoing = other.segments.length > 1;
    return {
      start: { kind: 'node', nodeId: otherId, pos: other.pos, level: other.level },
      end: target,
      spec,
      mode: 'arc',
      tangent: keepsGoing ? this.net.dirFrom(otherId, s.id) : null,
      exclude: { segs: [s.id], nodes: [nodeId] },
    };
  }

  /** Переносит конец участка: строит новый участок и сносит старый. */
  moveEnd(nodeId: number, target: Snap): boolean {
    const req = this.moveEndRequest(nodeId, target);
    if (!req) return false;
    const old = this.net.segment(this.net.node(nodeId).segments[0]);
    const plan = this.plan(req);
    if (!plan.ok) return false;
    const oldCost = this.segmentCost(old);
    const spec = old.spec;
    const curve = old.curve;
    const [a, b] = [old.a, old.b];
    this.ctx.traffic.evictSegment(old.id);
    // Узлы не удаляем: второй конец — начало нового участка.
    this.net.removeSegment(old.id, false);
    if (!this.build(req)) {
      // Не вышло (например, не хватило денег на снос) — возвращаем прежний участок.
      this.net.addSegment(a, b, curve, spec);
      this.ctx.networkChanged();
      return false;
    }
    const n = this.net.nodes.get(nodeId);
    if (n && n.segments.length === 0 && n.buildingId === null) this.net.deleteNode(nodeId);
    this.ctx.refund(oldCost);
    this.ctx.networkChanged();
    return true;
  }

  // ---------- Перенос узла ----------

  /** Что можно взять в режиме «Двигать»: тупик (тянется его участок) или узел (тянутся все его дороги). */
  pickMovable(p: Vec, radius: number): RoadNode | null {
    return this.net.findNodeNear(p, radius, (n) => this.isDeadEnd(n, 'road') || this.canMoveNode(n));
  }

  /**
   * Узел, который можно передвинуть вместе с дорогами: изгиб или перекрёсток автодорог.
   * Подъезды зданий и станций, кольца, переезды и пути стоят на месте.
   */
  canMoveNode(n: RoadNode): boolean {
    if (n.segments.length < 2 || n.buildingId !== null || n.roundabout !== null) return false;
    return n.segments.every((id) => {
      const s = this.net.segment(id);
      return !isRail(s.spec) && !s.ring && s.platform === undefined;
    });
  }

  /**
   * Подтягивает точку переноса на прямую между дальними концами двух прямых дорог узла,
   * если курсор рядом: так изгиб легко выпрямить. На перекрёстке — только почти встречные дороги.
   */
  alignNode(nodeId: number, p: Vec, radius: number): Vec {
    const n = this.net.nodes.get(nodeId);
    if (!n || n.segments.length < 2) return p;
    const segs = n.segments.map((id) => this.net.segment(id)).filter((s) => isStraightCurve(s.curve));
    const farPos = (s: Segment) => this.net.node(s.a === n.id ? s.b : s.a).pos;
    let best = p;
    let bestD = radius;
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (n.segments.length > 2 && dot(this.net.dirFrom(n.id, segs[i].id), this.net.dirFrom(n.id, segs[j].id)) > -0.5) continue;
        const hit = closestOnSegment(p, farPos(segs[i]), farPos(segs[j]));
        if (hit.t > 0.05 && hit.t < 0.95 && hit.d < bestD) {
          bestD = hit.d;
          best = hit.point;
        }
      }
    }
    return best;
  }

  /**
   * Формы участков узла, перенесённого в точку to. Прямые остаются прямыми. У кривой дальний
   * конец и касательная там не меняются, а у узла остаётся прежнее направление — или она
   * продолжает прямую, с которой шла гладко. Ручки растягиваются вместе с хордой.
   */
  private movedCurves(n: RoadNode, to: Vec): Map<number, Cubic> {
    const segs = n.segments.map((id) => this.net.segment(id));
    const farPos = (s: Segment) => this.net.node(s.a === n.id ? s.b : s.a).pos;
    const straight = new Set(segs.filter((s) => isStraightCurve(s.curve)).map((s) => s.id));
    const oldDir = new Map(segs.map((s) => [s.id, this.net.dirFrom(n.id, s.id)]));
    const result = new Map<number, Cubic>();
    for (const s of segs) {
      const far = farPos(s);
      if (straight.has(s.id)) {
        result.set(s.id, s.a === n.id ? straightCubic(to, far) : straightCubic(far, to));
        continue;
      }
      // Кривая от дальнего конца к узлу.
      const c = s.b === n.id ? s.curve : reverseCubic(s.curve);
      let u = oldDir.get(s.id)!;
      const partner = segs.find((o) => straight.has(o.id) && dot(oldDir.get(o.id)!, u) < -0.98);
      if (partner) u = norm(sub(to, farPos(partner)));
      const k = dist(far, to) / Math.max(1e-6, dist(far, n.pos));
      let q: Cubic = {
        p0: far,
        p1: add(far, scale(sub(c.p1, c.p0), k)),
        p2: add(to, scale(u, dist(c.p2, c.p3) * k)),
        p3: to,
      };
      // Узел утащили далеко и кривая заломилась — дуга от дальнего конца по его касательной.
      const minR = ROAD_CLASSES[s.spec.cls].minRadius;
      if (minRadius(q) < minR) {
        const arc = arcCubic(far, norm(sub(c.p1, c.p0)), to);
        if (arc && minRadius(arc) >= minR) q = arc;
      }
      result.set(s.id, s.b === n.id ? q : reverseCubic(q));
    }
    return result;
  }

  /** Можно ли перенести узел в точку to: каждая его дорога проверяется как новая, всё или ничего. */
  moveNodePlan(nodeId: number, target: Vec): NodeMovePlan {
    const res: NodeMovePlan = { ok: false, cost: 0, spend: 0, refund: 0, segs: [], plans: [], demolish: [] };
    const n = this.net.nodes.get(nodeId);
    if (!n || !this.canMoveNode(n)) return { ...res, reason: 'Этот узел не двигается' };
    const to = { ...target };
    // Сам узел и его старые участки заменяются — их не проверяем.
    const exclude = { segs: [...n.segments], nodes: [n.id] };
    const moved: Snap = { kind: 'free', pos: to, level: n.level };
    const demolish = new Set<number>();
    let reason: string | undefined;
    for (const [id, curve] of this.movedCurves(n, to)) {
      const s = this.net.segment(id);
      const far = this.nodeSnap(s.a === n.id ? s.b : s.a);
      const req: RoadRequest = { start: s.a === n.id ? moved : far, end: s.a === n.id ? far : moved, spec: s.spec, mode: 'straight', curve, exclude };
      let plan = this.plan(req);
      // Хватит ли денег — решает итог: за старые участки часть вернётся.
      if (!plan.ok && plan.reason === 'Не хватает денег') plan = { ...plan, ok: true, reason: undefined };
      // Новые перекрёстки при переносе не создаются.
      if (plan.ok && plan.crossings.length) plan = { ...plan, ok: false, reason: 'Пересечёт другую дорогу' };
      if (!plan.ok) reason ??= plan.reason;
      res.spend += plan.cost;
      // Дом под двумя дорогами сносится и оплачивается один раз.
      for (const b of plan.demolish) {
        if (demolish.has(b)) res.spend -= this.ctx.demolishCost(b);
        demolish.add(b);
      }
      res.refund += this.segmentCost(s);
      res.segs.push(id);
      res.plans.push(plan);
    }
    reason ??= this.armsProblem(n, to, res);
    res.demolish = [...demolish];
    res.cost = Math.round(res.spend - res.refund * COST.refundRatio);
    if (!reason && res.cost > this.ctx.budget) reason = 'Не хватает денег';
    if (reason) {
      // Беда не в одной дороге, а в узле целиком — красным всё.
      if (res.plans.every((p) => p.ok)) res.plans = res.plans.map((p) => ({ ...p, ok: false }));
      return { ...res, ok: false, reason };
    }
    return { ...res, ok: true };
  }

  /** Дороги перенесённого узла не должны сходиться слишком остро и пересекать друг друга. */
  private armsProblem(n: RoadNode, to: Vec, res: NodeMovePlan): string | undefined {
    const luts = res.plans.map((p) => p.lut);
    if (luts.some((l) => !l)) return undefined;
    const dirs = res.segs.map((id, i) => {
      const lut = luts[i]!;
      return this.net.segment(id).a === n.id ? lut.tangentAt(0) : scale(lut.tangentAt(lut.length), -1);
    });
    for (let i = 0; i < dirs.length; i++) {
      for (let j = i + 1; j < dirs.length; j++) {
        if (Math.acos(Math.max(-1, Math.min(1, dot(dirs[i], dirs[j])))) < MIN_JOIN_ANGLE) return 'Слишком острый угол';
        if (intersectCurves(luts[i]!, luts[j]!).some((h) => dist(h.point, to) > 3)) return 'Дороги узла пересекутся';
      }
    }
    return undefined;
  }

  /** Переносит узел: все его дороги перестраиваются следом, id участков (и настройки узлов) сохраняются. */
  moveNode(nodeId: number, target: Vec): boolean {
    const plan = this.moveNodePlan(nodeId, target);
    if (!plan.ok) return false;
    if (plan.demolish.length) this.ctx.demolish(plan.demolish);
    this.net.moveNode(nodeId, target);
    // Машины остаются на своих полосах и едут уже по новой форме дороги.
    plan.segs.forEach((id, i) => this.net.reshapeSegment(id, plan.plans[i].curve!));
    this.ctx.spend(plan.spend);
    this.ctx.refund(plan.refund);
    this.ctx.networkChanged();
    return true;
  }

  /** Участок, который можно изогнуть: за середину (не у самых узлов), не кольцо, не платформа, не рельсы. */
  pickBendable(p: Vec, radius: number): Segment | null {
    const seg = this.pickSegment(p, radius);
    if (!seg || seg.ring || seg.platform !== undefined || isRail(seg.spec)) return null;
    const s = seg.lut.closest(p).s;
    const margin = Math.min(18, seg.length * 0.25);
    return s > margin && s < seg.length - margin ? seg : null;
  }

  /**
   * Изгиб участка: концы на месте, середина проходит через target (дуга второго порядка),
   * углы у узлов меняются. Проверка как у новой дороги, без новых перекрёстков.
   */
  bendPlan(segId: number, target: Vec): NodeMovePlan {
    const s = this.net.segments.get(segId);
    if (!s) return { ok: false, reason: 'Дороги нет', cost: 0, spend: 0, refund: 0, segs: [], plans: [], demolish: [] };
    const p0 = this.net.node(s.a).pos;
    const p3 = this.net.node(s.b).pos;
    const mid = scale(add(p0, p3), 0.5);
    const q = sub(scale(target, 2), mid);
    const curve: Cubic =
      dist(q, mid) < 1 ? straightCubic(p0, p3) : { p0, p1: add(p0, scale(sub(q, p0), 2 / 3)), p2: add(p3, scale(sub(q, p3), 2 / 3)), p3 };
    return this.reshapePlan(segId, curve);
  }

  /** Перо участка (1 — у начала, 2 — у конца) переставлено в target: новая форма кривой. */
  handleCurve(segId: number, which: 1 | 2, target: Vec): Cubic | null {
    const s = this.net.segments.get(segId);
    if (!s) return null;
    return which === 1 ? { ...s.curve, p1: { ...target } } : { ...s.curve, p2: { ...target } };
  }

  /**
   * Дорога, которая продолжает участок за его конец (1 — начало, 2 — конец): самая встречная
   * в этом узле, если она почти напротив. Её перо в этом узле — пара перу участка.
   */
  handlePartner(segId: number, which: 1 | 2): { seg: number; which: 1 | 2 } | null {
    const s = this.net.segments.get(segId);
    if (!s) return null;
    const nodeId = which === 1 ? s.a : s.b;
    const d = this.net.dirFrom(nodeId, s.id);
    let best: Segment | null = null;
    let bestDot = -Math.cos(0.6);
    for (const id of this.net.node(nodeId).segments) {
      const o = this.net.segments.get(id);
      if (!o || o.id === s.id || o.ring || o.platform !== undefined || isRail(o.spec) || o.a === o.b) continue;
      const c = dot(d, this.net.dirFrom(nodeId, id));
      if (c < bestDot) {
        bestDot = c;
        best = o;
      }
    }
    return best ? { seg: best.id, which: best.a === nodeId ? 1 : 2 } : null;
  }

  /**
   * Перо участка переставлено в target. smooth — перо продолжающей дороги в том же узле
   * разворачивается на ту же прямую (его длина сохраняется): стык остаётся гладким.
   */
  handlePlan(segId: number, which: 1 | 2, target: Vec, smooth: boolean): { curves: { seg: number; curve: Cubic }[]; plan: NodeMovePlan } | null {
    const curve = this.handleCurve(segId, which, target);
    if (!curve) return null;
    const curves = [{ seg: segId, curve }];
    const partner = smooth ? this.handlePartner(segId, which) : null;
    if (partner) {
      const node = which === 1 ? curve.p0 : curve.p3;
      const o = this.net.segment(partner.seg);
      const v = sub(target, node);
      const l = Math.hypot(v.x, v.y);
      const lo = dist(partner.which === 1 ? o.curve.p1 : o.curve.p2, node);
      if (l > 1e-3 && lo > 1e-3) curves.push({ seg: o.id, curve: this.handleCurve(o.id, partner.which, sub(node, scale(v, lo / l)))! });
    }
    const ids = curves.map((c) => c.seg);
    const parts = curves.map((c) => this.reshapePlan(c.seg, c.curve, ids));
    const spend = parts.reduce((a, p) => a + p.spend, 0);
    const refund = parts.reduce((a, p) => a + p.refund, 0);
    const cost = parts.reduce((a, p) => a + p.cost, 0);
    const plan: NodeMovePlan = {
      ok: true,
      cost,
      spend,
      refund,
      segs: ids,
      plans: parts.flatMap((p) => p.plans),
      demolish: [...new Set(parts.flatMap((p) => p.demolish))],
    };
    const failed = parts.find((p) => !p.ok && p.reason !== 'Не хватает денег');
    const reason = failed?.reason ?? (cost > this.ctx.budget ? 'Не хватает денег' : undefined);
    return { curves, plan: reason ? { ...plan, ok: false, reason } : plan };
  }

  /** Перо (и, если надо, перо продолжающей дороги) — по плану handlePlan. */
  applyHandle(res: NonNullable<ReturnType<Builder['handlePlan']>>): boolean {
    const { curves, plan } = res;
    if (!plan.ok) return false;
    if (plan.demolish.length) this.ctx.demolish(plan.demolish);
    for (const c of curves) this.net.reshapeSegment(c.seg, c.curve);
    this.ctx.spend(plan.spend);
    this.ctx.refund(plan.refund);
    this.ctx.networkChanged();
    return true;
  }

  /**
   * Новая форма участка с теми же концами: проверка как у новой дороги, без новых перекрёстков.
   * also — участки, которые меняют форму вместе с ним: их старая форма не мешает.
   */
  reshapePlan(segId: number, curve: Cubic, also: number[] = []): NodeMovePlan {
    const res: NodeMovePlan = { ok: false, cost: 0, spend: 0, refund: 0, segs: [], plans: [], demolish: [] };
    const s = this.net.segments.get(segId);
    if (!s) return { ...res, reason: 'Дороги нет' };
    const segs = [...new Set([s.id, ...also])];
    const req: RoadRequest = { start: this.nodeSnap(s.a), end: this.nodeSnap(s.b), spec: s.spec, mode: 'straight', curve, exclude: { segs, nodes: [] } };
    let plan = this.plan(req);
    if (!plan.ok && plan.reason === 'Не хватает денег') plan = { ...plan, ok: true, reason: undefined };
    if (plan.ok && plan.crossings.length) plan = { ...plan, ok: false, reason: 'Пересечёт другую дорогу' };
    res.spend = plan.cost;
    res.refund = this.segmentCost(s);
    res.segs = [s.id];
    res.plans = [plan];
    res.demolish = plan.demolish;
    res.cost = Math.round(res.spend - res.refund * COST.refundRatio);
    const reason = plan.ok ? (res.cost > this.ctx.budget ? 'Не хватает денег' : undefined) : plan.reason;
    return reason ? { ...res, ok: false, reason } : { ...res, ok: true };
  }

  /** Изгибает участок за середину; id сохраняется, машины едут по новой форме. */
  bendSegment(segId: number, target: Vec): boolean {
    return this.applyReshape(segId, this.bendPlan(segId, target));
  }

  /** Меняет форму участка (например, перо у его конца). */
  reshape(segId: number, curve: Cubic): boolean {
    return this.applyReshape(segId, this.reshapePlan(segId, curve));
  }

  private applyReshape(segId: number, plan: NodeMovePlan): boolean {
    if (!plan.ok || !plan.plans[0].curve) return false;
    if (plan.demolish.length) this.ctx.demolish(plan.demolish);
    this.net.reshapeSegment(segId, plan.plans[0].curve);
    this.ctx.spend(plan.spend);
    this.ctx.refund(plan.refund);
    this.ctx.networkChanged();
    return true;
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

  /** Сливает два прямых соосных сегмента, если узел между ними стал лишним. */
  private tryMerge(nodeId: number): void {
    const n = this.net.nodes.get(nodeId);
    // Узел с ж/д сигналом — граница блока, его не сливаем.
    if (!n || n.segments.length !== 2 || n.buildingId !== null || n.control !== 'none' || n.roundabout !== null || n.signals?.length) return;
    const [s1, s2] = n.segments.map((id) => this.net.segment(id));
    if (s1.ring || s2.ring || !sameSpec(s1.spec, s2.spec)) return;
    if (s1.platform !== undefined || s2.platform !== undefined) return;
    if (!this.net.isFlat(s1) || !this.net.isFlat(s2)) return;
    const isStraight = (s: Segment) => minRadius(s.curve) > 1e5;
    if (!isStraight(s1) || !isStraight(s2)) return;
    const d1 = this.net.dirFrom(n.id, s1.id);
    const d2 = this.net.dirFrom(n.id, s2.id);
    if (dot(d1, d2) > -0.9995) return;
    // Направления односторонних дорог должны совпадать.
    if (isOneWay(s1.spec) && (s1.b === n.id) === (s2.b === n.id)) return;
    const a = s1.a === n.id ? s1.b : s1.a;
    const b = s2.a === n.id ? s2.b : s2.a;
    if (this.net.segmentBetween(a, b)) return;
    const from = isOneWay(s1.spec) && s1.b !== n.id ? b : a;
    const to = from === a ? b : a;
    this.net.removeSegment(s1.id, false);
    this.net.removeSegment(s2.id, false);
    this.net.deleteNode(n.id);
    this.net.addSegment(from, to, straightCubic(this.net.node(from).pos, this.net.node(to).pos), s1.spec);
  }

  /** Апгрейд: меняет класс и число полос. Повторный клик по односторонней — разворот. */
  upgradeCheck(p: Vec, spec: RoadSpec, radius = 4): { ok: boolean; reason?: string; cost: number; seg: Segment | null } {
    const seg = this.pickSegment(p, radius);
    if (!seg) return { ok: false, reason: 'Выберите дорогу', cost: 0, seg: null };
    if (seg.ring) return { ok: false, reason: 'Кольцо нельзя менять', cost: 0, seg };
    if (isRail(seg.spec) || isRail(spec)) return { ok: false, reason: 'Апгрейд только для дорог', cost: 0, seg };
    if (sameSpec(seg.spec, spec)) {
      if (!isOneWay(spec)) return { ok: false, reason: 'Уже такая дорога', cost: 0, seg };
      return { ok: true, cost: 0, seg };
    }
    if (minRadius(seg.curve) < ROAD_CLASSES[spec.cls].minRadius) return { ok: false, reason: 'Слишком крутой поворот', cost: 0, seg };
    // Только поменять знак скорости — дёшево, дорогу не перестраиваем.
    if (sameSpec(seg.spec, { ...spec, limit: specKmh(seg.spec) })) {
      const cost = SIGN_COST;
      return cost > this.ctx.budget ? { ok: false, reason: 'Не хватает денег', cost, seg } : { ok: true, cost, seg };
    }
    const oldCost = this.segmentCost(seg);
    const newCost = Math.round((oldCost * specCost(spec)) / specCost(seg.spec));
    const cost = Math.max(Math.round(newCost * 0.15), newCost - oldCost);
    if (cost > this.ctx.budget) return { ok: false, reason: 'Не хватает денег', cost, seg };
    return { ok: true, cost, seg };
  }

  upgrade(p: Vec, spec: RoadSpec, radius = 4): boolean {
    const check = this.upgradeCheck(p, spec, radius);
    if (!check.ok || !check.seg) return false;
    const seg = check.seg;
    this.ctx.traffic.evictSegment(seg.id);
    if (sameSpec(seg.spec, spec)) this.net.reverseSegment(seg.id);
    else {
      this.net.setSpec(seg.id, spec);
      this.ctx.roadWidened?.(seg.id);
    }
    this.ctx.spend(check.cost);
    this.ctx.networkChanged();
    return true;
  }

  /** Перекрёсток автодорог (без рельсов) — для светофоров и колец. */
  pickJunction(p: Vec, radius: number, minDegree = 3): RoadNode | null {
    const n = this.net.findNodeNear(p, radius + 6, (x) => x.segments.every((id) => !this.net.isRailSeg(id)));
    return n && n.segments.length >= minDegree ? n : null;
  }

  canToggleLights(p: Vec, radius: number): { ok: boolean; reason?: string; cost: number } {
    const n = this.pickJunction(p, radius);
    if (!n) return { ok: false, reason: 'Выберите перекрёсток', cost: 0 };
    if (n.roundabout !== null) return { ok: false, reason: 'Это кольцо', cost: 0 };
    if (n.control === 'lights') return { ok: true, cost: -Math.round(COST.trafficLight * COST.refundRatio) };
    if (COST.trafficLight > this.ctx.budget) return { ok: false, reason: 'Не хватает денег', cost: COST.trafficLight };
    return { ok: true, cost: COST.trafficLight };
  }

  toggleLights(p: Vec, radius: number): boolean {
    const check = this.canToggleLights(p, radius);
    const n = this.pickJunction(p, radius);
    if (!check.ok || !n) return false;
    if (n.control === 'lights') {
      n.control = 'none';
      this.ctx.refund(COST.trafficLight);
    } else {
      n.control = 'lights';
      this.ctx.spend(COST.trafficLight);
    }
    this.net.touch(n.id);
    this.ctx.networkChanged();
    return true;
  }

  /** Радиус оси кольца: выбранный размер, но не меньше, чем нужно примыкающим дорогам и полосам. */
  private roundaboutRadius(n: RoadNode, opts: RingOptions): number {
    const hw = Math.max(...n.segments.map((id) => halfWidth(this.net.segment(id).spec)));
    const ringHalf = (opts.lanes * LANE_W) / 2 + 2;
    return Math.max(RING_SIZES[opts.size], hw * 2 + 14, ringHalf + 14);
  }

  /** Цена кольца растёт с размером и числом полос. */
  private roundaboutCost(R: number, lanes: number): number {
    return Math.round((COST.roundabout * (R / 40) * (0.6 + 0.4 * lanes)) / 100) * 100;
  }

  /** Точка на сегменте на расстоянии r от узла (по прямой). Возвращает длину дуги от узла. */
  private distanceAlong(seg: Segment, nodeId: number, r: number): number | null {
    const center = this.net.node(nodeId).pos;
    for (let s = 0; s <= seg.length; s += 1) {
      const cs = seg.a === nodeId ? s : seg.length - s;
      if (dist(seg.lut.pointAt(cs), center) >= r) return s;
    }
    return null;
  }

  canRoundabout(
    p: Vec,
    radius: number,
    opts: RingOptions = DEFAULT_RING,
  ): { ok: boolean; reason?: string; cost: number; r: number; center?: Vec; lanes: number } {
    const n = this.pickJunction(p, radius);
    if (!n) return { ok: false, reason: 'Выберите перекрёсток', cost: this.roundaboutCost(RING_SIZES[opts.size], opts.lanes), r: 0, lanes: opts.lanes };
    const R = this.roundaboutRadius(n, opts);
    const cost = this.roundaboutCost(R, opts.lanes);
    const res = { cost, r: R, center: n.pos, lanes: opts.lanes };
    if (n.roundabout !== null) return { ok: false, reason: 'Уже кольцо', ...res };
    if (n.buildingId !== null) return { ok: false, reason: 'Это подъезд к зданию', ...res };
    if (n.level !== 0) return { ok: false, reason: 'Кольцо только на земле', ...res };
    const angles: number[] = [];
    for (const sid of n.segments) {
      const s = this.net.segment(sid);
      if (s.ring || !this.net.isFlat(s)) return { ok: false, reason: 'Рядом пандус', ...res };
      const along = this.distanceAlong(s, n.id, R);
      if (along === null || s.length - along < MIN_SEGMENT_LEN) return { ok: false, reason: 'Мало места', ...res };
      angles.push(angleOf(this.net.dirFrom(n.id, sid)));
    }
    angles.sort((a, b) => a - b);
    for (let i = 0; i < angles.length; i++) {
      const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
      if (next - angles[i] < 0.6) return { ok: false, reason: 'Дороги сходятся слишком остро', ...res };
    }
    for (const other of this.net.nodesNear(n.pos, R + 8)) {
      if (other.id !== n.id && Math.abs(other.level - n.level) < 1) {
        return { ok: false, reason: 'Мало места', ...res };
      }
    }
    const ringHalf = (opts.lanes * LANE_W) / 2 + 2;
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const pt = add(n.pos, { x: Math.cos(a) * R, y: Math.sin(a) * R });
      if (this.ctx.isWater(pt, ringHalf)) return { ok: false, reason: 'Мешает вода', ...res };
      if (this.ctx.blocked(pt, ringHalf + 2)) return { ok: false, reason: 'Мешает здание', ...res };
    }
    // Чужие дороги не должны задевать кольцо.
    for (const s of this.net.segmentsNear(n.pos, R + ringHalf + 30)) {
      if (n.segments.includes(s.id)) continue;
      const near = s.lut.closest(n.pos);
      if (near.d < R + ringHalf + halfWidth(s.spec) && Math.abs(this.net.levelAt(s, near.s) - n.level) < 0.75) {
        return { ok: false, reason: 'Мешает дорога', ...res };
      }
    }
    if (cost > this.ctx.budget) return { ok: false, reason: 'Не хватает денег', ...res };
    return { ok: true, ...res };
  }

  buildRoundabout(p: Vec, radius: number, opts: RingOptions = DEFAULT_RING): boolean {
    const check = this.canRoundabout(p, radius, opts);
    if (!check.ok) return false;
    const n = this.pickJunction(p, radius)!;
    const R = check.r;
    const center = { ...n.pos };
    const ringLanes = opts.lanes;
    const entries: { node: RoadNode; angle: number }[] = [];
    for (const sid of [...n.segments]) {
      const seg = this.net.segment(sid);
      const along = this.distanceAlong(seg, n.id, R)!;
      const cs = seg.a === n.id ? along : seg.length - along;
      const res = this.net.splitSegmentDetailed(sid, seg.lut.tAt(cs));
      const inner = seg.a === n.id ? res.first : res.second;
      this.net.removeSegment(inner.id, false);
      entries.push({ node: res.node, angle: angleOf(sub(res.node.pos, center)) });
    }
    this.net.deleteNode(n.id);
    const ringId = n.id;
    const spec: RoadSpec = { cls: 'street', lanesF: ringLanes, lanesB: 0 };
    // Против часовой стрелки на экране: угол убывает.
    entries.sort((a, b) => b.angle - a.angle);
    for (const e of entries) e.node.roundabout = ringId;
    for (let i = 0; i < entries.length; i++) {
      const from = entries[i];
      const to = entries[(i + 1) % entries.length];
      let arc = from.angle - to.angle;
      if (arc <= 0) arc += Math.PI * 2;
      const steps = Math.max(1, Math.ceil(arc / (Math.PI / 2)));
      let prev = from.node;
      for (let k = 1; k <= steps; k++) {
        const a0 = from.angle - (arc * (k - 1)) / steps;
        const a1 = from.angle - (arc * k) / steps;
        let next: RoadNode;
        if (k === steps) next = to.node;
        else {
          next = this.net.addNode({ x: center.x + Math.cos(a1) * R, y: center.y + Math.sin(a1) * R });
          next.roundabout = ringId;
        }
        const c = circleArc(center, R, a0, a1);
        this.net.addSegment(prev.id, next.id, { ...c, p0: prev.pos, p3: next.pos }, spec, true);
        prev = next;
      }
    }
    this.ctx.spend(check.cost);
    this.ctx.roundaboutCenters.set(ringId, center);
    this.ctx.networkChanged();
    return true;
  }
}
