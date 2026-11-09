import { describe, expect, it } from 'vitest';
import { Game, type SaveData } from '../game/game';
import { freightRoute, freshGame, runMonths, withoutCitizens } from '../game/testkit';
import { spanText, timelapseItemHtml, timelapseState } from './timelapseButton';

/** Сохранение без кадров таймлапса — как до этой версии игры; journal: false — и без журнала. */
function legacy(game: Game, journal = true): Game {
  const data = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
  delete data.timelapse;
  if (!journal) delete data.journal;
  return withoutCitizens(new Game(data.settings, data));
}

describe('Кнопка «Таймлапс партии»', { timeout: 120_000 }, () => {
  it('новая партия: серая, в подсказке — когда появится; после стройки — можно смотреть', () => {
    const game = withoutCitizens(freshGame(7));
    const empty = timelapseState(game);
    expect(empty.ok).toBe(false);
    expect(empty.tip).toMatch(/в конце каждого месяца/);
    const html = timelapseItemHtml(game);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('menu-item disabled');
    expect(html).toContain('data-tip=');
    expect(html).not.toContain('title=');
    // Построили на паузе — уже есть что показать: старт и сеть сейчас.
    freightRoute(game);
    expect(timelapseState(game).ok).toBe(true);
    runMonths(game, 2.05);
    const s = timelapseState(game);
    expect(s.ok).toBe(true);
    expect(s.note).toContain('2 мес.');
    expect(timelapseItemHtml(game)).toContain('aria-disabled="false"');
  });

  it('старое сохранение: начало — по журналу; без журнала и кадров — серая с объяснением', () => {
    const game = withoutCitizens(freshGame(7));
    freightRoute(game);
    runMonths(game, 2.05);
    const rough = timelapseState(legacy(game));
    expect(rough.ok).toBe(true);
    expect(rough.note).toContain('по журналу');
    const none = timelapseState(legacy(game, false));
    expect(none.ok).toBe(false);
    expect(none.tip).toMatch(/до таймлапса/);
  });

  it('длительность партии — годами и месяцами', () => {
    expect(spanText(0.4)).toBe('1 мес.');
    expect(spanText(7)).toBe('7 мес.');
    expect(spanText(12)).toBe('1 год');
    expect(spanText(29)).toBe('2 года 5 мес.');
    expect(spanText(60)).toBe('5 лет');
  });
});
