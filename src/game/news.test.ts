import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../world/settings';
import { Game } from './game';
import { News, NEWS_LIMIT, NEWS_MONTHS, NOTICE_AFTER_PAUSE, NOTICE_LIFE } from './news';

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

  it('клик по плашке — запись прочитана, на колокольчике её нет; отметка сохраняется до открытия окна', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    const town = game.towns[0];
    game.notify('a', undefined, { kind: 'town', refs: [{ type: 'town', id: town.id }] });
    game.notify('b', undefined, { kind: 'goal' });
    game.notify('Не хватает денег');
    expect(game.news.unread).toBe(2);
    game.readNotice(game.notices[0].id);
    game.readNotice(game.notices[2].id); // подсказка — не в истории, ничего не меняет
    expect(game.news.unread).toBe(1);
    expect([...game.news.unreadSet()]).toEqual([game.notices[1].news]);
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.news.unread).toBe(1);
    game.news.markRead();
    expect(game.news.entries.some((e) => e.read)).toBe(false);
    expect(game.news.unread).toBe(0);
  });

  it('крестик убирает только плашку — запись в истории остаётся непрочитанной', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    game.notify('Задание выполнено', undefined, { kind: 'goal' });
    game.closeNotice(game.notices[0].id);
    expect(game.notices).toHaveLength(0);
    expect(game.news.entries.map((e) => e.text)).toEqual(['Задание выполнено']);
    expect(game.news.unread).toBe(1);
  });

  it('на паузе плашки не гаснут; после паузы уходят по реальному времени', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    game.notify('Стройка закончена', undefined, { kind: 'build' });
    game.notify('Не хватает денег');
    game.update(5); // первое уже гаснет
    game.notify('Игра сохранена');
    game.speed = 0;
    for (let i = 0; i < 100; i++) game.update(1); // долгая пауза
    expect(game.notices.map((n) => n.age)).toEqual([NOTICE_LIFE - NOTICE_AFTER_PAUSE, NOTICE_LIFE - NOTICE_AFTER_PAUSE, 0]);
    // Продолжили — гаснувшим остаётся NOTICE_AFTER_PAUSE, свежему — вся жизнь; скорость игры не влияет.
    game.speed = 4;
    game.update(NOTICE_AFTER_PAUSE - 0.5);
    expect(game.notices).toHaveLength(3);
    game.update(1);
    expect(game.notices.map((n) => n.text)).toEqual(['Игра сохранена']);
    game.update(NOTICE_LIFE);
    expect(game.notices).toHaveLength(0);
  });

  it('то же уведомление, пока прежнее на экране, — не второе, а прежнее заново внизу', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    game.notify('Не хватает денег');
    game.notify('Игра сохранена');
    game.notices[0].age = 4;
    game.notify('Не хватает денег');
    expect(game.notices.map((n) => [n.text, n.age])).toEqual([
      ['Игра сохранена', 0],
      ['Не хватает денег', 0],
    ]);
    expect(new Set(game.notices.map((n) => n.id)).size).toBe(2);
  });
});
