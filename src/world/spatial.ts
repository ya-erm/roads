import type { Vec } from '../core/vec';

/** Повёрнутый прямоугольник: здания, предприятия, станции. */
export interface Footprint {
  center: Vec;
  w: number;
  h: number;
  angle: number;
}

export function footprintRadius(f: Footprint): number {
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
  return Math.abs(lx) <= f.w / 2 + margin && Math.abs(ly) <= f.h / 2 + margin;
}

export function footprintCorners(f: Footprint): Vec[] {
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

/** Пересекаются ли прямоугольники (по разделяющим осям). */
export function footprintsOverlap(a: Footprint, b: Footprint, margin = 0): boolean {
  const ca = footprintCorners({ ...a, w: a.w + margin * 2, h: a.h + margin * 2 });
  const cb = footprintCorners(b);
  for (const f of [a, b]) {
    for (const angle of [f.angle, f.angle + Math.PI / 2]) {
      const ax = Math.cos(angle);
      const ay = Math.sin(angle);
      const proj = (pts: Vec[]) => pts.map((p) => p.x * ax + p.y * ay);
      const pa = proj(ca);
      const pb = proj(cb);
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
  }
  return true;
}

/** Сеточный индекс прямоугольников для быстрых проверок «занято ли место». */
export class FootprintIndex<T extends { fp: Footprint }> {
  private readonly cells = new Map<string, T[]>();
  readonly items = new Set<T>();

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
    this.items.add(item);
    for (const k of this.keys(item.fp)) {
      if (!this.cells.has(k)) this.cells.set(k, []);
      this.cells.get(k)!.push(item);
    }
  }

  remove(item: T): void {
    this.items.delete(item);
    for (const k of this.keys(item.fp)) {
      const list = this.cells.get(k);
      if (list) this.cells.set(k, list.filter((x) => x !== item));
    }
  }

  near(p: Vec, radius: number): T[] {
    const result = new Set<T>();
    const x0 = Math.floor((p.x - radius) / this.cell);
    const x1 = Math.floor((p.x + radius) / this.cell);
    const y0 = Math.floor((p.y - radius) / this.cell);
    const y1 = Math.floor((p.y + radius) / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) for (const it of this.cells.get(`${x}:${y}`) ?? []) result.add(it);
    }
    return [...result];
  }

  at(p: Vec, margin = 0): T | null {
    for (const it of this.near(p, margin + 1)) if (pointInFootprint(p, it.fp, margin)) return it;
    return null;
  }

  overlaps(f: Footprint, margin = 0): boolean {
    for (const it of this.near(f.center, footprintRadius(f) + margin + 200)) {
      if (footprintsOverlap(f, it.fp, margin)) return true;
    }
    return false;
  }
}
