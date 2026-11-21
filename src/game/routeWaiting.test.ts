import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { dist } from '../core/vec';
import { buildBusScene } from '../testpages/bus';
import type { Station } from '../world/entities';
import { townTier } from '../world/townForms';
import { Game } from './game';
import { connectStations, freightRoute, freshGame, HIGHWAY, nearestPair, runSeconds, stationAtIndustry, townStreets, withoutCitizens } from './testkit';
import { DEFAULT_RULE } from './transport';

/**
 * Станция у улицы города — на той, что ближе к соседнему городу toward, с жителями в охвате (на окраине частного
 * сектора их мало — пассажиры подходят редко).
 */
function stationIn(game: Game, townId: number, toward: { x: number; y: number }, minPop = 500): Station {
  const mid = (c: ReturnType<typeof townStreets>[number]) => c.lut.pointAt(c.length / 2);
  const streets = townStreets(game, townId).sort((a, b) => dist(mid(a), toward) - dist(mid(b), toward));
  for (const seg of streets) {
    const p = mid(seg);
    const t = seg.lut.tangentAt(seg.length / 2);
    // Сперва — по ту сторону улицы, что дальше от соседнего города: шоссе к нему от перекрёстка выезда не упрётся в саму станцию.
    const away = (toward.x - p.x) * t.y - (toward.y - p.y) * t.x > 0 ? 1 : -1;
    for (const side of [away, -away]) {
      const st = game.placeStation({ x: p.x - t.y * side * 40, y: p.y + t.x * side * 40 }, 14);
      if (!st) continue;
      if (st.catchPop >= minPop) return st;
      game.removeStation(st);
    }
  }
  throw new Error(`Не поставить станцию в городе ${townId}`);
}

/** Станции в двух ближних больших городах мира 7, шоссе между ними; line — строить ли маршрут. */
function twoTowns(line: boolean) {
  const game = withoutCitizens(freshGame(7));
  game.money = 5_000_000;
  const [a, ...rest] = [...game.towns].sort((x, y) => y.population - x.population);
  // Соседний город — не село.
  const b = rest.filter((t) => townTier(t) !== 'village').sort((x, y) => dist(x.center, a.center) - dist(y.center, a.center))[0];
  const sA = stationIn(game, a.id, b.center);
  const sB = stationIn(game, b.id, a.center);
  expect(connectStations(game, sA, sB, HIGHWAY)).toBe(true);
  return { game, sA, sB, line: line ? game.createLine([sA.id, sB.id])! : null };
}

const waitingPax = (st: Station) => [...st.passengers.values()].reduce((s, n) => s + n, 0);

describe('Ожидание на остановке выбранного маршрута', () => {
  it('различает пассажиров двух маршрутов с общей остановкой, даже если транспорт ещё не куплен', () => {
    const { game, lines } = buildBusScene();
    const [a, b, c, other] = game.lines.get(lines.avenue)!.stops;
    const left = game.createLine([a, b])!;
    const right = game.createLine([a, c])!;
    expect(left.vehicles).toHaveLength(0);
    expect(right.vehicles).toHaveLength(0);
    const st = game.stations.get(a)!;
    st.passengers = new Map([[b, 25], [c, 44], [other, 7]]);

    expect(game.lineWaiting(left, 0, 'passengers')).toBe(25);
    expect(game.lineWaiting(right, 0, 'passengers')).toBe(44);
    expect(waitingPax(st)).toBe(76);
  });

  it('различает правила погрузки при двух посещениях одной станции и выгрузку у других остановок', () => {
    const game = withoutCitizens(freshGame(7));
    const { sA, sB } = freightRoute(game);
    const third = stationAtIndustry(game, game.industries.find((i) => i.id === sB.industryId)!, sA.fp.center)!;
    const line = game.createLine([sA.id, sB.id, sA.id, third.id])!;
    sA.cargo = { grain: 32.5, logs: 11, oil: 6 };
    sB.accepts = new Set(['grain']);
    third.accepts = new Set();
    game.setStopRule(line.id, 2, { ...DEFAULT_RULE, load: ['logs'] });

    expect(game.lineFreightWaiting(line, 0)).toEqual([['grain', 32.5]]);
    expect(game.lineFreightWaiting(line, 2)).toEqual([['logs', 11]]);
    expect(game.lineWaiting(line, 0, 'freight')).toBe(32.5);
    game.setStopRule(line.id, 1, { ...DEFAULT_RULE, unload: ['oil'] });
    expect(game.lineFreightWaiting(line, 0)).toEqual([['oil', 6]]);
    expect(game.lineFreightWaiting(line, 2)).toEqual([['logs', 11]]);
    game.setStopRule(line.id, 2, { ...DEFAULT_RULE, load: [] });
    expect(game.lineFreightWaiting(line, 2)).toEqual([]);
    expect(sA.cargo).toEqual({ grain: 32.5, logs: 11, oil: 6 });
  });
});

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
    // Без машин — не больше предела станции; со временем упираются в него и не растут. Как скоро — по жителям в охвате
    // станции (в частных домах окраины их немного): ждём кусками по 5 с, но не дольше 10 минут.
    const cap = game.stationCap(sA, 'passengers');
    let steps = 0;
    while (waitingPax(sA) < cap && steps < 120) {
      runSeconds(game, 5);
      steps++;
      expect(waitingPax(sA)).toBeLessThanOrEqual(cap);
    }
    expect(waitingPax(sA)).toBe(cap);
    runSeconds(game, 30);
    expect(waitingPax(sA)).toBe(cap);

    // Детерминизм: те же действия — те же пассажиры.
    const again = twoTowns(true);
    runSeconds(again.game, 15);
    for (let k = 0; k < steps; k++) runSeconds(again.game, 5);
    runSeconds(again.game, 30);
    expect([...again.sA.passengers]).toEqual([...sA.passengers]);
    expect([...again.sB.passengers]).toEqual([...sB.passengers]);
  });

  it('грузовой маршрут без грузовиков: продукция фермы идёт на станцию, пассажиров не ждут', () => {
    const plain = withoutCitizens(freshGame(7));
    const { a, b } = nearestPair(plain, 'farm', 'foodplant');
    const alone = stationAtIndustry(plain, a, b.fp.center)!;
    runSeconds(plain, MONTH_LENGTH);
    // Станция без маршрута — ферма стоит, на станцию ничего не кладёт.
    expect(alone.cargo.grain ?? 0).toBe(0);
    expect(plain.industries.find((i) => i.id === a.id)!.producedMonth).toBe(0);

    const game = withoutCitizens(freshGame(7));
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
    const game = withoutCitizens(freshGame(7));
    const { line, sA } = freightRoute(game);
    runSeconds(game, MONTH_LENGTH);
    const had = sA.cargo.grain ?? 0;
    expect(had).toBeGreaterThan(0);
    game.deleteLine(line.id);
    runSeconds(game, MONTH_LENGTH);
    expect(sA.cargo.grain ?? 0).toBe(had);
  });

  it('местное зерно с неподходящей станции переходит на маршрут вывоза по мере освобождения склада', () => {
    const game = withoutCitizens(freshGame(7));
    const { built, line, sA, sB, from, to } = freightRoute(game);
    expect(built).toBe(true);
    const old = stationAtIndustry(game, from, to.fp.center)!;
    expect(old.industryIds).toContain(from.id);
    const inbound = game.createLine([sB.id, old.id])!;
    // У этой линии есть грузовые остановки, но она не забирает зерно с old.
    game.setStopRule(inbound.id, 0, { wait: 'none', maxWait: null, load: 'auto', unload: ['food'] });
    old.cargo.grain = 30;
    from.output = 5;
    const produce = () => (game as unknown as { updateIndustries(dt: number): void }).updateIndustries(0);

    produce();
    expect(sA.cargo.grain).toBe(20);
    expect(old.cargo.grain).toBe(10);
    expect(from.output).toBe(5);
    const truck = game.buyVehicle(line.id, 'truck')!;
    expect(truck.cargo).toBe('grain');
    expect(truck.amount).toBe(16);
    expect(truck.loadedAt).toBe(sA.id);
    produce();
    expect(old.cargo.grain).toBe(0);
    expect(sA.cargo.grain).toBe(19);
    expect(from.output).toBe(0);

    // Запас, реально выгруженный другой линией, остаётся на её складе для обычной перевалки.
    old.cargo.grain = 7;
    old.cargoOrigin = { grain: sB.id };
    produce();
    expect(old.cargo.grain).toBe(7);
    expect(old.cargoOrigin.grain).toBe(sB.id);
  });

  it('явная выгрузка зерна на склад остаётся подходящим маршрутом для фермы', () => {
    const game = withoutCitizens(freshGame(7));
    const { line, sA, sB, from } = freightRoute(game);
    sB.accepts.delete('grain');
    game.setStopRule(line.id, 1, { wait: 'none', maxWait: null, load: 'auto', unload: ['grain'] });
    from.output = 4;

    (game as unknown as { updateIndustries(dt: number): void }).updateIndustries(0);

    expect(sA.cargo.grain).toBe(4);
    expect(from.output).toBe(0);
  });
});
