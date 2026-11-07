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
import { add, rightNormal, scale, sub, type Vec } from '../core/vec';
import { convoyGap, frontOf, nextSite, type StageReach, stageLayout, stageSpans } from '../game/constructionWork';
import { bridgeLook, deckAlong } from '../lanes/deck';
import type { LaneRenderer } from '../lanes/draw';
import { edgesAt, pointOff, stations } from '../lanes/geometry';
import type { Corridor, LaneNet } from '../lanes/model';
import { corridorLayer } from '../lanes/speedDisplay';
import type { BuildBase } from '../world/entities';
import { ROAD_MARGIN } from '../world/roadTypes';
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

/** Готовое на карте — целыми шагами drawStep (последний шаг — только когда участок готов целиком). */
export function drawnDone(c: Corridor): number {
  const done = c.build?.done ?? 0;
  return Math.min(c.length, Math.floor(done / CONSTRUCTION.drawStep) * CONSTRUCTION.drawStep);
}

/** Готовое на полотне c (как нарисовано, drawnDone): где отсыпка и какой этап дошёл до узлов на концах (stageLayout). */
export function projectLayout(c: Corridor, cuts: Map<number, [number, number]>): ReturnType<typeof stageLayout> {
  const [ca, cb] = cuts.get(c.id) ?? [0, 0];
  return stageLayout(stageSpans(drawnDone(c), c.length), c.length, !!c.build?.fromB, ca, cb);
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
  return `${c.rev}|${drawnDone(c)}|${c.build?.fromB ? 'b' : 'a'}`;
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
        const [earthTo] = stageSpans(drawnDone(c), c.length);
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
    const [earthTo, paveTo, marksTo] = stageSpans(drawnDone(c), c.length);
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

/** Где на полотне край работ (точка, направление стройки, этап) — нет, если участок ещё не начат. */
export function workFront(c: Corridor): { pos: Vec; dir: Vec; stage: 0 | 1 | 2; c: Corridor; s: number } | null {
  const b = c.build;
  if (!b || b.done <= 0) return null;
  const f = frontOf(b.done, c.length);
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

/**
 * Где машины этапов ждут своего начала на обочине (метров позади начала участка) и стоят, кончив (столько же до
 * конца), когда колонна не идёт дальше по оси (crewConvoy): разметка — у самого начала, покрытие и грейдер — дальше,
 * друг за другом без нахлёста. Стоянка у конца участка совпадает с ожиданием на обочине в начале следующего.
 */
const CREW_SLOT = [30, 10, 0] as const;
/** За столько метров своего края машина въезжает с обочины на полотно (и в конце этапа съезжает на неё). */
const CREW_RAMP = 24;
/** Длина машин этапа (drawMachines: от носа до хвоста, с зазором) — на столько за ней держится следующая в колонне. */
const CREW_LEN = [23, 19, 8] as const;

/** Другое полотно у стыка node, если там ровно два полотна и одно из них c (прямое продолжение, не поворот и не развилка). */
function seamNext(net: LaneNet, node: number, c: Corridor): Corridor | null {
  const n = net.node(node);
  if (n.kind !== 'seam' || n.corridors.length !== 2) return null;
  const other = n.corridors.find((id) => id !== c.id);
  return other === undefined ? null : (net.corridors.get(other) ?? null);
}

/**
 * Колонна техники на строящемся участке c (src/game/constructionWork.ts, stageSpans): у каждого этапа — своя машина
 * у своего края. Если участок прямо продолжает готовую дорогу (стык без поворота и развилки, например только что
 * достроенный участок того же проекта), колонна стоит и едет по оси: не начатые этапы ждут за началом, друг за другом
 * (CREW_LEN). Если следующий участок проекта (nextSite) прямо продолжает этот от его конца, кончившие этапы ждут на оси
 * у конца, а догоняющие встают за ними — колонна переходит на следующий участок без съезда с полотна. Иначе, как
 * раньше: не начатый ждёт на обочине позади начала и за первые CREW_RAMP метров плавно въезжает на полотно к краю;
 * кончивший, пока следующий этап идёт свои CREW_RAMP метров, отъезжает на обочину к стоянке у конца участка (разметка
 * уходит туда сама в самом конце).
 */
export function crewConvoy(net: LaneNet, c: Corridor): CrewMachine[] {
  const b = c.build;
  if (!b) return [];
  const L = c.length;
  const fronts = stageSpans(b.done, L);
  const ramp = Math.min(CREW_RAMP, L / 2);
  const raised = Math.max(net.node(c.a).level, net.node(c.b).level) > 0;
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const start = b.fromB ? c.b : c.a;
  const end = b.fromB ? c.a : c.b;
  // Откуда колонна пришла по оси (готовое прямое продолжение у начала) и пойдёт ли дальше по оси (следующий участок
  // проекта — прямое продолжение от конца и заполняется от него).
  const before = seamNext(net, start, c);
  const from = before && !before.build ? before : null;
  const next = nextSite(net, c, buildingCorridors(net));
  const onward = next && seamNext(net, end, c) === next.c && (next.fromB ? next.c.b : next.c.a) === end ? next.c : null;
  // Интервал в колонне — не больше отставания этапов (convoyGap) и у соседнего участка тоже: на стыке он один и тот же.
  const spacing = (k: number, other: Corridor | null) => Math.min(CREW_LEN[k], convoyGap(L), other ? convoyGap(other.length) : Infinity);
  /** Точка на u метров от начала заполнения (за концами — по касательной), сдвинутая вправо по ходу на lat. */
  const place = (u: number, side: number): { pos: Vec; dir: Vec } => {
    // Позади начала, на оси готовой дороги, откуда пришла колонна, — по её полотну.
    if (u < 0 && from) {
      const atA = from.a === start;
      const s = atA ? Math.min(-u, from.length) : Math.max(0, from.length + u);
      const t = from.lut.tangentAt(s);
      let pos = from.lut.pointAt(s);
      if (Math.max(net.node(from.a).level, net.node(from.b).level) > 0) pos = add(pos, bridgeLook(deckAlong(net, from, s)).lift);
      return { pos, dir: atA ? scale(t, -1) : t };
    }
    const s = b.fromB ? L - u : u;
    const sc = Math.max(0, Math.min(L, s));
    const t = c.lut.tangentAt(sc);
    const dir = b.fromB ? scale(t, -1) : t;
    // Обочина справа по ходу: у стройки от конца b это левая кромка полотна.
    const e = edgesAt(c, sc) ?? [-3.5, 3.5];
    const edge = (b.fromB ? -e[0] : e[1]) + ROAD_MARGIN + 3;
    let pos = add(c.lut.pointAt(sc), scale(t, s - sc));
    pos = add(pos, scale(rightNormal(dir), edge * side));
    if (raised) pos = add(pos, bridgeLook(deckAlong(net, c, sc)).lift);
    return { pos, dir };
  };
  // Каждой машине — где она вдоль участка (u, метров от начала заполнения), насколько на обочине (side) и работает ли.
  const at = ([0, 1, 2] as const).map((k) => {
    const f = fronts[k];
    const slot = CREW_SLOT[k];
    if (f >= L - 1e-6) {
      // Кончил: дальше по оси — ждёт у конца; иначе с полотна — на обочину к стоянке у конца, пока следующий этап
      // проходит CREW_RAMP.
      if (onward) return { u: L, side: 0, active: false };
      const next = k < 2 ? fronts[k + 1] : L;
      const back = clamp01((next - (L - convoyGap(L))) / ramp);
      return { u: L - slot * back, side: back, active: false };
    }
    if (f <= 0) return from ? { u: 0, side: 0, active: false } : { u: -slot, side: 1, active: false };
    // Разметка (за ней уже никого) в самом конце сама уходит на обочину — к месту, где будет ждать на следующем
    // участке, если колонна не идёт по оси дальше.
    const out = k === 2 && !onward ? clamp01((f - (L - ramp / 2)) / (ramp / 2)) : 0;
    if (from) return { u: f, side: out, active: true };
    // Въезд с обочины в начале этапа.
    const into = clamp01(f / ramp);
    return { u: -slot + (f + slot) * into, side: Math.max(1 - into, out), active: true };
  });
  // На оси машины колонны не наезжают друг на друга: следующая — за хвостом предыдущей (у начала участка интервал —
  // как у пришедшей колонны, у конца — как у той, что пойдёт дальше).
  for (const k of [1, 2] as const) {
    const lead = at[k - 1];
    if (at[k].side !== 0 || lead.side !== 0) continue;
    const cap = lead.u - spacing(k - 1, lead.u < L / 2 ? from : onward);
    if (at[k].u > cap) at[k] = { u: cap, side: 0, active: false };
  }
  return at.map((m, k) => ({ ...place(m.u, m.side), stage: k as 0 | 1 | 2, active: m.active }));
}

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
 * и каток, 2 — машина разметки. light — маячок горит (работают). На мосту (kind) этап 0 — автокран со стрелой и
 * бетоновоз, в тоннеле — проходческий щит (structureArt); t — время игры, с: стрела качается, барабан и ротор крутятся.
 */
export function drawMachines(ctx: CanvasRenderingContext2D, at: Vec, dir: Vec, stage: 0 | 1 | 2, light: boolean, shift = 0, kind: SiteKind = 'road', t = 0): void {
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(Math.atan2(dir.y, dir.x));
  ctx.translate(0, shift);
  // Чуть крупнее настоящих: на обзорном зуме технику должно быть видно.
  ctx.scale(1.35, 1.35);
  const box =(x: number, y: number, w: number, h: number, fill: string, stroke = '#6b5410') => {
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
  };
  let beacon = -1.8;
  if (stage === 0 && kind === 'bridge') beacon = drawCraneSet(ctx, t);
  else if (stage === 0 && kind === 'tunnel') beacon = drawShieldSet(ctx, t);
  else if (stage === 0) {
    // Грейдер: длинная рама и нож поперёк, кабина сзади; за ним — самосвал с грунтом.
    box(-6, -1.2, 7, 2.4, '#f2b81d');
    ctx.fillStyle = '#4d4f55';
    ctx.fillRect(-2.6, -2.2, 0.8, 4.4);
    box(-5.6, -1.4, 2, 2.8, '#e0a81a');
    box(-16, -1.8, 7.5, 3.6, '#f2b81d');
    ctx.fillStyle = '#9a7b55';
    ctx.fillRect(-15.5, -1.3, 5, 2.6);
  } else if (stage === 1) {
    // Асфальтоукладчик и каток с тёмным вальцом.
    box(-5, -2.2, 5, 4.4, '#f2b81d');
    ctx.fillStyle = '#2f3237';
    ctx.fillRect(-6.2, -2.4, 1.2, 4.8);
    box(-13, -1.6, 4, 3.2, '#f2b81d');
    ctx.fillStyle = '#3d4148';
    ctx.fillRect(-9, -1.9, 1.6, 3.8);
  } else {
    // Машина разметки: белый фургон с полосой.
    box(-5, -1.3, 5, 2.6, '#f4f5f7', '#8a9099');
    ctx.fillStyle = '#e8743b';
    ctx.fillRect(-4.6, -0.3, 4.2, 0.6);
  }
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
