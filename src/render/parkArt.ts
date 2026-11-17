import { hash } from '../core/math';
import { dist, type Vec } from '../core/vec';
import { CORNER_CUT_MAX } from '../lanes/geometry';
import type { Corridor, LaneNet, LaneNode } from '../lanes/model';
import type { Town, TownPark } from '../world/entities';
import { inPolygon, junctionPlate, polyDist } from '../world/lotClear';
import { ROAD_MARGIN } from '../world/roadTypes';
import type { Footprint } from '../world/spatial';
import { corridorHalf, curbGap, halfAtS } from '../world/worldgen';
import { Art, disc } from './industryArt';
import { type Box, grow } from './tileCache';
import {
  along,
  bench,
  curve,
  flowerbed,
  fountain,
  lamp,
  LAMPS_ON,
  loop,
  obelisk,
  PAVING,
  pathDist,
  paths,
  playground,
  statue,
  STONE,
  WATER,
  type Path,
} from './townDecor';

/**
 * Парки, скверы, сквер с памятником и набережная (world/townParks.ts), вид сверху — в плитках кэша карты, под дорогами:
 * дорога игрока через парк ложится поверх. Сцена — в осях участка (x — вдоль улицы, у набережной вода — со стороны
 * +y); три прохода, как у домов (houseArt.ts): земля → общая тень → кроны, памятники, скамейки. Раскладка — по хешу
 * от id парка, считается раз на парк (не в каждой плитке): дорожки плавные — кривые и овал, деревья — группами в
 * стороне от дорожек. Детали по зуму: издали — газон и пятна крон; ближе — дорожки, клумбы, тени; от 0,5 — кромки
 * дорожек, скамейки, разметка; совсем вблизи — фонари, струи фонтана, вечный огонь.
 */

/** Совсем вблизи — фонари, струи фонтана, цветы на клумбах. */
export const PARK_FINE = 1.1;
const LAWN = 'rgba(118,172,80,0.55)';
const LAWN_FAR = 'rgba(118,172,80,0.66)';
const PLAZA = '#e6dcc6';
const HEDGE = 'rgba(92,136,62,0.85)';
const FIRS = ['#4f7a4a', '#5a8752', '#46704a'];
const TREES = ['#8fb46a', '#7aa55a', '#9cc177', '#6e9a52'];

interface Tree {
  x: number;
  y: number;
  r: number;
  /** Номер цвета (по палитре биома) или ель (-1). */
  k: number;
}

/** Раскладка парка: всё в осях участка, без зума — рисуется по ней на любом. */
interface Layout {
  paths: Path[];
  /** Ширина дорожек. */
  pw: number;
  /** Мощёные круги и прямоугольники (площадки). */
  plazas: { x: number; y: number; r: number }[];
  pads: { x: number; y: number; w: number; h: number; color: string }[];
  fountains: { x: number; y: number; r: number }[];
  statues: { x: number; y: number; s: number }[];
  obelisk: { x: number; y: number } | null;
  ponds: { x: number; y: number; rx: number; ry: number }[];
  beds: { x: number; y: number; rx: number; ry: number; rot: number }[];
  playgrounds: { x: number; y: number; s: number }[];
  trees: Tree[];
  benches: { x: number; y: number; ux: number; uy: number; side: number }[];
  lamps: { x: number; y: number }[];
  /** Набережная: прогулочная полоса и парапет у воды. */
  promenade: boolean;
  /** Площадь: весь участок мощёный (брусчатка), а не газон. */
  paved: boolean;
}

const layouts = new Map<number, { key: string; layout: Layout }>();

function emptyLayout(): Layout {
  return {
    paths: [],
    pw: 2.2,
    plazas: [],
    pads: [],
    fountains: [],
    statues: [],
    obelisk: null,
    ponds: [],
    beds: [],
    playgrounds: [],
    trees: [],
    benches: [],
    lamps: [],
    promenade: false,
    paved: false,
  };
}

/** Свободно ли место под дерево или клумбу радиуса r: в участке, в стороне от дорожек, площадок, прудов. */
function roomy(L: Layout, W: number, H: number, x: number, y: number, r: number): boolean {
  if (Math.abs(x) > W / 2 - r - 0.8 || Math.abs(y) > H / 2 - r - 0.8) return false;
  for (const p of L.paths) if (pathDist(p, x, y) < r + L.pw / 2 + 0.6) return false;
  for (const p of L.plazas) if (Math.hypot(x - p.x, y - p.y) < p.r + r + 0.6) return false;
  for (const p of L.ponds) if (Math.hypot((x - p.x) / (p.rx + r + 1), (y - p.y) / (p.ry + r + 1)) < 1) return false;
  for (const b of L.beds) if (Math.hypot(x - b.x, y - b.y) < Math.max(b.rx, b.ry) + r + 0.4) return false;
  for (const g of L.playgrounds) if (x > g.x - r - 0.5 && x < g.x + g.s + r + 0.5 && y > g.y - r - 0.5 && y < g.y + g.s + r + 0.5) return false;
  for (const d of L.pads) if (x > d.x - r && x < d.x + d.w + r && y > d.y - r && y < d.y + d.h + r) return false;
  if (L.obelisk && Math.hypot(x - L.obelisk.x, y - L.obelisk.y) < r + 5) return false;
  for (const t of L.trees) if (Math.hypot(x - t.x, y - t.y) < (r + t.r) * 0.62) return false;
  return true;
}

/** Деревья группами: n групп по 3–6 деревьев в свободных местах. */
function groves(L: Layout, W: number, H: number, seed: number, n: number, firs = 0): void {
  for (let g = 0; g < n; g++) {
    const gx = (hash(seed, 100 + g) - 0.5) * (W - 6);
    const gy = (hash(seed, 200 + g) - 0.5) * (H - 6);
    const count = 4 + Math.floor(hash(seed, 300 + g) * 5);
    const spread = 3.5 + hash(seed, 400 + g) * 4.5;
    const fir = hash(seed, 450 + g) < firs;
    for (let k = 0; k < count * 2 && k < 18; k++) {
      const a = hash(seed, 500 + g * 20 + k) * Math.PI * 2;
      const d = k === 0 ? 0 : spread * Math.sqrt(hash(seed, 700 + g * 20 + k));
      const r = (fir ? 1.7 : 2.1) + hash(seed, 900 + g * 20 + k) * 1.5;
      const x = gx + Math.cos(a) * d;
      const y = gy + Math.sin(a) * d;
      if (roomy(L, W, H, x, y, r)) L.trees.push({ x, y, r, k: fir ? -1 : Math.floor(hash(seed, 1100 + g * 20 + k) * 4) });
    }
  }
}

/** Ряд деревьев по краю участка (отступ inset), через step м; пропуски — у дорожек и по хешу. */
function rim(L: Layout, W: number, H: number, seed: number, inset: number, step: number, keep: number): void {
  // Крона не выходит за изгородь: отступ — не меньше радиуса кроны с запасом.
  inset = Math.max(inset, 3.2);
  const edges: [number, number, number, number][] = [
    [-W / 2 + inset, -H / 2 + inset, W / 2 - inset, -H / 2 + inset],
    [W / 2 - inset, -H / 2 + inset, W / 2 - inset, H / 2 - inset],
    [W / 2 - inset, H / 2 - inset, -W / 2 + inset, H / 2 - inset],
    [-W / 2 + inset, H / 2 - inset, -W / 2 + inset, -H / 2 + inset],
  ];
  let i = 0;
  for (const [x0, y0, x1, y1] of edges) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    // С угла и через ~step: угол ряда — его первое дерево (у следующей стороны угол — её первое).
    const n = Math.max(1, Math.round(len / step));
    for (let k = 0; k < n; k++, i++) {
      if (hash(seed, 1300 + i) > keep) continue;
      const t = k / n;
      const r = Math.min(inset - 1, 1.9 + hash(seed, 1500 + i) * 0.9);
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      if (roomy(L, W, H, x, y, r)) L.trees.push({ x, y, r, k: Math.floor(hash(seed, 1700 + i) * 4) });
    }
  }
}

/** Скамейки вдоль дорожки через step м: по очереди с обеих сторон; фонари — между ними. */
function furnish(L: Layout, p: Path, step: number, seed: number, lamps = true): void {
  let len = 0;
  for (let i = 0; i + 3 < p.length; i += 2) len += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
  const n = Math.floor(len / step);
  for (let k = 0; k < n; k++) {
    const q = along(p, (k + 0.5) / n);
    const side = k % 2 ? 1 : -1;
    const off = L.pw / 2 + 0.75;
    if (hash(seed, 2000 + k) < 0.8) L.benches.push({ x: q.x - q.uy * side * off, y: q.y + q.ux * side * off, ux: q.ux, uy: q.uy, side });
    if (lamps && k % 2 === 0) {
      const l = along(p, (k + 1) / n);
      L.lamps.push({ x: l.x + l.uy * side * (L.pw / 2 + 0.5), y: l.y - l.ux * side * (L.pw / 2 + 0.5) });
    }
  }
}

/** Большой парк: круговая дорожка, входы с краёв кривыми к площади в середине (фонтан или клумба с памятником), пруд, группы деревьев. */
function bigLayout(W: number, H: number, seed: number): Layout {
  const L = emptyLayout();
  L.pw = 2.6;
  const px = (hash(seed, 1) - 0.5) * W * 0.12;
  const py = (hash(seed, 2) - 0.5) * H * 0.12;
  const pr = Math.max(5, Math.min(12, Math.min(W, H) * 0.1));
  L.plazas.push({ x: px, y: py, r: pr });
  const ring = loop(px, py, (W / 2 - pr - 6) * 0.72 + pr * 0.4, (H / 2 - pr - 6) * 0.72 + pr * 0.4, 0.07, seed);
  L.paths.push(ring);
  // Входы — середины сторон и углы; два — с противоположных сторон, ещё один-два — по хешу.
  const gates: [number, number][] = [
    [0, -H / 2],
    [0, H / 2],
    [-W / 2, 0],
    [W / 2, 0],
    [-W / 2, -H / 2],
    [W / 2, H / 2],
    [W / 2, -H / 2],
    [-W / 2, H / 2],
  ];
  const first = hash(seed, 3) < 0.5 ? 0 : 2;
  const pick = [first, first + 1, ...[4, 5, 6, 7].filter((i) => hash(seed, 10 + i) < 0.35)];
  if (hash(seed, 4) < 0.5) pick.push(first === 0 ? 2 : 0);
  for (const i of pick) {
    const [gx, gy] = gates[i];
    const ex = gx * 0.985;
    const ey = gy * 0.985;
    const d = Math.hypot(px - ex, py - ey);
    const ux = (px - ex) / d;
    const uy = (py - ey) / d;
    const bend = (hash(seed, 20 + i) - 0.5) * d * 0.45;
    const tx = px - ux * pr;
    const ty = py - uy * pr;
    L.paths.push(curve(ex, ey, (ex + tx) / 2 - uy * bend, (ey + ty) / 2 + ux * bend, tx, ty));
  }
  if (hash(seed, 5) < 0.65) L.fountains.push({ x: px, y: py, r: pr * 0.62 });
  else {
    L.beds.push({ x: px, y: py, rx: pr * 0.62, ry: pr * 0.62, rot: 0 });
    L.statues.push({ x: px, y: py, s: 1.8 });
  }
  // Пруд — в одной из четвертей, если там нет дорожек.
  if (W * H > 4200 && hash(seed, 6) < 0.55) {
    const qx = (hash(seed, 7) < 0.5 ? -1 : 1) * W * 0.3;
    const qy = (hash(seed, 8) < 0.5 ? -1 : 1) * H * 0.28;
    const rx = Math.min(W, H) * 0.13;
    const ry = rx * 0.72;
    if (L.paths.every((p) => pathDist(p, qx, qy) > rx + L.pw)) L.ponds.push({ x: qx, y: qy, rx, ry });
  }
  // Клумбы у площади — между входами.
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const r = pr + 3.8;
    const x = px + Math.cos(a) * r;
    const y = py + Math.sin(a) * r;
    if (roomy(L, W, H, x, y, 2.2)) L.beds.push({ x, y, rx: 2.8, ry: 1.7, rot: a + Math.PI / 2 });
  }
  // Детская площадка в большом парке — где найдётся место.
  if (W * H > 5000) {
    for (let k = 0; k < 6; k++) {
      const s = 9;
      const x = (hash(seed, 40 + k) - 0.5) * (W - s - 8) - s / 2;
      const y = (hash(seed, 50 + k) - 0.5) * (H - s - 8) - s / 2;
      if ([0, 1].every((i) => [0, 1].every((j) => roomy(L, W, H, x + i * s, y + j * s, 0.5))) && roomy(L, W, H, x + s / 2, y + s / 2, s / 2)) {
        L.playgrounds.push({ x, y, s });
        break;
      }
    }
  }
  groves(L, W, H, seed, Math.round((W * H) / 380), 0.15);
  rim(L, W, H, seed, 3.2, 8, 0.6);
  furnish(L, ring, 12, seed);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    L.benches.push({ x: px + Math.cos(a) * (pr - 0.9), y: py + Math.sin(a) * (pr - 0.9), ux: -Math.sin(a), uy: Math.cos(a), side: 1 });
  }
  return L;
}

/** Сквер: дорожки крестом, кольцом или одной дугой; в середине — клумба, фонтанчик или бюст; деревья по краю. */
function squareLayout(W: number, H: number, seed: number): Layout {
  const L = emptyLayout();
  L.pw = 2;
  const mode = hash(seed, 1);
  const cr = Math.max(2.4, Math.min(W, H) * 0.14);
  const w2 = W / 2 - 0.4;
  const h2 = H / 2 - 0.4;
  if (mode < 0.4) {
    // Крест по диагоналям, слегка изогнутый.
    const b = (hash(seed, 2) - 0.5) * 4;
    L.paths.push(curve(-w2, -h2, -b, b, w2, h2), curve(w2, -h2, b, b, -w2, h2));
  } else if (mode < 0.75) {
    // Кольцо вокруг середины и два входа.
    L.paths.push(loop(0, 0, cr + 2.6, cr + 2.2, 0, seed));
    L.paths.push(curve(0, -h2, (hash(seed, 3) - 0.5) * 3, -h2 / 2, 0, -cr - 2.2), curve(0, h2, (hash(seed, 4) - 0.5) * 3, h2 / 2, 0, cr + 2.2));
  } else {
    // Одна дуга от угла к углу.
    const s = hash(seed, 5) < 0.5 ? 1 : -1;
    L.paths.push(curve(-w2, -h2 * s, 0, h2 * s * 0.9, w2, -h2 * s * 0.2));
  }
  // Середина — на пересечении дорожек; у дуги — в стороне от неё, где хватает места.
  const spot =
    mode < 0.75
      ? { x: 0, y: 0 }
      : [
          { x: 0, y: h2 * 0.45 },
          { x: 0, y: -h2 * 0.45 },
          { x: w2 * 0.45, y: 0 },
          { x: -w2 * 0.45, y: 0 },
        ].find((p) => roomy(L, W, H, p.x, p.y, cr + 0.6));
  if (spot) {
    const { x: cx, y: cy } = spot;
    if (mode < 0.75) L.plazas.push({ x: cx, y: cy, r: cr + 0.6 });
    const center = hash(seed, 6);
    if (center < 0.45) L.beds.push({ x: cx, y: cy, rx: cr, ry: cr, rot: 0 });
    else if (center < 0.75) L.fountains.push({ x: cx, y: cy, r: cr });
    else {
      L.beds.push({ x: cx, y: cy, rx: cr, ry: cr, rot: 0 });
      L.statues.push({ x: cx, y: cy, s: 1.3 });
    }
    L.lamps.push({ x: cx + cr + 1.4, y: cy - cr - 1.4 }, { x: cx - cr - 1.4, y: cy + cr + 1.4 });
  }
  rim(L, W, H, seed, 3, 4.2, 0.85);
  groves(L, W, H, seed, 3, 0);
  for (const p of L.paths) furnish(L, p, 7, seed + 3, false);
  return L;
}

/** Сквер с памятником (село): мощёная площадка с обелиском и вечным огнём, клумбы, ели по бокам, дорожка насквозь. */
function memorialLayout(W: number, H: number, seed: number): Layout {
  const L = emptyLayout();
  L.pw = 2;
  const pw = Math.min(W * 0.4, 15);
  const ph = Math.min(H * 0.42, 12);
  L.pads.push({ x: -pw / 2, y: -ph / 2, w: pw, h: ph, color: PAVING });
  L.paths.push([0, -H / 2, 0, -ph / 2], [0, ph / 2, 0, H / 2]);
  L.obelisk = { x: 0, y: 0.6 };
  for (const sx of [-1, 1]) L.beds.push({ x: sx * (pw / 2 - 1.6), y: -ph / 2 + 1.6, rx: 1.2, ry: 1.2, rot: 0 });
  // Ели — рядами по бокам, за ними — берёзы и липы.
  for (const sx of [-1, 1]) {
    for (let y = -H / 2 + 3; y <= H / 2 - 3; y += 4.2) {
      const x = sx * (pw / 2 + 2.6);
      if (Math.abs(x) < W / 2 - 2) L.trees.push({ x, y, r: 1.7, k: -1 });
    }
  }
  rim(L, W, H, seed, 2.2, 6, 0.7);
  L.benches.push({ x: -pw / 2 + 0.8, y: ph / 2 - 1.2, ux: 0, uy: 1, side: 1 }, { x: pw / 2 - 0.8, y: ph / 2 - 1.2, ux: 0, uy: 1, side: -1 });
  L.lamps.push({ x: -pw / 2 - 0.6, y: -ph / 2 - 0.6 }, { x: pw / 2 + 0.6, y: -ph / 2 - 0.6 });
  return L;
}

/**
 * Площадь у ратуши: брусчатка во весь участок; посередине — памятник в кольце клумбы (фонтан — у самой ратуши,
 * houseArt), по сторонам — длинные клумбы, вокруг памятника — скамейки, по углам — деревья в приствольных кругах,
 * по краю — фонари.
 */
function plazaLayout(W: number, H: number, seed: number): Layout {
  const L = emptyLayout();
  L.paved = true;
  L.pw = 0;
  const long = W >= H;
  const cr = Math.max(2.2, Math.min(5.5, Math.min(W, H) * 0.12));
  L.beds.push({ x: 0, y: 0, rx: cr, ry: cr, rot: 0 });
  L.statues.push({ x: 0, y: 0, s: Math.min(2.4, cr * 0.7) });
  const span = (long ? W : H) / 2;
  if (span > 14) {
    for (const s of [-1, 1]) {
      const d = Math.min(span - 5, Math.max(cr + 6, span * 0.55));
      const rx = Math.min(7, span * 0.18);
      const ry = Math.min(1.8, (long ? H : W) * 0.09);
      L.beds.push(long ? { x: s * d, y: 0, rx, ry, rot: 0 } : { x: 0, y: s * d, rx, ry, rot: Math.PI / 2 });
    }
  }
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    L.benches.push({ x: Math.cos(a) * (cr + 1.6), y: Math.sin(a) * (cr + 1.6), ux: -Math.sin(a), uy: Math.cos(a), side: -1 });
  }
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ])
    L.trees.push({ x: sx * (W / 2 - 3), y: sy * (H / 2 - 3), r: 2.3 + hash(seed, 3 + sx + sy * 2) * 0.6, k: Math.floor(hash(seed, 9 + sx + sy * 3) * 4) });
  // Фонари — по краю через ~10 м.
  for (const [x0, y0, x1, y1] of [
    [-W / 2 + 1, -H / 2 + 1, W / 2 - 1, -H / 2 + 1],
    [-W / 2 + 1, H / 2 - 1, W / 2 - 1, H / 2 - 1],
  ]) {
    const n = Math.max(1, Math.round((x1 - x0) / 10));
    for (let k = 0; k <= n; k++) L.lamps.push({ x: x0 + ((x1 - x0) * k) / n, y: y0 + ((y1 - y0) * k) / n });
  }
  return L;
}

/** Набережная: у воды (+y) — прогулочная полоса с парапетом, скамейки лицом к воде; на суше — газон и ряд деревьев. */
function embankLayout(W: number, H: number, seed: number): Layout {
  const L = emptyLayout();
  L.promenade = true;
  L.pw = 4.6;
  const y = H / 2 - 3.4;
  for (let x = -W / 2 + 4.25; x < W / 2; x += 8.5) {
    L.trees.push({ x, y: -H / 2 + 3, r: 2.2 + hash(seed, Math.round(x)) * 0.8, k: Math.floor(hash(seed, 50 + Math.round(x)) * 4) });
    L.benches.push({ x: x + 4.25 < W / 2 ? x + 4.25 : x - 1, y: y - 1.6, ux: 1, uy: 0, side: -1 });
  }
  for (let x = -W / 2 + 5.5; x < W / 2; x += 11) L.lamps.push({ x, y: H / 2 - 1.5 });
  return L;
}

function layoutOf(p: TownPark): Layout {
  const { w: W, h: H } = p.fp;
  const key = `${p.kind}|${W.toFixed(1)}|${H.toFixed(1)}`;
  const had = layouts.get(p.id);
  if (had?.key === key) return had.layout;
  const make = { park: bigLayout, memorial: memorialLayout, embankment: embankLayout, plaza: plazaLayout, square: squareLayout }[p.kind];
  const layout = make(W, H, p.id);
  layouts.set(p.id, { key, layout });
  return layout;
}

/** Что есть в парке — по той же раскладке, что рисуется на карте (карточка парка, ui/parkCard.ts). */
export interface ParkContents {
  fountains: number;
  ponds: number;
  /** Памятники и бюсты на постаменте. */
  statues: number;
  /** Обелиск с вечным огнём (сквер с памятником). */
  obelisk: boolean;
  playgrounds: number;
  beds: number;
  trees: number;
  benches: number;
  lamps: number;
  /** Прогулочная полоса с парапетом у воды (набережная). */
  promenade: boolean;
  /** Весь участок мощёный (площадь). */
  paved: boolean;
}

export function parkContents(p: TownPark): ParkContents {
  const L = layoutOf(p);
  return {
    fountains: L.fountains.length,
    ponds: L.ponds.length,
    statues: L.statues.length,
    obelisk: !!L.obelisk,
    playgrounds: L.playgrounds.length,
    beds: L.beds.length,
    trees: L.trees.length,
    benches: L.benches.length,
    // Фонари пока не рисуются (LAMPS_ON) — и в карточке их нет.
    lamps: LAMPS_ON ? L.lamps.length : 0,
    promenade: L.promenade,
    paved: L.paved,
  };
}

/**
 * Входы парка или сквера: концы его дорожек у края участка — точка в мире и направление наружу (по нормали к ближней
 * стороне). От них дорожки ведут к тротуару ближней улицы (render/townWalks.ts). У площади и набережной входов нет —
 * они сами у тротуара.
 */
export function parkGates(p: TownPark): { x: number; y: number; ux: number; uy: number }[] {
  if (p.kind === 'plaza' || p.kind === 'embankment') return [];
  const { w: W, h: H } = p.fp;
  const c = Math.cos(p.fp.angle);
  const s = Math.sin(p.fp.angle);
  const out: { x: number; y: number; ux: number; uy: number }[] = [];
  for (const path of layoutOf(p).paths) {
    for (const i of [0, path.length - 2]) {
      const x = path[i];
      const y = path[i + 1];
      const dx = W / 2 - Math.abs(x);
      const dy = H / 2 - Math.abs(y);
      if (Math.min(dx, dy) > 2.5) continue;
      // Наружу — к ближней стороне.
      const [nx, ny] = dx < dy ? [Math.sign(x), 0] : [0, Math.sign(y)];
      out.push({ x: p.fp.center.x + x * c - y * s, y: p.fp.center.y + x * s + y * c, ux: nx * c - ny * s, uy: nx * s + ny * c });
    }
  }
  return out;
}

// ---------- Аллеи вдоль проспектов и фонари вдоль улиц ----------

/** Деревья и фонари вдоль одного полотна города: точки по очереди и рамка (для кэша карты). */
export interface StreetGreen {
  id: number;
  /** x, y, r — по очереди. */
  trees: number[];
  /** x, y — по очереди (пока фонари выключены — LAMPS_ON, — пусто). */
  lamps: number[];
  box: Box;
  /** Подпись для кэша карты: поменялась — плитки под полотном перерисовать. */
  sig: string;
}

/** Фонари вдоль улиц — только при сильном приближении. */
export const LAMP_ZOOM = 1.4;
/**
 * Деревья аллеи — между тротуаром (render/sidewalks.ts, 3,6 м от края полотна) и участками домов (в 5 м): кроны над
 * краем тротуара.
 */
const ALLEY = { step: 9, end: 14, off: 4.4 };
const LAMPS = { step: 27, off: 0.9 };
/**
 * Не ближе стольких метров к площадке перекрёстка (асфальт со скруглениями углов): дерево — за тротуаром, как вдоль
 * полотна (ALLEY.off от края, с запасом), фонарь — у самого бордюра.
 */
const PLATE_CLEAR = { tree: ALLEY.off - 0.6, lamp: 0.4 };
/** Аллея полотна зависит от полотен не дальше стольких метров от его оси (деревья — в ~10 м от неё, соседи — в 30 м). */
const ALLEY_REACH = 50;

/** Площадка перекрёстка для проверки деревьев: контур и его рамка. */
interface Plate {
  poly: Vec[];
  box: Box;
}

/** Рамка оси полотна — по точкам таблицы длин (она общая у копий сети: на протяжке — тот же объект). */
const axisBoxes = new WeakMap<object, Box>();
function axisBox(c: Corridor): Box {
  let b = axisBoxes.get(c.lut);
  if (!b) {
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const p of c.lut.points) b = { x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x), y1: Math.max(b.y1, p.y) };
    axisBoxes.set(c.lut, b);
  }
  return b;
}

/** Подпись узла для кэша аллей: всё, от чего его площадка, — вид, уровень, скругления углов и формы его полотен. */
function nodeSig(roads: LaneNet, n: LaneNode): string {
  let s = `${n.id}:${n.kind}:${n.level}:${n.roundabout ?? ''}:`;
  if (n.corners) for (const k of Object.keys(n.corners).sort()) s += `${k}=${n.corners[k]},`;
  for (const id of n.corridors) s += `${roads.corridors.get(id)?.rev ?? 0},`;
  return s;
}

/**
 * Аллеи и фонари городов: вдоль проспектов в черте города — ряд деревьев по обе стороны между тротуаром и участками
 * домов, вдоль улиц и проспектов — фонари в шахматном порядке (пока выключены, LAMPS_ON). Не у перекрёстков и не на
 * их площадках (со скруглёнными игроком углами — тоже), не на других полотнах, не на остановках и строениях (busy), не
 * на мостах и в тоннелях. Тротуары — render/sidewalks.ts.
 *
 * cache — между пересчётами (и на протяжке правки — по сети с правкой): аллея полотна берётся оттуда, пока те же его
 * форма, узлы на концах (скругления углов, примыкания), полотна рядом и перекрёстки со скруглёнными углами в досягаемости.
 * Поменялось что-то из них — сдвинули или повернули узел, скруглили угол, перестроили соседнюю дорогу — считается заново.
 * only — только эти полотна (на протяжке — alleyScope): остальные аллеи правка не меняет.
 */
export function streetGreen(
  roads: LaneNet,
  towns: readonly Pick<Town, 'center' | 'radius'>[],
  busy: (p: Vec, r: number) => boolean,
  cache?: Map<number, { sig: string; line: StreetGreen | null }>,
  only?: ReadonlySet<number>,
): StreetGreen[] {
  const out: StreetGreen[] = [];
  const list = only ? [...only].flatMap((id) => roads.corridors.get(id) ?? []) : roads.corridors.values();
  // Скруглённые игроком углы: дуга бордюра уходит от узла до обрезов подъездов (до CORNER_CUT_MAX) — далеко за «у узла».
  const rounded: LaneNode[] = [];
  for (const n of roads.nodes.values()) if (n.corners && n.kind === 'junction') rounded.push(n);
  const plates = new Map<number, Plate | null>();
  const plateOf = (n: LaneNode): Plate | null => {
    let p = plates.get(n.id);
    if (p === undefined) {
      const poly = n.level === 0 ? junctionPlate(roads, n) : null;
      let box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const q of poly ?? []) box = { x0: Math.min(box.x0, q.x), y0: Math.min(box.y0, q.y), x1: Math.max(box.x1, q.x), y1: Math.max(box.y1, q.y) };
      plates.set(n.id, (p = poly ? { poly, box } : null));
    }
    return p;
  };
  for (const c of list) {
    if (c.build || c.ring || (c.cls !== 'avenue' && c.cls !== 'street')) continue;
    const na = roads.node(c.a);
    const nb = roads.node(c.b);
    if (na.level !== 0 || nb.level !== 0) continue;
    const mid = c.lut.pointAt(c.length / 2);
    if (!towns.some((t) => dist(mid, t.center) < t.radius)) continue;
    const box = axisBox(c);
    const near = roads.corridorsInBox(box.x0 - ALLEY_REACH, box.y0 - ALLEY_REACH, box.x1 + ALLEY_REACH, box.y1 + ALLEY_REACH);
    near.sort((p, q) => p.id - q.id);
    const reach = CORNER_CUT_MAX + ALLEY_REACH;
    const far = rounded.filter(
      (n) => n !== na && n !== nb && n.pos.x > box.x0 - reach && n.pos.x < box.x1 + reach && n.pos.y > box.y0 - reach && n.pos.y < box.y1 + reach,
    );
    let key = `${c.rev}|${nodeSig(roads, na)}|${nodeSig(roads, nb)}|`;
    for (const o of near) if (o !== c) key += `${o.id}:${o.rev},`;
    for (const n of far) key += `|${nodeSig(roads, n)}`;
    const had = cache?.get(c.id);
    if (had?.sig === key) {
      if (had.line) out.push(had.line);
      continue;
    }
    const around: Plate[] = [];
    for (const n of [na, nb, ...far]) {
      const p = plateOf(n);
      if (p && !around.includes(p)) around.push(p);
    }
    const line = alleyOf(roads, c, busy, around);
    cache?.set(c.id, { sig: key, line });
    if (line) out.push(line);
  }
  return out;
}

/**
 * Полотна сети next (копия before с правкой), чьи аллеи правка может поменять: changed — полотна и узлы правки (как
 * sidewalkScope). Аллея полотна зависит от полотен в ALLEY_REACH от него (до и после правки) и от скруглённых углов
 * перекрёстков дальше — до CORNER_CUT_MAX (там кончается дуга бордюра).
 */
export function alleyScope(before: LaneNet, next: LaneNet, changed: { corridors: ReadonlySet<number>; nodes: ReadonlySet<number> }): Set<number> {
  const out = new Set<number>(changed.corridors);
  const take = (b: Box, pad: number) => {
    for (const c of next.corridorsInBox(b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + pad)) out.add(c.id);
  };
  for (const net of [before, next]) {
    for (const id of changed.corridors) {
      const c = net.corridors.get(id);
      if (c) take(axisBox(c), ALLEY_REACH);
    }
    for (const id of changed.nodes) {
      const n = net.nodes.get(id);
      if (n) take({ x0: n.pos.x, y0: n.pos.y, x1: n.pos.x, y1: n.pos.y }, ALLEY_REACH + (n.corners ? CORNER_CUT_MAX : 0));
    }
  }
  return out;
}

/** Аллея и фонари одного полотна (streetGreen); plates — площадки перекрёстков, куда не сажать. */
function alleyOf(roads: LaneNet, c: Corridor, busy: (p: Vec, r: number) => boolean, plates: readonly Plate[]): StreetGreen | null {
  // Другие полотна подходят близко у узлов (пересекаются улицы в узле), а под острым углом к узлу — и дальше от него:
  // там полоса стоянки соседней улицы (с одной стороны — curbGap) доходит до аллеи. Площадка перекрёстка со
  // скруглённым углом выходит далеко за края полотен: дуга бордюра срезает угол квартала.
  const free = (p: Vec, r: number, s: number, clear: number) => {
    if (busy(p, r)) return false;
    const mid = s > 45 && s < c.length - 45;
    for (const o of roads.corridorsNear(p, 30)) {
      if (o === c) continue;
      if (mid ? curbGap(o, p) < r + 0.5 : o.lut.closest(p).d < corridorHalf(o) + r + 0.5) return false;
    }
    for (const { poly, box } of plates) {
      if (p.x < box.x0 - clear || p.x > box.x1 + clear || p.y < box.y0 - clear || p.y > box.y1 + clear) continue;
      if (inPolygon(p, poly) || polyDist(p, poly) < clear) return false;
    }
    return mid || !roads.nodesNear(p, 4 + r).length;
  };
  const trees: number[] = [];
  const lamps: number[] = [];
  if (c.cls === 'avenue') {
    for (let s = ALLEY.end; s <= c.length - ALLEY.end; s += ALLEY.step) {
      const p = c.lut.pointAt(s);
      const t = c.lut.tangentAt(s);
      const hw = halfAtS(c, s);
      for (const side of [1, -1]) {
        const r = 1.8 + hash(c.id * 31 + side, Math.round(s)) * 0.6;
        const q = { x: p.x - t.y * side * (hw + ALLEY.off), y: p.y + t.x * side * (hw + ALLEY.off) };
        if (free(q, r, s, PLATE_CLEAR.tree)) trees.push(q.x, q.y, r);
      }
    }
  }
  if (LAMPS_ON) {
    for (let s = LAMPS.step / 2, k = 0; s <= c.length - 8; s += LAMPS.step, k++) {
      const p = c.lut.pointAt(s);
      const t = c.lut.tangentAt(s);
      const side = k % 2 ? 1 : -1;
      const off = halfAtS(c, s) + LAMPS.off - ROAD_MARGIN;
      const q = { x: p.x - t.y * side * off, y: p.y + t.x * side * off };
      if (free(q, 0.4, s, PLATE_CLEAR.lamp)) lamps.push(q.x, q.y);
    }
  }
  if (!trees.length && !lamps.length) return null;
  let box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const take = (x: number, y: number) => (box = { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) });
  for (let i = 0; i < trees.length; i += 3) take(trees[i], trees[i + 1]);
  for (let i = 0; i < lamps.length; i += 2) take(lamps[i], lamps[i + 1]);
  const sig = `${trees.map((v) => v.toFixed(1)).join(',')}|${lamps.map((v) => v.toFixed(1)).join(',')}`;
  return { id: c.id, trees, lamps, box: grow(box, 6), sig };
}

/** Аллеи и фонари в рамке view — поверх дорог, под домами; тени — одной заливкой. */
export function drawStreetGreen(ctx: CanvasRenderingContext2D, lines: readonly StreetGreen[], view: Box, zoom: number, trees: readonly string[] = TREES): void {
  const seen = lines.filter((l) => l.box.x1 >= view.x0 && l.box.x0 <= view.x1 && l.box.y1 >= view.y0 && l.box.y0 <= view.y1);
  if (!seen.length) return;
  const a = new Art(ctx, { id: 0, fp: { center: { x: 0, y: 0 }, w: 1, h: 1, angle: 0 } }, zoom, 0, 0, 'still');
  const lit = zoom > LAMP_ZOOM;
  ctx.save();
  for (const pass of [1, 2] as const) {
    if (pass === 1 && !a.lod) continue;
    a.pass = pass;
    if (pass === 1) ctx.beginPath();
    for (const l of seen) {
      for (let i = 0; i < l.trees.length; i += 3) a.tree(l.trees[i], l.trees[i + 1], l.trees[i + 2] * (a.lod ? 1 : 1.1), trees[(l.id + i) % trees.length]);
      if (lit) for (let i = 0; i < l.lamps.length; i += 2) lamp(a, l.lamps[i], l.lamps[i + 1], true);
    }
    if (pass === 1) {
      ctx.fillStyle = 'rgba(30,40,25,0.2)';
      ctx.fill();
    }
  }
  ctx.restore();
}

// ---------- Фонтаны вблизи: рябь поверх плиток ----------

/** С какого зума фонтаны «оживают» (рябь в каждом кадре фона). */
export const FOUNTAIN_ZOOM = 1.6;

/** Фонтаны парка в мире: середина и радиус чаши. */
export function parkFountains(p: TownPark): { x: number; y: number; r: number }[] {
  const c = Math.cos(p.fp.angle);
  const s = Math.sin(p.fp.angle);
  return layoutOf(p).fountains.map((f) => ({ x: p.fp.center.x + f.x * c - f.y * s, y: p.fp.center.y + f.x * s + f.y * c, r: f.r }));
}

/**
 * Рябь на воде фонтанов — два расходящихся круга и пульсирующая струя посередине: несколько дуг на фонтан, рисуется
 * поверх плиток в каждом кадре фона (renderer.drawMotion), только при сильном приближении. time — секунды часов.
 */
export function drawFountainRipples(ctx: CanvasRenderingContext2D, list: readonly { x: number; y: number; r: number }[], time: number): void {
  if (!list.length) return;
  ctx.save();
  ctx.lineWidth = 0.18;
  for (const f of list) {
    for (const k of [0, 0.5]) {
      const ph = (time * 0.45 + k + f.x * 0.013) % 1;
      ctx.strokeStyle = `rgba(255,255,255,${(0.55 * (1 - ph)).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r * (0.34 + 0.46 * ph), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r * (0.1 + 0.04 * Math.sin(time * 6 + f.y)), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Насколько рисунок парка выходит за его участок (тени деревьев, обелиска), м — для рамки в кэше карты. */
export const PARK_REACH = 7;

/** Парк, сквер или набережная — сцена в осях участка, три прохода. trees — цвета деревьев биома. */
export function drawParkArt(ctx: CanvasRenderingContext2D, park: TownPark, zoom: number, trees: readonly string[] = TREES): void {
  const L = layoutOf(park);
  const fp: Footprint = park.fp;
  const W = fp.w;
  const H = fp.h;
  const a = new Art(ctx, { id: park.id, fp }, zoom, 0, park.id, 'still');
  const fine = zoom > PARK_FINE;
  const c = ctx;
  const color = (t: Tree) => (t.k < 0 ? FIRS[Math.floor(hash(park.id, Math.round(t.x * 13 + t.y)) * FIRS.length)] : trees[t.k % trees.length]);
  ctx.save();
  ctx.translate(fp.center.x, fp.center.y);
  ctx.rotate(fp.angle);
  for (const pass of [0, 1, 2] as const) {
    if (pass === 1 && !a.lod) continue;
    a.pass = pass;
    if (pass === 1) ctx.beginPath();
    if (pass === 0) {
      // Газон; набережная — газон только на суше, у воды — мощёная полоса; площадь — брусчатка во весь участок.
      c.fillStyle = L.paved ? PLAZA : a.lod ? LAWN : LAWN_FAR;
      c.beginPath();
      c.roundRect(-W / 2, -H / 2, W, H, L.paved || L.promenade ? 0.5 : Math.min(4, Math.min(W, H) * 0.15));
      c.fill();
      if (L.paved) {
        if (a.lod) {
          c.strokeStyle = 'rgba(120,100,70,0.35)';
          c.lineWidth = 0.6;
          c.strokeRect(-W / 2 + 0.3, -H / 2 + 0.3, W - 0.6, H - 0.6);
        }
        if (a.d) {
          // Брусчатка: ряды вдоль длинной стороны, швы рядов — со сдвигом (вблизи).
          const long = W >= H;
          c.strokeStyle = 'rgba(150,130,100,0.28)';
          c.lineWidth = 0.12;
          c.beginPath();
          const A = long ? W : H;
          const B = long ? H : W;
          for (let v = -B / 2 + 1.2; v < B / 2; v += 1.2) (long ? (c.moveTo(-A / 2, v), c.lineTo(A / 2, v)) : (c.moveTo(v, -A / 2), c.lineTo(v, A / 2)));
          if (fine) {
            let row = 0;
            for (let v = -B / 2; v < B / 2 - 1.2; v += 1.2, row++) {
              for (let u = -A / 2 + (row % 2 ? 0.9 : 0); u < A / 2; u += 1.8) (long ? (c.moveTo(u, v), c.lineTo(u, v + 1.2)) : (c.moveTo(v, u), c.lineTo(v + 1.2, u)));
            }
          }
          c.stroke();
          // Приствольные круги у деревьев.
          c.fillStyle = 'rgba(120,100,70,0.35)';
          for (const t of L.trees) disc(c, t.x, t.y, 1.3);
        }
      } else if (L.promenade) {
        c.fillStyle = PAVING;
        c.fillRect(-W / 2, H / 2 - 5.6, W, 5.6);
        if (a.lod) {
          c.fillStyle = STONE;
          c.fillRect(-W / 2, H / 2 - 0.9, W, 0.9);
        }
        if (a.d) {
          // Плиты прогулочной полосы и балясины парапета.
          c.strokeStyle = 'rgba(150,140,120,0.35)';
          c.lineWidth = 0.12;
          c.beginPath();
          for (let x = -W / 2 + 2; x < W / 2; x += 2) (c.moveTo(x, H / 2 - 5.6), c.lineTo(x, H / 2 - 0.9));
          c.stroke();
          c.strokeStyle = '#a49c8a';
          c.lineWidth = 0.18;
          c.beginPath();
          for (let x = -W / 2 + 0.6; x < W / 2; x += 1.2) (c.moveTo(x, H / 2 - 0.85), c.lineTo(x, H / 2 - 0.05));
          c.stroke();
        }
      } else if (a.lod) {
        // Живая изгородь по краю.
        c.strokeStyle = HEDGE;
        c.lineWidth = a.d ? 0.9 : 1.2;
        c.beginPath();
        c.roundRect(-W / 2 + 0.5, -H / 2 + 0.5, W - 1, H - 1, Math.min(3.5, Math.min(W, H) * 0.14));
        c.stroke();
      }
      if (!a.lod) {
        // Издали — газон и пятна крон, дорожки и вода — только у большого парка.
        if (W >= 40) paths(a, L.paths, L.pw + 1.4);
        c.fillStyle = trees[0] ?? TREES[0];
        for (const t of L.trees) if (t.r > 2.4 || L.trees.length < 30) disc(c, t.x, t.y, t.r * 1.15);
        for (const p of L.ponds) {
          c.fillStyle = WATER;
          c.beginPath();
          c.ellipse(p.x, p.y, p.rx, p.ry, 0, 0, Math.PI * 2);
          c.fill();
        }
        continue;
      }
      for (const p of L.ponds) a.stain(p.x, p.y, p.rx, p.ry, WATER, park.id % 97, 0.18, a.d ? '#b9b19a' : undefined);
      for (const d of L.pads) a.patch(d.x, d.y, d.w, d.h, d.color, 0.6);
      paths(a, L.paths, L.pw);
      for (const p of L.plazas) {
        c.fillStyle = PAVING;
        disc(c, p.x, p.y, p.r);
        if (a.d) {
          c.strokeStyle = 'rgba(150,140,120,0.4)';
          c.lineWidth = 0.15;
          c.beginPath();
          c.arc(p.x, p.y, p.r * 0.75, 0, Math.PI * 2);
          c.stroke();
        }
      }
    }
    for (const b of L.beds) flowerbed(a, b.x, b.y, b.rx, b.ry, park.id * 7 + Math.round(b.x * 3 + b.y), fine, b.rot);
    for (const f of L.fountains) fountain(a, f.x, f.y, f.r, fine);
    for (const g of L.playgrounds) playground(a, g.x, g.y, g.s, park.id + g.x, fine);
    for (const s of L.statues) statue(a, s.x, s.y, s.s);
    if (L.obelisk) obelisk(a, L.obelisk.x, L.obelisk.y, 2.4, 12, true, fine);
    if (pass === 0 && a.d && L.ponds.length && fine) {
      // Камыш у берега пруда.
      c.strokeStyle = '#6f8f4a';
      c.lineWidth = 0.18;
      for (const p of L.ponds) {
        c.beginPath();
        for (let k = 0; k < 10; k++) {
          const t = hash(park.id, 60 + k) * Math.PI * 2;
          const x = p.x + Math.cos(t) * p.rx * 0.92;
          const y = p.y + Math.sin(t) * p.ry * 0.92;
          c.moveTo(x, y);
          c.lineTo(x + 0.3, y - 0.8);
        }
        c.stroke();
      }
    }
    if (pass !== 0) for (const t of L.trees) a.tree(t.x, t.y, t.r, color(t));
    for (const b of L.benches) bench(a, b.x, b.y, b.ux, b.uy, b.side);
    for (const l of L.lamps) lamp(a, l.x, l.y, fine);
    if (pass === 1) {
      c.fillStyle = 'rgba(30,40,25,0.2)';
      c.fill();
    }
  }
  ctx.restore();
}
