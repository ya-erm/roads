import { expect, it } from 'vitest';
import { add } from '../core/vec';
import { parkParts } from '../render/parkArt';
import type { TownPark } from '../world/entities';
import { parkToWorld } from '../world/parkParts';
import { Game } from './game';
import { freshGame, openSpot, road } from './testkit';

function fixture() {
  const game = freshGame({ seed: 11, towns: 2, industries: 'few', size: 'small', water: 'dry', money: 500_000 });
  const center = openSpot(game, [[{ x: -50, y: 0 }, { x: 125, y: 0 }, 80]]);
  const park: TownPark = { id: 92345, kind: 'park', fp: { center, w: 80, h: 48, angle: 0 } };
  const town = game.towns[0];
  town.parks = [...town.parks ?? [], park];
  return { game, park, at: (x: number, y: number) => add(center, { x, y }) };
}

it('старый парк сохраняет зерно; перемещение и удаление его предметов, декор вне парка, сохранение и отмена', () => {
  const { game, park, at } = fixture();
  const tree = parkParts(park).objects.find(o => o.kind === 'tree')!;
  const origin = parkToWorld(park, tree.pos);
  expect(game.parkObjectAt(origin)?.object.id).toBe(tree.id);
  const outside = at(75, 0);
  expect(game.moveParkObject(park.id, tree.id, outside, Math.PI / 4)).toBeNull();
  expect(parkParts(park).objects.some(o => o.id === tree.id)).toBe(false);
  expect(game.parkObjectAt(outside)).toMatchObject({ park: null, object: { kind: 'tree', angle: Math.PI / 4 } });
  expect(game.placeParkObject(null, 'bench', outside)).toContain('Мешает');
  const save = game.toSave();
  const loaded = new Game(save.settings, JSON.parse(JSON.stringify(save)));
  const moved = loaded.parkObjectAt(outside)!.object;
  expect(loaded.removeParkObject(null, moved.id)).toBeNull();
  expect(loaded.parkObjectAt(outside)).toBeNull();
  expect(loaded.undo()).toBeTruthy();
  expect(loaded.parkObjectAt(outside)?.object).toEqual(moved);
  expect(game.undo()).toBeTruthy();
  expect(park.edits).toBeUndefined();
  expect(game.parkObjectAt(origin)?.object.id).toBe(tree.id);
  expect(game.redo()).toBeTruthy();
  expect(game.parkObjectAt(outside)?.object.kind).toBe('tree');
});

it('новые предметы и кривые внутри участка хранятся локально и поворачиваются вместе с парком', () => {
  const { game, park, at } = fixture();
  park.edits = { paths: [], objects: [] };
  expect(game.placeParkObject(park.id, 'kiosk', at(-15, 8), 0.4)).toBeNull();
  const a = at(-20, -10), b = at(20, -10);
  const shape = { kind: 'curve' as const, c1: at(-10, 1), c2: at(10, -16) };
  expect(game.buildFootpath(a, b, shape)).toBeNull();
  const path = game.parkFootpaths(park)[0];
  expect(path).toMatchObject({ a, b, shape, parkId: park.id });
  expect(game.footpaths).toEqual([]);
  expect(game.parkObjectPlan(park.id, 'pond', a).reason).toContain('дорожка');
  expect(game.footpathPlan(at(-25, 8), at(0, 8)).reason).toContain('предмет');
  // Меняем позу участка как при movePark или переносе площади вместе с ратушей.
  park.fp = { ...park.fp, center: at(10, 4), angle: Math.PI / 2 };
  expect(game.parkFootpaths(park)[0]).toMatchObject({ id: path.id, a: parkToWorld(park, { x: -20, y: -10 }) });
  const kiosk = parkToWorld(park, { x: -15, y: 8 });
  expect(game.parkObjectAt(kiosk)?.object.angle).toBeCloseTo(0.4 + Math.PI / 2);
  const save = game.toSave();
  const loaded = new Game(save.settings, JSON.parse(JSON.stringify(save)));
  expect(loaded.parkFootpaths(loaded.parkById(park.id)!.park)).toEqual(game.parkFootpaths(park));
});

it('автодорога закрывает парковую дорожку; снос самой дорожки обратим', () => {
  const { game, park, at } = fixture();
  park.edits = { paths: [], objects: [] };
  expect(game.buildFootpath(at(-28, 0), at(28, 0))).toBeNull();
  const [path] = game.openParkFootpaths(park);
  expect(path).toBeTruthy();
  expect(road(game, { free: at(0, -45) }, { free: at(0, 45) })).toBe(true);
  expect(game.openParkFootpaths(park)).toEqual([]);
  game.checkpoint('снос дорожки');
  game.removeFootpaths([path]);
  game.commit();
  expect(game.parkFootpaths(park)).toEqual([]);
  expect(game.undo()).toBeTruthy();
  expect(game.parkFootpaths(park)[0].id).toBe(path.id);
});
