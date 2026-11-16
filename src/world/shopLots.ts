import { TOWN_SCALE } from '../config';
import { hash } from '../core/math';
import type { TownBuilding } from './entities';
import { drivewayAt, type Driveway, type LotRect } from './houseAccess';
import { formOf } from './townForms';

/**
 * Стоянки покупателей у магазина, сельского магазина и рынка и двор с рампой для грузовика: раскладка участка
 * (здание, места, проезд к рампе), общая для рисунка (render/houseArt.ts) и для игры — машины горожан заезжают на
 * свободное место и уезжают (game/shopParking.ts), грузовик заезжает во двор к рампе (game/docks.ts). Всё — по хешу
 * id дома (Art.r(i) = hash(id, i)), без генератора случайных чисел партии.
 *
 * Оси участка — как у рисунка дома: начало — в середине участка, x — вдоль улицы, улица — со стороны −y. Места —
 * поперёк улицы, машина встаёт носом от улицы; заезд — широкий, во всю группу мест: машина сворачивает с полосы прямо
 * к своему месту, выезжает задним ходом к бордюру (как у гаража, game/garages.ts). Стоянка — перед входом, проезд к
 * рампе — вдоль торца здания у края участка (с другой стороны от мест), рампа — сзади (docs/RETAIL.md, «Заезд во двор»).
 */

/**
 * Место на стоянке: машина 7,5 × 3 (CAR_SIZE) и по бокам — открыть двери; ширина 4,6–5 м (сколько мест влезает
 * по ширине площадки, остаток — поровну между ними), глубина 8,5 м — машина и метр: нос — в STALL_STOP от упора,
 * корма — ещё в 0,4 м от края места.
 */
export const STALL = { min: 4.6, max: 5, d: 8.5 } as const;
/**
 * Асфальт между краем участка и местами, м: машина с улицы доворачивает ещё до мест и въезжает в своё прямо, не
 * задевая соседних (поворот кончается в 3,8 м от бордюра — центр кузова, нос — в 2,55 м за краем участка).
 */
export const APRON = 2.5;
/** Нос стоящей машины — за столько метров до дальнего края места (упор). */
export const STALL_STOP = 0.6;
/** Сколько мест у сельского магазина — не больше. */
const STORE_MAX = 4;
/** Проход к входу между двумя группами мест (у большого магазина), м. */
const WALK = 3.2;

/** Проезд к рампе, м: грузовик 4,25 м шириной и по метру с боков. */
export const SERVICE_DRIVE = 6.4;
/**
 * Грузовик у магазина — самый длинный, что заедет во двор (world/retail.RETAIL.maxLength.shop, Грузовик II): длина,
 * ширина; r — радиус поворота середины кузова во дворе, м. По нему — глубина двора и где рампа.
 */
export const DOCK_TRUCK = { l: 15, w: 4.25, r: 7 } as const;
/** Корма у рампы — в стольких метрах от стены. */
export const RAMP_GAP = 0.3;
/**
 * Двор за зданием, где грузовик разворачивается: от стены — кузов у рампы, радиус поворота, полширины и запас у забора
 * (17,5 м). Двор мельче — грузовик заезжает по проезду передом и выезжает задним ходом (DockYard.kind 'back').
 */
export const YARD_DEPTH = DOCK_TRUCK.l / 2 + RAMP_GAP + DOCK_TRUCK.r + DOCK_TRUCK.w / 2 + 0.6;
/** Разворот во дворе от рампы к проезду: не уже стольких метров между ними. */
const U_TURN = 6;

/**
 * Двор с рампой. 'turn' — грузовик по проезду передом во двор, поворачивает за здание, сдаёт задом к рампе на задней
 * стене (wall, rx), выгружается, разворачивается к проезду и выезжает передом в просвет. 'back' — двор мелкий (или
 * рампа у торца: рынок, контора, склад): передом по проезду до рампы (нос — у y1), выезд задним ходом, как из гаража.
 */
export interface DockYard {
  kind: 'turn' | 'back';
  /** Проезд от края участка (−H/2) вглубь до y1: середина по x и ширина. */
  drive: { x: number; w: number; y1: number };
  /** 'turn': задняя стена здания (y) и середина рампы по x. 'back': y1 и x проезда. */
  wall: number;
  rx: number;
  /** С какой стороны от рампы проезд, по x: 1 — справа (+x), −1 — слева. */
  side: 1 | -1;
  /** Рисунок: бетонная площадка рампы у стены и асфальт двора (с проездом). */
  ramp: LotRect;
  pad: LotRect[];
}

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
  /** Двор с рампой для грузовика; не влез — null. */
  yard: DockYard | null;
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

/** Две группы мест в span [xa, xb] по обе стороны прохода ко входу в середине span. */
function split(xa: number, xb: number, y0: number, walk: number): StallGroup[] {
  const out: StallGroup[] = [];
  const half = (xb - xa - walk) / 2;
  const f = stallFit(half);
  if (!f.n) return out;
  const c = (xa + xb) / 2;
  // Места — от прохода к краям: остаток ширины — у краёв участка (газон).
  out.push(group(c - walk / 2 - f.n * f.w, f.n, f.w, y0));
  out.push(group(c + walk / 2, f.n, f.w, y0));
  return out;
}

/** Проезд к рампе у края участка: середина по x (side — край: −1 — левый, 1 — правый) и где кончается полоса под него. */
function driveAt(W: number, side: 1 | -1): { x: number; inner: number } {
  const edge = 0.6;
  const x = side * (W / 2 - edge - SERVICE_DRIVE / 2);
  return { x, inner: side * (W / 2 - edge - SERVICE_DRIVE - 0.9) };
}

/**
 * Двор 'turn' за зданием b (LotRect) с проездом по x = xd (side — сторона проезда от здания): рампа на задней стене,
 * где грузовик в развороте не выходит за участок; не влезает (узко, мелко) — null.
 */
function turnYard(W: number, H: number, b: LotRect, xd: number, side: 1 | -1): DockYard | null {
  const wall = b.y + b.h;
  if (H / 2 - wall < YARD_DEPTH - 1e-6) return null;
  const { l, r: R } = DOCK_TRUCK;
  // Разворачиваясь у рампы, кузов проезжает за неё на R + полдлины в сторону от проезда — не за край участка.
  const far = W / 2 - 0.5 - R - l / 2;
  const lo = Math.max(b.x + 2.8, side === 1 ? -far : xd + side * -U_TURN);
  const hi = Math.min(b.x + b.w - 2.8, side === 1 ? xd - U_TURN : far);
  if (lo > hi) return null;
  const rx = clamp(b.x + b.w / 2, lo, hi);
  const top = H / 2 - 0.4;
  // Асфальт двора — от проезда до самого дальнего места разворота.
  const swing = rx - side * (R + l / 2 + 0.3);
  const xa = Math.max(-W / 2 + 0.3, Math.min(xd - SERVICE_DRIVE / 2, swing, rx - 3.2));
  const xb = Math.min(W / 2 - 0.3, Math.max(xd + SERVICE_DRIVE / 2, swing, rx + 3.2));
  return {
    kind: 'turn',
    drive: { x: xd, w: SERVICE_DRIVE, y1: wall + l / 2 + RAMP_GAP },
    wall,
    rx,
    side,
    ramp: { x: rx - 3, y: wall - 0.2, w: 6, h: 0.5 },
    pad: [
      { x: xd - SERVICE_DRIVE / 2, y: -H / 2 + 0.3, w: SERVICE_DRIVE, h: wall + H / 2 },
      { x: xa, y: wall, w: xb - xa, h: top - wall },
    ],
  };
}

/**
 * Двор 'back': проезд по x = xd до y1, рампа — сбоку у торца здания (по x — wallX, со стороны проезда) у кормы
 * стоящего грузовика или впереди него (склад: wallX не задан — рампа на стене y1).
 */
function backYard(H: number, xd: number, y1: number, side: 1 | -1, wallX?: number): DockYard {
  const l = DOCK_TRUCK.l;
  const ramp: LotRect =
    wallX === undefined
      ? { x: xd - 3, y: y1 - 0.2, w: 6, h: 0.5 }
      : { x: side === 1 ? wallX : wallX - 1, y: y1 - 0.4 - l * 0.8, w: 1, h: l * 0.5 };
  return {
    kind: 'back',
    drive: { x: xd, w: SERVICE_DRIVE, y1 },
    wall: y1,
    rx: xd,
    side,
    ramp,
    pad: [{ x: xd - SERVICE_DRIVE / 2, y: -H / 2 + 0.3, w: SERVICE_DRIVE, h: y1 - -H / 2 - 0.3 }],
  };
}

/**
 * Раскладка магазина. Небольшой (до 3 этажей) — здание у тротуара, стоянка сбоку: мест — сколько влезает по
 * ширине (участок 35–57 м — 1–3 места), с другой стороны здания — проезд к рампе, двор с рампой — за зданием.
 * Большой (от 4 этажей) — универмаг: стоянка во всю ширину перед ним, проход ко входу посередине, проезд к рампе —
 * у края участка, здание — за стоянкой; двор за ним, если участок глубокий, иначе рампа у торца.
 */
function shopLot(b: Pick<TownBuilding, 'id' | 'fp' | 'floors'>): ShopLot {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const left = r(b, 1) < 0.5;
  // Проезд — у края, с той стороны, где здание (не через стоянку).
  const side: 1 | -1 = left ? -1 : 1;
  const dv = driveAt(W, side);
  if (b.floors >= 4) {
    const by = y0 + APRON + STALL.d + 1.8;
    const xa = left ? dv.inner : x0 + 1.5;
    const xb = left ? -x0 - 1.5 : dv.inner;
    const deep = H / 2 - by - YARD_DEPTH - 0.4;
    const d = deep >= 8 ? deep : Math.max(8, H / 2 - 2 - by);
    const building = { x: xa, y: by, w: xb - xa, h: d };
    const groups = split(xa, xb, y0, WALK);
    const yard = turnYard(W, H, building, dv.x, side) ?? backYard(H, dv.x, H / 2 - 0.8, side, left ? xa : xb);
    return { building, groups, gravel: false, walk: { x: (xa + xb) / 2, w: WALK }, yard };
  }
  const span = W - 3.5 - SERVICE_DRIVE;
  let w = clamp(W * 0.5 - SERVICE_DRIVE / 2, 9, 20 * S);
  const f = stallFit(span - w);
  if (f.n) w = span - f.n * f.w;
  const d = clamp(Math.min(H * 0.5, H - 2.2 - YARD_DEPTH - 0.4), 8, 14 * S);
  const bx = left ? dv.inner + 0 : dv.inner - w;
  const building = { x: bx, y: y0 + 2.2, w, h: d };
  const px = left ? bx + w + 1 : x0 + 1;
  const yard = turnYard(W, H, building, dv.x, side) ?? backYard(H, dv.x, Math.min(H / 2 - 0.8, building.y + d + 1), side, left ? bx : bx + w);
  return { building, groups: f.n ? [group(px, f.n, f.w, y0)] : [], gravel: false, walk: null, yard };
}

/**
 * Сельский магазин: дом под скатной крышей у одной стороны участка, рядом — гравийная площадка на 1–4 машины
 * (без разметки — у каждого места бревно-упор); с другой стороны дома — проезд во двор к рампе.
 */
function storeLot(b: Pick<TownBuilding, 'id' | 'fp'>): ShopLot {
  const W = b.fp.w;
  const H = b.fp.h;
  const y0 = -H / 2;
  const left = r(b, 1) < 0.5;
  const side: 1 | -1 = left ? -1 : 1;
  const dv = driveAt(W, side);
  const w = clamp(W * 0.55 - SERVICE_DRIVE / 2, 10, 17 * S);
  const d = clamp(Math.min(H * 0.45, H - 3.2 - YARD_DEPTH - 0.4), 8.5, 12 * S);
  const bx = left ? dv.inner : dv.inner - w;
  const span = W - w - 3.5 - SERVICE_DRIVE;
  const fit = stallFit(span);
  const n = Math.min(STORE_MAX, fit.n);
  const sw = n ? Math.min(STALL.max, span / n) : 0;
  // Места — у здания (к крыльцу ближе), остаток — к краю участка.
  const px = left ? bx + w + 1 : bx - 1 - n * sw;
  const building = { x: bx, y: y0 + 3.2, w, h: d };
  const yard = turnYard(W, H, building, dv.x, side) ?? backYard(H, dv.x, Math.min(H / 2 - 0.8, building.y + d + 1), side, left ? bx : bx + w);
  return { building, groups: n ? [group(px, n, sw, y0)] : [], gravel: true, walk: null, yard };
}

/** Павильон рынка в глубине участка: глубина, м. */
export function marketHall(H: number): number {
  return clamp(H * 0.3, 6, 10 * S);
}

/**
 * Рынок: стоянка во всю ширину у улицы, проход к рядам посередине (треть ширины); ряды навесов — за стоянкой,
 * павильон — в глубине; у края участка — проезд вдоль павильона, рампа — у его торца.
 */
function marketLot(b: Pick<TownBuilding, 'id' | 'fp'>): ShopLot {
  const W = b.fp.w;
  const H = b.fp.h;
  const side: 1 | -1 = r(b, 1) < 0.5 ? -1 : 1;
  const dv = driveAt(W, side);
  const xa = side === -1 ? dv.inner : -W / 2 + 1.5;
  const xb = side === -1 ? W / 2 - 1.5 : dv.inner;
  const walk = Math.max(WALK, (xb - xa) * 0.3);
  const yard = backYard(H, dv.x, H / 2 - 0.8, side, side === -1 ? xa : xb);
  return { building: null, groups: split(xa, xb, -H / 2, walk), gravel: false, walk: { x: (xa + xb) / 2, w: walk }, yard };
}

/** Раскладка участка со стоянкой покупателей — у магазина, сельского магазина и рынка; у прочих — null. */
export function shopLotOf(b: Pick<TownBuilding, 'id' | 'fp' | 'floors' | 'form' | 'kind'>): ShopLot | null {
  const form = formOf(b);
  if (form === 'shop') return shopLot(b);
  if (form === 'store') return storeLot(b);
  if (form === 'market') return marketLot(b);
  return null;
}

/** Контора: здание почти во весь участок — без полосы у края, где проезд к рампе у торца. */
export function officeLot(b: Pick<TownBuilding, 'id' | 'fp'>): { building: LotRect; yard: DockYard } {
  const W = b.fp.w;
  const H = b.fp.h;
  const side: 1 | -1 = r(b, 11) < 0.5 ? -1 : 1;
  const dv = driveAt(W, side);
  const xa = side === -1 ? dv.inner : -W / 2 + 1.2;
  const xb = side === -1 ? W / 2 - 1.2 : dv.inner;
  const building = { x: xa, y: -H / 2 + 1.2, w: xb - xa, h: H - 3.4 };
  return { building, yard: backYard(H, dv.x, H / 2 - 0.8, side, side === -1 ? xa : xb) };
}

/**
 * Склад: ангар в глубине участка, перед ним — площадка для грузовиков до 21 м (RETAIL.maxLength.yard, Фура): проезд
 * от улицы прямо к рампе на стене ангара (грузовик — носом к ней, выезд задним ходом). Площадка — Фура и 1,6 м.
 */
export function warehouseLot(b: Pick<TownBuilding, 'id' | 'fp'>): { hangar: LotRect; yard: DockYard } {
  const W = b.fp.w;
  const H = b.fp.h;
  const d = clamp(Math.min(H * 0.62, H - 1.2 - 22.6), 8, H - 5);
  const hangar = { x: -W / 2 + 1.2, y: H / 2 - 1.2 - d, w: W - 2.4, h: d };
  const xd = (r(b, 4) - 0.5) * (W - 10);
  return { hangar, yard: backYard(H, xd, hangar.y - 0.3, 1) };
}

/** Двор с рампой у дома: магазин, сельский магазин, рынок, контора, склад; у прочих — null. */
export function dockYardOf(b: Pick<TownBuilding, 'id' | 'fp' | 'floors' | 'form' | 'kind'>): DockYard | null {
  if (b.kind !== 'com') return null;
  const form = formOf(b);
  if (form === 'office') return officeLot(b).yard;
  if (form === 'warehouse') return warehouseLot(b).yard;
  return shopLotOf(b)?.yard ?? null;
}

/**
 * Середина здания получателя в осях участка — над ней значок груза (render/renderer.drawReceivers): магазин, контора,
 * ангар склада; у рынка — павильон в глубине. Не получатель — середина участка.
 */
export function roofCenter(b: Pick<TownBuilding, 'id' | 'fp' | 'floors' | 'form' | 'kind'>): { x: number; y: number } {
  const form = formOf(b);
  const mid = (r: LotRect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  if (form === 'office') return mid(officeLot(b).building);
  if (form === 'warehouse') return mid(warehouseLot(b).hangar);
  const lot = shopLotOf(b);
  if (lot?.building) return mid(lot.building);
  if (form === 'market') return { x: lot?.walk?.x ?? 0, y: b.fp.h / 2 - 1.2 - marketHall(b.fp.h) / 2 };
  return { x: 0, y: 0 };
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

/** Проезд к рампе в мире — заезд (Driveway) от бордюра до конца проезда; двора нет — null. */
export function dockDriveway(b: TownBuilding): Driveway | null {
  const yard = dockYardOf(b);
  return yard ? drivewayAt(b, yard.drive.x, yard.drive.w, yard.drive.y1, false, 0) : null;
}
