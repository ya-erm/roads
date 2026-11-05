import { describe, expect, it } from 'vitest';
import { stopFoldHtml, stopPlaceHtml, toggleStop } from './routeStop';

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
