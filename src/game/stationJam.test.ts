import { describe, expect, it } from 'vitest';
import { Game } from './game';
import { type Approach, JAM_DELAY, JAM_REACH, jamShown, nextJam, queuedAt } from './stationJam';
import { fieldSpot, road, withoutCitizens } from './testkit';
import { DEFAULT_RULE } from './transport';

const at = (station: number, o: Partial<Approach> = {}): Approach => ({ station, line: 1, blocked: false, stopped: false, dist: 50, ...o });

describe('Очередь на въезд: кто ждёт', () => {
  it('та, которой не дали поста, и стоящие за ней на подъезде; едущие и дальние — нет', () => {
    const list = [
      at(7, { blocked: true, dist: 0 }),
      at(7, { stopped: true, dist: 30, line: 2 }),
      at(7, { stopped: true, dist: JAM_REACH + 1 }),
      at(7, { stopped: false, dist: 40 }),
      at(8, { blocked: true }),
    ];
    const q = queuedAt(list, 7);
    expect(q).toHaveLength(2);
    expect(q.map((a) => a.line)).toEqual([1, 2]);
  });

  it('никому не отказали — очереди нет, сколько бы машин ни стояло у въезда (светофор, пробка)', () => {
    expect(queuedAt([at(7, { stopped: true, dist: 5 }), at(7, { stopped: true, dist: 20 })], 7)).toEqual([]);
  });
});

describe('Очередь на въезд: когда предупреждать', () => {
  const q = [at(7, { blocked: true }), at(7, { stopped: true, line: 3 }), at(7, { stopped: true, line: 3 })];

  it('держится с первого замера; линии — без повторов', () => {
    const a = nextJam(undefined, true, q, 100)!;
    expect(a).toEqual({ since: 100, waiting: 3, lines: [1, 3] });
    const b = nextJam(a, true, q.slice(0, 2), 104)!;
    expect(b.since).toBe(100);
    expect(b.waiting).toBe(2);
  });

  it('посты освободились или ждать некому — очередь сброшена и отсчёт пойдёт заново', () => {
    const a = nextJam(undefined, true, q, 100);
    expect(nextJam(a, false, q, 101)).toBeUndefined();
    expect(nextJam(a, true, [], 101)).toBeUndefined();
    expect(nextJam(undefined, true, q, 130)!.since).toBe(130);
  });

  it('короткое заполнение не показываем: только после JAM_DELAY секунд', () => {
    const a = nextJam(undefined, true, q, 100);
    expect(jamShown(a, 100 + JAM_DELAY - 1)).toBe(false);
    expect(jamShown(a, 100 + JAM_DELAY)).toBe(true);
    expect(jamShown(undefined, 1000)).toBe(false);
  });
});

describe('Очередь на въезд в игре', { timeout: 60_000 }, () => {
  it('все посты заняты автобусами, остальные ждут у въезда — станция и маршрут предупреждают; пост добавили — очередь ушла', () => {
    const game = withoutCitizens(new Game(42));
    game.money = 5_000_000;
    const a = fieldSpot(game, 500);
    expect(road(game, { free: a }, { free: { x: a.x + 500, y: a.y } })).toBe(true);
    const sA = game.placeStation({ x: a.x + 120, y: a.y - 30 }, 14)!;
    const sB = game.placeStation({ x: a.x + 380, y: a.y - 30 }, 14)!;
    const line = game.createLine([sA.id, sB.id])!;
    // На второй станции ждут полной загрузки, а пассажиров в поле нет: занявшие посты стоят там всё время.
    game.setStopRule(line.id, 1, { ...DEFAULT_RULE, wait: 'full', maxWait: null });
    for (let i = 0; i < sB.bays + 2; i++) expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    game.speed = 1;
    let firstSeen: number | null = null;
    let queueSince: number | null = null;
    for (let t = 0; t < 240 && firstSeen === null; t += 0.1) {
      game.update(0.1);
      if (queueSince === null && sB.occupied.length >= sB.bays && [...game.fleet.values()].some((v) => game.bayWait(v) > 0)) queueSince = game.time;
      if (game.stationJam(sB) > 0) firstSeen = game.time;
    }
    expect(sB.occupied).toHaveLength(sB.bays);
    expect(queueSince).not.toBeNull();
    expect(firstSeen).not.toBeNull();
    // Не сразу, а когда очередь продержалась порог.
    expect(firstSeen! - queueSince!).toBeGreaterThanOrEqual(JAM_DELAY - 1);
    // Ждут двое: одной не дали поста, другая стоит за ней.
    expect(game.stationJam(sB)).toBe(2);
    expect(game.stationJam(sA)).toBe(0);
    expect(game.lineJams(line)).toEqual([{ station: sB, waiting: 2 }]);
    // Постов хватает всем — предупреждение пропало.
    expect(game.setStationBays(sB.id, sB.bays + 2)).toBeNull();
    for (let t = 0; t < 40; t += 0.1) game.update(0.1);
    expect(game.stationJam(sB)).toBe(0);
    expect(game.lineJams(line)).toEqual([]);
  });
});
