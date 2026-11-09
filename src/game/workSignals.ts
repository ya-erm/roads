/**
 * Временные светофоры реверса на перестройке «с проездом» узкой дороги (src/lanes/closure.ts, laneWise; правила —
 * docs/DESIGN.md, «Перестройка и перекрытия»). Пока бригада перекладывает одну половину полотна, на участке у неё
 * (reverseZone, куски по CONSTRUCTION.rebuild.reverse.chunk м) открыта одна полоса — по ней едут по очереди в обе
 * стороны. На каждом конце участка — светофор со стоп-линией (reverseStops): зелёный — одной стороне, потом красный
 * обеим, пока участок не опустеет, потом зелёный другой.
 *
 * Фазы (stepPhase, числа — CONSTRUCTION.rebuild.reverse):
 * - зелёный держится не меньше minGreen и, пока с другой стороны ждут, не дольше reverseGreen(длина участка): base +
 *   perSec × время проезда участка на скорости зоны работ, в пределах green; с другой стороны никого — зелёный горит
 *   дальше, со своей стороны больше никто не подъезжает — переключается раньше;
 * - красный обеим (очистка): пока на участке есть машины, пустившиеся на прошлый зелёный, но не меньше allRed и не
 *   дольше двух проездов по участку и ещё 10 с (застрявшая машина не держит светофор вечно);
 * - очередь у стоп-линии видна только на своём полотне; стоп-линия у самого узла (очередь — за ним) — спрос «не
 *   виден» и считается, что он есть: светофор работает по времени, как обычный временный.
 * Участок переехал на следующий кусок — светофоры встают на новые места, фазы идут дальше (бригада проходит кусок
 * быстрее, чем светофор делает круг: сброс к очистке отдавал бы зелёный всё время одной стороне). Состояние не
 * сохраняется: после загрузки и у нового участка светофор начинает с очистки.
 */
import { CONSTRUCTION } from '../config';
import { closureOf, endCuts, laneWise, reverseStops, reverseZone } from '../lanes/closure';
import type { LaneGraph } from '../lanes/graph';
import type { LaneNet } from '../lanes/model';
import type { Barrier } from '../lanes/traffic';
import { KMH_PER_UNIT } from '../world/roadTypes';

/** Кому зелёный: идущим по оси полотна (1), против (−1) или никому — очистка участка (0). */
export type Go = 1 | -1 | 0;

export interface PhaseState {
  go: Go;
  /** Кому зелёный после очистки. */
  next: 1 | -1;
  /** Сколько секунд горит нынешняя фаза. */
  t: number;
}

/** Светофоры одного участка под реверсом. */
export interface WorkSignal {
  corridor: number;
  zone: [number, number];
  /** Стоп-линии по оси от a: [идущих по оси, идущих против]. */
  stops: [number, number];
  state: PhaseState;
  /** Стоп-линии для движения (LaneTraffic.signals): [по оси, против]. */
  barriers: [Barrier, Barrier];
  /** Держат красный для бригады (hold), и участок уже пуст — ей можно разворачиваться. */
  clear?: boolean;
}

/** Секунд ехать по участку длиной len на скорости зоны работ. */
export function crossTime(len: number): number {
  return Math.max(0, len) / (CONSTRUCTION.rebuild.zone / KMH_PER_UNIT);
}

/** Зелёный реверса, с, на участке длиной len (между стоп-линиями): base + perSec × проезд, в пределах green. */
export function reverseGreen(len: number): number {
  const K = CONSTRUCTION.rebuild.reverse;
  return Math.max(K.green[0], Math.min(K.green[1], K.base + K.perSec * crossTime(len)));
}

/** Самая долгая очистка участка длиной len, с: два проезда по нему и ещё 10 с. */
export function clearMax(len: number): number {
  return 2 * crossTime(len) + 10;
}

/**
 * Фаза вперёд на dt. len — участок между стоп-линиями; demand(f) — сколько машин направления f у его стоп-линии (null —
 * не видно, считается, что есть); inside(f) — машин направления f на участке между стоп-линиями.
 */
export function stepPhase(s: PhaseState, dt: number, len: number, demand: (f: 1 | -1) => number | null, inside: (f: 1 | -1) => number): void {
  const K = CONSTRUCTION.rebuild.reverse;
  s.t += dt;
  if (s.go === 0) {
    const prev = -s.next as 1 | -1;
    if ((inside(prev) === 0 && s.t >= K.allRed) || s.t >= clearMax(len)) {
      s.go = s.next;
      s.t = 0;
    }
    return;
  }
  if (s.t < K.minGreen) return;
  const other = -s.go as 1 | -1;
  // С другой стороны никого — зелёный горит дальше.
  if (demand(other) === 0) return;
  if (s.t >= reverseGreen(len) || demand(s.go) === 0) {
    s.next = other;
    s.go = 0;
    s.t = 0;
  }
}

/**
 * Фаза вперёд на dt, пока бригада держит красный (WorkSignals.hold): зелёный, отгоревший minGreen, — сразу на очистку;
 * очистка не кончается. Участок пуст (не раньше allRed; застрявшая машина — не дольше clearMax) — sig.clear.
 */
export function holdPhase(sig: WorkSignal, dt: number, len: number, inside: (f: 1 | -1) => number): void {
  const K = CONSTRUCTION.rebuild.reverse;
  const s = sig.state;
  s.t += dt;
  if (s.go !== 0 && s.t >= K.minGreen) {
    s.next = -s.go as 1 | -1;
    s.go = 0;
    s.t = 0;
  }
  sig.clear = s.go === 0 && ((inside(1) === 0 && inside(-1) === 0 && s.t >= K.allRed) || s.t >= clearMax(len));
}

/** Как далеко от стоп-линии видна очередь, м. */
const QUEUE_LOOK = 150;
/** Стоп-линия ближе стольких метров к концу полотна — очередь за узлом, её не видно. */
const BLIND = 40;

export class WorkSignals {
  list = new Map<number, WorkSignal>();
  private net: LaneNet | null = null;
  private ver = -1;
  /** Где бригада держит красный на этот такт (hold): номера полотен. */
  private holds = new Set<number>();

  /**
   * Такт до движения: участки — заново, если сеть поменялась (стройка ушла на другой кусок, проход сменился, правка);
   * фазы вперёд по машинам на графе; стоп-линии — в движение (signals).
   */
  step(dt: number, net: LaneNet, graph: LaneGraph, traffic: { signals: Map<number, Barrier[]> }): void {
    if (net !== this.net || net.version !== this.ver) this.sync(net, traffic);
    if (!this.list.size) return;
    for (const sig of this.list.values()) {
      const [s0, s1] = sig.stops;
      const links = graph.corridorLinks(sig.corridor);
      const c = net.corridors.get(sig.corridor);
      const L = c?.length ?? s1;
      const count = (ok: (flow: 1 | -1, s: number) => boolean) => {
        let n = 0;
        for (const link of links) for (const lane of link.lanes) for (const v of lane.vehicles) if (ok(link.flow, v.centerS)) n++;
        return n;
      };
      const demand = (f: 1 | -1): number | null => {
        const n = count((flow, s) => flow === f && (f > 0 ? s < s0 && s > s0 - QUEUE_LOOK : s > s1 && s < s1 + QUEUE_LOOK));
        if (n > 0) return n;
        return (f > 0 ? s0 : L - s1) < BLIND ? null : 0;
      };
      const inside = (f: 1 | -1) => count((flow, s) => flow === f && s > s0 - 1 && s < s1 + 1);
      if (this.holds.has(sig.corridor)) holdPhase(sig, dt, s1 - s0, inside);
      else {
        sig.clear = false;
        stepPhase(sig.state, dt, s1 - s0, demand, inside);
      }
      sig.barriers[0].closed = sig.state.go !== 1;
      sig.barriers[1].closed = sig.state.go !== -1;
    }
    this.holds.clear();
  }

  /**
   * Бригада разворачивается через обе половины полотна id (Construction, Host.turnGate): со следующего такта обеим
   * сторонам — красный (зелёный, отгоревший minGreen, кончается сразу), пока зовут каждый такт. true — участок под
   * реверсом уже пуст (или светофора нет): можно разворачиваться.
   */
  hold(id: number): boolean {
    this.holds.add(id);
    const sig = this.list.get(id);
    return !sig || !!sig.clear;
  }

  /** Участки под реверсом — по сети: переехавший — с теми же фазами, новый — с очистки (на нём могут быть машины). */
  private sync(net: LaneNet, traffic: { signals: Map<number, Barrier[]> }): void {
    this.net = net;
    this.ver = net.version;
    const next = new Map<number, WorkSignal>();
    for (const c of net.corridors.values()) {
      if (!c.build || closureOf(c.build) !== 'part' || !laneWise(c.build)) continue;
      const zone = reverseZone(c, c.build, endCuts(net, c));
      const stops = reverseStops(c, c.build, zone);
      // Участок переехал на следующий кусок — фазы идут дальше (сброс отдавал бы зелёный всё время одной стороне:
      // бригада проходит кусок быстрее, чем светофор — круг); новый участок — с очистки.
      const old = this.list.get(c.id);
      const state: PhaseState = old ? old.state : { go: 0, next: 1, t: 0 };
      const barriers: [Barrier, Barrier] = old
        ? old.barriers
        : [
            { s: stops[0], closed: true, busy: false, flow: 1, stop: 0 },
            { s: stops[1], closed: true, busy: false, flow: -1, stop: 0 },
          ];
      barriers[0].s = stops[0];
      barriers[1].s = stops[1];
      barriers[0].closed = state.go !== 1;
      barriers[1].closed = state.go !== -1;
      next.set(c.id, { corridor: c.id, zone, stops, state, barriers, ...(old?.clear ? { clear: true } : {}) });
    }
    this.list = next;
    const map = new Map<number, Barrier[]>();
    for (const sig of next.values()) map.set(sig.corridor, sig.barriers);
    traffic.signals = map;
  }

  /** Что горит у стоп-линии направления flow на полотне id: зелёный, жёлтый (очистка) или красный; светофора нет — null. */
  lamp(id: number, flow: 1 | -1): 'green' | 'red' | null {
    const sig = this.list.get(id);
    if (!sig) return null;
    return sig.state.go === flow ? 'green' : 'red';
  }
}
