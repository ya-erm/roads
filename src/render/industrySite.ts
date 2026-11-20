import type { IndustryType } from '../world/cargo';
import type { Footprint, Plot } from '../world/spatial';

type Point = readonly [number, number];

// Нормированные контуры участков. Углы уступают место траве, воде и выемкам.
const FIELDS: readonly Point[] = [
  [-0.50, -0.26], [-0.40, -0.47], [-0.16, -0.49], [0.09, -0.40], [0.23, -0.48], [0.47, -0.47],
  [0.49, 0.32], [0.39, 0.47], [0.15, 0.43], [0.00, 0.49], [-0.29, 0.47], [-0.49, 0.33],
];
const WOODLAND: readonly Point[] = [
  [-0.49, -0.15], [-0.43, -0.39], [-0.26, -0.49], [-0.04, -0.43], [0.17, -0.48], [0.41, -0.37],
  [0.49, -0.11], [0.43, 0.15], [0.49, 0.42], [0.26, 0.49], [-0.09, 0.44], [-0.34, 0.48], [-0.48, 0.31],
];
const EXCAVATION: readonly Point[] = [
  [-0.50, -0.04], [-0.46, -0.32], [-0.33, -0.48], [-0.10, -0.49], [0.06, -0.38], [0.22, -0.48], [0.43, -0.48],
  [0.49, -0.39], [0.47, -0.03], [0.50, 0.15], [0.46, 0.45], [0.20, 0.49], [-0.13, 0.48], [-0.40, 0.41],
];
const WELLS: readonly Point[] = [
  [-0.48, -0.42], [-0.19, -0.48], [0.04, -0.34], [0.31, -0.49], [0.48, -0.37], [0.48, 0.26],
  [0.34, 0.48], [-0.05, 0.44], [-0.43, 0.48], [-0.48, 0.27], [-0.35, 0.02],
];
const WHARF: readonly Point[] = [
  [-0.49, -0.40], [-0.42, -0.49], [0.42, -0.49], [0.49, -0.35], [0.48, 0.13],
  [0.34, 0.24], [0.12, 0.18], [0.04, 0.34], [-0.36, 0.33], [-0.49, 0.16],
];
const HEAVY: readonly Point[] = [
  [-0.49, -0.29], [-0.43, -0.29], [-0.43, -0.48], [0.31, -0.48], [0.49, -0.36], [0.49, 0.14],
  [0.37, 0.14], [0.37, 0.48], [-0.49, 0.48],
];
const WORKS: readonly Point[] = [
  [-0.49, -0.43], [0.12, -0.48], [0.12, -0.41], [0.40, -0.41], [0.49, -0.29], [0.49, 0.29],
  [0.34, 0.46], [-0.11, 0.49], [-0.11, 0.41], [-0.41, 0.41], [-0.49, 0.29],
];

/** Контур покрытия, в локальных координатах площадки. */
export function industrySitePath(c: CanvasRenderingContext2D, info: IndustryType, w: number, h: number, parts?: readonly Plot[]): void {
  if (parts) {
    c.beginPath();
    for (const part of parts) tracePlot(c, part, w, h);
    return;
  }
  if (info.accepts.length) {
    c.beginPath();
    c.roundRect(-w / 2, -h / 2, w, h, 3);
    return;
  }
  let points: readonly Point[];
  switch (info.kind) {
    case 'farm': case 'flaxfarm': case 'sunflower': case 'cottonfarm': case 'ranch': case 'sheepfarm':
      points = FIELDS;
      break;
    case 'forest':
      points = WOODLAND;
      break;
    case 'coalmine': case 'ironmine': case 'quarry': case 'sandpit': case 'claypit': case 'goldmine': case 'gemmine': case 'coppermine':
      points = EXCAVATION;
      break;
    case 'oilwell': case 'gasfield':
      points = WELLS;
      break;
    case 'fishery':
      points = WHARF;
      break;
    case 'steelmill': case 'smelter': case 'refinery': case 'cement': case 'gasplant': case 'papermill':
      points = HEAVY;
      break;
    default:
      points = WORKS;
  }
  c.beginPath();
  const soft = points === FIELDS || points === WOODLAND;
  if (soft) {
    const first = points[0];
    const last = points[points.length - 1];
    c.moveTo((first[0] + last[0]) * w / 2, (first[1] + last[1]) * h / 2);
    points.forEach(([x, y], i) => {
      const [nx, ny] = points[(i + 1) % points.length];
      c.quadraticCurveTo(x * w, y * h, (x + nx) * w / 2, (y + ny) * h / 2);
    });
  } else {
    c.moveTo(points[0][0] * w, points[0][1] * h);
    for (let i = 1; i < points.length; i++) c.lineTo(points[i][0] * w, points[i][1] * h);
  }
  c.closePath();
}

export function tracePlot(c: CanvasRenderingContext2D, plot: Plot, w: number, h: number): void {
  c.moveTo(plot[0].x * w, plot[0].y * h);
  for (let i = 1; i < plot.length; i++) c.lineTo(plot[i].x * w, plot[i].y * h);
  c.closePath();
}

export function paintIndustrySite(
  c: CanvasRenderingContext2D, info: IndustryType, fp: Footprint, fill: string, stroke?: string, width = 1,
): void {
  c.save();
  c.translate(fp.center.x, fp.center.y);
  c.rotate(fp.angle);
  industrySitePath(c, info, fp.w, fp.h, fp.parts);
  c.fillStyle = fill;
  c.fill();
  if (stroke) {
    c.strokeStyle = stroke;
    c.lineWidth = width;
    c.lineJoin = 'round';
    c.stroke();
  }
  c.restore();
}
