/**
 * Полоса бригады на стройке — один непрерывный путь машин её колонны (src/game/crews.ts): от мест, где колонна
 * собралась у подъезда (на готовой дороге перед узлом), через узел на начало заполнения участка, по его оси и дальше
 * по следующему участку, если тот продолжает этот от его конца. Машины ездят только вдоль полосы — вперёд по своему
 * курсу, повороты скруглены (fillet), ряд бригады на участке (row) — плавным перестроением с поворотом корпуса. Где
 * машины работают — места этапов (stageSlots, метров от начала заполнения), та же полоса: от «приехали» к «работают»
 * машины доезжают до своих мест без скачка, не наезжая друг на друга. Чистые расчёты, без игры.
 */
import { smoothstep } from '../core/math';
import { add, dist, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import { laneWise } from '../lanes/closure';
import { edgesAt } from '../lanes/geometry';
import type { Corridor, CorridorBuild } from '../lanes/model';
import { steerBase } from '../sim/body';
import { ROAD_MARGIN } from '../world/roadTypes';
import { frontOf, spansOf, stageSpans } from './constructionWork';

/**
 * Машины бригады, от головной, — они же техника этапов на стройке (одна и та же машина в потоке, вдоль стройки и на
 * месте работ): отсыпка — грейдер и самосвал с грунтом, покрытие — асфальтоукладчик и каток, разметка — машина
 * разметки. Длина — от носа до хвоста, м; ширина — по самому широкому (нож грейдера, брус укладчика).
 */
export const CREW_UNITS = [
  { body: 'crewEarth', length: 22, width: 4.6 },
  { body: 'crewPave', length: 18, width: 4.8 },
  { body: 'crewMarks', length: 7, width: 3.6 },
] as const;

/** Машин в колонне бригады. */
export const CREW_CARS = CREW_UNITS.length;

/**
 * Зазор между машинами колонны на стройке, м (от хвоста до носа следующей): чуть больше, чем у стоящих в потоке
 * (IDM.minGap), — на повороте вторая часть длинной машины выносится назад и не задевает следующую.
 */
export const CREW_GAP = 4;

/**
 * Скорость машин бригады по полосе к своим местам, м/с игры: не медленнее, чем край отсыпки уходит вперёд на ×1, —
 * головная догоняет свой край, а не отстаёт от него.
 */
export const LANE_SPEED = 25;

/** От носа машины k колонны до носа следующей за ней: её длина и зазор. */
export const crewSpacing = (k: number): number => CREW_UNITS[Math.min(k, CREW_UNITS.length - 1)].length + CREW_GAP;

/** Радиус скругления поворотов полосы, м. */
const TURN_R = 9;
/**
 * Съезд с дороги на стройку (turnIn): насколько дуга может вынести машину за ось проекта, если ширина полотна
 * неизвестна, м, и не короче скольких метров пути она возвращается на ось.
 */
const ENTRY_OVER = 3;
const ENTRY_RAMP = 20;
/** Скорость машин бригады на съезде с дороги на стройку (до конца поворота, CrewLane.slow), м/с игры (~22 км/ч). */
export const ENTRY_SPEED = 6;
/** За столько метров пути вдоль полосы машина перестраивается в ряд своей бригады. */
export const ROW_RAMP = 30;

/** Участок проекта на полосе бригады: полотно, с какого конца заполняется и где на полосе начало заполнения, м. */
export interface LaneLeg {
  corridor: number;
  fromB: boolean;
  at: number;
}

/**
 * Перестроение бригады в другой ряд: начиная с места at полосы (м от её начала) машина на ROW_RAMP метрах пути плавно
 * сдвигается вбок к ряду to (вправо по ходу, м). Каждая машина колонны перестраивается, проезжая это место, — стоящая
 * ждёт в своём ряду.
 */
export interface LaneShift {
  at: number;
  to: number;
}

/** Полоса бригады (сохраняется вместе с бригадой). */
export interface CrewLane {
  path: Vec[];
  legs: LaneLeg[];
  /**
   * Откуда (м от начала полосы) машины колонны тронулись к своим местам и когда (секунды игры); нет — уже на местах.
   * Короче колонны — на полосе пока только первые машины (сходят со дороги по одной, по порядку, как доехали:
   * Crews.board); остальные ещё в пути.
   */
  from?: number[];
  t0?: number;
  /** Когда тронулась каждая машина (по номеру; нет — все в t0). */
  t?: number[];
  /**
   * На сколько машина стояла вбок от линии полосы, когда сошла на неё (вправо по ходу, м; по номеру): за ROW_RAMP
   * метров пути она плавно выходит на полосу (laneCarPose). Нет — стояла на ней.
   */
  side?: number[];
  /** Перестроения в ряды по порядку (laneShift); нет — по оси полосы. */
  shifts?: LaneShift[];
  /** Разворот колонны перед полосой (planTurn); нет — полоса начинается сразу. */
  turn?: LaneTurn;
  /**
   * Съезд с дороги на стройку с поворотом (turnIn): до этого места (м от начала полосы; конец поворота и ещё TURN_TAIL,
   * пока задняя ось длинной машины на дуге) машины едут медленно — ENTRY_SPEED. Нет — поворота нет.
   */
  slow?: number;
}

/**
 * Разворот колонны на 180° перед её полосой (перестройка «с проездом», второй проход — назад по другой половине):
 * машины идут не по полосе, а по пути разворота path — настоящим точкам носа, без рядов. Он кончается на полосе:
 * последняя точка — место полосы end (м от её начала) с её рядом и курсом; места на полосе до end — на path, path
 * кончается в end. На развороте машины едут медленно (TURN_SPEED), каждая — тем же путём следом за предыдущей.
 */
export interface LaneTurn {
  path: Vec[];
  end: number;
  /** Откуда (м по полосе) головная тронулась на разворот: дальше курс машины — по хорде к её задней оси (laneCarPose). */
  lead: number;
  /** Разворот в три приёма — где (м по полосе) машины идут задним ходом; нет — одной дугой. */
  back?: [number, number];
  /** Колонна ждёт, когда можно развернуться (Construction: обе стороны реверса на красном и участок пуст). */
  wait?: true;
}

/** Скорость машин бригады на развороте, м/с игры (~9 км/ч). */
export const TURN_SPEED = 4;

/**
 * Радиус разворота, м: сколько позволяет ширина полотна — нос машины не дальше от оси, чем кромка с обочиной минус
 * полмашины (turnRoom), но не больше max; меньше min — разворот в три приёма с радиусом min.
 */
export const U_TURN = { min: 5, max: 10 };

/** За столько метров машина отходит к кромке перед дугой разворота и после неё возвращается в свой ряд. */
const TURN_IN = 10;
const TURN_OUT = 12;
/**
 * За концом разворота машина ещё столько метров идёт медленно: её задняя ось (по ней курс корпуса, laneCarPose) ещё на
 * развороте. Ближе к концу разворота машины после него не встают (Construction.crewSlots).
 */
export const TURN_TAIL = 10;
/** Шаг точек пути разворота, м. */
const TURN_STEP = 0.25;

/** Насколько далеко от оси может быть нос машины на развороте, м: от оси до кромки с обочиной минус полмашины и запас. */
export function turnRoom(edges: readonly [number, number]): number {
  return Math.min(-edges[0], edges[1]) + ROAD_MARGIN - MACHINE_HALF - 0.3;
}

/** Сколько метров вперёд от головной нужно на разворот (до дальней точки дуги). */
export function turnAhead(room: number): number {
  return TURN_IN + Math.max(U_TURN.min, Math.min(U_TURN.max, room));
}

/** Длина ломаной — по разметке, если она длинная (без перебора точек на каждый вызов). */
function pathLen(p: readonly Vec[]): number {
  if (p.length < POLY_INDEX_MIN) return polyLength(p);
  const m = polyMarks(p);
  return m.ends.length ? m.ends[m.ends.length - 1] : 0;
}

/** Место на пути разворота: s — м по полосе (до turn.end). Курс — по точкам рядом (плавно), задним ходом — назад. */
function turnPose(turn: LaneTurn, s: number): { pos: Vec; dir: Vec } {
  const start = turn.end - pathLen(turn.path);
  const u = s - start;
  const pos = polyAt(turn.path, u).pos;
  const d = smoothDir(turn.path, u);
  const back = turn.back;
  const sign = back && s >= back[0] && s < back[1] ? -1 : 1;
  return { pos, dir: { x: sign * d.x, y: sign * d.y } };
}

/**
 * Касательная ломаной p в u м от начала — плавно: в точках излома — средняя соседних отрезков, между ними — по
 * доле отрезка. Там, где путь идёт назад (машина меняет ход), — касательная своего отрезка.
 */
function smoothDir(p: readonly Vec[], u: number): Vec {
  const m = polyMarks(p);
  const k = m.ends.length;
  if (!k) return { x: 1, y: 0 };
  let lo = 0;
  let hi = k - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (m.ends[mid] >= u) hi = mid;
    else lo = mid + 1;
  }
  const d = m.dirs[lo];
  const unit = (x: number, y: number): Vec => {
    const l = Math.hypot(x, y);
    return l > 1e-9 ? { x: x / l, y: y / l } : d;
  };
  const at = (i: number): Vec => {
    if (i < 0 || i >= k) return d;
    const e = m.dirs[i];
    if (dot(e, d) < 0) {
      // Путь поворачивает назад (машина меняет ход) — касательная своего отрезка, продолженная по изгибу с другой его
      // стороны: в точке смены хода курс тот же, что и до неё.
      const o = m.dirs[i > lo ? lo - 1 : lo + 1];
      return o && dot(o, d) > 0 ? unit(1.5 * d.x - 0.5 * o.x, 1.5 * d.y - 0.5 * o.y) : d;
    }
    return unit(d.x + e.x, d.y + e.y);
  };
  const a = at(lo - 1);
  const b = at(lo + 1);
  const s0 = lo ? m.ends[lo - 1] : 0;
  const f = Math.max(0, Math.min(1, (u - s0) / Math.max(1e-9, m.ends[lo] - s0)));
  const x = a.x + (b.x - a.x) * f;
  const y = a.y + (b.y - a.y) * f;
  const l = Math.hypot(x, y);
  return l > 1e-9 ? { x: x / l, y: y / l } : d;
}

/**
 * Разворот колонны на 180° с прежнего пути на полосу next (planTurn — ответ: путь разворота и где на полосе машины).
 * old(s) — нос и курс на прежнем пути в s м; cars — где на нём машины колонны (по номеру, головная — дальше всех);
 * rowOld — на сколько прежний путь правее оси полотна; room — turnRoom. Головная отходит вправо к кромке (TURN_IN),
 * дугой через обе половины полотна разворачивается налево и возвращается в ряд полосы next (TURN_OUT). Радиус — сколько
 * позволяет ширина (до U_TURN.max); меньше U_TURN.min — в три приёма: вперёд налево до другой кромки, назад с поворотом
 * (нос продолжает разворачиваться), вперёд налево в свой ряд. Машины за головной — тем же путём: он начинается
 * позади последней по прежнему пути.
 */
export function planTurn(
  old: (s: number) => { pos: Vec; dir: Vec },
  rowOld: number,
  cars: readonly number[],
  next: CrewLane,
  room: number,
): { turn: LaneTurn; from: number[] } {
  const head = Math.max(...cars);
  const tail = Math.min(...cars);
  const pts: Vec[] = [];
  const at: number[] = [];
  // Позади последней машины и до головной — по прежнему пути (там же, где машины стоят), с местами машин.
  const marks = [...new Set([...cars, ...Array.from({ length: Math.ceil((head - tail + 30) / 2) + 1 }, (_, i) => Math.min(head, tail - 30 + i * 2))])].sort((x, y) => x - y);
  for (const s of marks) pts.push(old(s).pos);
  const k = room >= U_TURN.min;
  const R = k ? Math.min(U_TURN.max, room) : U_TURN.min;
  // Отход к кромке (направо — от оси), дальше дуга налево.
  const edge = k ? R : room;
  const n = (s: number) => rightNormal(old(s).dir);
  const runIn = (u: number) => add(old(head + u * TURN_IN).pos, scale(n(head + u * TURN_IN), (edge - rowOld) * smoothstep(u)));
  const steps = (len: number) => Math.max(4, Math.ceil(len / TURN_STEP));
  for (let i = 1, m = steps(TURN_IN); i <= m; i++) pts.push(runIn(i / m));
  const q = pts[pts.length - 1];
  const d1 = old(head + TURN_IN).dir;
  const rowNext = laneShift(next, Number.MAX_SAFE_INTEGER / 2).lat;
  let back: [number, number] | undefined;
  let backAt: [number, number] | undefined;
  let e: Vec;
  let sa: number;
  if (k) {
    // Дуга: от отхода к кромке до такой же точки у другой кромки, напротив (кубическая кривая — почти полукруг).
    sa = polyProject(next.path, q);
    const np = lanePose(next, sa);
    e = add(np.pos, scale(rightNormal(np.dir), R - rowNext));
    const r = dist(q, e) / 2;
    const c1 = add(q, scale(d1, (4 / 3) * r));
    const c2 = sub(e, scale(np.dir, (4 / 3) * r));
    for (let i = 1, m = steps(Math.PI * r); i <= m; i++) pts.push(cubic(q, c1, c2, e, i / m));
  } else {
    // В три приёма, в осях от оси полотна напротив q (q — на y0, у правой кромки): x — вперёд по прежнему ходу, y —
    // налево (к другой кромке).
    const y = scale(n(head + TURN_IN), -1);
    const r = R;
    const y0 = -room;
    const o = sub(q, scale(y, y0));
    const P = (x: number, yy: number) => add(o, add(scale(d1, x), scale(y, yy)));
    const y1 = room;
    const th1 = Math.acos(Math.max(-1, Math.min(1, 1 - (y1 - y0) / r)));
    const x1 = r * Math.sin(th1);
    // Ряд полосы next — правее её хода, то есть левее прежнего.
    const Y = rowNext;
    const c2 = Math.max(-1, Math.min(Math.cos(th1), (Y - r - y1 + r * Math.cos(th1)) / (2 * r)));
    const th2 = Math.acos(c2);
    const x2 = x1 - r * (Math.sin(th2) - Math.sin(th1));
    const y2 = y1 - r * (Math.cos(th1) - Math.cos(th2));
    for (let i = 1, m = steps(r * th1); i <= m; i++) {
      const f = (th1 * i) / m;
      pts.push(P(r * Math.sin(f), y0 + r * (1 - Math.cos(f))));
    }
    const b0 = pts.length - 1;
    for (let i = 1, m = steps(r * (th2 - th1)); i <= m; i++) {
      const f = th1 + ((th2 - th1) * i) / m;
      pts.push(P(x1 - r * (Math.sin(f) - Math.sin(th1)), y1 - r * (Math.cos(th1) - Math.cos(f))));
    }
    const b1 = pts.length - 1;
    for (let i = 1, m = steps(r * (Math.PI - th2)); i <= m; i++) {
      const f = th2 + ((Math.PI - th2) * i) / m;
      pts.push(P(x2 + r * (Math.sin(f) - Math.sin(th2)), y2 + r * (Math.cos(th2) - Math.cos(f))));
    }
    backAt = [b0, b1];
    e = pts[pts.length - 1];
    sa = polyProject(next.path, e);
  }
  // Назад в ряд полосы: с прямой от конца дуги плавно на полосу.
  const d2 = lanePose(next, sa).dir;
  for (let i = 1, m = steps(TURN_OUT); i <= m; i++) {
    const u = i / m;
    const line = add(e, scale(d2, u * TURN_OUT));
    pts.push(lerpVec(line, lanePose(next, sa + u * TURN_OUT).pos, smoothstep(u)));
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const end = sa + TURN_OUT;
  const start = end - cum[cum.length - 1];
  for (const s of cars) at.push(start + cum[marks.indexOf(s)]);
  if (backAt) back = [start + cum[backAt[0]], start + cum[backAt[1]]];
  const turn: LaneTurn = { path: pts, end, lead: at[cars.indexOf(head)], ...(back ? { back } : {}) };
  return { turn, from: at };
}

function cubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

const lerpVec = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/**
 * Колонне можно разворачиваться (lane.turn.wait снят в момент now): машины трогаются по очереди — каждая не ближе к
 * предыдущей, чем её длина с зазором (crewSpacing), и дальше идут с одной скоростью.
 */
export function releaseTurn(lane: CrewLane, now: number): void {
  if (!lane.turn) return;
  delete lane.turn.wait;
  const from = lane.from ?? [];
  const t: number[] = [];
  from.forEach((s, k) => {
    if (!k) return t.push(now);
    const gap = from[k - 1] - s;
    t.push(t[k - 1] + Math.max(0, crewSpacing(k - 1) - gap) / TURN_SPEED);
  });
  lane.t0 = now;
  lane.t = t;
}

/** Колонна ещё разворачивается: ждёт своей очереди или какая-то машина не доехала до конца разворота. */
export function turning(lane: CrewLane, target: readonly number[], time: number): boolean {
  const turn = lane.turn;
  if (!turn) return false;
  if (turn.wait) return true;
  return laneArcs(lane, target, time)
    .slice(0, laneCars(lane))
    .some((s) => s < turn.end - 1e-6);
}

/** Ряд, в который бригада перестроится последним (куда она едет сейчас), м вправо по ходу. */
export function laneRow(lane: CrewLane): number {
  const s = lane.shifts;
  return s?.length ? s[s.length - 1].to : 0;
}

/** Сдвиг машины вбок от оси полосы в s метрах от её начала и его производная по пути (наклон корпуса). */
export function laneShift(lane: CrewLane, s: number): { lat: number; slope: number } {
  let lat = 0;
  let slope = 0;
  let was = 0;
  for (const sh of lane.shifts ?? []) {
    const u = (s - sh.at) / ROW_RAMP;
    const d = sh.to - was;
    lat += d * smoothstep(u);
    if (u > 0 && u < 1) slope += (d * 6 * u * (1 - u)) / ROW_RAMP;
    was = sh.to;
  }
  return { lat, slope };
}

/** Длина ломаной. */
export function polyLength(p: readonly Vec[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += dist(p[i - 1], p[i]);
  return s;
}

/** Ломаная не короче стольких точек ищет место по разметке (polyMarks) половинным делением, а не перебором с начала. */
export const POLY_INDEX_MIN = 16;

/** Разметка длинной ломаной: её ненулевые отрезки (начало, курс, длина) и где каждый кончается, м от начала. */
interface PolyMarks {
  n: number;
  first: Vec;
  last: Vec;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  from: Vec[];
  dirs: Vec[];
  ends: Float64Array;
}

const polyMarksOf = new WeakMap<readonly Vec[], PolyMarks>();

/**
 * Разметка ломаной p — один раз на массив точек (полоса бригады, путь колонны): машины колонны и вторые части машин
 * (laneTrail — десятки вызовов polyAt на машину в кадр) ищут своё место на длинной полосе половинным делением.
 * Массив поменяли (другие точки или их число) — разметка заново.
 */
function polyMarks(p: readonly Vec[]): PolyMarks {
  const n = p.length;
  const first = p[0];
  const last = p[n - 1];
  const had = polyMarksOf.get(p);
  if (had && had.n === n && had.first === first && had.last === last && had.x0 === first.x && had.y0 === first.y && had.x1 === last.x && had.y1 === last.y) return had;
  const from: Vec[] = [];
  const dirs: Vec[] = [];
  const ends: number[] = [];
  let s = 0;
  for (let i = 1; i < n; i++) {
    const a = p[i - 1];
    const b = p[i];
    const d = dist(a, b);
    if (d < 1e-9) continue;
    from.push(a);
    dirs.push({ x: (b.x - a.x) / d, y: (b.y - a.y) / d });
    s += d;
    ends.push(s);
  }
  const marks: PolyMarks = { n, first, last, x0: first.x, y0: first.y, x1: last.x, y1: last.y, from, dirs, ends: Float64Array.from(ends) };
  polyMarksOf.set(p, marks);
  return marks;
}

/** Точка ломаной в s метрах от начала и направление там; за концами — по касательной (продолжение прямо). */
export function polyAt(p: readonly Vec[], s: number): { pos: Vec; dir: Vec } {
  if (p.length >= POLY_INDEX_MIN) {
    // Длинная ломаная — по разметке: первый отрезок, что кончается не раньше s (как перебор ниже).
    const m = polyMarks(p);
    const k = m.ends.length;
    if (!k) return { pos: add(p[p.length - 1], { x: Math.max(0, s), y: 0 }), dir: { x: 1, y: 0 } };
    // Курс — копией: разметка общая, ответ вызывающий волен менять.
    if (s < 0) return { pos: add(m.from[0], scale(m.dirs[0], s)), dir: { ...m.dirs[0] } };
    let lo = 0;
    let hi = k;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (m.ends[mid] >= s) hi = mid;
      else lo = mid + 1;
    }
    if (lo < k) {
      const start = lo ? m.ends[lo - 1] : 0;
      return { pos: add(m.from[lo], scale(m.dirs[lo], s - start)), dir: { ...m.dirs[lo] } };
    }
    return { pos: add(p[p.length - 1], scale(m.dirs[k - 1], Math.max(0, s - m.ends[k - 1]))), dir: { ...m.dirs[k - 1] } };
  }
  const pts = p.length ? p : [{ x: 0, y: 0 }];
  let dir = { x: 1, y: 0 };
  let left = s;
  let first = true;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = dist(a, b);
    if (d < 1e-9) continue;
    dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    // Позади начала — назад по первому отрезку.
    if (first && left < 0) return { pos: add(a, scale(dir, left)), dir };
    first = false;
    if (left <= d) return { pos: add(a, scale(dir, left)), dir };
    left -= d;
  }
  return { pos: add(pts[pts.length - 1], scale(dir, Math.max(0, left))), dir };
}

/** Где на ломаной (м от начала) ближайшая к p точка. */
export function polyProject(p: readonly Vec[], q: Vec): number {
  let best = Infinity;
  let at = 0;
  let s = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1];
    const ab = sub(p[i], a);
    const L = Math.hypot(ab.x, ab.y);
    if (L < 1e-9) continue;
    const t = Math.max(0, Math.min(1, dot(sub(q, a), ab) / (L * L)));
    const d = dist(q, add(a, scale(ab, t)));
    if (d < best - 1e-9) {
      best = d;
      at = s + t * L;
    }
    s += L;
  }
  return at;
}

/**
 * Ломаная со скруглёнными поворотами: у каждого излома круче 4° — дуга (квадратичная кривая Безье) радиуса около r,
 * не длиннее соседних отрезков (половины — если и там излом). Почти совпадающие точки убираются. Первые keep точек —
 * на месте (там стоят машины): дуга начинается не раньше последней из них.
 */
export function fillet(p: readonly Vec[], r = TURN_R, keep = 0): Vec[] {
  const pts: Vec[] = [];
  for (const q of p) if (!pts.length || dist(pts[pts.length - 1], q) > 0.05) pts.push({ ...q });
  if (pts.length < 3) return pts;
  const angle = (i: number) => {
    if (i <= 0 || i + 1 >= pts.length) return 0;
    const d1 = sub(pts[i], pts[i - 1]);
    const d2 = sub(pts[i + 1], pts[i]);
    return Math.acos(Math.max(-1, Math.min(1, dot(d1, d2) / (Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y)))));
  };
  const out: Vec[] = [pts[0]];
  /** Сколько от начала текущего отрезка уже съело скругление предыдущего излома. */
  let used = 0;
  for (let i = 1; i + 1 < pts.length; i++) {
    const [a, b, c] = [pts[i - 1], pts[i], pts[i + 1]];
    const l1 = dist(a, b);
    const l2 = dist(b, c);
    const d1 = scale(sub(b, a), 1 / l1);
    const d2 = scale(sub(c, b), 1 / l2);
    const th = angle(i);
    if (th < 0.07) {
      out.push(b);
      used = 0;
      continue;
    }
    // До излома — вся прямая перед ним (отрезки подряд без изломов), кроме съеденного прошлым скруглением; после —
    // отрезок целиком, а если и там излом — половина.
    let run = l1;
    if (used === 0) for (let j = i - 1; j > 0 && j >= keep && angle(j) < 0.07; j--) run += dist(pts[j - 1], pts[j]);
    const t = Math.max(0, Math.min(r * Math.tan(Math.min(th, 2.6) / 2), run - used, angle(i + 1) >= 0.07 ? l2 / 2 : l2 * 0.95));
    used = t;
    const p1 = sub(b, scale(d1, t));
    // Дуга начинается раньше предыдущих точек на той же прямой — их уже нет.
    while (out.length > 1 && dot(sub(out[out.length - 1], p1), d1) > -1e-9) out.pop();
    // Дуга окружности p1 → p2 (касательные на концах — по соседним отрезкам): кривизна по всей дуге одна, без
    // крутой середины, как у параболы.
    if (t < 1e-6) out.push(b);
    else out.push(...arcPoints(p1, d1, t / Math.tan(th / 2), d1.x * d2.y - d1.y * d2.x > 0 ? th : -th));
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Точки дуги окружности радиуса r от p с курсом d на угол turn (рад; больше 0 — в сторону (-d.y, d.x), меньше — в
 * другую), с началом и концом. Шаг — не круче 2,5°: на дуге курс машины меняется плавно.
 */
export function arcPoints(p: Vec, d: Vec, r: number, turn: number): Vec[] {
  const sign = turn >= 0 ? 1 : -1;
  const th = Math.abs(turn);
  const c = { x: p.x - d.y * r * sign, y: p.y + d.x * r * sign };
  const v = sub(p, c);
  const n = Math.max(2, Math.ceil(th / 0.044));
  const out: Vec[] = [];
  for (let k = 0; k <= n; k++) {
    const a = (sign * th * k) / n;
    const cs = Math.cos(a);
    const sn = Math.sin(a);
    out.push({ x: c.x + v.x * cs - v.y * sn, y: c.y + v.x * sn + v.y * cs });
  }
  return out;
}

/**
 * Съезд колонны с дороги на стройку: головная стоит в своей полосе у узла (p, курс d), дальше путь body — от центра
 * узла по оси проекта. Поворот — там, где линия полосы пересекает ось проекта (как машина и повернула бы, не заезжая к
 * центру узла и не виляя), — дугой окружности радиуса TURN_R. Машина стоит к оси ближе, чем нужно такой дуге (у
 * стоп-линии перед самым перекрёстком или в самом узле), — дуга начинается прямо от неё, а не сжимается в разворот на
 * месте: машину выносит за ось не дальше over (сколько позволяет ширина полотна проекта, turnRoom), и не короче чем за
 * ENTRY_RAMP метров она плавно выходит на ось. Прямо (ось — почти продолжение полосы) — плавно с полосы на ось на 25 м
 * пути (скругляет fillet). Ответ — точки пути после p и где кончается дуга поворота (end; нет — поворота нет): до неё
 * машины едут медленно (CrewLane.slow).
 */
export function turnIn(p: Vec, d: Vec, body: readonly Vec[], over = ENTRY_OVER): { pts: Vec[]; end?: Vec } {
  const c = body[0];
  // Ось проекта у узла: от центра узла к точке метрах в 12 дальше.
  const far = body.find((q) => dist(q, c) >= 12) ?? body[body.length - 1];
  const len = dist(far, c);
  if (len < 1) return { pts: [...body] };
  const o = { x: (far.x - c.x) / len, y: (far.y - c.y) / len };
  const den = d.x * o.y - d.y * o.x;
  if (Math.abs(den) > 0.25) {
    // p + a·d = c + b·o.
    const w = sub(c, p);
    const a = (w.x * o.y - w.y * o.x) / den;
    const b = (w.x * d.y - w.y * d.x) / den;
    // Машина и в самом узле (почти на оси или чуть за ней) — тоже дугой, а не изломом с места.
    const reach = over / Math.max(0.25, Math.sin(Math.acos(Math.max(-1, Math.min(1, dot(d, o))))));
    if (a > 1 - reach && a < 40 && b > -15 && b < 15) {
      const x = add(p, scale(d, a));
      const th = Math.acos(Math.max(-1, Math.min(1, dot(d, o))));
      const tan = Math.tan(th / 2);
      // Вынос за ось — (t − a)·sin θ: радиус — TURN_R, а если машине так не уложиться — сколько позволяет вынос.
      const r = Math.min(TURN_R, (a + reach) / tan);
      const t = r * tan;
      const arc = arcPoints(t < a ? sub(x, scale(d, t)) : p, d, r, den > 0 ? th : -th);
      const end = arc[arc.length - 1];
      // Дальше — по оси: точки оси за концом дуги; вынесло за ось — сначала плавно на неё.
      const cum = [0];
      for (let i = 1; i < body.length; i++) cum.push(cum[i - 1] + dist(body[i - 1], body[i]));
      const uE = polyProject(body, end);
      const at = polyAt(body, uE);
      const off = dot(sub(end, at.pos), rightNormal(at.dir));
      const pts = [...arc];
      let past = uE;
      if (Math.abs(off) > 0.05) {
        // Длиннее с большим выносом: наклон корпуса при выходе на ось — не круче ~14°.
        const ramp = Math.max(ENTRY_RAMP, 6 * Math.abs(off));
        const n = Math.ceil(ramp);
        for (let i = 1; i <= n; i++) {
          const q = polyAt(body, uE + (ramp * i) / n);
          pts.push(add(q.pos, scale(rightNormal(q.dir), off * (1 - smoothstep(i / n)))));
        }
        past = uE + ramp;
      }
      pts.push(...body.filter((_, i) => cum[i] > past + 1));
      return { pts, end };
    }
  }
  // Почти прямо: с полосы на ось — плавно, без поворота у центра узла.
  return { pts: body.filter((q) => dot(sub(q, p), d) > 25 || dist(q, p) > 25) };
}

/** Как ждут своего края машины на участке (stageSlots). */
export interface SlotOptions {
  /** Дальше какого места машины не заезжают (у готовой дороги в конце — перед её перекрёстком: оттуда выедут в поток). */
  end?: number;
  /** Не начатые ждут на самом участке, колонной от его начала (обычная дорога), а не позади него (мост, тоннель). */
  ahead?: boolean;
  /** Полоса идёт дальше по следующему участку — сколько её там, м (0 — не идёт). */
  ext?: number;
  /** На следующем участке не начатые тоже ждут на нём самом (ahead). */
  extAhead?: boolean;
}

/**
 * Места машин этапов на участке длиной L (м от начала заполнения; меньше 0 — позади, на полосе, откуда пришла колонна;
 * больше L — на следующем участке полосы): у каждого этапа — его машина у его края (stageSpans). Не начатые ждут
 * колонной у начала: на обычной дороге — уже на участке (ahead: разметка у самого начала, перед ней покрытие, впереди
 * отсыпка — так они не стоят на готовой дороге, по которой приехали, и не мешают её движению), у моста и тоннеля —
 * позади начала (не на недостроенном пролёте и не в непрорытом тоннеле); трогаются, когда край их догонит. Догоняющий
 * не наезжает на кончившего: если на следующем участке ждут на нём самом (ext, extAhead), кончивший уступает — едет
 * вперёд к своему месту ожидания там; иначе догоняющий встаёт за ним. Всё непрерывно по ходу этапов (at — этапы,
 * spansOf, или по-старому одно done): машина нигде не прыгает и не едет назад, а места у конца участка совпадают с
 * местами ожидания у начала следующего.
 */
export function stageSlots(at: number | readonly number[], L: number, o: SlotOptions = {}): [number, number, number] {
  const f = typeof at === 'number' ? stageSpans(at, L) : at;
  const sp = [crewSpacing(0), crewSpacing(1)];
  const wait = o.ahead ? [sp[0] + sp[1], sp[1], 0] : [0, -sp[0], -sp[0] - sp[1]];
  const push = (o.ext ?? 0) > 0 && !!o.extAhead;
  const far = push ? L + (o.ext ?? 0) : Math.min(L, o.end ?? L);
  const y = f.map((x, k) => Math.min(Math.max(x, wait[k]), far));
  // Дальше на следующем участке ждут на нём — кончивший уступает догоняющему (вперёд); иначе догоняющий встаёт за ним.
  if (push) for (let k = 1; k >= 0; k--) y[k] = Math.min(far, Math.max(y[k], y[k + 1] + sp[k]));
  y[1] = Math.min(y[1], y[0] - sp[0]);
  y[2] = Math.min(y[2], y[1] - sp[1]);
  return [y[0], y[1], y[2]];
}

/** Полуширина машины поперёк хода (с запасом) — на столько ряд техники выступает от своей оси. */
const MACHINE_HALF = 2.6;

/**
 * Ряды техники n бригад на участке c (сдвиг вправо по ходу заполнения, м; по порядку слева направо): ширина полотна
 * по кромкам делится поровну на n полос, каждая бригада — посередине своей, но не дальше кромки с обочиной
 * (ROAD_MARGIN). Полосы уже машины (n бригад на узком полотне) — ряды бок о бок в пределах полотна с обочинами,
 * посередине. Одна бригада — по оси (0).
 */
export function crewRows(c: Corridor, n: number): number[] {
  const b = c.build;
  const L = c.length;
  // «С проездом» на узкой (closure.ts, laneWise): бригада одна и идёт посередине своей половины полотна — правой по
  // ходу заполнения (по другой едут машины).
  if (b && laneWise(b)) return [halfRow(c, b)];
  if (n <= 1) return [0];
  const f = b ? frontOf(spansOf(b, L), L).s : 0;
  const s = Math.max(0, Math.min(L, b?.fromB ? L - f : f));
  const e = edgesAt(c, s) ?? [-3.5, 3.5];
  // При ходе от конца b «вправо по ходу» — влево по оси полотна: ряды — зеркально.
  const sign = b?.fromB ? -1 : 1;
  const lo = e[0] - ROAD_MARGIN + MACHINE_HALF;
  const hi = e[1] + ROAD_MARGIN - MACHINE_HALF;
  const strip = (e[1] - e[0]) / n;
  let rows: number[];
  if (strip >= 2 * MACHINE_HALF) rows = Array.from({ length: n }, (_, k) => Math.max(lo, Math.min(hi, e[0] + (k + 0.5) * strip)));
  else {
    const mid = (lo + hi) / 2;
    const step = Math.min(2 * MACHINE_HALF + 0.4, Math.max(0, hi - lo) / (n - 1));
    rows = Array.from({ length: n }, (_, k) => mid + (k - (n - 1) / 2) * step);
  }
  rows = rows.map((r) => r * sign);
  return sign < 0 ? rows.reverse() : rows;
}

/**
 * Ряд бригады «с проездом» на узкой (laneWise) при стройке b на полотне c: посередине перекладываемой половины —
 * правой по ходу заполнения.
 */
export function halfRow(c: Corridor, b: CorridorBuild): number {
  const L = c.length;
  const f = frontOf(spansOf(b, L), L).s;
  const e = edgesAt(c, Math.max(0, Math.min(L, b.fromB ? L - f : f))) ?? [-3.5, 3.5];
  const half = b.fromB ? -e[0] : e[1];
  return Math.max(MACHINE_HALF, half / 2);
}

/**
 * Точка полосы в s метрах от начала с учётом ряда: нос машины и курс корпуса (по касательной перестроения). До конца
 * разворота (CrewLane.turn) — на пути разворота.
 */
export function lanePose(lane: CrewLane, s: number): { pos: Vec; dir: Vec } {
  if (lane.turn && s < lane.turn.end) return turnPose(lane.turn, s);
  const at = polyAt(lane.path, s);
  if (!lane.shifts?.length) return at;
  const { lat, slope } = laneShift(lane, s);
  const n = rightNormal(at.dir);
  // Производная сдвига по пути — наклон корпуса при перестроении.
  const d = add(at.dir, scale(n, slope));
  const l = Math.hypot(d.x, d.y);
  return { pos: add(at.pos, scale(n, lat)), dir: { x: d.x / l, y: d.y / l } };
}

/**
 * Где вторая часть машины (самосвал за грейдером, каток за укладчиком) на полосе: её задняя ось — на полосе, на длине
 * сцепки (tail) от шарнира, а шарнир — прямо позади носа (как рисует vehicleArt). Так вторая часть на повороте идёт по
 * следу передней и не выступает назад на следующую машину. s — нос машины на полосе; nose и dir — его точка и курс.
 */
export function laneTrail(lane: CrewLane, s: number, nose: Vec, dir: Vec, joint: number, tail: number, car?: number): Vec {
  const j = sub(nose, scale(dir, joint));
  // Разворот в три приёма: задним ходом след впереди — вторая часть всё время разворота прямо за первой (до и после
  // него путь прямой — там это и так её место).
  const turn = lane.turn;
  if (turn?.back && s >= turn.lead && s <= turn.end + joint + tail + 2) return sub(j, scale(dir, tail));
  const pose = (u: number) => (car === undefined ? lanePose(lane, u) : laneCarPose(lane, car, u));
  // Ближе к шарниру — короче; дальше назад по полосе — длиннее: половинным делением.
  let lo = s - joint - tail - 20;
  let hi = s - joint;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (dist(pose(mid).pos, j) > tail) lo = mid;
    else hi = mid;
  }
  return pose((lo + hi) / 2).pos;
}

/**
 * Машина car на полосе в s метрах от начала: как lanePose, но сошедшая на полосу вбок от её линии (CrewLane.side) —
 * плавно выходит на неё за ROW_RAMP метров пути от места, где сошла (курс — по касательной этого выхода).
 */
export function laneCarPose(lane: CrewLane, car: number, s: number): { pos: Vec; dir: Vec } {
  const at = lanePose(lane, s);
  const turn = lane.turn;
  if (turn && !turn.back && s > turn.lead) {
    // На дуге разворота корпус — по хорде от задней оси (она идёт по тому же следу на base позади) к носу: машина
    // срезает дугу внутрь, а не торчит по касательной за кромку. С места, где головная тронулась, — плавно с касательной.
    const spec = CREW_UNITS[Math.min(car, CREW_UNITS.length - 1)];
    const base = steerBase(spec.body) * spec.length;
    if (s - base < turn.end) {
      const rear = lanePose(lane, s - base).pos;
      const c = sub(at.pos, rear);
      const l = Math.hypot(c.x, c.y);
      const w = smoothstep((s - turn.lead) / TURN_IN);
      if (l > 1e-6) {
        const d = add(scale(at.dir, 1 - w), scale(c, w / l));
        const m = Math.hypot(d.x, d.y);
        if (m > 1e-6) return { pos: at.pos, dir: { x: d.x / m, y: d.y / m } };
      }
    }
    return at;
  }
  const off = lane.side?.[car] ?? 0;
  const s0 = lane.from?.[car];
  if (Math.abs(off) < 1e-6 || s0 === undefined) return at;
  const u = (s - s0) / ROW_RAMP;
  if (u >= 1) return at;
  const lat = off * (1 - smoothstep(u));
  const slope = u > 0 ? (-off * 6 * u * (1 - u)) / ROW_RAMP : 0;
  const n = rightNormal(at.dir);
  const d = add(at.dir, scale(n, slope));
  const l = Math.hypot(d.x, d.y);
  return { pos: add(at.pos, scale(n, lat)), dir: { x: d.x / l, y: d.y / l } };
}

/**
 * Где машина, стоящая в p (курс d), сходит на полосу: место на ней (м от начала; позади начала — меньше 0, по
 * продолжению первого отрезка назад) и сдвиг вбок от её линии (вправо по ходу).
 */
export function laneEntry(lane: CrewLane, p: Vec): { s: number; side: number } {
  let s = polyProject(lane.path, p);
  if (s < 1e-6 && lane.path.length > 1) {
    const a = lane.path[0];
    const t = sub(lane.path[1], a);
    const l = Math.hypot(t.x, t.y);
    if (l > 1e-9) s = Math.min(0, dot(sub(p, a), t) / l);
  }
  const at = lanePose(lane, s);
  return { s, side: dot(sub(p, at.pos), rightNormal(at.dir)) };
}

/**
 * Где на полосе (м от начала) машины колонны: идут от мест from со скоростью LANE_SPEED к целям target (местам
 * этапов), не дальше цели и не назад; каждая — со своего времени (CrewLane.t). Нет from — уже на местах; машины, что
 * ещё не сошли на полосу (from короче), — сразу у цели (их на полосе не видно — Crews.carsAt).
 */
export function laneArcs(lane: CrewLane, target: readonly number[], time: number): number[] {
  const from = lane.from;
  const t0 = lane.t0;
  if (!from || t0 === undefined) return [...target];
  const turn = lane.turn;
  const zones = slowZones(lane);
  return target.map((x, k) => {
    const s0 = from[k] ?? x;
    // Ждут разворота — стоят, где стояли.
    if (turn?.wait) return s0;
    const dt = Math.max(0, time - (lane.t?.[k] ?? t0));
    return Math.min(advance(s0, dt, zones), Math.max(x, s0));
  });
}

/**
 * На съезде с поворотом (CrewLane.slow) машина, что стоит у своего места (догнала его или ждёт, пока оно не уйдёт
 * вперёд), трогается оттуда, где стоит, — со скоростью съезда, а не следом за местом с его скоростью: на дуге курс
 * не крутится быстрее, чем у машины, что едет по ней сама. Каждый такт (Construction.trackCrews): у такой машины
 * откуда (from) и когда (t) — здесь и сейчас; не вышедшая ещё вбок на полосу (side) — дальше с оставшегося сдвига.
 */
export function holdOnCurve(lane: CrewLane, target: readonly number[], time: number): void {
  const from = lane.from;
  const t0 = lane.t0;
  if (lane.slow === undefined || !from || t0 === undefined || lane.turn?.wait) return;
  const zones = slowZones(lane);
  const now = laneArcs(lane, target, time);
  for (let k = 0; k < laneCars(lane); k++) {
    const s0 = from[k];
    const s = now[k];
    if (s0 === undefined || s >= lane.slow) continue;
    const t = lane.t?.[k] ?? t0;
    // Едет сама — не держит место.
    if (s >= advance(s0, Math.max(0, time - t), zones) - 1e-9) continue;
    if (s === s0 && t === time) continue;
    const off = lane.side?.[k];
    if (lane.side && off) lane.side[k] = off * (1 - smoothstep(Math.max(0, Math.min(1, (s - s0) / ROW_RAMP))));
    from[k] = s;
    lane.t = from.map((_, i) => lane.t?.[i] ?? t0);
    lane.t[k] = time;
  }
}

/** Где машины на полосе едут медленно: до конца разворота и ещё TURN_TAIL — TURN_SPEED, до конца съезда (slow) — ENTRY_SPEED. */
function slowZones(lane: CrewLane): { end: number; v: number }[] {
  const out: { end: number; v: number }[] = [];
  if (lane.turn) out.push({ end: lane.turn.end + TURN_TAIL, v: TURN_SPEED });
  if (lane.slow !== undefined) out.push({ end: lane.slow, v: ENTRY_SPEED });
  return out;
}

/**
 * Откуда s0 за dt секунд: до конца каждой медленной зоны (slowZones; пока задняя ось машины ещё на развороте или на
 * повороте съезда) — со скоростью самой медленной из тех, что ещё впереди, дальше — LANE_SPEED.
 */
function advance(s0: number, dt: number, zones: readonly { end: number; v: number }[]): number {
  let s = s0;
  let left = dt;
  const ends = zones.map((z) => z.end).filter((e) => e > s0).sort((a, b) => a - b);
  for (const e of ends) {
    if (e <= s) continue;
    const v = Math.min(LANE_SPEED, ...zones.filter((z) => z.end > s).map((z) => z.v));
    const need = (e - s) / v;
    if (left <= need) return s + left * v;
    left -= need;
    s = e;
  }
  return s + left * LANE_SPEED;
}

/** Сколько машин колонны уже на полосе (сошли с дороги по порядку): from короче колонны — только первые. */
export function laneCars(lane: CrewLane): number {
  return lane.from ? Math.min(lane.from.length, CREW_CARS) : CREW_CARS;
}

/** Колонна уже на местах: все машины доехали до целей. */
export function laneSettled(lane: CrewLane, target: readonly number[], time: number): boolean {
  const now = laneArcs(lane, target, time);
  return now.every((s, k) => s >= target[k] - 1e-6);
}
