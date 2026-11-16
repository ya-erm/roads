import { TOWN_SCALE } from '../config';
import { hash } from '../core/math';
import type { TownBuilding } from './entities';
import { drivewayAt, type Driveway, type LotRect } from './houseAccess';
import { formOf } from './townForms';

/**
 * Стоянки покупателей у магазина, сельского магазина и рынка: раскладка участка (здание и места), общая для рисунка
 * (render/houseArt.ts) и для игры — машины горожан заезжают на свободное место и уезжают (game/shopParking.ts).
 * Всё — по хешу id дома (Art.r(i) = hash(id, i)), без генератора случайных чисел партии.
 *
 * Оси участка — как у рисунка дома: начало — в середине участка, x — вдоль улицы, улица — со стороны −y. Места —
 * поперёк улицы, машина встаёт носом от улицы; заезд — широкий, во всю группу мест: машина сворачивает с полосы прямо
 * к своему месту, выезжает задним ходом к бордюру (как у гаража, game/garages.ts).
 */

/**
 * Место на стоянке: машина 7 × 4 (CAR_SIZE) и по бокам — открыть двери; ширина 4,6–5 м (сколько мест влезает
 * по ширине площадки, остаток — поровну между ними), глубина 8 м — машина и полметра до упора.
 */
export const STALL = { min: 4.6, max: 5, d: 8 } as const;
/**
 * Асфальт между краем участка и местами, м: машина с улицы доворачивает ещё до мест и въезжает в своё прямо, не
 * задевая соседних (поворот кончается в 3,8 м от бордюра — центр кузова, нос — в 2,3 м за краем участка).
 */
export const APRON = 2.5;
/** Нос стоящей машины — за столько метров до дальнего края места (упор). */
export const STALL_STOP = 0.6;
/** Сколько мест у сельского магазина — не больше. */
const STORE_MAX = 4;
/** Проход к входу между двумя группами мест (у большого магазина), м. */
const WALK = 3.2;

/** Место: середина по x, ширина; от y0 (у улицы) до y1. */
export interface ShopStall {
  x: number;
  w: number;
  y0: number;
  y1: number;
}

/** Группа мест: асфальт (или гравий у сельского магазина), сами места и съезд через тротуар во всю ширину. */
export interface StallGroup {
  pad: LotRect;
  stalls: ShopStall[];
  cut: { x: number; w: number };
}

/** Раскладка участка с местами: здание (у рынка — нет: навесы рисует сцена), группы мест; gravel — без разметки. */
export interface ShopLot {
  building: LotRect | null;
  groups: StallGroup[];
  gravel: boolean;
  /** Проход от улицы ко входу между группами — у большого магазина и рынка. */
  walk: { x: number; w: number } | null;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const r = (b: Pick<TownBuilding, 'id'>, i: number) => hash(b.id, i);
const S = TOWN_SCALE;

/** Сколько мест влезает в span и какой ширины (4,6–5 м); не влезает ни одно — 0. */
export function stallFit(span: number): { n: number; w: number } {
  const n = Math.floor(span / STALL.min + 1e-9);
  return n < 1 ? { n: 0, w: 0 } : { n, w: Math.min(STALL.max, span / n) };
}

/** Группа из n мест шириной w от x (левый край) у улицы: места — от края участка + APRON, асфальт — по ним. */
function group(x: number, n: number, w: number, y0: number): StallGroup {
  const stalls: ShopStall[] = [];
  for (let k = 0; k < n; k++) stalls.push({ x: x + w * (k + 0.5), w, y0: y0 + APRON, y1: y0 + APRON + STALL.d });
  const width = n * w;
  return { pad: { x: x - 0.4, y: y0 + 0.4, w: width + 0.8, h: APRON + STALL.d + 0.2 }, stalls, cut: { x: x + width / 2, w: width } };
}

/** Две группы мест в span [xa, xb] по обе стороны прохода ко входу в середине. */
function split(xa: number, xb: number, y0: number, walk: number): StallGroup[] {
  const out: StallGroup[] = [];
  const half = (xb - xa - walk) / 2;
  const f = stallFit(half);
  if (!f.n) return out;
  // Места — от прохода к краям: остаток ширины — у краёв участка (газон).
  out.push(group(-walk / 2 - f.n * f.w, f.n, f.w, y0));
  out.push(group(walk / 2, f.n, f.w, y0));
  return out;
}

/**
 * Раскладка магазина. Небольшой (до 3 этажей) — здание у тротуара, стоянка сбоку: мест — сколько влезает по
 * ширине (участок 35–57 м — 2–4 места), остаток ширины отдаётся зданию — площадка ровно под места. Большой (от
 * 4 этажей) — универмаг: стоянка во всю ширину перед ним, проход ко входу посередине (участок 36–57 м — 6–10 мест),
 * здание — за стоянкой.
 */
function shopLot(b: Pick<TownBuilding, 'id' | 'fp' | 'floors'>): ShopLot {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const left = r(b, 1) < 0.5;
  if (b.floors >= 4) {
    const by = y0 + APRON + STALL.d + 1.8;
    const d = Math.max(8, H / 2 - 2 - by);
    const groups = split(x0 + 1.5, -x0 - 1.5, y0, WALK);
    return { building: { x: x0 + 1.5, y: by, w: W - 3, h: d }, groups, gravel: false, walk: { x: 0, w: WALK } };
  }
  let w = clamp(W * 0.55, 9, 20 * S);
  const f = stallFit(W - w - 3.5);
  if (f.n) w = W - 3.5 - f.n * f.w;
  const d = clamp(H * 0.5, 8, 14 * S);
  const bx = left ? x0 + 1.5 : -x0 - 1.5 - w;
  const px = left ? bx + w + 1 : x0 + 1;
  return { building: { x: bx, y: y0 + 2.2, w, h: d }, groups: f.n ? [group(px, f.n, f.w, y0)] : [], gravel: false, walk: null };
}

/**
 * Сельский магазин: дом под скатной крышей у одной стороны участка, рядом — гравийная площадка на 1–4 машины
 * (без разметки — у каждого места бревно-упор).
 */
function storeLot(b: Pick<TownBuilding, 'id' | 'fp'>): ShopLot {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const left = r(b, 1) < 0.5;
  const w = clamp(W * 0.55, 10, 17 * S);
  const d = clamp(H * 0.45, 8.5, 12 * S);
  const bx = left ? x0 + 1.5 : -x0 - 1.5 - w;
  const span = W - w - 3.5;
  const fit = stallFit(span);
  const n = Math.min(STORE_MAX, fit.n);
  const sw = n ? Math.min(STALL.max, span / n) : 0;
  // Места — у здания (к крыльцу ближе), остаток — к краю участка.
  const px = left ? bx + w + 1 : bx - 1 - n * sw;
  return { building: { x: bx, y: y0 + 3.2, w, h: d }, groups: n ? [group(px, n, sw, y0)] : [], gravel: true, walk: null };
}

/** Рынок: стоянка во всю ширину у улицы, проход к рядам посередине (треть ширины); ряды навесов — за стоянкой. */
function marketLot(b: Pick<TownBuilding, 'fp'>): ShopLot {
  const W = b.fp.w;
  const H = b.fp.h;
  const walk = Math.max(WALK, W * 0.3);
  return { building: null, groups: split(-W / 2 + 1.5, W / 2 - 1.5, -H / 2, walk), gravel: false, walk: { x: 0, w: walk } };
}

/** Раскладка участка со стоянкой покупателей — у магазина, сельского магазина и рынка; у прочих — null. */
export function shopLotOf(b: Pick<TownBuilding, 'id' | 'fp' | 'floors' | 'form' | 'kind'>): ShopLot | null {
  const form = formOf(b);
  if (form === 'shop') return shopLot(b);
  if (form === 'store') return storeLot(b);
  if (form === 'market') return marketLot(b);
  return null;
}

/** Дно ряда мест (дальний от улицы край), м от края участка: от него рынок и универмаг ставят остальное. */
export const STALL_ROW_DEPTH = APRON + STALL.d;

/** Места стоянки в мире — заезды (Driveway) по порядку групп и мест; у машины на месте нос — за STALL_STOP до упора. */
export function stallDriveways(b: TownBuilding): Driveway[] {
  const lot = shopLotOf(b);
  if (!lot) return [];
  const out: Driveway[] = [];
  for (const g of lot.groups) for (const s of g.stalls) out.push(drivewayAt(b, s.x, s.w, s.y1, false, STALL_STOP));
  return out;
}
