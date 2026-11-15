import type { HouseForm, TownBuilding } from '../world/entities';
import type { Footprint } from '../world/spatial';
import { formOf } from '../world/townForms';
import { Art, disc, METAL } from './industryArt';

/**
 * Дома городов, вид сверху (типы застройки — world/townForms.ts). Сцена дома рисуется в осях участка: начало — в
 * середине, x — вдоль улицы, улица — со стороны −y (дом с face = 1 повёрнут на пол-оборота: поворот, а не зеркало,
 * поэтому свет и тени те же). Как у предприятий (Art из industryArt.ts), три прохода одним кодом: земля участка →
 * общая тень всех построек одной заливкой → крыши. «Случайное» — хеш от id дома: картинка не дрожит.
 *
 * Детали по зуму (Art.lod): издали (lod 0) — только крыши и цвет участка, без теней; ближе (lod 1) — тени, скаты
 * крыш, заборы, деревья; вблизи (lod 2) — коньки, парапеты, грядки, разметка, выходы на крышу; совсем вблизи
 * (fine) — машины, штакетник, качели. Всё — в плитки кэша карты (src/render/tileCache.ts), без ctx.filter и размытия.
 */

const SHADOW = 'rgba(30,40,25,0.2)';
/** Совсем вблизи — машины во дворах, штакетник, качели. */
const FINE_ZOOM = 1.1;

const LAWN = 'rgba(128,170,88,0.2)';
const LAWN_DACHA = 'rgba(140,182,92,0.26)';
const BEDS = 'rgba(132,100,66,0.42)';
const SPROUTS = 'rgba(92,132,58,0.7)';
const PAVING = 'rgba(184,176,162,0.62)';
const GRAVEL = 'rgba(206,192,160,0.85)';
const ASPHALT = 'rgba(112,114,120,0.62)';
const SAND = '#e3cf98';
const PLAZA = '#e6dcc6';
/** Участок издали (lod 0): цвет застройки. */
const FAR_LOT = 'rgba(226,212,184,0.8)';
const GLASS = 'rgba(226,242,248,0.88)';
const FIELD = '#8fbf62';
const TRACK = '#c8735a';
const WOOD = '#9b7b55';
const HEDGE = '#6d9a4c';
const DOME_GOLD = '#e2b84a';
const CAR_COLORS = ['#c94f43', '#3f74b5', '#e8e8e4', '#5a5f66', '#4f9a5a', '#d9a13a', '#2f3640'];
const METAL_ROOFS = ['#6d8f6a', '#5f7f9f', '#9a9da3', '#8c5a4a'];
const AWNINGS = ['#c9503f', '#4f9a5a', '#3f74b5', '#e08a2e', '#8b5aa8'];
const STALLS = ['#d9534f', '#f0ad4e', '#5bc0de', '#5cb85c', '#f4f1ea', '#b46ac4'];
const TREES = ['#8fb46a', '#7aa55a', '#9cc177', '#6e9a52'];

/** Что знает сцена дома. */
interface Lot {
  b: TownBuilding;
  /** Размер участка: W — вдоль улицы, H — вглубь; улица — у y = −H/2. */
  W: number;
  H: number;
  fine: boolean;
  trees: readonly string[];
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

const tones = new Map<string, string>();
/**
 * Цвет #rrggbb светлее (k > 0) или темнее (k < 0) — тоже #rrggbb, поэтому его можно тонировать ещё раз (shade из
 * industryArt отдаёт rgb(): по нему второй раз — чёрный). Кэш — без новых строк в каждом кадре.
 */
export function tone(hex: string, k: number): string {
  const key = `${hex}|${k}`;
  let v = tones.get(key);
  if (v === undefined) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c: number) => Math.max(0, Math.min(255, Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k))));
    v = `#${((1 << 24) | (f((n >> 16) & 255) << 16) | (f((n >> 8) & 255) << 8) | f(n & 255)).toString(16).slice(1)}`;
    tones.set(key, v);
  }
  return v;
}

/** Высота стен по этажам, м: от неё — длина тени. */
const wallZ = (floors: number) => 1 + floors * 3;

/** Насколько далеко рисунок дома выходит за его контур (тень, площадь у ратуши), м — для рамки в кэше карты. */
export function houseReach(b: Pick<TownBuilding, 'floors' | 'kind'>): number {
  return (b.kind === 'landmark' ? 9 : 2) + wallZ(Math.max(b.floors, b.kind === 'landmark' ? 8 : 1)) * 0.6;
}

// ---------- Примитивы ----------

function poly(c: CanvasRenderingContext2D, pts: number[]): void {
  c.beginPath();
  c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
  c.fill();
}

/** Скат крыши с внешней нормалью (nx, ny): к свету светлее, от света темнее. */
function slope(a: Art, color: string, nx: number, ny: number): string {
  const k = Math.round((nx * a.lx + ny * a.ly) * 6) / 6;
  return tone(color, k * 0.2);
}

/**
 * Скатная крыша над прямоугольником: конёк вдоль длинной стороны (along — вдоль x), hip — насколько конёк короче
 * с каждого конца (вальмовая; половина короткой стороны — шатёр). z — высота до карниза (для тени).
 */
function pitched(a: Art, x: number, y: number, w: number, h: number, z: number, color: string, along: boolean, hip = 0, ribs = false): void {
  if (a.pass === 1) return a.rectShadow(x, y, w, h, z + Math.min(w, h) * 0.3);
  if (a.pass !== 2) return;
  const c = a.c;
  if (!a.lod) {
    c.fillStyle = color;
    c.fillRect(x, y, w, h);
    return;
  }
  if (along) {
    const hp = Math.min(hip, w / 2);
    const ym = y + h / 2;
    c.fillStyle = slope(a, color, 0, -1);
    poly(c, [x, y, x + w, y, x + w - hp, ym, x + hp, ym]);
    c.fillStyle = slope(a, color, 0, 1);
    poly(c, [x, y + h, x + w, y + h, x + w - hp, ym, x + hp, ym]);
    if (hp > 0) {
      c.fillStyle = slope(a, color, -1, 0);
      poly(c, [x, y, x + hp, ym, x, y + h]);
      c.fillStyle = slope(a, color, 1, 0);
      poly(c, [x + w, y, x + w - hp, ym, x + w, y + h]);
    }
  } else {
    const hp = Math.min(hip, h / 2);
    const xm = x + w / 2;
    c.fillStyle = slope(a, color, -1, 0);
    poly(c, [x, y, xm, y + hp, xm, y + h - hp, x, y + h]);
    c.fillStyle = slope(a, color, 1, 0);
    poly(c, [x + w, y, xm, y + hp, xm, y + h - hp, x + w, y + h]);
    if (hp > 0) {
      c.fillStyle = slope(a, color, 0, -1);
      poly(c, [x, y, x + w, y, xm, y + hp]);
      c.fillStyle = slope(a, color, 0, 1);
      poly(c, [x, y + h, x + w, y + h, xm, y + h - hp]);
    }
  }
  if (!a.d) return;
  const dark = tone(color, -0.38);
  if (ribs) {
    c.strokeStyle = tone(color, -0.16);
    c.lineWidth = 0.22;
    c.beginPath();
    if (along) for (let xx = x + 1; xx < x + w - 0.3; xx += 1) (c.moveTo(xx, y + 0.2), c.lineTo(xx, y + h - 0.2));
    else for (let yy = y + 1; yy < y + h - 0.3; yy += 1) (c.moveTo(x + 0.2, yy), c.lineTo(x + w - 0.2, yy));
    c.stroke();
  }
  c.strokeStyle = dark;
  c.lineWidth = 0.35;
  c.beginPath();
  if (along) {
    const hp = Math.min(hip, w / 2);
    c.moveTo(x + hp, y + h / 2);
    c.lineTo(x + w - hp, y + h / 2);
    if (hp > 0) {
      c.moveTo(x, y);
      c.lineTo(x + hp, y + h / 2);
      c.lineTo(x, y + h);
      c.moveTo(x + w, y);
      c.lineTo(x + w - hp, y + h / 2);
      c.lineTo(x + w, y + h);
    }
  } else {
    const hp = Math.min(hip, h / 2);
    c.moveTo(x + w / 2, y + hp);
    c.lineTo(x + w / 2, y + h - hp);
    if (hp > 0) {
      c.moveTo(x, y);
      c.lineTo(x + w / 2, y + hp);
      c.lineTo(x + w, y);
      c.moveTo(x, y + h);
      c.lineTo(x + w / 2, y + h - hp);
      c.lineTo(x + w, y + h);
    }
  }
  c.rect(x, y, w, h);
  c.stroke();
}

/** Мелкое на крыше (труба, выход, кондиционер): квадратик с короткой тенью — в проходе крыш, поверх неё. */
function roofBit(a: Art, x: number, y: number, w: number, h: number, z: number, color: string): void {
  if (a.pass !== 2 || !a.d) return;
  const c = a.c;
  c.fillStyle = 'rgba(30,30,25,0.22)';
  c.fillRect(x + a.sx * z, y + a.sy * z, w, h);
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
  c.strokeStyle = tone(color, -0.35);
  c.lineWidth = 0.2;
  c.strokeRect(x, y, w, h);
}

/** Плоская крыша с парапетом (светлая кромка к свету) и выходами на крышу через шаг bay. */
function flat(a: Art, x: number, y: number, w: number, h: number, z: number, color: string, bay = 0): void {
  if (a.pass === 1) return a.rectShadow(x, y, w, h, z);
  if (a.pass !== 2) return;
  const c = a.c;
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
  if (!a.lod) return;
  if (a.d) {
    const lit = tone(color, 0.2);
    const dim = tone(color, -0.18);
    const e = 0.55;
    c.fillStyle = a.ly < 0 ? lit : dim;
    c.fillRect(x, y, w, e);
    c.fillStyle = a.ly < 0 ? dim : lit;
    c.fillRect(x, y + h - e, w, e);
    c.fillStyle = a.lx < 0 ? lit : dim;
    c.fillRect(x, y, e, h);
    c.fillStyle = a.lx < 0 ? dim : lit;
    c.fillRect(x + w - e, y, e, h);
    if (bay > 0) {
      // Подъезды: тонкие швы между секциями и над каждой — выход на крышу.
      const along = w >= h;
      const L = along ? w : h;
      const n = Math.max(1, Math.round(L / bay));
      const step = L / n;
      c.strokeStyle = tone(color, -0.12);
      c.lineWidth = 0.25;
      c.beginPath();
      for (let k = 1; k < n; k++) {
        if (along) (c.moveTo(x + k * step, y + 0.6), c.lineTo(x + k * step, y + h - 0.6));
        else (c.moveTo(x + 0.6, y + k * step), c.lineTo(x + w - 0.6, y + k * step));
      }
      c.stroke();
      const bit = tone(color, 0.12);
      for (let k = 0; k < n; k++) {
        const m = (k + 0.5) * step;
        if (along) roofBit(a, x + m - 1.3, y + h / 2 - 1.3, 2.6, 2.6, 1.6, bit);
        else roofBit(a, x + w / 2 - 1.3, y + m - 1.3, 2.6, 2.6, 1.6, bit);
      }
    }
  }
  c.strokeStyle = tone(color, -0.4);
  c.lineWidth = 0.4;
  c.strokeRect(x, y, w, h);
}

/** Забор участка с калиткой на улицу (у gate по x): деревянный, живая изгородь или профлист. */
function fence(a: Art, lot: Lot, kind: number, gate: number): void {
  if (a.pass !== 0 || !a.lod) return;
  const c = a.c;
  const x0 = -lot.W / 2 + 0.4;
  const y0 = -lot.H / 2 + 0.4;
  const x1 = lot.W / 2 - 0.4;
  const y1 = lot.H / 2 - 0.4;
  if (kind < 0.45) {
    c.strokeStyle = WOOD;
    c.lineWidth = lot.fine ? 0.3 : 0.4;
    if (lot.fine) c.setLineDash([0.35, 0.3]);
  } else if (kind < 0.72) {
    c.strokeStyle = HEDGE;
    c.lineWidth = 1.1;
  } else {
    c.strokeStyle = ['#6f8796', '#8a6a52', '#6c8a64'][Math.floor(kind * 30) % 3];
    c.lineWidth = 0.45;
  }
  c.beginPath();
  c.moveTo(gate - 1.4, y0);
  c.lineTo(x0, y0);
  c.lineTo(x0, y1);
  c.lineTo(x1, y1);
  c.lineTo(x1, y0);
  c.lineTo(gate + 1.4, y0);
  c.stroke();
  c.setLineDash([]);
}

/** Грядки огорода: земля и ряды всходов поперёк. */
function beds(a: Art, x: number, y: number, w: number, h: number, vertical: boolean): void {
  if (w < 2 || h < 2) return;
  a.patch(x, y, w, h, BEDS, 0.6);
  a.rows(x, y, w, h, 1.3, SPROUTS, vertical, 0.45);
}

/** Теплица: светлое стекло с рёбрами. */
function greenhouse(a: Art, x: number, y: number, w: number, h: number): void {
  if (a.pass === 1 && a.lod) return a.rectShadow(x, y, w, h, 2.2);
  if (a.pass !== 2 || !a.lod) return;
  const c = a.c;
  c.fillStyle = GLASS;
  c.fillRect(x, y, w, h);
  c.strokeStyle = '#9fb6bf';
  c.lineWidth = 0.25;
  c.strokeRect(x, y, w, h);
  if (!a.d) return;
  c.beginPath();
  const along = w >= h;
  if (along) for (let xx = x + 1; xx < x + w; xx += 1) (c.moveTo(xx, y), c.lineTo(xx, y + h));
  else for (let yy = y + 1; yy < y + h; yy += 1) (c.moveTo(x, yy), c.lineTo(x + w, yy));
  c.stroke();
}

/** Дерево во дворе — только не издали. */
function yardTree(a: Art, lot: Lot, x: number, y: number, r: number, i: number): void {
  if (!a.lod) return;
  a.tree(x, y, r, lot.trees[Math.floor(a.r(i) * lot.trees.length)]);
}

/** Машина у дома — только совсем вблизи. */
function car(a: Art, lot: Lot, x: number, y: number, vertical: boolean, i: number): void {
  if (!lot.fine) return;
  a.vehicle(x, y, vertical ? 1.9 : 4.4, vertical ? 4.4 : 1.9, CAR_COLORS[Math.floor(a.r(i) * CAR_COLORS.length)]);
}

/** Стоянка: асфальт, разметка мест поперёк и машины (часть мест пустая). */
function parking(a: Art, lot: Lot, x: number, y: number, w: number, h: number, i: number): void {
  a.patch(x, y, w, h, ASPHALT, 0.5);
  const along = w >= h;
  const L = along ? w : h;
  const n = Math.floor(L / 2.7);
  if (n < 1) return;
  if (a.pass === 0 && a.d) {
    const c = a.c;
    c.strokeStyle = 'rgba(245,245,240,0.7)';
    c.lineWidth = 0.15;
    c.beginPath();
    for (let k = 1; k < n; k++) {
      const m = (L / n) * k;
      if (along) (c.moveTo(x + m, y + 0.3), c.lineTo(x + m, y + Math.min(h, 5) - 0.3));
      else (c.moveTo(x + 0.3, y + m), c.lineTo(x + Math.min(w, 5) - 0.3, y + m));
    }
    c.stroke();
  }
  for (let k = 0; k < n; k++) {
    if (a.r(i + k) < 0.45) continue;
    const m = (L / n) * (k + 0.5);
    if (along) car(a, lot, x + m, y + Math.min(h, 5) / 2, true, i + k + 50);
    else car(a, lot, x + Math.min(w, 5) / 2, y + m, false, i + k + 50);
  }
}

/** Детская площадка: песок, резиновое покрытие, горка и качели. */
function playground(a: Art, lot: Lot, x: number, y: number, s: number): void {
  if (!a.lod) return;
  a.patch(x, y, s, s, SAND, 0.8);
  a.patch(x + s * 0.5, y + s * 0.15, s * 0.4, s * 0.4, 'rgba(204,96,78,0.6)', 0.5);
  if (!lot.fine || a.pass !== 2) return;
  const c = a.c;
  c.fillStyle = '#e04f3c';
  c.fillRect(x + s * 0.15, y + s * 0.55, s * 0.18, s * 0.32);
  c.strokeStyle = '#4c5966';
  c.lineWidth = 0.25;
  c.beginPath();
  c.moveTo(x + s * 0.55, y + s * 0.2);
  c.lineTo(x + s * 0.85, y + s * 0.2);
  c.moveTo(x + s * 0.55, y + s * 0.5);
  c.lineTo(x + s * 0.85, y + s * 0.5);
  c.stroke();
  c.fillStyle = '#3f74b5';
  disc(c, x + s * 0.7, y + s * 0.75, s * 0.08);
}

/** Ряд деревьев вдоль линии (x0, y) → (x1, y), шаг step. */
function treeRow(a: Art, lot: Lot, x0: number, x1: number, y: number, step: number, r: number, i: number): void {
  for (let x = x0 + step / 2, k = 0; x < x1; x += step, k++) yardTree(a, lot, x, y + (a.r(i + k) - 0.5), r * (0.85 + 0.3 * a.r(i + k + 20)), i + k + 40);
}

/** Пятно газона на весь участок. */
const lawn = (a: Art, lot: Lot, color = LAWN) => a.patch(-lot.W / 2 + 0.3, -lot.H / 2 + 0.3, lot.W - 0.6, lot.H - 0.6, color, 0.8);

// ---------- Жилые ----------

/** Частный дом с участком: дом у улицы, за ним огород, сарай, теплица, плодовые деревья; забор с калиткой. */
function cottage(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  lawn(a, lot);
  const two = b.floors >= 2;
  const hw = clamp(W * (0.4 + 0.12 * a.r(1)), 6.5, 12) + (two ? 1 : 0);
  const hd = clamp(H * (0.36 + 0.1 * a.r(2)), 6, 9.5) + (two ? 0.8 : 0);
  const left = a.r(4) < 0.5;
  const hx = left ? x0 + 1.6 + a.r(5) * 1.5 : -x0 - 1.6 - hw - a.r(5) * 1.5;
  const hy = y0 + 2.4 + a.r(3) * 1.8;
  const back = hy + hd + 1.5;
  const yEnd = H / 2 - 1.2;
  // Огород — в глубине, со стороны дома или напротив; сарай — в другом углу.
  if (yEnd - back > 3) {
    const gw = W * (0.45 + 0.2 * a.r(6));
    const gx = a.r(7) < 0.5 ? x0 + 1.4 : -x0 - 1.4 - gw;
    beds(a, gx, back + 0.6, gw, yEnd - back - 0.6, a.r(8) < 0.5);
    const sx = gx < 0 && gx + gw / 2 < 0 ? -x0 - 1.4 - 3.6 : x0 + 1.4;
    pitched(a, sx, yEnd - 3.2, 3.6, 3, 2.3, a.r(9) < 0.5 ? '#8d7a66' : '#7f8890', true, 0, a.r(9) >= 0.5);
    if (a.r(10) < 0.4 && W > 14) greenhouse(a, gx + gw / 2 - 1.25, back + 0.9, 2.5, Math.min(5, yEnd - back - 1.5));
    yardTree(a, lot, sx + (sx < 0 ? 6 : -2.5), yEnd - 1.5 - a.r(11) * 2, 2.3 + a.r(12), 13);
  }
  if (a.r(14) < 0.6) yardTree(a, lot, left ? -x0 - 3 : x0 + 3, hy + hd * 0.6, 2 + a.r(15) * 1.2, 16);
  // Дорожка от калитки к крыльцу.
  const gate = hx + hw / 2;
  if (a.d) a.patch(gate - 0.6, y0, 1.2, hy - y0 + 0.5, GRAVEL);
  if (a.r(17) < 0.35) car(a, lot, left ? hx + hw + 2.5 : hx - 2.5, hy + 2.6, true, 18);
  fence(a, lot, a.r(19), gate);
  const metal = a.r(20) < 0.25;
  const roof = metal ? METAL_ROOFS[Math.floor(a.r(21) * METAL_ROOFS.length)] : b.roof;
  const z = wallZ(b.floors);
  const square = Math.abs(hw - hd) < 1.6;
  const hip = square && a.r(22) < 0.6 ? Math.min(hw, hd) / 2 : a.r(23) < 0.3 ? Math.min(hw, hd) * 0.35 : 0;
  const along = a.r(24) < 0.65 ? hw >= hd : hw < hd;
  pitched(a, hx, hy, hw, hd, z, roof, along, hip, metal);
  // Печная труба.
  roofBit(a, hx + hw * (0.25 + 0.5 * a.r(25)), hy + hd * 0.3, 0.9, 0.9, 1.2, '#8a5a48');
}

/** Дача: маленький домик, весь участок в грядках, теплица, яблони. */
function dacha(a: Art, lot: Lot): void {
  const { W, H } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  lawn(a, lot, LAWN_DACHA);
  const left = a.r(1) < 0.5;
  const hw = 4.5 + a.r(2) * 1.5;
  const hd = 4 + a.r(3) * 1.5;
  const hx = left ? x0 + 1.8 : -x0 - 1.8 - hw;
  const hy = y0 + 2 + a.r(4) * 2;
  // Грядки — полосой с другой стороны и в глубине.
  const bx = left ? hx + hw + 1.6 : x0 + 1.5;
  const bw = W - hw - 4.8;
  beds(a, bx, y0 + 2, bw, H * 0.5, true);
  beds(a, x0 + 1.5, hy + hd + 1.5, W - 3, H / 2 - hy - hd - 3, false);
  greenhouse(a, left ? -x0 - 4.2 : x0 + 1.7, H / 2 - 7, 2.5, 5);
  for (let k = 0; k < 3; k++) yardTree(a, lot, x0 + W * (0.25 + 0.25 * k), H / 2 - 2.2 - a.r(5 + k) * 3, 1.6 + a.r(8 + k) * 0.8, 11 + k);
  fence(a, lot, 0.1 + a.r(14) * 0.3, hx + hw / 2);
  const roof = a.r(15) < 0.5 ? METAL_ROOFS[Math.floor(a.r(16) * METAL_ROOFS.length)] : lot.b.roof;
  pitched(a, hx, hy, hw, hd, 3.2, roof, hw >= hd, a.r(17) < 0.5 ? Math.min(hw, hd) / 2 : 0, true);
}

/** Дом старого центра: вплотную к тротуару во всю ширину участка, за ним — мощёный двор с флигелем и деревом. */
function townhouse(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  a.patch(x0 + 0.4, y0 + 0.4, W - 0.8, H - 0.8, PAVING, 0.5);
  const d = clamp(H * 0.48, 7.5, 11.5) + b.floors * 0.4;
  const w = W - 0.8;
  const z = wallZ(b.floors);
  const back = y0 + 0.5 + d;
  const rest = H / 2 - back - 0.6;
  if (rest > 4) {
    const fw = clamp(W * 0.35, 4.5, 8);
    const left = a.r(1) < 0.5;
    const fx = left ? x0 + 0.6 : -x0 - 0.6 - fw;
    const fd = Math.min(rest - 0.6, 5 + a.r(2) * 2);
    pitched(a, fx, H / 2 - 0.6 - fd, fw, fd, wallZ(1), tone(b.roof, -0.08), fw < fd);
    yardTree(a, lot, left ? -x0 - 3.2 : x0 + 3.2, back + rest * 0.55, 2.2 + a.r(3), 4);
  }
  if (b.floors >= 3 && a.r(5) < 0.3) flat(a, x0 + 0.4, y0 + 0.5, w, d, z, tone(b.roof, 0.18));
  else pitched(a, x0 + 0.4, y0 + 0.5, w, d, z, b.roof, true, a.r(6) < 0.4 ? d * 0.45 : 0);
  if (a.d) for (let k = 0; k < (W > 18 ? 2 : 1); k++) roofBit(a, x0 + W * (0.25 + 0.5 * k) - 0.45, y0 + 0.5 + d * 0.28, 0.9, 0.9, 1.2, '#8a5a48');
}

/** Квартал старого центра: дома по периметру участка (П или замкнутый «колодец»), во дворе — мощение и деревья. */
function courtyard(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2 + 0.4;
  const y0 = -H / 2 + 0.5;
  const x1 = W / 2 - 0.4;
  const y1 = H / 2 - 0.5;
  const d = clamp(Math.min(W, H) * 0.3, 7, 10);
  const closed = H >= 22 && a.r(1) < 0.55;
  const ell = !closed && a.r(2) < 0.25;
  const roofFlat = a.r(3) < 0.35;
  const z = wallZ(b.floors);
  a.patch(x0, y0, x1 - x0, y1 - y0, PAVING, 0.5);
  // Двор: дерево, клумба, у большого — площадка.
  const cx = (x0 + x1) / 2;
  const cy = (y0 + d + (closed ? y1 - d : y1)) / 2;
  if (a.d) a.patch(cx - 2.2, cy - 1.6, 4.4, 3.2, LAWN_DACHA, 1.2);
  yardTree(a, lot, cx + (a.r(4) - 0.5) * 3, cy, 2.3 + a.r(5) * 0.8, 6);
  const roof = b.roof;
  const wing = (x: number, y: number, w: number, h: number) => {
    if (roofFlat) flat(a, x, y, w, h, z, tone(roof, 0.15));
    else pitched(a, x, y, w, h, z, roof, w >= h, 0);
  };
  const sideH = (closed ? y1 - d : y1) - (y0 + d);
  // Боковые крылья — первыми: лицевое и заднее ложатся поверх углов.
  if (sideH > 1) {
    if (!ell || a.r(7) < 0.5) wing(x0, y0 + d, d, sideH);
    if (!ell || a.r(7) >= 0.5) wing(x1 - d, y0 + d, d, sideH);
  }
  if (closed) wing(x0, y1 - d, x1 - x0, d);
  wing(x0, y0, x1 - x0, d);
  if (!roofFlat && a.d) {
    for (let k = 0; k < Math.floor((x1 - x0) / 9); k++) roofBit(a, x0 + 4 + k * 9, y0 + d * 0.25, 0.9, 0.9, 1.2, '#8a5a48');
  }
}

/** Панельный дом: длинный корпус с плоской крышей и подъездами вдоль улицы, за ним двор — площадка, стоянка, деревья. */
function slab(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const f = b.floors;
  const z = wallZ(f);
  const D = f >= 9 ? 13 : f >= 5 ? 12 : 10.5;
  lawn(a, lot);
  if (W >= H * 0.8 || H < 30) {
    // Вдоль улицы: корпус у тротуара, двор — за ним.
    const set = clamp(H - D - 4, 1, 4);
    const bd = Math.min(D, H - set - 1);
    const by = y0 + set;
    const L = W - 3;
    const yard = by + bd + 1.5;
    const depth = H / 2 - 1 - yard;
    if (depth > 5) {
      const pw = Math.min(W * 0.35, 22);
      const left = a.r(1) < 0.5;
      parking(a, lot, left ? x0 + 1.5 : -x0 - 1.5 - pw, yard + depth - Math.min(depth, 5.5), pw, Math.min(depth, 5.5), 2);
      const s = Math.min(depth - 1, 9);
      if (s >= 4) playground(a, lot, left ? -x0 - 2 - s : x0 + 2, yard + 0.5, s);
      treeRow(a, lot, x0 + (left ? pw + 2 : 1), -x0 - (left ? 1 : pw + 2), H / 2 - 2.6, 7, 2.4, 30);
    }
    // Г-образный: второй корпус вдоль боковой границы.
    if (H >= 34 && W >= 50 && a.r(3) < 0.35) {
      const right = a.r(4) < 0.5;
      const len = H - set - bd - 3;
      flat(a, right ? -x0 - 1.5 - bd : x0 + 1.5, by + bd, bd, len, z, b.roof, 15);
    }
    flat(a, x0 + 1.5, by, L, bd, z, b.roof, 15);
    if (a.d && a.pass === 0) for (let k = 0; k < Math.max(1, Math.round(L / 15)); k++) a.patch(x0 + 1.5 + (L / Math.max(1, Math.round(L / 15))) * (k + 0.5) - 0.8, by - Math.min(set, 2.5), 1.6, Math.min(set, 2.5), PAVING);
  } else {
    // Узкий глубокий участок: корпус торцом к улице, двор сбоку.
    const left = a.r(1) < 0.5;
    const bw = Math.min(D, W - 6);
    const bx = left ? x0 + 1.5 : -x0 - 1.5 - bw;
    const yardX = left ? bx + bw + 1.5 : x0 + 1.5;
    const yw = W - bw - 4.5;
    if (yw > 4) {
      parking(a, lot, yardX, y0 + 2, yw, Math.min(H * 0.35, 14), 2);
      const s = Math.min(yw - 1, 9);
      if (s >= 4) playground(a, lot, yardX + (yw - s) / 2, y0 + H * 0.5, s);
      yardTree(a, lot, yardX + yw / 2, H / 2 - 3, 2.6, 21);
    }
    flat(a, bx, y0 + 2.5, bw, H - 5, z, b.roof, 15);
  }
}

/** Высотка: башня в глубине участка, перед ней — стоянка, вокруг — деревья. */
function tower(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const z = wallZ(b.floors);
  lawn(a, lot);
  // Башня крестом: квадрат с выступами-крыльями, у узкого участка — во всю его глубину.
  const left = a.r(1) < 0.5;
  let T: number;
  let tx: number;
  let ty: number;
  if (H >= 40 && W >= 40) {
    // Участок квартала от улицы до улицы: башня посреди общего двора, стоянки — у обеих улиц, площадка и деревья — во дворе.
    T = clamp(Math.min(W, H) * 0.42, 20, 28);
    tx = (left ? -1 : 1) * Math.min(W / 2 - T / 2 - 4, W * 0.18);
    ty = -T / 2;
    const pw = Math.min(W * 0.45, 30);
    parking(a, lot, left ? -x0 - 2 - pw : x0 + 2, y0 + 1.5, pw, 5.5, 3);
    parking(a, lot, left ? x0 + 2 : -x0 - 2 - pw, H / 2 - 7, pw, 5.5, 60);
    const s = Math.min(10, W / 2 - T / 2 - 6);
    if (s >= 5) playground(a, lot, left ? tx + T / 2 + 3 : tx - T / 2 - 3 - s, -s / 2, s);
    treeRow(a, lot, x0 + 1, -x0 - 1, y0 + 9.5, 7, 2.2, 40);
    treeRow(a, lot, x0 + 1, -x0 - 1, H / 2 - 9.5, 7, 2.2, 80);
  } else {
    T = clamp(Math.min(W, H) - 3, 16, 24);
    tx = left ? x0 + 2 + T / 2 + 2 : -x0 - 2 - T / 2 - 2;
    ty = clamp(H / 2 - 1.5 - T, y0 + 1.5, y0 + 6);
    const rest = W - T - 8;
    if (rest > 6) {
      const px = left ? tx + T / 2 + 3 : x0 + 2;
      parking(a, lot, px, y0 + 1.5, rest, Math.min(5.5, H - 3), 3);
      if (H > 14 && rest > 12) playground(a, lot, px + rest / 2 - 4, y0 + 8, Math.min(8, H - 10));
      treeRow(a, lot, px, px + rest, H / 2 - 2, 6.5, 2.2, 40);
    }
  }
  const roof = tone(b.roof, 0.18);
  const k = T * 0.22;
  flat(a, tx - T / 2, ty + k, T, T - 2 * k, z, roof);
  flat(a, tx - T / 2 + k, ty, T - 2 * k, T, z, roof);
  // Машинное отделение лифтов и антенна.
  flat(a, tx - 3, ty + T / 2 - 2.2, 6, 4.4, z + 3, tone(roof, 0.1));
  roofBit(a, tx + T / 2 - k - 2, ty + 1.5, 1.2, 1.2, 2.5, '#c0c4c8');
}

// ---------- Общественные и деловые ----------

/** Магазин: здание у тротуара с цветным козырьком, сбоку стоянка покупателей. */
function shop(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const big = b.floors >= 4;
  const left = a.r(1) < 0.5;
  const w = big ? W - 3 : clamp(W * 0.62, 9, 20);
  const d = big ? H - 4 : clamp(H * 0.6, 8, 14);
  const bx = left ? x0 + 1.5 : -x0 - 1.5 - w;
  const by = y0 + 2.2;
  lawn(a, lot);
  a.patch(x0 + 0.4, y0 + 0.4, W - 0.8, Math.min(H - 0.8, d + 3.4), PAVING, 0.5);
  if (H - d > 9) yardTree(a, lot, left ? x0 + 3 : -x0 - 3, H / 2 - 2.6, 2.2, 9);
  if (!big && W - w > 7) parking(a, lot, left ? bx + w + 1 : x0 + 1, y0 + 1.2, W - w - 3.5, Math.min(H - 2.4, 11), 4);
  else if (H - d > 6) parking(a, lot, x0 + 1.5, by + d + 0.8, W - 3, H / 2 - by - d - 1.6, 4);
  const z = wallZ(b.floors);
  flat(a, bx, by, w, d, z, tone(b.roof, 0.25));
  // Козырёк над входом — цветом вывески.
  if (a.pass === 2 && a.lod) {
    a.c.fillStyle = AWNINGS[Math.floor(a.r(5) * AWNINGS.length)];
    a.c.fillRect(bx + 0.6, by - 1, w - 1.2, 1.4);
  }
  roofBit(a, bx + w * 0.3, by + d * 0.5, 1.6, 1.2, 1, '#b4b9be');
  roofBit(a, bx + w * 0.62, by + d * 0.4, 1.6, 1.2, 1, '#b4b9be');
}

/** Сельский магазин или клуб: дом под скатной крышей с вывеской и крыльцом, перед ним — утоптанная площадка, скамейка. */
function store(a: Art, lot: Lot): void {
  const { W, H } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  lawn(a, lot);
  const w = clamp(W * 0.55, 8, 13);
  const d = clamp(H * 0.45, 6.5, 10);
  const bx = (a.r(1) - 0.5) * (W - w - 3);
  const by = y0 + 3.2;
  a.patch(x0 + 0.5, y0 + 0.4, W - 1, 3.6, GRAVEL, 0.5);
  if (H - d > 9) {
    yardTree(a, lot, bx < 0 ? -x0 - 3 : x0 + 3, by + d + 2.5, 2.4 + a.r(2), 3);
    pitched(a, bx < 0 ? x0 + 1.5 : -x0 - 5.5, H / 2 - 4.5, 4, 3.2, 2.3, '#8d7a66', true);
  }
  const roof = a.r(4) < 0.5 ? METAL_ROOFS[Math.floor(a.r(5) * METAL_ROOFS.length)] : '#8c6a52';
  pitched(a, bx, by, w, d, wallZ(1), roof, w >= d, 0, a.r(4) < 0.5);
  if (a.pass === 2 && a.lod) {
    const c = a.c;
    // Вывеска над крыльцом.
    c.fillStyle = AWNINGS[Math.floor(a.r(6) * AWNINGS.length)];
    c.fillRect(bx + w / 2 - 2.2, by - 0.9, 4.4, 0.9);
    if (lot.fine) {
      c.fillStyle = WOOD;
      c.fillRect(bx + w + 0.8, by - 2.2, 2.4, 0.6);
    }
  }
}

/** Контора: здание почти во весь участок, верхние этажи уступом, на крыше — фонарь и вентиляция. */
function office(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  a.patch(x0 + 0.4, y0 + 0.4, W - 0.8, H - 0.8, PAVING, 0.5);
  const z = wallZ(b.floors);
  const glass = a.r(1) < 0.3;
  const roof = glass ? '#9fb4c4' : tone(b.roof, 0.1);
  const w = W - 2.4;
  const d = H - 3.4;
  if (b.floors >= 3 && a.r(2) < 0.6) {
    flat(a, x0 + 1.2, y0 + 1.2, w, d, z * 0.65, tone(roof, 0.12));
    flat(a, x0 + 1.2 + w * 0.12, y0 + 1.2 + d * 0.1, w * 0.76, d * 0.62, z, roof);
  } else flat(a, x0 + 1.2, y0 + 1.2, w, d, z, roof);
  if (a.pass === 2 && a.d) {
    a.c.fillStyle = 'rgba(176,214,232,0.85)';
    a.c.fillRect(x0 + 1.2 + w * 0.3, y0 + 1.2 + d * 0.3, w * 0.4, 1.4);
  }
  roofBit(a, x0 + w * 0.7, y0 + d * 0.55, 2, 1.6, 1.2, '#b4b9be');
  if (H > 22) yardTree(a, lot, x0 + 3, H / 2 - 2.5, 2.2, 7);
}

/** Рынок: ряды цветных навесов на мощёной площадке и крытый павильон в глубине. */
function market(a: Art, lot: Lot): void {
  const { W, H } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  a.patch(x0 + 0.3, y0 + 0.3, W - 0.6, H - 0.6, PAVING, 0.5);
  const hd = clamp(H * 0.34, 6, 10);
  pitched(a, x0 + 1.5, H / 2 - 1.2 - hd, W - 3, hd, 4.5, '#8fa3ad', true, 0, true);
  const rows = Math.max(1, Math.floor((H - hd - 4) / 5));
  for (let r = 0; r < rows; r++) {
    const y = y0 + 1.8 + r * 5;
    const n = Math.floor((W - 3) / 3.2);
    for (let k = 0; k < n; k++) {
      const color = STALLS[Math.floor(a.r(r * 31 + k) * STALLS.length)];
      pitched(a, x0 + 1.5 + k * 3.2, y, 2.9, 2.6, 1.8, color, false, 0);
    }
  }
}

/** Школа: П-образное здание у улицы, за ним — стадион с беговой дорожкой; вдоль забора — деревья. */
function school(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  lawn(a, lot);
  const d = clamp(H * 0.26, 6, 8.5);
  const by = y0 + 2;
  const wingL = clamp(H * 0.42, 7, 14);
  // Стадион за зданием между крыльями — или во всю ширину, если крыльям не хватает места.
  const fy = by + d + 1.5;
  const fh = H / 2 - 1.5 - fy;
  if (fh > 5) {
    const fx = x0 + 1.5 + d + 1;
    const fw = W - 2 * (1.5 + d + 1);
    const full = fw < 10;
    const tx = full ? x0 + 1.5 : fx;
    const tw = full ? W - 3 : fw;
    const ty = full ? by + d + wingL - d + 1 : fy;
    const th = H / 2 - 1.5 - ty;
    if (th > 4 && a.lod) {
      a.patch(tx, ty, tw, th, TRACK, Math.min(th, tw) * 0.45);
      a.patch(tx + 1.4, ty + 1.4, tw - 2.8, th - 2.8, FIELD, Math.min(th, tw) * 0.3);
      if (a.d && a.pass === 0) {
        const c = a.c;
        c.strokeStyle = 'rgba(255,255,255,0.8)';
        c.lineWidth = 0.18;
        c.strokeRect(tx + 2.4, ty + 2.4, tw - 4.8, th - 4.8);
        c.beginPath();
        c.moveTo(tx + tw / 2, ty + 2.4);
        c.lineTo(tx + tw / 2, ty + th - 2.4);
        c.stroke();
      }
    }
  }
  const z = wallZ(Math.min(b.floors, 4));
  const roof = '#c9b79a';
  flat(a, x0 + 1.5, by + d, d, wingL - d, z, roof);
  flat(a, -x0 - 1.5 - d, by + d, d, wingL - d, z, roof);
  flat(a, x0 + 1.5, by, W - 3, d, z, roof);
  if (a.pass === 2 && a.lod) {
    // Крыльцо и флаг у входа.
    a.c.fillStyle = '#b25a45';
    a.c.fillRect(-1.6, by - 1.1, 3.2, 1.1);
  }
  treeRow(a, lot, x0, -x0, y0 + 0.9, 6, 1.5, 70);
}

/** Больница: корпус буквой «Н» с красным крестом на крыше, вокруг — сквер. */
function hospital(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  lawn(a, lot);
  const z = wallZ(b.floors);
  const roof = '#eceeea';
  const t = clamp(Math.min(W, H) * 0.24, 5.5, 8);
  const L = H - 4;
  flat(a, x0 + 2, y0 + 2, t, L, z, roof);
  flat(a, -x0 - 2 - t, y0 + 2, t, L, z, roof);
  flat(a, x0 + 2 + t, -t / 2, W - 4 - 2 * t, t, z * 0.85, roof);
  if (a.pass === 2 && a.lod) {
    const c = a.c;
    c.fillStyle = '#d64541';
    const s = t * 0.42;
    c.fillRect(-s / 2, -s * 0.16, s, s * 0.32);
    c.fillRect(-s * 0.16, -s / 2, s * 0.32, s);
  }
  yardTree(a, lot, 0, y0 + 3.5, 2.4, 3);
  yardTree(a, lot, 0, H / 2 - 3, 2.6, 4);
  if (lot.fine) a.vehicle(x0 + 2 + t + 3.2, y0 + 3.4, 5, 2.1, '#f4f4f0');
}

/** Храм: неф поперёк улицы, апсида в глубине, колокольня у входа, луковичная глава; вокруг — ограда и деревья. */
function church(a: Art, lot: Lot, scale = 1): void {
  const { W, H } = lot;
  const y0 = -H / 2;
  lawn(a, lot);
  const w = clamp(W * 0.36, 7, 12) * scale;
  const L = clamp(H * 0.55, 11, 22) * scale;
  const ny = y0 + 3 + 4.5 * scale;
  const blue = a.r(1) < 0.4;
  const dome = blue ? '#4d78b8' : DOME_GOLD;
  const roof = a.r(2) < 0.5 ? '#6f9a7a' : '#8a9aa6';
  if (a.d) a.patch(-0.7, y0, 1.4, ny - y0, GRAVEL);
  for (let k = 0; k < 4; k++) yardTree(a, lot, (k % 2 ? 1 : -1) * (w / 2 + 3 + a.r(3 + k) * 2), y0 + H * (0.3 + 0.35 * (k >> 1)), 2 + a.r(7 + k), 11 + k);
  fence(a, lot, 0.8, 0);
  // Апсида — полукруг у восточного торца (в глубине участка).
  const c = a.c;
  if (a.pass === 1 && a.lod) a.capsule(0, ny + L, w * 0.38, 7);
  if (a.pass === 2) {
    c.fillStyle = slope(a, roof, 0, 1);
    c.beginPath();
    c.arc(0, ny + L, w * 0.38, 0, Math.PI);
    c.fill();
  }
  pitched(a, -w / 2, ny, w, L, 7, roof, false, 0);
  // Колокольня у входа: шатёр.
  const t = 4.2 * scale;
  pitched(a, -t / 2, ny - t + 0.4, t, t, 16, roof, true, t / 2);
  if (a.pass === 1 && a.lod) a.capsule(0, ny + L * 0.45, w * 0.3, 14);
  if (a.pass === 2) {
    const r = w * 0.3;
    c.fillStyle = tone(dome, -0.15);
    disc(c, 0, ny + L * 0.45, r);
    if (a.lod) {
      c.fillStyle = tone(dome, 0.3);
      disc(c, a.lx * r * 0.35, ny + L * 0.45 + a.ly * r * 0.35, r * 0.45);
    }
    c.fillStyle = DOME_GOLD;
    disc(c, 0, ny - t / 2 + 0.4, 0.9 * scale);
    if (lot.fine) {
      c.strokeStyle = '#8a6a20';
      c.lineWidth = 0.25;
      c.beginPath();
      c.moveTo(-0.9, ny + L * 0.45);
      c.lineTo(0.9, ny + L * 0.45);
      c.moveTo(0, ny + L * 0.45 - 1.3);
      c.lineTo(0, ny + L * 0.45 + 1.3);
      c.stroke();
    }
  }
}

/** Гаражи: ряды боксов с разноцветными крышами вдоль проезда. */
function garages(a: Art, lot: Lot): void {
  const { W, H } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  a.patch(x0 + 0.3, y0 + 0.3, W - 0.6, H - 0.6, ASPHALT, 0.5);
  const n = Math.floor((W - 2) / 3.2);
  const rowsAt = H >= 18 ? [y0 + 1, H / 2 - 7] : [H / 2 - 7];
  for (const [r, y] of rowsAt.entries()) {
    if (!a.lod) {
      flat(a, x0 + 1, y, n * 3.2, 6, 2.6, '#8b8f94');
      continue;
    }
    for (let k = 0; k < n; k++) {
      const t = a.r(r * 50 + k);
      const color = t < 0.5 ? '#8b8f94' : t < 0.7 ? '#9a6b52' : t < 0.85 ? '#6f8798' : '#7d9572';
      flat(a, x0 + 1 + k * 3.2, y, 3.2, 6, 2.6, color);
    }
  }
}

/** Склад: ангар из профлиста, у ворот — рампа, поддоны и грузовик. */
function warehouse(a: Art, lot: Lot): void {
  const { W, H } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  a.patch(x0 + 0.3, y0 + 0.3, W - 0.6, H - 0.6, 'rgba(150,148,140,0.6)', 0.5);
  const d = clamp(H * 0.62, 8, H - 5);
  const roof = a.r(1) < 0.6 ? METAL : '#a56a4b';
  pitched(a, x0 + 1.2, H / 2 - 1.2 - d, W - 2.4, d, 6, roof, true, 0, true);
  const docks = Math.floor((W - 4) / 5);
  for (let k = 0; k < docks; k++) {
    if (a.pass === 2 && a.d) {
      a.c.fillStyle = '#4a4d52';
      a.c.fillRect(x0 + 2.5 + k * 5, H / 2 - 1.2 - d - 0.8, 3, 0.8);
    }
  }
  for (let k = 0; k < 3; k++) roofBit(a, x0 + 2 + k * 2.2 + a.r(5) * 4, y0 + 1.5 + a.r(6 + k) * 2, 1.6, 1.6, 1, '#c9a46a');
  if (lot.fine && a.r(9) < 0.6) a.truck(x0 + W * 0.6, y0 + 3.2, false, '#c94f43', '#d8d8d2');
}

/** Ратуша на площади: площадь шире участка, здание с часовой башней, фонтан, деревья по углам. */
function hall(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  a.patch(x0 - 7, y0 - 7, W + 14, H + 14, PLAZA, 2, 'rgba(120,100,70,0.35)');
  if (a.d && a.pass === 0) {
    const c = a.c;
    c.strokeStyle = 'rgba(150,130,100,0.25)';
    c.lineWidth = 0.2;
    c.beginPath();
    for (let x = x0 - 4; x < -x0 + 7; x += 4) (c.moveTo(x, y0 - 6), c.lineTo(x, y0 + H * 0.35));
    c.stroke();
  }
  // Фонтан перед входом.
  if (a.lod && a.pass === 0) {
    const c = a.c;
    c.fillStyle = '#c9bea6';
    disc(c, 0, y0 + H * 0.13, 4.2);
    c.fillStyle = '#7fb6d9';
    disc(c, 0, y0 + H * 0.13, 3.4);
    if (a.d) {
      c.fillStyle = '#e8f4fa';
      disc(c, 0, y0 + H * 0.13, 0.9);
    }
  }
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) yardTree(a, lot, sx * (W / 2 + 2.5), sy * (H / 2 + 2.5), 2.6, 5 + sx + sy * 2);
  const w = W * 0.82;
  const d = H * 0.42;
  const by = y0 + H * 0.3;
  pitched(a, -w / 2, by, w, d, 12, b.roof, true, d * 0.5);
  // Боковые ризалиты.
  pitched(a, -w / 2 - 1, by - 1, w * 0.2, d + 2, 12, b.roof, false, w * 0.08);
  pitched(a, w / 2 - w * 0.2 + 1, by - 1, w * 0.2, d + 2, 12, b.roof, false, w * 0.08);
  const t = Math.min(7, W * 0.17);
  pitched(a, -t / 2, by - t * 0.6, t, t, 24, tone(b.roof, -0.1), true, t / 2);
  if (a.pass === 2) {
    a.c.fillStyle = DOME_GOLD;
    disc(a.c, 0, by - t * 0.6 + t / 2, Math.max(0.9, t * 0.12));
  }
  if (lot.fine && a.pass === 2) {
    a.c.strokeStyle = '#555';
    a.c.lineWidth = 0.2;
    a.c.beginPath();
    a.c.moveTo(w / 2 - 2, y0 - 2);
    a.c.lineTo(w / 2 - 2, y0 - 5);
    a.c.stroke();
    a.c.fillStyle = '#d64541';
    a.c.fillRect(w / 2 - 2, y0 - 5, 2.2, 1.3);
  }
}

/** Храм в центре села: церковь на зелёной площади. */
function temple(a: Art, lot: Lot): void {
  a.patch(-lot.W / 2 - 6, -lot.H / 2 - 6, lot.W + 12, lot.H + 12, PLAZA, 2, 'rgba(120,100,70,0.3)');
  church(a, lot, 1.15);
}

const SCENES: Record<HouseForm, (a: Art, lot: Lot) => void> = {
  cottage,
  dacha,
  townhouse,
  courtyard,
  slab,
  tower,
  shop,
  store,
  office,
  market,
  school,
  hospital,
  church,
  garages,
  warehouse,
  hall,
  temple,
};

/**
 * Дом города: сцена его типа в осях участка (улица — к −y), три прохода (земля, тени, крыши). trees — цвета
 * деревьев биома.
 */
export function drawHouseArt(ctx: CanvasRenderingContext2D, b: TownBuilding, zoom: number, trees: readonly string[] = TREES): void {
  const form = formOf(b);
  const angle = (b.face ?? -1) === 1 ? b.fp.angle + Math.PI : b.fp.angle;
  const fp: Footprint = { center: b.fp.center, w: b.fp.w, h: b.fp.h, angle };
  const a = new Art(ctx, { id: b.id, fp }, zoom, 0, b.id, 'still');
  const lot: Lot = { b, W: b.fp.w, H: b.fp.h, fine: zoom > FINE_ZOOM, trees };
  const scene = SCENES[form];
  ctx.save();
  ctx.translate(fp.center.x, fp.center.y);
  ctx.rotate(angle);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  for (const pass of [0, 1, 2] as const) {
    if (pass === 1 && !a.lod) continue;
    a.pass = pass;
    if (pass === 0 && !a.lod) {
      // Издали — весь участок одним цветом застройки (город читается пятном, а не россыпью точек), без мелочей двора.
      ctx.fillStyle = form === 'hall' || form === 'temple' ? PLAZA : FAR_LOT;
      ctx.fillRect(-lot.W / 2, -lot.H / 2, lot.W, lot.H);
      continue;
    }
    if (pass === 1) {
      ctx.beginPath();
      scene(a, lot);
      ctx.fillStyle = SHADOW;
      ctx.fill();
    } else scene(a, lot);
  }
  ctx.restore();
}
