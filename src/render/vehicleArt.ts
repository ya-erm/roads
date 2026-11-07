import type { Vec } from '../core/vec';
import { type Hitch, hitchOf, jointOf, trailDir } from '../sim/body';
import type { VehicleLook } from '../sim/vehicle';
import { glassFor, shadeHex } from '../ui/icons';

/**
 * Машины на карте сверху. Система машины: нос в 0, кузов тянется назад по −x, справа +y.
 * Машины компании рисуются по кузову (sim/body): фургон, тягач с полуприцепом, микроавтобус, городской
 * и сочленённый автобус; у машин из двух частей вторая часть — по своему курсу (от её оси к шарниру).
 */

/** Пустой кузов грузовика. */
const EMPTY = '#f4efe6';
const STEEL = '#4a525c';
const BELLOWS = '#3a4048';
const ROOF_UNIT = '#cfd5db';

export interface VehicleDrawOptions {
  /** Мелкие детали — окна, кабина, кузов (камера достаточно близко). */
  detailed: boolean;
  /** Белая обводка такой толщины (машины выбранной линии); 0 — без неё. */
  halo: number;
}

/**
 * Часть кузова: прямоугольник от x0 до x1 (x1 — ближе к носу) в системе с началом origin и курсом dir.
 * link — перемычка между частями (гармошка): рисуется в координатах мира, без обводки и тени.
 */
interface Part {
  origin: Vec;
  dir: Vec;
  x0: number;
  x1: number;
  paint: (ctx: CanvasRenderingContext2D) => void;
  link?: boolean;
}

const WORLD: Pick<Part, 'origin' | 'dir'> = { origin: { x: 0, y: 0 }, dir: { x: 1, y: 0 } };

/**
 * Техника строительной бригады в колонне (как на стройке, constructionArt.drawMachines): грейдер — длинная узкая рама,
 * нож поперёк посередине, кабина сзади; каток — тёмный валец во всю ширину впереди, за ним корпус с кабиной.
 */
function crewMachineArt(ctx: CanvasRenderingContext2D, v: VehicleLook, detailed: boolean): void {
  const L = v.length;
  const W = v.width;
  const dark = '#3d4148';
  ctx.strokeStyle = '#6b5410';
  ctx.lineWidth = 0.3;
  if (v.body === 'grader') {
    ctx.fillStyle = v.color;
    rr(ctx, -L, -W * 0.3, L, W * 0.6, 0.6);
    ctx.fill();
    ctx.stroke();
    // Нож поперёк рамы и кабина над задними колёсами.
    ctx.fillStyle = '#4d4f55';
    ctx.fillRect(-L * 0.48, -W / 2, 0.9, W);
    ctx.fillStyle = shadeHex(v.color, -0.08);
    rr(ctx, -L * 0.82, -W * 0.42, L * 0.24, W * 0.84, 0.5);
    ctx.fill();
    ctx.stroke();
    if (detailed) {
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.fillRect(-L * 0.6, -W * 0.3, 0.6, W * 0.6);
    }
    return;
  }
  // Каток: валец впереди, корпус и кабина за ним.
  ctx.fillStyle = dark;
  rr(ctx, -2.2, -W / 2, 2.2, W, 0.9);
  ctx.fill();
  ctx.fillStyle = v.color;
  rr(ctx, -L, -W * 0.42, L - 2.6, W * 0.84, 0.7);
  ctx.fill();
  ctx.stroke();
  if (detailed) {
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillRect(-L * 0.55, -W * 0.3, 0.6, W * 0.6);
  }
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function inFrame(ctx: CanvasRenderingContext2D, origin: Vec, dir: Vec, fn: () => void): void {
  ctx.save();
  ctx.translate(origin.x, origin.y);
  ctx.rotate(Math.atan2(dir.y, dir.x));
  fn();
  ctx.restore();
}

/** Длина первой части от носа (у цельной машины — вся длина): по ней ставятся поворотники. */
export function frontLength(v: Pick<VehicleLook, 'body' | 'length'>): number {
  const h = hitchOf(v.body);
  return h ? h.front * v.length : v.length;
}

/** Машина целиком: обводка, тени, части кузова по порядку снизу вверх. */
export function drawVehicleArt(ctx: CanvasRenderingContext2D, v: VehicleLook, o: VehicleDrawOptions): void {
  const parts = partsOf(v, o.detailed);
  const shells = parts.filter((p) => !p.link);
  const W = v.width;
  if (o.halo > 0) {
    ctx.fillStyle = '#ffffff';
    for (const p of shells) {
      inFrame(ctx, p.origin, p.dir, () => {
        rr(ctx, p.x0 - o.halo, -W / 2 - o.halo, p.x1 - p.x0 + 2 * o.halo, W + 2 * o.halo, 1.3 + o.halo);
        ctx.fill();
      });
    }
  }
  if (o.detailed) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (const p of shells) {
      inFrame(ctx, p.origin, p.dir, () => {
        rr(ctx, p.x0 + 0.8, -W / 2 + 0.9, p.x1 - p.x0, W, 1.2);
        ctx.fill();
      });
    }
  }
  for (const p of parts) inFrame(ctx, p.origin, p.dir, () => p.paint(ctx));
}

/** Части кузова в порядке отрисовки (снизу вверх). */
function partsOf(v: VehicleLook, detailed: boolean): Part[] {
  const L = v.length;
  const W = v.width;
  const h = hitchOf(v.body);
  if (!h) return [{ origin: v.pos, dir: v.dir, x0: -L, x1: 0, paint: (ctx) => rigidArt(ctx, v, detailed) }];
  const joint = jointOf(v.pos, v.dir, L, h);
  const td = trailDir(joint, v.trail, v.dir);
  // Вторая часть — от back (от носа прямой машины) до хвоста, в системе шарнира.
  const back = { x0: -(1 - h.joint) * L, x1: (h.joint - h.back) * L };
  if (v.body === 'articBus') {
    const rear: Part = { origin: joint, dir: td, ...back, paint: (ctx) => busSection(ctx, v, back.x0, back.x1, detailed, 'rear') };
    const front: Part = { origin: v.pos, dir: v.dir, x0: -h.front * L, x1: 0, paint: (ctx) => busSection(ctx, v, -h.front * L, 0, detailed, 'front') };
    // Гармошка — чёрный резиновый круг под обеими секциями: снаружи изгиба виден дугой, без разрыва.
    const bellows: Part = { ...WORLD, x0: 0, x1: 0, link: true, paint: (ctx) => bellowsArt(ctx, v, h, joint) };
    return [bellows, rear, front];
  }
  // Тягач с полуприцепом: рама тягача — под полуприцепом, кабина — над ним.
  const cab = (h.cab ?? 0.2) * L;
  const chassis: Part = { origin: v.pos, dir: v.dir, x0: -h.front * L, x1: -cab + 0.5, paint: (ctx) => chassisArt(ctx, -h.front * L, -cab + 0.5, W) };
  const trailer: Part = { origin: joint, dir: td, ...back, paint: (ctx) => trailerArt(ctx, v, back.x0, back.x1, detailed) };
  const tractor: Part = { origin: v.pos, dir: v.dir, x0: -cab, x1: 0, paint: (ctx) => cabArt(ctx, v.color, -cab, W, detailed) };
  return [chassis, trailer, tractor];
}

/** Цельный кузов: машина жителя как раньше, фургон, микроавтобус и городской автобус. */
function rigidArt(ctx: CanvasRenderingContext2D, v: VehicleLook, detailed: boolean): void {
  const L = v.length;
  const W = v.width;
  if (v.body === 'microbus') return microbusArt(ctx, v, detailed);
  if (v.body === 'cityBus') return busSection(ctx, v, -L, 0, detailed, 'whole');
  if (v.body === 'grader' || v.body === 'roller') return crewMachineArt(ctx, v, detailed);
  ctx.fillStyle = v.color;
  rr(ctx, -L, -W / 2, L, W, 1.3);
  ctx.fill();
  if (!detailed) return;
  if (v.body === 'van') {
    // Кабина впереди, за ней фургон цвета груза (пустой — светлый) с рамкой.
    const cab = 3.4;
    const load = v.load ?? EMPTY;
    ctx.fillStyle = load;
    rr(ctx, -L + 0.4, -W / 2 + 0.35, L - cab - 0.9, W - 0.7, 0.8);
    ctx.fill();
    ctx.strokeStyle = shadeHex(load, -0.25);
    ctx.lineWidth = 0.35;
    ctx.stroke();
    windshield(ctx, 0, W, v.color);
    return;
  }
  if (v.kind === 'truck') {
    ctx.fillStyle = v.load ?? EMPTY;
    ctx.fillRect(-L + 0.6, -W / 2 + 0.6, L - 4.2, W - 1.2);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(-2.6, -W / 2 + 0.8, 1.3, W - 1.6);
  } else if (v.kind === 'bus') {
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    for (let x = -L + 1.5; x < -2; x += 2.4) ctx.fillRect(x, -W / 2 + 0.5, 1.5, 0.8);
    ctx.fillRect(-2.2, -W / 2 + 0.8, 1.2, W - 1.6);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(-2.6, -W / 2 + 0.7, 1.4, W - 1.4);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(-L + 1, -W / 2 + 0.7, 1.4, W - 1.4);
  }
}

/** Лобовое стекло у носа x1: тёмная (на тёмном кузове — светлая) полоса поперёк. */
function windshield(ctx: CanvasRenderingContext2D, x1: number, W: number, color: string, depth = 1.1): void {
  ctx.fillStyle = glassFor(color);
  rr(ctx, x1 - depth - 0.35, -W / 2 + 0.55, depth, W - 1.1, 0.4);
  ctx.fill();
}

/** Окна салона вдоль обоих бортов — от x0 до x1. */
function sideWindows(ctx: CanvasRenderingContext2D, x0: number, x1: number, W: number, color: string): void {
  if (x1 - x0 < 1) return;
  ctx.fillStyle = glassFor(color);
  ctx.globalAlpha *= 0.85;
  ctx.fillRect(x0, -W / 2 + 0.35, x1 - x0, 0.6);
  ctx.fillRect(x0, W / 2 - 0.95, x1 - x0, 0.6);
  ctx.globalAlpha /= 0.85;
}

/** Микроавтобус: короткий капот, высокая светлая крыша, окна по бортам. */
function microbusArt(ctx: CanvasRenderingContext2D, v: VehicleLook, detailed: boolean): void {
  const L = v.length;
  const W = v.width;
  ctx.fillStyle = v.color;
  ctx.beginPath();
  ctx.roundRect(-L, -W / 2, L, W, [1.2, 2.2, 2.2, 1.2]);
  ctx.fill();
  if (!detailed) return;
  const hood = 1.6;
  // Крыша — светлее кузова, от лобового стекла до кормы.
  ctx.fillStyle = shadeHex(v.color, 0.16);
  rr(ctx, -L + 0.7, -W / 2 + 0.95, L - hood - 2.4, W - 1.9, 0.8);
  ctx.fill();
  windshield(ctx, -hood, W, v.color, 1.2);
  sideWindows(ctx, -L + 1.2, -hood - 1.8, W, v.color);
}

/**
 * Секция автобуса от x0 до x1: светлая крыша с кондиционером, окна по бортам, у передней — лобовое стекло,
 * у задней — заднее. part: whole — цельный автобус, front и rear — секции сочленённого: со стороны
 * гармошки углы прямые, чтобы секция вплотную сходилась с резиной.
 */
function busSection(ctx: CanvasRenderingContext2D, v: VehicleLook, x0: number, x1: number, detailed: boolean, part: 'whole' | 'front' | 'rear'): void {
  const W = v.width;
  const len = x1 - x0;
  const nose = part !== 'rear';
  const r = 1.3;
  const tight = 0.2;
  // Углы roundRect: верхний левый, верхний правый, нижний правый, нижний левый (x0 — слева, нос x1 — справа).
  const back = part === 'front' ? tight : r;
  const fore = part === 'rear' ? tight : r;
  ctx.fillStyle = v.color;
  ctx.beginPath();
  ctx.roundRect(x0, -W / 2, len, W, [back, fore, fore, back]);
  ctx.fill();
  if (!detailed) return;
  ctx.fillStyle = shadeHex(v.color, 0.18);
  rr(ctx, x0 + 0.6, -W / 2 + 0.95, len - (nose ? 2.2 : 1.2), W - 1.9, 0.7);
  ctx.fill();
  // Кондиционер на крыше — посередине секции.
  ctx.fillStyle = ROOF_UNIT;
  rr(ctx, x0 + len * 0.38, -W * 0.22, Math.min(3.2, len * 0.26), W * 0.44, 0.5);
  ctx.fill();
  sideWindows(ctx, x0 + 0.9, x1 - (nose ? 1.9 : 0.6), W, v.color);
  if (nose) windshield(ctx, x1, W, v.color, 1.05);
  else {
    ctx.fillStyle = glassFor(v.color);
    ctx.fillRect(x0 + 0.25, -W / 2 + 1.1, 0.45, W - 2.2);
  }
}

/**
 * Гармошка сочленённого автобуса — чёрный резиновый круг вокруг шарнира, под обеими секциями. Радиус — до
 * углов секций со стороны шарнира: на прямой виден полосой между ними, на повороте снаружи изгиба — дугой
 * от угла до угла, без разрыва.
 */
function bellowsArt(ctx: CanvasRenderingContext2D, v: VehicleLook, h: Hitch, joint: Vec): void {
  const gap = Math.max(Math.abs(h.joint - h.front), Math.abs(h.back - h.joint)) * v.length;
  ctx.fillStyle = BELLOWS;
  ctx.beginPath();
  ctx.arc(joint.x, joint.y, Math.hypot(gap, v.width / 2), 0, Math.PI * 2);
  ctx.fill();
}

/** Рама тягача за кабиной: тёмная, уже кузова, с седлом. */
function chassisArt(ctx: CanvasRenderingContext2D, x0: number, x1: number, W: number): void {
  ctx.fillStyle = STEEL;
  rr(ctx, x0, -W * 0.36, x1 - x0, W * 0.72, 0.6);
  ctx.fill();
}

/** Кабина тягача от x0 до носа: цвета линии, с лобовым стеклом и светлой крышей-обтекателем. */
function cabArt(ctx: CanvasRenderingContext2D, color: string, x0: number, W: number, detailed: boolean): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x0, -W / 2, -x0, W, [0.6, 1.4, 1.4, 0.6]);
  ctx.fill();
  if (!detailed) return;
  ctx.fillStyle = shadeHex(color, 0.14);
  rr(ctx, x0 + 0.4, -W / 2 + 0.8, -x0 - 1.9, W - 1.6, 0.5);
  ctx.fill();
  windshield(ctx, 0, W, color, 0.9);
}

/** Полуприцеп: тентованный кузов цвета груза (пустой — светлый) с рамкой и поперечными дугами тента. */
function trailerArt(ctx: CanvasRenderingContext2D, v: VehicleLook, x0: number, x1: number, detailed: boolean): void {
  const W = v.width;
  const load = v.load ?? EMPTY;
  ctx.fillStyle = load;
  rr(ctx, x0, -W / 2, x1 - x0, W, 0.7);
  ctx.fill();
  if (!detailed) return;
  ctx.strokeStyle = shadeHex(load, -0.28);
  ctx.lineWidth = 0.35;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.13)';
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  for (let x = x0 + 1.6; x < x1 - 0.8; x += 1.6) {
    ctx.moveTo(x, -W / 2 + 0.3);
    ctx.lineTo(x, W / 2 - 0.3);
  }
  ctx.stroke();
}
