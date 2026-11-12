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
 *
 * Участок растёт (бригада дошла до следующего куска, работы только начались) — не сразу (grow): расширение пересаживает
 * машины с перекладываемой половины на полосу встречных, и если на новом куске ехали в обе стороны, они проезжали
 * друг сквозь друга (отчёт 0.2.129). Сначала стоп-линии въезда на новых концах — на красный, бригада ждёт, пока на
 * будущем участке не останутся машины одного хода (и зелёный — не навстречу им); тогда участок растёт.
 */
import { CONSTRUCTION } from '../config';
import { closureOf, laneWise, type ReverseSite, reverseSite, siteS, siteSpot } from '../lanes/closure';
import type { LaneGraph } from '../lanes/graph';
import type { Corridor, CorridorBuild, LaneNet } from '../lanes/model';
import type { Barrier } from '../lanes/traffic';
import type { Vehicle } from '../sim/vehicle';
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
  /** Участок по оси от a; дошёл до стыка — заходит на соседа (closure.ts, reverseSite): за концами оси. */
  zone: [number, number];
  /** Стоп-линии по оси от a: [идущих по оси, идущих против]; съезд на соседе — за концами оси (на соседе). */
  stops: [number, number];
  /** Соседи за стыками, куда заходит участок и где стоп-линия: [у a, у b]. */
  reach: ReverseSite['reach'];
  state: PhaseState;
  /** Стоп-линии для движения (LaneTraffic.signals): [по оси, против] — на полотнах on (своём или соседа). */
  barriers: [Barrier, Barrier];
  on: [number, number];
  /** Держат красный для бригады (hold), и участок уже пуст — ей можно разворачиваться. */
  clear?: boolean;
  /** Стоп-линии, когда кончился зелёный: очистка ждёт машины только там (WorkSignals.step). */
  clearZone?: [number, number];
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

/**
 * Каждая машина на полотне c и на соседях за стыками (reach) — по оси c: ход (как по ней) и место. moves — и машины на
 * манёврах, въезжающие на эти полотна (в узле перед ними): там, где начинается их полоса.
 */
function eachCar(graph: LaneGraph, c: Corridor, reach: ReverseSite['reach'], each: (flow: 1 | -1, s: number, v: Vehicle) => void, moves = false): void {
  const parts: { id: number; at: (s: number) => number; k: 1 | -1 }[] = [{ id: c.id, at: (s) => s, k: 1 }];
  reach.forEach((r, i) => r && parts.push({ id: r.corridor.id, at: (s) => siteS(c, r, i ? 'b' : 'a', s), k: r.k }));
  for (const p of parts) {
    for (const link of graph.corridorLinks(p.id)) {
      const flow = (link.flow * p.k) as 1 | -1;
      for (const lane of link.lanes) {
        for (const v of lane.vehicles) each(flow, p.at(v.centerS), v);
        if (!moves) continue;
        const start = p.at(link.flow > 0 ? link.s0 : link.s1);
        for (const m of graph.movesInto.get(lane.id) ?? []) for (const v of m.vehicles) each(flow, start, v);
      }
    }
  }
}

/** Тормозной путь, за который машина ещё встанет у стоп-линии, загоревшейся красным, м (замедление 4 м/с²). */
const brakeLen = (v: number) => (v * v) / 8;

/**
 * Можно ли участку стать site (Construction растит его, WorkSignals.grow): между его стоп-линиями (и не успевая встать
 * перед ними) — машины не больше чем одного хода f, и зелёный — не навстречу им (go — фаза светофора; его ещё нет —
 * null). Тогда после расширения на общей полосе нет встречных: светофор пустит других, только когда эти уедут.
 */
export function canGrow(graph: LaneGraph, c: Corridor, site: ReverseSite, go: Go | null): boolean {
  const [s0, s1] = site.stops;
  const flows = new Set<1 | -1>();
  eachCar(
    graph,
    c,
    site.reach,
    (flow, s, v) => {
      const lo = s0 - (flow > 0 ? brakeLen(v.v) + 0.2 : 1);
      const hi = s1 + (flow < 0 ? brakeLen(v.v) + 0.2 : 1);
      if (s > lo && s < hi) flows.add(flow);
    },
    true,
  );
  if (flows.size > 1) return false;
  const [f] = flows;
  return f === undefined || go !== -f;
}

/** Бригада ждёт расширения участка (grow): стоп-линии въезда на его новых концах — красные, пока ждёт. */
interface Want {
  barriers: Barrier[];
  /** Полотна стоп-линий (своё или сосед за стыком). */
  on: number[];
  /** Такт WorkSignals.step, когда бригада звала в последний раз. */
  at: number;
}

export class WorkSignals {
  list = new Map<number, WorkSignal>();
  private net: LaneNet | null = null;
  private ver = -1;
  /** Где бригада держит красный на этот такт (hold): номера полотен. */
  private holds = new Set<number>();
  /** Где бригада ждёт расширения участка (grow): номера полотен. */
  private wants = new Map<number, Want>();
  /** Такты step — чтобы забыть ожидание, которое бригада больше не зовёт. */
  private ticks = 0;

  /**
   * Такт до движения: участки — заново, если сеть поменялась (стройка ушла на другой кусок, проход сменился, правка);
   * фазы вперёд по машинам на графе; стоп-линии — в движение (signals).
   */
  step(dt: number, net: LaneNet, graph: LaneGraph, traffic: { signals: Map<number, Barrier[]> }): void {
    if (net !== this.net || net.version !== this.ver) this.sync(net, traffic);
    // Ожидание расширения, которое бригада больше не зовёт (расширила, ушла, стройку сняли), — забыть.
    this.ticks++;
    const had = this.wants.size;
    for (const [id, w] of this.wants) if (w.at < this.ticks - 1) this.wants.delete(id);
    if (had) this.publish(traffic);
    if (!this.list.size) return;
    for (const sig of this.list.values()) {
      const [s0, s1] = sig.stops;
      const c = net.corridors.get(sig.corridor);
      if (!c) continue;
      const L = c.length;
      // Машины на своём полотне и на соседях за стыками — по оси c (ход — как по ней).
      const count = (ok: (flow: 1 | -1, s: number) => boolean) => {
        let n = 0;
        eachCar(graph, c, sig.reach, (flow, s) => {
          if (ok(flow, s)) n++;
        });
        return n;
      };
      // Видно ли очередь: от стоп-линии назад до начала своего полотна (или соседа за стыком).
      const lo = sig.reach[0] ? -sig.reach[0].corridor.length : 0;
      const hi = sig.reach[1] ? L + sig.reach[1].corridor.length : L;
      const demand = (f: 1 | -1): number | null => {
        const n = count((flow, s) => flow === f && (f > 0 ? s < s0 && s > s0 - QUEUE_LOOK : s > s1 && s < s1 + QUEUE_LOOK));
        if (n > 0) return n;
        return (f > 0 ? s0 - lo : hi - s1) < BLIND ? null : 0;
      };
      if (this.holds.has(sig.corridor)) {
        // Бригада разворачивается — участок целиком должен быть пуст.
        const all = (f: 1 | -1) => count((flow, s) => flow === f && s > s0 - 1 && s < s1 + 1);
        holdPhase(sig, dt, s1 - s0, all);
      } else {
        sig.clear = false;
        // Очистка — участок, по которому ехали на прошлый зелёный: переехал во время очистки — только общее с ним. Иначе
        // бригада, идущая почти со скоростью машин, всё время «догоняет» уехавших вперёд, и очистка тянется до clearMax;
        // а ждущие у стоп-линии, переехавшей вперёд, уже не на участке. Вырос — и новый конец (sync): там уехавшие
        // вперёд уже на общей полосе, пустить встречных можно, только когда и они уедут.
        if (sig.state.go !== 0 || !sig.clearZone) sig.clearZone = [s0, s1];
        const c0 = Math.max(s0, sig.clearZone[0]);
        const c1 = Math.min(s1, sig.clearZone[1]);
        const inside = (f: 1 | -1) => count((flow, s) => flow === f && s > c0 - 1 && s < c1 + 1);
        stepPhase(sig.state, dt, Math.max(0, c1 - c0), demand, inside);
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
      const { zone, stops, reach } = reverseSite(net, c, c.build);
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
      // Стоп-линия — на своём полотне или на соседе за стыком (там ход по его оси).
      const on: [number, number] = [0, 0];
      ([1, -1] as const).forEach((flow, i) => {
        const spot = siteSpot(c, reach, stops[i]);
        barriers[i].s = spot.s;
        barriers[i].flow = (flow * spot.k) as 1 | -1;
        on[i] = spot.corridor.id;
      });
      barriers[0].closed = state.go !== 1;
      barriers[1].closed = state.go !== -1;
      // Очистка идёт, а участок вырос — очищать и новый конец: пустившиеся на прошлый зелёный едут по нему по общей полосе.
      const cz = old?.clearZone;
      const clearZone: [number, number] | undefined =
        old && cz ? [zone[0] < old.zone[0] - 0.01 ? Math.min(cz[0], stops[0]) : cz[0], zone[1] > old.zone[1] + 0.01 ? Math.max(cz[1], stops[1]) : cz[1]] : undefined;
      next.set(c.id, {
        corridor: c.id,
        zone,
        stops,
        reach,
        state,
        barriers,
        on,
        ...(old?.clear ? { clear: true } : {}),
        ...(clearZone ? { clearZone } : {}),
      });
    }
    this.list = next;
    this.publish(traffic);
  }

  /** Стоп-линии в движение (LaneTraffic.signals): светофоров участков и красные въезда у ждущих расширения (grow). */
  private publish(traffic: { signals: Map<number, Barrier[]> }): void {
    const map = new Map<number, Barrier[]>();
    const put = (id: number, b: Barrier) => map.set(id, [...(map.get(id) ?? []), b]);
    for (const sig of this.list.values()) sig.barriers.forEach((b, i) => put(sig.on[i], b));
    for (const w of this.wants.values()) w.barriers.forEach((b, i) => put(w.on[i], b));
    traffic.signals = map;
  }

  /**
   * Бригада вот-вот расширит участок под реверсом на полотне id (Construction, Host.zoneGate; build — стройка после
   * шага: следующий кусок или начало работ). Расширение пересаживает машины с перекладываемой половины на полосу
   * встречных: ехали там в обе стороны — проехали бы друг сквозь друга. Поэтому, пока бригада ждёт (зовёт каждый
   * такт), стоп-линии въезда на новых концах участка — красные (со следующего такта), а расширять можно, когда на
   * будущем участке машины одного хода и зелёный — не навстречу им (canGrow). true — можно сейчас; нет — ждать.
   */
  grow(net: LaneNet, graph: LaneGraph, id: number, build: CorridorBuild): boolean {
    const c = net.corridors.get(id);
    if (!c) return true;
    const site = reverseSite(net, c, build);
    const sig = this.list.get(id);
    if (canGrow(graph, c, site, sig ? sig.state.go : null)) {
      this.wants.delete(id);
      return true;
    }
    // Новые концы: участка ещё нет (работы начинаются) — оба.
    const ends = sig ? [site.zone[0] < sig.zone[0] - 0.01, site.zone[1] > sig.zone[1] + 0.01] : [true, true];
    const want: Want = { barriers: [], on: [], at: this.ticks };
    ([1, -1] as const).forEach((flow, i) => {
      if (!ends[i]) return;
      const spot = siteSpot(c, site.reach, site.stops[i]);
      want.barriers.push({ s: spot.s, closed: true, busy: false, flow: (flow * spot.k) as 1 | -1, stop: 0 });
      want.on.push(spot.corridor.id);
    });
    this.wants.set(id, want);
    return false;
  }

  /** Что горит у стоп-линии направления flow на полотне id: зелёный, жёлтый (очистка) или красный; светофора нет — null. */
  lamp(id: number, flow: 1 | -1): 'green' | 'red' | null {
    const sig = this.list.get(id);
    if (!sig) return null;
    return sig.state.go === flow ? 'green' : 'red';
  }
}
