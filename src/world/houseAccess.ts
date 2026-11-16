import { hash } from '../core/math';
import type { Vec } from '../core/vec';
import type { LaneNet } from '../lanes/model';
import type { TownBuilding } from './entities';
import { formOf, storeysOf } from './townForms';

/**
 * Заезды частных домов: геометрия участка с домом и гаражом, общая для рисунка (render/houseArt.ts) и для игры —
 * машины жителей смогут выезжать из гаража и заезжать в него (drivewayOf, drivewayLink). Всё — по хешу id дома,
 * без генератора случайных чисел партии.
 *
 * Оси участка (как у рисунка дома): начало — в середине участка, x — вдоль улицы, улица — со стороны −y (дом с
 * face = 1 повёрнут на пол-оборота).
 */

/** Легковая машина жителя (game.CAR_SPEC): длина и ширина, м. */
export const CAR_SIZE = { l: 7, w: 4 } as const;
/** Участок стоит в стольких метрах от края полотна (worldgen.fillStreet): между ними — тротуар и газон. */
export const LOT_SETBACK = 5;
/**
 * Гараж частного дома — в масштабе машины, как и дом: шире её в 1,6 раза (по бокам — место открыть двери), длиннее
 * на треть (верстак, полки), ширина и глубина, м.
 */
export const GARAGE = { w: CAR_SIZE.w * 1.6, d: CAR_SIZE.l + 2.6 } as const;
/** Ширина заезда, м — шире машины. */
export const DRIVE_W = CAR_SIZE.w + 1.2;
/** Частный дом по улице (около трёх длин машины) и вглубь, м — если участок позволяет. */
const HOUSE = { w: [19, 25], d: [13, 17] } as const;

/** Прямоугольник в осях участка: левый нижний угол (x, y), ширина и глубина. */
export interface LotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Раскладка участка частного дома: дом, а у части домов — гараж с заездом от улицы. */
export interface CottagePlan {
  house: LotRect;
  /** Дом у левой границы участка (иначе у правой). */
  left: boolean;
  /** Гараж: у ворот (со стороны улицы) — площадка под машину не короче машины. Нет — дом без заезда. */
  garage: LotRect | null;
  /** Заезд в участке: от края участка (y = −H/2) до ворот гаража; x — середина. */
  drive: { x: number; w: number; y0: number; y1: number } | null;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const r = (b: Pick<TownBuilding, 'id'>, i: number) => hash(b.id, i);

/**
 * Раскладка частного дома (те же хеши, что у рисунка: Art.r(i) = hash(id дома, i)). Дом — 19–25 м по улице (около
 * трёх длин машины) и 13–17 вглубь, на узком участке — сколько влезает; перед ним — палисадник в несколько метров.
 * Гараж — у половины домов на участке от 22 м по улице, сбоку от дома, отступив от края участка на длину машины с
 * запасом: машина встаёт перед воротами, не на тротуаре. У дома второго ряда (TownBuilding.rear) гаража нет.
 * Участки старых сохранений (22–30 м) — те же правила: дом почти во всю ширину участка, как прежде.
 */
export function cottagePlan(b: Pick<TownBuilding, 'id' | 'fp' | 'kind' | 'floors' | 'people' | 'form' | 'rear'>): CottagePlan {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const two = storeysOf(b) >= 2;
  // Ворота гаража — дальше от края участка, чем машина длиной: перед ней ещё полтора метра.
  const gy = y0 + 1.5 + CAR_SIZE.l;
  // У дома второго ряда улицы рядом нет — и заезда тоже.
  const garage = !b.rear && r(b, 17) < 0.5 && W >= 22 && H >= gy - y0 + GARAGE.d + 3;
  const room = garage ? GARAGE.w + 1.6 : 0;
  // Палисадник перед домом: на крупном участке — шире.
  const front = clamp(H * 0.08, 1.8, 4) + r(b, 3) * clamp(H * 0.04, 1.2, 2);
  // На большом участке (у центра) и дом больше.
  const wide = Math.max(0, W - 42) * 0.3;
  const deep = Math.max(0, H - 42) * 0.2;
  const hw = clamp(HOUSE.w[0] + (HOUSE.w[1] - HOUSE.w[0]) * r(b, 1) + wide - room * 0.25, 9.5, Math.min(W * 0.72 - room * 0.4, W - 4.4 - room));
  const hd = clamp(HOUSE.d[0] + (HOUSE.d[1] - HOUSE.d[0]) * r(b, 2) + deep, 8.5, Math.min(H * 0.58, H - front - 4)) + (two ? 0.6 : 0);
  const left = r(b, 4) < 0.5;
  const side = clamp(W * 0.04, 1.2, 2.4) + r(b, 5) * 0.8;
  const hx = left ? x0 + side : -x0 - side - hw;
  const hy = y0 + front;
  const house = { x: hx, y: hy, w: hw, h: hd };
  if (!garage) return { house, left, garage: null, drive: null };
  const gx = left ? hx + hw + 1.4 : hx - 1.4 - GARAGE.w;
  return {
    house,
    left,
    garage: { x: gx, y: gy, w: GARAGE.w, h: GARAGE.d },
    drive: { x: gx + GARAGE.w / 2, w: DRIVE_W, y0, y1: gy },
  };
}

/** Заезд в мире: от края полотна до ворот гаража. */
export interface Driveway {
  /** Дом. */
  building: number;
  /** Середина заезда у края полотна (бордюр). */
  curb: Vec;
  /** Середина ворот гаража. */
  gate: Vec;
  /** Единичный вектор от улицы к воротам. */
  dir: Vec;
  /** Ширина заезда, м. */
  width: number;
  /** Где стоит машина перед воротами (середина), носом к воротам — по dir. */
  spot: Vec;
}

/** Поворот осей участка: дом с face = 1 повёрнут на пол-оборота (как у рисунка). */
function lotFrame(b: Pick<TownBuilding, 'fp' | 'face'>) {
  const angle = (b.face ?? -1) === 1 ? b.fp.angle + Math.PI : b.fp.angle;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return (x: number, y: number): Vec => ({ x: b.fp.center.x + x * c - y * s, y: b.fp.center.y + x * s + y * c });
}

/** Заезд к гаражу частного дома в мире (нет гаража — null). */
export function drivewayOf(b: TownBuilding): Driveway | null {
  if (b.kind !== 'res' || formOf(b) !== 'cottage') return null;
  const plan = cottagePlan(b);
  if (!plan.drive) return null;
  const at = lotFrame(b);
  const d = plan.drive;
  const curb = at(d.x, -b.fp.h / 2 - LOT_SETBACK);
  const gate = at(d.x, d.y1);
  const len = Math.hypot(gate.x - curb.x, gate.y - curb.y);
  return {
    building: b.id,
    curb,
    gate,
    dir: { x: (gate.x - curb.x) / len, y: (gate.y - curb.y) / len },
    width: d.w,
    spot: at(d.x, d.y1 - CAR_SIZE.l / 2 - 0.4),
  };
}

/**
 * К какому полотну примыкает заезд: ближайшее к его точке у бордюра (ось — не дальше 25 м), место на оси s и
 * сторона (1 — справа по направлению a→b, как полосы с offset > 0, GLane.offset; −1 — слева). Нет полотна рядом
 * (дорогу снесли) — null.
 */
export function drivewayLink(roads: LaneNet, d: Driveway): { corridor: number; s: number; side: 1 | -1 } | null {
  let best: { corridor: number; s: number; side: 1 | -1; d: number } | null = null;
  for (const c of roads.corridorsNear(d.curb, 40)) {
    const hit = c.lut.closest(d.curb);
    if (hit.d > 25 || (best && hit.d >= best.d)) continue;
    const t = c.lut.tangentAt(hit.s);
    const side = (t.x * (d.curb.y - hit.point.y) - t.y * (d.curb.x - hit.point.x) >= 0 ? 1 : -1) as 1 | -1;
    best = { corridor: c.id, s: hit.s, side, d: hit.d };
  }
  if (!best) return null;
  return { corridor: best.corridor, s: best.s, side: best.side };
}
