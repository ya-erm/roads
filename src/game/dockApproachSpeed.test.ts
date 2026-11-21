import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { LaneNet, twoWay } from '../lanes/model';
import { ROLL_BRAKE } from '../lanes/traffic';
import type { TownBuilding } from '../world/entities';
import { freshGame, withoutCitizens } from './testkit';
import { MODELS, type RoadModel } from './transport';

const truck = (MODELS.truck as RoadModel).spec;

describe('Скорость грузовика перед поворотом во двор', () => {
  it.each([false, true])('тормозит к въезду на свободной улице, короткая последняя связь: %s', (shortLink) => {
    const game = withoutCitizens(freshGame(7));
    const net = new LaneNet();
    const east = { x: 1, y: 0 };
    const a = net.addSeam({ x: 0, y: 0 }, east);
    const b = net.addSeam({ x: 600, y: 0 }, east);
    const profile = { cls: 'street' as const, lanes: twoWay(1, 1), ...(shortLink ? { limit: 60 } : {}) };
    const seam = shortLink ? net.addSeam({ x: 289, y: 0 }, east) : null;
    net.addCorridor(a.id, seam?.id ?? b.id, profile);
    if (seam) net.addCorridor(seam.id, b.id, profile);
    game.roads.replace(net);
    const shop: TownBuilding = {
      type: 'building', kind: 'com', form: 'depot', floors: 4, id: 90_001, townId: game.towns[0].id, anchor: a.id,
      face: -1, fp: { center: { x: 330, y: 35 }, w: 61, h: 48, angle: 0 }, color: '#aaa', roof: '#888',
    };
    const slot = game.docks.geoOf(shop, truck.length, truck.width)?.in;
    expect(slot).toBeTruthy();
    const route = game.docks.route(a.id, shop, truck.length, truck.width)!;
    expect(route).toHaveLength(shortLink ? 2 : 1);
    const sim = game.traffic.spawn({ ...truck, route, targetNode: b.id })!;
    expect(game.docks.approach(sim, 1, shop)).toBe(true);
    const inset = slot!.lane.length - slot!.mid - sim.length / 2;
    let cruise = 0;
    let turnSpeed = 0;
    let maxBrake = 0;
    let brakingBeforeLink = false;
    for (let t = 0; t < 40 && !game.docks.entering(1); t += SIM_DT) {
      const prev = sim.v;
      game.traffic.step(SIM_DT);
      const left = game.traffic.routeLeft(sim) - inset;
      if (left > 60 && left < 75) cruise = Math.max(cruise, sim.v);
      if (left < 80) maxBrake = Math.max(maxBrake, (prev - sim.v) / SIM_DT);
      if (sim.routeIndex === 0 && left < 80 && prev - sim.v > SIM_DT) brakingBeforeLink = true;
      turnSpeed = sim.v;
      game.docks.step(SIM_DT);
    }
    expect(game.docks.entering(1)).toBe(true);
    expect(cruise).toBeGreaterThan(0.9 * Math.min(slot!.lane.speed, truck.maxSpeed));
    expect(turnSpeed).toBeGreaterThan(2);
    expect(turnSpeed).toBeLessThan(7);
    expect(maxBrake).toBeLessThan(ROLL_BRAKE * 1.3);
    if (shortLink) expect(brakingBeforeLink).toBe(true);
  });
});
