import { COST } from '../config';
import { Cubic, minRadius } from '../core/bezier';
import { add, dist, dot, rightNormal, scale, sub, Vec } from '../core/vec';
import { Anchor, applyLane, buildRoad, bulldoze, bulldozeBox, EditError, LaneDraft, laneStep, LaneTip, RoadOptions, taperDeadLanes } from '../lanes/edit';
import { edgesAt, laneShare } from '../lanes/geometry';
import { Corridor, LaneNet, LaneSlot } from '../lanes/model';
import { LEVEL_RUN, RoadClass, ROAD_CLASSES, ROAD_MARGIN } from '../world/roadTypes';
import { halfAtS } from '../world/worldgen';
import type { Roads } from './roads';

/** Что строитель дорог знает об игре. */
export interface RoadContext {
  readonly roads: Roads;
  readonly budget: number;
  isWater(p: Vec, margin?: number): boolean;
  inBounds(p: Vec, margin?: number): boolean;
  /** Строения в точке: id, можно ли снести их ради дороги и узел въезда (у автостанции — торец её выезда). */
  obstaclesAt(p: Vec, radius: number): { id: number; demolishable: boolean; gate?: number }[];
  demolishCost(id: number): number;
  demolish(ids: number[]): void;
  spend(amount: number): void;
  refund(amount: number): void;
  networkChanged(): void;
  /** Что не так у полотна с путями: переезд под острым углом, мало места по высоте, слишком близко. */
  railConflict?(net: LaneNet, c: Corridor): string | undefined;
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
}

const fail = (reason: string): RoadPlan => ({ ok: false, reason, cost: 0, spend: 0, refund: 0, demolish: [], net: null, changed: [] });

/** Полуширина полотна с одной стороны оси (side ≥ 0 — справа по ходу a→b) вместе с обочиной. */
function sideHalf(c: Corridor, s: number, side: number): number {
  const e = edgesAt(c, s);
  return (e ? Math.max(0, side >= 0 ? e[1] : -e[0]) : 0) + ROAD_MARGIN;
}

/** Множитель цены в точке: мосты, эстакады и тоннели дороже земли. */
function structureFactor(h: number, water: boolean): number {
  if (water && h > -0.5) return 4;
  if (h > 0.25) return 1 + 1.5 * Math.min(h, 1) + 0.6 * Math.max(0, h - 1);
  if (h < -0.25) return 1 + 3 * Math.min(-h, 1) + (water ? 1 : 0);
  return 1;
}

/** Стоимость полотна: длина × полосы × цена класса × мост, эстакада или тоннель (над водой — вчетверо). */
export function corridorCost(net: LaneNet, c: Corridor, isWater: (p: Vec, margin?: number) => boolean): number {
  const n = Math.max(2, Math.ceil(c.length / 12));
  let cost = 0;
  for (let i = 0; i < n; i++) {
    const s = (c.length * (i + 0.5)) / n;
    const p = c.lut.pointAt(s);
    // Полосы — сколько их здесь на самом деле: пристроенная на кусок дороги стоит по своей длине (отгон — по ширине).
    const lanes = c.lanes.reduce((k, l) => k + laneShare(c, l, s), 0);
    cost += (c.length / n) * ROAD_CLASSES[c.cls].cost * lanes * structureFactor(net.heightAt(c, s), isWater(p, 2));
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
    edit: (net: LaneNet) => boolean | void,
    opts: { free?: boolean; shove?: boolean; raze?: boolean; trusted?: boolean; only?: (c: Corridor) => boolean } = {},
  ): RoadPlan {
    const before = this.net;
    const next = before.clone();
    try {
      if (edit(next) === false) return fail('Так не построить');
    } catch (e) {
      return fail(e instanceof EditError ? e.message : 'Так не построить');
    }
    // Что изменилось: новые полотна, полотна с новой ревизией и исчезнувшие.
    const changed: Corridor[] = [];
    let after = 0;
    let was = 0;
    const water = (p: Vec, m?: number) => this.ctx.isWater(p, m);
    for (const c of next.corridors.values()) {
      if (before.corridors.get(c.id)?.rev === c.rev) continue;
      changed.push(c);
      after += corridorCost(next, c, water);
    }
    for (const c of before.corridors.values()) {
      if (next.corridors.get(c.id)?.rev !== c.rev) was += corridorCost(before, c, water);
    }
    const demolish = new Set<number>();
    let reason: string | undefined;
    // Снос ничего не строит: оставшиеся куски дорог не проверяем и дома у них не сносим.
    // Развязка (trusted) проложена заранее: её куски вплотную друг к другу — так задумано, сверяем только с прочими дорогами.
    // only — что проверять (вставка: её полотна; разрезанные ею старые дороги — нет, у них дома не сносим).
    const own = opts.trusted ? new Set(changed.map((c) => c.id)) : null;
    for (const c of opts.raze ? [] : opts.only ? changed.filter(opts.only) : changed) {
      reason = this.check(next, c, demolish, !!opts.shove, own);
      if (reason) break;
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
    return plan;
  }

  /** Строит по плану: сносит дома, копия сети становится сетью, деньги списываются. */
  apply(plan: RoadPlan): boolean {
    if (!plan.ok || !plan.net) return false;
    if (plan.demolish.length) this.ctx.demolish(plan.demolish);
    this.ctx.roads.replace(plan.net);
    if (plan.spend) this.ctx.spend(plan.spend);
    if (plan.refund) this.ctx.refund(plan.refund);
    this.ctx.networkChanged();
    return true;
  }

  // ---------- Действия ----------

  /** Дорога между якорями (якоря — в текущей сети; в копии те же id). */
  road(a: Anchor, b: Anchor, o: RoadOptions, opts: { free?: boolean } = {}): RoadPlan {
    return this.plan((n) => buildRoad(n, a, b, o).length > 0, opts);
  }

  /** Полоса по черновику инструмента «Полоса». */
  lane(d: LaneDraft, cls: RoadClass): RoadPlan {
    // Дома у дороги не сносим: после стройки их отодвинут от неё (roadWidened), сносят — только если места нет.
    return this.plan((n) => applyLane(n, d, cls), { shove: true });
  }

  /**
   * Куски полосы по точкам от конца tip через qs (каждая точка — как следующий клик); step — новый конец
   * (в сети плана) и что построено.
   */
  laneStep(tip: LaneTip, qs: Vec[], cls: RoadClass, radius: number): { plan: RoadPlan; step: { tip: LaneTip; what: string } | null } {
    const out: { step: { tip: LaneTip; what: string } | null } = { step: null };
    const plan = this.plan(
      (n) => {
        let at = tip;
        const what: string[] = [];
        for (const q of qs) {
          const s = laneStep(n, at, q, cls, radius);
          at = s.tip;
          what.push(s.what);
        }
        out.step = { tip: at, what: what.join(' → ') };
        return qs.length > 0;
      },
      { shove: true },
    );
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

  /** Новая форма полотна (концы на месте). */
  reshape(id: number, curve: (net: LaneNet, c: Corridor) => Cubic): RoadPlan {
    return this.plan((n) => {
      const c = n.corridors.get(id);
      if (!c) return false;
      n.setCurve(c, curve(n, c));
    });
  }

  /** Перенос узла: дороги следом. */
  moveNode(id: number, pos: Vec): RoadPlan {
    return this.plan((n) => {
      if (!n.nodes.has(id)) return false;
      n.moveNode(id, pos);
    });
  }

  // ---------- Проверки ----------

  /** Что не так с полотном c в сети net; дома, которые придётся снести, — в demolish. */
  private check(net: LaneNet, c: Corridor, demolish: Set<number>, shove: boolean, own: Set<number> | null = null): string | undefined {
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
    const ends = [A.pos, B.pos];
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
          if (!o.demolishable) return 'Мешает здание';
          if (!shove) demolish.add(o.id);
        }
      }
      // Чужие дороги рядом на той же высоте: у общих узлов — можно (там перекрёсток или стык), в остальном — не ближе краёв.
      const nearEnd = ends.some((e) => dist(e, p) < 45);
      for (const o of net.corridorsNear(p, half + 40)) {
        if (o.id === c.id || own?.has(o.id)) continue;
        const shares = o.a === c.a || o.a === c.b || o.b === c.a || o.b === c.b;
        if (shares && nearEnd) continue;
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
