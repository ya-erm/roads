import { TOWN_SCALE } from '../config';
import type { HouseForm, TownBuilding } from '../world/entities';
import type { Footprint } from '../world/spatial';
import { CAR_SIZE, cottagePlan, dachaPlan, LOT_SETBACK, type LotRect } from '../world/houseAccess';
import { marketHall, officeLot, shopLotOf, STALL_ROW_DEPTH, warehouseLot, type DockYard, type ShopLot } from '../world/shopLots';
import { formOf, LANDMARK_YARD, storeysOf } from '../world/townForms';
import { courtyardPlan, garagesPlan, slabPlan, towerPlan, townhousePlan, type YardPlan, type YardRow } from '../world/yardLots';
import { Art, disc, METAL } from './industryArt';
import { WALK_LOOK } from './sidewalks';
import { bench, flowerbed, fountain, lamp, playground as playArea, sportsBox, statue, trashPad } from './townDecor';

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
/** Совсем вблизи — машины во дворах, штакетник, качели (и машины перед гаражами — их рисует движение, renderer). */
export const FINE_ZOOM = 1.1;

const LAWN = 'rgba(128,170,88,0.2)';
const LAWN_DACHA = 'rgba(140,182,92,0.26)';
const BEDS = 'rgba(132,100,66,0.42)';
const SPROUTS = 'rgba(92,132,58,0.7)';
const PAVING = 'rgba(184,176,162,0.62)';
const GRAVEL = 'rgba(206,192,160,0.85)';
const ASPHALT = 'rgba(100,107,118,0.9)';
const PLAZA = '#e6dcc6';
/** Участок издали (lod 0): цвет застройки. */
const FAR_LOT = 'rgba(226,212,184,0.8)';
const GLASS = 'rgba(226,242,248,0.88)';
const FIELD = '#8fbf62';
const TRACK = '#c8735a';
const WOOD = '#9b7b55';
const HEDGE = '#6d9a4c';
const DOME_GOLD = '#e2b84a';
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
  /** Этажей у дома: у жилого — по жильцам (townForms.storeysOf), у прочих — этажи генерации. */
  storeys: number;
  fine: boolean;
  trees: readonly string[];
}

/**
 * Масштаб — как у дорог (полоса 7 м, легковая машина 7,5 × 3): дом занимает почти весь участок, а не его треть, машины
 * во дворах — как на улице. Участок стоит в SETBACK м от края полотна (worldgen.fillStreet): у бордюра — тротуар
 * (render/sidewalks.ts), между ним и участком — газон. Дорожки к крыльцу и съезды к стоянкам за пределами участка
 * (через газон и тротуар до полотна) рисуются не здесь, а под дорогами (houseAccess → render/townWalks.ts): их край у
 * полотна закрывает асфальт дороги, а не наоборот.
 */
const SETBACK = LOT_SETBACK;
/** Легковая у дома: длина и ширина, ед. (как машина на улице). */
const CAR = { l: CAR_SIZE.l, w: CAR_SIZE.w };
/**
 * Масштаб построек к прежнему (config.TOWN_SCALE): участки и дома крупнее во столько раз, а машины, места на стоянках,
 * скамейки и площадки — те же, в масштабе дорог.
 */
const S = TOWN_SCALE;
/** Сарай и теплица во дворе частного дома, м. */
const SHED = { w: 5.8, d: 4.6 } as const;
const GREENHOUSE = { w: 3.8, d: 7.5 } as const;
/** Съезд и стоянки — асфальт цветом дороги (lanes/draw.ts): продолжение дороги во двор. */
export const DRIVE = '#646b76';
const DRIVE_EDGE = 'rgba(70,74,82,0.6)';
/** Съезд к гравийной стоянке сельского магазина. */
const GRAVEL_DRIVE = '#cdbf9c';
/** Разметка мест на стоянке. */
const STALL_LINE = 'rgba(246,246,240,0.85)';
/** Площадка под машину у дома без гаража — бетонная плитка, светлее асфальта. */
const PAD_COLOR = '#a9a59b';
const PAD_JOINT = 'rgba(120,116,108,0.55)';

/** Выход дома к улице за пределами участка: дорожка к крыльцу или съезд — x и ширина в осях участка, сторона улицы. */
export interface HouseAccess {
  kind: 'path' | 'drive';
  x: number;
  w: number;
  /** −1 — улица со стороны −y (как у всех), 1 — у участка от улицы до улицы, с задней. */
  side: 1 | -1;
  color: string;
}

/** Куда складывать выходы к улице (houseAccess): пока не null — frontPath и curbCut записывают их сюда. */
let accessSink: HouseAccess[] | null = null;

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

/** Налёт у дома вплотную к вредному заводу (grime = 1): насколько крыша теряет цвет и насколько темнеет. */
export const GRIME_LOOK = { fade: 0.7, dark: 0.06 } as const;

/**
 * Крыша в налёте от вредных предприятий (grime 0…1, enterpriseArt.houseGrime): блёкнет к серому той же яркости и лишь
 * чуть темнеет — дом в зоне вреда серый, но не тёмный пятном. Налёт — шагами по 0.1 (кэш tone).
 */
export function grimy(hex: string, grime: number): string {
  const g = Math.round(clamp(grime, 0, 1) * 10) / 10;
  if (!g) return hex;
  const key = `${hex}|g${g}`;
  let v = tones.get(key);
  if (v === undefined) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255;
    const gr = (n >> 8) & 255;
    const b = n & 255;
    const y = 0.299 * r + 0.587 * gr + 0.114 * b;
    const s = GRIME_LOOK.fade * g;
    const d = 1 - GRIME_LOOK.dark * g;
    const f = (c: number) => Math.max(0, Math.min(255, Math.round((c + (y - c) * s) * d)));
    v = `#${((1 << 24) | (f(r) << 16) | (f(gr) << 8) | f(b)).toString(16).slice(1)}`;
    tones.set(key, v);
  }
  return v;
}

/** Налёт рисуемого сейчас дома (drawHouseArt): им тонируются его крыши — pitched и flat (мелочи на них — нет). */
let soot = 0;

/** Высота стен по этажам, м: от неё — длина тени. */
const wallZ = (floors: number) => 1 + floors * 3;

/**
 * Насколько далеко рисунок дома выходит за его контур (тень, площадь у ратуши, дорожка к крыльцу и съезд до
 * тротуара), м — для рамки в кэше карты.
 */
export function houseReach(b: Pick<TownBuilding, 'id' | 'floors' | 'kind' | 'people' | 'form' | 'fp'>): number {
  const storeys = b.kind === 'landmark' ? 8 : Math.max(1, storeysOf(b));
  return Math.max((b.kind === 'landmark' ? 9 : 2) + wallZ(storeys) * 0.6, SETBACK + 0.5);
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
  color = grimy(color, soot);
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
  color = grimy(color, soot);
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

/**
 * Забор участка с калиткой на улицу (у gate по x): деревянный, живая изгородь или профлист; ворота (gate2, шириной
 * gw) — у заезда во двор.
 */
function fence(a: Art, lot: Lot, kind: number, gate: number, gate2?: number, gw = 0): void {
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
  c.moveTo(x0, y0);
  c.lineTo(x0, y1);
  c.lineTo(x1, y1);
  c.lineTo(x1, y0);
  // Вдоль улицы — справа налево, с проёмами калитки и ворот.
  const gaps = [[gate - 1.4, gate + 1.4]];
  if (gate2 !== undefined) gaps.push([gate2 - gw / 2, gate2 + gw / 2]);
  gaps.sort((p, q) => q[0] - p[0]);
  let x = x1;
  for (const [g0, g1] of gaps) {
    if (g1 < x) c.lineTo(Math.max(g1, x0), y0);
    x = Math.max(x0, Math.min(x, g0));
    c.moveTo(x, y0);
  }
  c.lineTo(x0, y0);
  c.stroke();
  c.setLineDash([]);
}

/**
 * Дорожка к крыльцу: у x шириной w, в участке — от его края до y. Дальше, через газон до тротуара, — под дорогами
 * (houseAccess). Цветом тротуара (WALK_LOOK), непрозрачная: в участке и за ним — одно покрытие с тротуаром. Земля
 * (проход 0).
 */
function frontPath(a: Art, lot: Lot, x: number, y: number, w = 1.4): void {
  if (a.pass !== 0 || !a.lod) return;
  const color = WALK_LOOK.paved.fill;
  accessSink?.push({ kind: 'path', x, w, side: -1, color });
  const y0 = -lot.H / 2;
  if (y > y0) a.patch(x - w / 2, y0, w, y - y0, color);
}

/**
 * Съезд с улицы во двор или на стоянку: асфальт у x шириной w, в участке — от его края до y; через газон и тротуар
 * до полотна (с пониженным бордюром) — под дорогами (houseAccess). Только картинка: дорог и узлов не добавляет.
 * side — с какой стороны участка улица: −1 — как у всех (−y), 1 — у участка от улицы до улицы, с задней.
 */
function curbCut(a: Art, lot: Lot, x: number, w: number, y: number, color = DRIVE, side: 1 | -1 = -1): void {
  if (a.pass !== 0 || !a.lod) return;
  accessSink?.push({ kind: 'drive', x, w, side, color });
  const y0 = side * (lot.H / 2);
  if ((y - y0) * -side <= 0) return;
  const c = a.c;
  c.fillStyle = color;
  c.fillRect(x - w / 2, Math.min(y0, y), w, Math.abs(y - y0));
  if (!a.d) return;
  c.strokeStyle = DRIVE_EDGE;
  c.lineWidth = 0.25;
  c.beginPath();
  c.moveTo(x - w / 2, y0);
  c.lineTo(x - w / 2, y);
  c.moveTo(x + w / 2, y0);
  c.lineTo(x + w / 2, y);
  c.stroke();
}

/**
 * Выходы дома к улице за пределами участка — дорожки к крыльцу и съезды (их рисует render/townWalks.ts под дорогами).
 * Сцена дома проигрывается вхолостую (холст-заглушка), а frontPath и curbCut записывают, что нарисовали бы.
 */
export function houseAccess(b: TownBuilding): HouseAccess[] {
  const out: HouseAccess[] = [];
  const angle = (b.face ?? -1) === 1 ? b.fp.angle + Math.PI : b.fp.angle;
  const a = new Art(BLIND, { id: b.id, fp: { center: b.fp.center, w: b.fp.w, h: b.fp.h, angle } }, 1, 0, b.id, 'still');
  a.pass = 0;
  accessSink = out;
  try {
    SCENES[formOf(b)](a, { b, W: b.fp.w, H: b.fp.h, storeys: storeysOf(b), fine: false, trees: TREES });
  } finally {
    accessSink = null;
  }
  return out;
}

/** Холст, который ничего не рисует: для холостого прохода сцены (houseAccess). */
const BLIND = new Proxy({} as Record<string | symbol, unknown>, {
  get: (t, k) => (k in t ? t[k] : () => undefined),
  set: (t, k, v) => ((t[k] = v), true),
}) as unknown as CanvasRenderingContext2D;

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

/**
 * Стоянка двора или у улицы (world/yardLots.ts): асфальт и разметка мест 4,6 × 8,5 ед. (≈ 2,8 × 5,1 м) — линии между
 * местами и упор у дальнего края. Машины на местах рисует не участок, а движение (game/carHomes.ts): на месте ровно
 * те машины дома, что сейчас дома.
 */
function parking(a: Art, row: YardRow): void {
  const p = row.pad;
  a.patch(p.x, p.y, p.w, p.h, ASPHALT, 0.5);
  if (a.pass !== 0 || !a.d || !row.stalls.length) return;
  const c = a.c;
  c.strokeStyle = STALL_LINE;
  c.lineWidth = 0.16;
  c.beginPath();
  for (const s of row.stalls) {
    if (row.open === 'y-' || row.open === 'y+') {
      for (const x of [s.x, s.x + s.w]) (c.moveTo(x, s.y + 0.3), c.lineTo(x, s.y + s.h - 0.3));
      const end = row.open === 'y-' ? s.y + s.h - 0.3 : s.y + 0.3;
      (c.moveTo(s.x, end), c.lineTo(s.x + s.w, end));
    } else {
      for (const y of [s.y, s.y + s.h]) (c.moveTo(s.x + 0.3, y), c.lineTo(s.x + s.w - 0.3, y));
      const end = row.open === 'x-' ? s.x + s.w - 0.3 : s.x + 0.3;
      (c.moveTo(end, s.y), c.lineTo(end, s.y + s.h));
    }
  }
  c.stroke();
}

/** Ряд деревьев вдоль линии (x0, y) → (x1, y), шаг step. */
function treeRow(a: Art, lot: Lot, x0: number, x1: number, y: number, step: number, r: number, i: number): void {
  for (let x = x0 + step / 2, k = 0; x < x1; x += step, k++) yardTree(a, lot, x, y + (a.r(i + k) - 0.5), r * (0.85 + 0.3 * a.r(i + k + 20)), i + k + 40);
}

/**
 * Открытая площадка под машину у дома без гаража (world/houseAccess: cottagePlan, dachaPlan): бетонная плитка от
 * края участка, съезд к ней — через газон и тротуар. Машину на ней рисует движение (game/garages.ts).
 */
function carPad(a: Art, lot: Lot, p: LotRect): void {
  curbCut(a, lot, p.x + p.w / 2, p.w, p.y + p.h, PAD_COLOR);
  if (a.pass !== 0 || !a.d) return;
  const c = a.c;
  c.strokeStyle = PAD_JOINT;
  c.lineWidth = 0.1;
  c.beginPath();
  for (let y = p.y + 1.4; y < p.y + p.h - 0.3; y += 1.4) (c.moveTo(p.x, y), c.lineTo(p.x + p.w, y));
  c.moveTo(p.x + p.w / 2, p.y);
  c.lineTo(p.x + p.w / 2, p.y + p.h);
  c.stroke();
}

/** Пятно газона на весь участок. */
const lawn = (a: Art, lot: Lot, color = LAWN) => a.patch(-lot.W / 2 + 0.3, -lot.H / 2 + 0.3, lot.W - 0.6, lot.H - 0.6, color, 0.8);

// ---------- Жилые ----------

/**
 * Частный дом с участком: крупный дом у улицы почти во всю ширину участка (крыльцо — к калитке), за ним огород,
 * сарай, теплица, плодовые деревья; забор с калиткой; у 45 % домов — гараж под машину с асфальтовым заездом от
 * улицы, у 35 % — открытая площадка под машину (машину в гараж, перед воротами и на площадке рисует движение).
 * Раскладка (дом, гараж или площадка, заезд) — world/houseAccess.cottagePlan: её же видит игра.
 */
function cottage(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const plan = cottagePlan(b);
  lawn(a, lot);
  const two = lot.storeys >= 2;
  const { x: hx, y: hy, w: hw, h: hd } = plan.house;
  const left = plan.left;
  const back = Math.max(hy + hd, plan.garage ? plan.garage.y + plan.garage.h : -Infinity) + 1.2;
  const yEnd = H / 2 - 1;
  // Огород — в глубине, со стороны дома или напротив; сарай — в другом углу.
  if (yEnd - back > 2.6) {
    // Огород — у задней границы, не во весь двор: на большом участке между ним и домом — газон и плодовые деревья.
    const gw = W * (0.36 + 0.18 * a.r(6));
    const gx = a.r(7) < 0.5 ? x0 + 1.2 : -x0 - 1.2 - gw;
    const gd = Math.min(yEnd - back - 0.4, 10 + 6 * a.r(40));
    beds(a, gx, yEnd - gd, gw, gd, a.r(8) < 0.5);
    // Сад: в просторном дворе — деревья с другой стороны от огорода.
    if (yEnd - back > 12) {
      const tx0 = gx < 0 ? gx + gw + 3 : x0 + 3;
      const tx1 = gx < 0 ? -x0 - 3 : gx - 3;
      for (let k = 0; k < 3; k++) if (tx1 - tx0 > 6 && a.r(41 + k) < 0.7) yardTree(a, lot, tx0 + (tx1 - tx0) * (0.2 + 0.3 * k), back + 3 + a.r(44 + k) * (yEnd - back - 12), 2 + a.r(47 + k) * 0.9, 50 + k);
    }
    // Сарай и теплица — в масштабе дома (а не машины): на мелком участке — меньше.
    const shed = { w: Math.min(SHED.w, W * 0.2), d: Math.min(SHED.d, yEnd - back) };
    const sx = gx < 0 && gx + gw / 2 < 0 ? -x0 - 1.2 - shed.w : x0 + 1.2;
    pitched(a, sx, yEnd - shed.d - 0.2, shed.w, shed.d, 2.6, a.r(9) < 0.5 ? '#8d7a66' : '#7f8890', true, 0, a.r(9) >= 0.5);
    if (a.r(10) < 0.4 && W > 15 && yEnd - back > 4.5) greenhouse(a, gx + gw / 2 - GREENHOUSE.w / 2, back + 0.8, GREENHOUSE.w, Math.min(GREENHOUSE.d, yEnd - back - 1.4));
    yardTree(a, lot, sx + (sx < 0 ? shed.w + 2.8 : -2.8), yEnd - 1.6 - a.r(11) * 1.5, 2.3 + a.r(12), 13);
  }
  // Заезд: асфальт от улицы до ворот гаража. Машину рисует не участок, а движение (game/garages.ts): дома она в гараже
  // (ворота закрыты), выезжает из него и возвращается; у части домов вторая стоит перед воротами.
  const drive = plan.drive;
  const g = plan.garage;
  if (drive && g) {
    curbCut(a, lot, drive.x, drive.w, drive.y1 + 0.3);
    // Гараж под машину: ворота — к улице.
    const groof = a.r(27) < 0.5 ? METAL_ROOFS[Math.floor(a.r(28) * METAL_ROOFS.length)] : tone(b.roof, -0.1);
    pitched(a, g.x, g.y, g.w, g.h, 2.8, groof, false, 0, a.r(27) < 0.5);
    if (a.pass === 2 && a.lod) {
      a.c.fillStyle = '#5a5f66';
      a.c.fillRect(g.x + 0.5, g.y - 0.35, g.w - 1, 0.5);
    }
  } else {
    // Площадка под машину (у дома без гаража) — машину на ней тоже рисует движение.
    if (plan.pad) carPad(a, lot, plan.pad);
    if (a.r(14) < 0.6) yardTree(a, lot, left ? -x0 - 3 : x0 + 3, hy + hd * 0.6, 2 + a.r(15) * 1.2, 16);
  }
  // Дорожка от тротуара через калитку к крыльцу.
  const gate = hx + hw * (0.3 + 0.4 * a.r(26));
  frontPath(a, lot, gate, hy + 0.4);
  fence(a, lot, a.r(19), gate, drive ? drive.x : undefined, drive ? drive.w + 0.4 : 0);
  const metal = a.r(20) < 0.25;
  const roof = metal ? METAL_ROOFS[Math.floor(a.r(21) * METAL_ROOFS.length)] : b.roof;
  const z = wallZ(lot.storeys);
  const square = Math.abs(hw - hd) < 1.6;
  const hip = square && a.r(22) < 0.6 ? Math.min(hw, hd) / 2 : a.r(23) < 0.3 ? Math.min(hw, hd) * 0.35 : 0;
  const along = a.r(24) < 0.65 ? hw >= hd : hw < hd;
  pitched(a, hx, hy, hw, hd, z, roof, along, hip, metal);
  // Крыльцо с козырьком к калитке, печная труба, у двухэтажного — мансардные окна.
  if (a.pass === 2 && a.lod) {
    a.c.fillStyle = tone(roof, -0.2);
    a.c.fillRect(gate - 1.5, hy - 1.3, 3, 1.4);
  }
  roofBit(a, hx + hw * (0.25 + 0.5 * a.r(25)), hy + hd * 0.3, 1.3, 1.3, 1.2, '#8a5a48');
  if (two && along) for (const k of [0.3, 0.7]) roofBit(a, hx + hw * k - 1.1, hy + hd * 0.08, 2.2, 1.6, 0.5, GLASS);
}

/** Дача: домик, весь участок в грядках, теплица, яблони. */
function dacha(a: Art, lot: Lot): void {
  const { W, H } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  lawn(a, lot, LAWN_DACHA);
  // Домик — в масштабе дома (TOWN_SCALE), а не машины; у части дач рядом с ним — площадка под машину.
  const { house, left, pad } = dachaPlan(lot.b);
  const { x: hx, y: hy, w: hw, h: hd } = house;
  // Грядки — полосой с другой стороны (за площадкой) и в глубине.
  const bx = left ? hx + hw + 1.4 : x0 + 1.4;
  const bw = W - hw - 4.4;
  if (pad) {
    // Площадка — у домика, грядки — рядом с ней.
    carPad(a, lot, pad);
    const room = pad.w + 1.2;
    beds(a, left ? bx + room : bx, y0 + 2, bw - room, H * 0.5, true);
  } else beds(a, bx, y0 + 2, bw, H * 0.5, true);
  beds(a, x0 + 1.4, hy + hd + 1.4, W - 2.8, H / 2 - hy - hd - 2.6, false);
  const gw = Math.min(GREENHOUSE.w, W * 0.12);
  const gd = Math.min(GREENHOUSE.d, H * 0.24);
  greenhouse(a, left ? -x0 - 1.6 - gw : x0 + 1.6, H / 2 - 1.5 - gd, gw, gd);
  for (let k = 0; k < 3; k++) yardTree(a, lot, x0 + W * (0.25 + 0.25 * k), H / 2 - 2.2 - a.r(5 + k) * 3, 1.6 + a.r(8 + k) * 0.8, 11 + k);
  frontPath(a, lot, hx + hw / 2, hy + 0.4, 1.2);
  fence(a, lot, 0.1 + a.r(14) * 0.3, hx + hw / 2, pad ? pad.x + pad.w / 2 : undefined, pad ? pad.w + 0.4 : 0);
  const roof = a.r(15) < 0.5 ? METAL_ROOFS[Math.floor(a.r(16) * METAL_ROOFS.length)] : lot.b.roof;
  pitched(a, hx, hy, hw, hd, 3.6, roof, hw >= hd, a.r(17) < 0.5 ? Math.min(hw, hd) / 2 : 0, true);
}

/**
 * Многоквартирный дом в два-три этажа (село и окраина города): корпус почти во весь участок под скатной или
 * вальмовой крышей, подъезды с козырьками — к улице, к каждому — дорожка от тротуара; за домом — ряд сараев, на
 * глубоком участке — ещё грядки и палисадники жильцов, лавочка, дерево.
 */
function walkup(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  lawn(a, lot);
  const s = lot.storeys;
  // Корпус — почти весь участок: за ним только полоса двора с сараями.
  const bw = W - 1.8;
  const bd = clamp(H * 0.55, 9, 15 * S);
  const by = y0 + 1.8;
  const bx = x0 + 0.9;
  const sections = Math.max(1, Math.round(bw / (11 * S)));
  const step = bw / sections;
  const roof = b.roof;
  // Подъезды: дорожки от тротуара к каждому.
  for (let k = 0; k < sections; k++) frontPath(a, lot, bx + step * (k + 0.5), by, 1.6);
  // Двор: сараи вдоль задней границы, на широком — ещё грядки и палисадники, лавочка, дерево.
  const yard = by + bd + 0.8;
  const yEnd = H / 2 - 0.6;
  if (yEnd - yard > 2.6) {
    // Сараи жильцов — как у частного дома, поменьше.
    const n = Math.max(2, Math.floor((W - 3) / 4.8));
    const sh = Math.min(4.4, yEnd - yard - 0.4);
    for (let k = 0; k < n; k++) {
      const t = a.r(60 + k);
      pitched(a, x0 + 1.5 + k * 4.8, yEnd - sh, 4.5, sh, 2.4, t < 0.5 ? '#8d7a66' : t < 0.8 ? '#7f8890' : '#9a6b52', false, 0, t >= 0.5);
    }
    const gy = yard + 0.3;
    const gh = yEnd - sh - 1 - gy;
    if (gh > 1.8) {
      beds(a, x0 + 1.5, gy, W * 0.4, gh, true);
      if (a.d) a.patch(-x0 - 1.5 - W * 0.35, gy, W * 0.35, gh, LAWN_DACHA, 0.8);
      yardTree(a, lot, -x0 - 1.5 - W * 0.2, gy + gh / 2, 2.2 + a.r(3), 4);
      bench(a, x0 + W * 0.55, gy + 0.6, 1, 0, -1);
    }
  }
  const z = wallZ(s);
  const hip = a.r(7) < 0.45 ? bd * 0.45 : 0;
  pitched(a, bx, by, bw, bd, z, roof, true, hip, a.r(8) < 0.25);
  if (a.pass === 2 && a.lod) {
    // Козырьки подъездов.
    a.c.fillStyle = tone(roof, -0.22);
    for (let k = 0; k < sections; k++) a.c.fillRect(bx + step * (k + 0.5) - 1.6, by - 1.3, 3.2, 1.4);
  }
  // Трубы.
  for (let k = 0; k < sections; k++) roofBit(a, bx + step * (k + 0.5) - 0.65, by + bd * 0.3, 1.3, 1.3, 1.2, '#8a5a48');
}

/**
 * Дом старого центра: вплотную к тротуару во всю ширину участка, за ним — мощёный двор с флигелем и деревом; у
 * глубокого двора вместо дерева — места у задней границы, въезд — аркой в корпусе (world/yardLots.townhousePlan).
 */
function townhouse(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  a.patch(x0 + 0.4, y0 + 0.4, W - 0.8, H - 0.8, PAVING, 0.5);
  const s = lot.storeys;
  const p = townhousePlan(b);
  const { d, door } = p;
  const w = W - 0.8;
  const z = wallZ(s);
  // Вход с улицы — дорожка через газон к двери, во двор — проезд-арка (въезд с улицы).
  frontPath(a, lot, door, y0 + 0.6, 1.8);
  if (p.arch) curbCut(a, lot, p.arch.x, p.arch.w, y0 + 0.5 + d + 1.5, PAVING);
  if (p.row) parking(a, p.row);
  if (p.wing) pitched(a, p.wing.x, p.wing.y, p.wing.w, p.wing.h, wallZ(1), tone(b.roof, -0.08), p.wing.w < p.wing.h);
  if (p.tree) yardTree(a, lot, p.tree.x, p.tree.y, 2.2 + a.r(3), 4);
  if (s >= 3 && a.r(5) < 0.3) flat(a, x0 + 0.4, y0 + 0.5, w, d, z, tone(b.roof, 0.18));
  else pitched(a, x0 + 0.4, y0 + 0.5, w, d, z, b.roof, true, a.r(6) < 0.4 ? d * 0.45 : 0);
  if (a.pass === 2 && a.lod) {
    a.c.fillStyle = tone(b.roof, -0.25);
    a.c.fillRect(door - 1.2, y0 - 0.5, 2.4, 1);
    if (p.arch) {
      // Арка во двор — тёмный проём у фасада.
      a.c.fillStyle = 'rgba(60,56,50,0.75)';
      a.c.fillRect(p.arch.x - p.arch.w / 2, y0 + 0.5, p.arch.w, 0.9);
    }
  }
  if (a.d) for (let k = 0; k < (W > 18 * S ? 2 : 1); k++) roofBit(a, x0 + W * (0.25 + 0.5 * k) - 0.45, y0 + 0.5 + d * 0.28, 1, 1, 1.2, '#8a5a48');
}

/** Квартал старого центра: дома по периметру участка (П или замкнутый «колодец»), во дворе — мощение и деревья. */
function courtyard(a: Art, lot: Lot): void {
  const { b } = lot;
  // Раскладка — world/yardLots.courtyardPlan: там и арка (ворота двора), и места во дворе.
  const p = courtyardPlan(b);
  const { x0, y0, x1, y1, d, closed } = p;
  const roofFlat = a.r(3) < 0.35;
  const z = wallZ(lot.storeys);
  a.patch(x0, y0, x1 - x0, y1 - y0, PAVING, 0.5);
  // Подъезды — со двора: через арку в лицевом корпусе — проезд от улицы, рядом — дорожка от тротуара.
  const arch = p.arch.x;
  curbCut(a, lot, arch, p.arch.w, y0 + d + 2, PAVING);
  // Двор: дерево, клумба; в просторном — ряд мест у дальнего края (машины на них рисует движение, carHomes.ts).
  if (p.row) parking(a, p.row);
  if (p.lawn) {
    const { x: cx, y: cy } = p.lawn;
    if (a.d) a.patch(cx - 2.2 * S, cy - 1.6 * S, 4.4 * S, 3.2 * S, LAWN_DACHA, 1.2);
    yardTree(a, lot, cx + (a.r(4) - 0.5) * 3, cy, 2.3 + a.r(5) * 0.8, 6);
  }
  const roof = b.roof;
  const wing = (x: number, y: number, w: number, h: number) => {
    if (roofFlat) flat(a, x, y, w, h, z, tone(roof, 0.15));
    else pitched(a, x, y, w, h, z, roof, w >= h, 0);
  };
  const sideH = (closed ? y1 - d : y1) - (y0 + d);
  // Боковые крылья — первыми: лицевое и заднее ложатся поверх углов.
  if (p.leftWing) wing(x0, y0 + d, d, sideH);
  if (p.rightWing) wing(x1 - d, y0 + d, d, sideH);
  if (closed) wing(x0, y1 - d, x1 - x0, d);
  wing(x0, y0, x1 - x0, d);
  if (a.pass === 2 && a.lod) {
    // Арка в лицевом корпусе — тёмный проём у фасада.
    a.c.fillStyle = 'rgba(60,56,50,0.75)';
    a.c.fillRect(arch - p.arch.w / 2, y0, p.arch.w, 0.9);
  }
  if (!roofFlat && a.d) {
    for (let k = 0; k < Math.floor((x1 - x0) / (9 * S)); k++) roofBit(a, x0 + 4 + k * 9 * S, y0 + d * 0.25, 1.2, 1.2, 1.2, '#8a5a48');
  }
}

/**
 * Двор многоэтажки (раскладка — world/yardLots.yardPlan, в прямоугольнике x, y): вдоль длинной стороны по очереди —
 * детская площадка (песочница, горка, качели, карусель), спортивная коробка, стоянка, мусорная площадка; что не
 * влезло — нет. Вдоль дальнего края — деревья, где хватает места.
 */
function yardItems(a: Art, lot: Lot, plan: YardPlan | null, x: number, y: number, seed: number): void {
  if (!plan) return;
  const { across, L, D } = plan;
  for (const p of plan.pieces) {
    const { x: ix, y: iy, w: w2, h: h2 } = p.rect;
    if (p.item === 'play') playArea(a, ix, iy, Math.min(w2, h2), lot.b.id + seed, lot.fine);
    else if (p.item === 'box') sportsBox(a, ix, iy, w2, h2, lot.b.id + seed, lot.fine);
    else if (p.item === 'park') parking(a, p.row!);
    else trashPad(a, ix, iy, w2, h2);
  }
  const taken = plan.pieces.map((p) => [p.u0, p.u1, p.end]);
  // Деревья по дальнему краю — там, где площадки не доходят до него.
  for (let u = 3, k = 0; u < L - 2; u += 6.5, k++) {
    if (taken.some(([u0, u1, end]) => u > u0 - 2.4 && u < u1 + 2.4 && end > D - 4.2)) continue;
    const r = 2 + a.r(seed + 40 + k) * 0.6;
    const v = D - r - 0.2;
    if (across) yardTree(a, lot, x + v, y + u, r, seed + 60 + k);
    else yardTree(a, lot, x + u, y + v, r, seed + 60 + k);
  }
}

/** Проезд к подъездам вдоль корпуса (полоса асфальта) и пятачки у каждого подъезда; n — подъездов, x0..x1 — корпус. */
function driveway(a: Art, x0: number, x1: number, y: number, n: number, from?: number): void {
  if (!a.lod) return;
  // От проезда с улицы (from — край участка у торца) — до дальнего конца корпуса.
  const l = from === undefined ? x0 - 1 : Math.min(from, x0 - 1);
  const r = from === undefined ? x1 + 1 : Math.max(from, x1 + 1);
  a.patch(l, y + 1.2, r - l, 3.2, ASPHALT, 0.6);
  if (!a.d) return;
  const step = (x1 - x0) / n;
  for (let k = 0; k < n; k++) a.patch(x0 + step * (k + 0.5) - 1, y - 0.2, 2, 1.6, PAVING);
}

/** Панельный дом: длинный корпус с плоской крышей у улицы, подъезды — во двор; во дворе — проезд, площадки, стоянка, деревья. */
function slab(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const z = wallZ(lot.storeys);
  lawn(a, lot);
  const p = slabPlan(b);
  if (p.kind === 'along') {
    // Вдоль улицы: корпус у тротуара, двор — за ним; у длинного дома с одного торца — проезд с улицы во двор, у
    // короткого — арка в корпусе (world/yardLots.slabPlan: там ворота двора, машины въезжают в них).
    const { bx, by, L, bd, top, yx0, yx1, ell, right } = p;
    if (p.yard) {
      if (p.pass) curbCut(a, lot, p.pass.x, p.pass.w, top + 4.4);
      if (p.arch) curbCut(a, lot, p.arch.x, p.arch.w, by + 0.4);
      driveway(a, Math.max(yx0, bx), Math.min(yx1, bx + L), top, p.sections, p.pass?.edge);
      yardItems(a, lot, p.plan, yx0, top + 5.2, 30);
    }
    if (ell) flat(a, right ? -x0 - 1.5 - bd : x0 + 1.5, by + bd, bd, H - (by - y0) - bd - 3, z, b.roof, 15 * S);
    flat(a, bx, by, L, bd, z, b.roof, 15 * S);
    if (p.arch && a.pass === 2 && a.lod) {
      // Арка во двор — тёмный проём у фасада.
      a.c.fillStyle = 'rgba(60,56,50,0.75)';
      a.c.fillRect(p.arch.x - p.arch.w / 2, by, p.arch.w, 0.9);
    }
  } else {
    // Узкий глубокий участок: корпус торцом к улице, двор сбоку, стоянка у улицы — со съездом во всю её ширину.
    const { bx, bw } = p;
    if (p.lot && p.cut) {
      curbCut(a, lot, p.cut.x, p.cut.w, y0 + 2.5);
      parking(a, p.lot);
      yardItems(a, lot, p.plan, p.yardX, p.yy, 30);
    }
    frontPath(a, lot, bx + bw / 2, y0 + 2.6, 1.8);
    flat(a, bx, y0 + 2.5, bw, H - 5, z, b.roof, 15 * S);
  }
}

/** Высотка: башня в глубине участка, перед ней — стоянка со съездом с улицы, вокруг — деревья. */
function tower(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const z = wallZ(lot.storeys);
  lawn(a, lot);
  // Башня крестом: квадрат с выступами-крыльями, у узкого участка — во всю его глубину. Раскладка — world/yardLots.
  const p = towerPlan(b);
  const { T, tx, ty } = p;
  // Стоянки у улицы — съезд во всю ширину ряда мест: машина сворачивает с полосы прямо на своё место.
  for (const c of p.cuts) curbCut(a, lot, c.x, c.w, c.side * (H / 2 - 1.6), DRIVE, c.side);
  for (const row of p.rows) parking(a, row);
  if (p.block) {
    // Участок квартала от улицы до улицы: башня посреди общего двора, стоянки — у обеих улиц, площадки и деревья — во
    // дворе (между рядами деревьев, с другой стороны от башни).
    const yard = p.yard!;
    yardItems(a, lot, p.plan, yard.x, yard.y, 50);
    treeRow(a, lot, x0 + 1, -x0 - 1, y0 + 12, 7, 2.2, 40);
    treeRow(a, lot, x0 + 1, -x0 - 1, H / 2 - 12, 7, 2.2, 80);
  } else if (p.rest > 6) {
    const { px, rest } = p;
    if (H > 20 && rest > 12) playArea(a, px + rest / 2 - 4, y0 + 10.6, Math.min(8, H - 13), b.id, lot.fine);
    treeRow(a, lot, px, px + rest, H / 2 - 2, 6.5, 2.2, 40);
  }
  frontPath(a, lot, tx, ty, 2);
  const roof = tone(b.roof, 0.18);
  const k = T * 0.22;
  flat(a, tx - T / 2, ty + k, T, T - 2 * k, z, roof);
  flat(a, tx - T / 2 + k, ty, T - 2 * k, T, z, roof);
  // Машинное отделение лифтов и антенна.
  flat(a, tx - 3, ty + T / 2 - 2.2, 6, 4.4, z + 3, tone(roof, 0.1));
  roofBit(a, tx + T / 2 - k - 2, ty + 1.5, 1.2, 1.2, 2.5, '#c0c4c8');
}

// ---------- Общественные и деловые ----------

/** Бетон рампы и её тёмная кромка-отбойник. */
const RAMP = '#c2bcae';
const RAMP_EDGE = '#3e4147';

/**
 * Двор с рампой для грузовика (world/shopLots.DockYard): съезд с улицы, асфальт проезда и двора (у сельского
 * магазина — гравий), вблизи — бетонная рампа у стены с тёмным отбойником. Грузовик во дворе рисует движение
 * (game/docks.ts).
 */
function serviceYard(a: Art, lot: Lot, y: DockYard, gravel = false): void {
  curbCut(a, lot, y.drive.x, y.drive.w, -lot.H / 2 + 0.6, gravel ? GRAVEL_DRIVE : DRIVE);
  for (const p of y.pad) a.patch(p.x, p.y, p.w, p.h, gravel ? GRAVEL : ASPHALT, 0.4);
  if (a.pass !== 2 || !a.lod) return;
  const c = a.c;
  const r = y.ramp;
  c.fillStyle = RAMP;
  c.fillRect(r.x, r.y, r.w, r.h);
  if (!a.d) return;
  c.fillStyle = RAMP_EDGE;
  // Отбойник — по кромке, к которой встаёт грузовик.
  if (r.w >= r.h) c.fillRect(r.x, y.kind === 'turn' ? r.y + r.h - 0.18 : r.y, r.w, 0.18);
  else c.fillRect(y.side === 1 ? r.x + r.w - 0.18 : r.x, r.y, 0.18, r.h);
}

/**
 * Стоянка покупателей (world/shopLots.ts): асфальт (у сельского магазина — гравий) ровно под места, съезд с улицы во
 * всю ширину группы. Вблизи — разметка: белые линии между местами и по краям, черта-упор у дальнего края (у
 * сельского — бревно-упор у каждого места). Машины на местах рисует не участок, а движение (game/shopParking.ts):
 * они приезжают и уезжают.
 */
function stallGroups(a: Art, lot: Lot, plan: ShopLot): void {
  for (const g of plan.groups) {
    const p = g.pad;
    curbCut(a, lot, g.cut.x, g.cut.w, p.y + 0.6, plan.gravel ? GRAVEL_DRIVE : DRIVE);
    a.patch(p.x, p.y, p.w, p.h, plan.gravel ? GRAVEL : ASPHALT, 0.5);
    if (!a.d) continue;
    const c = a.c;
    if (plan.gravel) {
      if (a.pass !== 2) continue;
      c.fillStyle = WOOD;
      for (const s of g.stalls) c.fillRect(s.x - s.w / 2 + 0.9, s.y1 - 0.75, s.w - 1.8, 0.45);
      continue;
    }
    if (a.pass !== 0) continue;
    c.strokeStyle = STALL_LINE;
    c.lineWidth = 0.16;
    c.beginPath();
    for (const s of g.stalls) {
      for (const x of [s.x - s.w / 2, s.x + s.w / 2]) (c.moveTo(x, s.y0 + 0.4), c.lineTo(x, s.y1));
      c.moveTo(s.x - s.w / 2, s.y1);
      c.lineTo(s.x + s.w / 2, s.y1);
    }
    c.stroke();
  }
}

/**
 * Магазин: здание с цветным козырьком над входом; стоянка покупателей (world/shopLots.ts) — сбоку от небольшого
 * магазина или перед универмагом (от 4 этажей) во всю ширину, с проходом ко входу посередине.
 */
function shop(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const plan = shopLotOf(b)!;
  const { x: bx, y: by, w, h: d } = plan.building!;
  const left = bx + w / 2 < 0;
  lawn(a, lot);
  if (plan.walk) {
    // Универмаг: мощёная полоса вдоль фасада и проход к нему между группами мест.
    a.patch(x0 + 0.4, by - 1.8, W - 0.8, 2, PAVING, 0.5);
    frontPath(a, lot, plan.walk.x, by - 1, plan.walk.w);
  } else {
    a.patch(bx - 0.6, y0 + 0.4, w + 1.2, Math.min(H - 0.8, d + 3.4), PAVING, 0.5);
    frontPath(a, lot, bx + w / 2, by, 2.4);
  }
  if (plan.yard) serviceYard(a, lot, plan.yard);
  else if (H / 2 - by - d > 5) yardTree(a, lot, left ? -x0 - 3 : x0 + 3, H / 2 - 2.6, 2.2, 9);
  stallGroups(a, lot, plan);
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

/**
 * Сельский магазин или клуб: дом под скатной крышей с вывеской и крыльцом у одной стороны участка, перед крыльцом —
 * утоптанная площадка, рядом с домом — гравийная стоянка на 1–4 машины (world/shopLots.ts).
 */
function store(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  lawn(a, lot);
  const plan = shopLotOf(b)!;
  const { x: bx, y: by, w, h: d } = plan.building!;
  a.patch(bx - 0.5, y0 + 0.4, w + 1, by - y0 - 0.2, GRAVEL, 0.5);
  frontPath(a, lot, bx + w / 2, y0 + 0.6, 2.4);
  stallGroups(a, lot, plan);
  if (plan.yard) serviceYard(a, lot, plan.yard, true);
  else if (H / 2 - by - d > 6) {
    yardTree(a, lot, bx < 0 ? -x0 - 3 : x0 + 3, by + d + 2.5, 2.4 + a.r(2), 3);
    pitched(a, bx < 0 ? x0 + 1.5 : -x0 - 1.5 - SHED.w, H / 2 - 1.3 - SHED.d, SHED.w, SHED.d, 2.6, '#8d7a66', true);
  }
  const roof = a.r(4) < 0.5 ? METAL_ROOFS[Math.floor(a.r(5) * METAL_ROOFS.length)] : '#8c6a52';
  pitched(a, bx, by, w, d, wallZ(1), roof, w >= d, 0, a.r(4) < 0.5);
  if (a.pass === 2 && a.lod) {
    const c = a.c;
    // Вывеска над крыльцом.
    c.fillStyle = AWNINGS[Math.floor(a.r(6) * AWNINGS.length)];
    c.fillRect(bx + w / 2 - 2.2, by - 0.9, 4.4, 0.9);
    if (lot.fine) {
      // Скамейка у крыльца — с той стороны, где нет стоянки.
      c.fillStyle = WOOD;
      c.fillRect(plan.groups[0] && plan.groups[0].pad.x < bx ? bx + w - 3.2 : bx + 0.8, by - 2.2, 2.4, 0.6);
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
  // Здание — почти во весь участок; у одного края — проезд к рампе у торца (world/shopLots.officeLot).
  const plan = officeLot(b);
  const { x: bx, y: by, w, h: d } = plan.building;
  serviceYard(a, lot, plan.yard);
  frontPath(a, lot, bx + w / 2 + (a.r(3) - 0.5) * w * 0.5, y0 + 1.4, 2.6);
  if (b.floors >= 3 && a.r(2) < 0.6) {
    flat(a, bx, by, w, d, z * 0.65, tone(roof, 0.12));
    flat(a, bx + w * 0.12, by + d * 0.1, w * 0.76, d * 0.62, z, roof);
  } else flat(a, bx, by, w, d, z, roof);
  if (a.pass === 2 && a.d) {
    a.c.fillStyle = 'rgba(176,214,232,0.85)';
    a.c.fillRect(bx + w * 0.3, by + d * 0.3, w * 0.4, 1.4);
  }
  roofBit(a, bx + w * 0.7, by + d * 0.55, 2, 1.6, 1.2, '#b4b9be');
}

/**
 * Рынок: ряды цветных навесов на мощёной площадке и крытый павильон в глубине; у улицы — стоянка покупателей
 * (world/shopLots.ts) двумя группами, между ними — широкий проход к рядам.
 */
function market(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const plan = shopLotOf(b)!;
  a.patch(x0 + 0.3, y0 + 0.3, W - 0.6, H - 0.6, PAVING, 0.5);
  // Рынок открыт к улице: мощение прохода — через газон до тротуара.
  frontPath(a, lot, plan.walk!.x, y0 + 0.5, plan.walk!.w);
  stallGroups(a, lot, plan);
  if (plan.yard) serviceYard(a, lot, plan.yard);
  // Ряды и павильон — между краем участка и проездом к рампе у торца павильона.
  const xa = plan.yard ? (plan.yard.side === -1 ? plan.yard.drive.x + plan.yard.drive.w / 2 + 0.9 : x0 + 1.5) : x0 + 1.5;
  const xb = plan.yard ? (plan.yard.side === -1 ? -x0 - 1.5 : plan.yard.drive.x - plan.yard.drive.w / 2 - 0.9) : -x0 - 1.5;
  const hd = marketHall(H);
  pitched(a, xa, H / 2 - 1.2 - hd, xb - xa, hd, 4.5 * S, '#8fa3ad', true, 0, true);
  // Навесы — под прилавок и покупателя, крупнее прежних (TOWN_SCALE), но мельче домов; за стоянкой.
  const row = 6.5;
  const pitch = 4.2;
  const top = y0 + (plan.groups.length ? STALL_ROW_DEPTH + 1.8 : 1.8);
  const rows = Math.max(1, Math.floor((H / 2 - 1.2 - hd - top) / row));
  for (let r = 0; r < rows; r++) {
    const y = top + r * row;
    const n = Math.floor((xb - xa) / pitch);
    for (let k = 0; k < n; k++) {
      const color = STALLS[Math.floor(a.r(r * 31 + k) * STALLS.length)];
      pitched(a, xa + k * pitch, y, pitch - 0.4, 3.4, 2.2, color, false, 0);
    }
  }
}

/** Школа: П-образное здание у улицы, за ним — стадион с беговой дорожкой; вдоль забора — деревья. */
function school(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  lawn(a, lot);
  const d = clamp(H * 0.24, 6, 8.5 * S);
  const by = y0 + 2;
  const wingL = clamp(H * 0.42, 7, 14 * S);
  // Стадион за зданием между крыльями — или во всю ширину, если крыльям не хватает места.
  const fy = by + d + 1.5;
  const fh = H / 2 - 1.5 - fy;
  if (fh > 5) {
    const fx = x0 + 1.5 + d + 1;
    const fw = W - 2 * (1.5 + d + 1);
    const full = fw < 10 * S;
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
  frontPath(a, lot, 0, by, 3.2);
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
  const t = clamp(Math.min(W, H) * 0.24, 5.5, 8 * S);
  const L = H - 4;
  // Подъезд к приёмному покою — съезд с улицы между крыльями «Н», к перемычке.
  curbCut(a, lot, 0, 5.2, -t / 2 + 0.2);
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
  yardTree(a, lot, 0, H / 2 - 3, 2.6, 4);
  if (lot.fine) a.vehicle(2.2, -t / 2 - 4, CAR.w + 0.3, CAR.l + 1, '#f4f4f0');
}

/** Храм: неф поперёк улицы, апсида в глубине, колокольня у входа, луковичная глава; вокруг — ограда и деревья. */
function church(a: Art, lot: Lot, scale = 1): void {
  const { W, H } = lot;
  const y0 = -H / 2;
  lawn(a, lot);
  const w = clamp(W * 0.3, 7, 12 * S) * scale;
  const L = clamp(H * 0.5, 11, 22 * S) * scale;
  // Колокольня — в масштабе храма.
  const t = clamp(w * 0.42, 4.2 * scale, 4.2 * S * scale);
  const ny = y0 + 3 + t + 0.3;
  const blue = a.r(1) < 0.4;
  const dome = blue ? '#4d78b8' : DOME_GOLD;
  const roof = a.r(2) < 0.5 ? '#6f9a7a' : '#8a9aa6';
  frontPath(a, lot, 0, ny, 1.6);
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
  // Бокс — под машину, как место во дворе (world/yardLots: 4,6 × 8,5 ед., ≈ 2,8 × 5,1 м); два ряда — если между ними
  // остаётся проезд. Въезд — с торца участка (там ворота: машина въезжает и пропадает в боксе), боксов переднего ряда
  // напротив него нет.
  const p = garagesPlan(lot.b);
  curbCut(a, lot, p.gate.x, p.gate.w, y0 + 1);
  for (const [r, row] of p.rows.entries()) {
    if (!a.lod) {
      for (const x of row.xs) flat(a, x, row.y, p.bw, p.bd, 2.8, '#8b8f94');
      continue;
    }
    for (const [k, x] of row.xs.entries()) {
      const t = a.r(r * 50 + k);
      const color = t < 0.5 ? '#8b8f94' : t < 0.7 ? '#9a6b52' : t < 0.85 ? '#6f8798' : '#7d9572';
      flat(a, x, row.y, p.bw, p.bd, 2.8, color);
    }
  }
}

/** Склад: ангар из профлиста, у ворот — рампа, поддоны и грузовик. */
function warehouse(a: Art, lot: Lot): void {
  const { W, H } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  a.patch(x0 + 0.3, y0 + 0.3, W - 0.6, H - 0.6, 'rgba(150,148,140,0.6)', 0.5);
  // Въезд для грузовиков — от улицы прямо к рампе на стене ангара (world/shopLots.warehouseLot).
  const plan = warehouseLot(lot.b);
  const h = plan.hangar;
  serviceYard(a, lot, plan.yard);
  const roof = a.r(1) < 0.6 ? METAL : '#a56a4b';
  pitched(a, h.x, h.y, h.w, h.h, 6, roof, true, 0, true);
  const docks = Math.floor((W - 4) / 5);
  for (let k = 0; k < docks; k++) {
    if (a.pass === 2 && a.d) {
      a.c.fillStyle = '#4a4d52';
      a.c.fillRect(x0 + 2.5 + k * 5, h.y - 0.8, 3, 0.8);
    }
  }
  for (let k = 0; k < 3; k++) roofBit(a, x0 + 2 + k * 2.2 + a.r(5) * 4, y0 + 1.5 + a.r(6 + k) * 2, 1.6, 1.6, 1, '#c9a46a');
}

/** Ратуша на площади: площадь шире участка, здание с часовой башней, фонтан, деревья по углам. */
function hall(a: Art, lot: Lot): void {
  const { W, H, b } = lot;
  const x0 = -W / 2;
  const y0 = -H / 2;
  // Площадь — шире участка на LANDMARK_YARD.hall (её же обходит перенос ратуши: Game.movePlan).
  const yard = LANDMARK_YARD.hall;
  a.patch(x0 - yard, y0 - yard, W + yard * 2, H + yard * 2, PLAZA, 2, 'rgba(120,100,70,0.35)');
  if (a.d && a.pass === 0) {
    // Брусчатка: ряды поперёк фасада, вблизи — швы со сдвигом.
    const c = a.c;
    c.strokeStyle = 'rgba(150,130,100,0.25)';
    c.lineWidth = 0.15;
    c.beginPath();
    for (let y = y0 - 6; y < H / 2 + 7; y += 1.2) (c.moveTo(x0 - 6.5, y), c.lineTo(-x0 + 6.5, y));
    if (lot.fine) {
      let row = 0;
      for (let y = y0 - 6; y < H / 2 + 6; y += 1.2, row++) for (let x = x0 - 6.5 + (row % 2 ? 0.9 : 0); x < -x0 + 6.5; x += 1.8) (c.moveTo(x, y), c.lineTo(x, y + 1.2));
    }
    c.stroke();
  }
  // Перед входом — фонтан, по бокам — клумба и памятник; скамейки и фонари вокруг.
  // Место и размер фонтана — те же, что у hallFountain (рябь на воде вблизи).
  const fy = y0 + H * 0.13;
  const fr = hallFountainR(W);
  fountain(a, 0, fy, fr, lot.fine);
  const side = a.r(31) < 0.5 ? 1 : -1;
  if (W >= 30) {
    flowerbed(a, -side * W * 0.3, fy, 2.6, 1.6, b.id, lot.fine);
    statue(a, side * W * 0.3, fy, 1.8);
  }
  for (const s of [-1, 1]) bench(a, s * (fr + 1.6), fy, 0, 1, s);
  for (const [lx, ly] of [
    [-W / 2 - 4.5, y0 - 4.5],
    [W / 2 + 4.5, y0 - 4.5],
    [-W * 0.18, y0 - 5],
    [W * 0.18, y0 - 5],
    [-W / 2 - 4.5, H / 2 + 4.5],
    [W / 2 + 4.5, H / 2 + 4.5],
  ])
    lamp(a, lx, ly, lot.fine);
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
  const t = Math.min(7 * S, W * 0.17);
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

/** Радиус фонтана перед ратушей с участком шириной W, м: в масштабе площади (TOWN_SCALE). */
const hallFountainR = (W: number) => Math.min(6, W * 0.11);

/** Фонтан перед ратушей (как в hall): середина в мире и радиус — для ряби на воде вблизи (renderer.drawMotion). */
export function hallFountain(b: TownBuilding): { x: number; y: number; r: number } | null {
  if (formOf(b) !== 'hall') return null;
  const angle = (b.face ?? -1) === 1 ? b.fp.angle + Math.PI : b.fp.angle;
  const ly = -b.fp.h / 2 + b.fp.h * 0.13;
  return { x: b.fp.center.x - ly * Math.sin(angle), y: b.fp.center.y + ly * Math.cos(angle), r: hallFountainR(b.fp.w) };
}

/** Храм в центре села: церковь на зелёной площади. */
function temple(a: Art, lot: Lot): void {
  const { W, H } = lot;
  const yard = LANDMARK_YARD.temple;
  a.patch(-W / 2 - yard, -H / 2 - yard, W + yard * 2, H + yard * 2, PLAZA, 2, 'rgba(120,100,70,0.3)');
  // Перед оградой — клумбы и скамейки у входа, фонари (памятник села — в сквере рядом, townParks).
  for (const s of [-1, 1]) {
    flowerbed(a, s * W * 0.3, -H / 2 - 3, 2.2, 1.3, lot.b.id + s, lot.fine);
    bench(a, s * W * 0.14, -H / 2 - 3.6, 1, 0, -1);
    lamp(a, s * (W / 2 + 3), -H / 2 - 3, lot.fine);
  }
  church(a, lot, 1.15);
}

const SCENES: Record<HouseForm, (a: Art, lot: Lot) => void> = {
  cottage,
  dacha,
  walkup,
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
 * деревьев биома; grime — налёт от вредных предприятий (enterpriseArt.houseGrime): крыши блёкнут (grimy).
 */
export function drawHouseArt(ctx: CanvasRenderingContext2D, b: TownBuilding, zoom: number, trees: readonly string[] = TREES, grime = 0): void {
  soot = grime;
  try {
    drawScene(ctx, b, zoom, trees);
  } finally {
    soot = 0;
  }
}

function drawScene(ctx: CanvasRenderingContext2D, b: TownBuilding, zoom: number, trees: readonly string[]): void {
  const form = formOf(b);
  const angle = (b.face ?? -1) === 1 ? b.fp.angle + Math.PI : b.fp.angle;
  const fp: Footprint = { center: b.fp.center, w: b.fp.w, h: b.fp.h, angle };
  const a = new Art(ctx, { id: b.id, fp }, zoom, 0, b.id, 'still');
  const lot: Lot = { b, W: b.fp.w, H: b.fp.h, storeys: storeysOf(b), fine: zoom > FINE_ZOOM, trees };
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
