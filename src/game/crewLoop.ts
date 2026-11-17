import { add, dist, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import { LaneGraph, type GLane } from '../lanes/graph';
import type { Corridor } from '../lanes/model';
import { GLIDE_SLOPE, type LaneTraffic } from '../lanes/traffic';
import { follow, hitchOf, jointOf, steerBase, trailDir, type VehicleBody } from '../sim/body';
import type { Vehicle } from '../sim/vehicle';
import type { Footprint } from '../world/spatial';
import { halfAtS } from '../world/worldgen';

/**
 * Разворот техники бригады петлёй — в «кармане» у дороги, а не в тупике (docs/DESIGN.md, стройка: «Проект кончился
 * тупиком»).
 *
 * Машине бригады в потоке впереди по маршруту разворот в тупике (проект кончился тупиком или у выезда станции):
 * развернуться там, как все машины, — нос по крутой кривой между полосами, а машина длиной 18–22 м на полотне 1+1
 * шириной ~11 м развернуться не может: её крутило на месте, а у грузовой станции — прямо на площадке у постов, поверх
 * грузовиков. Теперь она встаёт на дороге ближе всего к тупику там, где рядом есть место (planLoop: постройки, станция с
 * площадкой перед постами, предприятия, вода, чужие дороги и пути не мешают), и разворачивается одной петлёй вперёд,
 * без заднего хода: в сторону с дороги, большой дугой (радиус по задней оси LOOP.r) через дорогу и обратно — во
 * встречную полосу, носом назад, и прямо, пока вторая часть кузова не ляжет вдоль полосы. Курс — по касательной к следу
 * задней оси (как у машины на руле), поэтому он меняется не быстрее, чем позволяет радиус: никакого вращения на месте.
 * Карман справа или слева — где меньше заезжать за асфальт; нигде нет места — разворот в тупике, как раньше.
 *
 * Разворачиваются по одной: машина ждёт, пока место разворота не опустеет и не освободится от других разворотов, а
 * встречных и попутных, кто доедет туда раньше, чем она развернётся, останавливают (регулировщик: holdAfter перед
 * местом, flag; держит место уже с подъезда, LOOP.near) — и грузовики со станции (с постов их не выпускают, busyAt), и
 * другие машины колонны. Пока машина на петле, в потоке она уже стоит во встречной полосе, где петля кончится
 * (traffic.relocate): за ней встают те, кто едет оттуда, а попутная свободна — следующие машины колонны подъезжают и
 * успевают съехать с оси дороги в свою полосу (колонна у тупика встаёт заранее, Construction.deadEndRoom). Развернулась
 * — ждёт, пока впереди по встречной никто не стоит поперёк её пути (съезжающая с оси машина колонны), и едет дальше в
 * потоке; пока не проехала свою длину, рядом с ней тоже никого не пускают.
 *
 * Не сохраняется: колонна в потоке не сохраняется (после загрузки бригада выезжает заново).
 */
export const LOOP = {
  /** Радиус петли по задней оси, м. */
  r: 8,
  /** Скорость на петле, м/с игры (~25 км/ч), разгон и торможение, м/с². */
  speed: 7,
  accel: 2,
  /** Разворот в тупике ближе стольких метров по маршруту — петлёй. */
  look: 250,
  /** Место петли ищется от тупика назад к машине шагом step, м. */
  step: 5,
  /** На столько метров за конец петли машина ещё идёт прямо (кузов ложится вдоль полосы). */
  run: 2,
  /** Конец петли (нос) — не дальше стольких метров позади носа в начале. */
  back: 6,
  /** Запас вокруг кузова: чужие машины ближе — мешают. */
  margin: 0.6,
  /**
   * Петля не ближе стольких метров к станции: перед постами — площадка, где грузовики заезжают на посты (и разворотная
   * «шляпка» тупика у ворот, ~15 м от постов), на ней и у её края не разворачиваются.
   */
  yard: 18,
  /** Развернувшаяся проезжает мимо стоящей и впритирку: столько кузова (с каждой стороны) не в счёт. */
  tight: 0.2,
  /** Регулировщик останавливает тех, кто в стольких метрах от места разворота (по их маршруту). */
  flag: 120,
  /** Машина ближе стольких метров к месту своей петли — регулировщик уже держит место и её саму. */
  near: 40,
  /** Как часто (с) решать, кого держать регулировщику и можно ли начинать петлю. */
  every: 0.2,
  /** Торможение остановленных регулировщиком, м/с². */
  brake: 4,
  /** Развернувшаяся ждёт, пока впереди не освободится, не дольше, с; ждущая начала — не дольше, с (дальше — тупик). */
  exitWait: 20,
  startWait: 60,
};

/** Корпус машины (или часть машины из двух): середина, курс, полудлина и полуширина. */
export interface Box {
  c: Vec;
  d: Vec;
  hl: number;
  hw: number;
}

/** Что нужно знать о машине, чтобы найти её корпус: нос, курс, вторая часть, размеры и кузов. */
export interface BodyLook {
  pos: Vec;
  dir: Vec;
  trail?: Vec;
  length: number;
  width: number;
  body?: VehicleBody;
}

/** Корпус машины прямоугольниками (у машины из двух частей — два: первая часть и вторая по своему курсу), с запасом grow. */
export function bodyBoxes(m: BodyLook, grow = 0): Box[] {
  const L = m.length;
  const hw = m.width / 2 + grow;
  const h = hitchOf(m.body);
  if (!h) return [{ c: sub(m.pos, scale(m.dir, L / 2)), d: m.dir, hl: L / 2 + grow, hw }];
  const front = h.front * L;
  const joint = jointOf(m.pos, m.dir, L, h);
  const td = trailDir(joint, m.trail, m.dir);
  const gap = Math.max(0, h.back - h.joint) * L;
  const rest = (1 - h.back) * L;
  return [
    { c: sub(m.pos, scale(m.dir, front / 2)), d: m.dir, hl: front / 2 + grow, hw },
    { c: sub(joint, scale(td, gap + rest / 2)), d: td, hl: rest / 2 + grow, hw },
  ];
}

/** Пересекаются ли прямоугольники (по разделяющим осям). */
export function boxesOverlap(a: Box, b: Box): boolean {
  const cx = a.c.x - b.c.x;
  const cy = a.c.y - b.c.y;
  // Далеко друг от друга (дальше описанных окружностей) — сразу нет: так почти все пары.
  const reach = a.hl + a.hw + b.hl + b.hw;
  if (cx * cx + cy * cy > reach * reach) return false;
  // По разделяющим осям: курсы обоих и поперёк них.
  return !(
    apart(a, b, cx, cy, a.d.x, a.d.y) ||
    apart(a, b, cx, cy, -a.d.y, a.d.x) ||
    apart(a, b, cx, cy, b.d.x, b.d.y) ||
    apart(a, b, cx, cy, -b.d.y, b.d.x)
  );
}

/** Проекции прямоугольников на ось (ux, uy) не пересекаются (c — от середины b к середине a). */
function apart(a: Box, b: Box, cx: number, cy: number, ux: number, uy: number): boolean {
  const ra = Math.abs(a.d.x * ux + a.d.y * uy) * a.hl + Math.abs(-a.d.y * ux + a.d.x * uy) * a.hw;
  const rb = Math.abs(b.d.x * ux + b.d.y * uy) * b.hl + Math.abs(-b.d.y * ux + b.d.x * uy) * b.hw;
  return Math.abs(cx * ux + cy * uy) > ra + rb;
}

const anyOverlap = (a: readonly Box[], b: readonly Box[]): boolean => a.some((x) => b.some((y) => boxesOverlap(x, y)));

/** Прямоугольник корпуса — площадкой (для проверок построек). */
const boxFp = (b: Box): Footprint => ({ center: b.c, w: b.hl * 2, h: b.hw * 2, angle: Math.atan2(b.d.y, b.d.x) });

/** Точки корпуса для проверки, на дороге ли он: углы, середина и по длинным сторонам через ~3 м. */
function probes(b: Box): Vec[] {
  const n = rightNormal(b.d);
  const out: Vec[] = [b.c];
  const k = Math.max(1, Math.ceil((b.hl * 2) / 3));
  for (let i = 0; i <= k; i++) {
    const along = scale(b.d, -b.hl + (2 * b.hl * i) / k);
    out.push(add(b.c, add(along, scale(n, b.hw))), add(b.c, add(along, scale(n, -b.hw))));
  }
  return out;
}

/** Место машины на петле: нос, курс, вторая часть; s — пройдено по следу задней оси. */
export interface LoopPose {
  pos: Vec;
  dir: Vec;
  trail?: Vec;
  s: number;
}

/**
 * Петля разворота: позы машины через LOOP_STEP м пути задней оси (от позы, где она встала, до конца — во встречной
 * полосе носом назад), длина пути, с какой стороны карман (1 — справа по ходу, −1 — слева) и радиус.
 */
export interface LoopPlan {
  poses: LoopPose[];
  len: number;
  side: 1 | -1;
  r: number;
  /** Корпус машины по петле — через ~0,5 м пути, с запасом LOOP.margin (index — номер позы). */
  sweep: { index: number; boxes: Box[] }[];
}

/** Шаг поз петли, м. */
const LOOP_STEP = 0.25;

/** Единичный вектор курса a (радианы). */
const dirOf = (a: number): Vec => ({ x: Math.cos(a), y: Math.sin(a) });

/**
 * След задней оси: от rear0 с курсом dir0 — дуги радиуса r (k = 1 — направо по ходу, −1 — налево, a — угол) и прямая
 * run в конце. Курс — по касательной к следу (машина на руле, без заноса).
 */
export function loopTrack(rear0: Vec, dir0: Vec, arcs: readonly { k: 1 | -1; a: number }[], r: number, run: number): { rear: Vec; dir: Vec }[] {
  let th = Math.atan2(dir0.y, dir0.x);
  let rear = { ...rear0 };
  const out = [{ rear, dir: dirOf(th) }];
  for (const { k, a } of arcs) {
    const n = Math.max(1, Math.ceil((r * a) / LOOP_STEP));
    const center = add(rear, scale(rightNormal(dirOf(th)), r * k));
    const th0 = th;
    for (let i = 1; i <= n; i++) {
      th = th0 + (k * a * i) / n;
      rear = sub(center, scale(rightNormal(dirOf(th)), r * k));
      out.push({ rear, dir: dirOf(th) });
    }
  }
  const d = dirOf(th);
  const n = Math.max(1, Math.ceil(run / LOOP_STEP));
  const from = rear;
  for (let i = 1; i <= n; i++) out.push({ rear: add(from, scale(d, (run * i) / n)), dir: d });
  return out;
}

/** Куда машина с кузовом look разворачивается: где стоит задняя ось и вторая часть, курс. */
export interface LoopStart {
  pos: Vec;
  dir: Vec;
  trail?: Vec;
}

/**
 * Проверка места петли: корпус (прямоугольники) — null, если задевает постройку, воду, чужую дорогу или путь; иначе —
 * насколько далеко он заходит за край асфальта своих полотен (0 — весь на асфальте).
 */
export type LoopCheck = (boxes: readonly Box[]) => number | null;

/**
 * Петля разворота для машины spec, стоящей в start: во встречную полосу, что на left м левее её задней оси (по курсу).
 * Перебирает сторону кармана (сперва справа), радиус (LOOP.r и на 1–2 м больше) и угол первого отворота; из петель, что
 * не задевают ничего (check), — та, что меньше всего заходит за край асфальта. Нет такой — null.
 */
export function planLoop(start: LoopStart, kind: Pick<BodyLook, 'length' | 'width' | 'body'>, left: number, check: LoopCheck): LoopPlan | null {
  const spec = { length: kind.length, width: kind.width, body: kind.body };
  const base = steerBase(spec.body) * spec.length;
  const rear0 = sub(start.pos, scale(start.dir, base));
  const h = hitchOf(spec.body);
  // После дуг — прямо, пока вторая часть (самосвал, каток на сцепке) не ляжет вдоль полосы: на повороте её заносит
  // внутрь, и сразу за петлёй она торчала бы поперёк соседней полосы.
  const run = h ? Math.max(LOOP.run, 1.2 * h.tail * spec.length) : LOOP.run;
  let best: { plan: LoopPlan; score: number } | null = null;
  for (const r of [LOOP.r, LOOP.r + 1, LOOP.r + 2]) {
    for (const side of [1, -1] as const) {
      for (let deg = 14; deg <= 120; deg += 4) {
        const a = (deg * Math.PI) / 180;
        // Задняя ось в конце — на left левее начала (см. loopTrack: направо a, налево π + a + b, направо b; слева — зеркально).
        const cb = side > 0 ? left / (2 * r) + 1 - Math.cos(a) : 1 - left / (2 * r) - Math.cos(a);
        if (cb < 0 || cb > 1) continue;
        const b = Math.acos(cb);
        const track = loopTrack(rear0, start.dir, [
          { k: side, a },
          { k: (-side) as 1 | -1, a: Math.PI + a + b },
          { k: side, a: b },
        ], r, run);
        const end = track[track.length - 1];
        const lat = dot(sub(end.rear, rear0), scale(rightNormal(start.dir), -1));
        if (Math.abs(lat - left) > 0.3 || dot(end.dir, start.dir) > -0.99) continue;
        // Развернувшаяся (в конце дуг) — не позади места, где начала (там, позади, — следующие машины колонны): нос — не
        // дальше LOOP.back назад, чтобы следующей хватило пути съехать с оси в свою полосу, пока она её не обгонит.
        const arcEnd = track[track.length - 1 - Math.ceil(run / LOOP_STEP)];
        if (dot(sub(add(arcEnd.rear, scale(arcEnd.dir, base)), start.pos), start.dir) < -LOOP.back) continue;
        const poses: LoopPose[] = [];
        let trail = start.trail;
        track.forEach((t, i) => {
          const pos = add(t.rear, scale(t.dir, base));
          if (h) trail = follow(jointOf(pos, t.dir, spec.length, h), t.dir, trail, spec.length * h.tail);
          poses.push({ pos, dir: t.dir, ...(h && trail ? { trail: { ...trail } } : {}), s: i * LOOP_STEP });
        });
        const last = poses.length - 1;
        let score = 0;
        let ok = true;
        for (let i = 0; ok; i = Math.min(last, i + CHECK_EVERY)) {
          const s = check(bodyBoxes({ ...poses[i], ...spec }));
          if (s === null) ok = false;
          else score = Math.max(score, s);
          if (i === last) break;
        }
        if (!ok) continue;
        // Сперва — меньше за краем асфальта (с точностью до полуметра), потом радиус меньше и карман справа.
        const rank = Math.round(score * 2) / 2;
        if (!best || rank < best.score) best = { plan: { poses, len: poses[last].s, side, r, sweep: [] }, score: rank };
      }
    }
  }
  if (!best) return null;
  // Где пройдёт корпус — часто (через SWEEP_EVERY): длинная машина на повороте заметает кормой широко.
  const { poses } = best.plan;
  const last = poses.length - 1;
  for (let i = 0; ; i = Math.min(last, i + SWEEP_EVERY)) {
    best.plan.sweep.push({ index: i, boxes: bodyBoxes({ ...poses[i], ...spec }, LOOP.margin) });
    if (i === last) break;
  }
  return best.plan;
}

/** Через сколько поз проверяется место петли (~1,5 м) и строится то, что заметает корпус (~0,5 м). */
const CHECK_EVERY = 6;
const SWEEP_EVERY = 2;

/** Поза на петле в s м пути задней оси — между соседними позами. */
export function loopPose(plan: LoopPlan, s: number): LoopPose {
  const p = plan.poses;
  const x = Math.max(0, Math.min(plan.len, s)) / LOOP_STEP;
  const i = Math.min(p.length - 2, Math.floor(x));
  if (i < 0) return p[0];
  const f = x - i;
  const a = p[i];
  const b = p[i + 1];
  const mix = (u: Vec, v: Vec): Vec => ({ x: u.x + (v.x - u.x) * f, y: u.y + (v.y - u.y) * f });
  const d = mix(a.dir, b.dir);
  const l = Math.hypot(d.x, d.y) || 1;
  return { pos: mix(a.pos, b.pos), dir: { x: d.x / l, y: d.y / l }, ...(a.trail && b.trail ? { trail: mix(a.trail, b.trail) } : {}), s };
}

/** Точка пути машины впереди по маршруту: сколько до неё, нос и курс по полосе; полоса и место на ней (не в узле). */
interface TrackPt {
  d: number;
  pos: Vec;
  dir: Vec;
  lane?: GLane;
  u?: number;
}

/**
 * Путь машины впереди по её маршруту (по полосам и манёврам в узлах), через step м, не дальше max; uturn — впереди
 * разворот в тупике: узел и сколько до манёвра (путь дальше него не идёт).
 */
export function routeAhead(graph: LaneGraph, veh: Vehicle, max: number, step: number): { pts: TrackPt[]; uturn?: { node: number; d: number } } {
  const pts: TrackPt[] = [];
  let d = 0;
  let lane: GLane | undefined;
  let u = 0;
  let ri = veh.routeIndex;
  const onMove = (m: { length: number }, from: number, at: (s: number) => { pos: Vec; dir: Vec }) => {
    for (let s = from; s < m.length; s += step) pts.push({ d: d + s - from, ...at(s) });
    d += Math.max(0, m.length - from);
  };
  if (veh.onMovement) {
    const m = graph.moves.get(veh.onMovement);
    if (!m) return { pts };
    onMove(m, veh.s, (s) => LaneGraph.pointOnMove(m, s));
    lane = graph.lanes.get(m.outLane);
    const k = veh.route.indexOf(m.outLink, veh.routeIndex);
    ri = k >= 0 ? k : veh.routeIndex + 1;
  } else {
    lane = graph.lanes.get(veh.lane);
    u = veh.s;
    const k = lane ? veh.route.indexOf(lane.link, veh.routeIndex) : -1;
    if (k >= 0) ri = k;
  }
  while (lane && d <= max) {
    for (let x = u; x < lane.length; x += step) pts.push({ d: d + x - u, ...graph.lanePose(lane, x), lane, u: x });
    pts.push({ d: d + lane.length - u, ...graph.lanePose(lane, lane.length), lane, u: lane.length });
    d += Math.max(0, lane.length - u);
    const next = veh.route[ri + 1];
    if (next === undefined) break;
    const m = (graph.movesFrom.get(lane.id) ?? []).find((x) => x.outLink === next) ?? graph.transitions.get(`${lane.link}>${next}`)?.[0];
    if (!m) break;
    if (m.node !== null && dot(m.dirIn, m.dirOut) < -0.9) {
      const n = graph.net.nodes.get(m.node);
      if (n && graph.net.isDeadEnd(n)) return { pts, uturn: { node: m.node, d } };
    }
    if (!m.cont) onMove(m, 0, (s) => LaneGraph.pointOnMove(m, s));
    lane = graph.lanes.get(m.outLane);
    u = 0;
    ri++;
  }
  return { pts };
}

/** Что разворотам нужно от игры. */
export interface CrewLoopHost {
  readonly traffic: LaneTraffic;
  readonly graph: LaneGraph;
  readonly time: number;
  /** Машины бригад в потоке. */
  crewSims(): Vehicle[];
  /** Машины бригад вне потока (стоят на местах, ждут колонну) — их корпус мешает разворотам. */
  parked(): BodyLook[];
  /**
   * Что мешает петле в круге (center, r): blocked — прямоугольник задевает постройку, станцию, предприятие, базу,
   * площадку, парк, воду, путь или край карты; roads — полотна дорог рядом (и строящиеся).
   */
  area(center: Vec, r: number): { blocked(fp: Footprint): boolean; roads: Corridor[] };
}

/**
 * Что делает машина: едет к месту петли, ждёт там начала, на петле, развернулась и ждёт, пока впереди освободится,
 * уезжает (вторая часть кузова ещё не выровнялась — рядом с ней пока никого не пускают).
 */
type Phase = 'approach' | 'ready' | 'loop' | 'exit' | 'leave';

/** Разворот машины: тупик, куда она ехала, что делает сейчас, петля и где на ней. */
interface Turn {
  sim: number;
  node: number;
  phase: Phase;
  /** До места петли, м (approach). */
  remain: number;
  /** Где была машина в прошлый такт — сколько проехала (approach). */
  last: Vec;
  plan?: LoopPlan;
  s: number;
  v: number;
  /** С какого времени в этой фазе. */
  since: number;
}

export class CrewLoops {
  private readonly turns = new Map<number, Turn>();
  /** Машина и тупик, где петли не нашлось (или уже развернулась): там — как все. */
  private readonly skip = new Map<number, number>();
  /** Когда снова искать тупик впереди (по машине). */
  private readonly nextLook = new Map<number, number>();
  /** Кого остановил регулировщик. */
  private readonly held = new Set<number>();

  constructor(private readonly host: CrewLoopHost) {}

  /** Никто не разворачивается и никого не держат: такт не нужен. */
  get idle(): boolean {
    return !this.turns.size && !this.held.size;
  }

  /** Разворачивается ли машина sim петлёй сейчас (на петле или ждёт, развернувшись). */
  looping(sim: number): boolean {
    const p = this.turns.get(sim)?.phase;
    return p === 'loop' || p === 'exit';
  }

  /** Машина sim развернётся петлёй (едет к её месту, ждёт, на ней или уезжает с неё): за ней следят развороты. */
  turning(sim: number): boolean {
    return this.turns.has(sim);
  }

  /**
   * Рядом с точкой p (ближе r) разворачиваются или ждут разворота: машине, что трогается там с места (грузовик со
   * станции в конце выезда), — подождать, как и тем, кого держит регулировщик.
   */
  busyAt(p: Vec, r: number): boolean {
    for (const t of this.turns.values()) if (this.zoneOf(t).some((b) => dist(b.c, p) < r + b.hl + b.hw)) return true;
    return false;
  }

  /** Петли, что сейчас идут (для карты и проверок): машина, петля, где на ней. */
  active(): { sim: number; plan: LoopPlan; s: number }[] {
    const out: { sim: number; plan: LoopPlan; s: number }[] = [];
    for (const t of this.turns.values()) if (t.plan && (t.phase === 'loop' || t.phase === 'exit')) out.push({ sim: t.sim, plan: t.plan, s: t.s });
    return out;
  }

  /** Такт — сразу после движения: машины на петле рисуются там, где они на ней. */
  step(dt: number): void {
    const { traffic, time } = this.host;
    // Кого держать и можно ли начинать — не каждый такт, а LOOP.every: остановленные стоят там, где их остановили
    // (holdAfter — место на маршруте), а за это время машина проезжает пару метров.
    const look = time >= this.nextCheck;
    if (look) this.nextCheck = time + LOOP.every;
    this.paths.clear();
    // Машины нет в потоке (доехала, бригаду распустили, дорогу снесли) — забыть.
    for (const id of [...this.turns.keys()]) if (!traffic.vehicles.has(id)) this.turns.delete(id);
    for (const id of [...this.skip.keys()]) if (!traffic.vehicles.has(id)) this.skip.delete(id);
    for (const id of [...this.nextLook.keys()]) if (!traffic.vehicles.has(id)) this.nextLook.delete(id);
    const sims = this.host.crewSims();
    for (const veh of sims) {
      if (this.turns.has(veh.id) || (this.nextLook.get(veh.id) ?? 0) > time) continue;
      this.nextLook.set(veh.id, time + 0.5);
      this.detect(veh);
    }
    // По порядку: кто раньше встал ждать, тот раньше и начнёт.
    const list = [...this.turns.values()].sort((a, b) => a.since - b.since || a.sim - b.sim);
    for (const t of list) {
      const veh = traffic.vehicles.get(t.sim);
      if (!veh) continue;
      if (t.phase === 'approach') this.approach(t, veh);
      if (t.phase === 'ready' && look) this.ready(t, veh);
      if (t.phase === 'loop') this.drive(t, veh, dt);
      if (t.phase === 'exit') this.exit(t, veh, look);
      else if (t.phase === 'leave') this.leave(t, veh);
    }
    if (look) this.flag();
  }

  /** Когда снова решать, кого держать и кому начинать (LOOP.every). */
  private nextCheck = 0;
  /** Путь машин впереди (routeAhead до LOOP.flag) — в этот такт, для всех мест разворота разом. */
  private readonly paths = new Map<number, TrackPt[]>();

  /** Впереди по маршруту машины бригады — разворот в тупике: ищем, где развернуться петлёй, и едем туда. */
  private detect(veh: Vehicle): void {
    const graph = this.host.graph;
    const ahead = routeAhead(graph, veh, LOOP.look, 1);
    const u = ahead.uturn;
    if (!u) return;
    if (this.skip.get(veh.id) === u.node) return;
    // Место — ближе всего к тупику, где есть где развернуться (как развернулись бы и там, в конце дороги): позади в
    // колонне — следующие машины, им нужен путь, чтобы съехать с оси дороги в свою полосу, пока эта, развернувшись, не
    // поедет мимо. Не ближе, чем она успеет мягко остановиться.
    const d0 = (veh.v * veh.v) / (2 * LOOP.brake) + (veh.v > 0.5 ? 1 : 0);
    const allow = this.own(ahead.pts);
    for (let d = u.d; d >= d0 - 1e-6; d = d - LOOP.step < d0 && d > d0 ? d0 : d - LOOP.step) {
      const at = d < 0.5 ? { pos: veh.pos, dir: veh.dir, lane: graph.lanes.get(veh.lane), u: veh.s } : pointAt(ahead.pts, d);
      if (!at?.lane || at.u === undefined) continue;
      const start: LoopStart = d < 0.5 ? { pos: veh.pos, dir: veh.dir, trail: veh.trail } : { pos: at.pos, dir: at.dir };
      const plan = this.plan(veh, start, at.lane, at.u, allow);
      if (!plan) continue;
      this.turns.set(veh.id, { sim: veh.id, node: u.node, phase: 'approach', remain: d, last: { ...veh.pos }, plan, s: 0, v: 0, since: this.host.time });
      this.host.traffic.holdAfter(veh, d);
      return;
    }
    // Петле нигде нет места — у этого тупика как все.
    this.skip.set(veh.id, u.node);
  }

  /**
   * Свои полотна петли: по которым машина едет до тупика, и те, что продолжают их через стыки (без перекрёстка) — дорога,
   * с которой она только что выехала, тоже своя: по ней петля может пройти.
   */
  private own(pts: readonly TrackPt[]): Set<number> {
    const graph = this.host.graph;
    const net = graph.net;
    const out = new Set<number>();
    for (const p of pts) if (p.lane) out.add(graph.links.get(p.lane.link)!.corridor);
    const queue = [...out];
    while (queue.length) {
      const c = net.corridors.get(queue.pop()!);
      if (!c) continue;
      for (const id of [c.a, c.b]) {
        const n = net.nodes.get(id);
        if (n?.kind !== 'seam') continue;
        for (const k of n.corridors) {
          if (out.has(k)) continue;
          out.add(k);
          queue.push(k);
        }
      }
    }
    return out;
  }

  /** Петля для машины veh из start (на полосе lane в u): во встречную полосу полотна; null — нет места. */
  private plan(veh: Vehicle, start: LoopStart, lane: GLane, u: number, allow: ReadonlySet<number>): LoopPlan | null {
    const graph = this.host.graph;
    const link = graph.links.get(lane.link);
    if (!link) return null;
    const s = graph.axisS(lane, u);
    // Встречная полоса — ближняя к машине полоса встречной связи там же.
    let target: Vec | null = null;
    for (const l of graph.corridorLinks(link.corridor)) {
      if (l.flow === link.flow || s < l.s0 - 0.5 || s > l.s1 + 0.5) continue;
      for (const o of l.lanes) {
        const p = graph.lanePose(o, Math.max(0, Math.min(o.length, l.flow > 0 ? s - l.s0 : l.s1 - s))).pos;
        if (!target || dist(p, start.pos) < dist(target, start.pos)) target = p;
      }
    }
    if (!target) return null;
    const base = steerBase(veh.body) * veh.length;
    const rear = sub(start.pos, scale(start.dir, base));
    const left = dot(sub(target, rear), scale(rightNormal(start.dir), -1));
    if (left < 1) return null;
    const area = this.host.area(add(start.pos, scale(start.dir, LOOP.r)), LOOP.r * 2 + veh.length + 10);
    const roads = area.roads;
    const check: LoopCheck = (boxes) => {
      let out = 0;
      for (const b of boxes) {
        if (area.blocked(boxFp(b))) return null;
        for (const q of probes(b)) {
          let own = Infinity;
          for (const c of roads) {
            const hit = c.lut.closest(q);
            const edge = hit.d - halfAtS(c, hit.s);
            if (allow.has(c.id)) own = Math.min(own, edge);
            // Чужая дорога (поперечная улица, съезд): по ней ездят — не заезжаем.
            else if (edge < 0.5) return null;
          }
          out = Math.max(out, own);
        }
      }
      return Math.max(0, out);
    };
    return planLoop(start, veh, left, check);
  }

  /** Едет к месту петли (holdAfter): доехала и стоит — петля заново от того места, где она встала. */
  private approach(t: Turn, veh: Vehicle): void {
    t.remain -= Math.max(0, dot(sub(veh.pos, t.last), veh.dir));
    t.last = { ...veh.pos };
    // Маршрут сменился (бригаду послали в другое место) — разворот там не нужен.
    const ahead = routeAhead(this.host.graph, veh, Math.max(t.remain, 0) + LOOP.look, 2);
    if (ahead.uturn?.node !== t.node) return this.drop(t, veh, false);
    if (t.remain > 0.6 || veh.v > 0.3) return;
    const lane = this.host.graph.lanes.get(veh.lane);
    const allow = this.own(ahead.pts);
    const plan = lane && !veh.onMovement ? this.plan(veh, { pos: veh.pos, dir: veh.dir, trail: veh.trail }, lane, veh.s, allow) : null;
    if (!plan) return this.drop(t, veh, true);
    t.plan = plan;
    t.phase = 'ready';
    t.since = this.host.time;
  }

  /** Стоит у места петли: начинает, когда место пусто и никто не въедет туда, пока она разворачивается. */
  private ready(t: Turn, veh: Vehicle): void {
    const plan = t.plan!;
    const traffic = this.host.traffic;
    if (this.host.time - t.since > LOOP.startWait) return this.drop(t, veh, true);
    const zone = ahead(plan);
    // Другие развороты рядом — по очереди: сперва та, что стоит на месте петли другой (иначе обе ждали бы друг друга),
    // потом — кто раньше встал ждать.
    for (const o of this.turns.values()) {
      if (o === t || !o.plan || o.phase === 'approach') continue;
      const other = this.zoneOf(o);
      if (!anyOverlap(zone, other)) continue;
      if (o.phase !== 'ready') return;
      const ov = traffic.vehicles.get(o.sim);
      if (ov && anyOverlap(zone, bodyBoxes(ov))) return;
      if (anyOverlap(other, bodyBoxes(veh))) continue;
      if (o.since < t.since || (o.since === t.since && o.sim < t.sim)) return;
    }
    // Место пусто: ни машин колонны на местах, ни машин в потоке, а кто едет туда — успеет остановиться перед ним.
    for (const m of this.host.parked()) if (anyOverlap(zone, bodyBoxes(m))) return;
    for (const o of this.near(plan.poses[Math.floor(plan.poses.length / 2)].pos)) {
      if (o.id === veh.id || this.looping(o.id)) continue;
      if (anyOverlap(zone, bodyBoxes(o))) return;
      const gap = this.gapTo(o, zone);
      if (gap !== null && o.v > 0.3 && (o.v * o.v) / (2 * LOOP.brake) > gap - 0.5) return;
    }
    // В потоке — сразу во встречную полосу, где петля кончится: стоит там, пока не развернётся.
    const end = plan.poses[plan.poses.length - 1];
    const rear = veh.rear ? { ...veh.rear } : undefined;
    const trail = veh.trail ? { ...veh.trail } : undefined;
    if (!traffic.relocate(veh, end.pos, end.dir, 3)) return this.drop(t, veh, true);
    traffic.holdAfter(veh, 0);
    veh.rear = rear;
    veh.trail = trail;
    t.phase = 'loop';
    t.s = 0;
    t.v = 0;
    t.since = this.host.time;
    this.pose(t, veh);
  }

  /** По петле: разгон, ход, торможение к её концу. */
  private drive(t: Turn, veh: Vehicle, dt: number): void {
    const plan = t.plan!;
    const left = plan.len - t.s;
    t.v = Math.min(t.v + LOOP.accel * dt, LOOP.speed, Math.sqrt(2 * LOOP.accel * Math.max(0, left)));
    t.s = Math.min(plan.len, t.s + Math.max(t.v, 0.3) * dt);
    if (t.s >= plan.len - 1e-6) {
      t.phase = 'exit';
      t.since = this.host.time;
    }
    this.pose(t, veh);
  }

  /** Развернулась: едет дальше в потоке, когда впереди по встречной никто не стоит поперёк её пути. */
  private exit(t: Turn, veh: Vehicle, look: boolean): void {
    this.pose(t, veh);
    if (!look || (this.host.time - t.since < LOOP.exitWait && this.blockedAhead(veh))) return;
    const traffic = this.host.traffic;
    const end = loopPose(t.plan!, t.plan!.len);
    const lane = this.host.graph.lanes.get(veh.lane);
    if (lane && !veh.onMovement) {
      const at = this.host.graph.lanePose(lane, Math.min(veh.s, lane.length));
      veh.lateral = dot(sub(end.pos, at.pos), rightNormal(at.dir));
      veh.glide = true;
    }
    traffic.release(veh);
    this.skip.set(t.sim, t.node);
    t.phase = 'leave';
    t.since = this.host.time;
    t.last = { ...veh.pos };
    t.s = 0;
  }

  /**
   * Уезжает в потоке: пока не проехала свою длину, вторая часть кузова ещё не легла вдоль полосы — рядом с ней никого
   * не пускают (её корпус — место разворота, flag).
   */
  private leave(t: Turn, veh: Vehicle): void {
    t.s += Math.max(0, dot(sub(veh.pos, t.last), veh.dir));
    t.last = { ...veh.pos };
    if (t.s >= veh.length || this.host.time - t.since > LOOP.exitWait) this.turns.delete(t.sim);
  }

  /** Машину — туда, где она на петле (рисунок и проверки; в потоке она стоит в конце петли). */
  private pose(t: Turn, veh: Vehicle): void {
    const p = loopPose(t.plan!, t.s);
    const base = steerBase(veh.body) * veh.length;
    veh.pos = { ...p.pos };
    veh.dir = { ...p.dir };
    veh.rear = sub(p.pos, scale(p.dir, base));
    if (p.trail) veh.trail = { ...p.trail };
  }

  /** Разворот петлёй отменён: машина — как все (в тупике); skip — и у этого тупика больше не искать. */
  private drop(t: Turn, veh: Vehicle, skip: boolean): void {
    if (veh.holdDist !== undefined && !this.held.has(veh.id)) this.host.traffic.release(veh);
    this.turns.delete(t.sim);
    if (skip) this.skip.set(t.sim, t.node);
  }

  /**
   * Где разворот ещё пройдёт: ждёт — вся петля, на петле — от того места, где машина, развернулась и уезжает — она
   * сама.
   */
  private zoneOf(t: Turn): Box[] {
    // Сама машина — тоже: едет к месту петли, а ещё не съехала с оси дороги в свою полосу (выехала с места на стройке)
    // или стоит чуть наискось — встречные не проедут сквозь неё, а подождут (в своей полосе она им не мешает).
    const own = this.nowOf(t);
    // Подъезжает к месту петли — и место петли уже: встречные, что доедут туда раньше, чем она развернётся, ждут перед
    // ним, а не встают рядом с ней (иначе она ждала бы их, а они — её).
    // Далеко от места петли и уже в своей полосе — никому не мешает.
    if (t.phase === 'approach') {
      if (t.plan && t.remain < LOOP.near) return [...own, ...ahead(t.plan)];
      const veh = this.host.traffic.vehicles.get(t.sim);
      return veh && Math.abs(veh.lateral) > 0.3 ? own : [];
    }
    const plan = t.plan;
    if (!plan) return [];
    if (t.phase === 'ready') return [...own, ...ahead(plan)];
    if (t.phase === 'exit' || t.phase === 'leave') return own;
    const at = t.s / LOOP_STEP;
    return [...own, ...plan.sweep.filter((x) => x.index >= at).flatMap((x) => x.boxes)];
  }

  /** Где машина разворота сама стоит или едет сейчас (корпус с запасом), если она мешает другим: не в своей полосе или на петле. */
  private nowOf(t: Turn): Box[] {
    const veh = this.host.traffic.vehicles.get(t.sim);
    return veh ? bodyBoxes(veh, LOOP.margin) : [];
  }

  /** Машины в потоке рядом с местом c (в стольких метрах, сколько регулировщик смотрит вперёд, и ещё на петлю). */
  private near(c: Vec): Vehicle[] {
    const r = LOOP.flag + LOOP.r * 2 + 30;
    const out: Vehicle[] = [];
    for (const v of this.host.traffic.vehicles.values()) if (Math.abs(v.pos.x - c.x) < r && Math.abs(v.pos.y - c.y) < r) out.push(v);
    return out;
  }

  /**
   * Сколько машине o ехать по маршруту до места, где её корпус заденет zone (не дальше LOOP.flag); null — не заденет.
   * Машина, что съезжает в полосу (glide), — со своим сдвигом, который тает по пути.
   */
  private gapTo(o: Vehicle, zone: readonly Box[]): number | null {
    if (!zone.length) return null;
    let cx = 0;
    let cy = 0;
    for (const b of zone) {
      cx += b.c.x;
      cy += b.c.y;
    }
    const c = { x: cx / zone.length, y: cy / zone.length };
    let R = 0;
    for (const b of zone) R = Math.max(R, dist(b.c, c) + b.hl + b.hw);
    let ahead = this.paths.get(o.id);
    if (!ahead) this.paths.set(o.id, (ahead = routeAhead(this.host.graph, o, LOOP.flag, 2).pts));
    const hits = (p: { d: number; pos: Vec; dir: Vec }): boolean => {
      const lat = o.glide ? Math.sign(o.lateral) * Math.max(0, Math.abs(o.lateral) - p.d * GLIDE_SLOPE) : 0;
      const pos = lat ? add(p.pos, scale(rightNormal(p.dir), lat)) : p.pos;
      // Кузов наискось к полосе (съезжает в неё) — выравнивается за полторы длины пути.
      const k = Math.min(1, p.d / (1.5 * o.length));
      const d = { x: o.dir.x * (1 - k) + p.dir.x * k, y: o.dir.y * (1 - k) + p.dir.y * k };
      const l = Math.hypot(d.x, d.y) || 1;
      return anyOverlap(zone, bodyBoxes({ pos, dir: { x: d.x / l, y: d.y / l }, length: o.length, width: o.width }));
    };
    for (let i = 0; i < ahead.length; i++) {
      const p = ahead[i];
      if (dist(p.pos, c) > R + o.length + 2 || !hits(p)) continue;
      // Задевает здесь — где именно, между этой точкой пути и прошлой (через четверть метра).
      const q = ahead[i - 1];
      if (!q) return p.d;
      const n = Math.max(1, Math.ceil((p.d - q.d) / 0.25));
      for (let j = 1; j <= n; j++) {
        const f = j / n;
        const mid = { d: q.d + (p.d - q.d) * f, pos: add(q.pos, scale(sub(p.pos, q.pos), f)), dir: add(scale(q.dir, 1 - f), scale(p.dir, f)) };
        if (hits(mid)) return mid.d;
      }
      return p.d;
    }
    return null;
  }

  /** Впереди развернувшейся по её полосе кто-то стоит поперёк её пути (съезжает с оси в свою полосу, стоит на месте). */
  private blockedAhead(veh: Vehicle): boolean {
    const path = routeAhead(this.host.graph, veh, 60, 2).pts;
    const lat = veh.lateral;
    const mine = path.map((p) => bodyBoxes({ pos: add(p.pos, scale(rightNormal(p.dir), lat)), dir: p.dir, length: veh.length, width: veh.width })).flat();
    // Мешают стоящие вне потока (машины колонны на местах) и те, что ещё съезжают с оси в свою полосу; кто уже в своей
    // полосе (и стоит чуть наискось, не успев выровняться), — нет: мимо него проедет впритирку.
    const others: Box[][] = this.host.parked().map((m) => bodyBoxes(m, -LOOP.tight));
    for (const o of this.host.traffic.vehicles.values()) {
      if (o.id === veh.id || dist(o.pos, veh.pos) > 90 || Math.abs(o.lateral) < 1) continue;
      others.push(bodyBoxes(o, -LOOP.tight));
    }
    return others.some((b) => anyOverlap(mine, b));
  }

  /**
   * Регулировщик: всех, кто по маршруту доедет до места разворота (ждущего начала или идущего), — остановить перед ним
   * (holdAfter); кто уже там — пусть уезжает. Машину, что едет к месту своей петли, — не дальше него. Не нужно —
   * отпустить.
   */
  private flag(): void {
    const traffic = this.host.traffic;
    const want = new Map<number, number>();
    for (const t of this.turns.values()) {
      const all = this.zoneOf(t);
      if (!all.length) continue;
      const own = this.nowOf(t);
      for (const o of this.near(all[0].c)) {
        const ot = this.turns.get(o.id);
        if (o.id === t.sim || (ot && ot.phase !== 'approach')) continue;
        // Место петли той, что ещё только подъезжает к нему, держат для встречных; машинам колонны, что едут к своим
        // местам (по очереди их разводит ready), мешает только её корпус.
        const zone = ot && t.phase === 'approach' ? own : all;
        // Уже там (ближе запаса): машина колонны, что едет к своей петле, а рядом уже разворачиваются, — стоит, где стоит;
        // другие пусть уезжают, но не сквозь корпус (без запаса), — тогда стоят, где стоят.
        if (anyOverlap(zone, bodyBoxes(o))) {
          const now = own.map((b) => ({ ...b, hl: b.hl - LOOP.margin, hw: b.hw - LOOP.margin }));
          const gap = ot && t.phase === 'loop' ? 0 : this.gapTo(o, now);
          if (gap !== null && gap > 0.5) want.set(o.id, Math.min(want.get(o.id) ?? Infinity, gap - 0.5));
          else if (gap !== null && ot) want.set(o.id, 0);
          continue;
        }
        const gap = this.gapTo(o, zone);
        if (gap !== null) want.set(o.id, Math.min(want.get(o.id) ?? Infinity, Math.max(0, gap - 1)));
      }
    }
    for (const t of this.turns.values()) {
      if (t.phase !== 'approach') continue;
      const veh = traffic.vehicles.get(t.sim);
      if (veh) traffic.holdAfter(veh, Math.min(Math.max(0, t.remain), want.get(t.sim) ?? Infinity));
      want.delete(t.sim);
    }
    for (const [id, d] of want) {
      const o = traffic.vehicles.get(id);
      if (!o) continue;
      // Стоит по своей причине (у остановки, у двора) — не трогаем.
      if (o.holdDist !== undefined && !this.held.has(id)) continue;
      traffic.holdAfter(o, d);
      this.held.add(id);
    }
    for (const id of [...this.held]) {
      if (want.has(id)) continue;
      const o = traffic.vehicles.get(id);
      if (o && !this.turns.has(id)) traffic.release(o);
      this.held.delete(id);
    }
  }
}

/**
 * Где пройдёт петля, кроме места, где машина стоит перед ней (первые полтора метра): позади неё в очереди — следующая
 * машина, её корпус вплотную к этому месту — не помеха.
 */
const ahead = (plan: LoopPlan): Box[] => plan.sweep.filter((x) => x.index * LOOP_STEP >= 1.5).flatMap((x) => x.boxes);

/** Точка пути впереди в d м (ближайшая из pts). */
function pointAt(pts: readonly TrackPt[], d: number): TrackPt | undefined {
  let best: TrackPt | undefined;
  for (const p of pts) if (p.lane && (!best || Math.abs(p.d - d) < Math.abs(best.d - d))) best = p;
  return best;
}
