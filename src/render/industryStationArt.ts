import { closestOnSegment, dist, type Vec } from '../core/vec';
import { industryRoadPaths } from '../game/annexes';
import type { IndustryHaulView } from '../game/industryHaul';
import { CARGO, type CargoType } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import { moduleCargo } from '../world/industryModules';
import { sitePoint } from '../world/industrySites';
import type { Footprint } from '../world/spatial';
import { Art, shade } from './industryArt';
import { cargoShape } from './industryCargoArt';
import { type Circuit, paintTransferTruck } from './industryEquipment';
import { drawIndustrialGate, drawIndustrialRoads, industryRoadSurface } from './industryRoadArt';

export const OPEN_BAY_REAR = -2;

/** +y — выезд на улицу. Слева от технологического проезда отгрузка, справа приём сырья. */
function rearRoad(st: Station, side: 1 | -1): Circuit {
  const depth = st.fp.h / 2;
  return [[0, -depth + (st.industryAccess ? -5 : 4)], [0, -depth * 0.39], [side * 8, -depth * 0.39]];
}

export function drawIndustryYard(c: CanvasRenderingContext2D, st: Station, ind?: Industry): void {
  const { w, h } = st.fp;
  const left = -w / 2 + 2;
  const right = w / 2 - 2;
  const back = -h / 2;
  c.fillStyle = '#b6b4a9';
  c.fillRect(left, back + 1, w - 4, h / 2 + OPEN_BAY_REAR - 1);
  c.fillStyle = '#777c7c';
  if (st.industryAccess) {
    c.fillRect(left, back + 1, -4 - left, 1.1);
    c.fillRect(4, back + 1, right - 4, 1.1);
  } else c.fillRect(left, back + 1, right - left, 1.1);
  const roads = [rearRoad(st, -1)];
  if (ind?.info.accepts.length) roads.push(rearRoad(st, 1));
  drawIndustrialRoads(c, roads, industryRoadSurface(ind?.info.kind));
  if (st.industryAccess) drawIndustrialGate(c, 0, back, Math.PI / 2);
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
  c: CanvasRenderingContext2D, st: Station, ind: Industry, zoom: number, capacity: number, trip?: IndustryHaulView,
): void {
  const a = new Art(c, st, zoom, 0);
  const { w, h } = st.fp;
  const width = w / 2 - 14;
  const depth = h / 2 - 2;
  if (width < 4 || depth < 5) return;
  const out = ind.info.produces;
  const cellHeight = depth - 2;
  const cells: StorageCell[] = [{
    cargo: out, x: -w / 2 + 3, y: -depth, w: width, h: cellHeight,
    amount: Math.max(0, (st.cargo[out] ?? 0) - (trip?.outgoing[out] ?? 0)),
  }];
  const inputs = ind.info.accepts;
  inputs.forEach((cargo, i) => {
    const span = cellHeight / inputs.length;
    cells.push({
      cargo, x: 11, y: -depth + i * span, w: width, h: span - (inputs.length > 1 ? 0.9 : 0),
      amount: (st.cargo[cargo] ?? 0) + (trip?.incoming[cargo] ?? 0),
    });
  });
  for (const cell of cells) paintStorageCell(a, cell, ind, capacity, st.fp.h >= 48 && cell.h > 18);
}

function paintStorageCell(a: Art, cell: StorageCell, ind: Industry, capacity: number, roof: boolean): void {
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
    for (let i = 0; i < count; i++) {
      const cx = x + w * (i + 1) / (count + 1);
      a.tank(cx, y + h * 0.53, radius, shape === 'silo' ? 11 : 6, '#e2e3dd', fill > 0 ? tone : '#a1a4a5');
      if (fill > 0) a.box(cx - radius * 0.58, y + h * 0.53 + radius * 0.78, radius * 1.16 * fill, 0.7, 0.25, tone);
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
    if (shape === 'logs') a.logs(x + w / 2, y + h * 0.58, w * (0.3 + 0.58 * fill), Math.ceil(5 * fill), 145);
    else a.stack(x + w * 0.13, y + h * 0.35, w * (0.25 + 0.62 * fill), h * 0.36, 1 + 3 * fill, tone, shade(tone, -0.23), '#685744');
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

const transferPaths = new WeakMap<Station, {
  station: Footprint; plant: Footprint; annexes: Industry['annexes']; front: number; routes: Map<string, Circuit>;
}>();

/** Путь от ворот нужного участка к выходу из комплекса. Стыки веток лежат на оси проездов. */
function routeToExit(roads: readonly (readonly Vec[])[], start: Vec): readonly Vec[] {
  const main = roads[0];
  const exit = main[main.length - 1];
  const key = (p: Vec) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
  const vertices = [...new Map([start, ...roads.flat()].map((p) => [key(p), p])).values()];
  const segments = roads.flatMap((road) => road.slice(1).map((b, i) => [road[i], b] as const));
  const queue = [[start]];
  const known = new Set([key(start)]);
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    const at = path[path.length - 1];
    if (key(at) === key(exit)) return path;
    for (const [a, b] of segments) {
      if (dist(at, closestOnSegment(at, a, b).point) > 0.01) continue;
      for (const p of vertices) {
        if (known.has(key(p)) || dist(p, closestOnSegment(p, a, b).point) > 0.01) continue;
        known.add(key(p));
        queue.push([...path, p]);
      }
    }
  }
  return main;
}

function transferPath(st: Station, ind: Industry, front: 1 | -1, trip: IndustryHaulView): Circuit {
  let cached = transferPaths.get(st);
  if (cached?.station !== st.fp || cached.plant !== ind.fp || cached.front !== front || cached.annexes !== ind.annexes) {
    cached = { station: st.fp, plant: ind.fp, front, annexes: ind.annexes, routes: new Map() };
    transferPaths.set(st, cached);
  }
  const id = `${trip.direction}:${trip.cargo}`;
  const saved = cached.routes.get(id);
  if (saved) return saved;
  const { fp } = st;
  const rear = rearRoad(st, trip.direction === 'out' ? -1 : 1)
    .map(([x, y]) => sitePoint(fp, [x / fp.w, y * front / fp.h]));
  let path = rear;
  if (st.industryAccess) {
    const roads = industryRoadPaths(ind);
    const annex = ind.annexes?.find((part) => part.module && part.connector?.length && (trip.direction === 'out'
      ? part.module === 'warehouse'
      : moduleCargo(ind, part.module) === trip.cargo));
    const section = ind.fp.compound?.sections.find((part) => trip.direction === 'out'
      ? part.kind === 'warehouse'
      : part.kind === 'receiving' && part.cargo === trip.cargo);
    const start = annex?.connector?.at(-1) ?? (section?.gate ? sitePoint(ind.fp, section.gate) : roads[0][0]);
    path = [...routeToExit(roads, start), ...rear.slice(1)];
  }
  const route: Circuit = path.map(({ x, y }) => [x, y]);
  cached.routes.set(id, route);
  return route;
}

/** Клиенты на улице и техника технологического двора используют разные проезды. */
export function drawIndustryTransfer(c: CanvasRenderingContext2D, st: Station, ind: Industry, front: 1 | -1, trip: IndustryHaulView): void {
  paintTransferTruck(c, transferPath(st, ind, front, trip), trip, ind.info.kind);
}
