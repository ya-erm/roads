import type { Vec } from '../core/vec';

/**
 * Кузов машины компании — каким его рисовать на карте и гнётся ли он:
 *  - van — фургон (Грузовик): кабина и кузов одним целым;
 *  - semi — тягач с полуприцепом (Грузовик II), longSemi — длинный, на трёх осях (Фура);
 *  - microbus — микроавтобус (Автобус), cityBus — городской (Автобус II);
 *  - articBus — сочленённый (Автобус III): две секции с «гармошкой»;
 *  - crewEarth, crewPave, crewMarks — техника строительной бригады (src/game/crewLane.ts, CREW_UNITS): грейдер с
 *    самосвалом грунта, асфальтоукладчик с катком (две части, как тягач с прицепом: вторая идёт следом за первой) и
 *    машина разметки — одни и те же в потоке, вдоль стройки и на месте работ.
 * У машин жителей кузова нет — они рисуются как были.
 */
export type VehicleBody = 'van' | 'semi' | 'longSemi' | 'microbus' | 'cityBus' | 'articBus' | 'crewEarth' | 'crewPave' | 'crewMarks';

/**
 * Сцепка машины из двух частей — доли её длины, считая от носа:
 *  - base — от носа до задней оси первой части (тягача, передней секции): по ней первая часть поворачивает;
 *  - joint — шарнир (седло тягача, «гармошка»);
 *  - tail — от шарнира до задней оси второй части (полуприцепа, задней секции);
 *  - front — где кончается первая часть, back — откуда начинается вторая (от носа, по прямой машине);
 *  - cab — кабина тягача (за ней — рама с седлом, над рамой — передний край полуприцепа).
 */
export interface Hitch {
  base: number;
  joint: number;
  tail: number;
  front: number;
  back: number;
  cab?: number;
}

/** Обычная машина: задняя ось — на 0.7 длины от носа (корма срезает угол на повороте). */
export const RIGID_BASE = 0.7;

/**
 * Тягач поворачивает круто, полуприцеп лежит на седле над его задней осью. Передние углы полуприцепа на
 * повороте описывают дугу вокруг седла и выходят вперёд на a·cos θ + (W/2)·sin θ (a — сколько прицеп
 * выступает перед седлом, W — ширина): чтобы при изгибе до 60° они не заходили на кабину, седло стоит
 * дальше от кабины, чем этот вынос, — между ними видна рама тягача. Доли — под длину модели (12.5 и 18).
 */
const HITCHES: Partial<Record<VehicleBody, Hitch>> = {
  semi: { cab: 0.2, back: 0.364, joint: 0.396, base: 0.42, front: 0.46, tail: 0.452 },
  longSemi: { cab: 0.17, back: 0.287, joint: 0.309, base: 0.33, front: 0.37, tail: 0.551 },
  // Сочленённый: передняя секция чуть длиннее задней, между ними — гармошка.
  articBus: { base: 0.46, joint: 0.575, tail: 0.25, front: 0.555, back: 0.595 },
  // Техника бригады (22 и 18 м): впереди грейдер (укладчик), за ним на «сцепке» — самосвал (каток), идёт по его следу.
  crewEarth: { base: 0.33, joint: 0.455, tail: 0.43, front: 0.41, back: 0.5 },
  crewPave: { base: 0.3, joint: 0.555, tail: 0.36, front: 0.47, back: 0.61 },
};

/** Сцепка кузова; цельный кузов — undefined. */
export const hitchOf = (body: VehicleBody | undefined): Hitch | undefined => (body ? HITCHES[body] : undefined);

/** От носа до задней оси первой части — по ней считается курс машины. */
export const steerBase = (body: VehicleBody | undefined): number => hitchOf(body)?.base ?? RIGID_BASE;

/**
 * Ось, которая тянется за точкой front на расстоянии len: остаётся на прямой от front к прежнему положению.
 * Так задняя ось идёт за носом, а полуприцеп — за седлом тягача; на повороте они срезают угол. Прежнего
 * положения нет или оно неправдоподобно (машину переставили) — ставим прямо позади по направлению dir.
 */
export function follow(front: Vec, dir: Vec, prev: Vec | undefined, len: number): Vec {
  const d = prev ? Math.hypot(front.x - prev.x, front.y - prev.y) : 0;
  if (!prev || d < len * 0.5 || d > len * 1.6) return { x: front.x - dir.x * len, y: front.y - dir.y * len };
  return { x: front.x + ((prev.x - front.x) / d) * len, y: front.y + ((prev.y - front.y) / d) * len };
}

/** Шарнир машины: на joint длины позади носа pos по курсу dir. */
export const jointOf = (pos: Vec, dir: Vec, length: number, h: Hitch): Vec => ({ x: pos.x - dir.x * h.joint * length, y: pos.y - dir.y * h.joint * length });

/**
 * Курс второй части: от её задней оси trail к шарниру. Нет trail (машина стоит на посту, у остановки) —
 * вторая часть прямо за первой.
 */
export function trailDir(joint: Vec, trail: Vec | undefined, dir: Vec): Vec {
  if (!trail) return dir;
  const dx = joint.x - trail.x;
  const dy = joint.y - trail.y;
  const l = Math.hypot(dx, dy);
  return l < 1e-6 ? dir : { x: dx / l, y: dy / l };
}
