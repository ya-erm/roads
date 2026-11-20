import { hash } from '../core/math';
import type { IndustryHaulTrip } from '../game/industryHaul';
import { CARGO, type IndustryKind } from '../world/cargo';
import { cargoShape, type CargoShape } from './industryCargoArt';
import { industrialRoadPoints } from './industryRoadArt';

export type WorkPoint = readonly [x: number, y: number];
export type Circuit = readonly WorkPoint[];
export type Equipment =
  | { kind: 'harvester'; route: Circuit; color: string }
  | { kind: 'haul'; route: Circuit; color: string; load: string; incoming?: boolean; body?: 'tank' | 'box' | 'flatbed' }
  | { kind: 'excavator'; reach: WorkPoint }
  | { kind: 'rail'; end: number; color: string };

/** Плавный замкнутый маршрут уборочной техники по полю. */
function onCircuit(route: Circuit, t: number): WorkPoint {
  const idx = Math.floor(t);
  const f = t - idx;
  const n = route.length;
  const prev = route[(idx + n - 1) % n];
  const from = route[idx];
  const to = route[(idx + 1) % n];
  const next = route[(idx + 2) % n];
  const interpolate = (axis: 0 | 1) => {
    const a = prev[axis];
    const b = from[axis];
    const c = to[axis];
    const d = next[axis];
    return b + 0.5 * f * ((c - a) + f * ((2 * a - 5 * b + 4 * c - d) + f * (3 * b - a - 3 * c + d)));
  };
  return [interpolate(0), interpolate(1)];
}

const roadLengths = new WeakMap<Circuit, { road: Circuit; cumulative: number[]; length: number }>();

function roadMetric(route: Circuit) {
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

function roadPose(route: Circuit, progress: number, forward: boolean): readonly [number, number, number, boolean] {
  const metric = roadMetric(route);
  const at = progress * metric.length;
  let i = 1;
  while (i < metric.road.length - 1 && metric.cumulative[i] < at) i++;
  const [x, y] = metric.road[i - 1];
  const [ex, ey] = metric.road[i];
  const p = (at - metric.cumulative[i - 1]) / Math.max(1e-6, metric.cumulative[i] - metric.cumulative[i - 1]);
  return [x + p * (ex - x), y + p * (ey - y), Math.atan2(ey - y, ex - x) + (forward ? 0 : Math.PI), forward];
}

function haulPose(route: Circuit, time: number | undefined, seed: number): readonly [number, number, number, boolean] {
  const phase = time === undefined ? 0 : (time / Math.max(16, roadMetric(route).length * 0.34) + hash(seed, 381)) % 1;
  return roadPose(route, 0.5 - Math.cos(phase * Math.PI * 2) * 0.5, phase < 0.5);
}

export function paintTransferTruck(c: CanvasRenderingContext2D, route: Circuit, trip: IndustryHaulTrip, producer: IndustryKind): void {
  const shape = cargoShape(trip.cargo, producer);
  const outbound = trip.direction === 'out';
  const forward = outbound !== (trip.phase === 'returning');
  const [x, y, heading] = roadPose(route, outbound ? trip.progress : 1 - trip.progress, forward);
  const yaw = heading + (trip.phase === 'unloading' ? Math.PI * trip.turn : 0);
  const pose = [x - Math.sin(yaw) * 1.5, y + Math.cos(yaw) * 1.5, yaw, true] as const;
  const colors = ['#568e91', '#ad7855', '#788f53', '#d8ac37'];
  const truck = { kind: 'haul' as const, route, color: shape === 'bulk' ? '#e9b52f' : colors[trip.id % colors.length], load: CARGO[trip.cargo].color };
  paintWorkVehicle(c, truck, pose, { shape, fill: trip.fill, scale: shape === 'tank' ? 0.68 : 0.64 });
}

/** Техника видна сверху, кабина и направление движения смотрят вдоль локальной оси +x. */
export function paintEquipment(
  c: CanvasRenderingContext2D, equipment: Equipment, x: number, y: number, seed: number, time?: number,
): void {
  const seconds = equipment.kind === 'haul' ? 16 : equipment.kind === 'harvester' ? 19 : 13;
  const phase = time === undefined ? 0 : (time / seconds + hash(seed, 381)) % 1;
  if (equipment.kind === 'excavator') {
    const [dx, dy] = equipment.reach;
    const cycle = phase * Math.PI * 2;
    const angle = Math.atan2(dy, dx) + Math.sin(cycle * 2) * 0.65;
    const length = Math.hypot(dx, dy) * (0.85 + Math.cos(cycle * 2) * 0.15);
    c.fillStyle = '#444448';
    c.fillRect(x - 3.2, y - 2.6, 6.4, 1.2);
    c.fillRect(x - 3.2, y + 1.4, 6.4, 1.2);
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    c.fillStyle = '#e9b52f';
    c.fillRect(-2.5, -1.9, 5.0, 3.8);
    c.fillStyle = '#475764';
    c.fillRect(-0.3, -1.35, 2.2, 1.0);
    c.strokeStyle = '#d3a239';
    c.lineWidth = 1.3;
    c.beginPath();
    c.moveTo(0, 0.7);
    c.lineTo(length * 0.56, 1.4);
    c.lineTo(length, 0);
    c.stroke();
    c.fillStyle = '#515559';
    c.fillRect(length - 0.7, -1.1, 1.7, 2.2);
    c.restore();
    return;
  }
  if (equipment.kind === 'rail') {
    // Челнок на технологическом пути. В крайнем положении ковш остывает перед обратным ходом.
    const at = x + (equipment.end - x) * (0.5 - Math.cos(phase * Math.PI * 2) * 0.5);
    c.fillStyle = '#424348';
    c.fillRect(at - 3.8, y - 2.0, 7.6, 4);
    c.fillStyle = equipment.color;
    c.fillRect(at - 2.9, y - 1.3, 5.8, 2.6);
    c.fillStyle = '#727478';
    c.fillRect(at - 8.6, y - 1.65, 4.2, 3.3);
    c.fillStyle = '#d7cfad';
    c.fillRect(at - 8.2, y - 0.9, 1.3, 1.8);
    return;
  }

  const route = equipment.route;
  const pose = equipment.kind === 'harvester' ? harvestPose(route, phase * route.length) : haulPose(route, time, seed);
  paintWorkVehicle(c, equipment, pose);
}

function paintWorkVehicle(
  c: CanvasRenderingContext2D,
  equipment: Extract<Equipment, { kind: 'harvester' | 'haul' }>,
  [px, py, yaw, inbound]: readonly [number, number, number, boolean],
  freight?: { shape: CargoShape; fill: number; scale?: number },
): void {
  const harvest = equipment.kind === 'harvester';
  const length = harvest ? 7.5 : 10;
  const width = harvest ? 4.3 : 5.2;
  c.save();
  c.translate(px, py);
  c.rotate(yaw);
  if (freight?.scale) c.scale(freight.scale, freight.scale);
  c.fillStyle = 'rgba(46,40,28,0.20)';
  c.fillRect(-length / 2 + 0.85, -width / 2 + 1.1, length, width);
  c.fillStyle = '#3f4144';
  for (const wheel of [-width / 2 - 0.2, width / 2 - 0.7]) {
    c.fillRect(-length / 2 + 0.4, wheel, 2.8, 0.9);
    c.fillRect(length / 2 - 2.8, wheel, 1.8, 0.9);
  }
  c.fillStyle = equipment.color;
  c.fillRect(-length / 2, -width / 2 + 0.4, length, width - 0.8);
  c.fillStyle = '#526c78';
  c.fillRect(length / 2 - 1.9, -width / 2 + 0.85, 1.25, width - 1.7);
  if (harvest) {
    c.fillStyle = '#725538';
    c.fillRect(2.5, -3.5, 2.0, 7.0);
    c.fillStyle = '#e4bb56';
    c.fillRect(4.0, -3.4, 1.1, 6.8);
    c.fillStyle = '#dfcc87';
    c.fillRect(-2.6, -1.4, 2.2, 2.8);
  } else if (freight) {
    paintFreight(c, freight.shape, equipment.load, freight.fill);
  } else {
    paintLoad(c, equipment, inbound === !!equipment.incoming);
  }
  c.restore();
}

/** Открытый кузов: при перегрузке количество груза меняется прямо на платформе. */
function paintFreight(c: CanvasRenderingContext2D, shape: CargoShape, color: string, fill: number): void {
  c.fillStyle = '#685e51';
  c.fillRect(-4.4, -1.75, 5.7, 3.5);
  if (shape === 'tank') {
    c.fillStyle = '#d8dce0';
    c.beginPath();
    c.roundRect(-4.45, -1.75, 5.7, 3.5, 1.5);
    c.fill();
    c.fillStyle = color;
    c.fillRect(-3.9, -0.55, 4.5 * fill, 1.1);
    return;
  }
  if (fill <= 0.01) return;
  c.fillStyle = color;
  if (shape === 'bulk' || shape === 'silo') {
    c.beginPath();
    const rx = 2.5 * Math.sqrt(fill);
    c.ellipse(-1.6, 0, rx, 1.4 * Math.sqrt(fill), 0, 0, 2 * Math.PI);
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.22)';
    c.beginPath();
    c.ellipse(-1.9, -0.3, 0.65 * fill, 0.47 * fill, 0, 0, 2 * Math.PI);
    c.fill();
    return;
  }
  if (shape === 'logs' || shape === 'planks') {
    for (let i = 0; i < Math.ceil(fill * 3); i++) c.fillRect(-4.05, -1.35 + i * 0.94, 4.8, 0.72);
    return;
  }
  const nx = shape === 'bricks' ? 4 : 2;
  const dx = 4.85 / nx;
  for (let i = 0; i < Math.ceil(fill * nx * 2); i++) {
    c.fillRect(-4.1 + Math.floor(i / 2) * dx, -1.35 + i % 2 * 1.48, dx - 0.20, 1.23);
  }
}

function harvestPose(route: Circuit, where: number): readonly [number, number, number, boolean] {
  const [x, y] = onCircuit(route, where);
  const [nx, ny] = onCircuit(route, (where + 0.015) % route.length);
  return [x, y, Math.atan2(ny - y, nx - x), true];
}

function paintLoad(c: CanvasRenderingContext2D, equipment: Extract<Equipment, { kind: 'haul' }>, loaded: boolean): void {
  c.fillStyle = '#766b58';
  c.fillRect(-4.4, -1.65, 5.7, 3.3);
  if (equipment.body === 'tank') {
    c.fillStyle = '#d6dce0';
    c.beginPath();
    c.roundRect(-4.45, -1.75, 5.7, 3.5, 1.5);
    c.fill();
    c.fillStyle = equipment.load;
    c.fillRect(-3.2, -0.38, 3.5, 0.76);
  } else if (equipment.body === 'box') {
    c.fillStyle = '#e1dfd4';
    c.fillRect(-4.35, -1.7, 5.6, 3.4);
    c.fillStyle = equipment.load;
    c.fillRect(-4, -1.45, 1.45, 2.9);
  } else if (loaded) {
    c.fillStyle = equipment.load;
    c.fillRect(-3.85, -1.25, 4.45, 2.5);
    if (equipment.body === 'flatbed') {
      c.fillStyle = '#5f5346';
      c.fillRect(-3.75, -0.2, 4.3, 0.4);
    }
  }
}
