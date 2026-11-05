import { describe, expect, it } from 'vitest';
import { glassFor, modelSvg, reliefSvg, shadeHex, waterSvg } from './icons';

describe('shadeHex', () => {
  it('светлее — к белому, темнее — к чёрному', () => {
    expect(shadeHex('#808080', 0.5)).toBe('#c0c0c0');
    expect(shadeHex('#808080', -0.5)).toBe('#404040');
    expect(shadeHex('#4a8fe7', 0)).toBe('#4a8fe7');
  });

  it('не #rrggbb — как есть', () => {
    expect(shadeHex('red', 0.3)).toBe('red');
  });
});

describe('glassFor', () => {
  it('на светлом кузове окна тёмные, на тёмном — светлые', () => {
    expect(glassFor('#e9b52f')).toBe('#2f3d4b');
    expect(glassFor('#1d2a6b')).toBe('#9fb3c6');
  });
});

describe('modelSvg', () => {
  it('автобус и грузовик — цвета маршрута', () => {
    for (const id of ['bus', 'bus2', 'bus3', 'truck', 'truck2', 'truck3']) {
      expect(modelSvg(id, '#3fae6a')).toContain('fill="#3fae6a"');
    }
  });

  it('без цвета — цвет модели по умолчанию', () => {
    expect(modelSvg('bus')).toContain('fill="#3b7dd8"');
    expect(modelSvg('truck')).toContain('fill="#e07b39"');
  });

  it('сочленённый автобус и фура длиннее обычных', () => {
    const width = (svg: string) => Number(/width="([\d.]+)"/.exec(svg)![1]);
    expect(width(modelSvg('bus3'))).toBeGreaterThan(width(modelSvg('bus')));
    expect(width(modelSvg('truck3'))).toBeGreaterThan(width(modelSvg('truck2')));
  });

  it('оси как у образцов: сочленённый — три, грузовик II — четыре, фура — шесть', () => {
    const wheels = (svg: string) => (svg.match(/fill="#2b323b"/g) ?? []).length;
    expect(wheels(modelSvg('bus'))).toBe(2);
    expect(wheels(modelSvg('bus2'))).toBe(2);
    expect(wheels(modelSvg('bus3'))).toBe(3);
    expect(wheels(modelSvg('truck'))).toBe(2);
    expect(wheels(modelSvg('truck2'))).toBe(4);
    expect(wheels(modelSvg('truck3'))).toBe(6);
  });

  it('микроавтобус короче городского', () => {
    const width = (svg: string) => Number(/width="([\d.]+)"/.exec(svg)![1]);
    expect(width(modelSvg('bus'))).toBeLessThan(width(modelSvg('bus2')));
  });
});

describe('waterSvg', () => {
  const fullDrops = (svg: string) => (svg.match(/fill="#5aa9e6" stroke=/g) ?? []).length;

  it('сухо — пустая капля, обычно — одна капля, много воды — две', () => {
    expect(fullDrops(waterSvg('dry'))).toBe(0);
    expect(waterSvg('dry')).toContain('fill="#fff"');
    expect(fullDrops(waterSvg('normal'))).toBe(1);
    expect(fullDrops(waterSvg('wet'))).toBe(2);
  });

  it('много воды — две капли в ряд, правая заходит на левую', () => {
    const tips = [...waterSvg('wet').matchAll(/d="M([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(tips).toHaveLength(2);
    const [[x1, y1], [x2, y2]] = tips;
    expect(y1).toBe(y2);
    expect(x2).toBeGreaterThan(x1);
    // Ширина капли — 2r = 10: центры ближе — капли накладываются.
    expect(x2 - x1).toBeLessThan(10);
  });

  it('размер задаётся параметром', () => {
    expect(waterSvg('normal', 30)).toContain('width="30" height="30"');
  });
});

describe('reliefSvg', () => {
  it('снежные вершины только у гор', () => {
    expect(reliefSvg('mountains')).toContain('class="snow"');
    expect(reliefSvg('hills')).not.toContain('class="snow"');
    expect(reliefSvg('plains')).not.toContain('class="snow"');
  });

  it('у каждого варианта свой значок', () => {
    const all = new Set([reliefSvg('plains'), reliefSvg('hills'), reliefSvg('mountains')]);
    expect(all.size).toBe(3);
  });
});
