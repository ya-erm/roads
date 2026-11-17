import { TOWN_SCALE } from '../config';
import { hash } from '../core/math';
import type { Vec } from '../core/vec';
import type { TownBuilding } from './entities';
import { CAR_SIZE, LOT_SETBACK, lotFrame, type Driveway, type LotRect } from './houseAccess';
import { STALL_STOP } from './shopLots';
import { flatsOf, formOf, stackFolk, storeysOf } from './townForms';

/**
 * Дворовые стоянки многоквартирных домов и гаражные боксы (docs/PARKING.md, этап 1): раскладка участка, общая для
 * рисунка (render/houseArt.ts: slab, tower, garages) и для игры — машины жителей ночуют на этих местах
 * (game/carHomes.ts). Всё — по хешу id дома (Art.r(i) = hash(id, i)), без генератора случайных чисел партии.
 *
 * Оси участка — как у рисунка дома: начало — в середине участка, x — вдоль улицы, улица — со стороны −y.
 * Места — перпендикулярные, 4,6 × 8,5 ед. (≈ 2,8 × 5,1 м; единица карты — 0,6 м), проезд — 7 ед. (≈ 4,2 м).
 * Ряд мест прямо у улицы (карман перед панелькой, у её торца, у высотки) — «с улицы»: у каждого места свой заезд,
 * машина сворачивает с полосы прямо на него, как на стоянку магазина, и выезжает с него задним ходом через тротуар —
 * всё время на виду. У панелек мест во дворе нет: двор — под детскую и спортивную площадки. Места во дворе за аркой
 * (квартал, дом старого центра) — за воротами двора: машина въезжает в арку, как в гараж, и дальше «пропадает во
 * дворе» — видна уже на своём месте. Боксы — за воротами гаражного кооператива, машин в них не видно.
 */

/** Машин на квартиру многоквартирного дома (game/carHomes.ts, CAR_HOMES.perFlat). */
export const CARS_PER_FLAT = 0.15;

/**
 * Карман перед панелькой вдоль улицы: ряд мест у края участка (заезд с улицы прямо на место), за ним — тротуар вдоль
 * фасада с подъездами, дальше корпус, за корпусом — двор. Ед. (единица — 0,6 м).
 */
export const SLAB_FRONT = {
  /** Места — от края участка на столько. */
  edge: 0.6,
  /** Тротуар вдоль фасада между местами и корпусом (≈ 1,8 м). */
  walk: 3,
  /** Двор за корпусом — не мельче стольких (детская площадка), иначе — места у торца. */
  yard: 6,
  /** Мест в куске кармана — не больше; между кусками — проход от улицы к подъездам. */
  seg: 6,
  /** Проход между кусками, ед. */
  gap: 2.4,
  /** Мест — с запасом сверх машин дома: доля и не меньше стольких. */
  spare: 0.25,
  spareMin: 2,
  /** Места у торца (участок мелкий для кармана): мест — от и до. */
  end: [2, 4] as const,
} as const;

/**
 * Машин у многоквартирного дома — для раскладки мест: как в парке машин жителей (game/carHomes.ts), но по жильцам
 * проекта (townForms.stackFolk — их же дом получает при заселении), а не по TownBuilding.people: раскладка — только по
 * участку и этажам, одна и та же и до заселения (генерация, загрузка сохранения), и после.
 */
export function homeCars(b: Pick<TownBuilding, 'id' | 'kind' | 'floors' | 'form' | 'fp'>): number {
  const flats = flatsOf({ ...b, people: stackFolk(b) });
  return Math.min(62, Math.round(flats * CARS_PER_FLAT));
}

/** Место: ширина и глубина, ед. (≈ 2,8 × 5,1 м). */
export const YARD_STALL = { w: 4.6, d: 8.5 } as const;
/** Самое мелкое место (где двор неглубок): машина и полметра до упора, ед. */
export const STALL_MIN_D = CAR_SIZE.l + 0.5;
/** Проезд между рядами боксов, ед. (≈ 4,2 м). */
export const YARD_AISLE = 7;
/** Ворота двора — на столько единиц за краем участка (≈ 0,4 м; от бордюра — LOT_SETBACK + это, ≈ 3,4 м). */
export const YARD_GATE = 0.6;
/** Ширина ворот (въезда) двора, ед. (≈ 3,1 м). */
export const GATE_W = 5.2;

const S = TOWN_SCALE;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const r = (b: Pick<TownBuilding, 'id'>, i: number) => hash(b.id, i);

/** Откуда въезд на места ряда: с −y (к улице), с +y (к задней улице или проезду), с −x, с +x. */
export type Open = 'y-' | 'y+' | 'x-' | 'x+';

/**
 * Ряд мест: асфальт (pad), места (прямоугольники в осях участка), откуда въезд; direct — въезд прямо с улицы (side —
 * какой: −1 — передней, 1 — задней), иначе — через ворота двора.
 */
export interface YardRow {
  pad: LotRect;
  stalls: LotRect[];
  open: Open;
  direct: boolean;
  side: 1 | -1;
}

/** Двор: ряды мест и ворота (x — середина, w — ширина; у передней улицы); boxes — гаражные боксы (машин не видно). */
export interface YardLot {
  rows: YardRow[];
  gate: { x: number; w: number } | null;
  boxes: boolean;
}

/**
 * Ряд мест в прямоугольнике (x, y, w, h), въезд — с open: места поперёк ряда, по YARD_STALL.w, остаток ширины — поровну
 * по краям; глубина — сколько есть, не больше YARD_STALL.d. Мельче машины с запасом (STALL_MIN_D) — мест нет.
 */
export function stallRow(x: number, y: number, w: number, h: number, open: Open): LotRect[] {
  const along = open === 'y-' || open === 'y+';
  const span = along ? w : h;
  const deep = Math.min(along ? h : w, YARD_STALL.d);
  const n = Math.floor(span / YARD_STALL.w + 1e-9);
  if (n < 1 || deep < STALL_MIN_D) return [];
  const pad = (span - n * YARD_STALL.w) / 2;
  const out: LotRect[] = [];
  for (let k = 0; k < n; k++) {
    const u = pad + k * YARD_STALL.w;
    if (along) out.push({ x: x + u, y: open === 'y-' ? y : y + h - deep, w: YARD_STALL.w, h: deep });
    else out.push({ x: open === 'x-' ? x : x + w - deep, y: y + u, w: deep, h: YARD_STALL.w });
  }
  return out;
}

/** Ряд мест с асфальтом под ним; direct — у самой улицы с этой стороны. */
function row(x: number, y: number, w: number, h: number, open: Open, direct: boolean, side: 1 | -1 = -1): YardRow {
  return { pad: { x, y, w, h }, stalls: stallRow(x, y, w, h, open), open, direct, side };
}

/** Стоянка у улицы (как рисовалась стоянка parking): вдоль улицы — места с улицы; поперёк (узкая) — двор с воротами. */
function streetRow(x: number, y: number, w: number, h: number, side: 1 | -1): YardRow {
  if (w >= h) return row(x, y, w, h, side < 0 ? 'y-' : 'y+', true, side);
  return row(x, y, w, h, 'x-', false, side);
}

export type YardItem = 'play' | 'box' | 'trash';
/**
 * Наборы двора — какой достанется дому, по хешу: площадка, коробка, мусорка в разном порядке. Стоянки во дворе нет:
 * места многоэтажек — у улицы (карман, ряд у торца, у высотки).
 */
const YARD_SETS: YardItem[][] = [
  ['play', 'trash', 'box'],
  ['play', 'box', 'trash'],
  ['play', 'trash'],
  ['box', 'play', 'trash'],
  ['trash', 'play', 'box'],
];

/** Что во дворе: предмет, его прямоугольник; u0…u1 — вдоль двора, end — до какой глубины (для деревьев по краю). */
export interface YardPiece {
  item: YardItem;
  rect: LotRect;
  u0: number;
  u1: number;
  end: number;
}

/** Раскладка двора многоэтажки (x, y, w, h): вдоль длинной стороны, что влезает; across — двор поперёк (h > w). */
export interface YardPlan {
  across: boolean;
  L: number;
  D: number;
  pieces: YardPiece[];
}

/**
 * Двор многоэтажки в прямоугольнике (x, y, w, h): вдоль длинной стороны по очереди — детская площадка, спортивная
 * коробка, мусорная площадка; что не влезло — нет. Набор и порядок — по хешу дома (seed), начало — с той или другой
 * стороны.
 */
export function yardPlan(b: Pick<TownBuilding, 'id'>, x: number, y: number, w: number, h: number, seed: number): YardPlan | null {
  const across = h > w;
  const L = across ? h : w;
  const D = across ? w : h;
  if (D < 4.5 || L < 6) return null;
  const set = YARD_SETS[Math.floor(r(b, seed) * YARD_SETS.length)];
  const flip = r(b, seed + 1) < 0.5;
  const gap = 1.8;
  let cur = 0;
  const pieces: YardPiece[] = [];
  for (const item of set) {
    let iw = 0;
    let ih = 0;
    if (item === 'play') iw = ih = Math.min(D - 0.6, 10);
    else if (item === 'box') {
      ih = Math.min(D - 0.6, 12);
      iw = Math.min(ih * 1.7, 20);
      if (ih < 7.5) continue;
    } else {
      iw = 4.6;
      ih = 2.6;
    }
    if (iw < 4.5 && item === 'play') continue;
    if (cur + iw > L) continue;
    const u = flip ? L - cur - iw : cur;
    // Мусорка — у дорожки (ближний край), площадки — посередине глубины.
    const v = item === 'trash' ? 0.2 : (D - ih) / 2;
    const [ix, iy, w2, h2] = across ? [x + v, y + u, ih, iw] : [x + u, y + v, iw, ih];
    pieces.push({ item, rect: { x: ix, y: iy, w: w2, h: h2 }, u0: u, u1: u + iw, end: v + ih });
    cur += iw + gap;
  }
  return { across, L, D, pieces };
}

/**
 * Панельный дом вдоль улицы. Где участок позволяет — карман у улицы: ряд мест с заездом прямо с полосы, за ним тротуар
 * вдоль фасада с подъездами, корпус, за корпусом — двор с площадками (doors — 'front'). Мелкий участок — корпус у
 * тротуара, подъезды — во двор (doors — 'back'), места — у торца, тоже с заездом с улицы (если влезают).
 */
export interface SlabAlong {
  kind: 'along';
  /** Корпус: x, y, длина, глубина; секций (подъездов). */
  bx: number;
  by: number;
  L: number;
  bd: number;
  sections: number;
  /** Г-образный: второй корпус у боковой границы (right — у правой). */
  ell: boolean;
  right: boolean;
  /** Двор (x — от yx0 до yx1, от top — края корпуса — до задней границы участка); нет — участок мелкий. */
  yard: boolean;
  yx0: number;
  yx1: number;
  top: number;
  /** Где площадки двора (yardPlan) — начало по y. */
  yy: number;
  /** Подъезды — к улице (за карманом) или во двор. */
  doors: 'front' | 'back';
  /** Места у улицы (карман перед корпусом или у торца): куски ряда, заезд — с улицы на каждое место. */
  front: YardRow[];
  /** Дорожки от улицы к тротуару у фасада — x (между кусками кармана и по его краям). */
  paths: number[];
  /** Тротуар вдоль фасада (между карманом и корпусом): y и глубина; нет — подъезды во двор. */
  walk: { y: number; h: number } | null;
  plan: YardPlan | null;
}

/** Панельный дом на узком глубоком участке: корпус торцом к улице, сбоку — стоянка у улицы и двор за ней. */
export interface SlabDeep {
  kind: 'deep';
  bx: number;
  bw: number;
  yardX: number;
  yw: number;
  /** Стоянка у улицы (нет — сбоку не осталось места) и двор за ней. */
  lot: YardRow | null;
  cut: { x: number; w: number } | null;
  yy: number;
  plan: YardPlan | null;
}

/** Корпус панельного дома вглубь, ед.: по этажам. */
export function slabDepth(storeys: number): number {
  return (storeys >= 9 ? 14 : storeys >= 5 ? 13 : 11.5) * S;
}

/** Раскладка панельного дома (те же хеши, что у рисунка). */
export function slabPlan(b: Pick<TownBuilding, 'id' | 'fp' | 'kind' | 'floors' | 'people' | 'form'>): SlabAlong | SlabDeep {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const D = slabDepth(storeysOf(b));
  if (W >= H * 0.8 || H < 30 * S) {
    // Мест — по машинам дома с запасом (гостям и на вырост).
    const cars = homeCars(b);
    const want = cars ? cars + Math.max(SLAB_FRONT.spareMin, Math.ceil(cars * SLAB_FRONT.spare)) : 0;
    const ell = H >= 34 * S && W >= 50 * S && r(b, 3) < 0.35;
    const sections = (L: number) => Math.max(1, Math.round(L / (15 * S)));
    // Карман у улицы: места от края участка, тротуар у фасада, корпус отступает за них; двор за корпусом не мельче
    // SLAB_FRONT.yard. Люди — по участку (townForms.STACKS), не по корпусу: жителей столько же.
    const fy = y0 + SLAB_FRONT.edge;
    const fby = fy + YARD_STALL.d + SLAB_FRONT.walk;
    if (want && H / 2 - 0.6 - (fby + D) >= SLAB_FRONT.yard) {
      const bx = x0 + 1.5;
      const L = W - 3;
      const pocket = pocketRows(bx, L, fy, want);
      if (pocket.rows.length) {
        const right = r(b, 4) < 0.5;
        const top = fby + D;
        const yx0 = x0 + 1.5 + (ell && !right ? D + 1.5 : 0);
        const yx1 = -x0 - 1.5 - (ell && right ? D + 1.5 : 0);
        const yy = top + 1.6;
        const plan = yardPlan(b, yx0, yy, yx1 - yx0, H / 2 - 0.6 - yy, 30);
        const walk = { y: fy + YARD_STALL.d, h: SLAB_FRONT.walk };
        return { kind: 'along', bx, by: fby, L, bd: D, sections: sections(L), ell, right, yard: true, yx0, yx1, top, yy, doors: 'front', front: pocket.rows, paths: pocket.paths, walk, plan };
      }
    }
    // Мелкий участок: корпус у тротуара, подъезды — во двор (к нему — дорожкой), места — у торца с заезда с улицы.
    const set = clamp(H - D - 4, 1, 4);
    const bd = Math.min(D, H - set - 1);
    const by = y0 + set;
    const top = by + bd;
    const yard = H / 2 - top > 4.5;
    const cols = clamp(want, SLAB_FRONT.end[0], SLAB_FRONT.end[1]);
    const E = cols * YARD_STALL.w + 1.6;
    const end = want > 0 && W - 3 - E >= 24 * S;
    const endLeft = r(b, 9) < 0.5;
    const bx = x0 + 1.5 + (end && endLeft ? E : 0);
    const L = W - 3 - (end ? E : 0);
    // Второй корпус (Г) — у другого торца, не у мест.
    const right = end ? endLeft : r(b, 4) < 0.5;
    const yx0 = x0 + 1.5 + (ell && !right ? bd + 1.5 : 0);
    const yx1 = -x0 - 1.5 - (ell && right ? bd + 1.5 : 0);
    const front: YardRow[] = [];
    const paths: number[] = [];
    if (end) {
      const rx = endLeft ? x0 + 1.5 : -x0 - 1.5 - cols * YARD_STALL.w;
      front.push(row(rx, y0 + SLAB_FRONT.edge, cols * YARD_STALL.w, Math.min(YARD_STALL.d, H - 2), 'y-', true, -1));
      // Дорожка во двор — между местами и торцом.
      if (yard) paths.push(endLeft ? bx - 0.8 : bx + L + 0.8);
    }
    const yy = top + 3.2;
    const plan = yard ? yardPlan(b, yx0, yy, yx1 - yx0, H / 2 - 0.6 - yy, 30) : null;
    return { kind: 'along', bx, by, L, bd, sections: sections(L), ell, right, yard, yx0, yx1, top, yy, doors: 'back', front, paths, walk: null, plan };
  }
  const left = r(b, 1) < 0.5;
  const bw = Math.min(D, W - 6);
  const bx = left ? x0 + 1.5 : -x0 - 1.5 - bw;
  const yardX = left ? bx + bw + 1.5 : x0 + 1.5;
  const yw = W - bw - 4.5;
  if (yw <= 4) return { kind: 'deep', bx, bw, yardX, yw, lot: null, cut: null, yy: 0, plan: null };
  const ph = Math.min(H * 0.35, 14);
  const lot = streetRow(yardX, y0 + 2, yw, Math.min(ph, YARD_STALL.d), -1);
  const cut = lot.direct && lot.stalls.length ? spanOf(lot.stalls) : { x: yardX + yw / 2, w: Math.min(GATE_W, yw - 1) };
  const yy = y0 + 2 + ph + 1.5;
  // Двор за стоянкой — без стоянки: проехать к нему можно только через места у улицы.
  return { kind: 'deep', bx, bw, yardX, yw, lot, cut, yy, plan: yardPlan(b, yardX, yy, yw, H / 2 - 1 - yy, 30) };
}

/**
 * Карман у улицы вдоль фасада (от x длиной len, места от y вглубь): want мест или сколько влезает, кусками не длиннее
 * SLAB_FRONT.seg мест, между кусками — проход SLAB_FRONT.gap; всё — посередине фасада. paths — дорожки от улицы к
 * фасаду: в проходах и по краям кармана (если там есть место).
 */
export function pocketRows(x: number, len: number, y: number, want: number): { rows: YardRow[]; paths: number[] } {
  const { seg, gap } = SLAB_FRONT;
  const w = YARD_STALL.w;
  const width = (k: number) => k * w + (Math.ceil(k / seg) - 1) * gap;
  let n = Math.floor(want);
  while (n > 0 && width(n) > len - 2) n--;
  if (n < 1) return { rows: [], paths: [] };
  const segs = Math.ceil(n / seg);
  let cx = x + (len - width(n)) / 2;
  const rows: YardRow[] = [];
  const paths: number[] = [];
  if (cx - x >= 2) paths.push(cx - 1.2);
  for (let i = 0; i < segs; i++) {
    const k = Math.floor(n / segs) + (i < n % segs ? 1 : 0);
    rows.push(row(cx, y, k * w, YARD_STALL.d, 'y-', true, -1));
    cx += k * w;
    if (i < segs - 1) {
      paths.push(cx + gap / 2);
      cx += gap;
    }
  }
  if (x + len - cx >= 2) paths.push(cx + 1.2);
  return { rows, paths };
}

/** Середина и ширина ряда мест вдоль x — съезд с улицы во всю его ширину. */
function spanOf(stalls: LotRect[]): { x: number; w: number } {
  const a = stalls[0].x;
  const z = stalls[stalls.length - 1].x + stalls[stalls.length - 1].w;
  return { x: (a + z) / 2, w: z - a };
}

/** Высотка: башня (середина, сторона), стоянки у улицы (у участка от улицы до улицы — у обеих), двор. */
export interface TowerPlan {
  /** Участок квартала от улицы до улицы: башня посреди общего двора. */
  block: boolean;
  T: number;
  tx: number;
  ty: number;
  left: boolean;
  rows: YardRow[];
  cuts: { x: number; w: number; side: 1 | -1 }[];
  /** Ряд деревьев у стоянок (block) или вдоль задней границы — y; двор — прямоугольник. */
  yard: LotRect | null;
  plan: YardPlan | null;
  /** Небольшой участок: стоянка и площадка рядом с башней — левый край и ширина. */
  px: number;
  rest: number;
}

export function towerPlan(b: Pick<TownBuilding, 'id' | 'fp'>): TowerPlan {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const left = r(b, 1) < 0.5;
  if (H >= 40 * S && W >= 40 * S) {
    const T = clamp(Math.min(W, H) * 0.42, 20, 28 * S);
    const tx = (left ? -1 : 1) * Math.min(W / 2 - T / 2 - 4, W * 0.18);
    const pw = Math.min(W * 0.45, 30);
    const fx = left ? -x0 - 2 - pw : x0 + 2;
    const rx = left ? x0 + 2 : -x0 - 2 - pw;
    const front = streetRow(fx, y0 + 1.2, pw, YARD_STALL.d, -1);
    const back = streetRow(rx, H / 2 - 1.2 - YARD_STALL.d, pw, YARD_STALL.d, 1);
    const cuts = [front, back].map((rw) => ({ ...(rw.stalls.length ? spanOf(rw.stalls) : { x: rw.pad.x + rw.pad.w / 2, w: GATE_W }), side: rw.side }));
    const cx0 = left ? tx + T / 2 + 3 : x0 + 2;
    const cx1 = left ? -x0 - 2 : tx - T / 2 - 3;
    const yard = { x: cx0, y: y0 + 14.5, w: cx1 - cx0, h: H - 29 };
    // Двор посреди квартала — без стоянки: проезда к нему нет (стоянки — у улиц).
    const plan = yardPlan(b, yard.x, yard.y, yard.w, yard.h, 50);
    return { block: true, T, tx, ty: -T / 2, left, rows: [front, back], cuts, yard, plan, px: 0, rest: 0 };
  }
  const T = clamp(Math.min(W, H) * 0.7 + 4, 16, 24 * S);
  const tx = left ? x0 + 2 + T / 2 + 2 : -x0 - 2 - T / 2 - 2;
  const ty = clamp(H / 2 - 1.5 - T, y0 + 1.5, y0 + 6);
  const rest = W - T - 8;
  const px = left ? tx + T / 2 + 3 : x0 + 2;
  if (rest <= 6) return { block: false, T, tx, ty, left, rows: [], cuts: [], yard: null, plan: null, px, rest };
  const lot = streetRow(px, y0 + 1.2, rest, Math.min(YARD_STALL.d, H - 3), -1);
  const cut = lot.direct && lot.stalls.length ? spanOf(lot.stalls) : { x: px + rest / 2, w: Math.min(GATE_W, rest - 1) };
  return { block: false, T, tx, ty, left, rows: [lot], cuts: [{ ...cut, side: -1 }], yard: null, plan: null, px, rest };
}

/**
 * Квартал старого центра (courtyard): корпуса по периметру (x0…x1, y0…y1 — края застройки, d — глубина корпуса), П или
 * замкнутый «колодец» (closed), у части — Г (ell: только одно боковое крыло); арка в лицевом корпусе — въезд во двор
 * (там ворота двора). Во дворе — газон с деревом и, где двор глубже места, проезда и газона, — ряд мест у дальнего края.
 */
export interface CourtyardPlan {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  d: number;
  closed: boolean;
  leftWing: boolean;
  rightWing: boolean;
  arch: { x: number; w: number };
  lawn: { x: number; y: number } | null;
  row: YardRow | null;
}

export function courtyardPlan(b: Pick<TownBuilding, 'id' | 'fp'>): CourtyardPlan {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2 + 0.4;
  const y0 = -H / 2 + 0.5;
  const x1 = W / 2 - 0.4;
  const y1 = H / 2 - 0.5;
  const d = clamp(Math.min(W, H) * 0.28, 7, 10 * S);
  const closed = H >= 3.1 * d && r(b, 1) < 0.55;
  const ell = !closed && r(b, 2) < 0.25;
  const yy0 = y0 + d;
  const yy1 = closed ? y1 - d : y1;
  const sideH = yy1 - yy0;
  const leftWing = sideH > 1 && (!ell || r(b, 7) < 0.5);
  const rightWing = sideH > 1 && (!ell || r(b, 7) >= 0.5);
  const ix0 = leftWing ? x0 + d : x0;
  const ix1 = rightWing ? x1 - d : x1;
  // Арка — шире машины (4,6 ед., ≈ 2,8 м).
  const arch = { x: (r(b, 8) - 0.5) * (x1 - x0) * 0.5, w: YARD_STALL.w };
  const cx = (x0 + x1) / 2;
  let park: YardRow | null = null;
  let lawn: { x: number; y: number } | null = { x: cx, y: (yy0 + yy1) / 2 };
  if (sideH >= YARD_STALL.d + YARD_AISLE + 4 && ix1 - ix0 >= 2 * YARD_STALL.w + 2) {
    const ry = yy1 - 0.4 - YARD_STALL.d;
    park = row(ix0 + 1, ry, ix1 - ix0 - 2, YARD_STALL.d, 'y-', false);
    // Газон с деревом — между аркой и проездом к местам; не влезает — без него.
    const room = ry - YARD_AISLE - yy0;
    lawn = room >= 3.2 * S + 1 ? { x: cx, y: yy0 + room / 2 } : null;
  }
  return { x0, y0, x1, y1, d, closed, leftWing, rightWing, arch, lawn, row: park };
}

/**
 * Дом старого центра (townhouse): корпус во всю ширину участка у тротуара (глубина d), за ним — мощёный двор с
 * флигелем у одной боковой границы (wing; нет — двор мелкий). У глубокого двора с другой стороны — ряд мест у задней
 * границы, въезд — аркой в корпусе (там ворота двора); иначе там дерево.
 */
export interface TownhousePlan {
  d: number;
  back: number;
  rest: number;
  door: number;
  wing: { x: number; y: number; w: number; h: number } | null;
  tree: { x: number; y: number } | null;
  row: YardRow | null;
  arch: { x: number; w: number } | null;
}

export function townhousePlan(b: Pick<TownBuilding, 'id' | 'fp' | 'kind' | 'floors' | 'people' | 'form'>): TownhousePlan {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const s = storeysOf(b);
  const d = clamp(H * 0.5 + s * 0.6, 9, Math.min(14.5 * S, H - 2));
  const back = y0 + 0.5 + d;
  const rest = H / 2 - back - 0.6;
  const door = (r(b, 9) - 0.5) * W * 0.4;
  if (rest <= 4) return { d, back, rest, door, wing: null, tree: null, row: null, arch: null };
  const fw = clamp(W * 0.3, 5.5, 9 * S);
  const left = r(b, 1) < 0.5;
  const fx = left ? x0 + 0.6 : -x0 - 0.6 - fw;
  const fd = Math.min(rest - 0.6, (6 + r(b, 2) * 2) * S);
  const wing = { x: fx, y: H / 2 - 0.6 - fd, w: fw, h: fd };
  // Места — с другой стороны от флигеля, у задней границы; арка — у той же боковой границы, подальше от двери.
  const sx0 = left ? fx + fw + 1 : x0 + 1;
  const sx1 = left ? -x0 - 1 : fx - 1;
  const park = rest >= YARD_STALL.d + 1 ? row(sx0, H / 2 - 0.6 - YARD_STALL.d, sx1 - sx0, YARD_STALL.d, 'y-', false) : null;
  const ax = left ? -x0 - 1.2 - YARD_STALL.w / 2 : x0 + 1.2 + YARD_STALL.w / 2;
  if (park?.stalls.length && Math.abs(ax - door) > YARD_STALL.w / 2 + 1.6) {
    return { d, back, rest, door, wing, tree: null, row: park, arch: { x: ax, w: YARD_STALL.w } };
  }
  return { d, back, rest, door, wing, tree: { x: left ? -x0 - 3.2 : x0 + 3.2, y: back + rest * 0.55 }, row: null, arch: null };
}

/** Гаражные боксы: ряды (y и какие места есть — x левого края), бокс — ширина и глубина; въезд — с торца участка. */
export interface GaragesPlan {
  bw: number;
  bd: number;
  rows: { y: number; xs: number[] }[];
  gate: { x: number; w: number };
}

/**
 * Гаражи: ряды боксов вдоль проезда, бокс — под машину (YARD_STALL), на мелком участке старых сохранений — короче;
 * два ряда — если между ними остаётся проезд (YARD_AISLE). Въезд с улицы — у торца участка, боксы переднего ряда
 * напротив него не ставятся.
 */
export function garagesPlan(b: Pick<TownBuilding, 'id' | 'fp'>): GaragesPlan {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const bw = YARD_STALL.w;
  const bd = Math.min(YARD_STALL.d, H - 2);
  const n = Math.floor((W - 2) / bw);
  const two = H >= 2 * bd + YARD_AISLE + 2;
  const gx = r(b, 3) < 0.5 ? x0 + 3 : -x0 - 3;
  const ys = two ? [y0 + 1, H / 2 - 1 - bd] : [H / 2 - 1 - bd];
  const rows = ys.map((y, i) => {
    const xs: number[] = [];
    for (let k = 0; k < n; k++) {
      const x = x0 + 1 + k * bw;
      if (two && i === 0 && x < gx + GATE_W / 2 + 0.4 && x + bw > gx - GATE_W / 2 - 0.4) continue;
      xs.push(x);
    }
    return { y, xs };
  });
  return { bw, bd, rows, gate: { x: gx, w: GATE_W } };
}

/** Двор дома (места и ворота) — у панельки, высотки и гаражей; у прочих — null. */
export function yardLotOf(b: TownBuilding): YardLot | null {
  const form = formOf(b);
  if (form === 'slab' && b.kind === 'res') {
    // Места панельки — только у улицы, с заездом прямо на место: ворот двора у неё нет.
    const p = slabPlan(b);
    const rows = (p.kind === 'along' ? p.front : p.lot ? [p.lot] : []).filter((x) => x.direct && x.stalls.length);
    return rows.length ? { rows, gate: null, boxes: false } : null;
  }
  if (form === 'tower' && b.kind === 'res') {
    // Стоянки высотки — у улиц, с заездом на место (узкий участок, где ряд поперёк, — без мест: ворот там нет).
    const rows = towerPlan(b).rows.filter((x) => x.direct && x.stalls.length);
    return rows.length ? { rows, gate: null, boxes: false } : null;
  }
  if (form === 'townhouse' && b.kind === 'res') {
    const p = townhousePlan(b);
    return p.row && p.arch ? { rows: [p.row], gate: p.arch, boxes: false } : null;
  }
  if (form === 'courtyard' && b.kind === 'res') {
    const p = courtyardPlan(b);
    return p.row?.stalls.length ? { rows: [p.row], gate: p.arch, boxes: false } : null;
  }
  if (form === 'garages') {
    const p = garagesPlan(b);
    const rows: YardRow[] = p.rows.map((x) => ({
      pad: { x: -b.fp.w / 2, y: x.y, w: b.fp.w, h: p.bd },
      stalls: x.xs.map((bx) => ({ x: bx, y: x.y, w: p.bw, h: p.bd })),
      open: 'y-',
      direct: false,
      side: -1,
    }));
    return rows.some((x) => x.stalls.length) ? { rows, gate: p.gate, boxes: true } : null;
  }
  return null;
}

/**
 * Заезд в мире по оси x участка с улицы side (−1 — передней, 1 — задней) до yFar (ворота или дальний край места):
 * от бордюра (край участка плюс LOT_SETBACK) — внутрь участка. Машина стоит носом к yFar, нос — за stop до него.
 */
export function driveFrom(b: Pick<TownBuilding, 'id' | 'fp' | 'face'>, x: number, w: number, side: 1 | -1, yFar: number, garage: boolean, stop: number, L: number): Driveway {
  const at = lotFrame(b);
  const curb = at(x, side * (b.fp.h / 2 + LOT_SETBACK));
  const gate = at(x, yFar);
  const len = Math.hypot(gate.x - curb.x, gate.y - curb.y);
  const dir = { x: (gate.x - curb.x) / len, y: (gate.y - curb.y) / len };
  const spotY = yFar + side * (L / 2 + stop);
  return { building: b.id, curb, gate, dir, width: w, spot: at(x, spotY), garage };
}

/** Место двора в мире: где стоит машина (нос, курс), заезд с улицы (у мест с улицы), ряд и номер в ряду. */
export interface YardSpot {
  nose: Vec;
  dir: Vec;
  drive: Driveway | null;
  row: number;
  k: number;
}

/** Места двора в мире и ворота (заезд через них, Driveway.garage = true); L — длина машины. */
export function yardSpots(b: TownBuilding, lot: YardLot, L: number): { gate: Driveway | null; spots: YardSpot[] } {
  const at = lotFrame(b);
  const gate = lot.gate ? driveFrom(b, lot.gate.x, lot.gate.w, -1, -b.fp.h / 2 + YARD_GATE, true, 0.4, L) : null;
  const spots: YardSpot[] = [];
  lot.rows.forEach((rw, i) =>
    rw.stalls.forEach((s, k) => {
      // Нос — у дальнего от въезда края места (за STALL_STOP до упора), курс — от въезда вглубь.
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const [fx, fy] = rw.open === 'y-' ? [cx, s.y + s.h - STALL_STOP] : rw.open === 'y+' ? [cx, s.y + STALL_STOP] : rw.open === 'x-' ? [s.x + s.w - STALL_STOP, cy] : [s.x + STALL_STOP, cy];
      const [bx, by] = rw.open === 'y-' ? [cx, s.y] : rw.open === 'y+' ? [cx, s.y + s.h] : rw.open === 'x-' ? [s.x, cy] : [s.x + s.w, cy];
      const nose = at(fx, fy);
      const back = at(bx, by);
      const l = Math.hypot(nose.x - back.x, nose.y - back.y) || 1;
      const dir = { x: (nose.x - back.x) / l, y: (nose.y - back.y) / l };
      const yFar = rw.open === 'y-' ? s.y + s.h : s.y;
      const drive = rw.direct ? driveFrom(b, cx, s.w, rw.side, yFar, false, STALL_STOP, L) : null;
      spots.push({ nose, dir, drive, row: i, k });
    }),
  );
  return { gate, spots };
}
