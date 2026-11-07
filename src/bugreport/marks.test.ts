import { describe, expect, it } from 'vitest';
import {
  addMark,
  arrowHead,
  cropHandles,
  distToEllipseEdge,
  dragCrop,
  dragHandle,
  emptySketch,
  findMark,
  fitView,
  fixArea,
  fixCrop,
  handles,
  hitCrop,
  hitTest,
  markBox,
  moveCrop,
  moveMark,
  outputBox,
  removeMark,
  replaceMark,
  restyle,
  setArea,
  setCrop,
  textBox,
  Timeline,
  toModel,
  toScreen,
  tooSmall,
  type Measure,
  type ShapeMark,
  type Sketch,
  type TextMark,
} from './marks';

/** Ширина строки: 0.5 размера на букву. */
const measure: Measure = (line, size) => line.length * size * 0.5;

const rect = (a: [number, number], b: [number, number], width = 4): Omit<ShapeMark, 'id'> => ({
  kind: 'rect',
  color: '#e8483f',
  width,
  a: { x: a[0], y: a[1] },
  b: { x: b[0], y: b[1] },
});

function sketchWith(...marks: Parameters<typeof addMark>[1][]): [Sketch, number[]] {
  let sk = emptySketch();
  const ids: number[] = [];
  for (const m of marks) {
    const [next, id] = addMark(sk, m);
    sk = next;
    ids.push(id);
  }
  return [sk, ids];
}

describe('Пометки: создание и правка', () => {
  it('новые пометки получают id по порядку и встают сверху', () => {
    const [sk, ids] = sketchWith(rect([0, 0], [10, 10]), { kind: 'text', color: '#000', size: 20, at: { x: 5, y: 5 }, text: 'Тут' });
    expect(ids).toEqual([1, 2]);
    expect(sk.marks.map((m) => m.kind)).toEqual(['rect', 'text']);
    expect(sk.nextId).toBe(3);
    expect(findMark(sk, 2)?.kind).toBe('text');
    expect(findMark(sk, null)).toBeUndefined();
  });

  it('перемещение и узелки: углы прямоугольника тянутся независимо', () => {
    const [sk] = sketchWith(rect([10, 10], [50, 30]));
    const m = sk.marks[0] as ShapeMark;
    expect(moveMark(m, 5, -5)).toMatchObject({ a: { x: 15, y: 5 }, b: { x: 55, y: 25 } });
    expect(handles(m).map((h) => h.h)).toEqual(['a', 'ba', 'b', 'ab']);
    // Левый нижний угол (x от a, y от b) — в (0, 60): меняются a.x и b.y.
    expect(dragHandle(m, 'ab', { x: 0, y: 60 })).toMatchObject({ a: { x: 0, y: 10 }, b: { x: 50, y: 60 } });
    expect(dragHandle(m, 'ba', { x: 70, y: 0 })).toMatchObject({ a: { x: 10, y: 0 }, b: { x: 70, y: 30 } });
    // У линии — только концы.
    const line: ShapeMark = { ...m, kind: 'arrow' };
    expect(handles(line).map((h) => h.h)).toEqual(['a', 'b']);
    expect(dragHandle(line, 'b', { x: 1, y: 2 }).b).toEqual({ x: 1, y: 2 });
  });

  it('свойства: цвет — у всех, толщина — у фигур, размер и текст — у текста', () => {
    const [sk] = sketchWith(rect([0, 0], [10, 10], 2), { kind: 'text', color: '#000', size: 20, at: { x: 0, y: 0 }, text: 'а' });
    const [r, t] = sk.marks;
    expect(restyle(r, { color: '#2f80ed', width: 8, size: 40 })).toMatchObject({ color: '#2f80ed', width: 8 });
    expect(restyle(r, { size: 40 })).not.toHaveProperty('size');
    expect(restyle(t, { color: '#fff', width: 8, size: 32, text: 'Пробка' })).toMatchObject({ color: '#fff', size: 32, text: 'Пробка' });
    expect(restyle(t, { width: 8 })).not.toHaveProperty('width');
    const next = replaceMark(sk, restyle(t, { text: 'б' }));
    expect((findMark(next, t.id) as TextMark).text).toBe('б');
    expect(next.marks.map((m) => m.id)).toEqual([1, 2]);
    expect(removeMark(next, 1).marks.map((m) => m.id)).toEqual([2]);
  });

  it('рамка текста: по самой длинной строке, высота — по числу строк, с отступом', () => {
    const t: TextMark = { id: 1, kind: 'text', color: '#000', size: 20, at: { x: 100, y: 50 }, text: 'ab\nabcd' };
    // Самая длинная строка — 4 буквы × 10 = 40; две строки по 25; отступ 6.
    expect(textBox(t, measure)).toEqual({ x: 94, y: 44, w: 52, h: 62 });
    // Пустой текст — рамка не схлопывается: есть куда поставить курсор.
    expect(textBox({ ...t, text: '' }, measure).w).toBeGreaterThan(10);
    expect(markBox(t, measure)).toEqual(textBox(t, measure));
    expect(markBox({ ...t, kind: 'rect', width: 4, a: { x: 0, y: 0 }, b: { x: 10, y: 10 } } as unknown as ShapeMark, measure)).toEqual({
      x: -2,
      y: -2,
      w: 14,
      h: 14,
    });
  });

  it('случайный щелчок не оставляет фигуру, пустой текст — тоже', () => {
    expect(tooSmall({ id: 1, ...rect([0, 0], [1, 2]) } as ShapeMark)).toBe(true);
    expect(tooSmall({ id: 1, ...rect([0, 0], [1, 20]) } as ShapeMark)).toBe(false);
    expect(tooSmall({ id: 1, ...rect([0, 0], [2, 1]), kind: 'line' } as ShapeMark)).toBe(true);
    expect(tooSmall({ id: 1, kind: 'text', color: '#000', size: 20, at: { x: 0, y: 0 }, text: '  ' })).toBe(true);
  });
});

describe('Пометки: попадание мышью', () => {
  const [sk, [big, small, line, text]] = sketchWith(
    rect([0, 0], [200, 200]),
    rect([50, 50], [80, 80]),
    { kind: 'line', color: '#000', width: 6, a: { x: 0, y: 300 }, b: { x: 100, y: 300 } },
    { kind: 'text', color: '#000', size: 20, at: { x: 300, y: 0 }, text: 'Текст' },
  );

  it('линия — рядом с ней (с учётом толщины), фигура — у контура', () => {
    expect(hitTest(sk.marks, { x: 50, y: 305 }, 3, measure)).toEqual({ id: line, handle: null });
    expect(hitTest(sk.marks, { x: 50, y: 310 }, 3, measure)).toBeNull();
    expect(hitTest(sk.marks, { x: 1, y: 100 }, 3, measure)).toEqual({ id: big, handle: null });
    expect(hitTest(sk.marks, { x: 65, y: 51 }, 3, measure)).toEqual({ id: small, handle: null });
  });

  it('внутри фигуры — только для «Выбрать», и из вложенных — меньшая', () => {
    expect(hitTest(sk.marks, { x: 120, y: 120 }, 3, measure)).toBeNull();
    expect(hitTest(sk.marks, { x: 120, y: 120 }, 3, measure, { inside: true })).toEqual({ id: big, handle: null });
    expect(hitTest(sk.marks, { x: 65, y: 65 }, 3, measure, { inside: true })).toEqual({ id: small, handle: null });
  });

  it('текст — внутри рамки; узелки выбранной пометки — раньше всего', () => {
    expect(hitTest(sk.marks, { x: 310, y: 10 }, 3, measure)).toEqual({ id: text, handle: null });
    // Угол большой рамки (0, 0): выбрана — узелок, не выбрана — просто контур.
    expect(hitTest(sk.marks, { x: 1, y: 1 }, 3, measure, { selected: big })).toEqual({ id: big, handle: 'a' });
    expect(hitTest(sk.marks, { x: 1, y: 1 }, 3, measure)).toEqual({ id: big, handle: null });
    expect(hitTest(sk.marks, { x: 200, y: 0 }, 3, measure, { selected: big })).toEqual({ id: big, handle: 'ba' });
  });

  it('овал — по контуру, а не по рамке', () => {
    const box = { x: 0, y: 0, w: 100, h: 50 };
    expect(distToEllipseEdge({ x: 100, y: 25 }, box)).toBeCloseTo(0);
    expect(distToEllipseEdge({ x: 50, y: 0 }, box)).toBeCloseTo(0);
    // Угол рамки — далеко от овала.
    expect(distToEllipseEdge({ x: 0, y: 0 }, box)).toBeGreaterThan(10);
    const [ov] = sketchWith({ kind: 'ellipse', color: '#000', width: 2, a: { x: 0, y: 0 }, b: { x: 100, y: 50 } });
    expect(hitTest(ov.marks, { x: 2, y: 2 }, 3, measure)).toBeNull();
    expect(hitTest(ov.marks, { x: 50, y: 1 }, 3, measure)?.id).toBe(1);
  });
});

describe('Стрелка', () => {
  it('острие в конце, основание на линии, крылья симметричны', () => {
    const h = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 4)!;
    expect(h.tip).toEqual({ x: 100, y: 0 });
    expect(h.base.y).toBe(0);
    expect(h.base.x).toBeLessThan(100);
    expect(h.left.x).toBeCloseTo(h.right.x);
    expect(h.left.y).toBeCloseTo(-h.right.y);
    // Наконечник растёт с толщиной, но не длиннее 0.6 стрелки.
    expect(100 - arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 10)!.base.x).toBeGreaterThan(100 - h.base.x);
    expect(20 - arrowHead({ x: 0, y: 0 }, { x: 20, y: 0 }, 10)!.base.x).toBeCloseTo(12);
    expect(arrowHead({ x: 5, y: 5 }, { x: 5, y: 5 }, 4)).toBeNull();
  });
});

describe('Участок карты', () => {
  it('держится в пределах снимка; крошечный — нет участка; во весь снимок — можно', () => {
    expect(fixArea({ x: -10, y: 20, w: 100, h: 1000 }, 800, 600)).toEqual({ x: 0, y: 20, w: 90, h: 580 });
    expect(fixArea({ x: 10, y: 10, w: 4, h: 100 }, 800, 600)).toBeNull();
    expect(fixArea({ x: -5, y: -5, w: 900, h: 700 }, 800, 600)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(fixArea(null, 800, 600)).toBeNull();
    // Рамка, протянутая справа налево, — та же рамка; кадр от участка не меняется.
    const sk = setArea(emptySketch(), { x: 300, y: 200, w: -200, h: -100 }, 800, 600);
    expect(sk.area).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    expect(sk.crop).toBeNull();
  });
});

describe('Кадр', () => {
  it('держится в пределах снимка; крошечный или во весь снимок — снимок целиком', () => {
    expect(fixCrop({ x: -10, y: 20, w: 100, h: 1000 }, 800, 600)).toEqual({ x: 0, y: 20, w: 90, h: 580 });
    expect(fixCrop({ x: 10, y: 10, w: 4, h: 100 }, 800, 600)).toBeNull();
    expect(fixCrop({ x: -5, y: -5, w: 900, h: 700 }, 800, 600)).toBeNull();
    expect(fixCrop(null, 800, 600)).toBeNull();
    const sk = setCrop(emptySketch(), { x: 100, y: 100, w: 200, h: 100 }, 800, 600);
    expect(outputBox(sk, 800, 600)).toEqual({ x: 100, y: 100, w: 200, h: 100 });
    expect(outputBox(emptySketch(), 800, 600)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });

  it('тянется за углы, двигается целиком и не уезжает за край', () => {
    const box = { x: 100, y: 100, w: 200, h: 100 };
    expect(cropHandles(box).map((h) => h.p)).toEqual([
      { x: 100, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 200 },
      { x: 100, y: 200 },
    ]);
    expect(hitCrop(box, { x: 299, y: 199 }, 4)).toBe('b');
    expect(hitCrop(box, { x: 200, y: 150 }, 4)).toBe('move');
    expect(hitCrop(box, { x: 50, y: 50 }, 4)).toBeNull();
    // Угол перетащили за противоположный — рамка разворачивается, а не выворачивается.
    expect(dragCrop(box, 'b', { x: 50, y: 150 })).toEqual({ x: 50, y: 100, w: 50, h: 50 });
    expect(moveCrop(box, 1000, -1000, 800, 600)).toEqual({ x: 600, y: 0, w: 200, h: 100 });
  });
});

describe('Вид редактора', () => {
  it('вписывает область по центру и переводит точки туда и обратно', () => {
    const v = fitView({ x: 0, y: 0, w: 1000, h: 500 }, 520, 520, 10);
    expect(v.zoom).toBeCloseTo(0.5);
    expect(toScreen(v, { x: 0, y: 0 })).toEqual({ x: 10, y: 135 });
    const p = { x: 123, y: 456 };
    const back = toModel(v, toScreen(v, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
    // Кадр — его угол встаёт в угол поля; маленький кадр увеличивается, но не больше maxZoom.
    const crop = fitView({ x: 200, y: 100, w: 100, h: 100 }, 1000, 1000, 0, 3);
    expect(crop.zoom).toBe(3);
    expect(toScreen(crop, { x: 250, y: 150 })).toEqual({ x: 500, y: 500 });
  });
});

describe('Отмена и повтор', () => {
  it('шаги set, протяжка — один шаг, новая правка стирает повтор', () => {
    const t = new Timeline(0);
    t.set(1);
    t.set(2);
    expect(t.undo()).toBe(true);
    expect(t.now).toBe(1);
    expect(t.redo()).toBe(true);
    expect(t.now).toBe(2);
    // Протяжка: много промежуточных состояний — одна отмена.
    const base = t.now;
    t.preview(3);
    t.preview(4);
    t.settle(base);
    expect(t.now).toBe(4);
    t.undo();
    expect(t.now).toBe(2);
    expect(t.canRedo).toBe(true);
    t.set(5);
    expect(t.canRedo).toBe(false);
    expect(t.redo()).toBe(false);
    // Протяжка без изменений шага не добавляет.
    const before = t.past.length;
    t.settle(t.now);
    expect(t.past.length).toBe(before);
    t.undo();
    t.undo();
    t.undo();
    expect(t.now).toBe(0);
    expect(t.undo()).toBe(false);
  });
});
