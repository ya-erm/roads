import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE } from '../game/transport';
import { reorderStop, stopFoldHtml, stopPlaceHtml, stopWaitingHtml, toggleStop } from './routeStop';

describe('toggleStop', () => {
  it('клик по свёрнутой остановке раскрывает её', () => {
    expect(toggleStop(null, { line: 1, i: 0 })).toEqual({ line: 1, i: 0 });
  });

  it('повторный клик по раскрытой остановке сворачивает её', () => {
    expect(toggleStop({ line: 1, i: 0 }, { line: 1, i: 0 })).toBeNull();
  });

  it('клик по другой остановке или другой линии переключает на неё', () => {
    expect(toggleStop({ line: 1, i: 0 }, { line: 1, i: 2 })).toEqual({ line: 1, i: 2 });
    expect(toggleStop({ line: 1, i: 0 }, { line: 3, i: 0 })).toEqual({ line: 3, i: 0 });
  });
});

describe('stopPlaceHtml', () => {
  it('номер и название — одна кнопка «показать на карте» с id станции', () => {
    const html = stopPlaceHtml(1, 42, 'Угольная шахта');
    expect(html).toMatch(/^<button class="stop-place" data-action="show-station" data-id="42"/);
    expect(html).toContain('<span class="num">2</span>');
    expect(html).toContain('<span class="st-name">Угольная шахта</span>');
    expect(html).toMatch(/<\/button>$/);
  });

  it('кнопка не раскрывает настройку остановки', () => {
    expect(stopPlaceHtml(0, 7, 'А')).not.toContain('stop-open');
  });

  it('станции нет — номер и название без действия', () => {
    const html = stopPlaceHtml(0, null, '?');
    expect(html).toBe('<span class="stop-place"><span class="num">1</span><span class="st-name">?</span></span>');
  });
});

describe('stopFoldHtml', () => {
  it('свёрнутая — стрелка вниз, раскрытая — вверх', () => {
    expect(stopFoldHtml(false)).toContain('class="fold down"');
    expect(stopFoldHtml(true)).toContain('class="fold up"');
    expect(stopFoldHtml(true)).toContain('<svg');
  });
});

describe('stopWaitingHtml', () => {
  it('показывает пассажирскую очередь и разбивку по грузам', () => {
    const pax = stopWaitingHtml(7, []);
    expect(pax).toContain('<b>7</b>');
    expect(pax).not.toContain('Зерно');
    const mixed = stopWaitingHtml(7, [['grain', 3.8], ['logs', 4.9], ['oil', 0.6]]);
    expect(mixed).toContain('7 пасс.');
    expect(mixed).toContain('Груза ждёт 7 · Зерно 3 · Брёвна 4');
    expect(mixed).not.toContain('Нефть');
  });

  it('у одного типа груза показывает его значок и число, у пустой станции нет плашек', () => {
    const freight = stopWaitingHtml(0, [['grain', 5]]);
    expect(freight).toContain('Зерно · ждёт 5');
    expect(freight).not.toContain('пасс.');
    expect(stopWaitingHtml(0, [])).toBe('');
  });
});

describe('reorderStop', () => {
  it('переносит остановку и её правила одним шагом с сохранением порядка соседних остановок', () => {
    const rule = { ...DEFAULT_RULE, platform: 2 };
    const line = { stops: [1, 2, 3, 4], rules: [null, rule] };
    expect(reorderStop(line, 1, 3)).toEqual({ stops: [1, 3, 4, 2], rules: [null, null, null, rule] });
    expect(reorderStop(line, 3, 0)).toEqual({ stops: [4, 1, 2, 3], rules: [null, null, rule, null] });
    expect(line.stops).toEqual([1, 2, 3, 4]);
    expect(line.rules).toEqual([null, rule]);
  });
});
