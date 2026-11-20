export type WorkPoint = readonly [x: number, y: number];
export type Circuit = readonly WorkPoint[];
export type WorkVehiclePose = readonly [x: number, y: number, yaw: number, forward: boolean];

/** Одна геометрия скругления для полотна и техники. */
export function industrialRoadPoints(route: Circuit): Circuit {
  const result: WorkPoint[] = [route[0]];
  for (let i = 1; i < route.length - 1; i++) {
    const [x, y] = route[i];
    const before = route[i - 1];
    const after = route[i + 1];
    const a = Math.min(0.45, 4.5 / Math.hypot(before[0] - x, before[1] - y));
    const b = Math.min(0.45, 4.5 / Math.hypot(after[0] - x, after[1] - y));
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

const roadLengths = new WeakMap<Circuit, { road: Circuit; cumulative: number[]; length: number }>();

export function roadMetric(route: Circuit) {
  let metric = roadLengths.get(route);
  if (!metric) {
    const road = industrialRoadPoints(route);
    const cumulative = [0];
    for (let i = 1; i < road.length; i++) cumulative[i] = cumulative[i - 1] + Math.hypot(road[i][0] - road[i - 1][0], road[i][1] - road[i - 1][1]);
    metric = { road, cumulative, length: cumulative[cumulative.length - 1] };
    roadLengths.set(route, metric);
  }
  return metric;
}

export function roadPose(route: Circuit, progress: number, forward: boolean): WorkVehiclePose {
  const metric = roadMetric(route);
  const at = progress * metric.length;
  let i = 1;
  while (i < metric.road.length - 1 && metric.cumulative[i] < at) i++;
  const [x, y] = metric.road[i - 1];
  const [ex, ey] = metric.road[i];
  const p = (at - metric.cumulative[i - 1]) / Math.max(1e-6, metric.cumulative[i] - metric.cumulative[i - 1]);
  // Направление чуть сглажено вдоль скругления, в том числе в переходе на прямую.
  const before = metric.road[Math.max(0, i - 2)];
  const after = metric.road[Math.min(i + 1, metric.road.length - 1)];
  const angle = Math.atan2(p * (after[1] - y) + (1 - p) * (ey - before[1]), p * (after[0] - x) + (1 - p) * (ex - before[0]));
  return [x + p * (ex - x), y + p * (ey - y), angle + (forward ? 0 : Math.PI), forward];
}
