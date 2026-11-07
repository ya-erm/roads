/**
 * Пометки на снимке баг-репорта: прямоугольник, овал, линия, стрелка, текст и кадр. Модель без DOM: создать,
 * найти под курсором, подвинуть, потянуть за узелок, поменять цвет, толщину, текст и размер, кадрировать, отменить.
 *
 * Координаты — в точках экрана игры на момент снимка (CSS px), а не в пикселях картинки: толщина 3 — как 3 px
 * на экране при любой плотности пикселей. Объекты неизменяемые: правка возвращает новый объект и новый Sketch —
 * так отмена хранит просто прежние состояния.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow';
export type MarkKind = ShapeKind | 'text';
/** Инструменты редактора: выбор, кадр, участок карты и виды пометок. */
export type Tool = 'select' | 'crop' | 'area' | MarkKind;

/** Фигура от точки a до точки b: у прямоугольника и овала это противоположные углы рамки. */
export interface ShapeMark {
  id: number;
  kind: ShapeKind;
  color: string;
  width: number;
  a: Pt;
  b: Pt;
}

/** Текст: at — левый верхний угол первой строки, size — высота букв (px), строки — через \n. */
export interface TextMark {
  id: number;
  kind: 'text';
  color: string;
  size: number;
  at: Pt;
  text: string;
}

export type Mark = ShapeMark | TextMark;
export type NewMark = Omit<ShapeMark, 'id'> | Omit<TextMark, 'id'>;

/** Узелки: концы a и b; у прямоугольника и овала ещё два угла — ab (x от a, y от b) и ba (x от b, y от a). */
export type Handle = 'a' | 'b' | 'ab' | 'ba';

/**
 * Все пометки снимка и кадр (null — снимок целиком). area — участок карты, на который жалуются (рамка
 * инструмента «Участок»): по нему отчёт пишет координаты в мире (bugreport/spot.ts).
 */
export interface Sketch {
  readonly marks: readonly Mark[];
  readonly crop: Box | null;
  readonly area?: Box | null;
  readonly nextId: number;
}

/** Что задают панели редактора: цвет, толщина линий и размер текста. */
export interface Style {
  color: string;
  width: number;
  size: number;
}

/** Ширина строки текста размера size — в браузере её меряет canvas, в тестах — простая оценка. */
export type Measure = (line: string, size: number) => number;

/** Межстрочный интервал текста — доля размера. */
export const LINE_HEIGHT = 1.25;
/** Отступ рамки текста от букв — доля размера. */
export const TEXT_PAD = 0.3;
/** Кадр меньше этого (по любой стороне) не считается: снимок остаётся целым. */
export const MIN_CROP = 8;

export const emptySketch = (): Sketch => ({ marks: [], crop: null, nextId: 1 });

export const isShape = (m: Mark): m is ShapeMark => m.kind !== 'text';

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Рамка по двум противоположным углам. */
export function normBox(a: Pt, b: Pt): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

export function grow(box: Box, d: number): Box {
  return { x: box.x - d, y: box.y - d, w: box.w + 2 * d, h: box.h + 2 * d };
}

export function inBox(p: Pt, box: Box): boolean {
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}

/** Расстояние от точки до отрезка ab. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Расстояние от точки до контура прямоугольника (изнутри — до ближайшей стороны). */
export function distToRectEdge(p: Pt, box: Box): number {
  const x1 = box.x + box.w;
  const y1 = box.y + box.h;
  if (inBox(p, box)) return Math.min(p.x - box.x, x1 - p.x, p.y - box.y, y1 - p.y);
  return Math.hypot(Math.max(box.x - p.x, 0, p.x - x1), Math.max(box.y - p.y, 0, p.y - y1));
}

/** Расстояние от точки до контура овала, вписанного в рамку, — по лучу из центра (для попадания мышью хватает). */
export function distToEllipseEdge(p: Pt, box: Box): number {
  const rx = box.w / 2;
  const ry = box.h / 2;
  const c = { x: box.x + rx, y: box.y + ry };
  // Сплющенный в линию овал — как отрезок.
  if (rx < 0.5 || ry < 0.5) return distToSegment(p, { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y + box.h });
  const d = Math.hypot((p.x - c.x) / rx, (p.y - c.y) / ry);
  if (d === 0) return Math.min(rx, ry);
  const r = dist(p, c);
  return Math.abs(r - r / d);
}

function insideShape(p: Pt, m: ShapeMark): boolean {
  const box = normBox(m.a, m.b);
  if (m.kind === 'rect') return inBox(p, box);
  if (m.kind === 'ellipse') {
    const rx = box.w / 2;
    const ry = box.h / 2;
    return rx > 0 && ry > 0 && Math.hypot((p.x - box.x - rx) / rx, (p.y - box.y - ry) / ry) <= 1;
  }
  return false;
}

/** Рамка текста: буквы и отступ вокруг — за неё текст тянут, по ней его выбирают. */
export function textBox(m: TextMark, measure: Measure): Box {
  const lines = m.text.split('\n');
  const w = Math.max(m.size * 0.6, ...lines.map((l) => measure(l, m.size)));
  const pad = m.size * TEXT_PAD;
  return { x: m.at.x - pad, y: m.at.y - pad, w: w + 2 * pad, h: lines.length * m.size * LINE_HEIGHT + 2 * pad };
}

/** Рамка пометки целиком (с толщиной линии) — для выделения. */
export function markBox(m: Mark, measure: Measure): Box {
  if (m.kind === 'text') return textBox(m, measure);
  return grow(normBox(m.a, m.b), m.width / 2);
}

/** Узелки выбранной фигуры: у линии и стрелки — концы, у прямоугольника и овала — четыре угла. У текста узелков нет. */
export function handles(m: Mark): { h: Handle; p: Pt }[] {
  if (m.kind === 'text') return [];
  if (m.kind === 'line' || m.kind === 'arrow') {
    return [
      { h: 'a', p: m.a },
      { h: 'b', p: m.b },
    ];
  }
  return [
    { h: 'a', p: m.a },
    { h: 'ba', p: { x: m.b.x, y: m.a.y } },
    { h: 'b', p: m.b },
    { h: 'ab', p: { x: m.a.x, y: m.b.y } },
  ];
}

/** Фигура, у которой узелок h перетащили в точку p. */
export function dragHandle(m: ShapeMark, h: Handle, p: Pt): ShapeMark {
  switch (h) {
    case 'a':
      return { ...m, a: { ...p } };
    case 'b':
      return { ...m, b: { ...p } };
    case 'ab':
      return { ...m, a: { x: p.x, y: m.a.y }, b: { x: m.b.x, y: p.y } };
    case 'ba':
      return { ...m, a: { x: m.a.x, y: p.y }, b: { x: p.x, y: m.b.y } };
  }
}

export function moveMark<M extends Mark>(m: M, dx: number, dy: number): M {
  if (m.kind === 'text') return { ...m, at: { x: m.at.x + dx, y: m.at.y + dy } };
  const s = m as ShapeMark;
  return { ...m, a: { x: s.a.x + dx, y: s.a.y + dy }, b: { x: s.b.x + dx, y: s.b.y + dy } };
}

/**
 * Новые свойства пометки: цвет — у всех, толщина — у фигур, размер и текст — у текста. Неподходящие поля
 * пропускаются: одна панель свойств правит что угодно.
 */
export function restyle(m: Mark, patch: Partial<Style> & { text?: string }): Mark {
  const color = patch.color ?? m.color;
  if (m.kind === 'text') return { ...m, color, size: patch.size ?? m.size, text: patch.text ?? m.text };
  return { ...m, color, width: patch.width ?? m.width };
}

/** Пометка (или узелок выбранной) под курсором. */
export interface Hit {
  id: number;
  handle: Handle | null;
}

/**
 * Что под точкой p (tol — запас попадания в единицах снимка). Сначала узелки выбранной пометки, затем пометки
 * сверху вниз: линия — у самой линии, фигура — у контура, текст — в рамке. inside — и внутри прямоугольника
 * и овала (инструмент «Выбрать»): из вложенных берётся меньший, чтобы до маленькой рамки в большой можно было достать.
 */
export function hitTest(
  marks: readonly Mark[],
  p: Pt,
  tol: number,
  measure: Measure,
  opts: { selected?: number | null; inside?: boolean } = {},
): Hit | null {
  const sel = opts.selected == null ? undefined : marks.find((m) => m.id === opts.selected);
  if (sel) {
    for (const { h, p: q } of handles(sel)) if (dist(p, q) <= tol * 1.4) return { id: sel.id, handle: h };
  }
  let best: { id: number; area: number } | null = null;
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    if (m.kind === 'text') {
      // Рамка текста с запасом: за неё тянут текст, даже когда внутри открыто поле ввода.
      if (inBox(p, grow(textBox(m, measure), tol))) return { id: m.id, handle: null };
      continue;
    }
    const t = tol + m.width / 2;
    if (m.kind === 'line' || m.kind === 'arrow') {
      if (distToSegment(p, m.a, m.b) <= t) return { id: m.id, handle: null };
      continue;
    }
    const box = normBox(m.a, m.b);
    const edge = m.kind === 'rect' ? distToRectEdge(p, box) : distToEllipseEdge(p, box);
    if (edge <= t) return { id: m.id, handle: null };
    if (opts.inside && insideShape(p, m)) {
      const area = box.w * box.h;
      if (!best || area < best.area) best = { id: m.id, area };
    }
  }
  return best && { id: best.id, handle: null };
}

/** Наконечник стрелки: острие в b, основание — на линии; null — если стрелка нулевой длины. */
export function arrowHead(a: Pt, b: Pt, width: number): { tip: Pt; base: Pt; left: Pt; right: Pt } | null {
  const len = dist(a, b);
  if (len < 0.01) return null;
  const head = Math.min(len * 0.6, Math.max(10, width * 3.5));
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const base = { x: b.x - ux * head, y: b.y - uy * head };
  const half = head * 0.55;
  return {
    tip: { ...b },
    base,
    left: { x: base.x - uy * half, y: base.y + ux * half },
    right: { x: base.x + uy * half, y: base.y - ux * half },
  };
}

/** С Shift: линия и стрелка — с шагом 45°, прямоугольник и овал — квадратом и кругом. */
export function constrain(kind: ShapeKind, a: Pt, p: Pt): Pt {
  const dx = p.x - a.x;
  const dy = p.y - a.y;
  if (kind === 'line' || kind === 'arrow') {
    const len = Math.hypot(dx, dy);
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: a.x + Math.sign(dx || 1) * s, y: a.y + Math.sign(dy || 1) * s };
}

/** Фигура слишком мала, чтобы её оставить (случайный щелчок, а не протяжка). */
export function tooSmall(m: Mark, min = 3): boolean {
  if (m.kind === 'text') return !m.text.trim();
  if (m.kind === 'line' || m.kind === 'arrow') return dist(m.a, m.b) < min;
  const box = normBox(m.a, m.b);
  return box.w < min && box.h < min;
}

// ---------- Действия над снимком ----------

export function findMark(sk: Sketch, id: number | null): Mark | undefined {
  return id == null ? undefined : sk.marks.find((m) => m.id === id);
}

/** Новая пометка поверх остальных; возвращает снимок и id пометки. */
export function addMark(sk: Sketch, mark: NewMark): [Sketch, number] {
  const id = sk.nextId;
  return [{ ...sk, marks: [...sk.marks, { ...mark, id } as Mark], nextId: id + 1 }, id];
}

/** Заменить пометку с тем же id (её место в стопке не меняется). */
export function replaceMark(sk: Sketch, mark: Mark): Sketch {
  return { ...sk, marks: sk.marks.map((m) => (m.id === mark.id ? mark : m)) };
}

export function removeMark(sk: Sketch, id: number): Sketch {
  return { ...sk, marks: sk.marks.filter((m) => m.id !== id) };
}

/**
 * Кадр в пределах снимка W×H. Слишком маленький или во весь снимок — null (снимок целиком).
 */
export function fixCrop(box: Box | null, W: number, H: number): Box | null {
  if (!box) return null;
  const x0 = Math.max(0, Math.min(W, box.x));
  const y0 = Math.max(0, Math.min(H, box.y));
  const x1 = Math.max(0, Math.min(W, box.x + box.w));
  const y1 = Math.max(0, Math.min(H, box.y + box.h));
  const out = normBox({ x: x0, y: y0 }, { x: x1, y: y1 });
  if (out.w < MIN_CROP || out.h < MIN_CROP) return null;
  if (out.x <= 0 && out.y <= 0 && out.w >= W && out.h >= H) return null;
  return out;
}

export function setCrop(sk: Sketch, crop: Box | null, W: number, H: number): Sketch {
  return { ...sk, crop: fixCrop(crop, W, H) };
}

/** Участок карты в пределах снимка W×H; слишком маленький — null (участок не отмечен). Во весь снимок — можно. */
export function fixArea(box: Box | null, W: number, H: number): Box | null {
  if (!box) return null;
  const x0 = Math.max(0, Math.min(W, box.x));
  const y0 = Math.max(0, Math.min(H, box.y));
  const x1 = Math.max(0, Math.min(W, box.x + box.w));
  const y1 = Math.max(0, Math.min(H, box.y + box.h));
  const out = normBox({ x: x0, y: y0 }, { x: x1, y: y1 });
  return out.w < MIN_CROP || out.h < MIN_CROP ? null : out;
}

export function setArea(sk: Sketch, area: Box | null, W: number, H: number): Sketch {
  return { ...sk, area: fixArea(area, W, H) };
}

/** Кадр, сдвинутый целиком, — не выходит за снимок. */
export function moveCrop(box: Box, dx: number, dy: number, W: number, H: number): Box {
  return { ...box, x: Math.max(0, Math.min(W - box.w, box.x + dx)), y: Math.max(0, Math.min(H - box.h, box.y + dy)) };
}

/** Узелки кадра — как у прямоугольника. */
export function cropHandles(box: Box): { h: Handle; p: Pt }[] {
  return handles(cropShape(box));
}

/** Кадр после перетаскивания его узелка h в точку p. */
export function dragCrop(box: Box, h: Handle, p: Pt): Box {
  const s = dragHandle(cropShape(box), h, p);
  return normBox(s.a, s.b);
}

/** Что у кадра под точкой: узелок, внутренность (тянуть кадр целиком) или ничего. */
export function hitCrop(box: Box, p: Pt, tol: number): Handle | 'move' | null {
  for (const { h, p: q } of cropHandles(box)) if (dist(p, q) <= tol * 1.4) return h;
  return inBox(p, box) ? 'move' : null;
}

function cropShape(box: Box): ShapeMark {
  return { id: 0, kind: 'rect', color: '', width: 0, a: { x: box.x, y: box.y }, b: { x: box.x + box.w, y: box.y + box.h } };
}

/** Итоговая картинка: кадр или снимок целиком. */
export function outputBox(sk: Sketch, W: number, H: number): Box {
  return sk.crop ?? { x: 0, y: 0, w: W, h: H };
}

// ---------- Вид: как снимок вписан в окно редактора ----------

/** Экран = точка снимка × zoom + (ox, oy). */
export interface View {
  zoom: number;
  ox: number;
  oy: number;
}

/** Вписать область region в поле cw×ch с отступом pad, по центру; крупнее maxZoom не увеличиваем. */
export function fitView(region: Box, cw: number, ch: number, pad = 12, maxZoom = 3): View {
  const zoom = Math.max(0.02, Math.min(maxZoom, (cw - 2 * pad) / Math.max(1, region.w), (ch - 2 * pad) / Math.max(1, region.h)));
  return { zoom, ox: (cw - region.w * zoom) / 2 - region.x * zoom, oy: (ch - region.h * zoom) / 2 - region.y * zoom };
}

export const toScreen = (v: View, p: Pt): Pt => ({ x: p.x * v.zoom + v.ox, y: p.y * v.zoom + v.oy });
export const toModel = (v: View, s: Pt): Pt => ({ x: (s.x - v.ox) / v.zoom, y: (s.y - v.oy) / v.zoom });

// ---------- Отмена ----------

/**
 * История правок: now — текущее состояние, past и future — для отмены и повтора. Протяжка мышью идёт через
 * preview (без шагов), а на отпускании settle(base) кладёт в историю одно состояние до протяжки.
 */
export class Timeline<T> {
  past: T[] = [];
  future: T[] = [];

  constructor(public now: T) {}

  /** Новое состояние — один шаг отмены. */
  set(next: T): void {
    if (next === this.now) return;
    this.past.push(this.now);
    this.future = [];
    this.now = next;
  }

  /** Промежуточное состояние (тянем мышью): в историю не пишется. */
  preview(next: T): void {
    this.now = next;
  }

  /** Протяжка закончилась: если что-то изменилось с base — это один шаг отмены. */
  settle(base: T): void {
    if (base === this.now) return;
    this.past.push(base);
    this.future = [];
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (prev === undefined) return false;
    this.future.push(this.now);
    this.now = prev;
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (next === undefined) return false;
    this.past.push(this.now);
    this.now = next;
    return true;
  }
}
