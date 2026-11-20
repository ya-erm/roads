import { hash } from '../core/math';

export type WorkPoint = readonly [x: number, y: number];
export type Circuit = readonly WorkPoint[];
export type Equipment =
  | { kind: 'harvester'; route: Circuit; color: string }
  | { kind: 'haul'; route: Circuit; color: string; load: string; incoming?: boolean; body?: 'tank' | 'box' | 'flatbed' }
  | { kind: 'excavator'; reach: WorkPoint }
  | { kind: 'rail'; end: number; color: string };

/** Один и тот же сплайн задаёт колею и траекторию колёс. */
function onCircuit(route: Circuit, t: number, closed = true): WorkPoint {
  const idx = Math.min(Math.floor(t), closed ? route.length - 1 : route.length - 2);
  const f = t - idx;
  const n = route.length;
  const prev = route[closed ? (idx + n - 1) % n : Math.max(0, idx - 1)];
  const from = route[idx];
  const to = route[(idx + 1) % n];
  const next = route[closed ? (idx + 2) % n : Math.min(n - 1, idx + 2)];
  const interpolate = (axis: 0 | 1) => {
    const a = prev[axis];
    const b = from[axis];
    const c = to[axis];
    const d = next[axis];
    return b + 0.5 * f * ((c - a) + f * ((2 * a - 5 * b + 4 * c - d) + f * (3 * b - a - 3 * c + d)));
  };
  return [interpolate(0), interpolate(1)];
}

export function traceCircuit(c: CanvasRenderingContext2D, route: Circuit, closed = true): void {
  c.beginPath();
  c.moveTo(...route[0]);
  const steps = (closed ? route.length : route.length - 1) * 8;
  for (let step = 1; step <= steps; step++) c.lineTo(...onCircuit(route, closed ? (step / 8) % route.length : step / 8, closed));
  if (closed) c.closePath();
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
  const harvest = equipment.kind === 'harvester';
  const where = harvest ? phase * route.length : (0.5 - 0.5 * Math.cos(phase * Math.PI * 2)) * (route.length - 1);
  const [px, py] = onCircuit(route, where, harvest);
  const ahead = harvest ? (where + 0.015) % route.length : Math.min(route.length - 1, where + 0.015);
  const behind = harvest ? where : Math.max(0, where - 0.015);
  const [nx, ny] = onCircuit(route, ahead, harvest);
  const [bx, by] = onCircuit(route, behind, harvest);
  const length = harvest ? 7.5 : 10;
  const width = harvest ? 4.3 : 5.2;
  c.save();
  c.translate(px, py);
  c.rotate(Math.atan2(ny - by, nx - bx) + (!harvest && phase >= 0.5 ? Math.PI : 0));
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
  } else {
    paintLoad(c, equipment, (phase < 0.5) === !!equipment.incoming);
  }
  c.restore();
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
