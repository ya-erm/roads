import type { Vec } from '../core/vec';

/** Дерево карты: где стоит и спрятано ли (под дорогой, путями, строением). */
export interface CoverTree {
  pos: Vec;
  hidden: boolean;
}

/** Кто прячет деревья: кружки x, y, r подряд. Ключ — что угодно, по чему его узнать в следующий раз. */
export type Hiders = Map<unknown, number[]>;

/** Клетка сетки деревьев, м. */
const CELL = 60;
/** Номер клетки — числом (строки на каждое дерево и каждый кружок заметно дороже). */
const cellKey = (x: number, y: number) => (x + 4096) * 8192 + y + 4096;
/** Изменилось больше стольких «прячущих» — проще пересчитать всё. */
const MANY = 400;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxOf(pts: number[]): Box {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (let i = 0; i < pts.length; i += 3) {
    const r = pts[i + 2];
    b.x0 = Math.min(b.x0, pts[i] - r);
    b.y0 = Math.min(b.y0, pts[i + 1] - r);
    b.x1 = Math.max(b.x1, pts[i] + r);
    b.y1 = Math.max(b.y1, pts[i + 1] + r);
  }
  return b;
}

const meets = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
const sameNumbers = (a: number[], b: number[]) => a === b || (a.length === b.length && a.every((v, i) => v === b[i]));

/**
 * Какие деревья спрятаны: дерево — внутри хоть одного кружка (строго ближе r к центру). После правки пересчитываются
 * только деревья в рамках тех, кто поменялся (прежние и новые кружки), — по всем, кто до этих рамок достаёт; выходит
 * то же, что и пересчёт всей карты (`full`), но без прохода по всем дорогам и строениям.
 */
export class TreeCover {
  private trees: CoverTree[] | null = null;
  private n = 0;
  private cells = new Map<number, number[]>();
  private last = new Map<unknown, { pts: number[]; box: Box }>();

  update(trees: CoverTree[], hiders: Hiders): void {
    if (this.trees !== trees || this.n !== trees.length) return this.full(trees, hiders);
    const dirty: Box[] = [];
    const next = new Map<unknown, { pts: number[]; box: Box }>();
    for (const [key, pts] of hiders) {
      const was = this.last.get(key);
      if (was && sameNumbers(was.pts, pts)) {
        next.set(key, was);
        continue;
      }
      const item = { pts, box: boxOf(pts) };
      next.set(key, item);
      if (was) dirty.push(was.box);
      if (pts.length) dirty.push(item.box);
      if (dirty.length > MANY) return this.full(trees, hiders);
    }
    for (const [key, was] of this.last) if (!next.has(key) && was.pts.length) dirty.push(was.box);
    this.last = next;
    if (!dirty.length) return;
    if (dirty.length > MANY) return this.full(trees, hiders);
    // Деревья в рамках изменений — заново.
    const mark = new Uint8Array(trees.length);
    let any = false;
    for (const b of dirty) {
      this.eachIn(b.x0, b.y0, b.x1, b.y1, (i) => {
        const p = trees[i].pos;
        if (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1 || mark[i]) return;
        mark[i] = 1;
        trees[i].hidden = false;
        any = true;
      });
    }
    if (!any) return;
    for (const { pts, box } of next.values()) {
      if (!dirty.some((b) => meets(b, box))) continue;
      for (let i = 0; i < pts.length; i += 3) this.hide(pts[i], pts[i + 1], pts[i + 2], mark);
    }
  }

  /** Всё заново: сетка деревьев (если они другие) и все кружки. */
  full(trees: CoverTree[], hiders: Hiders): void {
    if (this.trees !== trees || this.n !== trees.length) {
      this.trees = trees;
      this.n = trees.length;
      this.cells = new Map();
      trees.forEach((t, i) => {
        const k = cellKey(Math.floor(t.pos.x / CELL), Math.floor(t.pos.y / CELL));
        const list = this.cells.get(k);
        if (list) list.push(i);
        else this.cells.set(k, [i]);
      });
    }
    for (const t of trees) t.hidden = false;
    this.last = new Map();
    for (const [key, pts] of hiders) {
      this.last.set(key, { pts, box: boxOf(pts) });
      for (let i = 0; i < pts.length; i += 3) this.hide(pts[i], pts[i + 1], pts[i + 2], null);
    }
  }

  /** Деревья в клетках, задевающих рамку. */
  private eachIn(x0: number, y0: number, x1: number, y1: number, fn: (i: number) => void): void {
    for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) {
      for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++) {
        const list = this.cells.get(cellKey(x, y));
        if (list) for (const i of list) fn(i);
      }
    }
  }

  /** Прячет деревья ближе r к (px, py); only — только отмеченные. */
  private hide(px: number, py: number, r: number, only: Uint8Array | null): void {
    const trees = this.trees!;
    const r2 = r * r;
    const x1 = Math.floor((px + r) / CELL);
    const y0 = Math.floor((py - r) / CELL);
    const y1 = Math.floor((py + r) / CELL);
    for (let x = Math.floor((px - r) / CELL); x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const list = this.cells.get(cellKey(x, y));
        if (!list) continue;
        for (const i of list) {
          if (only && !only[i]) continue;
          const p = trees[i].pos;
          if ((p.x - px) ** 2 + (p.y - py) ** 2 < r2) trees[i].hidden = true;
        }
      }
    }
  }
}
