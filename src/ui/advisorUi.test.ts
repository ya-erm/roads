import { describe, expect, it } from 'vitest';
import type { Advice } from '../game/advisor';
import { Game } from '../game/game';
import { DEFAULT_SETTINGS } from '../world/settings';
import { adviceBadge, advisorHtml, fixLabel } from './advisorUi';

const advice = (over: Partial<Advice>): Advice => ({ key: 'k', kind: 'noVehicles', level: 'tip', title: 'Т', detail: 'Д', ...over });

describe('Панель советника', () => {
  it('число на лампочке — все советы, цвет — по самому важному', () => {
    expect(adviceBadge([])).toEqual({ n: 0, level: null });
    expect(adviceBadge([advice({ level: 'tip' })])).toEqual({ n: 1, level: 'tip' });
    expect(adviceBadge([advice({ level: 'tip' }), advice({ level: 'warn' })])).toEqual({ n: 2, level: 'warn' });
    expect(adviceBadge([advice({ level: 'warn' }), advice({ level: 'alert' })])).toEqual({ n: 2, level: 'alert' });
  });

  it('карточка: заголовок, подробности, «Показать», быстрое действие; подсказки — свои, без title', () => {
    const game = new Game({ ...DEFAULT_SETTINGS, seed: 42 });
    const html = advisorHtml(game, [
      advice({ key: 'debt', kind: 'debt', level: 'alert', title: 'На грани банкротства', detail: 'Возьмите кредит', at: { x: 1, y: 2 }, fix: { kind: 'loan' } }),
      advice({ key: 'q', kind: 'queue', level: 'warn', title: 'Очередь на въезд', detail: '3 машины', count: 3, fix: { kind: 'bay', station: 1 } }),
    ]);
    expect(html).toContain('На грани банкротства');
    expect(html).toContain('data-action="advice-show" data-key="debt"');
    expect(html).toContain('data-action="advice-fix" data-key="debt"');
    expect(html).toContain('Взять кредит');
    expect(html).toContain('+1 пост');
    expect(html).toContain('class="adv-count">3<');
    expect(html).not.toMatch(/title="[^"]/);
    // Советов нет — «всё работает».
    expect(advisorHtml(game, [])).toContain('Всё работает');
    expect(fixLabel(game, { kind: 'sell', line: 1 })).toBe('−1 машина');
  });
});
