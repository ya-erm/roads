import type { LotGate, ParkingLot } from '../world/entities';
import { LOT, lotLayout } from '../world/parkingLots';
import type { LotRect } from '../world/houseAccess';
import type { Footprint } from '../world/spatial';

/**
 * Площадка-стоянка на карте (docs/PARKING.md, этап 3; раскладка — world/parkingLots.ts): асфальт, бордюр по краю,
 * белые линии мест, проезды, ворота у края к улице (значок хода: ⬌ — в обе стороны, ⇥ — въезд, ↤ — выезд) и заезд от
 * бордюра до ворот через тротуар; у большой площадки — тупик-выезд (его рисует сеть, без разворота на конце). Большая
 * рисуется поверх сети: тупик-выезд виден до края площадки, дальше — проезд её покрытием (мест под ним нет, lotLayout),
 * без бордюра в воротах. Вдали — асфальт и «P».
 */
// Непрозрачный: кромка и разметка тупика-выезда под большой площадкой не должны просвечивать.
export const LOT_ASPHALT = 'rgb(96,102,112)';
const ASPHALT = LOT_ASPHALT;
const CURB = 'rgba(200,200,196,0.95)';
const PAINT = 'rgba(245,245,240,0.9)';
const SIGN = '#2f6fd0';

/** С какого масштаба рисовать линии мест. */
const FINE = 0.6;

/** Участок в осях площадки: x — вдоль улицы, улица — со стороны −y. */
function frame(ctx: CanvasRenderingContext2D, fp: Footprint): void {
  ctx.translate(fp.center.x, fp.center.y);
  ctx.rotate(fp.angle);
}

/** Значок хода ворот: стрелки к улице и от неё. */
export function gateGlyph(mode: LotGate['mode']): string {
  return mode === 'both' ? '⬌' : mode === 'in' ? '⇥' : '↤';
}

/** Стрелка хода у ворот (в осях площадки): x — середина, y — край, dir — +1 внутрь, −1 наружу. */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, dir: 1 | -1, size: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - dir * size);
  ctx.lineTo(x, y + dir * size * 0.6);
  ctx.moveTo(x - size * 0.5, y + dir * size * 0.1);
  ctx.lineTo(x, y + dir * size * 0.7);
  ctx.lineTo(x + size * 0.5, y + dir * size * 0.1);
  ctx.stroke();
}

/**
 * Ворота площадки: стрелки хода на проезде у края. Заезд от ворот через газон и тротуар до полотна рисуют дорожки
 * кварталов поверх тротуара (render/townWalks.ts, с понижением бордюра), в предпросмотре — подсветка ворот.
 */
function drawGates(ctx: CanvasRenderingContext2D, fp: Footprint, gates: readonly LotGate[], zoom: number, bad?: readonly number[]): void {
  const H = fp.h;
  gates.forEach((g, i) => {
    ctx.strokeStyle = bad?.includes(i) ? '#e0473c' : PAINT;
    ctx.lineWidth = Math.max(0.4, 1.4 / zoom);
    // Стрелки хода — на проезде площадки у края (у большой за краем — тупик-выезд со своей разметкой).
    const y = -H / 2 + 3;
    if (g.mode !== 'out') arrow(ctx, g.x - (g.mode === 'both' ? 1.6 : 0), y, 1, 2);
    if (g.mode !== 'in') arrow(ctx, g.x + (g.mode === 'both' ? 1.6 : 0), y, -1, 2);
  });
}

/** Линии мест: боковые границы каждого места (как разметка во дворах). */
function drawStalls(ctx: CanvasRenderingContext2D, stalls: readonly LotRect[], zoom: number, color = PAINT): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.25, 0.9 / zoom);
  ctx.beginPath();
  for (const r of stalls) {
    ctx.moveTo(r.x, r.y);
    ctx.lineTo(r.x, r.y + r.h);
    ctx.moveTo(r.x + r.w, r.y);
    ctx.lineTo(r.x + r.w, r.y + r.h);
  }
  ctx.stroke();
}

/** Бордюр по краю участка; в проёмах gaps (от и до по x на краю у улицы) его нет — там въезд тупика-выезда. */
function drawCurb(ctx: CanvasRenderingContext2D, W: number, H: number, gaps: readonly (readonly [number, number])[]): void {
  ctx.strokeStyle = CURB;
  ctx.lineWidth = 0.7;
  const x0 = -W / 2 + 0.35;
  const x1 = W / 2 - 0.35;
  const y0 = -H / 2 + 0.35;
  const y1 = H / 2 - 0.35;
  if (!gaps.length) {
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    return;
  }
  // Кругом от первого проёма до последнего по краю у улицы, между проёмами — кусками.
  const cuts = [...gaps].sort((a, b) => a[0] - b[0]);
  ctx.beginPath();
  ctx.moveTo(Math.max(x0, cuts[0][0]), y0);
  ctx.lineTo(x0, y0);
  ctx.lineTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.lineTo(x1, y0);
  ctx.lineTo(Math.min(x1, cuts[cuts.length - 1][1]), y0);
  for (let k = 0; k + 1 < cuts.length; k++) {
    if (cuts[k + 1][0] <= cuts[k][1]) continue;
    ctx.moveTo(cuts[k][1], y0);
    ctx.lineTo(cuts[k + 1][0], y0);
  }
  ctx.stroke();
}

/** Площадка в плитки кэша (под машинами; машины на местах рисует движение). */
export function drawLotArt(ctx: CanvasRenderingContext2D, lot: ParkingLot, zoom: number): void {
  const { fp } = lot;
  const W = fp.w;
  const H = fp.h;
  ctx.save();
  frame(ctx, fp);
  const big = !!lot.nodes?.length;
  ctx.fillStyle = ASPHALT;
  ctx.fillRect(-W / 2, -H / 2, W, H);
  // В воротах бордюра нет: у большой — во всю ширину тупика-выезда, у маленькой — заезда.
  const half = big ? LOT.stubEdge : LOT.gateW / 2;
  drawCurb(ctx, W, H, lot.gates.map((g) => [g.x - half, g.x + half] as const));
  if (zoom >= FINE) {
    drawStalls(ctx, lotLayout(lot).stalls.map((s) => s.rect), zoom);
    drawGates(ctx, fp, lot.gates, zoom);
  }
  // Знак «P» у края к улице, вдали — посередине.
  const r = zoom >= FINE ? 2.6 : Math.min(W, H) * 0.25;
  const sx = zoom >= FINE ? -W / 2 + 3 : 0;
  const sy = zoom >= FINE ? -H / 2 + 3 : 0;
  ctx.fillStyle = SIGN;
  ctx.fillRect(sx - r, sy - r, 2 * r, 2 * r);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${r * 1.5}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Буква — по курсу площадки, но не вверх ногами.
  ctx.save();
  ctx.translate(sx, sy);
  if (Math.cos(fp.angle) < 0) ctx.rotate(Math.PI);
  ctx.fillText('P', 0, r * 0.08);
  ctx.restore();
  ctx.restore();
}

/** Предпросмотр площадки (инструмент, перенос, ручки): участок, места, ворота; нельзя — красным. */
export function drawLotPreview(
  ctx: CanvasRenderingContext2D,
  o: { fp: Footprint; gates: readonly LotGate[]; ok: boolean; bad?: readonly number[]; stalls: readonly LotRect[]; selected?: boolean },
  zoom: number,
): void {
  const { fp } = o;
  ctx.save();
  frame(ctx, fp);
  const tint = o.ok ? (o.selected ? 'rgba(47,128,237,' : 'rgba(46,170,90,') : 'rgba(224,71,60,';
  if (!o.selected) {
    ctx.fillStyle = `${tint}0.28)`;
    ctx.fillRect(-fp.w / 2, -fp.h / 2, fp.w, fp.h);
  }
  ctx.strokeStyle = `${tint}0.95)`;
  ctx.lineWidth = 2 / zoom;
  ctx.setLineDash(o.selected ? [6 / zoom, 4 / zoom] : []);
  ctx.strokeRect(-fp.w / 2, -fp.h / 2, fp.w, fp.h);
  ctx.setLineDash([]);
  drawStalls(ctx, o.stalls, zoom, 'rgba(255,255,255,0.85)');
  // Ворота: подсветка края у улицы и стрелки хода.
  for (let i = 0; i < o.gates.length; i++) {
    const g = o.gates[i];
    ctx.fillStyle = o.bad?.includes(i) ? 'rgba(224,71,60,0.7)' : `${tint}0.55)`;
    ctx.fillRect(g.x - LOT.gateW / 2, -fp.h / 2 - LOT.setback, LOT.gateW, LOT.setback + 1);
  }
  drawGates(ctx, fp, o.gates, zoom, o.bad);
  ctx.restore();
}
