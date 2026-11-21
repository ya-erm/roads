import type { Vec } from '../core/vec';

/**
 * Значок пешеходного перехода — знак «Пешеходный переход» (5.19): синий квадрат, белый треугольник, чёрный шагающий
 * человечек над полосками зебры. Одна векторная отрисовка (координаты 0…100) — на карте в «Перекрёстке» (canvas) и в
 * карточке перекрёстка (SVG). Всегда ровно на экране, по дороге не поворачивается.
 * Состояния: есть переход — знак как есть; нет — серый и перечёркнут красным; «само» (решил город) — пунктир вокруг.
 */
export interface WalkSignState {
  on: boolean;
  underground?: boolean;
  /** Решил игрок; нет — «само». */
  own: boolean;
}

const SQUARE = 'M10 0H90Q100 0 100 10V90Q100 100 90 100H10Q0 100 0 90V10Q0 0 10 0Z';
const TRIANGLE = 'M50 7Q54 7 56 11L94 79Q97 86 90 86H10Q3 86 6 79L44 11Q46 7 50 7Z';
const STRIPES = 'M17 83L24 73H32L26 83Z M45 83L46 73H54L55 83Z M74 83L68 73H76L83 83Z';
const STAIRS = 'M11 75H28V62H44V49H60V36H76V23H89V33H82V46H66V59H50V72H34V85H11Z';
/** Руки, туловище и ноги — линиями толщиной LIMB с круглыми концами; голова — кругом. */
const LIMBS = 'M51 36L46 55 M46 55L40 66L38 78 M47 56L58 77 M50 38L42 47 M53 37L61 43L61 51';
const LIMB = 7;
const HEAD = { x: 51, y: 25, r: 7.5 };

const COLORS = {
  on: { plate: '#2f6fe0', field: '#f6f6f2', ink: '#16181b' },
  off: { plate: '#9aa1a9', field: '#e9eaec', ink: '#6b7178' },
};
const CROSS = '#e8483f';

/** Знак в карточке: SVG size×size пикселей. */
export function walkSignSvg(st: WalkSignState, size = 18): string {
  const c = st.on ? COLORS.on : COLORS.off;
  if (st.underground) return `<svg class="walk-sign" width="${size}" height="${size}" viewBox="-6 -6 112 112" aria-hidden="true"><path d="${SQUARE}" fill="${c.plate}"/><path d="${STAIRS}" fill="white"/></svg>`;
  const auto = st.own ? '' : `<path d="${SQUARE}" fill="none" stroke="#1f2933" stroke-width="7" stroke-dasharray="12 9" opacity="0.55"/>`;
  const cross = st.on ? '' : `<path d="M12 88L88 12" stroke="${CROSS}" stroke-width="10" stroke-linecap="round"/>`;
  return `<svg class="walk-sign" width="${size}" height="${size}" viewBox="-6 -6 112 112" aria-hidden="true">
    <path d="${SQUARE}" fill="${c.plate}"/>${auto}<path d="${TRIANGLE}" fill="${c.field}"/>
    <path d="${STRIPES}" fill="${c.ink}"/><circle cx="${HEAD.x}" cy="${HEAD.y}" r="${HEAD.r}" fill="${c.ink}"/>
    <path d="${LIMBS}" fill="none" stroke="${c.ink}" stroke-width="${LIMB}" stroke-linecap="round" stroke-linejoin="round"/>${cross}</svg>`;
}

let paths: { square: Path2D; triangle: Path2D; stripes: Path2D; limbs: Path2D; stairs: Path2D } | null = null;

/** Знак на карте: центр at, сторона size (в мире), ровно на экране; z — зум (тонкие линии — в пикселях). */
export function drawWalkSign(ctx: CanvasRenderingContext2D, at: Vec, size: number, st: WalkSignState, z: number): void {
  paths ??= { square: new Path2D(SQUARE), triangle: new Path2D(TRIANGLE), stripes: new Path2D(STRIPES), limbs: new Path2D(LIMBS), stairs: new Path2D(STAIRS) };
  const c = st.on ? COLORS.on : COLORS.off;
  const k = size / 100;
  ctx.save();
  ctx.translate(at.x - size / 2, at.y - size / 2);
  ctx.scale(k, k);
  // Белая кайма — знак читается и на асфальте, и на зебре.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = 2.2 / z / k;
  ctx.stroke(paths.square);
  ctx.fillStyle = c.plate;
  ctx.fill(paths.square);
  ctx.fillStyle = c.field;
  if (st.underground) {
    ctx.fill(paths.stairs);
    ctx.restore();
    return;
  }
  ctx.fill(paths.triangle);
  ctx.fillStyle = c.ink;
  ctx.fill(paths.stripes);
  ctx.beginPath();
  ctx.arc(HEAD.x, HEAD.y, HEAD.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = c.ink;
  ctx.lineWidth = LIMB;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(paths.limbs);
  if (!st.on) {
    ctx.strokeStyle = CROSS;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(12, 88);
    ctx.lineTo(88, 12);
    ctx.stroke();
  }
  if (!st.own) {
    // «Само»: пунктир вокруг знака, чуть в стороне от каймы.
    ctx.strokeStyle = 'rgba(31, 41, 51, 0.75)';
    ctx.lineWidth = 1.4 / z / k;
    ctx.setLineDash([3 / z / k, 2.5 / z / k]);
    ctx.strokeRect(-3.5 / z / k - 2, -3.5 / z / k - 2, 104 + (7 / z / k), 104 + (7 / z / k));
    ctx.setLineDash([]);
  }
  ctx.restore();
}
