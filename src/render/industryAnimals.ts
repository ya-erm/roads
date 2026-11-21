import { hash, lerp, smoothstep } from '../core/math';
import { angleDiff } from '../core/vec';

export interface GrazingAnimal {
  x: number;
  y: number;
  angle: number;
  seed: number;
  index: number;
  sheep: boolean;
  size: number;
  roamX: number;
  roamY: number;
  shadowX: number;
  shadowY: number;
}

/** Свободное место для туловища и головы при любом повороте. */
export const animalClearance = (sheep: boolean): number => sheep ? 2.8 : 3.6;

/** Точки отдыха и короткие переходы между ними остаются в отведённом участке. */
export function animalPose(a: GrazingAnimal, time: number): { x: number; y: number; angle: number } {
  if (Math.max(a.roamX, a.roamY) < 0.1) return { x: a.x, y: a.y, angle: a.angle };
  const seed = a.seed ^ Math.imul(a.index, 997);
  const period = 8 + 7 * hash(seed, 1);
  const progress = time / period + hash(seed, 2);
  const index = Math.floor(progress);
  const phase = progress - index;
  const point = (i: number) => {
    const angle = a.angle + Math.PI * 2 * hash(seed, 5 * i + 3);
    const r = 0.3 + 0.7 * hash(seed, 5 * i + 4);
    return { x: a.x + a.roamX * Math.cos(angle) * r, y: a.y + a.roamY * Math.sin(angle) * r };
  };
  const from = point(index);
  const to = point(index + 1);
  const prev = point(index - 1);
  const facing = Math.atan2(to.y - from.y, to.x - from.x);
  const arrived = Math.atan2(from.y - prev.y, from.x - prev.x);
  const moving = smoothstep((phase - 0.35) / 0.65);
  const angle = arrived + angleDiff(arrived, facing) * smoothstep((phase - 0.17) / 0.18);
  return { x: lerp(from.x, to.x, moving), y: lerp(from.y, to.y, moving), angle };
}

export function paintGrazingAnimal(c: CanvasRenderingContext2D, a: GrazingAnimal, time: number): void {
  const { x, y, angle } = animalPose(a, time);
  const pale = hash(a.seed, a.index * 11 + 7);
  const brown = !a.sheep && pale < 0.4;
  const body = a.sheep ? (pale < 0.15 ? '#d9cfbd' : '#f6f3ea') : brown ? '#8a5a3c' : '#f2efe8';
  const bodyX = a.sheep ? 1.6 : 2.2;
  const bodyY = a.sheep ? 1.2 : 1.1;
  const shadow = a.sheep ? 0.6 : 0.8;
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  if (a.size !== 1) c.scale(a.size, a.size);
  c.fillStyle = 'rgba(30,40,25,0.22)';
  c.beginPath();
  c.ellipse(a.shadowX * shadow, a.shadowY * shadow, bodyX, bodyY, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = body;
  c.beginPath();
  c.ellipse(0, 0, bodyX, bodyY, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = brown ? '#5e3c27' : '#3d3a36';
  c.beginPath();
  if (a.sheep) c.ellipse(1.8, 0, 0.6, 0.45, 0, 0, Math.PI * 2);
  else c.ellipse(2.4, 0, 0.8, 0.6, 0, 0, Math.PI * 2);
  c.fill();
  if (!a.sheep && !brown) {
    c.beginPath();
    c.ellipse(-0.6 + hash(a.seed, a.index * 11 + 8) * 1.2, -0.2, 0.7, 0.5, 0, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}
