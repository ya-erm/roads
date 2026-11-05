import type { Vec } from '../core/vec';
import { dist } from '../core/vec';
import { GLane, GLink, GMove, LaneGraph } from '../lanes/graph';
import { LaneNet, LaneNode } from '../lanes/model';
import { findLaneRoute, linkCost, transitionCost } from '../lanes/routing';
import { PROFILE_STEP } from '../lanes/speedProfile';
import { changePenalty, CURB_PULL, keepRightCost, LaneTraffic, LaneTrafficEvents, LATE_CHANGE } from '../lanes/traffic';
import type { TrackPiece } from './speedChart';

/** Размер кольца: радиус оси (если примыкающие дороги шире, кольцо будет больше). */
export type RingSize = 'small' | 'medium' | 'large';
export const RING_SIZES: Record<RingSize, number> = { small: 30, medium: 46, large: 66 };

export interface RingOptions {
  lanes: number;
  size: RingSize;
}

export const DEFAULT_RING: RingOptions = { lanes: 1, size: 'small' };

/**
 * Дороги игры: сеть полос (что построено), граф движения по ней (пересобирается после правок)
 * и машины. Маршруты — списки связей графа между узлами, где можно начать и кончить поездку.
 */
export class Roads {
  net = new LaneNet();
  graph: LaneGraph;
  readonly traffic: LaneTraffic;
  private graphOf: { net: LaneNet; version: number };

  constructor(events: LaneTrafficEvents) {
    this.graph = new LaneGraph(this.net);
    this.graphOf = { net: this.net, version: this.net.version };
    this.traffic = new LaneTraffic(this.graph, events);
  }

  /** Сеть поменялась (стройка, рост города): граф заново, машины переезжают на него. */
  changed(): void {
    if (this.graphOf.net === this.net && this.graphOf.version === this.net.version) return;
    this.graph = new LaneGraph(this.net);
    this.graphOf = { net: this.net, version: this.net.version };
    this.traffic.rebind(this.graph);
  }

  /** Новая сеть целиком (загрузка, отмена). */
  replace(net: LaneNet): void {
    this.net = net;
    this.changed();
  }

  /** Узел, где можно начать и кончить поездку: перекрёсток или тупик (через стык полосы просто идут дальше). */
  routable(id: number): boolean {
    const n = this.net.nodes.get(id);
    return !!n && (n.kind === 'junction' || this.net.isDeadEnd(n));
  }

  /** Ближайший к точке узел, где можно начать и кончить поездку. */
  nearestRoutable(p: Vec, r: number): LaneNode | null {
    let best: LaneNode | null = null;
    for (const n of this.net.nodesNear(p, r)) {
      if (!this.routable(n.id)) continue;
      if (!best || dist(n.pos, p) < dist(best.pos, p)) best = n;
    }
    return best;
  }

  /** Маршрут между узлами: связи графа; нет пути — null. */
  route(from: number, to: number): number[] | null {
    if (from === to) return null;
    return findLaneRoute(this.graph, this.graph.outLinks.get(from) ?? [], to);
  }

  /**
   * Маршрут дальше, как едет автобус от остановки: приехал по связи arrived в её узел (стык на улице) —
   * едет за узел в ту же сторону, а не разворачивается в нём. Продолжения нет — null.
   */
  continueRoute(arrived: number, to: number): number[] | null {
    const g = this.graph;
    const link = g.links.get(arrived);
    if (!link) return null;
    const outs = new Set<number>();
    for (const lane of link.lanes) for (const m of g.movesFrom.get(lane.id) ?? []) if (m.cont) outs.add(m.outLink);
    const starts = [...outs].map((id) => g.links.get(id)).filter((l): l is GLink => !!l);
    return starts.length ? findLaneRoute(g, starts, to) : null;
  }

  /** Обратная Дейкстра от цели: ближайший узел из candidates и маршрут от него до цели. */
  nearestSource(goal: number, candidates: Set<number>, maxCost = Infinity): { source: number; route: number[]; cost: number } | null {
    const g = this.graph;
    const cost = new Map<number, number>();
    const next = new Map<number, number>();
    const open: { c: number; link: GLink }[] = [];
    for (const link of g.inLinks.get(goal) ?? []) {
      cost.set(link.id, linkCost(link));
      open.push({ c: linkCost(link), link });
    }
    const closed = new Set<number>();
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].c < open[bi].c) bi = i;
      const { c, link } = open.splice(bi, 1)[0];
      if (c > maxCost) return null;
      if (closed.has(link.id)) continue;
      closed.add(link.id);
      if (link.fromNode !== null && candidates.has(link.fromNode)) {
        const route = [link.id];
        while (next.has(route[route.length - 1])) route.push(next.get(route[route.length - 1])!);
        return { source: link.fromNode, route, cost: c };
      }
      for (const prevId of g.linkPrev.get(link.id) ?? []) {
        const before = g.links.get(prevId);
        if (!before || closed.has(prevId)) continue;
        const nc = c + transitionCost(g, before, link) + linkCost(before);
        if (nc < (cost.get(prevId) ?? Infinity)) {
          cost.set(prevId, nc);
          next.set(prevId, link.id);
          open.push({ c: nc, link: before });
        }
      }
    }
    return null;
  }

  /** Длина маршрута. */
  routeLength(route: number[]): number {
    return route.reduce((sum, id) => sum + (this.graph.links.get(id)?.length ?? 0), 0);
  }

  /**
   * Маршрут по участкам с пределом скорости — для графика скорости линии: по полосе — разрешённая и по
   * изгибам (шагом профиля полосы, с уклоном), на перекрёстке — манёвра. Полоса на связи — самая правая
   * из тех, откуда можно проехать дальше (грузовики и автобусы держатся правее). null — маршрута нет.
   */
  routeTrack(route: number[]): TrackPiece[] | null {
    const g = this.graph;
    const links = route.map((id) => g.links.get(id));
    if (!links.length || links.some((l) => !l)) return null;
    const pieces: TrackPiece[] = [];
    const rightmost = <T>(xs: T[], index: (x: T) => number) => xs.reduce((a, b) => (index(b) > index(a) ? b : a));
    for (let k = 0; k < links.length; k++) {
      const link = links[k]!;
      const next = links[k + 1];
      const moves = next ? link.lanes.flatMap((l) => (g.movesFrom.get(l.id) ?? []).filter((m) => m.outLink === next.id)) : [];
      const from = moves.length ? link.lanes.filter((l) => moves.some((m) => m.inLane === l.id)) : link.lanes;
      const lane = rightmost(from, (l) => l.index);
      const prof = this.traffic.profile(lane);
      for (let i = 0; i < prof.c.length; i++) {
        const s0 = i * PROFILE_STEP;
        const s1 = Math.min(lane.length, s0 + PROFILE_STEP);
        if (s1 <= s0) break;
        const c = Math.min(prof.c[i], prof.c[Math.min(prof.c.length - 1, i + 1)]);
        pieces.push({ length: s1 - s0, cap: Math.min(lane.speed, c), grade: prof.g[i], from: g.lanePose(lane, s0).pos, to: g.lanePose(lane, s1).pos });
      }
      const mine = moves.filter((m) => m.inLane === lane.id);
      const move = mine.length ? rightmost(mine, (m) => g.lanes.get(m.outLane)?.index ?? 0) : null;
      if (!move || !(move.length > 0)) continue;
      // Манёвр — по его кривой: отрезками между её точками (длины — в долях длины манёвра).
      const pts = move.points;
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
      if (pts.length < 2 || total <= 0) {
        pieces.push({ length: move.length, cap: move.speed, grade: 0 });
        continue;
      }
      for (let i = 1; i < pts.length; i++) {
        const part = dist(pts[i - 1], pts[i]);
        if (part > 0) pieces.push({ length: (move.length * part) / total, cap: move.speed, grade: 0, from: pts[i - 1], to: pts[i] });
      }
    }
    return pieces;
  }

  /**
   * Линия маршрута для карты — по полосам, которыми поедут машины: с наименьшей трудностью перестроений
   * (как их выбирают сами машины; автобусы — keepRight — держатся правее), перестроение — плавно в начале
   * связи (там, где его и делают машины), повороты — по кривым манёвров.
   */
  routePolyline(route: number[], keepRight = false): Vec[] {
    const g = this.graph;
    const links = route.map((id) => g.links.get(id)).filter((l): l is GLink => !!l);
    if (!links.length) return [];
    const exits = (k: number, o: GLane) => (k + 1 < links.length ? (g.movesFrom.get(o.id) ?? []).filter((m) => m.outLink === links[k + 1].id) : []);
    // С конца: out — трудность дальше, если покинуть связь k по полосе; enter — если въехать на неё по полосе.
    const out: Map<number, number>[] = new Array(links.length);
    const enter: Map<number, number>[] = new Array(links.length);
    for (let k = links.length - 1; k >= 0; k--) {
      const link = links[k];
      // К цели — к бордюру, как едут сами машины (в «кармашек» у остановки).
      const last = (o: GLane) => (link.lanes.length - 1 - o.index) * CURB_PULL;
      const ahead = (o: GLane) => Math.min(Infinity, ...exits(k, o).map((m) => enter[k + 1].get(m.outLane) ?? Infinity));
      out[k] = new Map(
        link.lanes.map((o) => [o.id, (k === links.length - 1 ? last(o) : ahead(o)) + keepRightCost(link.lanes.length, o.index, keepRight)]),
      );
      // Как у машин: то же перестроение дальше по пути чуть труднее — при равенстве перестраиваются раньше.
      const late = 1 + LATE_CHANGE * k;
      enter[k] = new Map(
        link.lanes.map((l) => [l.id, Math.min(...link.lanes.map((o) => changePenalty(Math.abs(o.index - l.index), link.length) * late + out[k].get(o.id)!))]),
      );
    }
    const pts: Vec[] = [];
    // Отправляются от бордюра (из «кармашка» у остановки): крайняя правая полоса, с которой можно доехать.
    const ok = links[0].lanes.filter((l) => Number.isFinite(enter[0].get(l.id) ?? Infinity));
    let lane = (ok.length ? ok : links[0].lanes).reduce((a, b) => (b.index > a.index ? b : a));
    for (let k = 0; k < links.length; k++) {
      const link = links[k];
      // Куда перестроиться на этой связи (сама полоса — при равенстве).
      let to = lane;
      let cost = out[k].get(lane.id) ?? Infinity;
      for (const o of link.lanes) {
        const c = changePenalty(Math.abs(o.index - lane.index), link.length) * (1 + LATE_CHANGE * k) + (out[k].get(o.id) ?? Infinity);
        if (c < cost - 1e-6) {
          to = o;
          cost = c;
        }
      }
      const steps = Math.max(2, Math.ceil(link.length / 8));
      // Перестраиваются сразу, как только можно (в «кармашек» — в самом его начале): плавно на первых метрах связи.
      // Как и у машины: перестроение — за 15–20 м (её боковой сдвиг), сразу в начале связи. Автобус из крайней
      // правой («кармашка») выезжает в её конце.
      const span = Math.min(18, link.length * 0.5);
      const late = keepRight && to.index < lane.index && lane.index === link.lanes.length - 1;
      const from = late ? Math.max(0, link.length - span - Math.min(2, link.length * 0.05)) : Math.min(2, link.length * 0.05);
      for (let i = 0; i <= steps; i++) {
        const s = (link.length * i) / steps;
        const a = g.lanePose(lane, s).pos;
        if (to === lane) {
          pts.push(a);
          continue;
        }
        const b = g.lanePose(to, s).pos;
        const t = Math.max(0, Math.min(1, (s - from) / span));
        const w = t * t * (3 - 2 * t);
        pts.push({ x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w });
      }
      if (k + 1 === links.length) break;
      const move = exits(k, to).reduce<GMove | null>((m, x) => (!m || (enter[k + 1].get(x.outLane) ?? Infinity) < (enter[k + 1].get(m.outLane) ?? Infinity) ? x : m), null);
      const next = move && g.lanes.get(move.outLane);
      if (!move || !next) {
        lane = links[k + 1].lanes[Math.floor(links[k + 1].lanes.length / 2)];
        continue;
      }
      pts.push(...move.points);
      lane = next;
    }
    return pts;
  }
}
