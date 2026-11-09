import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import type { Station } from '../world/entities';
import { townPaxWant } from '../world/townPax';
import { Game, type SaveData } from './game';
import { connectStations, HIGHWAY, runMonths, townStreets, withoutCitizens } from './testkit';
import { townPax } from './townPax';

/** Станция у улицы города — на той, что ближе к соседнему городу toward (как в routeWaiting.test.ts). */
function stationIn(game: Game, townId: number, toward: { x: number; y: number }): Station {
  const mid = (c: ReturnType<typeof townStreets>[number]) => c.lut.pointAt(c.length / 2);
  const streets = townStreets(game, townId).sort((a, b) => dist(mid(a), toward) - dist(mid(b), toward));
  for (const seg of streets) {
    const p = mid(seg);
    const t = seg.lut.tangentAt(seg.length / 2);
    // Сперва — по ту сторону улицы, что дальше от соседнего города: шоссе к нему от перекрёстка выезда не упрётся в саму станцию.
    const away = (toward.x - p.x) * t.y - (toward.y - p.y) * t.x > 0 ? 1 : -1;
    for (const side of [away, -away]) {
      const st = game.placeStation({ x: p.x - t.y * side * 40, y: p.y + t.x * side * 40 }, 14);
      if (st) return st;
    }
  }
  throw new Error(`Не поставить станцию в городе ${townId}`);
}

describe('Пассажиры города в «Что нужно городу»', { timeout: 120_000 }, () => {
  it('без линий: хотят ездить по населению, никого не везут, ближние города — без линии', () => {
    const game = withoutCitizens(new Game(7));
    const town = [...game.towns].sort((x, y) => y.population - x.population)[0];
    const p = townPax(game, town);
    expect(p.want).toEqual(townPaxWant(town.population));
    expect(p.want.city).toBeGreaterThan(p.want.intercity);
    expect(p.now).toEqual({ city: 0, intercity: 0 });
    expect(p.covered).toBe(0);
    expect(p.lines).toEqual([]);
    // Подсказка, куда пустить автобус: два ближних города, линий туда нет.
    expect(p.dests).toHaveLength(2);
    expect(p.dests.every((d) => !d.lines.length && d.now === 0)).toBe(true);
  });

  it('автобус между городами: довезённые — в счёт города отправления, направление — с линией; месяц закрывается и сохраняется', () => {
    const game = withoutCitizens(new Game(7));
    game.money = 5_000_000;
    const [a, ...rest] = [...game.towns].sort((x, y) => y.population - x.population);
    const b = rest.sort((x, y) => dist(x.center, a.center) - dist(y.center, a.center))[0];
    const sA = stationIn(game, a.id, b.center);
    const sB = stationIn(game, b.id, a.center);
    expect(connectStations(game, sA, sB, HIGHWAY)).toBe(true);
    const line = game.createLine([sA.id, sB.id])!;
    expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();

    // Рейс туда и обратно — дольше месяца: ждём месяц, в котором автобус довёз пассажиров из a.
    for (let m = 0; m < 6 && !a.paxLast; m++) runMonths(game, 1);
    const p = townPax(game, a);
    expect(p.lines.map((l) => l.id)).toEqual([line.id]);
    expect(p.covered).toBeGreaterThan(0);
    expect(p.covered).toBeLessThanOrEqual(1);
    const toB = p.dests.find((d) => d.town === b.id)!;
    expect(toB.lines.map((l) => l.id)).toEqual([line.id]);
    expect(p.dests[0]).toBe(toB);
    // Всё довезённое из a — в b: межгород, по городу никого.
    expect(p.last.intercity).toBeGreaterThan(0);
    expect(p.last.city).toBe(0);
    expect(a.paxLast).toEqual({ [b.id]: p.last.intercity });
    expect(toB.last).toBe(p.last.intercity);
    expect(townPax(game, b).dests.find((d) => d.town === a.id)?.lines).toHaveLength(1);

    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    const loaded = new Game(save.settings, save);
    const a2 = loaded.towns.find((t) => t.id === a.id)!;
    expect(townPax(loaded, a2).last).toEqual(p.last);
    expect(townPax(loaded, a2).now).toEqual(p.now);

    // Обратные рейсы — в счёт b.
    for (let m = 0; m < 6 && !b.paxLast; m++) runMonths(game, 1);
    expect(b.paxLast).toEqual({ [a.id]: townPax(game, b).last.intercity });
    expect(townPax(game, b).last.intercity).toBeGreaterThan(0);
  });
});
