/**
 * Светофор въезда на карте — вид сверху, корпус «положен» вдоль бордюра, как у временного светофора стройки
 * (constructionArt.ts): у стоп-линии справа от дороги (src/lanes/lightSpot.ts) — корпус с тремя секциями: красная —
 * у стоп-линии (верхняя, если смотреть с места водителя), жёлтая, зелёная — навстречу машинам; за корпусом —
 * колонка на коротком кронштейне. Дополнительные секции со стрелкой — рядом с зелёной, дальше от дороги. Горит одна
 * секция — ярко и с ореолом, остальные — тёмным своим цветом: видно и что светофор трёхсекционный, и какой сигнал.
 * Тень — на юго-восток, как у домов и мостов. Размер — в метрах вблизи и не меньше нескольких пикселей издали
 * (lightScale). Без save/restore и шрифтов: холст — setFrame поверх преобразования мира, раз на светофор.
 */
import { dot, type Vec } from '../core/vec';
import { LIGHT_STEP } from '../lanes/lightSpot';
import { type Frame, setFrame } from './vehicleArt';

/** Сигнал секции: горит красный, жёлтый или зелёный. */
export type Lamp = 'red' | 'yellow' | 'green';

/** Секция по фазе: разрешено — зелёный (пока фаза меняется — жёлтый), нет — красный. */
export const lampOf = (on: boolean | undefined, amber: boolean): Lamp => (on ? (amber ? 'yellow' : 'green') : 'red');

/**
 * Во сколько раз светофор больше своего размера в метрах: вблизи (зум от 1,85) — в 1,3 раза (корпус ~6 м: читается
 * рядом с полосой в 7 м, не спорит с машинами), дальше растёт, чтобы оставался виден, но не больше чем в 3 раза —
 * не закрывает перекрёсток.
 */
export const lightScale = (zoom: number): number => Math.min(3, Math.max(1.3, 2.4 / Math.max(zoom, 1e-3)));

/** Секции вдоль корпуса (x — по ходу, 0 — стоп-линия): центры красной, жёлтой, зелёной и радиус огня. */
export const LAMP_X = { red: -1.3, yellow: -2.7, green: -4.1 } as const;
const LAMP_R = 0.55;
/** Корпус: от стоп-линии назад, полуширина, скругление. */
const BODY = { x0: -0.3, x1: -5.1, half: 0.85, round: 0.6 };
/** Колонка за корпусом. */
const POLE = { x: -6.0, r: 0.55 };
/** Тень на земле — смещение в мире (юго-восток), как у высокой колонки. */
const SHADOW = { x: 1.1, y: 1.6 };

const LIT: Record<Lamp, string> = { red: '#ff4b3e', yellow: '#ffc531', green: '#3ddc84' };
const GLOW: Record<Lamp, string> = { red: 'rgba(255, 75, 62, 0.32)', yellow: 'rgba(255, 197, 49, 0.32)', green: 'rgba(61, 220, 132, 0.32)' };
const DIM: Record<Lamp, string> = { red: '#5a2c2c', yellow: '#5a4b26', green: '#25483a' };
const BODY_FILL = '#262a30';
const BODY_EDGE = '#454c56';
const SHADE = 'rgba(30, 40, 25, 0.25)';

export interface LightLook {
  /** У стоп-линии справа от дороги, курс въезда (и «наружу» — его правая нормаль). */
  pos: Vec;
  dir: Vec;
  /** Основная секция. */
  main: Lamp;
  /** Секции со стрелкой: курс выезда поворота и сигнал (null — не горит). */
  arrows: readonly { dir: Vec; lamp: Lamp | null }[];
}

/**
 * Светофор look поверх преобразования мира m, в k раз больше своего размера (lightScale); detail — вблизи: колонка
 * с кронштейном, ореол и блик. Холст после него — в системе светофора: вернуть m — resetFrame (раз после всех).
 */
export function drawTrafficLight(ctx: CanvasRenderingContext2D, m: Frame, look: LightLook, k: number, detail: boolean): void {
  const { pos, dir } = look;
  // Холст — в систему светофора: x — по ходу въезда, y — вправо от дороги, в k раз крупнее.
  setFrame(ctx, m, pos.x, pos.y, dir.x * k, dir.y * k);
  // Тень мира в системе светофора (поворот обратный, масштаб уже в холсте).
  const sx = SHADOW.x * dir.x + SHADOW.y * dir.y;
  const sy = -SHADOW.x * dir.y + SHADOW.y * dir.x;
  const n = look.arrows.length;
  const w = BODY.x0 - BODY.x1;
  const h = 2 * BODY.half;
  ctx.fillStyle = SHADE;
  ctx.beginPath();
  ctx.roundRect(BODY.x1 + sx, -BODY.half + sy, w, h, BODY.round);
  for (let i = 0; i < n; i++) ctx.roundRect(LAMP_X.green - BODY.half + sx, -BODY.half + LIGHT_STEP * (i + 1) + sy, h, h, BODY.round);
  ctx.fill();
  if (detail) {
    // Колонка: тень от основания наискось, кронштейн к корпусу, сама — светлым кругом.
    ctx.strokeStyle = SHADE;
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(POLE.x, 0);
    ctx.lineTo(POLE.x + sx, sy);
    ctx.stroke();
    ctx.fillStyle = '#3a3f47';
    ctx.fillRect(POLE.x, -0.22, BODY.x1 - POLE.x + 0.2, 0.44);
    ctx.fillStyle = '#9aa1ab';
    ctx.strokeStyle = '#2a2e33';
    ctx.lineWidth = 0.2;
    ctx.beginPath();
    ctx.arc(POLE.x, 0, POLE.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  // Корпус и секции со стрелкой — одним путём.
  ctx.fillStyle = BODY_FILL;
  ctx.strokeStyle = BODY_EDGE;
  ctx.lineWidth = 0.18;
  ctx.beginPath();
  ctx.roundRect(BODY.x1, -BODY.half, w, h, BODY.round);
  for (let i = 0; i < n; i++) ctx.roundRect(LAMP_X.green - BODY.half, -BODY.half + LIGHT_STEP * (i + 1), h, h, BODY.round);
  ctx.fill();
  ctx.stroke();
  // Секции: горящая — ярко, с ореолом и бликом; остальные — тёмным своим цветом.
  for (const lamp of ['red', 'yellow', 'green'] as const) {
    const x = LAMP_X[lamp];
    const on = lamp === look.main;
    if (on && detail) {
      ctx.fillStyle = GLOW[lamp];
      ctx.beginPath();
      ctx.arc(x, 0, LAMP_R * 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = on ? LIT[lamp] : DIM[lamp];
    ctx.beginPath();
    ctx.arc(x, 0, on ? LAMP_R * 1.08 : LAMP_R, 0, Math.PI * 2);
    ctx.fill();
  }
  if (detail) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.beginPath();
    ctx.arc(LAMP_X[look.main] - LAMP_R * 0.35, -LAMP_R * 0.35, LAMP_R * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < n; i++) {
    const a = look.arrows[i];
    const cy = LIGHT_STEP * (i + 1);
    if (a.lamp && detail) {
      ctx.fillStyle = GLOW[a.lamp];
      ctx.beginPath();
      ctx.arc(LAMP_X.green, cy, LAMP_R * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    // Курс выезда — в системе светофора.
    turnArrow(ctx, LAMP_X.green, cy, dot(a.dir, dir), -a.dir.x * dir.y + a.dir.y * dir.x, a.lamp ? LIT[a.lamp] : '#6b737d');
  }
}

/** Стрелка поворота в секции (cx, cy) системы светофора: от въезда (курс +x) с изгибом на выезд (ex, ey). */
function turnArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, ex: number, ey: number, color: string): void {
  const s = 0.36;
  // Точки: kd по въезду и ke по выезду от центра секции.
  const ax = cx + (-1.3 - 0.6 * ex) * s;
  const ay = cy - 0.6 * ey * s;
  const bx = cx + (0.3 - 0.6 * ex) * s;
  const by = ay;
  const tx = cx + (0.3 + 1.25 * ex) * s;
  const ty = cy + 1.25 * ey * s;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 0.24;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  // Наконечник: назад по выезду, в стороны — поперёк него.
  const px = -ey;
  const py = ex;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx + (-0.95 * ex + 0.85 * px) * s, ty + (-0.95 * ey + 0.85 * py) * s);
  ctx.lineTo(tx + (-0.95 * ex - 0.85 * px) * s, ty + (-0.95 * ey - 0.85 * py) * s);
  ctx.closePath();
  ctx.fill();
}
