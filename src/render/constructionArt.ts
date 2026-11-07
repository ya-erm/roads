/**
 * Стройка дорог на карте (режим «Со строительством», src/game/construction.ts):
 * - проект — сама будущая дорога выбранного типа (полосы, разметка, мост, тоннель — отрисовкой дорог, своим
 *   LaneRenderer только по строящимся полотнам), полупрозрачной, с кромками синим пунктиром; по слоям высоты, как
 *   готовые дороги, в плитки кэша карты;
 * - этапы на строящемся участке (CONSTRUCTION.stages, идут колонной): 🟫 отсыпка, ⬛ покрытие, ⬜ разметка — до края
 *   каждого, шагами CONSTRUCTION.drawStep: плитки обновляются по шагу, а не каждый такт (projectSig);
 * - площадки строительных баз — тоже в плитках (drawBases);
 * - колонна техники (у каждого этапа своя машина у своего края, crewConvoy), самосвалы свободных бригад на базе и
 *   подпись «🏗 45%» — поверх, в динамическом проходе кадра, не в плитках.
 * Готовые участки рисует обычная отрисовка дорог: у них уже нет Corridor.build.
 */
import { CONSTRUCTION } from '../config';
import { add, rightNormal, scale, type Vec } from '../core/vec';
import { convoyGap, frontOf, stageSpans } from '../game/constructionWork';
import { bridgeLook, deckAlong } from '../lanes/deck';
import type { LaneRenderer } from '../lanes/draw';
import { edgesAt, pointOff, stations } from '../lanes/geometry';
import type { Corridor, LaneNet } from '../lanes/model';
import { corridorLayer } from '../lanes/speedDisplay';
import type { BuildBase } from '../world/entities';
import { ROAD_MARGIN } from '../world/roadTypes';
import type { Box } from './tileCache';

/** Строящиеся полотна сети — кэш по версии (стройка меняет её, когда закладывает или открывает участок). */
const cache = new WeakMap<LaneNet, { version: number; list: Corridor[] }>();

export function buildingCorridors(net: LaneNet): Corridor[] {
  const hit = cache.get(net);
  if (hit && hit.version === net.version) return hit.list;
  const list = [...net.corridors.values()].filter((c) => c.build);
  cache.set(net, { version: net.version, list });
  return list;
}

/** Готовое на карте — целыми шагами drawStep (последний шаг — только когда участок готов целиком). */
export function drawnDone(c: Corridor): number {
  const done = c.build?.done ?? 0;
  return Math.min(c.length, Math.floor(done / CONSTRUCTION.drawStep) * CONSTRUCTION.drawStep);
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

/** Кромки полотна на [s0, s1]: левая и правая (с обочиной pad), у моста — подняты, как у готового. */
function band(net: LaneNet, c: Corridor, s0: number, s1: number, pad: number): { left: Vec[]; right: Vec[] } {
  const left: Vec[] = [];
  const right: Vec[] = [];
  const raised = Math.max(net.node(c.a).level, net.node(c.b).level) > 0;
  for (const s of stations(c, s0, s1, 5)) {
    const e = edgesAt(c, s);
    if (!e) continue;
    const d = raised ? bridgeLook(deckAlong(net, c, s)).lift : null;
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

/**
 * Проекты стройки слоя высоты layer (−1 тоннели, 0 земля, 1 мосты, 2 эстакады) в рамке view. Не построенное — сама
 * будущая дорога (полотна и узлы проекта рисует lanes — как готовые: полосы, разметка, мост с парапетом и тенью),
 * но полупрозрачной; кромки проекта — синим пунктиром (у тоннеля — бледнее, по земле над ним). Готовое — этапами от
 * начала заполнения: 🟫 отсыпка (чуть шире полотна), ⬛ покрытие (дорога без разметки), ⬜ разметка (дорога целиком).
 * Для плиток кэша и для рисования без кэша — одно и то же.
 */
export function drawProjects(ctx: CanvasRenderingContext2D, net: LaneNet, lanes: LaneRenderer, zoom: number, view: Box, layer: number): void {
  const list = buildingCorridors(net).filter((c) => seen(projectBox(c), view));
  if (!list.length) return;
  ctx.save();
  ctx.lineJoin = 'round';
  // Будущая дорога — одним полупрозрачным слоем, в рамке проектов (с запасом на площадки перекрёстков).
  if (lanes.layerIn(net, layer, view)) {
    const pad = 60;
    const box = list.map(projectBox).reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
    const clip: Box = {
      x0: Math.max(view.x0, box.x0 - pad),
      y0: Math.max(view.y0, box.y0 - pad),
      x1: Math.min(view.x1, box.x1 + pad),
      y1: Math.min(view.y1, box.y1 + pad),
    };
    drawFaded(ctx, clip, GHOST, (g) => {
      lanes.draw(g, net, zoom, false, view, layer);
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
    if (earthTo > 0.5) {
      const earth = band(net, c, ...span(earthTo), ROAD_MARGIN + 1.2);
      ctx.fillStyle = '#c4a57c';
      poly(ctx, [...earth.left, ...[...earth.right].reverse()]);
      ctx.closePath();
      ctx.fill();
    }
    // Покрытие и разметка — то же полотно, что у готовой дороги, в полосе готового (с запасом на бордюр и парапет).
    const only = (id: number) => id === c.id;
    const none = () => false;
    if (paveTo > 0.5) clipped(ctx, band(net, c, ...span(paveTo), ROAD_MARGIN + 3), () => lanes.draw(ctx, net, zoom, false, view, layer, { corridor: only, node: none, marks: false }));
    if (marksTo > 0.5) clipped(ctx, band(net, c, ...span(marksTo), ROAD_MARGIN + 3), () => lanes.draw(ctx, net, zoom, false, view, layer, { corridor: only, node: none }));
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
    const all = band(net, c, 0, c.length, ROAD_MARGIN);
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
 * Где машины этапов ждут своего начала (метров позади начала участка) и стоят, кончив (столько же до конца): разметка —
 * у самого начала, покрытие и грейдер — дальше, друг за другом без нахлёста. Стоянка у конца участка совпадает с
 * ожиданием в начале следующего, если он продолжает этот, — колонна переходит на него без скачков.
 */
const CREW_SLOT = [30, 10, 0] as const;
/** За столько метров своего края машина въезжает с обочины на полотно (и в конце этапа съезжает на неё). */
const CREW_RAMP = 24;

/**
 * Колонна техники на строящемся участке c (src/game/constructionWork.ts, stageSpans): у каждого этапа — своя машина
 * у своего края. Этап не начат — машина ждёт на обочине позади начала; начался — за первые CREW_RAMP метров плавно
 * въезжает на полотно к краю; кончился — пока следующий этап идёт свои CREW_RAMP метров, отъезжает на обочину к стоянке
 * у конца участка. Разметка кончается вместе с участком — её стоянка уже на следующем.
 */
export function crewConvoy(net: LaneNet, c: Corridor): CrewMachine[] {
  const b = c.build;
  if (!b) return [];
  const L = c.length;
  const fronts = stageSpans(b.done, L);
  const ramp = Math.min(CREW_RAMP, L / 2);
  const raised = Math.max(net.node(c.a).level, net.node(c.b).level) > 0;
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  /** Точка на u метров от начала заполнения (за концами — по касательной), сдвинутая вправо по ходу на lat. */
  const place = (u: number, side: number): { pos: Vec; dir: Vec } => {
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
  return ([0, 1, 2] as const).map((k) => {
    const f = fronts[k];
    const slot = CREW_SLOT[k];
    if (f >= L - 1e-6) {
      // Кончил: с полотна — на обочину к стоянке у конца, пока следующий этап проходит CREW_RAMP.
      const next = k < 2 ? fronts[k + 1] : L;
      const back = clamp01((next - (L - convoyGap(L))) / ramp);
      return { ...place(L - slot * back, back), stage: k, active: false };
    }
    if (f <= 0) return { ...place(-slot, 1), stage: k, active: false };
    // Въезд с обочины в начале этапа; разметка (за ней уже никого) в самом конце сама уходит на обочину — к месту,
    // где будет ждать на следующем участке.
    const into = clamp01(f / ramp);
    const out = k === 2 ? clamp01((f - (L - ramp / 2)) / (ramp / 2)) : 0;
    return { ...place(-slot + (f + slot) * into, Math.max(1 - into, out)), stage: k, active: true };
  });
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
 * и каток, 2 — машина разметки. light — маячок горит (работают).
 */
export function drawMachines(ctx: CanvasRenderingContext2D, at: Vec, dir: Vec, stage: 0 | 1 | 2, light: boolean, shift = 0): void {
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
  if (stage === 0) {
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
  ctx.arc(-1.8, 0, 0.7, 0, Math.PI * 2);
  ctx.fill();
  if (light) {
    ctx.fillStyle = 'rgba(255, 140, 40, 0.28)';
    ctx.beginPath();
    ctx.arc(-1.8, 0, 3, 0, Math.PI * 2);
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
