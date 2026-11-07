import { COST, GRADE } from '../config';
import { curveProfile, earthFactor, earthworkProblem, GroundProfile, type ProfileSummary, structureGradeProblem } from './grade';
import { nodeDeck } from '../lanes/deck';
import { Cubic, minRadius } from '../core/bezier';
import { add, dist, dot, rightNormal, scale, sub, Vec } from '../core/vec';
import { Anchor, applyLane, buildRoad, bulldoze, bulldozeBox, EditError, LaneDraft, laneStep, LaneTip, RoadOptions, taperDeadLanes } from '../lanes/edit';
import { cornerCost, cornerHandles } from '../lanes/corners';
import { edgesAt, laneShare } from '../lanes/geometry';
import { Corridor, Flow, LaneNet, type LaneNode, LaneSlot, LAT_EPS } from '../lanes/model';
import { LEVEL_RUN, RoadClass, ROAD_CLASSES, ROAD_MARGIN, structureFactor } from '../world/roadTypes';
import type { Footprint } from '../world/spatial';
import { halfAtS } from '../world/worldgen';
import type { Roads } from './roads';
import { buildRate, carryBuild, paidFor } from './constructionWork';

/** Что строитель дорог знает об игре. */
export interface RoadContext {
  readonly roads: Roads;
  readonly budget: number;
  isWater(p: Vec, margin?: number): boolean;
  inBounds(p: Vec, margin?: number): boolean;
  /** Отметка земли в точке (вода — NaN); без рельефа (старые миры) — null: профиль не считаем. */
  ground(): ((p: Vec) => number) | null;
  /**
   * Строения в точке: id, можно ли снести их ради дороги, узел въезда (у автостанции — торец её выезда)
   * и movable — навес остановки: при расширении улицы (shove) не мешает, его отодвинут (shoveStops).
   */
  obstaclesAt(p: Vec, radius: number): { id: number; demolishable: boolean; gate?: number; movable?: boolean }[];
  /**
   * Расширение улицы (shove): остановки у изменённых полотен отодвигаются к новому бордюру сети net.
   * Дома на новых местах навесов — в demolish; ответ — новые места навесов или чем мешает.
   */
  shoveStops?(net: LaneNet, changed: Corridor[], demolish: Set<number>): Footprint[] | string;
  demolishCost(id: number): number;
  demolish(ids: number[]): void;
  spend(amount: number): void;
  refund(amount: number): void;
  networkChanged(): void;
  /** Что не так у полотна с путями: переезд под острым углом, мало места по высоте, слишком близко. */
  railConflict?(net: LaneNet, c: Corridor): string | undefined;
  /**
   * Режим «Со строительством»: номер, под которым новая дорога станет проектом (src/game/construction.ts);
   * null — «Мгновенно», строится сразу.
   */
  projectId?(): number | null;
  /** Проект заложен (план применён): стройка заводит его. */
  startProject?(p: ProjectStart, net: LaneNet): void;
}

/** Новая дорога — проект стройки: номер, полная цена, секунды стройки на ×1, длина и её полотна (в сети плана). */
export interface ProjectStart {
  id: number;
  cost: number;
  seconds: number;
  length: number;
  corridors: number[];
}

/** План правки дорог: сеть с правкой (для предпросмотра и стройки), цена, дома под снос, что не так. */
export interface RoadPlan {
  ok: boolean;
  reason?: string;
  /** Сколько заплатим (минус — сколько вернём). */
  cost: number;
  /** Дороги стали дороже на столько — платим; дешевле — возврат части. */
  spend: number;
  refund: number;
  demolish: number[];
  net: LaneNet | null;
  /** Новые и изменённые полотна (в net). */
  changed: number[];
  /** Куда отодвинутся навесы остановок (расширение улицы у остановки). */
  moved?: Footprint[];
  /** Продольный профиль новых полотен на земле: наибольший уклон, выемка и насыпь, м. */
  profile?: ProfileSummary;
  /**
   * Режим «Со строительством»: новые полотна — проект (в net уже помечены Corridor.build). cost плана — только то,
   * что платится сразу (снос домов, правки готовых дорог); проект оплачивается по готовым метрам.
   */
  project?: ProjectStart;
}

const fail = (reason: string): RoadPlan => ({ ok: false, reason, cost: 0, spend: 0, refund: 0, demolish: [], net: null, changed: [] });

/** Правка сети дорог на её копии: false (или EditError) — так нельзя. */
export type NetEdit = (net: LaneNet) => boolean | void;

/** Правка: новая форма полотна id (концы на месте). */
export function reshapeEdit(id: number, curve: (net: LaneNet, c: Corridor) => Cubic): NetEdit {
  return (n) => {
    const c = n.corridors.get(id);
    if (!c) return false;
    n.setCurve(c, curve(n, c));
  };
}

/** Правка «Полоса» по черновику инструмента (протянули край дороги или конец пристроенной полосы). */
export function laneEdit(d: LaneDraft, cls: RoadClass): NetEdit {
  return (n) => applyLane(n, d, cls);
}

/** Куда пришла «Полоса по точкам»: новый конец и что построено (заполняет правка, когда её выполняют). */
export interface LaneStepOut {
  step: { tip: LaneTip; what: string } | null;
}

/**
 * Правка «Полоса по точкам»: куски от конца tip через qs (каждая точка — как следующий клик); out.step — новый
 * конец (в сети правки) и что построено. limit — скорость новых однополосных дорог (съездов, въездов).
 */
export function laneStepEdit(tip: LaneTip, qs: Vec[], cls: RoadClass, radius: number, limit: number | undefined, reverse: boolean, out: LaneStepOut): NetEdit {
  return (n) => {
    const before = new Set(n.corridors.keys());
    let at = tip;
    const what: string[] = [];
    for (const q of qs) {
      const s = laneStep(n, at, q, cls, radius, reverse);
      at = s.tip;
      what.push(s.what);
    }
    if (limit !== undefined) for (const c of n.corridors.values()) if (!before.has(c.id) && c.lanes.length === 1 && c.lanes[0].offset === 0) c.limit = limit;
    out.step = { tip: at, what: what.join(' → ') };
    return qs.length > 0;
  };
}

/** Правка: узел id — в точку pos, дороги следом. */
export function moveNodeEdit(id: number, pos: Vec): NetEdit {
  return (n) => {
    if (!n.nodes.has(id)) return false;
    n.moveNode(id, pos);
  };
}

/** Полуширина полотна с одной стороны оси (side ≥ 0 — справа по ходу a→b) вместе с обочиной. */
function sideHalf(c: Corridor, s: number, side: number): number {
  const e = edgesAt(c, s);
  return (e ? Math.max(0, side >= 0 ? e[1] : -e[0]) : 0) + ROAD_MARGIN;
}

/** Сколько от конца полотна чужие дороги общего узла могут идти вплотную (там перекрёсток или стык). */
const JOINT_REACH = 45;

/**
 * Узлы, где с полотном c сходятся дороги: его концы и дальние концы коротких (до JOINT_REACH) полотен из стыков
 * на его концах. Съезд, ответвившийся в соседнем стыке, ещё идёт вплотную и за ним, если до него рукой подать.
 */
export function jointNodes(net: LaneNet, c: Corridor): Set<number> {
  const res = new Set([c.a, c.b]);
  for (const id of [c.a, c.b]) {
    const n = net.node(id);
    if (n.kind !== 'seam') continue;
    for (const e of net.ends(n)) {
      const k = e.corridor;
      if (k.id !== c.id && k.length < JOINT_REACH) res.add(e.end === 'a' ? k.b : k.a);
    }
  }
  return res;
}

/** Ось полотна o ближе к точке s полотна c, чем позволяют их кромки (как в проверке «слишком близко»); d — между осями. */
function crowds(c: Corridor, s: number, o: Corridor): { close: boolean; d: number } {
  const p = c.lut.pointAt(s);
  const hit = o.lut.closest(p);
  const to = sub(hit.point, p);
  const mine = sideHalf(c, s, dot(to, rightNormal(c.lut.tangentAt(s))));
  const theirs = sideHalf(o, hit.s, -dot(to, rightNormal(o.lut.tangentAt(hit.s))));
  return { close: hit.d < mine + theirs - 1, d: hit.d };
}

/**
 * «Ёлочка» у стыка, где одно из полотен c и o примыкает сбоку (въезд, съезд): кромки сходятся в стыке и
 * расходятся плавно — на длинном пологом въезде дольше JOINT_REACH, и это не «слишком близко». Сколько от
 * конца a и от конца b полотно c так идёт рядом с o: без разрыва от стыка и не ближе, чем в самом стыке.
 */
function goreReach(net: LaneNet, c: Corridor, o: Corridor): [number, number] {
  const res: [number, number] = [0, 0];
  (['a', 'b'] as const).forEach((end, k) => {
    const id = end === 'a' ? c.a : c.b;
    if (net.node(id).kind !== 'seam' || (o.a !== id && o.b !== id) || o.a === o.b) return;
    const mine = end === 'a' ? c.portA : c.portB;
    const theirs = o.a === id ? o.portA : o.portB;
    if (Math.abs(mine) < LAT_EPS && Math.abs(theirs) < LAT_EPS) return;
    const gap = Math.abs(mine - theirs);
    for (let d = 0; d <= c.length; d += 3) {
      const x = crowds(c, end === 'a' ? d : c.length - d, o);
      if (!x.close || x.d < gap - 1.5) break;
      res[k] = d + 3;
    }
  });
  return res;
}

/** Профиль полотна по рельефу: только у дороги на земле (оба конца на уровне 0) и если рельеф есть. */
export function corridorProfile(net: LaneNet, c: Corridor, ground: ((p: Vec) => number) | null): (GroundProfile & { ds: number }) | null {
  if (!ground || net.node(c.a).level !== 0 || net.node(c.b).level !== 0) return null;
  return curveProfile(c.lut, ground, GRADE.road);
}

/**
 * Стоимость полотна: длина × полосы × цена класса × мост, эстакада или тоннель (над водой — вчетверо) × насыпи и
 * выемки. Строящееся (Corridor.build) стоит столько, сколько за него уже заплачено, — за готовые метры: так снос
 * и перестройка стройки считаются по тем же правилам, что у готовой дороги.
 */
export function corridorCost(net: LaneNet, c: Corridor, isWater: (p: Vec, margin?: number) => boolean, ground: ((p: Vec) => number) | null = null): number {
  const full = fullCorridorCost(net, c, isWater, ground);
  return c.build ? paidFor(full, c.build.done, c.length) : full;
}

/** Стоимость полотна целиком, построено оно или ещё строится. */
export function fullCorridorCost(net: LaneNet, c: Corridor, isWater: (p: Vec, margin?: number) => boolean, ground: ((p: Vec) => number) | null = null): number {
  const n = Math.max(2, Math.ceil(c.length / 12));
  const prof = corridorProfile(net, c, ground);
  let cost = 0;
  for (let i = 0; i < n; i++) {
    const s = (c.length * (i + 0.5)) / n;
    const p = c.lut.pointAt(s);
    // Полосы — сколько их здесь на самом деле: пристроенная на кусок дороги стоит по своей длине (отгон — по ширине).
    const lanes = c.lanes.reduce((k, l) => k + laneShare(c, l, s), 0);
    let earth = 1;
    if (prof) {
      const k = Math.min(prof.z.length - 1, Math.round(s / prof.ds));
      if (!Number.isNaN(prof.h[k])) earth = earthFactor(prof.z[k] - prof.h[k], GRADE.earthUnit);
    }
    cost += (c.length / n) * ROAD_CLASSES[c.cls].cost * lanes * structureFactor(net.heightAt(c, s), isWater(p, 2)) * earth;
  }
  return Math.round(cost);
}

/**
 * Строитель дорог игры на сети полос: правка выполняется на копии сети, затем проверяется
 * всё, что она изменила (вода, дома, соседние дороги, крутые повороты, оборванные полосы) и считается
 * цена — разница стоимости дорог до и после плюс снос домов. По готовому плану копия становится сетью.
 */
export class RoadBuilder {
  constructor(private readonly ctx: RoadContext) {}

  get net(): LaneNet {
    return this.ctx.roads.net;
  }

  /**
   * Правка на копии сети и её проверка. free — за счёт города; shove — дома под дорогой не сносим:
   * после стройки их отодвинут (расширение улицы).
   */
  plan(
    edit: NetEdit,
    opts: { free?: boolean; shove?: boolean; raze?: boolean; trusted?: boolean; only?: (c: Corridor) => boolean; project?: boolean } = {},
  ): RoadPlan {
    const before = this.net;
    const next = before.clone();
    try {
      if (edit(next) === false) return fail('Так не построить');
    } catch (e) {
      return fail(e instanceof EditError ? e.message : 'Так не построить');
    }
    // «Со строительством»: новые дороги (не куски прежних, разрезанных ими) — проект, платить за них — по готовым метрам.
    const pid = opts.project && !opts.free ? (this.ctx.projectId?.() ?? null) : null;
    const project = pid === null ? undefined : this.markProject(before, next, pid);
    // Что изменилось: новые полотна, полотна с новой ревизией и исчезнувшие.
    const changed: Corridor[] = [];
    let after = 0;
    let was = 0;
    const water = (p: Vec, m?: number) => this.ctx.isWater(p, m);
    const ground = this.ctx.ground();
    for (const c of next.corridors.values()) {
      if (before.corridors.get(c.id)?.rev === c.rev) continue;
      changed.push(c);
      after += corridorCost(next, c, water, ground);
    }
    for (const c of before.corridors.values()) {
      if (next.corridors.get(c.id)?.rev !== c.rev) was += corridorCost(before, c, water, ground);
    }
    const demolish = new Set<number>();
    let reason: string | undefined;
    // Снос ничего не строит: оставшиеся куски дорог не проверяем и дома у них не сносим.
    // Развязка (trusted) проложена заранее: её куски вплотную друг к другу — так задумано, сверяем только с прочими дорогами.
    // only — что проверять (вставка: её полотна; разрезанные ею старые дороги — нет, у них дома не сносим).
    const own = opts.trusted ? new Set(changed.map((c) => c.id)) : null;
    const checked = opts.raze ? [] : opts.only ? changed.filter(opts.only) : changed;
    for (const c of checked) {
      reason = this.check(next, c, demolish, !!opts.shove, own, !onOldAxis(before, c));
      if (reason) break;
    }
    // Скруглённые игроком углы перекрёстков, которые правка задела: асфальт угла — в цену, место под ним — проверить.
    if (!opts.raze) {
      for (const n of roundedNodes(before, next)) {
        after += cornerCost(next, n);
        const old = before.nodes.get(n.id);
        if (old) was += cornerCost(before, old);
        reason ??= this.checkCorners(next, n, demolish);
      }
    }
    // Расширение у остановки: её навес отодвигается к новому бордюру, дома на его новом месте — под снос.
    let moved: Footprint[] | undefined;
    if (!reason && opts.shove && checked.length && this.ctx.shoveStops) {
      const res = this.ctx.shoveStops(next, checked, demolish);
      if (typeof res === 'string') reason = res;
      else if (res.length) moved = res;
    }
    // Новые беды сети (оборванные полосы и т. п.) — только те, что появились от этой правки.
    if (!reason && !opts.raze) {
      const old = new Set(before.problems());
      reason = next.problems().find((p) => !old.has(p)) ? 'Полосы не сходятся в стыке' : undefined;
    }
    const razed = [...demolish];
    const demolishCost = razed.reduce((s, id) => s + this.ctx.demolishCost(id), 0);
    const diff = after - was;
    const spend = opts.free ? 0 : Math.max(0, diff) + demolishCost;
    const refund = opts.free ? 0 : Math.max(0, -diff);
    const cost = Math.round(spend - refund * COST.refundRatio);
    if (!reason && cost > this.ctx.budget) reason = 'Не хватает денег';
    const plan: RoadPlan = { ok: !reason, reason, cost, spend, refund, demolish: razed, net: next, changed: changed.map((c) => c.id) };
    if (moved) plan.moved = moved;
    if (project) plan.project = project;
    for (const c of checked) {
      const prof = onOldAxis(before, c) ? null : corridorProfile(next, c, ground);
      if (!prof) continue;
      const was = plan.profile ?? { grade: 0, cut: 0, fill: 0 };
      plan.profile = { grade: Math.max(was.grade, prof.grade), cut: Math.max(was.cut, prof.cut), fill: Math.max(was.fill, prof.fill) };
    }
    return plan;
  }

  /**
   * Новые полотна плана — проект pid: помечает их стройкой с нуля. Ответ — что за проект (нет новых — undefined).
   * Новые — те, которых не было, и не на оси прежних (куски разрезанной дороги остаются, какими были).
   */
  private markProject(before: LaneNet, next: LaneNet, pid: number): ProjectStart | undefined {
    const water = (p: Vec, m?: number) => this.ctx.isWater(p, m);
    const ground = this.ctx.ground();
    const res: ProjectStart = { id: pid, cost: 0, seconds: 0, length: 0, corridors: [] };
    for (const c of next.corridors.values()) {
      if (before.corridors.has(c.id) || c.build || onOldAxis(before, c)) continue;
      c.build = { project: pid, done: 0 };
      res.corridors.push(c.id);
      res.cost += fullCorridorCost(next, c, water, ground);
      res.seconds += c.length / buildRate(next, c, water);
      res.length += c.length;
    }
    return res.corridors.length ? res : undefined;
  }

  /** Строит по плану: сносит дома, копия сети становится сетью, деньги списываются. */
  apply(plan: RoadPlan): boolean {
    if (!plan.ok || !plan.net) return false;
    if (plan.demolish.length) this.ctx.demolish(plan.demolish);
    // Стройка с тех пор, как план считали, ушла вперёд — готовое переносим в сеть плана.
    carryBuild(this.ctx.roads.net, plan.net);
    this.ctx.roads.replace(plan.net);
    if (plan.spend) this.ctx.spend(plan.spend);
    if (plan.refund) this.ctx.refund(plan.refund);
    if (plan.project) this.ctx.startProject?.(plan.project, plan.net);
    this.ctx.networkChanged();
    return true;
  }

  // ---------- Действия ----------

  /** Дорога между якорями (якоря — в текущей сети; в копии те же id). */
  road(a: Anchor, b: Anchor, o: RoadOptions, opts: { free?: boolean; project?: boolean } = {}): RoadPlan {
    return this.plan((n) => buildRoad(n, a, b, o).length > 0, opts);
  }

  /** Полоса по черновику инструмента «Полоса». */
  lane(d: LaneDraft, cls: RoadClass): RoadPlan {
    // Дома у дороги не сносим: после стройки их отодвинут от неё (roadWidened), сносят — только если места нет.
    return this.plan(laneEdit(d, cls), { shove: true });
  }

  /**
   * Куски полосы по точкам от конца tip через qs (каждая точка — как следующий клик); step — новый конец
   * (в сети плана) и что построено. limit — скорость новых однополосных дорог (съездов, въездов).
   */
  laneStep(
    tip: LaneTip,
    qs: Vec[],
    cls: RoadClass,
    radius: number,
    limit?: number,
    reverse = false,
  ): { plan: RoadPlan; step: { tip: LaneTip; what: string } | null } {
    const out: LaneStepOut = { step: null };
    const plan = this.plan(laneStepEdit(tip, qs, cls, radius, limit, reverse, out), { shove: true });
    return { plan, step: plan.ok ? out.step : null };
  }

  /** Снос полотен. */
  bulldoze(ids: number[]): RoadPlan {
    return this.plan(
      (n) => {
        for (const id of ids) bulldoze(n, id);
        return ids.length > 0;
      },
      { raze: true },
    );
  }

  /** Снос рамкой: всё, что внутри; дороги на краю режутся по нему. */
  bulldozeBox(x0: number, y0: number, x1: number, y1: number): RoadPlan {
    return this.plan((n) => bulldozeBox(n, x0, y0, x1, y1) > 0, { raze: true });
  }

  /** Другие полосы, класс и ограничение скорости у полотна; дома, на которые налезет шире дорога, отодвигаются после стройки. */
  rebuild(id: number, p: { cls: RoadClass; lanes: LaneSlot[]; limit?: number }): RoadPlan {
    return this.plan(
      (n) => {
        const c = n.corridors.get(id);
        if (!c) return false;
        if (c.ring) throw new EditError('Кольцо не перестраивается');
        c.cls = p.cls;
        c.limit = p.limit;
        n.setLanes(c, p.lanes);
        // В стыке с дорогой другого профиля лишние полосы (у неё или у соседа) сходят на нет отгоном.
        taperDeadLanes(n, [c.a, c.b]);
      },
      { shove: true },
    );
  }

  /**
   * Ограничение скорости на полотнах ids без перестройки: форма, полосы и цена те же, проверять нечего.
   * limit не задан — по классу дороги.
   */
  setLimit(ids: number[], limit: number | undefined): RoadPlan {
    return this.plan(
      (n) => {
        for (const id of ids) {
          const c = n.corridors.get(id);
          if (!c) return false;
          c.limit = limit;
          // Новая ревизия полотна — граф движения возьмёт новую скорость.
          n.setLanes(c, c.lanes);
        }
      },
      { raze: true },
    );
  }

  /** Разворот односторонней дороги — всех её кусков разом, чтобы полосы на стыках не встречались лбами. */
  reverse(ids: number[]): RoadPlan {
    return this.plan(
      (n) => {
        const nodes: number[] = [];
        for (const id of ids) {
          const c = n.corridors.get(id);
          if (!c || c.ring) return false;
          n.setLanes(
            c,
            c.lanes.map((l) => ({ ...l, flow: -l.flow as Flow })),
          );
          nodes.push(c.a, c.b);
        }
        taperDeadLanes(n, nodes);
      },
      { shove: true },
    );
  }

  /** Новая форма полотна (концы на месте). */
  reshape(id: number, curve: (net: LaneNet, c: Corridor) => Cubic): RoadPlan {
    return this.plan(reshapeEdit(id, curve));
  }

  /** Перенос узла: дороги следом. */
  moveNode(id: number, pos: Vec): RoadPlan {
    return this.plan(moveNodeEdit(id, pos));
  }

  // ---------- Проверки ----------

  /**
   * Мост или тоннель между узлами A и B круче, чем можно дороге (GRADE.road)? Отметка узла — земля под ним
   * (над водой — её уровень) и высота полотна; у пандуса (ramp) — запас на насыпь или выемку у подножия.
   * Без рельефа — не бывает.
   */
  private structureSteep(A: LaneNode, B: LaneNode, length: number, ramp: boolean): string | undefined {
    const ground = this.ctx.ground();
    if (!ground) return undefined;
    const z = (n: LaneNode) => {
      const g = ground(n.pos);
      return (Number.isFinite(g) ? g : 0) + nodeDeck(n);
    };
    return structureGradeProblem(z(A), z(B), length, GRADE.road, ramp ? GRADE.roadDepth : 0);
  }

  /**
   * Скруглённые углы перекрёстка n: асфальт от вершины угла до дуги не заходит на чужую дорогу (на той же высоте),
   * в воду, за край карты и под здание, которое не снести; дома под ним — в demolish.
   */
  private checkCorners(net: LaneNet, n: LaneNode, demolish: Set<number>): string | undefined {
    const arms = new Set(n.corridors);
    for (const h of cornerHandles(net, n)) {
      if (!h.radius) continue;
      // Бордюр угла и середины между ним и вершиной — там новый асфальт.
      const pts = h.curb.flatMap((p) => [p, scale(add(p, h.corner.apex), 0.5)]);
      for (const p of pts) {
        if (!this.ctx.inBounds(p, 5)) return 'За краем карты';
        if (n.level === 0 && this.ctx.isWater(p, 1)) return 'Мешает вода';
        if (n.level > -0.75) {
          for (const o of this.ctx.obstaclesAt(p, 1)) {
            if (o.gate === n.id) continue;
            if (!o.demolishable) return 'Мешает здание';
            demolish.add(o.id);
          }
        }
        for (const o of net.corridorsNear(p, 40)) {
          if (arms.has(o.id)) continue;
          const hit = o.lut.closest(p);
          if (Math.abs(net.heightAt(o, hit.s) - n.level) >= 0.75) continue;
          const theirs = sideHalf(o, hit.s, dot(sub(p, hit.point), rightNormal(o.lut.tangentAt(hit.s))));
          if (hit.d < theirs + 0.5) return 'Угол заходит на другую дорогу';
        }
      }
    }
    return undefined;
  }

  /** Что не так с полотном c в сети net; дома, которые придётся снести, — в demolish. */
  private check(net: LaneNet, c: Corridor, demolish: Set<number>, shove: boolean, own: Set<number> | null = null, reshaped = true): string | undefined {
    if (c.length < 8) return 'Слишком коротко';
    const limit = ROAD_CLASSES[c.cls].minRadius;
    if (minRadius(c.curve) < limit * 0.7) return 'Слишком крутой поворот';
    const A = net.node(c.a);
    const B = net.node(c.b);
    const rise = Math.abs(A.level - B.level);
    if (rise > 2) return 'Слишком большой перепад';
    if (rise * LEVEL_RUN > c.length) return 'Слишком крутой подъём';
    // Опора на земле в воде: мост через реку — полотно над ней, узлы — на берегах.
    for (const n of [A, B]) if (Math.abs(n.level) < 0.25 && this.ctx.isWater(n.pos, 2)) return 'Опора в воде — нужен мост';
    // Вдоль оси круче допустимого — выравниваем насыпью и выемкой; слишком глубоко — мост, тоннель или путь наискось.
    // Старую дорогу (расширение, перекрёсток на ней) не перепроверяем: её профиль уже построен.
    const prof = reshaped ? corridorProfile(net, c, this.ctx.ground()) : null;
    const earth = prof && earthworkProblem(prof, GRADE.road, GRADE.roadDepth);
    if (earth) return earth;
    // Мост, эстакада, тоннель, пандус: уклон — по отметкам полотна в узлах (земля плюс высота полотна), не круче,
    // чем у дороги на земле: мост не поднимает дорогу по склону на любую гору.
    const steep = reshaped && (A.level !== 0 || B.level !== 0) ? this.structureSteep(A, B, c.length, rise > 0) : undefined;
    if (steep) return steep;
    const ends = [A.pos, B.pos];
    const joint = jointNodes(net, c);
    // «Ёлочка» с полотнами общего стыка (въезд, съезд): докуда от концов c идёт вплотную к ним — считаем, когда встретим.
    const gores = new Map<number, [number, number]>();
    const inGore = (o: Corridor, s: number) => {
      let g = gores.get(o.id);
      if (!g) gores.set(o.id, (g = goreReach(net, c, o)));
      return s <= g[0] || c.length - s <= g[1];
    };
    const step = 6;
    for (let s = 0; s <= c.length; s += step) {
      const p = c.lut.pointAt(s);
      const half = halfAtS(c, s);
      const h = net.heightAt(c, s);
      if (!this.ctx.inBounds(p, 20)) return 'За краем карты';
      if (h < -0.25 && h > -0.75 && this.ctx.isWater(p, 2)) return 'Въезд в тоннель в воде';
      // Полотно бывает шире с одной стороны (пристроенная полоса): дома и дороги проверяем по кромке своей стороны.
      const n = rightNormal(c.lut.tangentAt(s));
      const e = edgesAt(c, s);
      const deck = e ? add(p, scale(n, (e[0] + e[1]) / 2)) : p;
      const deckHalf = (e ? (e[1] - e[0]) / 2 : 0) + ROAD_MARGIN;
      // Тоннель проходит под домами; мосты и эстакады стоят на опорах — дома под ними сносим.
      if (h > -0.75) {
        for (const o of this.ctx.obstaclesAt(deck, deckHalf + 1)) {
          // Своя станция в торце выезда: широкое полотно у ворот слегка заходит в её контур — так и задумано.
          if (o.gate !== undefined && (o.gate === c.a || o.gate === c.b)) continue;
          // Навес остановки при расширении улицы отодвинется к новому бордюру (shoveStops).
          if (shove && o.movable) continue;
          if (!o.demolishable) return 'Мешает здание';
          if (!shove) demolish.add(o.id);
        }
      }
      // Чужие дороги рядом на той же высоте: у общих узлов — можно (там перекрёсток или стык), в остальном — не ближе краёв.
      const nearEnd = ends.some((e) => dist(e, p) < JOINT_REACH);
      for (const o of net.corridorsNear(p, half + 40)) {
        if (o.id === c.id || own?.has(o.id)) continue;
        const shares = joint.has(o.a) || joint.has(o.b);
        if (shares && (nearEnd || inGore(o, s))) continue;
        const hit = o.lut.closest(p);
        const to = sub(hit.point, p);
        const mine = sideHalf(c, s, dot(to, n));
        const theirs = sideHalf(o, hit.s, -dot(to, rightNormal(o.lut.tangentAt(hit.s))));
        if (hit.d < mine + theirs - 1 && !(nearEnd && shares)) {
          if (Math.abs(h - net.heightAt(o, hit.s)) >= 0.75) continue;
          // Касание у самого чужого узла (дорога к нему подходит) — проверит узел.
          if (dist(hit.point, net.node(o.a).pos) < 2 || dist(hit.point, net.node(o.b).pos) < 2) continue;
          return 'Слишком близко к другой дороге';
        }
      }
    }
    return this.ctx.railConflict?.(net, c);
  }
}

/**
 * Перекрёстки, у которых правка задела скругления углов: настройку углов поменяли (или сняли), либо подвинули узел
 * или его дороги, а скругления на нём есть. В сети после правки.
 */
function roundedNodes(before: LaneNet, next: LaneNet): LaneNode[] {
  const res: LaneNode[] = [];
  for (const n of next.nodes.values()) {
    const old = before.nodes.get(n.id);
    if (!n.corners && !old?.corners) continue;
    // Объект настроек при правке заменяется целиком: тот же — не меняли.
    const same =
      old &&
      old.corners === n.corners &&
      old.pos.x === n.pos.x &&
      old.pos.y === n.pos.y &&
      old.corridors.length === n.corridors.length &&
      n.corridors.every((id) => before.corridors.get(id)?.rev === next.corridors.get(id)?.rev);
    if (!same) res.push(n);
  }
  return res;
}

/** Полотно лежит на оси дороги, что уже была (расширение, разрезание перекрёстком), — форма не новая. */
export function onOldAxis(before: LaneNet, c: Corridor): boolean {
  for (const k of [0.1, 0.5, 0.9]) {
    const q = c.lut.pointAt(c.length * k);
    if (!before.corridorsNear(q, 10).some((o) => o.lut.closest(q).d < 0.5)) return false;
  }
  return true;
}

/** Улица, на оси которой точка q (в пределах 4): полотно и где на нём. */
function streetAt(net: LaneNet, q: Vec): { c: Corridor; s: number } | null {
  let best: { c: Corridor; s: number; d: number } | null = null;
  for (const c of net.corridorsNear(q, 20)) {
    const hit = c.lut.closest(q);
    if (hit.d < 4 && (!best || hit.d < best.d)) best = { c, s: hit.s, d: hit.d };
  }
  return best;
}

/**
 * Навес остановки fp у бордюра улицы в сети net: улица идёт через узел node вдоль навеса,
 * навес — с той же стороны, в gap от кромки асфальта (как при постройке). Кромку берём самую дальнюю
 * по длине навеса — «кармашек» мог начаться у самой остановки. Ближе к улице, чем сейчас, навес не встаёт.
 */
export function curbFootprint(net: LaneNet, node: Vec, fp: Footprint, gap = 2): Footprint {
  const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const d = sub(fp.center, node);
  const n = dot(d, { x: -u.y, y: u.x }) >= 0 ? { x: -u.y, y: u.x } : { x: u.y, y: -u.x };
  let need = 0;
  for (let i = 0; i <= 6; i++) {
    const hit = streetAt(net, add(node, scale(u, (i / 6 - 0.5) * fp.w)));
    if (hit) need = Math.max(need, sideHalf(hit.c, hit.s, dot(n, rightNormal(hit.c.lut.tangentAt(hit.s)))));
  }
  const off = Math.max(dot(d, n), need + gap + fp.h / 2);
  return { ...fp, center: add(node, add(scale(u, dot(d, u)), scale(n, off))) };
}

/** Своя ли улица остановки полотно c: проходит по оси через её узел вдоль навеса (не чужая дорога поперёк). */
export function isStopStreet(c: Corridor, node: Vec, fp: Footprint): boolean {
  const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  for (let i = 0; i <= 6; i++) if (c.lut.closest(add(node, scale(u, (i / 6 - 0.5) * (fp.w + 4)))).d < 4) return true;
  return false;
}
