import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { MODELS } from '../game/transport';
import { DEFAULT_SETTINGS } from '../world/settings';

const scenarioGame = () => new Game({ ...DEFAULT_SETTINGS, seed: 42, scenario: { difficulty: 'normal', challenge: false } });

/** Главная цель этапа выполнена — переходим на следующий. */
function advance(game: Game): void {
  const sc = game.scenario!;
  const main = sc.state.objectives.filter((o) => o.phase === sc.state.phase && o.role === 'main').pop()!;
  main.status = 'done';
  expect(sc.advancePhase()).toBe(true);
}

describe('Модели транспорта в сценарии', () => {
  it('этап B открывает вторую ступень, этап C — третью; с заметками и записью в журнале', () => {
    const game = scenarioGame();
    expect(game.modelTier).toBe(1);
    expect(game.modelOpen('truck')).toBe(true);
    expect(game.modelOpen('truck2')).toBe(false);
    expect(game.modelOpen('bus2')).toBe(false);

    advance(game);
    expect(game.modelTier).toBe(2);
    for (const id of ['truck2', 'bus2', 'freightTrain2'] as const) expect(game.modelOpen(id)).toBe(true);
    for (const id of ['truck3', 'bus3', 'passengerTrain2'] as const) expect(game.modelOpen(id)).toBe(false);
    expect(game.notices.some((n) => n.text.includes(MODELS.truck2.name))).toBe(true);
    expect(game.journal.entries.find((e) => e.k === 'models')).toMatchObject({ tier: 2, open: ['truck2', 'bus2', 'freightTrain2'] });

    advance(game);
    expect(game.modelTier).toBe(3);
    for (const id of ['truck3', 'bus3', 'passengerTrain2'] as const) expect(game.modelOpen(id)).toBe(true);
    // Год всё ещё первый — открыли этапы, а не календарь.
    expect(game.year).toBe(game.startYear);
  });

  it('ступень сохраняется; старое сохранение без неё — по этапу сценария', () => {
    const game = scenarioGame();
    advance(game);
    const save = game.toSave();
    expect(save.modelTier).toBe(2);
    expect(new Game(save.settings, save).modelOpen('truck2')).toBe(true);
    const { modelTier: _drop, ...old } = save;
    expect(new Game(old.settings, old).modelTier).toBe(2);
  });

  it('в песочнице модели выходят по годам', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 7 });
    expect(game.modelOpen('truck2')).toBe(false);
    (game as unknown as { month: number }).month = MODELS.truck2.debut * 12;
    expect(game.modelOpen('truck2')).toBe(true);
    expect(game.modelOpen('truck3')).toBe(false);
  });
});
