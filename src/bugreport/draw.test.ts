import { describe, expect, it } from 'vitest';
import { drawMarks, haloFor, luminance, outputSize, renderSketch } from './draw';
import { addMark, emptySketch, setCrop, type Sketch } from './marks';

/** Подделка 2D-контекста: записывает вызовы методов и присваивания свойств. */
function recorder(): { ctx: CanvasRenderingContext2D; calls: [string, ...unknown[]][] } {
  const calls: [string, ...unknown[]][] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get: (_t, key: string) => (key in target ? target[key] : (...args: unknown[]) => void calls.push([key, ...args])),
    set: (_t, key: string, value) => {
      calls.push([`=${key}`, value]);
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function sample(): Sketch {
  let sk = emptySketch();
  [sk] = addMark(sk, { kind: 'rect', color: '#e8483f', width: 4, a: { x: 30, y: 40 }, b: { x: 10, y: 20 } });
  [sk] = addMark(sk, { kind: 'arrow', color: '#2f80ed', width: 6, a: { x: 0, y: 0 }, b: { x: 100, y: 0 } });
  [sk] = addMark(sk, { kind: 'text', color: '#ffffff', size: 24, at: { x: 5, y: 6 }, text: 'Пробка\nздесь' });
  return sk;
}

describe('Отрисовка пометок', () => {
  it('прямоугольник — по нормализованной рамке, стрелка — линия до основания и залитый наконечник', () => {
    const { ctx, calls } = recorder();
    const sk = sample();
    drawMarks(ctx, sk.marks.slice(0, 2));
    expect(calls).toContainEqual(['rect', 10, 20, 20, 20]);
    expect(calls).toContainEqual(['=lineWidth', 4]);
    const lineTo = calls.filter((c) => c[0] === 'lineTo');
    // Линия стрелки кончается до острия, наконечник начинается в острие.
    expect(lineTo[0][1]).toBeLessThan(100);
    expect(calls).toContainEqual(['moveTo', 100, 0]);
    expect(calls.filter((c) => c[0] === 'fill')).toHaveLength(1);
    // Каждая пометка рисуется в своём save/restore — стили не протекают.
    expect(calls.filter((c) => c[0] === 'save')).toHaveLength(2);
    expect(calls.filter((c) => c[0] === 'restore')).toHaveLength(2);
  });

  it('текст — по строкам, с обводкой контрастного цвета; правимый текст пропускается', () => {
    const { ctx, calls } = recorder();
    const sk = sample();
    drawMarks(ctx, sk.marks, 1);
    expect(calls.some((c) => c[0] === 'rect')).toBe(false);
    const fills = calls.filter((c) => c[0] === 'fillText');
    expect(fills).toEqual([
      ['fillText', 'Пробка', 5, 6],
      ['fillText', 'здесь', 5, 6 + 24 * 1.25],
    ]);
    expect(calls.filter((c) => c[0] === 'strokeText')).toHaveLength(2);
    expect(calls).toContainEqual(['=strokeStyle', haloFor('#ffffff')]);
    expect(calls).toContainEqual(['=textBaseline', 'top']);
  });

  it('контраст обводки: у белого текста тёмная, у тёмного — светлая', () => {
    expect(luminance('#fff')).toBeCloseTo(1);
    expect(luminance('#000000')).toBe(0);
    expect(luminance('не цвет')).toBe(0.5);
    expect(haloFor('#ffffff')).toMatch(/^rgba\(20/);
    expect(haloFor('#1f2933')).toMatch(/^rgba\(255/);
  });
});

describe('Итоговая картинка', () => {
  it('размер — по кадру и плотности пикселей, снимок сдвинут так, что кадр в углу', () => {
    const sk = setCrop(sample(), { x: 100, y: 50, w: 300, h: 200 }, 1440, 900);
    expect(outputSize(sk, 1440, 900, 2)).toEqual({ width: 600, height: 400 });
    expect(outputSize(emptySketch(), 1440, 900, 1)).toEqual({ width: 1440, height: 900 });
    const { ctx, calls } = recorder();
    const image = {} as CanvasImageSource;
    renderSketch(ctx, image, sk, 1440, 900, 2);
    expect(calls).toContainEqual(['setTransform', 2, 0, 0, 2, -200, -100]);
    expect(calls).toContainEqual(['drawImage', image, 0, 0, 1440, 900]);
    // Пометки — после снимка, поверх.
    const drawAt = calls.findIndex((c) => c[0] === 'drawImage');
    expect(calls.findIndex((c) => c[0] === 'fillText')).toBeGreaterThan(drawAt);
  });
});
