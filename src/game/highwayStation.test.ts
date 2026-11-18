import { describe, expect, it } from 'vitest';
import { twoWay } from '../lanes/model';
import { TERRAIN_VERSION } from '../world/settings';
import { Game, type RoadStationOptions } from './game';
import { fieldSpot, road, withoutCitizens } from './testkit';
import { DEFAULT_RULE } from './transport';

function scene(cls: 'highway' | 'motorway' = 'highway') {
  const game = withoutCitizens(new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 50_000_000, water: 'dry', terrainVersion: TERRAIN_VERSION }));
  const a = fieldSpot(game, 800);
  expect(road(game, { free: a }, { free: { x: a.x + 800, y: a.y } }, { cls, lanes: twoWay(2, 2) })).toBe(true);
  return { game, x: a.x, y: a.y };
}

describe('Автостанция у магистрали', () => {
  it.each<RoadStationOptions>([{}, { side: true }])('постройка и рейсы грузовика в обе стороны: %j', (options) => {
    const { game, x, y } = scene();
    const cargo = { pax: false, cargo: true };
    const place = (px: number, py: number) => game.placeStation({ x: px, y: py }, 14, 'road', cargo, 0, 2, undefined, false, options);
    const a = place(x + 200, y + 45)!;
    const b = place(x + 600, y - 45)!;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(game.roads.net.problems()).toEqual([]);
    const line = game.createLine([a.id, b.id])!;
    expect(line).toBeTruthy();
    for (const i of [0, 1]) game.setStopRule(line.id, i, { ...DEFAULT_RULE, wait: 'none', maxWait: null });
    const v = game.buyVehicle(line.id, 'truck')!;
    expect(v).toBeTruthy();
    const visited = new Set<number>();
    let drove = false;
    game.speed = 1;
    for (let t = 0; t < 300 && visited.size < 2; t += 0.1) {
      game.update(0.1);
      drove ||= v.state === 'driving';
      if (drove && v.enter) visited.add(line.stops[v.stop]);
    }
    expect([...visited].sort()).toEqual([a.id, b.id].sort());
    expect(line.problem).toBeNull();
  });

  it('выезд пристраивается прямо к перекрёстку магистрали', () => {
    const { game, x, y } = scene();
    expect(road(game, { x: x + 400, y }, { free: { x: x + 400, y: y - 150 } })).toBe(true);
    const junction = game.roads.net.nodesNear({ x: x + 400, y }, 1)[0];
    const p = { x: x + 400, y: y + 45 };
    const plan = game.stationPlan(p, 14);
    expect(plan.ok).toBe(true);
    expect(plan.from).toMatchObject({ kind: 'node', node: junction.id });
    expect(game.placeStation(p, 14)).toBeTruthy();
    expect(game.roads.net.problems()).toEqual([]);
  });

  it('прямой выезд к автомагистрали с разделителем по-прежнему не ставится', () => {
    const { game, x, y } = scene('motorway');
    const plan = game.stationPlan({ x: x + 400, y: y + 45 }, 14);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('К автомагистрали станцию не пристроить');
  });
});
