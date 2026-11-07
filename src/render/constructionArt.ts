/**
 * Стройка дорог на карте (режим «Со строительством», src/game/construction.ts):
 * - чертёж проекта — полотно синей штриховкой по кромкам, ось пунктиром (рисуется в плитки кэша карты);
 * - этапы на строящемся участке (CONSTRUCTION.stages): 🟫 отсыпка, ⬛ покрытие, ⬜ разметка — до края каждого,
 *   шагами CONSTRUCTION.drawStep: плитки обновляются по шагу, а не каждый такт (projectSig);
 * - площадки строительных баз — тоже в плитках (drawBases);
 * - техника бригад у края работ (по этапу), самосвалы свободных бригад на базе и подпись «🏗 45%» — поверх,
 *   в динамическом проходе кадра, не в плитках.
 * Готовые участки рисует обычная отрисовка дорог: у них уже нет Corridor.build.
 */
import { CONSTRUCTION } from '../config';
import { add, scale, type Vec } from '../core/vec';
import { frontOf, stageSpans } from '../game/constructionWork';
import { bridgeLook, deckAlong } from '../lanes/deck';
import { edgesAt, pointOff, stations } from '../lanes/geometry';
import type { Corridor, LaneNet } from '../lanes/model';
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

/**
 * Чертежи строящихся полотен сети net в рамке view: штриховка и кромки пунктиром, готовое — отсыпкой и асфальтом.
 * Тоннель — бледнее (он под землёй). Для плиток кэша и для рисования без кэша — одно и то же.
 */
export function drawProjects(ctx: CanvasRenderingContext2D, net: LaneNet, zoom: number, view: Box): void {
  const list = buildingCorridors(net).filter((c) => seen(projectBox(c), view));
  if (!list.length) return;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  const px = 1 / Math.max(0.05, zoom);
  for (const c of list) {
    const tunnel = Math.min(net.node(c.a).level, net.node(c.b).level) < 0 && Math.max(net.node(c.a).level, net.node(c.b).level) <= 0;
    ctx.globalAlpha = tunnel ? 0.55 : 1;
    const all = band(net, c, 0, c.length, ROAD_MARGIN);
    if (all.left.length < 2) continue;
    // Чертёж: бледная синяя заливка полотна и кромки пунктиром.
    ctx.fillStyle = 'rgba(47, 128, 237, 0.13)';
    poly(ctx, [...all.left, ...[...all.right].reverse()]);
    ctx.closePath();
    ctx.fill();
    // Этапы: 🟫 отсыпка (чуть шире полотна), ⬛ покрытие поверх, ⬜ разметка — от начала заполнения.
    const [earthTo, paveTo, marksTo] = stageSpans(drawnDone(c), c.length);
    const span = (to: number): [number, number] => (c.build?.fromB ? [c.length - to, c.length] : [0, to]);
    if (earthTo > 0.5) {
      const earth = band(net, c, ...span(earthTo), ROAD_MARGIN + 1.2);
      ctx.fillStyle = '#c4a57c';
      poly(ctx, [...earth.left, ...[...earth.right].reverse()]);
      ctx.closePath();
      ctx.fill();
    }
    if (paveTo > 0.5) {
      const top = band(net, c, ...span(paveTo), 0);
      ctx.fillStyle = '#6a6f77';
      poly(ctx, [...top.left, ...[...top.right].reverse()]);
      ctx.closePath();
      ctx.fill();
    }
    if (marksTo > 0.5) {
      // Разметка: кромки сплошной, ось — пунктиром.
      const [m0, m1] = span(marksTo);
      const edge = band(net, c, m0, m1, -0.4);
      ctx.strokeStyle = 'rgba(240, 242, 244, 0.9)';
      ctx.lineWidth = Math.max(0.3, 0.35);
      ctx.setLineDash([]);
      poly(ctx, edge.left);
      ctx.stroke();
      poly(ctx, edge.right);
      ctx.stroke();
      ctx.setLineDash([3, 4]);
      poly(
        ctx,
        stations(c, m0, m1, 6).map((s) => c.lut.pointAt(s)),
      );
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = '#2f80ed';
    ctx.lineWidth = Math.max(0.6, 1.4 * px);
    ctx.setLineDash([7 * px, 5 * px]);
    poly(ctx, all.left);
    ctx.stroke();
    poly(ctx, all.right);
    ctx.stroke();
    // Ось — точками: «здесь будет дорога».
    ctx.globalAlpha *= 0.6;
    ctx.lineWidth = Math.max(0.5, 1 * px);
    ctx.setLineDash([2 * px, 6 * px]);
    poly(
      ctx,
      stations(c, 0, c.length, 6).map((s) => c.lut.pointAt(s)),
    );
    ctx.stroke();
    ctx.setLineDash([]);
  }
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
