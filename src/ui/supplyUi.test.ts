import { describe, expect, it } from 'vitest';
import { NEEDS_HINT, needLevel, needsFoldHtml, needsHeadHtml, needTip, supplyBarHtml, supplyLineHtml, type TownNeed } from './supplyUi';

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

describe('«Что нужно городу» свёрнутым — одной строкой', () => {
  const needs: TownNeed[] = [
    { cargo: 'fuel', now: 0, carried: 0, last: 0 },
    { cargo: 'food', now: 22, carried: 15, last: 18 },
    { cargo: 'construction', now: 6, carried: 0, last: 15 },
  ];
  /** Значки строки по порядку: состояние и подсказка. */
  const dots = (html: string) => [...html.matchAll(/<span class="need-dot (\w+)" data-tip="([^"]*)">/g)].map((m) => ({ level: m[1], tip: m[2] }));
  /** Длина дуги заполнения у значков, у кого она есть. */
  const arcs = (html: string) => [...html.matchAll(/stroke-dasharray="([\d.]+) /g)].map((m) => Number(m[1]));

  it('закрыто / частично / ничего — по привезённому в этом месяце', () => {
    expect(needLevel(15, 15)).toBe('ok');
    expect(needLevel(40, 15)).toBe('ok');
    expect(needLevel(0.4, 15)).toBe('part');
    expect(needLevel(0, 15)).toBe('none');
  });

  it('значок каждого груза по порядку и счётчик «✓ закрыто из всех»', () => {
    const html = needsFoldHtml(needs, 15);
    expect(dots(html).map((d) => d.level)).toEqual(['none', 'ok', 'part']);
    expect(html).toContain('<span class="need-count" data-tip="Закрыто в этом месяце: 1 из 3 · в прошлом: 2 из 3">✓ 1 из 3</span>');
    // Без системных подсказок: у значков груза нет <title>.
    expect(html).not.toContain('<title>');
  });

  it('кольцо заполнено, сколько привезли из нормы: у пустого дуги нет, у закрытого — целиком и зелёная', () => {
    const html = needsFoldHtml(needs, 15);
    const full = 2 * Math.PI * 10.6;
    const [ok, part] = arcs(html);
    expect(ok).toBeCloseTo(full, 0);
    expect(part).toBeCloseTo(full * (6 / 15), 0);
    expect(arcs(html)).toHaveLength(2);
    expect(html).toContain('stroke="#2e9d57"');
  });

  it('все закрыты — счётчик зелёный, ни одной — красный', () => {
    const done = needs.map((n) => ({ ...n, now: 15 }));
    expect(needsFoldHtml(done, 15)).toContain('class="need-count all"');
    expect(needsFoldHtml(done, 15)).toContain('✓ 3 из 3');
    const empty = needs.map((n) => ({ ...n, now: 0 }));
    expect(needsFoldHtml(empty, 15)).toContain('class="need-count none"');
  });

  it('в подсказке значка — этот месяц с переносами и прошлый', () => {
    expect(needTip(needs[1], 15)).toBe(
      'Продукты: в этом месяце 22 из 15 ✓ · 15 — излишек прошлого месяца · 7 сверх нормы перейдёт в следующий · в прошлом 18 ✓',
    );
    expect(needTip(needs[0], 15)).toBe('Топливо: в этом месяце 0 из 15 · в прошлом 0');
    expect(dots(needsFoldHtml(needs, 15))[2].tip).toBe(needTip(needs[2], 15));
  });

  it('город ничего не просит — строки нет', () => {
    expect(needsFoldHtml([], 15)).toBe('');
  });

  it('заголовок: «?» с подсказкой о росте вместо текста под блоком; сводка — только у свёрнутого', () => {
    const open = needsHeadHtml(needs, 15, false);
    const folded = needsHeadHtml(needs, 15, true);
    for (const html of [open, folded]) {
      expect(html).toContain('data-action="toggle-needs"');
      expect(html).toContain(`<span class="help-q" data-action="hint" data-tip="${NEEDS_HINT}">?</span>`);
      expect(html).not.toContain('title=');
    }
    expect(NEEDS_HINT).toContain('ускоряет рост');
    expect(open).not.toContain('need-dot');
    expect(open).toContain('class="caret "');
    expect(folded).toContain(needsFoldHtml(needs, 15));
    expect(folded).toContain('class="caret closed"');
  });
});
