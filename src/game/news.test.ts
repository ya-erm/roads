import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../world/settings';
import { Game } from './game';
import { News, NEWS_LIMIT, NEWS_MONTHS } from './news';

describe('История событий', () => {
  it('хранит записи за последние NEWS_MONTHS месяцев, старые уходят', () => {
    const news = new News();
    for (let m = 0; m < 10; m++) news.add(m, { kind: 'town', text: `Месяц ${m}` });
    const months = news.entries.map((e) => e.month);
    expect(Math.min(...months)).toBe(10 - NEWS_MONTHS);
    expect(months).toHaveLength(NEWS_MONTHS);
  });

  it('сверх предела уходят самые старые записи', () => {
    const news = new News();
    for (let i = 0; i < NEWS_LIMIT + 20; i++) news.add(0, { kind: 'industry', text: `#${i}` });
    expect(news.entries).toHaveLength(NEWS_LIMIT);
    expect(news.entries[0].text).toBe('#20');
  });

  it('непрочитанное — с прошлого открытия окна', () => {
    const news = new News();
    news.add(0, { kind: 'goal', text: 'a' });
    news.add(0, { kind: 'goal', text: 'b' });
    expect(news.unread).toBe(2);
    news.markRead();
    expect(news.unread).toBe(0);
    news.add(1, { kind: 'event', text: 'c' });
    expect(news.unread).toBe(1);
  });

  it('по месяцам, свежие сверху; фильтр по видам', () => {
    const news = new News();
    news.add(3, { kind: 'town', text: 'город' });
    news.add(3, { kind: 'industry', text: 'завод' });
    news.add(4, { kind: 'town', text: 'город 2' });
    const all = news.byMonth();
    expect(all.map((g) => g.month)).toEqual([4, 3]);
    expect(all[1].entries.map((e) => e.text)).toEqual(['завод', 'город']);
    const towns = news.byMonth(new Set(['town']));
    expect(towns.flatMap((g) => g.entries.map((e) => e.text))).toEqual(['город 2', 'город']);
    expect(news.counts().get('town')).toBe(2);
  });

  it('в историю идут события партии (с видом), а не подсказки на действия игрока', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    const ind = game.industries[0];
    game.notify('Не хватает денег');
    game.notify(`${ind.name}: производство выросло`, '#2e9d57', { kind: 'industry', refs: [{ type: 'industry', id: ind.id }] });
    expect(game.notices).toHaveLength(2);
    expect(game.notices[1].refs).toEqual([{ type: 'industry', id: ind.id }]);
    expect(game.news.entries).toHaveLength(1);
    expect(game.news.entries[0]).toMatchObject({ kind: 'industry', month: game.monthIndex, refs: [{ type: 'industry', id: ind.id }] });
  });

  it('история и отметка «прочитано» сохраняются в партии', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    const town = game.towns[0];
    game.notify(`${town.name} растёт`, undefined, { kind: 'town', refs: [{ type: 'town', id: town.id }] });
    game.news.markRead();
    game.notify('Стройка закончена', '#3f9d5a', { kind: 'build', at: { pos: { x: 10.4, y: 20.6 }, r: 80 } });
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.news.entries.map((e) => e.text)).toEqual([`${town.name} растёт`, 'Стройка закончена']);
    expect(loaded.news.entries[1].at).toEqual({ pos: { x: 10, y: 21 }, r: 80 });
    expect(loaded.news.unread).toBe(1);
  });

  it('старое сохранение без истории открывается с пустой', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    const save = JSON.parse(JSON.stringify(game.toSave()));
    delete save.news;
    const loaded = new Game(game.settings, save);
    expect(loaded.news.entries).toEqual([]);
    expect(loaded.news.unread).toBe(0);
  });
});
