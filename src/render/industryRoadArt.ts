import type { IndustryKind } from '../world/cargo';
import { INDUSTRY_ROAD_WIDTH } from '../world/industryCompound';
import { hasFields, hasPastures, isOpenPit } from '../world/industrySites';
import { industrialRoadPoints, type Circuit } from '../world/industryRoad';

const INDUSTRY_ASPHALT = '#858a90';
export const INDUSTRY_DIRT = '#bdab88';

const DIRT_SITES = new Set<IndustryKind>(['coalmine', 'goldmine', 'gemmine', 'oilwell', 'gasfield']);

/** Грунт у выработок, скважин и полей, светлый асфальт у остальных комплексов. */
export function industryRoadSurface(kind?: IndustryKind): string {
  return kind && (isOpenPit(kind) || DIRT_SITES.has(kind) || hasFields(kind) || hasPastures(kind)) ? INDUSTRY_DIRT : INDUSTRY_ASPHALT;
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
