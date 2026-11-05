import { describe, expect, it } from 'vitest';
import type { Advice } from '../game/advisor';
import type { Game } from '../game/game';
import type { StationWarning } from '../game/stationWarnings';
import type { Station } from '../world/entities';
import { lineJamsHtml, stationWarningsHtml } from './jamUi';

const g = { lines: new Map() } as unknown as Game;

describe('Предупреждения в панелях', () => {
  const jam: StationWarning = { key: 'jam:5', level: 'warn', title: 'Все посты заняты', tip: '…', detail: 'Ждут въезда: 3.', fix: { kind: 'bay', station: 5 }, count: 3 };
  const advice = { key: 'storage:5', kind: 'storage', level: 'warn', title: 'Склад станции полон', detail: 'Проведите маршрут.', fix: { kind: 'route', station: 5 } } as Advice;
  const storage: StationWarning = { key: advice.key, level: 'warn', advice, title: advice.title, tip: '…', detail: advice.detail, fix: advice.fix };

  it('карточка станции: по строке на предупреждение — значок, что случилось, подробно и кнопка действия', () => {
    const html = stationWarningsHtml(g, 5, [jam, storage]);
    expect(html).toContain('no-entry');
    expect(html).toContain('<b>Все посты заняты</b>');
    expect(html).toContain('data-action="warn-fix" data-id="5" data-key="jam:5"');
    expect(html).toContain('+1 пост');
    expect(html).toContain('<b>Склад станции полон</b>');
    expect(html).toContain('+ Маршрут отсюда');
    expect(html).not.toContain('flash');
    expect(stationWarningsHtml(g, 5, [jam], true)).toContain('station-warnings flash');
    expect(stationWarningsHtml(g, 5, [])).toBe('');
  });

  it('карточка маршрута: по строке на станцию, клик показывает её; название экранировано', () => {
    const st = { id: 5, name: 'Б<ерёзовка>', kind: 'road' } as Station;
    const html = lineJamsHtml([{ station: st, waiting: 4 }]);
    expect(html).toContain('data-action="show-station" data-id="5"');
    expect(html).toContain('Б&lt;ерёзовка&gt;: все посты заняты, ждут въезда 4');
    expect(lineJamsHtml([])).toBe('');
  });
});
