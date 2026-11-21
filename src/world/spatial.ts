import { closestOnSegment, segSegDist, type Vec } from '../core/vec';
import type { CompoundPlan } from './industryCompound';

/** Нормированные координаты внутри участка. Части могут выходить за размеры базовой сцены w × h. */
export type Plot = readonly Vec[];

/** Участок с поворотом. Без частей — обычный прямоугольник. */
export interface Footprint {
  center: Vec;
  w: number;
  h: number;
  angle: number;
  parts?: readonly Plot[];
  /** Число площадок без технологических проездов в начале списка частей. */
  groundParts?: number;
  compound?: CompoundPlan;
}

export function footprintRadius(f: Footprint): number {
  if (f.parts) {
    let squared = 0;
    for (const part of f.parts) for (const { x, y } of part) squared = Math.max(squared, (x * f.w) ** 2 + (y * f.h) ** 2);
    return Math.sqrt(squared);
  }
  return Math.hypot(f.w, f.h) / 2;
}

/** Лежит ли точка внутри прямоугольника, расширенного на margin. */
export function pointInFootprint(p: Vec, f: Footprint, margin = 0): boolean {
  const dx = p.x - f.center.x;
  const dy = p.y - f.center.y;
  const c = Math.cos(-f.angle);
  const s = Math.sin(-f.angle);
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  if (f.parts) {
    const p = { x: lx / f.w, y: ly / f.h };
    return f.parts.some((part) => {
      const inside = pointInPolygon(p, part);
      if (!margin || inside === (margin > 0)) return inside;
      const within = part.some((a, i) => {
        const b = part[(i + 1) % part.length];
        return closestOnSegment({ x: lx, y: ly }, { x: a.x * f.w, y: a.y * f.h }, { x: b.x * f.w, y: b.y * f.h }).d <= Math.abs(margin);
      });
      return margin > 0 ? within : !within;
    });
  }
  return Math.abs(lx) <= f.w / 2 + margin && Math.abs(ly) <= f.h / 2 + margin;
}

export function pointInPolygon(p: Vec, polygon: Plot): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (b.x - a.x) * (p.y - a.y) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

function worldPlots(f: Footprint): readonly Plot[] {
  if (!f.parts) return [footprintCorners(f)];
  const cos = Math.cos(f.angle);
  const sin = Math.sin(f.angle);
  return f.parts.map((part) => part.map(({ x, y }) => {
    const lx = x * f.w;
    const ly = y * f.h;
    return { x: f.center.x + lx * cos - ly * sin, y: f.center.y + lx * sin + ly * cos };
  }));
}

/** Вершины всех частей. Для прямоугольника — четыре угла в порядке обхода. */
export function footprintCorners(f: Footprint): Vec[] {
  if (f.parts) return worldPlots(f).flat();
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([x, y]) => {
    const lx = (x * f.w) / 2;
    const ly = (y * f.h) / 2;
    return { x: f.center.x + lx * c - ly * s, y: f.center.y + lx * s + ly * c };
  });
}

/** Опорная граница участка вдоль единичной нормали (для подъездов). */
export function footprintSide(f: Footprint, normal: Vec): number {
  return Math.max(...footprintCorners(f).map((p) => (p.x - f.center.x) * normal.x + (p.y - f.center.y) * normal.y));
}

/** Полотно вдоль кривой. Малый запас перекрывает расстояние между соседними пробами. */
export function footprintAlong(
  f: Footprint, curve: { length: number; pointAt(s: number): Vec }, widthAt: (s: number) => number,
): boolean {
  const steps = Math.max(1, Math.ceil(curve.length / 3));
  const step = curve.length / steps;
  const r = footprintRadius(f);
  for (let i = 0; i <= steps; i++) {
    const s = i * step;
    const p = curve.pointAt(s);
    const margin = widthAt(s) + step / 2;
    if ((p.x - f.center.x) ** 2 + (p.y - f.center.y) ** 2 <= (r + margin) ** 2 && pointInFootprint(p, f, margin)) return true;
  }
  return false;
}

/** Пересекаются ли прямоугольники (по разделяющим осям). */
export function footprintsOverlap(a: Footprint, b: Footprint, margin = 0): boolean {
  if (a.parts || b.parts) {
    const reach = footprintRadius(a) + footprintRadius(b) + Math.max(0, margin);
    if ((a.center.x - b.center.x) ** 2 + (a.center.y - b.center.y) ** 2 > reach ** 2) return false;
    const left = worldPlots(a);
    const right = worldPlots(b);
    for (const p of left) for (const q of right) {
      if (pointInPolygon(p[0], q) || pointInPolygon(q[0], p)) return true;
      for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) {
        if (segSegDist(p[i], p[(i + 1) % p.length], q[j], q[(j + 1) % q.length]) <= Math.max(0, margin)) return true;
      }
    }
    return false;
  }
  // Горячее место генерации городов: углы и проекции — та же арифметика, что footprintCorners и
  // проекция на оси, только без временных массивов и объектов.
  const ca = cornersInto(CA, a.center, a.w + margin * 2, a.h + margin * 2, a.angle);
  const cb = cornersInto(CB, b.center, b.w, b.h, b.angle);
  for (let k = 0; k < 4; k++) {
    const angle = k === 0 ? a.angle : k === 1 ? a.angle + Math.PI / 2 : k === 2 ? b.angle : b.angle + Math.PI / 2;
    const ax = Math.cos(angle);
    const ay = Math.sin(angle);
    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (let i = 0; i < 8; i += 2) {
      const pa = ca[i] * ax + ca[i + 1] * ay;
      const pb = cb[i] * ax + cb[i + 1] * ay;
      if (pa < minA) minA = pa;
      if (pa > maxA) maxA = pa;
      if (pb < minB) minB = pb;
      if (pb > maxB) maxB = pb;
    }
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}

const CA = new Float64Array(8);
const CB = new Float64Array(8);
const CORNER_SIGNS = [-1, -1, 1, -1, 1, 1, -1, 1];

/** Углы как у footprintCorners (x, y по очереди) — в готовый массив out. */
function cornersInto(out: Float64Array, center: Vec, w: number, h: number, angle: number): Float64Array {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let i = 0; i < 8; i += 2) {
    const lx = (CORNER_SIGNS[i] * w) / 2;
    const ly = (CORNER_SIGNS[i + 1] * h) / 2;
    out[i] = center.x + lx * c - ly * s;
    out[i + 1] = center.y + lx * s + ly * c;
  }
  return out;
}

/** Сеточный индекс прямоугольников для быстрых проверок «занято ли место». */
export class FootprintIndex<T extends { fp: Footprint }> {
  private readonly cells = new Map<string, { items: T[]; revision: number }>();
  readonly items = new Set<T>();
  version = 0;

  constructor(private readonly cell = 120) {}

  private keys(f: Footprint, extra = 0): string[] {
    const r = footprintRadius(f) + extra;
    const x0 = Math.floor((f.center.x - r) / this.cell);
    const x1 = Math.floor((f.center.x + r) / this.cell);
    const y0 = Math.floor((f.center.y - r) / this.cell);
    const y1 = Math.floor((f.center.y + r) / this.cell);
    const keys: string[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x}:${y}`);
    return keys;
  }

  add(item: T): void {
    this.version++;
    this.items.add(item);
    for (const k of this.keys(item.fp)) {
      let cell = this.cells.get(k);
      if (!cell) this.cells.set(k, cell = { items: [], revision: this.version });
      cell.items.push(item);
      cell.revision = this.version;
    }
  }

  remove(item: T): void {
    this.version++;
    this.items.delete(item);
    for (const k of this.keys(item.fp)) {
      const cell = this.cells.get(k);
      if (cell) {
        cell.items = cell.items.filter((x) => x !== item);
        cell.revision = this.version;
      }
    }
  }

  near(p: Vec, radius: number): T[] {
    const result = new Set<T>();
    const x0 = Math.floor((p.x - radius) / this.cell);
    const x1 = Math.floor((p.x + radius) / this.cell);
    const y0 = Math.floor((p.y - radius) / this.cell);
    const y1 = Math.floor((p.y + radius) / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) for (const it of this.cells.get(`${x}:${y}`)?.items ?? []) result.add(it);
    }
    return [...result];
  }

  /** Последняя вставка или удаление в области запроса near, включая уже опустевшие клетки. */
  nearVersion(p: Vec, radius: number): number {
    let revision = 0;
    const x1 = Math.floor((p.x + radius) / this.cell);
    const y1 = Math.floor((p.y + radius) / this.cell);
    for (let x = Math.floor((p.x - radius) / this.cell); x <= x1; x++) {
      for (let y = Math.floor((p.y - radius) / this.cell); y <= y1; y++) {
        revision = Math.max(revision, this.cells.get(`${x}:${y}`)?.revision ?? 0);
      }
    }
    return revision;
  }

  at(p: Vec, margin = 0): T | null {
    for (const it of this.near(p, margin + 1)) if (pointInFootprint(p, it.fp, margin)) return it;
    return null;
  }

  overlaps(f: Footprint, margin = 0, ignore?: (item: T) => boolean): boolean {
    // Описанные окружности врозь (с запасом в метр) — прямоугольники точно не пересекаются: без точной проверки.
    const r = footprintRadius(f) + Math.max(0, margin) * Math.SQRT2 + 1;
    for (const it of this.near(f.center, footprintRadius(f) + margin + 200)) {
      if (ignore?.(it)) continue;
      const dx = it.fp.center.x - f.center.x;
      const dy = it.fp.center.y - f.center.y;
      const reach = r + footprintRadius(it.fp);
      if (dx * dx + dy * dy > reach * reach) continue;
      if (footprintsOverlap(f, it.fp, margin)) return true;
    }
    return false;
  }
}
