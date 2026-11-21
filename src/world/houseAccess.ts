import { TOWN_SCALE } from '../config';
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

/**
 * Легковая машина жителя (game.CAR_SPEC): длина и ширина, м игры — 7,5 × 3,6 (4,5 × 2,2 м настоящих, docs/DESIGN.md,
 * «Размеры машин»: полоса в игре шире настоящей, и при ширине 3 машина в ней выглядела узкой и вытянутой). Гараж и
 * заезд — прежних размеров (под машину 7 × 4); площадка — длиннее машины на 1,4 м, как была.
 */
export const CAR_SIZE = { l: 7.5, w: 3.6 } as const;
/** Участок стоит в стольких метрах от края полотна (worldgen.fillStreet): между ними — тротуар и газон. */
export const LOT_SETBACK = 5;
/** Максимальное расстояние от устья заезда до оси дороги. */
export const DRIVEWAY_REACH = 25;
/**
 * Гараж частного дома — в масштабе машины, как и дом: вдвое шире её (по бокам — место открыть двери), длиннее на 2 м
 * (верстак, полки), ширина и глубина, м.
 */
export const GARAGE = { w: 6.4, d: 9.6 } as const;
/** Ширина заезда, м — шире машины. */
export const DRIVE_W = 5.2;
/**
 * Открытая площадка под машину у дома без гаража: мощёный прямоугольник от края участка вглубь — под машину 7,5 × 3,6
 * с запасом открыть двери (5,2 × 8,9 м).
 */
export const PAD = { w: DRIVE_W, d: CAR_SIZE.l + 1.4 } as const;
/**
 * Где машина частного дома (по хешу id дома, на участке от 22 м по улице): у 45 % — гараж (кто строит дом с
 * участком, обычно строит и гараж), у 35 % — открытая площадка у дома (машина есть, гаража нет: так в сёлах и на
 * окраинах), у 20 % — ничего (машины у жильцов нет — старики, или ставят на улице). Дача — площадка у 40 %: на дачу
 * ездят на машине, гаража там не строят.
 */
export const CAR_PLACE = { garage: 0.45, pad: 0.35, dachaPad: 0.4 } as const;
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
  /** Гараж: у ворот (со стороны улицы) — площадка под машину не короче машины. Нет — дом без гаража. */
  garage: LotRect | null;
  /** Открытая площадка под машину (у дома без гаража) — от края участка вглубь. */
  pad: LotRect | null;
  /** Заезд в участке: от края участка (y = −H/2) до ворот гаража или до конца площадки; x — середина. */
  drive: { x: number; w: number; y0: number; y1: number } | null;
  spaces: { x: number; garage: boolean }[];
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const r = (b: Pick<TownBuilding, 'id'>, i: number) => hash(b.id, i);

/**
 * Раскладка частного дома (те же хеши, что у рисунка: Art.r(i) = hash(id дома, i)). Дом — 19–25 м по улице (около
 * трёх длин машины) и 13–17 вглубь, на узком участке — сколько влезает; перед ним — палисадник в несколько метров.
 * Гараж (CAR_PLACE.garage) — сбоку от дома, отступив от края участка на длину машины с запасом: машина въезжает в
 * него, а у части домов вторая стоит перед воротами, не на тротуаре. Площадка (CAR_PLACE.pad) — там же, сбоку от
 * дома, от края участка. У дома второго ряда (TownBuilding.rear) улицы рядом нет — ни гаража, ни площадки.
 * Участки старых сохранений (22–30 м) — те же правила: дом почти во всю ширину участка, как прежде.
 */
export function cottagePlan(b: Pick<TownBuilding, 'id' | 'fp' | 'kind' | 'floors' | 'people' | 'form' | 'rear' | 'homeSpaces' | 'garageSpaces'>): CottagePlan {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const two = storeysOf(b) >= 2;
  // Ворота гаража — дальше от края участка, чем машина длиной: перед ней ещё метр.
  const gy = y0 + 1 + CAR_SIZE.l;
  const roll = r(b, 17);
  const garage = !b.rear && roll < CAR_PLACE.garage && W >= 22 && H >= gy - y0 + GARAGE.d + 3;
  const pad = !b.rear && roll >= CAR_PLACE.garage && roll < CAR_PLACE.garage + CAR_PLACE.pad && W >= 22 && H >= PAD.d + 10;
  let count = b.homeSpaces ?? (W >= 42 && r(b, 31) < 0.18 ? 3 : W >= 32 && r(b, 32) < 0.4 ? 2 : 1);
  const inside = () => garage ? Math.min(count, b.garageSpaces ?? (r(b, 33) < 0.35 ? 2 : 1)) : 0;
  const spaceWidth = () => inside() * GARAGE.w + (count - inside()) * PAD.w + (inside() && count > inside() ? 0.8 : 0);
  while (count > 1 && spaceWidth() + 15.5 > W) count--;
  const room = garage || pad ? spaceWidth() + 1.6 : 0;
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
  if (pad) {
    const width = count * PAD.w;
    const px = left ? hx + hw + 1.4 : hx - 1.4 - width;
    return { house, left, garage: null, pad: { x: px, y: y0, w: width, h: PAD.d }, drive: { x: px + width / 2, w: width, y0, y1: y0 + PAD.d }, spaces: Array.from({ length: count }, (_, k) => ({ x: px + PAD.w * (k + 0.5), garage: false })) };
  }
  if (!garage) return { house, left, garage: null, pad: null, drive: null, spaces: [] };
  const garages = inside();
  const outdoor = count - garages;
  const total = spaceWidth();
  const base = left ? hx + hw + 1.4 : hx - 1.4 - total;
  const gx = left ? base : base + (outdoor ? outdoor * PAD.w + 0.8 : 0);
  const px = left ? gx + garages * GARAGE.w + 0.8 : base;
  return {
    house,
    left,
    garage: { x: gx, y: gy, w: garages * GARAGE.w, h: GARAGE.d },
    pad: outdoor ? { x: px, y: y0, w: outdoor * PAD.w, h: PAD.d } : null,
    drive: { x: base + total / 2, w: total, y0, y1: gy },
    spaces: [...Array.from({ length: garages }, (_, k) => ({ x: gx + GARAGE.w * (k + 0.5), garage: true })), ...Array.from({ length: outdoor }, (_, k) => ({ x: px + PAD.w * (k + 0.5), garage: false }))],
  };
}

/** Раскладка дачи: домик у улицы с одной стороны, у 40 % (CAR_PLACE.dachaPad) — площадка под машину рядом с ним. */
export interface DachaPlan {
  house: LotRect;
  left: boolean;
  pad: LotRect | null;
  spaces: { x: number; garage: boolean }[];
}

/**
 * Раскладка дачи (те же хеши, что у рисунка): домик в масштабе дома, у улицы, с одной стороны участка; площадка под
 * машину — рядом с домиком, от края участка (грядки начинаются за ней). У дачи второго ряда площадки нет.
 */
export function dachaPlan(b: Pick<TownBuilding, 'id' | 'fp' | 'rear' | 'homeSpaces'>): DachaPlan {
  const W = b.fp.w;
  const H = b.fp.h;
  const x0 = -W / 2;
  const y0 = -H / 2;
  const left = r(b, 1) < 0.5;
  const hw = clamp(W * 0.36, 7, 9.5 * TOWN_SCALE);
  const hd = clamp(H * 0.3, 6, 8 * TOWN_SCALE);
  const hx = left ? x0 + 1.6 : -x0 - 1.6 - hw;
  const hy = y0 + 1.8 + r(b, 4) * 1.5 * TOWN_SCALE;
  const house = { x: hx, y: hy, w: hw, h: hd };
  const fits = W - hw - 4.4 >= PAD.w + 3 && H >= PAD.d + 12;
  if (b.rear || !fits || r(b, 30) >= CAR_PLACE.dachaPad) return { house, left, pad: null, spaces: [] };
  const requested = b.homeSpaces ?? (W >= 42 && r(b, 31) < 0.25 ? 3 : W >= 32 && r(b, 32) < 0.5 ? 2 : 1);
  const count = Math.max(1, Math.min(requested, Math.floor((W - hw - 7.4) / PAD.w)));
  const width = count * PAD.w;
  const px = left ? hx + hw + 1.4 : hx - 1.4 - width;
  return { house, left, pad: { x: px, y: y0, w: width, h: PAD.d }, spaces: Array.from({ length: count }, (_, k) => ({ x: px + PAD.w * (k + 0.5), garage: false })) };
}

/** Заезд в мире: от края полотна до ворот гаража (или до конца площадки, места на стоянке). */
export interface Driveway {
  /** Дом. */
  building: number;
  /** Середина заезда у края полотна (бордюр). */
  curb: Vec;
  /** Середина ворот гаража (у площадки и места на стоянке — их дальний край). */
  gate: Vec;
  /** Единичный вектор от улицы к воротам. */
  dir: Vec;
  /** Ширина заезда, м. */
  width: number;
  /** Где стоит машина перед воротами или на площадке (середина), носом к воротам — по dir. */
  spot: Vec;
  /** За воротами — гараж (машина въезжает в него); нет — открытая площадка. */
  garage: boolean;
}

/** Поворот осей участка: дом с face = 1 повёрнут на пол-оборота (как у рисунка). */
export function lotFrame(b: Pick<TownBuilding, 'fp' | 'face'>) {
  const angle = (b.face ?? -1) === 1 ? b.fp.angle + Math.PI : b.fp.angle;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return (x: number, y: number): Vec => ({ x: b.fp.center.x + x * c - y * s, y: b.fp.center.y + x * s + y * c });
}

/**
 * Заезд в мире по оси x участка до y1 (ворота или дальний край места): от бордюра (край участка минус отступ) —
 * внутрь участка. Машина стоит носом к y1, нос — за stop м до него.
 */
export function drivewayAt(b: Pick<TownBuilding, 'id' | 'fp' | 'face'>, x: number, w: number, y1: number, garage: boolean, stop: number): Driveway {
  const at = lotFrame(b);
  const curb = at(x, -b.fp.h / 2 - LOT_SETBACK);
  const gate = at(x, y1);
  const len = Math.hypot(gate.x - curb.x, gate.y - curb.y);
  return {
    building: b.id,
    curb,
    gate,
    dir: { x: (gate.x - curb.x) / len, y: (gate.y - curb.y) / len },
    width: w,
    spot: at(x, y1 - CAR_SIZE.l / 2 - stop),
    garage,
  };
}

/** Заезд к гаражу или площадке частного дома (или дачи) в мире; нет ни того ни другого — null. */
export function drivewayOf(b: TownBuilding): Driveway | null {
  return drivewaysOf(b)[0] ?? null;
}

/** По отдельному заезду к каждой параллельной площадке/воротам многоместного гаража. */
export function drivewaysOf(b: TownBuilding): Driveway[] {
  if (b.kind !== 'res') return [];
  const form = formOf(b);
  if (form === 'dacha') {
    const plan = dachaPlan(b);
    return plan.pad ? plan.spaces.map((s) => drivewayAt(b, s.x, DRIVE_W, plan.pad!.y + plan.pad!.h, false, 0.6)) : [];
  }
  if (form !== 'cottage') return [];
  const plan = cottagePlan(b);
  const d = plan.drive;
  if (!d) return [];
  return plan.spaces.map((s) => drivewayAt(b, s.x, DRIVE_W, s.garage ? plan.garage!.y : plan.pad!.y + plan.pad!.h, s.garage, s.garage ? 0.4 : 0.6));
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
    if (hit.d > DRIVEWAY_REACH || (best && hit.d >= best.d)) continue;
    const t = c.lut.tangentAt(hit.s);
    const side = (t.x * (d.curb.y - hit.point.y) - t.y * (d.curb.x - hit.point.x) >= 0 ? 1 : -1) as 1 | -1;
    best = { corridor: c.id, s: hit.s, side, d: hit.d };
  }
  if (!best) return null;
  return { corridor: best.corridor, s: best.s, side: best.side };
}
