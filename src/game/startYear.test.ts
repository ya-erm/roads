import { describe, expect, it } from 'vitest';
import { LEGACY_START_YEAR, START_YEAR } from '../config';
import { Game } from './game';
import { withoutCitizens } from './testkit';
import { MODELS, modelsFor, type ModelId } from './transport';

const setMonth = (game: Game, month: number) => ((game as unknown as { month: number }).month = month);

describe('Календарь партии', () => {
  it('новая партия начинается с 2000 года', () => {
    expect(START_YEAR).toBe(2000);
    const game = withoutCitizens(new Game(7));
    expect(game.startYear).toBe(2000);
    expect(game.year).toBe(2000);
    expect(game.dateLabel).toBe('Янв 2000');
    setMonth(game, 14);
    expect(game.dateLabel).toBe('Мар 2001');
    expect(game.dateAt(0)).toBe('Янв 2000');
  });

  it('в 2000 году продаётся только первое поколение, следующие выходят по годам от начала партии', () => {
    const game = withoutCitizens(new Game(7));
    expect(modelsFor('road', game.modelOpen)).toEqual(['truck', 'bus']);
    expect(modelsFor('rail', game.modelOpen)).toEqual(['freightTrain', 'passengerTrain']);
    const years = Object.fromEntries((Object.keys(MODELS) as ModelId[]).map((id) => [id, game.modelYear(id)]));
    expect(years).toEqual({
      truck: 2000,
      bus: 2000,
      freightTrain: 2000,
      passengerTrain: 2000,
      truck2: 2008,
      bus2: 2009,
      freightTrain2: 2012,
      passengerTrain2: 2015,
      truck3: 2017,
      bus3: 2019,
    });
    // Ступень 2 — за 8–15 лет (месяц — минута: 1,5–3 часа игры), ступень 3 — позже неё.
    for (const id of Object.keys(MODELS) as ModelId[]) {
      const m = MODELS[id];
      expect(m.debut === 0).toBe(m.tier === 1);
      if (m.tier === 3) expect(m.debut).toBeGreaterThan(6);
    }
  });

  it('год начала пишется в сохранение и возвращается из него', () => {
    const game = withoutCitizens(new Game(7));
    setMonth(game, 14);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    expect(save.startYear).toBe(2000);
    const loaded = new Game(save.settings, save);
    expect(loaded.startYear).toBe(2000);
    expect(loaded.dateLabel).toBe('Мар 2001');
  });

  it('старое сохранение без года начала открывается со своей датой (с 1960 года), модели — по его календарю', () => {
    expect(LEGACY_START_YEAR).toBe(1960);
    const game = withoutCitizens(new Game(7));
    setMonth(game, 8 * 12 + 2);
    const { startYear: _drop, ...old } = JSON.parse(JSON.stringify(game.toSave()));
    const legacy = new Game(old.settings, old);
    expect(legacy.startYear).toBe(1960);
    expect(legacy.dateLabel).toBe('Мар 1968');
    // «Грузовик II» — через 8 лет от начала партии, в 1968-м; «Фура» — ещё нет (1977).
    expect(legacy.modelYear('truck2')).toBe(1968);
    expect(legacy.modelOpen('truck2')).toBe(true);
    expect(legacy.modelOpen('truck3')).toBe(false);
    // Пересохранённая старая партия остаётся в своём календаре.
    expect(legacy.toSave().startYear).toBe(1960);
  });

  it('совсем старое сохранение (с 1960 года, месяц 2 минуты): та же дата, и что вышло по реальному времени — в продаже', () => {
    const game = withoutCitizens(new Game(7));
    const { startYear: _drop, monthLength: _len, ...old } = JSON.parse(JSON.stringify(game.toSave()));
    // Март 1964-го при месяце в 2 минуты: прошло 4 года 2,5 месяца — 101 минута игры.
    old.month = 4 * 12 + 2;
    old.time = (4 * 12 + 2.5) * 120;
    const legacy = new Game(old.settings, old);
    expect(legacy.dateLabel).toBe('Мар 1964');
    // «Грузовик II» выходит через 8 лет по минуте — 96 минут игры: уже в продаже, как было и до пересчёта.
    expect(legacy.modelOpen('truck2')).toBe(true);
    expect(legacy.modelYear('truck2')).toBe(1964);
    // «Фура» — через 17 лет по минуте (204 мин): ещё 103 минуты — в 1973-м.
    expect(legacy.modelOpen('truck3')).toBe(false);
    expect(legacy.modelYear('truck3')).toBe(1973);
    // Сдвиг календаря моделей сохраняется с партией.
    const again = new Game(old.settings, JSON.parse(JSON.stringify(legacy.toSave())));
    expect(again.modelYear('truck2')).toBe(1964);
    expect(again.modelYear('truck3')).toBe(1973);
  });
});
