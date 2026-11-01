import { Cubic, CurveLUT, straightCubic } from '../core/bezier';
import { add, dot, scale, sub, Vec } from '../core/vec';
import { halfWidth, isTrunk, LEVEL_RUN, RoadSpec } from '../world/roadTypes';
import type { Builder, RoadRequest } from './build';
import type { Network } from '../world/network';

/**
 * Шаблоны развязок на магистрали. Поперечная дорога проходит над магистралью по мосту,
 * съезды — односторонние, справа по ходу движения. Если под курсором нет магистрали,
 * она строится вместе с развязкой (прямой участок, поворот — R).
 *
 * Все шаблоны собираются из кусков: каждый кусок — обычная дорога, концы которой
 * при постройке привязываются к уже построенным кускам.
 */

export type TemplateKind = 'diamond' | 'tee' | 'clover';

export const TEMPLATES: { id: TemplateKind; name: string; short: string; hint: string }[] = [
  { id: 'diamond', name: 'Ромб', short: 'мост + 4 съезда', hint: 'Поперечная дорога по мосту, четыре съезда. Компактно, но на поперечной дороге — перекрёстки' },
  { id: 'tee', name: 'Т-образная', short: '«сердце», 2 петли', hint: 'Дорога примыкает к магистрали с одной стороны (со стороны курсора). Две петли за магистралью, без перекрёстков и светофоров' },
  { id: 'clover', name: 'Клеверный лист', short: '4 петли, без светофоров', hint: 'Пересечение двух дорог: четыре петли для левых поворотов и четыре съезда для правых' },
];

/** Кусок шаблона: откуда и куда, на какой высоте, и готовая форма (для съездов). */
export interface TemplatePiece {
  from: Vec;
  fromLevel: number;
  to: Vec;
  toLevel: number;
  spec: RoadSpec;
  curve?: Cubic;
}

export interface TemplatePlan {
  ok: boolean;
  reason?: string;
  cost: number;
  pieces: TemplatePiece[];
  /** Для подсветки: формы всех кусков. */
  preview: Cubic[];
  /** Магистраль строится вместе с развязкой (в чистом поле). */
  withTrunk: boolean;
}

export interface TemplateOptions {
  kind: TemplateKind;
  /** Направление магистрали, если её строим сами. */
  angle: number;
  /** Какую магистраль строить в чистом поле (если выбранный тип — не магистраль, то автомагистраль 2‖2). */
  trunk: RoadSpec;
}

const CROSS: RoadSpec = { cls: 'avenue', lanesF: 1, lanesB: 1 };
const RAMP: RoadSpec = { cls: 'avenue', lanesF: 1, lanesB: 0, limit: 60 };
const LOOP: RoadSpec = { cls: 'avenue', lanesF: 1, lanesB: 0, limit: 40 };
const DEFAULT_TRUNK: RoadSpec = { cls: 'motorway', lanesF: 2, lanesB: 2 };
/** «Ромб»: насколько далеко вдоль магистрали отходят съезды и под каким углом. */
const RAMP_REACH = 260;
const RAMP_ANGLE = 0.35;
/** Горизонтальный разбег моста от края магистрали до земли. */
const UP = LEVEL_RUN + 40;
/** Угол, под которым съезд отходит от дороги и вливается в неё. */
const SPLAY = 0.3;
/** Отступ петли от дороги, в которую она вливается. */
const LOOP_GAP = 30;

/** Место развязки: центр, направление магистрали u и r — вправо от него; H — полуширина магистрали с запасом. */
interface Site {
  C: Vec;
  u: Vec;
  r: Vec;
  H: number;
  /** Где поперечная дорога снова на земле (от оси магистрали). */
  G: number;
  /** Сама магистраль: у «клевера» поперечная дорога — такая же. */
  trunk: RoadSpec;
}

interface Layout {
  pieces: TemplatePiece[];
  /** Сколько прямой магистрали нужно в обе стороны от центра. */
  reach: number;
}

const right = (v: Vec): Vec => ({ x: -v.y, y: v.x });

/** Раскладка развязки у точки p: на магистрали под курсором или в чистом поле вместе с магистралью. */
export function templatePlan(net: Network, builder: Builder, p: Vec, radius: number, budget: number, opts: TemplateOptions): TemplatePlan {
  const fail = (reason: string, pieces: TemplatePiece[] = [], withTrunk = false, cost = 0): TemplatePlan => ({
    ok: false,
    reason,
    cost,
    pieces,
    preview: pieces.map(curveOf),
    withTrunk,
  });
  const hit = net.findSegmentNear(p, Math.max(40, radius), (s) => isTrunk(s.spec.cls) && net.isFlat(s) && net.node(s.a).level === 0 && !s.ring);
  let site: Site;
  let layout: Layout;
  const trunkPieces: TemplatePiece[] = [];
  if (hit) {
    const seg = hit.seg;
    let u = seg.lut.tangentAt(hit.s);
    // Т-образная: ответвление — в сторону курсора.
    if (opts.kind === 'tee' && dot(sub(p, hit.point), right(u)) < -3) u = scale(u, -1);
    const H = halfWidth(seg.spec) + 12;
    site = { C: hit.point, u, r: right(u), H, G: H + UP, trunk: seg.spec };
    layout = layoutFor(opts.kind, site);
    const reach = layout.reach;
    if (hit.s < reach + 40 || seg.length - hit.s < reach + 40) return fail('Нужен длинный прямой участок магистрали без узлов рядом — или поставьте развязку в чистом поле');
    for (const s of [hit.s - reach, hit.s + reach]) {
      if (Math.abs(dot(seg.lut.tangentAt(s), u)) < Math.cos(0.08)) return fail('Развязка — только на прямом участке магистрали');
    }
  } else {
    // Чистое поле: магистраль — прямой участок через центр, поворот — R.
    const trunk = isTrunk(opts.trunk.cls) ? opts.trunk : DEFAULT_TRUNK;
    const u = { x: Math.cos(opts.angle), y: Math.sin(opts.angle) };
    const H = halfWidth(trunk) + 12;
    site = { C: p, u, r: right(u), H, G: H + UP, trunk };
    layout = layoutFor(opts.kind, site);
    const L = layout.reach + 120;
    trunkPieces.push({ from: sub(p, scale(u, L)), fromLevel: 0, to: add(p, scale(u, L)), toLevel: 0, spec: trunk });
  }
  const pieces = [...trunkPieces, ...layout.pieces];
  const withTrunk = trunkPieces.length > 0;
  // Оценка: каждый кусок отдельно против нынешней сети. Магистраль под курсором не мешает —
  // к ней съезды и примыкают; куски между собой согласованы заранее.
  const exclude = hit ? { segs: [hit.seg.id], nodes: [hit.seg.a, hit.seg.b] } : undefined;
  let cost = 0;
  for (const piece of pieces) {
    const plan = builder.plan({ ...pieceRequest(builder, piece), exclude });
    cost += plan.cost;
    if (!plan.ok) return fail(plan.reason ?? 'Нельзя построить', pieces, withTrunk, cost);
  }
  if (cost > budget) return fail('Не хватает денег', pieces, withTrunk, cost);
  return { ok: true, cost, pieces, preview: pieces.map(curveOf), withTrunk };
}

/** Старое имя: «ромб» на магистрали под курсором. */
export function diamondPlan(net: Network, builder: Builder, p: Vec, radius: number, budget: number): TemplatePlan {
  return templatePlan(net, builder, p, radius, budget, { kind: 'diamond', angle: 0, trunk: DEFAULT_TRUNK });
}

function layoutFor(kind: TemplateKind, site: Site): Layout {
  if (kind === 'tee') return teeLayout(site);
  if (kind === 'clover') return cloverLayout(site);
  return diamondLayout(site);
}

// ---------- «Ромб» ----------

function diamondLayout(site: Site): Layout {
  const { C, u, r, H } = site;
  const S = H + UP + 60;
  const L = H + UP + 140;
  const pieces = crossing(site, L, L);
  // Съезды — справа по ходу движения: для +u на стороне +r, для −u на стороне −r.
  const ramps = (dir: Vec, side: Vec): TemplatePiece[] => {
    const before = sub(C, scale(dir, RAMP_REACH));
    const after = add(C, scale(dir, RAMP_REACH));
    const J = add(C, scale(side, S));
    const out = add(scale(dir, Math.cos(RAMP_ANGLE)), scale(side, Math.sin(RAMP_ANGLE)));
    const into = sub(scale(dir, Math.cos(RAMP_ANGLE)), scale(side, Math.sin(RAMP_ANGLE)));
    return [
      // Выезд: от магистрали до моста — на поперечную дорогу.
      ramp(before, J, { p0: before, p1: add(before, scale(out, 110)), p2: sub(J, scale(dir, 90)), p3: J }),
      // Въезд: с поперечной дороги — на магистраль после моста.
      ramp(J, after, { p0: J, p1: add(J, scale(dir, 90)), p2: sub(after, scale(into, 110)), p3: after }),
    ];
  };
  pieces.push(...ramps(u, r), ...ramps(scale(u, -1), scale(r, -1)));
  return { pieces, reach: RAMP_REACH };
}

// ---------- Общие куски ----------

/** Поперечная дорога по мосту: от −back до +front вдоль r (на земле, подъём, мост, спуск, на земле). */
function crossing(site: Site, back: number, front: number): TemplatePiece[] {
  const { C, r, H, G } = site;
  const at = (k: number) => add(C, scale(r, k));
  return [
    { from: at(-back), fromLevel: 0, to: at(-G), toLevel: 0, spec: CROSS },
    { from: at(-G), fromLevel: 0, to: at(-H), toLevel: 1, spec: CROSS },
    { from: at(-H), fromLevel: 1, to: at(H), toLevel: 1, spec: CROSS },
    { from: at(H), fromLevel: 1, to: at(G), toLevel: 0, spec: CROSS },
    { from: at(G), fromLevel: 0, to: at(front), toLevel: 0, spec: CROSS },
  ];
}

function ramp(from: Vec, to: Vec, curve: Cubic, spec = RAMP): TemplatePiece {
  return { from, fromLevel: 0, to, toLevel: 0, spec, curve };
}

/** Кубика по концам и направлениям в них. */
function hermite(p0: Vec, d0: Vec, p3: Vec, d3: Vec, k0: number, k3 = k0): Cubic {
  return { p0, p1: add(p0, scale(d0, k0)), p2: sub(p3, scale(d3, k3)), p3 };
}

/**
 * Четверть развязки в своей системе координат: X — вдоль дороги, с которой съезжают
 * (по ходу движения), Y — вправо от неё; дорога, в которую вливаются, идёт по оси Y,
 * машины на ней едут в сторону −Y. Четверти k = 0..3 повёрнуты друг к другу на 90°:
 * чётные съезжают с магистрали на поперечную дорогу, нечётные — наоборот.
 */
interface Quad {
  P: (x: number, y: number) => Vec;
  D: (x: number, y: number) => Vec;
}

function quad(site: Site, k: number): Quad {
  let X = site.u;
  for (let i = 0; i < k; i++) X = right(X);
  const Y = right(X);
  const D = (x: number, y: number) => add(scale(X, x), scale(Y, y));
  return { P: (x, y) => add(site.C, D(x, y)), D };
}

/** Дуга окружности в системе четверти: угол a отсчитывается от +X к +Y. */
function arcIn(q: Quad, cx: number, cy: number, rho: number, a0: number, a1: number): Cubic {
  const pt = (a: number) => q.P(cx + rho * Math.cos(a), cy + rho * Math.sin(a));
  const tan = (a: number) => q.D(-Math.sin(a), Math.cos(a));
  const h = (4 / 3) * Math.tan((a1 - a0) / 4) * rho;
  return { p0: pt(a0), p1: add(pt(a0), scale(tan(a0), h)), p2: sub(pt(a1), scale(tan(a1), h)), p3: pt(a1) };
}

interface LoopGeom {
  /** Где съезжаем с дороги X. */
  xe: number;
  /** Где вливаемся в дорогу Y. */
  ym: number;
  /** Центр петли по Y и её радиус; по X центр — на LOOP_GAP + rho от дороги Y. */
  cy: number;
  rho: number;
}

/**
 * Петля для левого поворота: съезд направо с дороги X, разворот на 270° и вливание
 * в дорогу Y. Четыре куска: съезд до правого края петли, две дуги, вливание.
 */
function loopPieces(q: Quad, g: LoopGeom): TemplatePiece[] {
  const cx = LOOP_GAP + g.rho;
  const start = q.P(g.xe, 0);
  const rightPt = q.P(cx + g.rho, g.cy);
  const bottom = q.P(cx, g.cy + g.rho);
  const leftPt = q.P(LOOP_GAP, g.cy);
  const end = q.P(0, g.ym);
  const dx = cx + g.rho - g.xe;
  const exit = hermite(start, q.D(Math.cos(SPLAY), Math.sin(SPLAY)), rightPt, q.D(0, 1), Math.max(40, dx * 0.6), g.cy * 0.55);
  const merge = hermite(leftPt, q.D(0, -1), end, q.D(-Math.sin(SPLAY), -Math.cos(SPLAY)), (g.cy - g.ym) * 0.45);
  return [
    ramp(start, rightPt, exit, LOOP),
    ramp(rightPt, bottom, arcIn(q, cx, g.cy, g.rho, 0, Math.PI / 2), LOOP),
    ramp(bottom, leftPt, arcIn(q, cx, g.cy, g.rho, Math.PI / 2, Math.PI), LOOP),
    ramp(leftPt, end, merge, LOOP),
  ];
}

/** Простой съезд для правого поворота без петли рядом: с дороги Y (в R) на дорогу X (в U). */
function simpleOuter(q: Quad, R: number, U: number): TemplatePiece {
  const start = q.P(0, R);
  const end = q.P(U, 0);
  return ramp(start, end, hermite(start, q.D(Math.sin(SPLAY), -Math.cos(SPLAY)), end, q.D(Math.cos(SPLAY), -Math.sin(SPLAY)), Math.min(R, U) * 0.55));
}

// ---------- Т-образная ----------

/**
 * «Сердце»: дорога примыкает к магистрали со стороны +r и проходит над ней по мосту.
 * За магистралью она кончается узлом N0, к которому сходятся две одинаковые петли —
 * зеркальные друг другу: с магистрали на N0 (слева) и с N0 на магистраль (справа).
 * Со стороны примыкания — два почти зеркальных съезда для правых поворотов.
 */
function teeLayout(site: Site): Layout {
  const n0 = site.G + 30;
  const rho = 150;
  // Левая петля (четверть 2): съезжает с магистрали далеко от моста, по большой дуге — в N0.
  const loop = { xe: LOOP_GAP + 2 * rho - 90, ym: n0, cy: n0 + 80, rho };
  const left = loopPieces(quad(site, 2), loop);
  const near = site.G + 180;
  const pieces = [
    ...crossing(site, n0, near + 100),
    ...left,
    // Правая петля — зеркало левой, едут по ней в обратную сторону: из N0 на магистраль.
    ...mirrored(site, left),
    // Съезды для правых поворотов: с магистрали на ответвление и с ответвления на магистраль.
    simpleOuter(quad(site, 1), near, near),
    simpleOuter(quad(site, 0), near + 40, near),
  ];
  return { pieces, reach: Math.max(near, LOOP_GAP + 2 * rho) + 20 };
}

/**
 * Зеркальное отражение кусков с обратным направлением движения: по умолчанию — через ось
 * поперечной дороги (normal = u), с normal = r — через ось магистрали.
 */
function mirrored(site: Site, pieces: TemplatePiece[], normal: Vec = site.u): TemplatePiece[] {
  const m = (p: Vec) => sub(p, scale(normal, 2 * dot(sub(p, site.C), normal)));
  return [...pieces].reverse().map((p) => ({
    from: m(p.to),
    fromLevel: p.toLevel,
    to: m(p.from),
    toLevel: p.fromLevel,
    spec: p.spec,
    curve: p.curve && { p0: m(p.curve.p3), p1: m(p.curve.p2), p2: m(p.curve.p1), p3: m(p.curve.p0) },
  }));
}

// ---------- Клеверный лист ----------

/**
 * Компактный симметричный «клевер»: поперечная дорога — такая же, как магистраль, и идёт
 * по эстакаде. Четыре одинаковые круглые петли стоят вплотную к центру, по диагоналям:
 * съезжают с магистрали сразу за мостом и поднимаются прямо на эстакаду (или спускаются с неё).
 * Обходные съезды — вогнутые дуги по краям. Строится одна четверть, остальные — её зеркала
 * через обе оси; зеркальные куски сходятся в общих узлах (один лист съезжает, соседний вливается).
 */
function cloverLayout(site: Site): Layout {
  const half = halfWidth(site.trunk);
  // Петля — в стороне от обеих дорог: их полуширина, полуширина съезда и запас.
  const gap = half + 13;
  const rho = 70;
  const cc = gap + rho;
  // Где петля съезжает с магистрали (за мостом) и, зеркально, вливается в поперечную дорогу.
  const xe = Math.max(40, cc - 60);
  // Эстакада поперечной дороги — вдоль всей петли, дальше пандус до земли.
  const E = cc + 30;
  const G = E + LEVEL_RUN + 10;
  // Обходные съезды — дугами снаружи петель, примыкают к дорогам под острым углом.
  const U = Math.round(((cc * Math.SQRT2 + rho + 25) / 0.58) / 10) * 10;
  const L = U + 60;
  const at = (k: number) => add(site.C, scale(site.r, k));
  const cross = site.trunk;
  const q = quad(site, 0);
  const quarter = [...leafPieces(q, xe, cc, rho), outerArc(q, U)];
  const pieces: TemplatePiece[] = [
    { from: at(-L), fromLevel: 0, to: at(-G), toLevel: 0, spec: cross },
    { from: at(-G), fromLevel: 0, to: at(-E), toLevel: 1, spec: cross },
    { from: at(-E), fromLevel: 1, to: at(E), toLevel: 1, spec: cross },
    { from: at(E), fromLevel: 1, to: at(G), toLevel: 0, spec: cross },
    { from: at(G), fromLevel: 0, to: at(L), toLevel: 0, spec: cross },
    ...quarter,
    ...mirrored(site, quarter),
    ...mirrored(site, quarter, site.r),
    ...mirrored(site, mirrored(site, quarter, site.r)),
  ];
  return { pieces, reach: U + 20 };
}

/**
 * Лист «клевера» в четверти 0: съезд с магистрали (X) в точке xe, S-образно — на верх круга
 * радиуса rho с центром на диагонали (cc, cc), три четверти круга по часовой и вливание
 * в поперечную дорогу (Y) в точке xe. Лист симметричен относительно диагонали.
 * Посередине круга он поднимается на уровень эстакады поперечной дороги.
 */
function leafPieces(q: Quad, xe: number, cc: number, rho: number): TemplatePiece[] {
  const start = q.P(xe, 0);
  const top = q.P(cc, cc - rho);
  const side = q.P(cc + rho, cc);
  const bottom = q.P(cc, cc + rho);
  const left = q.P(cc - rho, cc);
  const end = q.P(0, xe);
  const k = (cc - xe) * 0.45;
  const piece = (from: Vec, fromLevel: number, to: Vec, toLevel: number, curve: Cubic): TemplatePiece => ({ from, fromLevel, to, toLevel, spec: LOOP, curve });
  return [
    piece(start, 0, top, 0, hermite(start, q.D(Math.cos(SPLAY), Math.sin(SPLAY)), top, q.D(1, 0), k)),
    piece(top, 0, side, 0, arcIn(q, cc, cc, rho, -Math.PI / 2, 0)),
    piece(side, 0, bottom, 1, arcIn(q, cc, cc, rho, 0, Math.PI / 2)),
    piece(bottom, 1, left, 1, arcIn(q, cc, cc, rho, Math.PI / 2, Math.PI)),
    piece(left, 1, end, 1, hermite(left, q.D(0, -1), end, q.D(-Math.sin(SPLAY), -Math.cos(SPLAY)), k)),
  ];
}

/** Обходной съезд четверти 0: с поперечной дороги (Y = U) на магистраль (X = U) вогнутой дугой. */
function outerArc(q: Quad, U: number): TemplatePiece {
  const phi = 0.4;
  const start = q.P(0, U);
  const end = q.P(U, 0);
  return ramp(start, end, hermite(start, q.D(Math.sin(phi), -Math.cos(phi)), end, q.D(Math.cos(phi), -Math.sin(phi)), U * 0.45));
}

function curveOf(p: TemplatePiece): Cubic {
  return p.curve ?? straightCubic(p.from, p.to);
}

/** Запрос на постройку куска: концы привязываются к уже построенным кускам и к магистрали. */
export function pieceRequest(builder: Builder, piece: TemplatePiece): RoadRequest {
  const start = builder.snap(piece.from, piece.fromLevel, 6);
  const end = builder.snap(piece.to, piece.toLevel, 6);
  return {
    start: start.level === piece.fromLevel ? start : { kind: 'free', pos: piece.from, level: piece.fromLevel },
    end: end.level === piece.toLevel ? end : { kind: 'free', pos: piece.to, level: piece.toLevel },
    spec: piece.spec,
    mode: 'straight',
    curve: piece.curve ? { ...piece.curve, p0: start.pos, p3: end.pos } : undefined,
  };
}

/** Длина шаблона для подсказки. */
export function templateLength(plan: TemplatePlan): number {
  return plan.preview.reduce((s, c) => s + new CurveLUT(c).length, 0);
}
