import { COST } from '../config';
import { Cubic, minRadius } from '../core/bezier';
import { dist, Vec } from '../core/vec';
import { Anchor, applyLane, buildRoad, bulldoze, LaneDraft, RoadOptions } from '../lanes/edit';
import { Corridor, LaneNet, LaneSlot } from '../lanes/model';
import { RoadClass, ROAD_CLASSES } from '../world/roadTypes';
import { halfAtS } from '../world/worldgen';
import type { Roads } from './roads';

/** Что строитель дорог знает об игре. */
export interface RoadContext {
  readonly roads: Roads;
  readonly budget: number;
  isWater(p: Vec, margin?: number): boolean;
  inBounds(p: Vec, margin?: number): boolean;
  /** Строения в точке: id и можно ли снести их ради дороги. */
  obstaclesAt(p: Vec, radius: number): { id: number; demolishable: boolean }[];
  demolishCost(id: number): number;
  demolish(ids: number[]): void;
  spend(amount: number): void;
  refund(amount: number): void;
  networkChanged(): void;
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

/** Стоимость полотна: длина × полосы × цена класса; над водой — мост, вчетверо дороже. */
export function corridorCost(c: Corridor, isWater: (p: Vec, margin?: number) => boolean): number {
  const n = Math.max(2, Math.ceil(c.length / 12));
  let cost = 0;
  for (let i = 0; i < n; i++) {
    const p = c.lut.pointAt((c.length * (i + 0.5)) / n);
    cost += (c.length / n) * ROAD_CLASSES[c.cls].cost * c.lanes.length * (isWater(p, 2) ? 4 : 1);
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

  /** Правка на копии сети и её проверка. */
  plan(edit: (net: LaneNet) => boolean | void, opts: { free?: boolean } = {}): RoadPlan {
    const before = this.net;
    const next = before.clone();
    try {
      if (edit(next) === false) return fail('Так не построить');
    } catch {
      return fail('Так не построить');
    }
    // Что изменилось: новые полотна, полотна с новой ревизией и исчезнувшие.
    const changed: Corridor[] = [];
    let after = 0;
    let was = 0;
    for (const c of next.corridors.values()) {
      if (before.corridors.get(c.id)?.rev === c.rev) continue;
      changed.push(c);
      after += corridorCost(c, (p, m) => this.ctx.isWater(p, m));
    }
    for (const c of before.corridors.values()) {
      if (next.corridors.get(c.id)?.rev !== c.rev) was += corridorCost(c, (p, m) => this.ctx.isWater(p, m));
    }
    const demolish = new Set<number>();
    let reason: string | undefined;
    for (const c of changed) {
      reason = this.check(next, c, demolish);
      if (reason) break;
    }
    // Новые беды сети (оборванные полосы и т. п.) — только те, что появились от этой правки.
    if (!reason) {
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
    return this.plan((n) => applyLane(n, d, cls));
  }

  /** Снос полотен. */
  bulldoze(ids: number[]): RoadPlan {
    return this.plan((n) => {
      for (const id of ids) bulldoze(n, id);
      return ids.length > 0;
    });
  }

  /** Другие полосы, класс и ограничение скорости у полотна. */
  rebuild(id: number, p: { cls: RoadClass; lanes: LaneSlot[]; limit?: number }): RoadPlan {
    return this.plan((n) => {
      const c = n.corridors.get(id);
      if (!c) return false;
      c.cls = p.cls;
      c.limit = p.limit;
      n.setLanes(c, p.lanes);
    });
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
  private check(net: LaneNet, c: Corridor, demolish: Set<number>): string | undefined {
    if (c.length < 8) return 'Слишком коротко';
    const limit = ROAD_CLASSES[c.cls].minRadius;
    if (minRadius(c.curve) < limit * 0.7) return 'Слишком крутой поворот';
    const ends = [net.node(c.a).pos, net.node(c.b).pos];
    const step = 6;
    for (let s = 0; s <= c.length; s += step) {
      const p = c.lut.pointAt(s);
      const half = halfAtS(c, s);
      if (!this.ctx.inBounds(p, 20)) return 'За краем карты';
      if (this.ctx.isWater(p, -half * 0.3)) return 'Через воду — мосты будут позже';
      for (const o of this.ctx.obstaclesAt(p, half + 1)) {
        if (!o.demolishable) return 'Мешает здание';
        demolish.add(o.id);
      }
      // Чужие дороги рядом: у общих узлов — можно (там перекрёсток или стык), в остальном — не ближе краёв.
      const nearEnd = ends.some((e) => dist(e, p) < 45);
      for (const o of net.corridorsNear(p, half + 40)) {
        if (o.id === c.id) continue;
        const shares = o.a === c.a || o.a === c.b || o.b === c.a || o.b === c.b;
        if (shares && nearEnd) continue;
        const hit = o.lut.closest(p);
        if (hit.d < half + halfAtS(o, hit.s) - 1 && !(nearEnd && shares)) {
          // Касание у самого чужого узла (дорога к нему подходит) — проверит узел.
          if (dist(hit.point, net.node(o.a).pos) < 2 || dist(hit.point, net.node(o.b).pos) < 2) continue;
          return 'Слишком близко к другой дороге';
        }
      }
    }
    return undefined;
  }
}
