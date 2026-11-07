import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { dist } from '../core/vec';
import type { Station } from '../world/entities';
import { Game } from './game';
import { connectStations, freightRoute, HIGHWAY, nearestPair, runSeconds, stationAtIndustry, townStreets, withoutCitizens } from './testkit';

/** Станция у улицы города — на той, что ближе к соседнему городу toward. */
function stationIn(game: Game, townId: number, toward: { x: number; y: number }): Station {
  const mid = (c: ReturnType<typeof townStreets>[number]) => c.lut.pointAt(c.length / 2);
  const streets = townStreets(game, townId).sort((a, b) => dist(mid(a), toward) - dist(mid(b), toward));
  for (const seg of streets) {
    for (const side of [-1, 1]) {
      const p = mid(seg);
      const t = seg.lut.tangentAt(seg.length / 2);
      const st = game.placeStation({ x: p.x - t.y * side * 40, y: p.y + t.x * side * 40 }, 14);
      if (st) return st;
    }
  }
  throw new Error(`Не поставить станцию в городе ${townId}`);
}

/** Станции в двух ближних больших городах мира 7, шоссе между ними; line — строить ли маршрут. */
function twoTowns(line: boolean) {
  const game = withoutCitizens(new Game(7));
  game.money = 5_000_000;
  const [a, ...rest] = [...game.towns].sort((x, y) => y.population - x.population);
  const b = rest.sort((x, y) => dist(x.center, a.center) - dist(y.center, a.center))[0];
  const sA = stationIn(game, a.id, b.center);
  const sB = stationIn(game, b.id, a.center);
  expect(connectStations(game, sA, sB, HIGHWAY)).toBe(true);
  return { game, sA, sB, line: line ? game.createLine([sA.id, sB.id])! : null };
}

const waitingPax = (st: Station) => [...st.passengers.values()].reduce((s, n) => s + n, 0);

describe('Пассажиры и груз копятся, как только есть маршрут, — машины не нужны', { timeout: 60_000 }, () => {
  it('пассажирский маршрут без автобусов: пассажиры ждут до другой станции, не больше предела станции', () => {
    const none = twoTowns(false);
    runSeconds(none.game, 15);
    // Маршрута нет — ехать некуда, никто не ждёт.
    expect(waitingPax(none.sA)).toBe(0);

    const { game, sA, sB, line } = twoTowns(true);
    expect(line!.vehicles).toHaveLength(0);
    expect(game.lineTakes(line!, 'passengers')).toBe(true);
    runSeconds(game, 15);
    expect(waitingPax(sA)).toBeGreaterThan(0);
    expect([...sA.passengers.keys()]).toEqual([sB.id]);
    expect(game.lineWaiting(line!, 0, 'passengers')).toBe(waitingPax(sA));
    // Без машин — не больше предела станции; со временем упираются в него и не растут.
    runSeconds(game, 60);
    expect(waitingPax(sA)).toBe(game.stationCap(sA, 'passengers'));

    // Детерминизм: те же действия — те же пассажиры.
    const again = twoTowns(true);
    runSeconds(again.game, 75);
    expect([...again.sA.passengers]).toEqual([...sA.passengers]);
    expect([...again.sB.passengers]).toEqual([...sB.passengers]);
  });

  it('грузовой маршрут без грузовиков: продукция фермы идёт на станцию, пассажиров не ждут', () => {
    const plain = withoutCitizens(new Game(7));
    const { a, b } = nearestPair(plain, 'farm', 'foodplant');
    const alone = stationAtIndustry(plain, a, b.fp.center)!;
    runSeconds(plain, MONTH_LENGTH);
    // Станция без маршрута — ферма стоит, на станцию ничего не кладёт.
    expect(alone.cargo.grain ?? 0).toBe(0);
    expect(plain.industries.find((i) => i.id === a.id)!.producedMonth).toBe(0);

    const game = withoutCitizens(new Game(7));
    const { built, line, sA, from } = freightRoute(game);
    expect(built).toBe(true);
    expect(line.vehicles).toHaveLength(0);
    expect(game.lineTakes(line, 'freight')).toBe(true);
    expect(game.lineTakes(line, 'passengers')).toBe(false);
    runSeconds(game, MONTH_LENGTH);
    expect(from.producedMonth).toBeGreaterThan(0);
    expect(sA.cargo.grain ?? 0).toBeGreaterThan(0);
    // Предел станции без машин и склад — те же.
    expect(sA.cargo.grain ?? 0).toBeLessThanOrEqual(game.stationCap(sA, 'freight'));
    expect(game.stationStored(sA)).toBeLessThanOrEqual(game.stationStorage(sA));
    expect(game.lineWaiting(line, 0, 'freight')).toBeGreaterThan(0);
    expect(sA.passengers.size).toBe(0);
  });

  it('маршрут убрали — продукция больше не поступает', () => {
    const game = withoutCitizens(new Game(7));
    const { line, sA } = freightRoute(game);
    runSeconds(game, MONTH_LENGTH);
    const had = sA.cargo.grain ?? 0;
    expect(had).toBeGreaterThan(0);
    game.deleteLine(line.id);
    runSeconds(game, MONTH_LENGTH);
    expect(sA.cargo.grain ?? 0).toBe(had);
  });
});
