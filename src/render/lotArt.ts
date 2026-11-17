import type { LotGate, ParkingLot } from '../world/entities';
import { LOT, lotLayout } from '../world/parkingLots';
import type { LotRect } from '../world/houseAccess';
import type { Footprint } from '../world/spatial';

/**
 * Площадка-стоянка на карте (docs/PARKING.md, этап 3; раскладка — world/parkingLots.ts): асфальт, бордюр по краю,
 * белые линии мест, проезды, ворота у края к улице (значок хода: ⬌ — в обе стороны, ⇥ — въезд, ↤ — выезд) и заезд от
 * бордюра до ворот через тротуар; у большой площадки — тупик-выезд (его рисует сеть). Вдали — асфальт и «P».
 */
const ASPHALT = 'rgba(96,102,112,0.95)';
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

/** Ворота площадки: заезд от бордюра через тротуар и стрелки хода. */
function drawGates(ctx: CanvasRenderingContext2D, fp: Footprint, gates: readonly LotGate[], zoom: number, big: boolean, bad?: readonly number[]): void {
  const H = fp.h;
  gates.forEach((g, i) => {
    const w = LOT.gateW;
    if (!big) {
      ctx.fillStyle = ASPHALT;
      ctx.fillRect(g.x - w / 2, -H / 2 - LOT.setback, w, LOT.setback + 0.5);
    }
    ctx.strokeStyle = bad?.includes(i) ? '#e0473c' : PAINT;
    ctx.lineWidth = Math.max(0.4, 1.4 / zoom);
    const y = -H / 2 - LOT.setback / 2;
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

/** Площадка в плитки кэша (под машинами; машины на местах рисует движение). */
export function drawLotArt(ctx: CanvasRenderingContext2D, lot: ParkingLot, zoom: number): void {
  const { fp } = lot;
  const W = fp.w;
  const H = fp.h;
  ctx.save();
  frame(ctx, fp);
  ctx.fillStyle = ASPHALT;
  ctx.fillRect(-W / 2, -H / 2, W, H);
  ctx.strokeStyle = CURB;
  ctx.lineWidth = 0.7;
  ctx.strokeRect(-W / 2 + 0.35, -H / 2 + 0.35, W - 0.7, H - 0.7);
  if (zoom >= FINE) {
    drawStalls(ctx, lotLayout(lot).stalls.map((s) => s.rect), zoom);
    drawGates(ctx, fp, lot.gates, zoom, !!lot.nodes?.length);
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
  drawGates(ctx, fp, o.gates, zoom, false, o.bad);
  ctx.restore();
}
