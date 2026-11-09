import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { DEFAULT_SETTINGS } from '../world/settings';
import { newsBadge, newsHtml, newsTarget, noticeHtml, noticeOpacity } from './newsUi';

describe('Окно «События»', () => {
  const setup = () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    const ind = game.industries[0];
    const town = game.towns[0];
    game.news.add(2, { kind: 'town', text: `${town.name} растёт`, refs: [{ type: 'town', id: town.id }] });
    game.news.add(3, { kind: 'industry', text: `${ind.name}: выросло`, color: '#2e9d57', refs: [{ type: 'industry', id: ind.id }] });
    game.news.add(3, { kind: 'build', text: 'Стройка закончена', refs: [{ type: 'project', id: 999 }], at: { pos: { x: 5, y: 5 }, r: 80 } });
    return { game, ind, town };
  };

  it('записи по месяцам, свежие сверху; кнопки-места ведут к объектам; подсказки — свои, без title', () => {
    const { game, ind, town } = setup();
    const html = newsHtml(game, { kinds: new Set(), unread: new Set() });
    const may = html.indexOf(game.dateAt(3));
    const apr = html.indexOf(game.dateAt(2));
    expect(may).toBeGreaterThan(0);
    expect(apr).toBeGreaterThan(may);
    expect(html).toContain(`data-action="news-go" data-n="1" data-i="0"`);
    expect(html).toContain(ind.name);
    expect(html).toContain(town.name);
    // Проекта уже нет — кнопка к месту на карте.
    expect(html).toMatch(/data-action="news-go" data-n="2" data-tip="Показать на карте">📍/);
    expect(html).not.toMatch(/title="|<title>/);
  });

  it('фильтр по виду и подсветка непрочитанного', () => {
    const { game } = setup();
    const html = newsHtml(game, { kinds: new Set(['industry']), unread: new Set([1]) });
    expect(html).toContain('выросло');
    expect(html).not.toContain('растёт</div>');
    expect(html).toContain('news-row unread');
    expect(html).toMatch(/news-filter active" data-action="news-filter" data-kind="industry"/);
  });

  it('пусто — колокольчик и «Пока тихо»', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    expect(newsHtml(game, { kinds: new Set(), unread: new Set() })).toContain('Пока тихо');
  });

  it('подсвечено непрочитанное на момент открытия: по чьей плашке кликнули — нет', () => {
    const { game } = setup();
    game.news.read(1);
    const html = newsHtml(game, { kinds: new Set(), unread: game.news.unreadSet() });
    expect(html.match(/news-row unread/g)).toHaveLength(2);
    expect(html).toMatch(/news-row " [^>]*>\s*<span class="news-ic"[^>]*>🏭/);
  });

  it('объекта нет — некуда вести; число на колокольчике', () => {
    const { game, town } = setup();
    expect(newsTarget(game, { type: 'project', id: 999 })).toBeNull();
    expect(newsTarget(game, { type: 'town', id: town.id })?.pos).toEqual(town.center);
    expect(newsBadge(0)).toBe('');
    expect(newsBadge(7)).toBe('7');
    expect(newsBadge(120)).toBe('99+');
  });
});

describe('Всплывающее уведомление', () => {
  it('с местом — кнопка к нему, без значка-булавки; справа крестик с подсказкой data-tip', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    const ind = game.industries[0];
    game.notify('🚧 Стройка закончена: Перенос', '#3f9d5a', { kind: 'build', at: { pos: { x: 10, y: 20 }, r: 80 } });
    game.notify(`${ind.name}: выросло`, undefined, { kind: 'industry', refs: [{ type: 'industry', id: ind.id }] });
    game.notify('Не хватает денег');
    const [built, grown, hint] = game.notices.map((n) => noticeHtml(game, n));
    expect(built).toContain(`class="notice go" data-action="notice-go" data-tip="Показать на карте" data-id="${game.notices[0].id}"`);
    expect(grown).toContain('data-action="notice-go"');
    expect(built).not.toContain('📍');
    expect(built).toContain(`<button class="notice-x" data-action="notice-close" data-id="${game.notices[0].id}" data-tip="Скрыть — останется в истории 🔔">×</button>`);
    // Подсказка на действие — без места и не в истории: клик только «прочитано», крестик просто скрывает.
    expect(hint).toContain('class="notice" data-action="notice-read"');
    expect(hint).toContain('data-tip="Скрыть">×');
    expect([built, grown, hint].join('')).not.toMatch(/title="/);
  });

  it('гаснет последние полторы секунды жизни', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    game.notify('Игра сохранена');
    const n = game.notices[0];
    expect(noticeOpacity(n)).toBe(1);
    n.age = 5.25;
    expect(noticeOpacity(n)).toBeCloseTo(0.5);
  });
});
