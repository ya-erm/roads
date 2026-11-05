import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { runMonths } from './testkit';

/**
 * Движение в городах не должно вставать со временем — иначе линии постепенно уходят в минус.
 * Четыре месяца целого мира с машинами жителей — один из самых долгих тестов: отдельным файлом,
 * чтобы шёл параллельно с остальной экономикой (economy.test.ts).
 */
describe('Экономика', { timeout: 60_000 }, () => {
  it('движение в городах не встаёт со временем', () => {
    const game = new Game(7);
    runMonths(game, 1);
    const arrivals: number[] = [];
    let last = game.traffic.arrivals;
    for (let m = 0; m < 3; m++) {
      runMonths(game, 1);
      arrivals.push(game.traffic.arrivals - last);
      last = game.traffic.arrivals;
    }
    // Пропускная способность не падает: последний месяц не хуже 85% первого.
    expect(arrivals[arrivals.length - 1]).toBeGreaterThan(arrivals[0] * 0.85);
  });
});
