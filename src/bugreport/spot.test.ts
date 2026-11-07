import { describe, expect, it } from 'vitest';
import { addMark, emptySketch, type Sketch } from './marks';
import { areaArg, fitCamera, mapSpot, marksArea, parseArea, parseCamera, parseSpot, savedArea, sketchArea, spotLine, toWorld, withSpot, worldBox, type SnapCamera } from './spot';

/** Камера: центр вида (1000, 500), 2 точки экрана на метр, холст 800×600 во всё окно. */
const cam: SnapCamera = { x: 1000, y: 500, zoom: 2, width: 800, height: 600, left: 0, top: 0 };

describe('Где на карте: перевод снимка в мир', () => {
  it('центр снимка — центр камеры, угол — на половину экрана / zoom от него', () => {
    expect(toWorld(cam, { x: 400, y: 300 })).toEqual({ x: 1000, y: 500 });
    expect(toWorld(cam, { x: 0, y: 0 })).toEqual({ x: 800, y: 350 });
    // Холст сдвинут в окне — точка окна сначала переводится в точку холста.
    expect(toWorld({ ...cam, left: 100, top: 50 }, { x: 500, y: 350 })).toEqual({ x: 1000, y: 500 });
  });

  it('рамка снимка — прямоугольник мира в целых метрах, наружу', () => {
    expect(worldBox(cam, { x: 100, y: 100, w: 201, h: 99 })).toEqual({ x0: 850, y0: 400, x1: 951, y1: 450 });
  });

  it('участок: рамка «Участок» важнее пометок, пометки — важнее кадра', () => {
    let sk: Sketch = { ...emptySketch(), crop: { x: 0, y: 0, w: 400, h: 300 } };
    expect(sketchArea(sk)).toEqual({ box: { x: 0, y: 0, w: 400, h: 300 }, source: 'crop' });
    [sk] = addMark(sk, { kind: 'ellipse', color: '#e8483f', width: 4, a: { x: 300, y: 200 }, b: { x: 200, y: 100 } });
    expect(sketchArea(sk)).toEqual({ box: { x: 200, y: 100, w: 100, h: 100 }, source: 'marks' });
    sk = { ...sk, area: { x: 10, y: 20, w: 30, h: 40 } };
    expect(sketchArea(sk)?.source).toBe('frame');
  });

  it('по пометкам: рамки прямоугольников и овалов и место у острия стрелки; линии и текст не в счёт', () => {
    let sk = emptySketch();
    [sk] = addMark(sk, { kind: 'line', color: '#000', width: 2, a: { x: 0, y: 0 }, b: { x: 700, y: 500 } });
    [sk] = addMark(sk, { kind: 'text', color: '#000', size: 24, at: { x: 5, y: 5 }, text: 'тут' });
    expect(marksArea(sk.marks)).toBeNull();
    [sk] = addMark(sk, { kind: 'rect', color: '#000', width: 2, a: { x: 100, y: 100 }, b: { x: 200, y: 150 } });
    [sk] = addMark(sk, { kind: 'arrow', color: '#000', width: 2, a: { x: 0, y: 0 }, b: { x: 300, y: 300 } });
    expect(marksArea(sk.marks)).toEqual({ x: 100, y: 100, w: 240, h: 240 });
  });

  it('место снимка: камера, видимая часть карты и участок с источником', () => {
    const sk: Sketch = { ...emptySketch(), area: { x: 200, y: 150, w: 400, h: 300 } };
    expect(mapSpot(cam, sk, 800, 600)).toEqual({
      camera: { x: 1000, y: 500, zoom: 2 },
      view: { x0: 800, y0: 350, x1: 1200, y1: 650 },
      area: { x0: 900, y0: 425, x1: 1100, y1: 575 },
      source: 'frame',
    });
    expect(mapSpot(cam, emptySketch(), 800, 600).area).toBeUndefined();
  });
});

describe('Где на карте: строка отчёта и обратно', () => {
  it('участок: размер, откуда он, координаты и готовые --area и --camera', () => {
    const spot = mapSpot({ ...cam, zoom: 0.8537 }, { ...emptySketch(), area: { x: 0, y: 0, w: 400, h: 300 } }, 800, 600);
    const line = spotLine(spot);
    expect(line).toMatch(/^\*\*Где на карте:\*\* участок \d+ × \d+ м, отмечен рамкой: x /);
    expect(line).toContain(`\`--area ${areaArg(spot.area!)}\``);
    expect(line).toContain('`--camera 1000,500,0.854`');
    expect(parseSpot(`Описание\n\n${line}\n\nверсия 0.2.5`)).toEqual({ area: spot.area, camera: spot.camera });
  });

  it('без участка — видимая часть карты и камера', () => {
    const line = spotLine(mapSpot(cam, emptySketch(), 800, 600));
    expect(line).toBe('**Где на карте:** участок не отмечен, на снимке x 800…1200, y 350…650 · камера 1000, 500, ×2 · `--camera 1000,500,2`');
    expect(parseSpot(line)).toEqual({ camera: { x: 1000, y: 500, zoom: 2 } });
  });

  it('из текста берутся только числа; тире вместо «--» тоже понимается; нет параметров — null', () => {
    expect(parseSpot('`—area -10,5.5,30,40`')).toEqual({ area: { x0: -10, y0: 5.5, x1: 30, y1: 40 } });
    expect(parseSpot('--area 1,2,3; rm -rf /')).toBeNull();
    expect(parseSpot('Просто текст')).toBeNull();
    expect(parseArea('30,40,10,20')).toEqual({ x0: 10, y0: 20, x1: 30, y1: 40 });
    expect(parseArea('1,1,1,5')).toBeNull();
    expect(parseCamera('1,2,0')).toBeNull();
    expect(parseCamera('1,2,0.5')).toEqual({ x: 1, y: 2, zoom: 0.5 });
  });

  it('камера на участок: в центре, участок с запасом помещается, масштаб в пределах камеры', () => {
    const area = { x0: 0, y0: 0, x1: 2000, y1: 1000 };
    const c = fitCamera(area, 1440, 900);
    expect(c.x).toBe(1000);
    expect(c.y).toBe(500);
    expect((area.x1 - area.x0) * c.zoom).toBeLessThan(1440);
    expect((area.x1 - area.x0) * 1.5 * c.zoom).toBeCloseTo(1440, -1);
    expect(fitCamera({ x0: 0, y0: 0, x1: 2, y1: 2 }, 1440, 900, { maxZoom: 3 }).zoom).toBe(3);
    expect(fitCamera({ x0: 0, y0: 0, x1: 1e6, y1: 1e6 }, 1440, 900, { minZoom: 0.08 }).zoom).toBe(0.08);
  });
});

describe('Где на карте: в сохранении', () => {
  it('сохранение получает bugSpot, остальное — как было; участок читается обратно', () => {
    const spot = mapSpot(cam, { ...emptySketch(), area: { x: 200, y: 150, w: 400, h: 300 } }, 800, 600);
    const save = withSpot('{"version":3,"view":{"x":1,"y":2,"zoom":1}}', spot);
    const data = JSON.parse(save);
    expect(data.version).toBe(3);
    expect(data.view).toEqual({ x: 1, y: 2, zoom: 1 });
    expect(savedArea(data)).toEqual(spot.area);
  });

  it('не JSON — без изменений; испорченный или пустой участок — нет участка', () => {
    expect(withSpot('не json', mapSpot(cam, emptySketch(), 800, 600))).toBe('не json');
    expect(savedArea({ version: 3 })).toBeNull();
    expect(savedArea(null)).toBeNull();
    expect(savedArea({ bugSpot: { area: { x0: 5, y0: 0, x1: 5, y1: 10 } } })).toBeNull();
    expect(savedArea({ bugSpot: { area: { x0: '0', y0: 0, x1: 5, y1: 10 } } })).toBeNull();
  });
});
