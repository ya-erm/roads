import { describe, expect, it } from 'vitest';
import { supplyBarHtml, supplyLineHtml } from './supplyUi';

const width = (html: string, cls = '') => {
  const m = new RegExp(`<div ${cls ? `class="${cls}" ` : ''}style="width:([\\d.]+)%`).exec(html);
  return m ? Number(m[1]) : null;
};

describe('Снабжение города в карточке: перенос излишков', () => {
  it('без переноса — одна сплошная полоска до нормы', () => {
    const html = supplyBarHtml(9, 0, 15, '#e5534b');
    expect(html).not.toContain('class="carry"');
    expect(width(html)).toBeCloseTo(60, 1);
  });

  it('перенесённое из прошлого месяца — штриховкой в начале, привезённое сейчас — следом', () => {
    const html = supplyBarHtml(12, 5, 15, '#e5534b');
    expect(width(html, 'carry')).toBeCloseTo((5 / 15) * 100, 1);
    expect(html).toContain('--c:#e5534b');
    // Сплошная часть — то, что привезли в этом месяце: 7 из 15.
    expect(width(html.replace(/<div class="carry"[^>]*><\/div>/, ''))).toBeCloseTo((7 / 15) * 100, 1);
  });

  it('сверх нормы полоска не растёт', () => {
    const html = supplyBarHtml(40, 15, 15, '#000');
    expect(width(html, 'carry')).toBe(100);
    expect(width(html.replace(/<div class="carry"[^>]*><\/div>/, ''))).toBe(0);
  });

  it('подпись: «↪ N» — пришло из прошлого месяца, «+N ↪» — уйдёт в следующий (не больше нормы)', () => {
    const line = supplyLineHtml(22, 5, 18, 15, '#e5534b');
    expect(line).toContain('↪ 5</span>');
    expect(line).toContain('+7 ↪');
    expect(line).toContain('в этом месяце 22 из 15 ✓');
    expect(line).toContain('в прошлом 18 ✓');
    expect(supplyLineHtml(60, 0, 0, 15, '#000')).toContain('+15 ↪');
  });

  it('без переноса и без излишка — без значков', () => {
    const line = supplyLineHtml(9, 0, 4, 15, '#000');
    expect(line).not.toContain('carry-chip');
    expect(line).toBe('в этом месяце 9 из 15 · в прошлом 4');
  });
});
