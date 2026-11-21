import { angleDiff } from '../core/vec';
import { INDUSTRY_ROAD_WIDTH } from './industryCompound';

export const INDUSTRIAL_LANE_OFFSET = INDUSTRY_ROAD_WIDTH / 4;
export const INDUSTRIAL_TURN_RATE = Math.PI / 3;

export type WorkPoint = readonly [x: number, y: number];
export type Circuit = readonly WorkPoint[];
export type WorkVehiclePose = readonly [x: number, y: number, yaw: number, forward: boolean];

/** Одна геометрия скругления для полотна и техники. */
export function industrialRoadPoints(route: Circuit): Circuit {
  // Стыки ветвей и ворота бывают промежуточными точками одной прямой. Для радиуса важна вся её длина.
  const corners: WorkPoint[] = [];
  const direction = (a: WorkPoint, b: WorkPoint) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  for (const p of route) {
    const last = corners.at(-1);
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-5) continue;
    const prev = corners.at(-2);
    if (prev && last && Math.abs(angleDiff(direction(prev, last), direction(last, p))) < 1e-5) corners.pop();
    corners.push(p);
  }
  if (corners.length < 2) return route.length ? [route[0], route.at(-1)!] : [];
  const result: WorkPoint[] = [corners[0]];
  for (let i = 1; i < corners.length - 1; i++) {
    const [x, y] = corners[i];
    const before = corners[i - 1];
    const after = corners[i + 1];
    const yaw = direction(before, corners[i]);
    const bend = angleDiff(yaw, direction(corners[i], after));
    if (Math.abs(bend) > Math.PI - 1e-4) {
      result.push(corners[i]);
      continue;
    }
    const tan = Math.tan(Math.abs(bend) / 2);
    const trim = Math.min(8 * tan, Math.hypot(x - before[0], y - before[1]) * (i === 1 ? 0.9 : 0.49),
      Math.hypot(x - after[0], y - after[1]) * (i === corners.length - 2 ? 0.9 : 0.49));
    const radius = Math.sign(bend) * trim / tan;
    const cx = x - trim * Math.cos(yaw) - radius * Math.sin(yaw);
    const cy = y - trim * Math.sin(yaw) + radius * Math.cos(yaw);
    const pieces = Math.ceil(Math.abs(bend) / (Math.PI / 24));
    for (let k = 0; k <= pieces; k++) {
      const a = yaw + bend * k / pieces;
      result.push([cx + radius * Math.sin(a), cy - radius * Math.cos(a)]);
    }
  }
  result.push(corners[corners.length - 1]);
  return result;
}

interface RoadMetric {
  road: Circuit;
  cumulative: number[];
  length: number;
  headings: number[];
  travel: number[];
  duration: number;
}

const roadLengths = new WeakMap<Circuit, RoadMetric>();

function segmentAt(samples: number[], at: number): number {
  let lo = 1;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function roadMetric(route: Circuit) {
  let metric = roadLengths.get(route);
  if (!metric) {
    const road = industrialRoadPoints(route);
    const angles = road.slice(1).map(([x, y], i) => Math.atan2(y - road[i][1], x - road[i][0]));
    const headings = road.map((_, i) => {
      if (i === 0) return angles[0];
      if (i === road.length - 1) return angles[i - 1];
      return angles[i - 1] + angleDiff(angles[i - 1], angles[i]) / 2;
    });
    const cumulative = [0];
    const travel = [0];
    for (let i = 1; i < road.length; i++) {
      const distance = Math.hypot(road[i][0] - road[i - 1][0], road[i][1] - road[i - 1][1]);
      const turn = Math.abs(angleDiff(headings[i - 1], headings[i]));
      cumulative.push(cumulative[i - 1] + distance);
      // На внешней полосе дуга длиннее оси. На тесном повороте дополнительно ограничиваем угловую скорость.
      travel.push(travel[i - 1] + Math.max((distance + INDUSTRIAL_LANE_OFFSET * turn) / 12, turn / INDUSTRIAL_TURN_RATE));
    }
    metric = { road, cumulative, headings, travel, length: cumulative.at(-1)!, duration: travel.at(-1)! };
    roadLengths.set(route, metric);
  }
  return metric;
}

/** Пройденная доля длины по доле времени, с учётом замедления в поворотах. */
export function roadTravelProgress(route: Circuit, progress: number): number {
  const m = roadMetric(route);
  const time = progress * m.duration;
  const i = segmentAt(m.travel, time);
  const p = (time - m.travel[i - 1]) / Math.max(1e-9, m.travel[i] - m.travel[i - 1]);
  return (m.cumulative[i - 1] + p * (m.cumulative[i] - m.cumulative[i - 1])) / Math.max(1e-9, m.length);
}

export function roadPose(route: Circuit, progress: number, forward: boolean): WorkVehiclePose {
  const metric = roadMetric(route);
  const at = progress * metric.length;
  const i = segmentAt(metric.cumulative, at);
  const [x, y] = metric.road[i - 1];
  const [ex, ey] = metric.road[i];
  const p = (at - metric.cumulative[i - 1]) / Math.max(1e-6, metric.cumulative[i] - metric.cumulative[i - 1]);
  const angle = metric.headings[i - 1] + p * angleDiff(metric.headings[i - 1], metric.headings[i]);
  return [x + p * (ex - x), y + p * (ey - y), angle + (forward ? 0 : Math.PI), forward];
}
