import type { IndustryKind } from '../world/cargo';
import { INDUSTRY_ROAD_WIDTH } from '../world/industryCompound';
import { hasFields, hasPastures, isOpenPit } from '../world/industrySites';
import type { Circuit, WorkPoint } from './industryEquipment';

const INDUSTRY_ASPHALT = '#858a90';
export const INDUSTRY_DIRT = '#bdab88';

const DIRT_SITES = new Set<IndustryKind>(['coalmine', 'goldmine', 'gemmine', 'oilwell', 'gasfield']);

/** Грунт у выработок, скважин и полей, светлый асфальт у остальных комплексов. */
export function industryRoadSurface(kind?: IndustryKind): string {
  return kind && (isOpenPit(kind) || DIRT_SITES.has(kind) || hasFields(kind) || hasPastures(kind)) ? INDUSTRY_DIRT : INDUSTRY_ASPHALT;
}

/** Короткое скругление в углу, между углами — прямые отрезки. */
export function industrialRoadPoints(route: Circuit): Circuit {
  const result: WorkPoint[] = [route[0]];
  for (let i = 1; i < route.length - 1; i++) {
    const [x, y] = route[i];
    const before = route[i - 1];
    const after = route[i + 1];
    const a = Math.min(0.45, 3.7 / Math.hypot(before[0] - x, before[1] - y));
    const b = Math.min(0.45, 3.7 / Math.hypot(after[0] - x, after[1] - y));
    const ax = (before[0] - x) * a;
    const ay = (before[1] - y) * a;
    const bx = (after[0] - x) * b;
    const by = (after[1] - y) * b;
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      result.push([x + ax * (1 - t) ** 2 + bx * t * t, y + ay * (1 - t) ** 2 + by * t * t]);
    }
  }
  result.push(route[route.length - 1]);
  return result;
}

/** Вся сеть одним непрозрачным штрихом. В местах стыка сохраняется сплошное полотно. */
export function drawIndustrialRoads(c: CanvasRenderingContext2D, routes: readonly Circuit[], surface: string): void {
  c.save();
  c.strokeStyle = surface;
  c.lineWidth = INDUSTRY_ROAD_WIDTH;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  for (const route of routes) {
    if (route.length < 2) continue;
    const points = industrialRoadPoints(route);
    c.moveTo(...points[0]);
    for (let i = 1; i < points.length; i++) c.lineTo(...points[i]);
  }
  c.stroke();
  c.restore();
}

/** Стойки по краям проезда: yaw задаёт направление проезда, а не забора. */
export function drawIndustrialGate(c: CanvasRenderingContext2D, x: number, y: number, yaw: number): void {
  const off = INDUSTRY_ROAD_WIDTH / 2 + 0.42;
  c.save();
  c.translate(x, y);
  c.rotate(yaw);
  c.fillStyle = '#43494e';
  c.fillRect(-0.76, -off - 0.52, 1.55, 1.15);
  c.fillRect(-0.76, off - 0.63, 1.55, 1.15);
  c.fillStyle = '#e5bc58';
  c.fillRect(-0.62, -off - 0.39, 1.26, 0.79);
  c.fillRect(-0.62, off - 0.49, 1.26, 0.79);
  c.restore();
}
