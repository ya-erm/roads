import { TOWN_SCALE } from '../config';
import { hash } from '../core/math';
import type { TownBuilding } from './entities';
import { CAR_SIZE, drivewayAt, type Driveway, type LotRect } from './houseAccess';
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
 * Место на стоянке: машина 7,5 × 3,6 (CAR_SIZE) и по бокам — открыть двери; ширина 4,6–5 м (сколько мест влезает
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

/** Проезд к рампе с запасом для выноса передка и кормы полуприцепа на повороте. */
export const SERVICE_DRIVE = 11;
/**
 * Грузовик у магазина — самый длинный, что заедет во двор (world/retail.RETAIL.maxLength.shop, Грузовик II): длина,
 * ширина; r — радиус поворота середины кузова во дворе, м. По нему — глубина двора и где рампа.
 */
export const DOCK_TRUCK = { l: 15, w: 4.6, r: 7 } as const;
/** Корма у рампы — в стольких метрах от стены. */
export const RAMP_GAP = 0.3;
/**
 * Двор за зданием, где грузовик разворачивается: от стены — кузов у рампы, радиус поворота, полширины и запас у забора
 * (около 20,3 ед. для полуприцепа). Учитывается диагональный вынос угла кузова на дуге, не только его ось.
 * Двор мельче — грузовик заезжает по проезду передом и выезжает задним ходом (DockYard.kind 'back').
 */
export const YARD_DEPTH = DOCK_TRUCK.l / 2 + RAMP_GAP + Math.hypot(DOCK_TRUCK.r + DOCK_TRUCK.w / 2, DOCK_TRUCK.l / 2) + 0.6;
/** Разворот во дворе от рампы к проезду: две четверть-дуги радиуса грузовика. */

/**
 * Двор с рампой. 'turn' — грузовик по проезду передом во двор, поворачивает за здание, сдаёт задом к рампе на задней
 * стене (wall, rx), выгружается, разворачивается к проезду и выезжает передом в просвет. 'back' — двор мелкий (или
 * рампа у торца: рынок, контора, склад): передом по проезду до рампы (нос — у y1), выезд задним ходом, как из гаража.
 * 'through' — сквозной проезд (АЗС, оптовая база): въезд у одного края участка, поворот на проезд вдоль улицы на
 * глубине wall, остановка у рампы (rx — середина кузова), поворот к выезду у другого края и передом в поток — без
 * заднего хода. Участок симметричен: какой из двух проездов въезд, решает ход ближней полосы (game/docks.ts).
 */
export interface DockYard {
  kind: 'turn' | 'back' | 'through';
  /** Проезд от края участка (−H/2) вглубь до y1: середина по x и ширина. 'through' — проезд у левого края (−x). */
  drive: { x: number; w: number; y1: number };
  /** 'through': второй проезд — у правого края (+x), до той же глубины. */
  exit?: { x: number; w: number; y1: number };
  /** 'turn': задняя стена здания (y) и середина рампы по x. 'back': y1 и x проезда. 'through': ось проезда вдоль улицы. */
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
  /** Вторая рампа со своим проездом — у рынка, с другой стороны участка: два грузовика разгружаются сразу. */
  yard2?: DockYard;
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
    const yard = backYard(H, dv.x, Math.min(H / 2 - 0.8, y0 + 30), side, left ? xa : xb);
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
  const yard = backYard(H, dv.x, Math.min(H / 2 - 0.8, Math.max(building.y + d, y0 + 30)), side, left ? bx : bx + w);
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
  const yard = backYard(H, dv.x, Math.min(H / 2 - 0.8, Math.max(building.y + d, y0 + 30)), side, left ? bx : bx + w);
  return { building, groups: n ? [group(px, n, sw, y0)] : [], gravel: true, walk: null, yard };
}

/** Павильон рынка в глубине участка: глубина, м. */
export function marketHall(H: number): number {
  return clamp(H * 0.3, 6, 10 * S);
}

/**
 * Рынок: стоянка во всю ширину у улицы, проход к рядам посередине (треть ширины); ряды навесов — за стоянкой,
 * павильон — в глубине; у обоих краёв участка — проезды вдоль павильона, рампы — у его торцов (docs/RETAIL.md: рынок
 * принимает вдвое больше магазина — две рампы, два грузовика сразу). Первая рампа — со стороны по хешу дома.
 */
function marketLot(b: Pick<TownBuilding, 'id' | 'fp'>): ShopLot {
  const W = b.fp.w;
  const H = b.fp.h;
  const side: 1 | -1 = r(b, 1) < 0.5 ? -1 : 1;
  const other = -side as 1 | -1;
  const dv = driveAt(W, side);
  const dv2 = driveAt(W, other);
  const xa = Math.min(dv.inner, dv2.inner);
  const xb = Math.max(dv.inner, dv2.inner);
  const walk = Math.max(WALK, (xb - xa) * 0.3);
  const yard = backYard(H, dv.x, H / 2 - 0.8, side, side === -1 ? xa : xb);
  const yard2 = backYard(H, dv2.x, H / 2 - 0.8, other, other === -1 ? xa : xb);
  return { building: null, groups: split(xa, xb, -H / 2, walk), gravel: false, walk: { x: (xa + xb) / 2, w: walk }, yard, yard2 };
}

/** Сквозной проезд: радиус поворота середины кузова с проезда у края на проезд вдоль улицы, м. */
export const THROUGH_R = 7;
/** Ось проезда вдоль улицы — на столько метров от края участка: въехавший с улицы грузовик (21 м) успевает выпрямиться. */
export const THROUGH_LANE = 15.5;
/** При повороте фуры 21×4,7 её корма проходит дальше оси проезда, чем половина ширины кузова. */
export const THROUGH_MARGIN = 8.2;
/** Запас за поперечным проездом на вынос кормы перед поворотом к выезду. */
export const THROUGH_SWEEP = 7.5;

/**
 * Сквозной двор (DockYard 'through') на участке W × H: проезды у обоих краёв участка, ось проезда вдоль улицы — в
 * THROUGH_LANE от улицы, середина кузова у рампы — по середине участка (rx = 0); ramp — рисунок рампы.
 */
function throughYard(W: number, H: number, ramp: LotRect): DockYard {
  const xe = W / 2 - THROUGH_MARGIN;
  const lane = -H / 2 + THROUGH_LANE;
  const y0 = -H / 2 + 0.3;
  return {
    kind: 'through',
    drive: { x: -xe, w: SERVICE_DRIVE, y1: lane },
    exit: { x: xe, w: SERVICE_DRIVE, y1: lane },
    wall: lane,
    rx: 0,
    side: 1,
    ramp,
    pad: [{ x: -W / 2 + 0.3, y: y0, w: W - 0.6, h: Math.min(H / 2 - 0.3, lane + THROUGH_SWEEP) - y0 }],
  };
}

/** АЗС: навес с колонками у улицы, между двумя проездами; за ним — проезд бензовоза и магазинчик в глубине. */
export interface FuelLot {
  canopy: LotRect;
  /** Островки с колонками под навесом. */
  islands: LotRect[];
  building: LotRect;
  /** Люки подземных ёмкостей — у края проезда, сбоку от стоящего бензовоза (рампа). */
  tanks: LotRect;
  yard: DockYard;
}

/**
 * АЗС (docs/RETAIL.md, этап 3): бензовоз до 21 м (Фура) въезжает у одного края участка, проходит за навесом вдоль
 * улицы, сливает топливо у люков подземных ёмкостей и выезжает у другого края — передом, без заднего хода.
 */
export function fuelLot(b: Pick<TownBuilding, 'id' | 'fp'>): FuelLot {
  const W = b.fp.w;
  const H = b.fp.h;
  const y0 = -H / 2;
  const lane = y0 + THROUGH_LANE;
  const inner = Math.max(1.5, W / 2 - THROUGH_MARGIN - SERVICE_DRIVE / 2 - 1.2);
  const canopy = { x: -inner, y: y0 + 1.6, w: inner * 2, h: lane - DOCK_TRUCK.w / 2 - 1.4 - (y0 + 1.6) };
  const n = clamp(Math.floor(canopy.w / 7), 1, 4);
  const islands: LotRect[] = [];
  for (let k = 0; k < n; k++) islands.push({ x: canopy.x + (canopy.w * (k + 0.5)) / n - 0.7, y: canopy.y + 1.4, w: 1.4, h: canopy.h - 2.8 });
  const tanks = { x: -3.6, y: lane + DOCK_TRUCK.w / 2 + 0.3, w: 7.2, h: 1.2 };
  const by = Math.max(tanks.y + tanks.h + 1.2, lane + THROUGH_SWEEP + 0.4);
  const bw = clamp(W * 0.45, 10, 16 * S);
  const building = { x: -bw / 2 + (r(b, 2) - 0.5) * (W - bw - 4), y: by, w: bw, h: clamp(H / 2 - 1.4 - by, 6, 9 * S) };
  return { canopy, islands, building, tanks, yard: throughYard(W, H, tanks) };
}

/** Оптовая база: ангар во всю ширину в глубине, перед ним — сквозной проезд для фуры с рампой вдоль стены ангара. */
export function depotLot(b: Pick<TownBuilding, 'id' | 'fp'>): { hangar: LotRect; yard: DockYard; containers: LotRect[] } {
  const W = b.fp.w;
  const H = b.fp.h;
  const lane = -H / 2 + THROUGH_LANE;
  const top = lane + THROUGH_SWEEP + 0.4;
  const hangar = { x: -W / 2 + 1.2, y: top, w: W - 2.4, h: Math.max(8, H / 2 - 1.2 - top) };
  const ramp = { x: -7, y: top - 0.9, w: 14, h: 0.9 };
  // Только центральная часть у улицы: края нужны длинной фуре для поворота и выноса прицепа.
  const half = Math.max(0, W / 2 - THROUGH_MARGIN - THROUGH_R - 11.5);
  const count = Math.min(3, Math.floor(half * 2 / 7.5));
  const containers = Array.from({ length: count }, (_, k) => ({ x: (k - (count - 1) / 2) * 7.5 - 3.2, y: -H / 2 + 2, w: 6.4, h: 2.6 }));
  return { hangar, yard: throughYard(W, H, ramp), containers };
}

/** Участок оптовой базы — не уже стольких метров: фура (21) на прямом проезде между поворотами к краям. */
export const DEPOT_MIN_W = 21 + 2 * THROUGH_R + 2 * THROUGH_MARGIN + 1;

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
export function warehouseLot(b: Pick<TownBuilding, 'id' | 'fp' | 'dockApproach'>): { hangar: LotRect; yard: DockYard } {
  const W = b.fp.w;
  const H = b.fp.h;
  if (b.dockApproach === 'parallel') {
    const top = -H / 2 + THROUGH_LANE + THROUGH_SWEEP + 0.4;
    const hangar = { x: -W / 2 + 1.2, y: top, w: W - 2.4, h: Math.max(8, H / 2 - 1.2 - top) };
    return { hangar, yard: throughYard(W, H, { x: -7, y: top - 0.9, w: 14, h: 0.9 }) };
  }
  const d = clamp(Math.min(H * 0.62, H - 1.2 - 22.6), 8, H - 5);
  const hangar = { x: -W / 2 + 1.2, y: H / 2 - 1.2 - d, w: W - 2.4, h: d };
  const xd = (r(b, 4) - 0.5) * (W - 10);
  return { hangar, yard: backYard(H, xd, hangar.y - 0.3, 1) };
}

/** Двор с рампой у дома: магазин, сельский магазин, рынок, контора, склад, АЗС, оптовая база; у прочих — null. */
export function dockYardOf(b: Pick<TownBuilding, 'id' | 'fp' | 'floors' | 'form' | 'kind' | 'dockApproach'>): DockYard | null {
  return dockYardsOf(b)[0] ?? null;
}

/** Все рампы дома со своими проездами: у рынка — две, у прочих получателей — одна, у остальных домов — ни одной. */
export function dockYardsOf(b: Pick<TownBuilding, 'id' | 'fp' | 'floors' | 'form' | 'kind' | 'dockApproach'>): DockYard[] {
  if (b.kind !== 'com') return [];
  const form = formOf(b);
  if (form === 'office') return [officeLot(b).yard];
  if (form === 'warehouse') return [warehouseLot(b).yard];
  if (form === 'fuel') return [fuelLot(b).yard];
  if (form === 'depot') return [depotLot(b).yard];
  const lot = shopLotOf(b);
  if (!lot?.yard) return [];
  return lot.yard2 ? [lot.yard, lot.yard2] : [lot.yard];
}

/** Твёрдые препятствия грузового двора в осях участка; навес АЗС не препятствие, его колонками служат островки. */
export function dockSolidsOf(b: Pick<TownBuilding, 'id' | 'fp' | 'floors' | 'form' | 'kind' | 'dockApproach'>, parkedCars = false): LotRect[] {
  const form = formOf(b);
  let solids: LotRect[] = [];
  if (form === 'fuel') { const p = fuelLot(b); solids = [p.building, ...p.islands]; }
  else if (form === 'depot') { const p = depotLot(b); solids = [p.hangar, ...p.containers]; }
  else if (form === 'warehouse') solids = [warehouseLot(b).hangar];
  else if (form === 'office') solids = [officeLot(b).building];
  else {
    const lot = shopLotOf(b);
    if (lot?.building) solids.push(lot.building);
    if (form === 'market' && lot?.yard && lot.yard2) {
      const yards = [lot.yard, lot.yard2];
      const left = yards.find((y) => y.side === -1)!;
      const right = yards.find((y) => y.side === 1)!;
      const xa = left.drive.x + left.drive.w / 2 + 0.9;
      const xb = right.drive.x - right.drive.w / 2 - 0.9;
      const hd = marketHall(b.fp.h);
      solids.push({ x: xa, y: b.fp.h / 2 - 1.2 - hd, w: xb - xa, h: hd });
    }
    if (parkedCars && lot) for (const s of lot.groups.flatMap((g) => g.stalls)) solids.push({ x: s.x - CAR_SIZE.w / 2, y: s.y1 - STALL_STOP - CAR_SIZE.l, w: CAR_SIZE.w, h: CAR_SIZE.l });
  }
  return solids;
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
  if (form === 'fuel') return mid(fuelLot(b).building);
  if (form === 'depot') return mid(depotLot(b).hangar);
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
export function dockDriveway(b: TownBuilding, yard: DockYard | null = dockYardOf(b)): Driveway | null {
  return yard ? drivewayAt(b, yard.drive.x, yard.drive.w, yard.drive.y1, false, 0) : null;
}

/** Второй проезд сквозного двора ('through') в мире — у правого края участка; у других дворов — null. */
export function exitDriveway(b: TownBuilding, yard: DockYard): Driveway | null {
  return yard.exit ? drivewayAt(b, yard.exit.x, yard.exit.w, yard.exit.y1, false, 0) : null;
}
