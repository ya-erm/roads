/**
 * Стройка дорог на карте (режим «Со строительством», src/game/construction.ts):
 * - проект — сама будущая дорога выбранного типа (полосы, разметка, мост, тоннель — отрисовкой дорог, своим
 *   LaneRenderer только по строящимся полотнам), полупрозрачной, с кромками синим пунктиром; по слоям высоты, как
 *   готовые дороги, в плитки кэша карты;
 * - этапы на строящемся участке (CONSTRUCTION.stages, идут колонной): 🟫 отсыпка (у моста — опоры, балки и плита
 *   настила, у тоннеля — выработка щита: src/render/structureArt.ts), ⬛ покрытие, ⬜ разметка — до края
 *   каждого, шагами CONSTRUCTION.drawStep: плитки обновляются по шагу, а не каждый такт (projectSig); отсыпка — не по
 *   площадке перекрёстка (там бывает готовая дорога), площадка — этапом, дошедшим до неё (nodeStage);
 * - тень мостов проекта — отдельным проходом под готовыми дорогами (drawProjectShadows): готовое — обычной, остальное —
 *   бледной;
 * - площадки строительных баз — тоже в плитках (drawBases);
 * - колонна техники (у каждого этапа своя машина у своего края, crewConvoy), самосвалы свободных бригад на базе и
 *   подпись «🏗 45%» — поверх, в динамическом проходе кадра, не в плитках.
 * Готовые участки рисует обычная отрисовка дорог: у них уже нет Corridor.build.
 */
import { CONSTRUCTION } from '../config';
import { add, scale, sub, type Vec } from '../core/vec';
import { convoyGap, frontOf, nextSite, type Spans, spansOf, type StageReach, stageLayout } from '../game/constructionWork';
import { CREW_UNITS, crewRows, fillet, polyAt, polyLength, polyProject, stageSlots } from '../game/crewLane';
import { drawVehicleArt } from './vehicleArt';
import { bridgeLook, deckAlong } from '../lanes/deck';
import type { LaneRenderer } from '../lanes/draw';
import { edgesAt, pointOff, stations } from '../lanes/geometry';
import type { Corridor, LaneNet } from '../lanes/model';
import { corridorLayer } from '../lanes/speedDisplay';
import type { BuildBase } from '../world/entities';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { closureOf, fitLanes, partLanes } from '../lanes/closure';
import { bridgePiers, drawCraneSet, drawShieldSet, type SiteKind, siteKind, slabTo } from './structureArt';
import { type Box, grow } from './tileCache';

/** Строящиеся полотна сети — кэш по версии (стройка меняет её, когда закладывает или открывает участок). */
const cache = new WeakMap<LaneNet, { version: number; list: Corridor[] }>();

export function buildingCorridors(net: LaneNet): Corridor[] {
  const hit = cache.get(net);
  if (hit && hit.version === net.version) return hit.list;
  const list = [...net.corridors.values()].filter((c) => c.build);
  cache.set(net, { version: net.version, list });
  return list;
}

/**
 * Полотна перестройки, перекрытые по полосам (closure.ts, 'part'): открытые прежние полосы рисуются ещё раз — поверх
 * стройки (отсыпки и чертежа), чтобы было видно, где едут машины.
 */
export function partialCorridors(net: LaneNet): Set<number> {
  return new Set(buildingCorridors(net).filter((c) => closureOf(c.build) === 'part').map((c) => c.id));
}

const joints = new WeakMap<LaneNet, { version: number; open: LaneNet; ids: Set<number> }>();

/**
 * Узлы, где готовую дорогу продолжает проект: в открытой для движения сети open (без строящегося) это тупики, но
 * разворота (и его тени у моста) там рисовать не надо — дальше идёт будущая дорога. Кэш — по версии всей сети full.
 */
export function projectJoints(open: LaneNet, full: LaneNet): Set<number> {
  const hit = joints.get(full);
  if (hit && hit.version === full.version && hit.open === open) return hit.ids;
  const ids = new Set<number>();
  for (const c of buildingCorridors(full)) {
    for (const id of [c.a, c.b]) {
      const n = open.nodes.get(id);
      if (n && open.isDeadEnd(n)) ids.add(id);
    }
  }
  joints.set(full, { version: full.version, open, ids });
  return ids;
}

/**
 * Этапы на карте (spansOf) — целыми шагами drawStep: этап, дошедший до конца, — до конца. Этап, что идёт вплотную за
 * предыдущим (на convoyGap позади), — на convoyGap позади нарисованного предыдущего: так этапы колонны переходят на
 * следующий шаг разом, и плитки перерисовываются по шагу колонны, а не по шагу каждого этапа.
 */
export function drawnSpans(c: Corridor): Spans {
  const L = c.length;
  const step = CONSTRUCTION.drawStep;
  const s = spansOf(c.build, L);
  const g = convoyGap(L);
  const out: Spans = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const own = s[k] >= L - 1e-6 ? L : Math.min(L, Math.floor(s[k] / step) * step);
    const locked = k > 0 && s[k - 1] < L - 1e-6 && Math.abs(s[k] - (s[k - 1] - g)) < 1e-6;
    out[k] = locked ? Math.max(0, Math.min(own + step, out[k - 1] - g)) : own;
  }
  return out;
}

/** Готовое на полотне c (как нарисовано, drawnSpans): где отсыпка и какой этап дошёл до узлов на концах (stageLayout). */
export function projectLayout(c: Corridor, cuts: Map<number, [number, number]>): ReturnType<typeof stageLayout> {
  const [ca, cb] = cuts.get(c.id) ?? [0, 0];
  return stageLayout(drawnSpans(c), c.length, !!c.build?.fromB, ca, cb);
}

/**
 * Этап готового на площадке узла id (перекрёсток, стык, тупик проекта) — дальний из дошедших до неё по строящимся
 * полотнам (lanes — отрисовка проектов: её обрезы у перекрёстков). Отсыпки нет, если к узлу подходит готовая дорога:
 * площадка там уже под асфальтом и до покрытия остаётся чертежом.
 */
export function nodeStage(net: LaneNet, lanes: LaneRenderer, id: number): StageReach {
  const k = nodeReach(net, lanes, id);
  const paved = net.nodes.get(id)?.corridors.some((cid) => !net.corridor(cid).build) ?? false;
  return k === 0 && paved ? -1 : k;
}

/** Дальний этап, дошедший до узла id по строящимся полотнам (−1 — никакой), без оглядки на готовые дороги у него. */
export function nodeReach(net: LaneNet, lanes: LaneRenderer, id: number): StageReach {
  const n = net.nodes.get(id);
  if (!n) return -1;
  const cuts = lanes.cutsOf(net);
  let k: StageReach = -1;
  for (const cid of n.corridors) {
    const c = net.corridor(cid);
    if (!c.build) continue;
    const { reach } = projectLayout(c, cuts);
    if (c.a === id) k = Math.max(k, reach.a) as StageReach;
    if (c.b === id) k = Math.max(k, reach.b) as StageReach;
  }
  return k;
}

/** Узлы проектов (площадки перекрёстков, стыки, тупики) с рамками — как их рисует lanes. */
export function projectNodes(net: LaneNet, lanes: LaneRenderer): { id: number; box: Box }[] {
  const out: { id: number; box: Box }[] = [];
  lanes.eachItem(net, (kind, id, _sig, box) => {
    if (kind === 'node') out.push({ id, box });
  });
  return out;
}

/** Подпись строящегося полотна для кэша плиток: форма (ревизия) и сколько готового нарисовано. */
export function projectSig(c: Corridor): string {
  return `${c.rev}|${drawnSpans(c).join(',')}|${c.build?.fromB ? 'b' : 'a'}`;
}

/** Рамка полотна с запасом на ширину и подъём моста. */
export function projectBox(c: Corridor): Box {
  const pts = [c.curve.p0, c.curve.p1, c.curve.p2, c.curve.p3];
  const pad = 40;
  return {
    x0: Math.min(...pts.map((p) => p.x)) - pad,
    y0: Math.min(...pts.map((p) => p.y)) - pad,
    x1: Math.max(...pts.map((p) => p.x)) + pad,
    y1: Math.max(...pts.map((p) => p.y)) + pad,
  };
}

const seen = (b: Box, view: Box) => !(b.x1 < view.x0 || b.x0 > view.x1 || b.y1 < view.y0 || b.y0 > view.y1);

/**
 * Кромки полотна на [s0, s1]: левая и правая (с обочиной pad), у моста — подняты, как у готового; shade — не само
 * полотно, а его тень на земле (сдвинута по высоте, как у отрисовки дорог).
 */
function band(net: LaneNet, c: Corridor, s0: number, s1: number, pad: number, shade = false): { left: Vec[]; right: Vec[] } {
  const left: Vec[] = [];
  const right: Vec[] = [];
  const raised = Math.max(net.node(c.a).level, net.node(c.b).level) > 0;
  for (const s of stations(c, s0, s1, 5)) {
    const e = edgesAt(c, s);
    if (!e) continue;
    const look = raised ? bridgeLook(deckAlong(net, c, s)) : null;
    const d = look && (shade ? look.shadow : look.lift);
    const up = (p: Vec) => (d ? add(p, d) : p);
    left.push(up(pointOff(c, s, e[0] - pad)));
    right.push(up(pointOff(c, s, e[1] + pad)));
  }
  return { left, right };
}

function poly(ctx: CanvasRenderingContext2D, pts: Vec[]): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
}

/** Насколько видна ещё не построенная часть проекта: будущая дорога полупрозрачной, сквозь неё видна земля. */
const GHOST = 0.55;
/** Оттенок будущей дороги — синий проекта. */
const PROJECT_TINT = 'rgba(47, 128, 237, 0.3)';
/** Отсыпка — цвет земляного полотна. */
const EARTH = '#c4a57c';
/** Мост: бетон плиты настила, балки пролёта, опоры. */
const SLAB = '#cdc8bd';
const BEAM = '#6f6a62';
const PIER = '#a39d92';
const PIER_EDGE = '#6f6a62';
/** Тоннель: пройденная щитом выработка (сквозь землю — бледно) и кольца обделки. */
const BORE = '#3b3128';
const RING = '#9c8a72';

/** Цвет первого этапа на площадке узла: у моста — бетон настила, в тоннеле — выработка, на земле — отсыпка. */
const firstStageColor = (level: number) => (level > 0 ? SLAB : level < 0 ? BORE : EARTH);

/** Линия вдоль полотна на [s0, s1] на доле f ширины (0 — левая кромка, 1 — правая), у моста — поднята с полотном. */
function deckLine(net: LaneNet, c: Corridor, s0: number, s1: number, f: number, step = 5): Vec[] {
  const out: Vec[] = [];
  for (const s of stations(c, s0, s1, step)) {
    const e = edgesAt(c, s);
    if (!e) continue;
    out.push(add(pointOff(c, s, e[0] + (e[1] - e[0]) * f), bridgeLook(deckAlong(net, c, s)).lift));
  }
  return out;
}

/** Поперечина полотна в точке s: от левой кромки до правой (с выносом pad), поднята с полотном на долю lift. */
function across(net: LaneNet, c: Corridor, s: number, pad: number, lift = 1): [Vec, Vec] | null {
  const e = edgesAt(c, s);
  if (!e) return null;
  const d = scale(bridgeLook(deckAlong(net, c, s)).lift, lift);
  return [add(pointOff(c, s, e[0] - pad), d), add(pointOff(c, s, e[1] + pad), d)];
}

/**
 * Мост, первый этап (вместо отсыпки): опоры впереди (bridgePiers: фундамент, потом столбы с ригелем), балки пролёта до
 * края этапа earthTo (метров от начала заполнения) и плита настила за ними (slabTo). [lo, hi] — своё у полотна (без
 * площадок перекрёстков), по оси от a.
 */
function drawBridgeFrame(ctx: CanvasRenderingContext2D, net: LaneNet, c: Corridor, earthTo: number, lo: number, hi: number): void {
  const L = c.length;
  const fromB = !!c.build?.fromB;
  const span = (to: number): [number, number] => {
    const [s0, s1] = fromB ? [L - to, L] : [0, to];
    return [Math.max(lo, s0), Math.min(hi, s1)];
  };
  ctx.save();
  ctx.lineJoin = 'round';
  // Опоры: фундамент на земле; опора — столбы от земли до полотна и ригель поперёк под ним.
  for (const p of bridgePiers(L, (s) => deckAlong(net, c, s), earthTo, fromB)) {
    if (p.s < lo || p.s > hi) continue;
    const t = c.lut.tangentAt(p.s);
    const foot = across(net, c, p.s, 0.5, 0);
    if (!foot) continue;
    const half = scale(t, p.full ? 1.2 : 1.6);
    ctx.lineWidth = 0.4;
    ctx.strokeStyle = PIER_EDGE;
    if (!p.full) {
      // Фундамент в работе: бетонная плита на земле с торчащей арматурой будущих столбов.
      ctx.fillStyle = PIER;
      poly(ctx, [add(foot[0], half), add(foot[1], half), sub(foot[1], half), sub(foot[0], half)]);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#7a4a2a';
      const e = edgesAt(c, p.s) ?? [-3.5, 3.5];
      const w = Math.max(0, e[1] - e[0] - 2);
      const n = Math.max(1, Math.round(w / 1.6));
      for (let i = 0; i <= n; i++) {
        for (const d of [-0.6, 0.6]) {
          const q = add(pointOff(c, p.s, e[0] + 1 + (w * i) / n), scale(t, d));
          ctx.fillRect(q.x - 0.25, q.y - 0.25, 0.5, 0.5);
        }
      }
      continue;
    }
    const cap = across(net, c, p.s, 0.8);
    if (!cap) continue;
    // Столбы — у кромок полотна (и посередине у широкого): от земли до ригеля.
    const e = edgesAt(c, p.s) ?? [-3.5, 3.5];
    const lift = bridgeLook(deckAlong(net, c, p.s)).lift;
    const cols = e[1] - e[0] > 12 ? [e[0] + 1.6, (e[0] + e[1]) / 2, e[1] - 1.6] : [e[0] + 1.6, e[1] - 1.6];
    ctx.strokeStyle = '#8a857c';
    ctx.lineWidth = 1.8;
    ctx.lineCap = 'butt';
    for (const lat of cols) {
      const g = pointOff(c, p.s, lat);
      ctx.beginPath();
      ctx.moveTo(g.x, g.y);
      ctx.lineTo(g.x + lift.x, g.y + lift.y);
      ctx.stroke();
    }
    ctx.fillStyle = '#c2bdb2';
    ctx.strokeStyle = PIER_EDGE;
    ctx.lineWidth = 0.4;
    poly(ctx, [add(cap[0], half), add(cap[1], half), sub(cap[1], half), sub(cap[0], half)]);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // Балки пролёта — вдоль, с поперечинами, до края этапа.
  const [b0, b1] = span(earthTo);
  if (b1 - b0 > 0.5) {
    ctx.strokeStyle = '#8d8880';
    ctx.lineWidth = 0.6;
    for (let s = Math.ceil(b0 / 6) * 6; s <= b1; s += 6) {
      const x = across(net, c, s, 0.3);
      if (!x) continue;
      poly(ctx, x);
      ctx.stroke();
    }
    ctx.strokeStyle = BEAM;
    ctx.lineWidth = 1.3;
    ctx.lineCap = 'butt';
    for (const f of [0.08, 0.36, 0.64, 0.92]) {
      const line = deckLine(net, c, b0, b1, f);
      if (line.length < 2) continue;
      poly(ctx, line);
      ctx.stroke();
    }
  }
  // Плита настила — за балками, со швами плит.
  const [p0, p1] = span(slabTo(earthTo, L));
  if (p1 - p0 > 0.5) {
    const b = band(net, c, p0, p1, ROAD_MARGIN + 1.2);
    ctx.fillStyle = SLAB;
    poly(ctx, [...b.left, ...[...b.right].reverse()]);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#9a958b';
    ctx.lineWidth = 0.5;
    poly(ctx, b.left);
    ctx.stroke();
    poly(ctx, b.right);
    ctx.stroke();
    ctx.strokeStyle = '#bdb8ad';
    ctx.lineWidth = 0.3;
    for (let s = Math.ceil(p0 / 6) * 6; s < p1; s += 6) {
      const x = across(net, c, s, ROAD_MARGIN + 1.2);
      if (!x) continue;
      poly(ctx, x);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Тоннель, первый этап (вместо отсыпки): пройденная щитом выработка на [s0, s1] — тёмной полосой сквозь землю (ярче
 * будущей дороги рядом) с кольцами обделки поперёк.
 */
function drawBore(ctx: CanvasRenderingContext2D, net: LaneNet, c: Corridor, s0: number, s1: number): void {
  ctx.save();
  ctx.globalAlpha = Math.min(1, ctx.globalAlpha * 2);
  const b = band(net, c, s0, s1, ROAD_MARGIN + 1.2);
  ctx.fillStyle = BORE;
  poly(ctx, [...b.left, ...[...b.right].reverse()]);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = RING;
  ctx.lineWidth = 0.5;
  for (let s = Math.ceil(s0 / 4) * 4; s <= s1; s += 4) {
    const x = across(net, c, s, ROAD_MARGIN + 1.2, 0);
    if (!x) continue;
    poly(ctx, x);
    ctx.stroke();
  }
  ctx.restore();
}

/** Чистые холсты для полупрозрачного слоя — по размеру холста, куда рисуем (экран или плитка кэша карты). */
const scratch = new Map<string, CanvasRenderingContext2D>();

function scratchFor(w: number, h: number): CanvasRenderingContext2D | null {
  const key = `${w}x${h}`;
  let g = scratch.get(key);
  if (!g) {
    // Окно поменяло размер — прежние холсты уже не нужны.
    if (scratch.size >= 3) scratch.clear();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    g = c.getContext('2d') ?? undefined;
    if (!g) return null;
    scratch.set(key, g);
  }
  return g;
}

/**
 * Рисует draw на чистом холсте того же размера, что у ctx, и переносит на ctx одним слоем с прозрачностью alpha:
 * бордюры под асфальтом, асфальт и разметка поверх не просвечивают друг сквозь друга. box — где рисуют (в мире).
 */
function drawFaded(ctx: CanvasRenderingContext2D, box: Box, alpha: number, draw: (g: CanvasRenderingContext2D) => void): void {
  const m = ctx.getTransform();
  const cv = ctx.canvas;
  const corners = [
    m.transformPoint({ x: box.x0, y: box.y0 }),
    m.transformPoint({ x: box.x1, y: box.y0 }),
    m.transformPoint({ x: box.x0, y: box.y1 }),
    m.transformPoint({ x: box.x1, y: box.y1 }),
  ];
  const x0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.x))));
  const y0 = Math.max(0, Math.floor(Math.min(...corners.map((p) => p.y))));
  const x1 = Math.min(cv.width, Math.ceil(Math.max(...corners.map((p) => p.x))));
  const y1 = Math.min(cv.height, Math.ceil(Math.max(...corners.map((p) => p.y))));
  if (x1 <= x0 || y1 <= y0) return;
  const g = scratchFor(cv.width, cv.height);
  if (!g) return;
  const w = x1 - x0;
  const h = y1 - y0;
  // Рисуем только в рамке (за ней холст всегда чистый) — и рамку же переносим.
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(x0, y0, w, h);
  g.save();
  g.beginPath();
  g.rect(x0, y0, w, h);
  g.clip();
  g.setTransform(m);
  draw(g);
  g.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= alpha;
  ctx.drawImage(g.canvas, x0, y0, w, h, x0, y0, w, h);
  ctx.restore();
}

/** Рисует draw только внутри полосы полотна band. */
function clipped(ctx: CanvasRenderingContext2D, b: { left: Vec[]; right: Vec[] }, draw: () => void): void {
  if (b.left.length < 2) return;
  ctx.save();
  poly(ctx, [...b.left, ...[...b.right].reverse()]);
  ctx.closePath();
  ctx.clip();
  draw();
  ctx.restore();
}

/** Рамка полупрозрачного слоя проектов в view: полотна и узлы с запасом на площадки перекрёстков и тень. */
function ghostClip(list: Corridor[], nodes: { box: Box }[], view: Box): Box {
  const pad = 60;
  const box = [...list.map(projectBox), ...nodes.map((n) => n.box)].reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
  return { x0: Math.max(view.x0, box.x0 - pad), y0: Math.max(view.y0, box.y0 - pad), x1: Math.min(view.x1, box.x1 + pad), y1: Math.min(view.y1, box.y1 + pad) };
}

/**
 * Тень мостов проектов слоя layer на земле — до готовых дорог этого слоя (их полотна её закрывают, как у готового
 * моста). Готовое (с отсыпки: мост уже стоит) — обычной тенью, не начатое — бледной; каждая — только по своему куску
 * полотна (в полосе тени, сдвинутой по высоте), на стыке — ни щели, ни двойной тени; площадки узлов — по дошедшему
 * до них этапу (nodeReach). Под полотном самого проекта тени нет: его не начатое полупрозрачно, и тень сквозь него
 * темнила бы его пятнами.
 */
export function drawProjectShadows(ctx: CanvasRenderingContext2D, net: LaneNet, lanes: LaneRenderer, zoom: number, view: Box, layer: number): void {
  if (layer < 0) return;
  const list = buildingCorridors(net).filter((c) => seen(projectBox(c), view));
  const nodes = projectNodes(net, lanes).filter((n) => seen(n.box, view));
  if ((!list.length && !nodes.length) || !lanes.layerIn(net, layer, view)) return;
  const none = () => false;
  const clip = ghostClip(list, nodes, view);
  for (const built of [false, true]) {
    drawFaded(ctx, clip, built ? 1 : GHOST, (g) => {
      for (const c of list) {
        const [earthTo] = drawnSpans(c);
        const [doneA, doneB] = c.build?.fromB ? [c.length - earthTo, c.length] : [0, earthTo];
        const [s0, s1] = built ? [doneA, doneB] : c.build?.fromB ? [0, doneA] : [doneB, c.length];
        if (s1 - s0 < 0.5) continue;
        clipped(g, band(net, c, s0, s1, ROAD_MARGIN + 10, true), () =>
          lanes.draw(g, net, zoom, false, view, layer, { corridor: (id) => id === c.id, node: none, shadow: 'only' }),
        );
      }
      for (const n of nodes) {
        if (nodeReach(net, lanes, n.id) >= 0 !== built) continue;
        lanes.draw(g, net, zoom, false, view, layer, { corridor: none, node: (id) => id === n.id, shadow: 'only' });
      }
      // Под полотном проекта — без тени.
      g.globalCompositeOperation = 'destination-out';
      lanes.draw(g, net, zoom, false, view, layer, { shadow: 'skip', marks: false });
    });
  }
}

/**
 * Проекты стройки слоя высоты layer (−1 тоннели, 0 земля, 1 мосты, 2 эстакады) в рамке view. Не построенное — сама
 * будущая дорога (полотна и узлы проекта рисует lanes — как готовые: полосы, разметка, мост с парапетом и тенью),
 * но полупрозрачной; кромки проекта — синим пунктиром (у тоннеля — бледнее, по земле над ним). Готовое — этапами от
 * начала заполнения: 🟫 отсыпка (чуть шире полотна), ⬛ покрытие (дорога без разметки), ⬜ разметка (дорога целиком).
 * Для плиток кэша и для рисования без кэша — одно и то же.
 */
export function drawProjects(ctx: CanvasRenderingContext2D, net: LaneNet, lanes: LaneRenderer, zoom: number, view: Box, layer: number): void {
  const list = buildingCorridors(net).filter((c) => seen(projectBox(c), view));
  // Площадки узлов проектов — по своим рамкам: у острого примыкания она длиннее запаса рамки полотна.
  const nodes = projectNodes(net, lanes).filter((n) => seen(n.box, view));
  if (!list.length && !nodes.length) return;
  ctx.save();
  ctx.lineJoin = 'round';
  const cuts = lanes.cutsOf(net);
  const none = () => false;
  // Будущая дорога — одним полупрозрачным слоем, в рамке проектов (с запасом на площадки перекрёстков); тень мостов
  // проекта — отдельно и раньше готовых дорог (drawProjectShadows).
  if (lanes.layerIn(net, layer, view)) {
    const clip = ghostClip(list, nodes, view);
    drawFaded(ctx, clip, GHOST, (g) => {
      lanes.draw(g, net, zoom, false, view, layer, { shadow: 'skip' });
      // Синеватый, как всё «проектное» (подсветка проекта, знаки, кромки), — только там, где уже нарисована дорога.
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = PROJECT_TINT;
      g.fillRect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
    });
  }
  // Этапы готового — непрозрачно, поверх будущей дороги.
  for (const c of list) {
    if (corridorLayer(net, c) !== layer) continue;
    const [earthTo, paveTo, marksTo] = drawnSpans(c);
    const span = (to: number): [number, number] => (c.build?.fromB ? [c.length - to, c.length] : [0, to]);
    // Отсыпка — только по своему у полотна, не по площадке перекрёстка: там бывает уже готовая дорога. У моста вместо
    // неё — опоры, балки и плита настила, у тоннеля — выработка щита (structureArt).
    const { earth } = projectLayout(c, cuts);
    const kind = siteKind(net, c);
    if (kind === 'bridge') {
      const [ca, cb] = cuts.get(c.id) ?? [0, 0];
      drawBridgeFrame(ctx, net, c, earthTo, Math.max(0, ca), c.length - Math.max(0, cb));
    } else if (earth && kind === 'tunnel') drawBore(ctx, net, c, ...earth);
    else if (earth) {
      const b = band(net, c, ...earth, ROAD_MARGIN + 1.2);
      ctx.fillStyle = EARTH;
      poly(ctx, [...b.left, ...[...b.right].reverse()]);
      ctx.closePath();
      ctx.fill();
    }
    // Покрытие и разметка — то же полотно, что у готовой дороги, в полосе готового (с запасом на бордюр и парапет).
    const only = (id: number) => id === c.id;
    // Тень — уже нарисована (shadows): в полосе полотна от неё был бы лишь обрывок поверх.
    if (paveTo > 0.5) clipped(ctx, band(net, c, ...span(paveTo), ROAD_MARGIN + 3), () => lanes.draw(ctx, net, zoom, false, view, layer, { corridor: only, node: none, marks: false, shadow: 'skip' }));
    if (marksTo > 0.5) clipped(ctx, band(net, c, ...span(marksTo), ROAD_MARGIN + 3), () => lanes.draw(ctx, net, zoom, false, view, layer, { corridor: only, node: none, shadow: 'skip' }));
  }
  // Площадки узлов — этапом, дошедшим до них (nodeStage): покрытие — асфальтом площадки (у примыкания к готовой дороге
  // закрывает и её разметку, как у готового перекрёстка), отсыпка — землёй по её контуру, если готовых дорог у узла нет.
  for (const n of nodes) {
    const k = nodeStage(net, lanes, n.id);
    if (k < 0) continue;
    const pick = { corridor: none, node: (id: number) => id === n.id, marks: k === 2, shadow: 'skip' as const };
    if (k > 0) lanes.draw(ctx, net, zoom, false, view, layer, pick);
    else
      drawFaded(ctx, grow(n.box, 4), 1, (g) => {
        lanes.draw(g, net, zoom, false, view, layer, pick);
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = firstStageColor(net.node(n.id).level);
        g.fillRect(n.box.x0 - 4, n.box.y0 - 4, n.box.x1 - n.box.x0 + 8, n.box.y1 - n.box.y0 + 8);
      });
  }
  // Кромки проекта — синим пунктиром: «это ещё проект». Тоннель — бледнее и поверх земли (его полотно — под ней).
  const px = 1 / Math.max(0.05, zoom);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = '#2f80ed';
  ctx.lineWidth = Math.max(0.6, 1.4 * px);
  ctx.setLineDash([7 * px, 5 * px]);
  const alpha = ctx.globalAlpha;
  for (const c of list) {
    const l = corridorLayer(net, c);
    if (Math.max(0, l) !== layer) continue;
    // Только по своему у полотна: через площадку перекрёстка (и готовую дорогу на ней) кромки не идут.
    const [ca, cb] = cuts.get(c.id) ?? [0, 0];
    if (c.length - cb - ca < 1) continue;
    const all = band(net, c, ca, c.length - cb, ROAD_MARGIN);
    if (all.left.length < 2) continue;
    ctx.globalAlpha = alpha * (l < 0 ? 0.55 : 1);
    poly(ctx, all.left);
    ctx.stroke();
    poly(ctx, all.right);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Перекрытие перестройки на карте (rebuild.ts, closure.ts), поверх дорог в динамическом проходе: у концов перекрытого
 * — красно-белые щиты поперёк закрытых полос (целиком — поперёк всего полотна), по полосам — ещё и ряд конусов по
 * границе открытого и закрытого. cuts — обрезы полотен у перекрёстков (щит — сразу за площадкой узла).
 */
export function drawClosures(ctx: CanvasRenderingContext2D, net: LaneNet, cuts: Map<number, [number, number]>, zoom: number, view: Box): void {
  if (zoom < 0.18) return;
  const list = buildingCorridors(net).filter((c) => c.build?.was && seen(projectBox(c), view));
  if (!list.length) return;
  ctx.save();
  ctx.lineCap = 'butt';
  const px = 1 / Math.max(0.05, zoom);
  for (const c of list) {
    const k = closureOf(c.build);
    if (k !== 'part' && k !== 'closed') continue;
    const w = c.build!.was!;
    const [ca, cb] = cuts.get(c.id) ?? [0, 0];
    const L = c.length;
    const ends = [Math.min(L / 2, Math.max(0, ca) + 3), Math.max(L / 2, L - Math.max(0, cb) - 3)];
    // Закрытые полосы — поперечными отрезками [lo, hi] от оси: целиком — всё полотно (прежнее и новое), по полосам —
    // прежние полосы, что не открыты.
    const old = fitLanes(w.lanes, w.len, L);
    const kept = new Set(k === 'part' ? partLanes(net, c).map((l) => l.offset) : []);
    const half = LANE_W / 2;
    const bands: [number, number][] = [];
    if (k === 'closed') {
      const e = edgesAt(c, L / 2);
      const lo = Math.min(e?.[0] ?? 0, ...old.map((l) => l.offset - half));
      const hi = Math.max(e?.[1] ?? 0, ...old.map((l) => l.offset + half));
      bands.push([lo, hi]);
    } else for (const l of old) if (!kept.has(l.offset)) bands.push([l.offset - half, l.offset + half]);
    if (!bands.length) continue;
    const bar = Math.max(2, 4 * px);
    for (const s of ends) {
      for (const [lo, hi] of bands) {
        const p = pointOff(c, s, lo + 0.4);
        const q = pointOff(c, s, hi - 0.4);
        ctx.lineWidth = bar;
        ctx.setLineDash([]);
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
        ctx.strokeStyle = '#e8483f';
        ctx.setLineDash([1.6, 1.6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // По полосам: конусы по границе закрытого (со стороны открытых полос), каждые 12 м.
    if (k === 'part') {
      const keptOld = old.filter((l) => kept.has(l.offset));
      const r = Math.max(0.7, 2.2 * px);
      for (const [lo, hi] of bands) {
        const edge = keptOld.some((l) => l.offset > hi - 0.01) ? hi : keptOld.some((l) => l.offset < lo + 0.01) ? lo : (lo + hi) / 2;
        for (let s = ends[0] + 6; s < ends[1] - 3; s += 12) {
          const p = pointOff(c, s, edge);
          if (p.x < view.x0 - 5 || p.x > view.x1 + 5 || p.y < view.y0 - 5 || p.y > view.y1 + 5) continue;
          ctx.fillStyle = '#f08a3c';
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 0.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }
  ctx.restore();
}

/** Где на полотне край работ (точка, направление стройки, этап) — нет, если участок ещё не начат. */
export function workFront(c: Corridor): { pos: Vec; dir: Vec; stage: 0 | 1 | 2; c: Corridor; s: number } | null {
  const b = c.build;
  if (!b || b.done <= 0) return null;
  const f = frontOf(spansOf(b, c.length), c.length);
  const s = b.fromB ? c.length - f.s : f.s;
  const t = c.lut.tangentAt(s);
  return { pos: c.lut.pointAt(s), dir: b.fromB ? scale(t, -1) : t, stage: f.stage, c, s };
}

/** Машина колонны стройки: где (нос), куда смотрит, её этап и работает ли сейчас (у своего края, а не ждёт или стоит). */
export interface CrewMachine {
  pos: Vec;
  dir: Vec;
  stage: 0 | 1 | 2;
  active: boolean;
}

/** Другое полотно у стыка node, если там ровно два полотна и одно из них c (прямое продолжение, не поворот и не развилка). */
function seamNext(net: LaneNet, node: number, c: Corridor): Corridor | null {
  const n = net.node(node);
  if (n.kind !== 'seam' || n.corridors.length !== 2) return null;
  const other = n.corridors.find((id) => id !== c.id);
  return other === undefined ? null : (net.corridors.get(other) ?? null);
}

/**
 * Колонна техники на строящемся участке c — без бригады с её полосой (проверки, показ): те же места этапов
 * (crewLane.stageSlots), что у бригады на её полосе, и всегда на оси, без съезда на обочину. Позади начала — по
 * готовой дороге, прямо продолжающей участок (стык без поворота и развилки), иначе прямо назад по оси; за концом — по
 * следующему участку проекта, если он прямо продолжает этот от его конца (колонна перейдёт на него без съезда).
 */
export function crewConvoy(net: LaneNet, c: Corridor): CrewMachine[] {
  const b = c.build;
  if (!b) return [];
  const L = c.length;
  const fronts = spansOf(b, L);
  const raised = Math.max(net.node(c.a).level, net.node(c.b).level) > 0;
  const start = b.fromB ? c.b : c.a;
  const end = b.fromB ? c.a : c.b;
  const before = seamNext(net, start, c);
  const from = before && !before.build ? before : null;
  const next = nextSite(net, c, buildingCorridors(net));
  const onward = next && seamNext(net, end, c) === next.c && (next.fromB ? next.c.b : next.c.a) === end ? next : null;
  // Полоса колонны: позади начала, сам участок по ходу заполнения, следующий участок.
  const pts: Vec[] = [];
  const along = (k: Corridor, s0: number, s1: number) => {
    const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / 5));
    for (let i = 0; i <= n; i++) pts.push(k.lut.pointAt(s0 + ((s1 - s0) * i) / n));
  };
  if (from) along(from, from.a === start ? Math.min(80, from.length) : Math.max(0, from.length - 80), from.a === start ? 0 : from.length);
  else {
    const t = c.lut.tangentAt(b.fromB ? L : 0);
    pts.push(add(c.lut.pointAt(b.fromB ? L : 0), scale(t, b.fromB ? 80 : -80)));
  }
  along(c, b.fromB ? L : 0, b.fromB ? 0 : L);
  if (onward) along(onward.c, onward.fromB ? onward.c.length : 0, onward.fromB ? 0 : onward.c.length);
  const path = fillet(pts);
  const probe = Math.min(15, L / 2);
  const zero = polyProject(path, c.lut.pointAt(b.fromB ? L - probe : probe)) - probe;
  const slots = stageSlots(fronts, L, {
    ahead: siteKind(net, c) === 'road',
    ext: onward ? Math.max(0, polyLength(path) - (zero + L)) : 0,
    extAhead: !!onward && siteKind(net, onward.c) === 'road',
  });
  return slots.map((u, k) => {
    const at = polyAt(path, zero + u);
    const s = b.fromB ? L - u : u;
    const pos = raised && u >= 0 && u <= L ? add(at.pos, bridgeLook(deckAlong(net, c, s)).lift) : at.pos;
    const f = fronts[k];
    return { pos, dir: at.dir, stage: k as 0 | 1 | 2, active: f > 0 && f < L - 1e-6 && Math.abs(u - f) < 1 };
  });
}

/** Ряды техники бригад на участке — поровну по ширине полотна (src/game/crewLane.ts). */
export { crewRows };

/** Площадка строительной базы: щебень за забором, вагончик, кучи песка и щебня. */
export function drawBases(ctx: CanvasRenderingContext2D, bases: Iterable<BuildBase>, view: Box): void {
  for (const b of bases) {
    const fp = b.fp;
    const r = Math.hypot(fp.w, fp.h) / 2;
    if (fp.center.x + r < view.x0 || fp.center.x - r > view.x1 || fp.center.y + r < view.y0 || fp.center.y - r > view.y1) continue;
    ctx.save();
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    const w = fp.w / 2;
    const h = fp.h / 2;
    // Щебёночная площадка и забор.
    ctx.fillStyle = '#cfc6b4';
    ctx.fillRect(-w, -h, fp.w, fp.h);
    ctx.strokeStyle = '#8c8170';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([2.2, 1.2]);
    ctx.strokeRect(-w + 0.4, -h + 0.4, fp.w - 0.8, fp.h - 0.8);
    ctx.setLineDash([]);
    // Вагончик-контора с оранжевой крышей.
    ctx.fillStyle = '#e8743b';
    ctx.strokeStyle = '#9a4a20';
    ctx.lineWidth = 0.5;
    ctx.fillRect(-w + 2, -h + 2, 11, 6);
    ctx.strokeRect(-w + 2, -h + 2, 11, 6);
    // Кучи песка и щебня.
    for (const [x, y, rr, col] of [
      [w - 6, -h + 6, 4.2, '#d9b878'],
      [w - 14, -h + 5, 3.4, '#9d9a92'],
    ] as const) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Подпись площадки базы для кэша плиток. */
export const baseSig = (b: BuildBase): string => `${b.fp.center.x},${b.fp.center.y},${b.fp.angle},${b.fp.w},${b.fp.h}`;

/** Рамка площадки базы. */
export function baseBox(b: BuildBase): Box {
  const r = Math.hypot(b.fp.w, b.fp.h) / 2 + 4;
  return { x0: b.fp.center.x - r, y0: b.fp.center.y - r, x1: b.fp.center.x + r, y1: b.fp.center.y + r };
}

/**
 * Техника бригады в точке at, носом по dir (в мире, метрами): этап 0 — грейдер и самосвал, 1 — асфальтоукладчик
 * и каток, 2 — машина разметки — тем же рисунком, что в потоке (vehicleArt, crewLane.CREW_UNITS). light — маячок
 * горит (работают). На мосту (kind) этап 0 — автокран со стрелой и бетоновоз, в тоннеле — проходческий щит
 * (structureArt); t — время игры, с: стрела качается, барабан и ротор крутятся.
 */
export function drawMachines(ctx: CanvasRenderingContext2D, at: Vec, dir: Vec, stage: 0 | 1 | 2, light: boolean, shift = 0, kind: SiteKind = 'road', t = 0): void {
  if (stage !== 0 || kind === 'road') {
    const u = CREW_UNITS[stage];
    const pos = shift ? add(at, scale({ x: -dir.y, y: dir.x }, shift)) : at;
    drawVehicleArt(ctx, { kind: 'truck', body: u.body, length: u.length, width: u.width, color: '#f2b81d', pos, dir, beacon: light }, { detailed: true, halo: 0 });
    return;
  }
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(Math.atan2(dir.y, dir.x));
  ctx.translate(0, shift);
  // Чуть крупнее настоящих: на обзорном зуме технику должно быть видно.
  ctx.scale(1.35, 1.35);
  const beacon = kind === 'bridge' ? drawCraneSet(ctx, t) : drawShieldSet(ctx, t);
  // Маячок.
  ctx.fillStyle = light ? '#ff7a1a' : '#b8682c';
  ctx.beginPath();
  ctx.arc(beacon, 0, 0.7, 0, Math.PI * 2);
  ctx.fill();
  if (light) {
    ctx.fillStyle = 'rgba(255, 140, 40, 0.28)';
    ctx.beginPath();
    ctx.arc(beacon, 0, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Свободные бригады на базе: самосвалы в ряд у забора (сколько стоит — столько и рисуем, до четырёх). */
export function drawParked(ctx: CanvasRenderingContext2D, base: BuildBase, idle: number): void {
  const fp = base.fp;
  ctx.save();
  ctx.translate(fp.center.x, fp.center.y);
  ctx.rotate(fp.angle);
  for (let i = 0; i < Math.min(4, idle); i++) {
    const x = -fp.w / 2 + 16 + i * 5;
    ctx.fillStyle = '#f2b81d';
    ctx.strokeStyle = '#6b5410';
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    ctx.rect(x, fp.h / 2 - 11, 3.4, 8);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
