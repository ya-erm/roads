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
import type { Corridor } from '../lanes/model';
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
    const p2 = add(b, scale(d2, t));
    // Дуга начинается раньше предыдущих точек на той же прямой — их уже нет.
    while (out.length > 1 && dot(sub(out[out.length - 1], p1), d1) > -1e-9) out.pop();
    const n = Math.max(3, Math.ceil(th / 0.12));
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      // Безье p1 → b → p2: касательные на концах — по соседним отрезкам.
      out.push(add(add(scale(p1, (1 - u) * (1 - u)), scale(b, 2 * u * (1 - u))), scale(p2, u * u)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
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
  if (b && laneWise(b)) {
    const f = frontOf(spansOf(b, L), L).s;
    const e = edgesAt(c, Math.max(0, Math.min(L, b.fromB ? L - f : f))) ?? [-3.5, 3.5];
    const half = b.fromB ? -e[0] : e[1];
    return [Math.max(MACHINE_HALF, half / 2)];
  }
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

/** Точка полосы в s метрах от начала с учётом ряда: нос машины и курс корпуса (по касательной перестроения). */
export function lanePose(lane: CrewLane, s: number): { pos: Vec; dir: Vec } {
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
  return target.map((x, k) => {
    const s0 = from[k] ?? x;
    const go = Math.max(0, time - (lane.t?.[k] ?? t0)) * LANE_SPEED;
    return Math.min(s0 + go, Math.max(x, s0));
  });
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
