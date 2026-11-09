import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import type { Station } from '../world/entities';
import { FIRST_RUN, firstRunWaits } from './firstRun';
import { Game } from './game';
import { connectStations, HIGHWAY, townStreets, withoutCitizens } from './testkit';
import { DEFAULT_RULE, type FleetVehicle, vehicleLoad } from './transport';

describe('Первый рейс маршрута: ждать ли пассажиров', () => {
  it('ждёт, пока не займёт половину мест и не выйдет предел, если пассажиры подходят', () => {
    expect(firstRunWaits(0, 0, 30, 0.6)).toBe(true);
    expect(firstRunWaits(10, 14, 30, 0.6)).toBe(true);
    expect(firstRunWaits(FIRST_RUN.maxWait - 1, 0, 30, 2)).toBe(true);
  });

  it('половина мест занята — едет', () => {
    expect(firstRunWaits(0, 15, 30, 0.6)).toBe(false);
    expect(firstRunWaits(0, 30, 30, 0.6)).toBe(false);
  });

  it('предел ожидания вышел — едет, сколько бы ни было в салоне', () => {
    expect(firstRunWaits(FIRST_RUN.maxWait, 0, 30, 5)).toBe(false);
    expect(firstRunWaits(FIRST_RUN.maxWait + 3, 2, 30, 5)).toBe(false);
  });

  it('до предела не подойдёт ни один пассажир — не ждёт совсем', () => {
    expect(firstRunWaits(0, 0, 30, 0)).toBe(false);
    expect(firstRunWaits(0, 0, 30, 0.9 / FIRST_RUN.maxWait)).toBe(false);
    expect(firstRunWaits(FIRST_RUN.maxWait - 2, 0, 30, 0.4)).toBe(false);
    expect(firstRunWaits(0, 0, 0, 1)).toBe(false);
  });
});

/** Станция у улицы города — на той, что ближе к соседнему городу toward. */
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

/** Автобусная линия между двумя ближними большими городами мира 7: станции в обоих, шоссе между ними. */
function intercityLine() {
  const game = withoutCitizens(new Game(7));
  game.money = 5_000_000;
  const [a, ...rest] = [...game.towns].sort((x, y) => y.population - x.population);
  const b = rest.sort((x, y) => dist(x.center, a.center) - dist(y.center, a.center))[0];
  const sA = stationIn(game, a.id, b.center);
  const sB = stationIn(game, b.id, a.center);
  expect(connectStations(game, sA, sB, HIGHWAY)).toBe(true);
  const line = game.createLine([sA.id, sB.id])!;
  return { game, line, sA, sB };
}

/** Игра вперёд, пока автобус не уедет с первой станции: сколько секунд прошло и сколько пассажиров увёз. */
function firstDeparture(game: Game, v: FleetVehicle): { t: number; load: number } {
  game.speed = 1;
  let t = 0;
  while (v.state !== 'driving' && t < 120) {
    game.update(0.1);
    t += 0.1;
  }
  expect(v.state).toBe('driving');
  return { t, load: vehicleLoad(v) };
}

describe('Первый автобус новой линии между городами', { timeout: 60_000 }, () => {
  it('раньше уезжал пустым, теперь ждёт первых пассажиров и увозит их', () => {
    // Как было: «авто» на остановке пассажиров не ждёт — то же, что «не ждать». Автобус сажает всех в миг
    // покупки, когда на остановке ещё никого, и через 5 с уезжает пустым; подошедшие остаются ждать.
    const before = intercityLine();
    before.game.setStopRule(before.line.id, 0, { ...DEFAULT_RULE, wait: 'none' });
    const old = before.game.buyVehicle(before.line.id, 'bus')!;
    expect(before.sA.passengers.size).toBe(0);
    const was = firstDeparture(before.game, old);
    expect(was.load).toBe(0);
    expect(was.t).toBeLessThan(6);
    expect([...before.sA.passengers.values()].reduce((s, n) => s + n, 0)).toBeGreaterThan(0);

    // Теперь (условие «авто»): ждёт на первой станции, сажая подходящих, — до половины мест или 20 с.
    const after = intercityLine();
    const bus = after.game.buyVehicle(after.line.id, 'bus')!;
    expect(after.sA.passengers.size).toBe(0);
    const now = firstDeparture(after.game, bus);
    expect(now.load).toBeGreaterThanOrEqual(10);
    expect(now.load).toBeLessThanOrEqual(15);
    // Без подарка: не больше, чем подошло за это время (жители станции дают 1.2 пассажира в секунду на тысячу).
    expect(now.load).toBeLessThanOrEqual(Math.ceil((after.sA.catchPop / 1000) * 1.2 * now.t));
    // И недолго: 5 с посадки, затем не дольше предела ожидания (проверки — раз в секунду и дольше на посадку).
    expect(now.t).toBeLessThan(5 + FIRST_RUN.maxWait * 1.4);
    // Записано в журнал: «go» — с пассажирами.
    const go = after.game.journal.entries.find((e) => e.k === 'go' && e.v === bus.id);
    expect(go?.load).toBe(now.load);
  });

  it('линия уже возит — новый автобус не ждёт; все проданы и куплен новый — снова ждёт', () => {
    const { game, line, sA } = intercityLine();
    const first = game.buyVehicle(line.id, 'bus')!;
    firstDeparture(game, first);
    // Вторая машина на работающей линии уходит как обычно — после посадки, без ожидания первых пассажиров.
    const second = game.buyVehicle(line.id, 'bus')!;
    const usual = firstDeparture(game, second).t;
    expect(usual).toBeLessThan(10);
    // Маршрут остался без машин — пассажиры ждут дальше (маршрут-то есть); новый автобус — снова первый рейс.
    game.sellVehicle(first.id);
    game.sellVehicle(second.id);
    game.update(0.1);
    // Ждущих на станции — меньше половины автобуса (иначе он и так уехал бы полным после посадки): у станции
    // с большим охватом их успевает набраться больше, поэтому начинаем с пустой.
    sA.passengers.clear();
    const again = game.buyVehicle(line.id, 'bus')!;
    const run = firstDeparture(game, again);
    // Ждёт дольше обычной посадки — пока не займёт половину мест.
    expect(run.t).toBeGreaterThan(usual + 1);
    expect(run.load).toBeGreaterThanOrEqual(10);
  });
});
