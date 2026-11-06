import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { freightRoute, runSeconds, withoutCitizens } from '../game/testkit';
import { CARGO } from '../world/cargo';
import { DEFAULT_SETTINGS } from '../world/settings';
import { linePaceHtml } from './linePace';

describe('Темп в карточке маршрута', () => {
  it('по грузу — значок и «N/мин» с подсказкой, что это оценка; пока рейсов не было — первая доставка; машин нет — пусто', { timeout: 60_000 }, () => {
    const game = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 5 }));
    const { line, from, built } = freightRoute(game);
    expect(built).toBe(true);
    expect(linePaceHtml(game, line)).toBe('');
    game.buyVehicle(line.id, 'truck');
    const html = linePaceHtml(game, line);
    expect(html).toContain('>Темп</span>');
    expect(html).toMatch(/<i class="lp" data-tip="[^"]*: ~[\d,]+ в минуту — оценка по циклу[^"]*"><svg class="cargo-icon"[\s\S]*<\/svg>[\d,]+\/мин<\/i>/);
    expect(html).toContain(`${CARGO[from.info.produces].name}: ~`);
    expect(html).toMatch(/>Первая доставка<\/span><b>через ~\d+ (сек|мин)<\/b>/);
    // Груз уже возили — без «первой доставки».
    for (let t = 0; t < 180 && !line.carriedMonth; t += 1) runSeconds(game, 1);
    expect(line.carriedMonth).toBeGreaterThan(0);
    expect(linePaceHtml(game, line)).not.toContain('Первая доставка');
  });
});
