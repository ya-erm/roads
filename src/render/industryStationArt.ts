import type { Vec } from '../core/vec';
import type { IndustryHaulView } from '../game/industryHaul';
import { stationHaulRoad } from '../game/industryHaulRoutes';
import { openBayRear } from '../game/transport';
import { CARGO, type CargoType } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import { Art, shade } from './industryArt';
import { cargoShape } from './industryCargoArt';
import { paintTransferTruck } from './industryEquipment';
import { drawIndustrialGate, drawIndustrialRoads, industryRoadSurface } from './industryRoadArt';

export function drawIndustryYard(c: CanvasRenderingContext2D, st: Station, ind?: Industry): void {
  const { w, h } = st.fp;
  const left = -w / 2 + 2;
  const right = w / 2 - 2;
  const back = -h / 2;
  c.fillStyle = '#b6b4a9';
  c.fillRect(left, back + 1, w - 4, openBayRear(h) - back - 1);
  c.fillStyle = '#777c7c';
  if (st.industryAccess) {
    c.fillRect(left, back + 1, -4 - left, 1.1);
    c.fillRect(4, back + 1, right - 4, 1.1);
  } else c.fillRect(left, back + 1, right - left, 1.1);
  const roads = [stationHaulRoad(st, -1)];
  if (ind?.info.accepts.length) roads.push(stationHaulRoad(st, 1));
  drawIndustrialRoads(c, roads, industryRoadSurface(ind?.info.kind));
}

interface StorageCell {
  cargo: CargoType;
  x: number;
  y: number;
  w: number;
  h: number;
  amount: number;
}

/** Каждый вид сырья занимает свою ячейку. Готовый запас берётся со склада станции. */
export function drawIndustryYardStock(
  c: CanvasRenderingContext2D, st: Pick<Station, 'id' | 'fp' | 'cargo'>, ind: Industry, zoom: number, capacity: number, trip?: IndustryHaulView,
): void {
  const a = new Art(c, st, zoom, 0);
  const { w, h } = st.fp;
  const width = w / 2 - 14;
  const back = -h / 2 + 2;
  const cellHeight = openBayRear(h) - back;
  if (width < 4 || cellHeight < 3) return;
  const out = ind.info.produces;
  const cells: StorageCell[] = [{
    cargo: out, x: -w / 2 + 3, y: back, w: width, h: cellHeight,
    amount: Math.max(0, (st.cargo[out] ?? 0) - (trip?.outgoing[out] ?? 0)),
  }];
  const inputs = ind.info.accepts;
  const rightX = 11;
  inputs.forEach((cargo, i) => {
    const span = cellHeight / inputs.length;
    cells.push({
      cargo, x: rightX, y: back + i * span, w: width, h: span - (inputs.length > 1 ? 0.9 : 0),
      amount: (st.cargo[cargo] ?? 0) + (trip?.incoming[cargo] ?? 0),
    });
  });
  const freeSideX = inputs.length === 0 ? rightX : undefined;
  for (const cell of cells) paintStorageCell(a, cell, ind, capacity, st.fp.h >= 48 && cell.h > 18, freeSideX);
}

function paintStorageCell(a: Art, cell: StorageCell, ind: Industry, capacity: number, roof: boolean, freeSideX?: number): void {
  const { x, y, w, h, cargo, amount } = cell;
  const tone = CARGO[cargo].color;
  const shape = cargoShape(cargo, ind.info.kind);
  const fill = Math.min(1, amount / Math.max(1, capacity * 0.52));
  const radius = Math.min(w / 3.8, h / 2.8, 7);
  a.pass = 0;
  a.patch(x, y, w, h, shape === 'bulk' ? '#aca597' : '#c7c5bc', 1, '#94918a');
  a.pass = 2;
  if (shape === 'bulk') {
    a.box(x + 0.5, y, w - 1, 1.5, 2, '#878680');
    if (fill > 0 && radius > 1.1) {
      const r = radius * (0.24 + 0.76 * Math.sqrt(fill));
      const count = w > 16 && fill > 0.48 ? 2 : 1;
      for (let i = 0; i < count; i++) a.heap(x + w * (i + 1) / (count + 1), y + h * 0.58, r, tone, i + 77);
    }
    return;
  }
  if (shape === 'tank' || shape === 'silo') {
    const count = w > 19 ? 2 : 1;
    const split = count === 2 && freeSideX !== undefined;
    if (split) {
      a.pass = 0;
      a.patch(freeSideX, y, w, h, '#c7c5bc', 1, '#94918a');
      a.pass = 2;
    }
    // Приёмную половину оставляем сырью. В общей ячейке два резервуара разделяет зазор.
    const r = count === 2 && !split ? Math.min(radius, (w - 3) / 4) : radius;
    const cy = y + h * 0.53;
    for (let i = 0; i < count; i++) {
      const cx = split ? (i === 0 ? x : freeSideX) + w / 2 : x + w * (i + 0.5) / count;
      a.tank(cx, cy, r, shape === 'silo' ? 11 : 6, '#e2e3dd', fill > 0 ? tone : '#a1a4a5');
      if (fill > 0) a.box(cx - r * 0.58, cy + r * 0.78, r * 1.16 * fill, 0.7, 0.25, tone);
    }
    return;
  }
  if (shape === 'livestock') {
    a.gable(x + 1, y + 1, w * 0.43, Math.min(6, h * 0.44), 4, '#92745d');
    for (let i = 0; i < Math.ceil(fill * 6); i++) a.animal(x + w * (0.26 + a.r(i + 60) * 0.52), y + h * (0.43 + a.r(i + 70) * 0.38), i, i + 73);
    return;
  }
  if (shape === 'logs' || shape === 'planks') {
    if (fill <= 0) return;
    if (shape === 'logs') {
      const rows = Math.min(5, Math.max(1, Math.floor((h - 1) / 3)));
      const count = Math.ceil(rows * fill);
      const length = (w - 2.5) * (0.35 + 0.65 * fill);
      a.logs(x + (w - length) / 2, y + (h - count * 3) / 2, length, count, 145);
    } else a.stack(x + w * 0.13, y + h * 0.35, w * (0.25 + 0.62 * fill), h * 0.36, 1 + 3 * fill, tone, shade(tone, -0.23), '#685744');
    return;
  }
  const bricks = shape === 'bricks';
  if (roof && !bricks) {
    a.gable(x + 0.5, y + 0.6, w - 1, 9, 6, '#8799a0', true);
    a.box(x + 1, y + 9, w - 2, 2.4, 1.5, '#b3bec1');
  }
  const pad = roof && !bricks ? 13 : 1;
  const rows = h - pad > 10 ? 2 : 1;
  const columns = Math.max(1, Math.floor(w / (bricks ? 4.8 : 6.8)));
  const count = Math.ceil(rows * columns * fill);
  const pitch = (w - 2) / columns;
  const depthStep = (h - pad - 1) / rows;
  for (let i = 0; i < count; i++) {
    const left = x + 1 + i % columns * pitch;
    const top = y + pad + Math.floor(i / columns) * depthStep;
    const width = Math.min(pitch - 0.7, bricks ? 4.5 : 5.9);
    const height = Math.min(depthStep - 0.6, bricks ? 4.5 : 6.8);
    if (bricks) a.stack(left, top, width, height, 1.3 + fill * 1.7, tone, shade(tone, -0.25), '#a58a6b');
    else a.box(left, top, width, height, 1.7 + fill * 1.5, tone, 1.2);
  }
}

export function drawIndustryHaulConnection(c: CanvasRenderingContext2D, st: Station, ind: Industry, connection: readonly Vec[]): void {
  drawIndustrialRoads(c, [connection.map(({ x, y }) => [x, y])], industryRoadSurface(ind.info.kind));
  const gate = connection[connection.length - 1];
  drawIndustrialGate(c, gate.x, gate.y, st.fp.angle + Math.PI / 2);
}

/** Клиенты на улице и техника технологического двора используют разные проезды. */
export function drawIndustryTransfer(c: CanvasRenderingContext2D, ind: Industry, work: IndustryHaulView): void {
  for (const trip of work.trips) paintTransferTruck(c, trip, ind.info.kind);
}
