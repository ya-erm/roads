import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH } from '../config';
import { dist } from '../core/vec';
import { adviceTip } from './stationWarnings';
import type { Station } from '../world/entities';
import { advise } from './advisor';
import { Game } from './game';
import { PAX_WAIT, paxGone, paxGoneTo, paxLeaving, paxPatience, paxStayShare, paxTolerance } from './paxPatience';
import { connectStations, HIGHWAY, runSeconds, townStreets, withoutCitizens } from './testkit';

describe('Терпение пассажиров: правило', () => {
  it('ждать готовы тем дольше, чем дальше ехать: 300 м — около минуты, 3 км — 6 мин, дальше 10 км — не дольше 20 мин', () => {
    expect(paxPatience(0)).toBe(PAX_WAIT.base);
    expect(paxPatience(300)).toBeCloseTo(76);
    expect(paxPatience(1000)).toBeCloseTo(160);
    expect(paxPatience(3000)).toBeCloseTo(400);
    expect(paxPatience(15_000)).toBe(PAX_WAIT.max);
    expect(paxPatience(2000)).toBeGreaterThan(paxPatience(1000));
  });

  it('остаются, кого увезут машины за терпение, но не меньше одной машины', () => {
    // 20 мест раз в 50 с, терпение 150 с — увезут троих машинами: 60 человек.
    expect(paxTolerance(20, 50, 150)).toBe(60);
    // Автобус раз в 10 мин: ближний всё равно ждёт, если влезет в первый.
    expect(paxTolerance(20, 600, 80)).toBe(20);
    expect(paxTolerance(0, 50, 150)).toBe(0);
  });

  it('уходят из хвоста: доля сверх терпения, понемногу', () => {
    expect(paxStayShare(30, 20)).toBe(1);
    expect(paxStayShare(30, 60)).toBe(0.5);
    expect(paxLeaving(40, 1, 1)).toBe(0);
    // Половина лишняя — уходят 20 за leaveTime: за секунду — 2.
    expect(paxLeaving(40, 0.5, 1)).toBeCloseTo((40 * 0.5) / PAX_WAIT.leaveTime);
    expect(paxLeaving(5, 0, 100)).toBe(5);
  });

  it('ушедших показываем за этот месяц или прошлый — что больше', () => {
    const st = { paxGone: { 1: 3, 2: 4 }, paxGoneLast: { 1: 10 } };
    expect(paxGone(st)).toBe(10);
    expect(paxGoneTo(st, 2)).toBe(4);
    expect(paxGoneTo(st, 1)).toBe(10);
    expect(paxGone({})).toBe(0);
  });
});

/** Станция у улицы города townId — на той, что ближе к точке toward. */
function stationIn(game: Game, townId: number, toward: { x: number; y: number }, skip: Station[] = []): Station {
  const mid = (c: ReturnType<typeof townStreets>[number]) => c.lut.pointAt(c.length / 2);
  const streets = townStreets(game, townId).sort((a, b) => dist(mid(a), toward) - dist(mid(b), toward));
  for (const seg of streets) {
    const p = mid(seg);
    if (skip.some((s) => dist(s.fp.center, p) < 250)) continue;
    const t = seg.lut.tangentAt(seg.length / 2);
    for (const side of [1, -1]) {
      const st = game.placeStation({ x: p.x - t.y * side * 40, y: p.y + t.x * side * 40 }, 14);
      if (st) return st;
    }
  }
  throw new Error(`Не поставить станцию в городе ${townId}`);
}

/**
 * Большой город мира 7: станция home, соседняя в том же городе near (сотни метров) и far в соседнем городе (км),
 * маршрут home → near → far с одним автобусом — машин мало, пассажиров много.
 */
function crowdedLine(buses = 2) {
  const game = withoutCitizens(new Game(7));
  game.money = 5_000_000;
  const [a, ...rest] = [...game.towns].filter((t) => !t.labelOnly).sort((x, y) => y.population - x.population);
  // Соседний город за 2.5 км и дальше: туда ждут дольше, чем идёт автобус.
  const b = rest.filter((t) => dist(t.center, a.center) > 2500).sort((x, y) => dist(x.center, a.center) - dist(y.center, a.center))[0];
  const home = stationIn(game, a.id, b.center);
  const near = stationIn(game, a.id, home.fp.center, [home]);
  const far = stationIn(game, b.id, a.center);
  expect(connectStations(game, home, far, HIGHWAY)).toBe(true);
  const line = game.createLine([home.id, near.id, far.id])!;
  for (let i = 0; i < buses; i++) expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
  return { game, line, home, near, far };
}

const waitingAt = (st: Station) => [...st.passengers.values()].reduce((s, n) => s + n, 0);

describe('Терпение пассажиров в игре', { timeout: 120_000 }, () => {
  it('очередь не растёт до предела станции: лишние уходят, ближние — первыми; ушедших видно и советнику', () => {
    const { game, line, home, near, far } = crowdedLine();
    expect(dist(home.fp.center, near.fp.center)).toBeLessThan(dist(home.fp.center, far.fp.center) / 2);
    let most = 0;
    runSeconds(game, MONTH_LENGTH * 8, () => (most = Math.max(most, waitingAt(home))));
    const cap = game.stationCap(home, 'passengers');
    const q = game.paxQueue(line, home)!;
    expect(q.headway).toBeGreaterThan(0);
    // Раньше очередь упиралась в предел станции (две вместимости парка); теперь — около мест, что увезут за терпение.
    expect(most).toBeLessThan(cap);
    const tolerated = paxTolerance(q.seats, q.headway, paxPatience(dist(home.fp.center, far.fp.center)));
    expect(waitingAt(home)).toBeLessThanOrEqual(Math.ceil(tolerated * 1.5) + 5);
    // Ушли, не дождавшись, — по направлениям; к ближней остановке — по доле больше, чем остались ждать.
    const goneNear = paxGoneTo(home, near.id);
    const goneFar = paxGoneTo(home, far.id);
    expect(goneNear + goneFar).toBeGreaterThan(0);
    const waitNear = home.passengers.get(near.id) ?? 0;
    const waitFar = home.passengers.get(far.id) ?? 0;
    expect(goneNear / Math.max(1, goneNear + goneFar)).toBeGreaterThan(waitNear / Math.max(1, waitNear + waitFar));
    // Ждут в основном те, кому ехать в другой город.
    expect(waitFar).toBeGreaterThan(waitNear);
    // Автобус по-прежнему уходит полным: в ближайший готов сесть каждый.
    expect(line.loadLast ?? 0).toBeGreaterThan(0.9);
    // Советник: «Пассажиры уходят» с числом ушедших и значком.
    const advice = advise(game).find((a) => a.kind === 'waiting' && a.station === home.id);
    expect(advice?.gone).toBeGreaterThan(0);
    expect(advice?.title).toBe('Пассажиры уходят');
    expect(adviceTip(advice!)).toContain('🚶');
    // Ушедшие переходят в итог прошлого месяца и сохраняются.
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const back = new Game(save.settings, save);
    expect(paxGone(back.stations.get(home.id)!)).toBe(paxGone(home));
    expect(paxGone(home)).toBeGreaterThan(0);
  });

  it('авто-парк видит ушедших как спрос, который линия не увезла, и докупает автобусы', () => {
    const { game, line } = crowdedLine(1);
    game.setLineAuto(line.id, { on: true, min: 1, max: 4 });
    runSeconds(game, MONTH_LENGTH * 10);
    expect(line.vehicles.length).toBeGreaterThan(1);
  });
});
