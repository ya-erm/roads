import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { DEFAULT_SETTINGS } from '../world/settings';
import { resultsHtml } from './scenarioUi';

describe('Итоговый экран сценария', () => {
  it('есть кнопка сохранить журнал партии — с числом записей', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 7, scenario: { difficulty: 'easy', challenge: false } });
    game.scenario!.lose('проверка итогов');
    const html = resultsHtml(game, { best: null, previous: null, isNew: false });
    const button = html.match(/<button class="menu-item" data-action="export-journal"[\s\S]*?<\/button>/)?.[0];
    expect(button).toBeTruthy();
    expect(button).toContain('Сохранить журнал партии');
    const n = game.journal.entries.length.toLocaleString('ru-RU');
    expect(button).toMatch(new RegExp(`${n} запис(ь|и|ей)<`));
  });

  it('крестик в углу закрывает итоги и продолжает в песочнице — как кнопка «Продолжить в песочнице»', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 7, scenario: { difficulty: 'easy', challenge: false } });
    game.scenario!.lose('проверка итогов');
    const html = resultsHtml(game, { best: null, previous: null, isNew: false });
    expect(html.trimStart()).toMatch(/^<button class="icon modal-close" data-action="sc-continue"[^>]*>✕<\/button>/);
    expect(html).toContain('<button class="menu-item" data-action="sc-continue">');
  });
});
