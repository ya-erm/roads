/**
 * Стройка полотна — чистые расчёты, без игры (их берут и строитель дорог, и стройка): сколько секунд метр этого
 * полотна, сколько уже заплачено за готовое, перенос готового из одной копии сети в другую.
 */
import { CONSTRUCTION } from '../config';
import type { CurveLUT } from '../core/bezier';
import type { Vec } from '../core/vec';
import type { Corridor, CorridorBuild, LaneNet } from '../lanes/model';
import type { Network, Segment } from '../world/network';

/**
 * Участок проекта стройки: полотно дороги (Corridor) или ж/д путь (Segment) — концы (узлы своей сети), длина, ось и
 * стройка. Ход стройки, этапы, фронты и оплата у них общие (construction.ts).
 */
export interface Piece {
  id: number;
  a: number;
  b: number;
  length: number;
  lut: CurveLUT;
  build?: CorridorBuild;
  /** Ревизия формы (кэши цены и состава по ней). */
  rev: number;
}

/**
 * Сколько бригад встанет на проект с недостроенными полотнами cs: есть полотно в одну полосу (съезд, заезд,
 * односторонняя) — не больше brigade.perNarrow (столько рядов техники помещается на нём бок о бок), иначе perProject.
 * По самому узкому полотну проекта, а не по участку у края работ: предел не скачет, пока колонна идёт по проекту.
 */
export function crewCap(cs: readonly Corridor[]): number {
  const { perProject, perNarrow } = CONSTRUCTION.brigade;
  return cs.some((c) => c.lanes.length <= 1) ? Math.min(perProject, perNarrow) : perProject;
}

/** Во сколько раз метр сооружения на высоте h (уровень) дольше метра на земле; water — под ним вода. */
export function structureWork(h: number, water: boolean): number {
  const K = CONSTRUCTION;
  if (h < -0.25) return 1 + (K.tunnel - 1) * Math.min(-h, 1);
  const up = h > 0.25 ? 1 + (K.bridge - 1) * Math.min(h, 1) + (K.overpass - K.bridge) * Math.max(0, Math.min(1, h - 1)) : 1;
  return water ? Math.max(up, K.water) : up;
}

/**
 * Во сколько раз метр полотна строится дольше метра обычной дороги (улица 1+1 на земле): класс, полосы сверх двух,
 * мосты, эстакады и тоннели — по высоте вдоль оси (пандус — по промежуточной).
 */
export function workFactor(net: LaneNet, c: Corridor, isWater: (p: Vec, margin?: number) => boolean): number {
  const K = CONSTRUCTION;
  const n = Math.max(2, Math.ceil(c.length / 24));
  let struct = 0;
  for (let i = 0; i < n; i++) {
    const s = (c.length * (i + 0.5)) / n;
    const h = net.heightAt(c, s);
    // Вода важна только для моста над ней: на земле дорога через воду не идёт.
    struct += structureWork(h, h > 0.25 && isWater(c.lut.pointAt(s), 2));
  }
  struct /= n;
  return K.cls[c.cls] * (1 + K.lane * Math.max(0, c.lanes.length - 2)) * struct;
}

/** Метров в секунду игры на скорости ×1 для этого полотна. */
export function buildRate(net: LaneNet, c: Corridor, isWater: (p: Vec, margin?: number) => boolean): number {
  return CONSTRUCTION.speed / workFactor(net, c, isWater);
}

/**
 * Темп стройки полотна, м/с на ×1 у одной бригады: новая дорога — buildRate; перестройка готовой (CorridorBuild.was,
 * rebuild.ts) — быстрее на долю work (на месте часть работы уже сделана), а по полосам (part) — в partial раз дольше.
 */
export function pieceRate(net: LaneNet, c: Corridor, isWater: (p: Vec, margin?: number) => boolean): number {
  const w = c.build?.was;
  const rate = buildRate(net, c, isWater);
  return w ? rate / (Math.max(0.05, w.work) * (w.part ? CONSTRUCTION.rebuild.partial : 1)) : rate;
}

/** Во сколько раз метр ж/д пути строится дольше метра обычной дороги: класс «rail» и мосты, эстакады, тоннели по высоте. */
export function railWorkFactor(net: Network, s: Segment, isWater: (p: Vec, margin?: number) => boolean): number {
  const n = Math.max(2, Math.ceil(s.length / 24));
  let struct = 0;
  for (let i = 0; i < n; i++) {
    const at = (s.length * (i + 0.5)) / n;
    const h = net.levelAt(s, at);
    struct += structureWork(h, h > 0.25 && isWater(s.lut.pointAt(at), 2));
  }
  return CONSTRUCTION.cls.rail * (struct / n);
}

/** Метров ж/д пути в секунду игры на скорости ×1 у одной бригады. */
export function railBuildRate(net: Network, s: Segment, isWater: (p: Vec, margin?: number) => boolean): number {
  return CONSTRUCTION.speed / railWorkFactor(net, s, isWater);
}

/** На сколько метров этап колонны отстаёт от предыдущего на участке длиной L. */
export function convoyGap(L: number): number {
  return Math.min(CONSTRUCTION.convoyGap, L / 4);
}

/** Докуда дошёл каждый этап участка (отсыпка, покрытие, разметка): метров от начала заполнения. */
export type Spans = [number, number, number];

/**
 * Этапы участка — у каждого свой ход (CorridorBuild.stages): каждый этап ведёт своя машина бригады, и этап, чья
 * машина ещё не на месте, стоит, а остальные идут. Сохранение без stages (одно done) — этапы колонной из done
 * (stageSpans). Нет стройки — ничего.
 */
export function spansOf(b: CorridorBuild | undefined, L: number): Spans {
  if (!b) return [0, 0, 0];
  const s = b.stages;
  if (Array.isArray(s) && s.length === 3 && s.every((x) => Number.isFinite(x))) return s.map((x) => Math.max(0, Math.min(L, x))) as Spans;
  return stageSpans(b.done, L);
}

/** Сколько работы готово «в метрах» (как платится, 0…L) при этапах spans: сумма долей этапов по пройденному ими. */
export function stageWork(spans: readonly number[], L: number): number {
  if (!(L > 0)) return 0;
  // Все дошли до конца — ровно L (без хвоста от деления дробей).
  if (spans.every((s) => s >= L - 1e-9)) return L;
  const w = CONSTRUCTION.stages;
  return Math.min(L, spans.reduce((sum, s, k) => sum + w[k] * Math.max(0, Math.min(L, s)), 0));
}

/**
 * Докуда может дойти этап k (1 — покрытие, 2 — разметка) при предыдущем на prev: не ближе convoyGap к нему, пока тот не
 * дошёл до конца участка; дошёл — до конца (разрыв в конце сходится к нулю).
 */
function stageCap(prev: number, L: number): number {
  return prev >= L - 1e-9 ? L : Math.max(0, prev - convoyGap(L));
}

/**
 * Этапы участка длиной L вперёд на dt секунд: этап k — со своим темпом speed[k] (м/с; 0 — его машины нет на месте),
 * покрытие — не ближе convoyGap к отсыпке, разметка — так же к покрытию (stageCap); назад этап не идёт. used — сколько
 * из dt этапы шли (меньше dt — участок дошёл до конца раньше: остаток времени — следующему участку).
 */
export function advanceStages(spans: readonly number[], L: number, speed: readonly number[], dt: number): { spans: Spans; used: number } {
  const out: Spans = [0, 0, 0];
  let used = 0;
  for (let k = 0; k < 3; k++) {
    const s = Math.max(0, Math.min(L, spans[k] ?? 0));
    const v = Math.max(0, speed[k] ?? 0);
    const cap = k === 0 ? L : stageCap(out[k - 1], L);
    out[k] = Math.max(s, Math.min(cap, s + v * dt));
    if (v > 0) used = Math.max(used, (out[k] - s) / v);
  }
  // Участок не кончился — время ушло целиком (этапы ждали друг друга или свою машину).
  return { spans: out, used: out[2] >= L - 1e-9 ? Math.min(dt, used) : dt };
}

/**
 * Сколько секунд ещё строить участок длиной L с этапами spans, если все машины на месте и каждый этап идёт v м/с:
 * этап кончается не раньше, чем через convoyGap после предыдущего (stageCap), — по последнему, разметке.
 */
export function stageSeconds(spans: readonly number[], L: number, v: number): number {
  if (!(v > 0)) return Infinity;
  const g = convoyGap(L);
  let t = 0;
  for (let k = 0; k < 3; k++) {
    const left = Math.max(0, L - (spans[k] ?? 0)) / v;
    t = k > 0 && (spans[k - 1] ?? 0) < L - 1e-9 ? Math.max(t + Math.min(g, L - (spans[k] ?? 0)) / v, left) : Math.max(t, left);
  }
  return t;
}

/**
 * Этапы участка (CONSTRUCTION.stages) идут колонной: впереди земляные работы, за ними на convoyGap — покрытие, за ним
 * так же — разметка и знаки; этап, которому впереди уже некого ждать (предыдущий дошёл до конца), догоняет до конца.
 * Голова колонны x: этап k — на x − k·gap (в пределах участка), работа — сумма долей этапов по пройденному ими.
 * done — сколько работы готово «в метрах» (0…L, как платится); ответ — докуда (метров от начала заполнения) дошёл
 * каждый этап. Так этапы выводятся из одного done в сохранениях, где своего хода у этапов ещё не было (spansOf).
 */
export function stageSpans(done: number, L: number): [number, number, number] {
  if (!(L > 0) || done <= 0) return [0, 0, 0];
  // Конец этапа — ровно L (без хвоста от деления дробей).
  if (done >= L) return [L, L, L];
  const w = CONSTRUCTION.stages;
  const g = convoyGap(L);
  const at = (x: number): [number, number, number] => [0, 1, 2].map((k) => Math.max(0, Math.min(L, x - k * g))) as [number, number, number];
  const work = (x: number) => at(x).reduce((sum, s, k) => sum + w[k] * s, 0);
  // Работа от головы колонны — ломаная: изломы там, где этап начинается или доходит до конца.
  const knots = [0, g, 2 * g, L, L + g, L + 2 * g].sort((p, q) => p - q);
  for (let i = 0; i + 1 < knots.length; i++) {
    const [x0, x1] = [knots[i], knots[i + 1]];
    const [d0, d1] = [work(x0), work(x1)];
    if (done <= d1 && d1 > d0) return at(x0 + ((done - d0) / (d1 - d0)) * (x1 - x0));
  }
  return [L, L, L];
}

/**
 * Какой участок проекта строить (Construction.current): начатый, иначе первый (list — по номерам), примыкающий к
 * готовым дорогам (open — у узла есть готовая дорога; заполняется от неё, fromB — от конца b), иначе первый.
 *
 * access — подъезд к узлу (Construction.accessRank): до узла можно доехать с базы по готовым дорогам — число (чем
 * меньше, тем ближе к базе), нельзя — null. С ним из не начатых — участок с подъездом у ближайшего к базе конца (от
 * него и заполняется): стройка идёт от подъезда внутрь проекта, а участок без подъезда ждёт, пока до него дорастёт
 * соседний. Подъезда нет нигде — как без access (проект ждёт, участок — только для показа).
 */
export function pickSite<T extends Piece>(
  list: readonly T[],
  open: (node: number) => boolean,
  access?: (node: number) => number | null,
): { c: T; fromB: boolean } | null {
  if (!list.length) return null;
  const started = list.find((c) => (c.build?.done ?? 0) > 0);
  if (started) return { c: started, fromB: !!started.build?.fromB };
  if (access) {
    let best: { c: T; fromB: boolean; r: number } | null = null;
    for (const c of list) {
      for (const fromB of [false, true]) {
        const r = access(fromB ? c.b : c.a);
        if (r !== null && (!best || r < best.r - 1e-6)) best = { c, fromB, r };
      }
    }
    if (best) return { c: best.c, fromB: best.fromB };
  }
  for (const c of list) {
    const a = open(c.a);
    const b = open(c.b);
    if (a || b) return { c, fromB: !a && b };
  }
  return { c: list[0], fromB: false };
}

/**
 * Участок проекта, который станет строиться, когда достроят c (building — все строящиеся полотна сети): тот же выбор,
 * что у Construction.current, но c уже готова — её концы считаются готовой дорогой.
 */
export function nextSite(net: LaneNet, c: Corridor, building: readonly Corridor[]): { c: Corridor; fromB: boolean } | null {
  const id = c.build?.project;
  if (id === undefined) return null;
  const list = building.filter((x) => x !== c && x.build?.project === id).sort((p, q) => p.id - q.id);
  const open = (node: number) => node === c.a || node === c.b || net.node(node).corridors.some((k) => !net.corridors.get(k)?.build);
  return pickSite(list, open);
}

/** Этап, дошедший до узла на конце полотна: −1 — никакой, 0 — отсыпка, 1 — покрытие, 2 — разметка. */
export type StageReach = -1 | 0 | 1 | 2;

/**
 * Где на полотне длиной L рисовать готовое по этапам spans (stageSpans: докуда дошёл каждый от начала заполнения;
 * fromB — заполняется от конца b). У перекрёстка полотно обрезано (cutA, cutB — метров от концов a и b, как у
 * отрисовки дорог): своё у полотна — только [cutA, L − cutB], дальше площадка перекрёстка, а она — общая с другими
 * дорогами, часто уже готовыми. Отсыпка поэтому — только по своему (earth: отрезок по оси от a, null — нечего), а на
 * площадку этап переходит целиком (reach): у начала заполнения — как только начат, у дальнего конца — когда дошёл до
 * площадки. Покрытие и разметку полотна обрезает сама отрисовка дорог.
 */
export function stageLayout(
  spans: readonly [number, number, number],
  L: number,
  fromB: boolean,
  cutA: number,
  cutB: number,
): { earth: [number, number] | null; reach: { a: StageReach; b: StageReach } } {
  const lo = Math.max(0, cutA);
  const hi = Math.min(L, L - cutB);
  const to = spans[0];
  const [s0, s1] = fromB ? [Math.max(lo, L - to), hi] : [lo, Math.min(hi, to)];
  const earth: [number, number] | null = to > 0 && s1 - s0 > 0.5 ? [s0, s1] : null;
  // Этапы идут колонной: дальше всех — отсыпка, за ней покрытие, за ним разметка.
  const last = (ok: (x: number) => boolean): StageReach => (ok(spans[2]) ? 2 : ok(spans[1]) ? 1 : ok(spans[0]) ? 0 : -1);
  const start = last((x) => x > 0);
  const farCut = Math.max(0, fromB ? cutA : cutB);
  const far = last((x) => x > 0 && x >= L - farCut - 1e-6);
  return { earth, reach: fromB ? { a: far, b: start } : { a: start, b: far } };
}

/**
 * Край работ на участке — голова колонны: метров от начала заполнения и её этап (0 — земля, 1 — покрытие, 2 — разметка;
 * этап, дошедший до конца, головой уже не считается). at — этапы (spansOf) или, по-старому, одно done (stageSpans).
 */
export function frontOf(at: number | readonly number[], L: number): { s: number; stage: 0 | 1 | 2 } {
  const [earth, pave, marks] = typeof at === 'number' ? stageSpans(at, L) : at;
  if (earth < L - 1e-6) return { s: earth, stage: 0 };
  if (pave < L - 1e-6) return { s: pave, stage: 1 };
  return { s: marks, stage: 2 };
}

/** Сколько заплачено за done готовых метров полотна длиной L ценой full: целые доллары, сумма тактов — та же. */
export function paidFor(full: number, done: number, L: number): number {
  return L > 0 ? Math.round(full * Math.max(0, Math.min(1, done / L))) : 0;
}

/**
 * Готовое на путях ж/д проектов — из живой сети (from: по номеру пути — его стройка и концы, как были до замены) в сеть
 * to (снимок для отмены): у тех же путей (номер и концы) берётся больше готового; готовый там — готов и тут. Как
 * carryBuild у дорог: стройка ушла вперёд, пока ждал снимок, — за готовое уже заплачено.
 */
export function carryRailBuild(from: ReadonlyMap<number, { build?: CorridorBuild; p0: Vec; p3: Vec }>, to: Network): void {
  const same = (u: Vec, v: Vec) => Math.abs(u.x - v.x) < 0.01 && Math.abs(u.y - v.y) < 0.01;
  let changed = false;
  for (const s of to.segments.values()) {
    if (!s.build) continue;
    const o = from.get(s.id);
    if (!o || !same(o.p0, s.curve.p0) || !same(o.p3, s.curve.p3)) continue;
    if (!o.build) {
      delete s.build;
      to.touch(s.a);
      to.touch(s.b);
      changed = true;
    } else if (o.build.project === s.build.project && o.build.done > s.build.done) {
      s.build = { ...o.build, done: Math.min(s.length, o.build.done), ...(o.build.stages ? { stages: [...o.build.stages] as Spans } : {}) };
      changed = true;
    }
  }
  if (changed) to.rebuild();
}

/**
 * Готовое — из сети from (живой) в сеть to (план, снимок для отмены): у тех же полотен (по номеру) берётся больше
 * готового; построенное там целиком — построено и тут. Нужна там, где сеть заменяют копией, сделанной раньше:
 * стройка за это время ушла вперёд. Поменянные полотна получают новую ревизию (отрисовка и граф их обновят).
 */
/** Та же дорога: класс, ось и полосы (смещения и направления) совпадают. */
function sameRoad(o: Corridor, c: Corridor): boolean {
  const near = (u: Vec, v: Vec) => Math.abs(u.x - v.x) < 0.01 && Math.abs(u.y - v.y) < 0.01;
  if (o.cls !== c.cls || o.lanes.length !== c.lanes.length || !near(o.curve.p1, c.curve.p1) || !near(o.curve.p2, c.curve.p2)) return false;
  return o.lanes.every((l, i) => Math.abs(l.offset - c.lanes[i].offset) < 0.01 && l.flow === c.lanes[i].flow && Math.abs(l.to - l.from - (c.lanes[i].to - c.lanes[i].from)) < 0.5);
}

export function carryBuild(from: LaneNet, to: LaneNet): void {
  for (const c of to.corridors.values()) {
    if (!c.build) continue;
    const o = from.corridors.get(c.id);
    // То же полотно: копии, разошедшиеся давно, могли дать один номер разным полотнам — сверяем и концы.
    const same = (u: Vec, v: Vec) => Math.abs(u.x - v.x) < 0.01 && Math.abs(u.y - v.y) < 0.01;
    if (!o || !same(o.curve.p0, c.curve.p0) || !same(o.curve.p3, c.curve.p3)) continue;
    if (!o.build) {
      // Перестройка готовой дороги (план её только что заложил): в живой сети — ещё прежняя дорога, а не достроенная.
      if (c.build.was && !sameRoad(o, c)) continue;
      delete c.build;
      to.touch(c);
    } else if (o.build.project === c.build.project && o.build.done > c.build.done) {
      c.build = { ...o.build, done: Math.min(c.length, o.build.done), ...(o.build.stages ? { stages: [...o.build.stages] as Spans } : {}) };
    }
  }
}
