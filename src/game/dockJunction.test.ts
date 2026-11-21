import { describe, expect, it } from 'vitest';
import { syncWalks } from '../lanes/crosswalk';
import { LaneNet, yardLanes } from '../lanes/model';
import type { TownBuilding } from '../world/entities';
import { DEFAULT_SETTINGS } from '../world/settings';
import { freshGame } from './testkit';
import { MODELS, type RoadModel } from './transport';

const truck = (MODELS.truck as RoadModel).spec;

function street(junction?: number): LaneNet {
  const net = new LaneNet();
  const west = net.addSeam({ x: 0, y: 0 }, { x: 1, y: 0 });
  const east = net.addSeam({ x: 280, y: 0 }, { x: 1, y: 0 });
  const profile = { cls: 'street' as const, lanes: yardLanes() };
  if (junction === undefined) net.addCorridor(west.id, east.id, profile);
  else {
    const j = net.addJunction({ x: junction, y: 0 });
    const side = net.addSeam({ x: junction, y: -85 }, { x: 0, y: 1 });
    net.addCorridor(west.id, j.id, profile);
    net.addCorridor(j.id, east.id, profile);
    net.addCorridor(j.id, side.id, profile);
    syncWalks(net, j, () => true);
  }
  return net;
}

function scene() {
  const game = freshGame({ ...DEFAULT_SETTINGS, seed: 7, retail: true });
  const town = game.towns.find((t) => t.receivers?.length)!;
  const base: TownBuilding = {
    type: 'building', kind: 'com', form: 'depot', floors: 4, id: 90_000, townId: town.id, anchor: 1,
    face: -1, fp: { center: { x: 96, y: 33 }, w: 61, h: 48, angle: 0 }, color: '#aaa', roof: '#888',
  };
  town.buildings.push(base);
  town.receivers!.push({ ...town.receivers![0], b: base.id, depot: true });
  game.index.add(base);
  game.roads.replace(street());
  return { game, base };
}

describe('Разгрузка рядом с новым городским перекрёстком', () => {
  it('у близкой зебры грузовик встаёт на полосу до стоп-линии', () => {
    const { game, base } = scene();
    game.roads.replace(street(150));
    const yard = game.docks.geoOf(base, truck.length, truck.width)!;
    const out = yard.out!;
    const stop = game.roads.graph.stopBack.get(out.lane.id)!;
    expect(stop).toBeGreaterThan(0);
    expect(out.zone[1]).toBeLessThanOrEqual(out.lane.length - stop + 1e-6);
    expect(out.zone[1]).toBeGreaterThan(out.lane.length - 10);
    expect(game.docks.route(yard.in!.link.fromNode!, base, truck.length, truck.width)).toEqual([yard.in!.link.id]);
  });

  it('находит полосу у выезда, когда въезд и выезд с разных сторон перекрёстка', () => {
    const { game, base } = scene();
    game.roads.replace(street(96));
    const yard = game.docks.geoOf(base, truck.length, truck.width)!;
    expect(yard.in).toBeTruthy();
    expect(yard.out).toBeTruthy();
    expect(yard.out!.lane.link).not.toBe(yard.in!.link.id);
  });

  it('рост разрешает подходящий перекрёсток и отклоняет вариант, перекрывающий ворота', () => {
    const { game, base } = scene();
    const growth = game as unknown as { growthKeepsDockAccess(next: LaneNet, ends: { x: number; y: number }[]): boolean };
    expect(game.docks.reachable(base, truck.length, truck.width)).toBe(true);
    expect(growth.growthKeepsDockAccess(street(150), [{ x: 150, y: 0 }])).toBe(true);
    expect(growth.growthKeepsDockAccess(street(122), [{ x: 122, y: 0 }])).toBe(false);
  });
});
