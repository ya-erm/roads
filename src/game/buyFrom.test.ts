import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import type { Station } from '../world/entities';
import { Game } from './game';
import { freshGame, runSeconds, townStreets } from './testkit';

/** Остановки на улицах крупнейшего города — не ближе minGap друг к другу. */
function placeStops(game: Game, count: number, minGap = 350): Station[] {
  const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
  const placed: Station[] = [];
  for (const seg of townStreets(game, town.id)) {
    if (placed.length >= count) break;
    if (seg.length < 80) continue;
    const p = seg.lut.pointAt(seg.length / 2);
    const t = seg.lut.tangentAt(seg.length / 2);
    const q = { x: p.x - t.y * 14, y: p.y + t.x * 14 };
    if (placed.some((s) => dist(s.fp.center, q) < minGap)) continue;
    const st = game.placeStation(q, 14, 'stop');
    if (st) placed.push(st);
  }
  return placed;
}

/** Городской автобусный маршрут по трём остановкам мира 7. */
function townLine() {
  const game = freshGame(7);
  game.money = 5_000_000;
  const stops = placeStops(game, 3);
  expect(stops).toHaveLength(3);
  const line = game.createLine(stops.map((s) => s.id))!;
  return { game, line, stops };
}

describe('Покупка автобуса на выбранную остановку маршрута', { timeout: 60_000 }, () => {
  it('автобус начинает работу с выбранной остановки сразу и едет дальше по маршруту', () => {
    const { game, line } = townLine();
    const money = game.money;
    const v = game.buyVehicle(line.id, 'bus', false, 2)!;
    expect(v).not.toBeNull();
    expect(game.money).toBeLessThan(money);
    expect(v.stop).toBe(2);
    expect(v.state).toBe('loading');
    // Уже в работе: в очередь новых машин на первой остановке не встаёт.
    expect(v.fresh).toBeUndefined();
    expect(game.journal.tail(5).find((e) => e.k === 'buy')).toMatchObject({ v: v.id, from: 2 });
    game.speed = 1;
    let t = 0;
    while (v.state !== 'driving' && t < 60) {
      game.update(0.1);
      t += 0.1;
    }
    expect(v.state).toBe('driving');
    // После третьей остановки — снова первая.
    expect(v.stop).toBe(0);
  });

  it('с другой остановки уезжает, не дожидаясь очереди за машинами с первой', () => {
    const { game, line } = townLine();
    game.setLineSpacing(line.id, true);
    game.buyVehicle(line.id, 'bus');
    game.buyVehicle(line.id, 'bus');
    const third = game.buyVehicle(line.id, 'bus')!;
    const mid = game.buyVehicle(line.id, 'bus', false, 1)!;
    expect(third.stop).toBe(0);
    expect(third.fresh).toBe(true);
    expect(mid.stop).toBe(1);
    // Третья с первой остановки ждёт своей очереди (интервала) — или ещё стоит, если маршрут длинный.
    let held = false;
    runSeconds(game, 20, () => {
      if (game.spacingLeft(third) !== null) held = true;
    });
    expect(mid.state).toBe('driving');
    expect(mid.stop).toBe(2);
    expect(held || third.state !== 'driving').toBe(true);
  });

  it('первая остановка или несуществующий номер — как обычная покупка', () => {
    const { game, line } = townLine();
    for (const from of [0, 3, -1, 1.5, Number.NaN]) {
      const v = game.buyVehicle(line.id, 'bus', false, from)!;
      expect(v.stop).toBe(0);
      expect(v.fresh).toBe(true);
    }
    expect(game.journal.tail(20).filter((e) => e.k === 'buy' && 'from' in e)).toHaveLength(0);
  });

  it('партия с таким автобусом сохраняется и открывается, а симуляция повторяется одинаково', () => {
    const play = () => {
      const { game, line } = townLine();
      game.buyVehicle(line.id, 'bus');
      game.buyVehicle(line.id, 'bus', false, 2);
      runSeconds(game, 30);
      return { game, line };
    };
    const a = play();
    const b = play();
    // Сохранения двух одинаковых партий совпадают — кроме времени записи.
    const saveOf = (g: Game) => JSON.stringify({ ...g.toSave(), savedAt: 0 });
    const save = saveOf(a.game);
    expect(saveOf(b.game) === save).toBe(true);
    const data = JSON.parse(save);
    const loaded = new Game(data.settings, data);
    expect(loaded.fleet.size).toBe(2);
    expect([...loaded.fleet.values()].map((v) => v.stop)).toEqual([...a.game.fleet.values()].map((v) => v.stop));
    runSeconds(loaded, 30);
    expect(loaded.lines.get(a.line.id)!.problem).toBeNull();
  });
});
