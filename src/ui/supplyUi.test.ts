import { describe, expect, it } from 'vitest';
import {
  NEEDS_HINT,
  needLevel,
  needsFoldHtml,
  needsHeadHtml,
  needTip,
  type PaxNeed,
  paxKindTip,
  paxLineHtml,
  paxNeedHtml,
  supplyBarHtml,
  supplyLineHtml,
  type TownNeed,
} from './supplyUi';

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

describe('Пассажиры в «Что нужно городу»', () => {
  const pax: PaxNeed = {
    want: { city: 108, intercity: 36 },
    now: { city: 27, intercity: 40 },
    last: { city: 50, intercity: 20 },
    covered: 0.42,
    waiting: 12,
    linesHtml: '<button class="line-kind-btn" data-action="select-line" data-id="3">A</button>',
    dests: [
      { town: 2, name: 'Озёрск', now: 40, waiting: 12, linked: true },
      { town: 5, name: 'Дубки "Новые"', now: 0, waiting: 0, linked: false },
    ],
  };
  const fills = (html: string) => [...html.matchAll(/<div class="bar"><div style="width:([\d.]+)%;background:([^"]+)"/g)].map((m) => ({ w: Number(m[1]), c: m[2] }));

  it('две полоски: по городу и в другие города — довезли из тех, кто хочет ездить; закрытое — зелёным', () => {
    const html = paxNeedHtml(pax);
    const [city, inter] = fills(html);
    expect(city.w).toBeCloseTo(25, 1);
    expect(inter.w).toBe(100);
    expect(inter.c).toBe('#2e9d57');
    expect(html).toContain('<b>27</b> / 108');
    expect(html).toContain('class="pax-kind ok"');
    expect(html).toContain(`data-tip="${paxKindTip('city', pax)}"`);
    expect(paxKindTip('city', pax)).toBe('По городу: хотят ездить 108 в месяц · довезли 27 · в прошлом 50');
    expect(paxKindTip('intercity', pax)).toBe('В другие города: хотят ездить 36 в месяц · довезли 40 ✓ · в прошлом 20');
    expect(html).toContain(pax.linesHtml);
  });

  it('направления: с линией — сколько довезли и ждут, без линии — бледно; клик ведёт к городу', () => {
    const html = paxNeedHtml(pax);
    expect(html).toContain('<button class="pax-dest" data-action="focus" data-type="town" data-id="2"');
    expect(html).toContain('→ Озёрск <b>40</b> <i>⏳12</i>');
    expect(html).toContain('<button class="pax-dest off" data-action="focus" data-type="town" data-id="5"');
    expect(html).toContain('линии нет — жители ездят туда на машине');
    expect(html).toContain('Дубки &quot;Новые&quot;');
    // Станции за городом — без перехода.
    expect(paxNeedHtml({ ...pax, dests: [{ town: -1, name: 'за город', now: 3, waiting: 0, linked: true }] })).toContain('<span class="pax-dest"');
  });

  it('подпись: доля жителей у остановок, сколько ждут, прошлый месяц из всех желающих', () => {
    expect(paxLineHtml(pax)).toContain('🚏 42%');
    expect(paxLineHtml(pax)).toContain('⏳ 12');
    expect(paxLineHtml(pax)).toContain('в прошлом 70 из 144');
    expect(paxLineHtml({ ...pax, covered: 0, waiting: 0 })).toContain('Ни одной остановки с линией');
    expect(paxLineHtml({ ...pax, waiting: 0 })).not.toContain('⏳');
  });

  it('без системных подсказок; у города без жителей строки нет', () => {
    expect(paxNeedHtml(pax)).not.toContain('<title>');
    expect(paxNeedHtml(pax)).not.toContain('title=');
    expect(paxNeedHtml({ ...pax, want: { city: 0, intercity: 0 } })).toBe('');
  });

  it('свёрнутая строка: значок пассажиров после счётчика, в «✓ из» не входит', () => {
    const needs: TownNeed[] = [{ cargo: 'food', now: 15, carried: 0, last: 15 }];
    const html = needsFoldHtml(needs, 15, pax);
    expect(html).toContain('✓ 1 из 1');
    expect(html.indexOf('need-dot pax')).toBeGreaterThan(html.indexOf('need-count'));
    // 67 из 144 — дуга почти в половину кольца.
    const arc = Number(/class="need-dot pax part"[^]*?stroke-dasharray="([\d.]+)/.exec(html)![1]);
    expect(arc).toBeCloseTo(2 * Math.PI * 10.6 * (67 / 144), 0);
    expect(needsFoldHtml(needs, 15)).not.toContain('need-dot pax');
    expect(needsHeadHtml(needs, 15, true, pax)).toContain('need-dot pax');
    expect(NEEDS_HINT).toContain('Пассажиры');
  });
});
