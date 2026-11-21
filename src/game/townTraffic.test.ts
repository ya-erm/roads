import { describe, expect, it } from 'vitest';
import { breathe, freshGame, runMonths } from './testkit';

/**
 * Движение в городах не должно вставать со временем — иначе линии постепенно уходят в минус.
 * Восемь месяцев целого мира с машинами жителей и пешеходами на переходах — один из самых долгих тестов: отдельным
 * файлом, чтобы шёл параллельно с остальной экономикой (economy.test.ts).
 */
describe('Экономика', { timeout: 240_000 }, () => {
  // async и пауза после каждого месяца (breathe): тест идёт десятки секунд, под нагрузкой — дольше минуты.
  it('движение в городах не встаёт со временем', async () => {
    const game = freshGame(7);
    game.setPedestrians(true);
    // Разгон: в первые месяцы машины жителей только разъезжаются по городу (во втором — пик прибытий), дальше — ровно.
    for (let month = 0; month < 2; month++) {
      runMonths(game, 1);
      await breathe();
    }
    const arrivals: number[] = [];
    let last = game.traffic.arrivals;
    for (let m = 0; m < 6; m++) {
      runMonths(game, 1);
      await breathe();
      arrivals.push(game.traffic.arrivals - last);
      last = game.traffic.arrivals;
    }
    // Пропускная способность не падает: три последних месяца в среднем не хуже 85% трёх первых. Месяц к месяцу
    // прибытия гуляют на ±10 % (кто куда поехал); пробка, что копится (пешеходы, вклинивающиеся в плотный поток, —
    // docs/CROSSWALKS.md), — это −20 % и больше к восьмому месяцу.
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean(arrivals.slice(3))).toBeGreaterThan(mean(arrivals.slice(0, 3)) * 0.85);
  });
});
