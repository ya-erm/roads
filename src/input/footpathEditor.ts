import { quadToCubic } from '../core/bezier';
import { add, dist, sub, type Vec } from '../core/vec';
import type { DrawMode } from '../game/build';
import { footpathLength, nearestFootpath, type Footpath, type FootpathShape } from '../game/footpaths';
import type { Game } from '../game/game';
import type { ToolOverlay } from '../render/renderer';
import { money } from './labels';

export type FootpathMode = DrawMode | 'move';
type Geometry = Omit<Footpath, 'id'>;
type Part = 'a' | 'b' | 'through' | 'c1' | 'c2' | 'body' | number;
type Snap = (p: Vec, skipId?: number) => Vec;
type Picked = { path: Footpath; part: Part };
type PathHandle = { part: Exclude<Part, 'body'>; pos: Vec };
const handleLabels = {
  a: 'Перенести конец', b: 'Перенести конец', through: 'Изменить дугу',
  c1: 'Изменить изгиб', c2: 'Изменить изгиб', body: 'Перенести дорожку',
};

function handles(path: Geometry): PathHandle[] {
  const h: PathHandle[] = [{ part: 'a', pos: path.a }, { part: 'b', pos: path.b }];
  if (path.shape?.kind === 'arc') h.push({ part: 'through', pos: path.shape.through });
  if (path.shape?.kind === 'curve') h.push({ part: 'c1', pos: path.shape.c1 }, { part: 'c2', pos: path.shape.c2 });
  if (path.shape?.kind === 'polyline') path.shape.via.forEach((pos, part) => h.push({ pos, part }));
  return h;
}

function handleAt(path: Geometry, p: Vec, radius: number) {
  return handles(path).map(h => ({ ...h, d: dist(p, h.pos) })).filter(h => h.d <= radius).sort((a, b) => a.d - b.d)[0];
}

function edit(path: Footpath, part: Part, pointer: Vec, from: Vec, snap: Snap): Geometry {
  let { a, b, shape } = path;
  if (part === 'body') {
    let delta = sub(pointer, from);
    // При переносе сохраняем геометрию и можем соединить любой конец с соседней дорожкой.
    for (const end of [a, b]) {
      const moved = add(end, delta);
      const target = snap(moved, path.id);
      if (dist(moved, target) > 0.001) { delta = sub(target, end); break; }
    }
    a = add(a, delta);
    b = add(b, delta);
    if (shape?.kind === 'arc') shape = { ...shape, through: add(shape.through, delta) };
    if (shape?.kind === 'curve') shape = { ...shape, c1: add(shape.c1, delta), c2: add(shape.c2, delta) };
    if (shape?.kind === 'polyline') shape = { ...shape, via: shape.via.map(p => add(p, delta)) };
  } else if (part === 'a' || part === 'b') {
    const target = snap(pointer, path.id);
    if (part === 'a') {
      if (shape?.kind === 'curve') shape = { ...shape, c1: add(shape.c1, sub(target, a)) };
      a = target;
    } else {
      if (shape?.kind === 'curve') shape = { ...shape, c2: add(shape.c2, sub(target, b)) };
      b = target;
    }
  } else if (shape?.kind === 'arc' && part === 'through') {
    shape = { ...shape, through: pointer };
  } else if (shape?.kind === 'curve' && (part === 'c1' || part === 'c2')) {
    shape = { ...shape, [part]: pointer };
  } else if (shape?.kind === 'polyline' && typeof part === 'number') {
    shape = { ...shape, via: shape.via.map((pos, i) => i === part ? pointer : pos) };
  }
  return { a, b, shape };
}

export class FootpathEditor {
  mode: FootpathMode = 'straight';
  private start: Vec | null = null;
  private control: Vec | null = null;
  private selected: number | null = null;
  private drag: (Picked & { from: Vec }) | null = null;

  clear(): void {
    this.start = this.control = null;
    this.selected = null;
    this.drag = null;
  }

  cancel(): boolean {
    if (!this.start && !this.drag && this.selected === null) return false;
    this.clear();
    return true;
  }

  private pick(paths: readonly Footpath[], p: Vec, radius: number): Picked | undefined {
    const selected = paths.find(path => path.id === this.selected);
    if (selected) {
      const h = handleAt(selected, p, radius);
      if (h) return { path: selected, part: h.part };
    }
    const path = nearestFootpath(paths, p, radius)?.path;
    if (path) return { path, part: handleAt(path, p, radius)?.part ?? 'body' };
  }

  down(game: Game, p: Vec, radius: number, snap: Snap): boolean {
    if (this.mode === 'move') {
      const hit = this.pick(game.editableFootpaths(), p, radius);
      this.selected = hit?.path.id ?? null;
      this.drag = hit ? { ...hit, from: p } : null;
    } else if (!this.start) {
      this.start = snap(p);
      return true;
    }
    return false;
  }

  private shape(end: Vec): FootpathShape | undefined {
    if (!this.start || !this.control) return;
    if (this.mode === 'arc') return { kind: 'arc', through: this.control };
    const { p1, p2 } = quadToCubic(this.start, this.control, end);
    return { kind: 'curve', c1: p1, c2: p2 };
  }

  up(game: Game, p: Vec, moved: boolean, began: boolean, snap: Snap): string | null {
    if (this.mode === 'move') {
      const drag = this.drag;
      this.drag = null;
      if (!drag || !moved) return null;
      const { a, b, shape } = edit(drag.path, drag.part, p, drag.from, snap);
      return game.moveFootpath(drag.path.id, a, b, shape, drag.part === 'a' || drag.part === 'b');
    }
    if (!this.start || (began && !moved)) return null;
    if (this.mode !== 'straight' && !this.control) {
      if (dist(this.start, p) < 0.1) return 'Укажите изгиб дальше от начала дорожки';
      this.control = p;
      return null;
    }
    const end = snap(p);
    const reason = game.buildFootpath(this.start, end, this.shape(end));
    if (!reason) { this.start = end; this.control = null; }
    return reason;
  }

  overlay(game: Game, p: Vec, radius: number, snap: Snap): Partial<ToolOverlay> {
    if (this.mode === 'move') {
      const paths = game.editableFootpaths();
      const hit = this.drag ?? this.pick(paths, p, radius);
      const path = hit?.path ?? paths.find(x => x.id === this.selected);
      if (!path) return { label: { text: 'Выберите дорожку для переноса или правки формы', ok: true } };
      const geom = this.drag ? edit(path, this.drag.part, p, this.drag.from, snap) : path;
      const plan = this.drag && game.footpathPlan(geom.a, geom.b, geom.shape, path.id, this.drag.part === 'a' || this.drag.part === 'b');
      const ok = !plan?.reason;
      const action = hit && (typeof hit.part === 'number' ? 'Перенести вершину' : handleLabels[hit.part]);
      return {
        footpath: { ...geom, ok },
        points: handles(geom).map(h => ({ pos: h.pos, color: h.part === 'a' || h.part === 'b' ? '#2f80ed' : '#f2994a', r: 5 })),
        handles: geom.shape?.kind === 'curve' ? [
          { anchor: geom.a, pos: geom.shape.c1, active: hit?.part === 'c1', partner: false },
          { anchor: geom.b, pos: geom.shape.c2, active: hit?.part === 'c2', partner: false },
        ] : undefined,
        label: { text: plan?.reason ?? action ?? 'Потяните дорожку или одну из её ручек', ok },
      };
    }
    const awaitingControl = this.mode !== 'straight' && !this.control;
    const end = this.start && awaitingControl ? p : snap(p);
    const shape = this.shape(end);
    const path = this.start && !awaitingControl && dist(this.start, end) > 0.1 ? { a: this.start, b: end, shape } : null;
    const plan = path && game.footpathPlan(path.a, path.b, shape);
    const ok = !plan?.reason;
    const points = [{ pos: end, color: ok ? '#2f80ed' : '#df403c', r: 4 }];
    if (this.start) points.push({ pos: this.start, color: '#2f80ed', r: 4 });
    if (this.control) points.push({ pos: this.control, color: '#f2994a', r: 4 });
    const prompt = !this.start ? 'Укажите начало дорожки' : awaitingControl ? (this.mode === 'arc' ? 'Укажите точку на дуге' : 'Укажите изгиб кривой') : 'Укажите конец дорожки · Esc — закончить';
    return { points, footpath: path ? { ...path, ok } : undefined, label: { text: plan && path ? plan.reason ?? `${Math.round(footpathLength(path))} м · ${money(plan.cost)}` : prompt, ok } };
  }
}
