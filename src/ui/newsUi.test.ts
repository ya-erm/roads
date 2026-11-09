import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { DEFAULT_SETTINGS } from '../world/settings';
import { newsBadge, newsHtml, newsTarget } from './newsUi';

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
    const html = newsHtml(game, { kinds: new Set(), unreadFrom: Infinity });
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
    const html = newsHtml(game, { kinds: new Set(['industry']), unreadFrom: 1 });
    expect(html).toContain('выросло');
    expect(html).not.toContain('растёт</div>');
    expect(html).toContain('news-row unread');
    expect(html).toMatch(/news-filter active" data-action="news-filter" data-kind="industry"/);
  });

  it('пусто — колокольчик и «Пока тихо»', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    expect(newsHtml(game, { kinds: new Set(), unreadFrom: 0 })).toContain('Пока тихо');
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
