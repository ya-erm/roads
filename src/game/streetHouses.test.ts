import { describe, expect, it } from 'vitest';
import { add, dist, dot, rightNormal, sub, type Vec } from '../core/vec';
import { splitCorridor } from '../lanes/edit';
import type { Corridor } from '../lanes/model';
import type { TownBuilding } from '../world/entities';
import { LOT_SETBACK } from '../world/houseAccess';
import { footprintsOverlap, type Footprint } from '../world/spatial';
import { halfAtS } from '../world/worldgen';
import type { Game } from './game';
import { MoveProject } from './moveProject';
import { moveNodeEdit } from './roadbuild';
import { fieldSpot, freshGame, road, withoutCitizens } from './testkit';

const LENGTH = 300;

function scene(construction: 'build' | 'instant' = 'instant') {
  const game = withoutCitizens(freshGame({ seed: 11, size: 'medium', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction }));
  const at = fieldSpot(game, LENGTH);
  const end = add(at, { x: LENGTH, y: 0 });
  expect(road(game, { free: at }, { free: end })).toBe(true);
  const street = game.roads.net.corridorNear(add(at, { x: LENGTH / 2, y: 0 }), 2)!;
  return { game, at, end, street };
}

function building(game: Game, fp: Footprint, spec: Partial<TownBuilding> = {}): TownBuilding {
  const town = game.towns[0];
  const b: TownBuilding = {
    type: 'building',
    id: game.nextId(),
    townId: town.id,
    kind: 'res',
    floors: 1,
    fp,
    color: '#ebcfb2',
    roof: '#965269',
    anchor: 0,
    ...spec,
  };
  town.buildings.push(b);
  game.index.add(b);
  return b;
}

function beside(game: Game, street: Corridor, s: number, side: 1 | -1) {
  const point = street.lut.pointAt(s);
  const depth = 28;
  const gap = halfAtS(street, s) + LOT_SETBACK + depth / 2;
  return building(game, { center: add(point, { x: 0, y: side * gap }), w: 34, h: depth, angle: 0 }, { anchor: street.a, face: side === 1 ? -1 : 1 });
}

function translate({ game, at, end, street }: ReturnType<typeof scene>, by: Vec) {
  return game.roadBuilder.plan((net) => {
    net.moveNode(street.a, add(at, by));
    net.moveNode(street.b, add(end, by));
  }, { rebuild: true });
}

describe('Дома у переносимой улицы', () => {
  it('сохраняет дома с обеих сторон, даже если новая дорога проходит через прежний участок, и отменяется одним шагом', () => {
    const layout = scene();
    const { game, at, street } = layout;
    const left = beside(game, street, 92, -1);
    const right = beside(game, street, 170, 1);
    expect(road(game, { free: add(at, { x: 0, y: -93 }) }, { free: add(at, { x: LENGTH, y: -93 }) })).toBe(true);
    const neighbor = game.roads.net.corridorNear(add(at, { x: LENGTH / 2, y: -93 }), 2)!;
    const other = beside(game, neighbor, 170, 1);
    const secondRow = building(game, { ...right.fp, center: add(right.fp.center, { x: 0, y: 80 }) }, { rear: true, face: -1 });
    const before = [left, right, other, secondRow].map((b) => b.fp.center);
    const by = { x: 0, y: 24 };
    const plan = translate(layout, by);
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.houseMoves?.map((m) => m.id).sort()).toEqual([left.id, right.id].sort());
    expect(plan.demolish).toEqual([]);
    expect(left.fp.center).toBe(before[0]);
    game.checkpoint('перенос улицы');
    expect(game.roadBuilder.apply(plan)).toBe(true);
    game.commit();
    expect(game.buildingById(right.id)).toBe(right);
    expect(dist(left.fp.center, add(before[0], by))).toBeCloseTo(0, 3);
    expect(dist(right.fp.center, add(before[1], by))).toBeCloseTo(0, 3);
    expect(left.face).toBe(1);
    expect(right.face).toBe(-1);
    expect(other.fp.center).toBe(before[2]);
    expect(secondRow.fp.center).toBe(before[3]);
    expect(game.undo()).toBe('перенос улицы');
    expect(game.buildingById(left.id)!.fp.center).toEqual(before[0]);
    expect(game.buildingById(right.id)!.fp.center).toEqual(before[1]);
    expect(game.redo()).toBe('перенос улицы');
    expect(dist(game.buildingById(right.id)!.fp.center, add(before[1], by))).toBeCloseTo(0, 3);
  });

  it('проект поворачивает фасад по новой улице и переносит дом на её появившийся после разреза участок', () => {
    const { game, street, end } = scene();
    const b = beside(game, street, 185, -1);
    const old = b.fp;
    const project = new MoveProject(() => game);
    expect(project.add(moveNodeEdit(street.b, add(end, { x: 0, y: 90 })))).toBeNull();
    expect(project.add((net) => {
      const current = net.corridor(street.id);
      splitCorridor(net, current, current.length * 0.4, 'seam');
    })).toBeNull();
    const plan = project.plan();
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.houseMoves).toHaveLength(1);
    expect(b.fp).toBe(old);
    expect(project.build()).toBeNull();
    const current = game.roads.net.corridorNear(b.fp.center, 50)!;
    const hit = current.lut.closest(b.fp.center);
    const tangent = current.lut.tangentAt(hit.s);
    expect(b.fp.angle).toBeCloseTo(Math.atan2(tangent.y, tangent.x));
    expect(dot(sub(b.fp.center, hit.point), rightNormal(tangent))).toBeLessThan(0);
    expect(dist(b.fp.center, old.center)).toBeGreaterThan(20);
  });

  it('если у фасада нет свободного места, использует соседний кусок той же улицы', () => {
    const { game, street, at, end } = scene();
    const b = beside(game, street, 70, 1);
    const blocker = building(game, { center: add(at, { x: 48, y: 73 }), w: 150, h: 30, angle: 0 }, { kind: 'landmark' });
    const project = new MoveProject(() => game);
    const by = { x: 0, y: 35 };
    expect(project.add((net) => {
      net.moveNode(street.a, add(at, by));
      net.moveNode(street.b, add(end, by));
      splitCorridor(net, net.corridor(street.id), 120, 'seam');
    })).toBeNull();
    expect(project.build()).toBeNull();
    expect(game.buildingById(b.id)).toBe(b);
    expect(b.fp.center.x - at.x).toBeGreaterThan(120);
    expect(b.fp.center.y - at.y).toBeGreaterThan(35);
    expect(footprintsOverlap(b.fp, blocker.fp, 2)).toBe(false);
  });

  it('сносит дом только когда на его стороне нет места, сохраняя дом с другой стороны', () => {
    const layout = scene();
    const { game, street, at } = layout;
    const left = beside(game, street, 125, -1);
    const right = beside(game, street, 155, 1);
    const blocker = building(game, { center: add(at, { x: LENGTH / 2, y: 72 }), w: LENGTH + 50, h: 30, angle: 0 }, { kind: 'landmark' });
    const plan = translate(layout, { x: 0, y: 35 });
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.houseMoves?.map((m) => m.id)).toEqual([left.id]);
    expect(plan.demolish).toEqual([right.id]);
    game.checkpoint('перенос улицы');
    expect(game.roadBuilder.apply(plan)).toBe(true);
    game.commit();
    expect(game.buildingById(right.id)).toBeUndefined();
    expect(game.index.items.has(right)).toBe(false);
    expect(game.buildingById(blocker.id)).toBe(blocker);
    expect(footprintsOverlap(left.fp, blocker.fp, 2)).toBe(false);
    expect(game.undo()).toBe('перенос улицы');
    expect(game.buildingById(right.id)).toBeDefined();
    expect(game.redo()).toBe('перенос улицы');
    expect(game.buildingById(right.id)).toBeUndefined();
  });

  it('при отмене перестройки следом за улицей возвращает ранее перенесённый дом', () => {
    const layout = scene('build');
    const { game, street, end } = layout;
    const b = beside(game, street, 150, 1);
    const old = b.fp;
    const plan = game.roadBuilder.moveNode(street.b, add(end, { x: 0, y: 80 }));
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.project?.rebuild?.moved).toBe(true);
    expect(game.roadBuilder.apply(plan)).toBe(true);
    expect(dist(b.fp.center, old.center)).toBeGreaterThan(20);
    expect(game.cancelProject(plan.project!.id)).toBe(true);
    expect(dist(b.fp.center, old.center)).toBeCloseTo(0, 2);
    expect(b.fp.angle).toBeCloseTo(old.angle);
  });

  it('грузовой двор использует положение того же магазина после переноса улицы и отмены', () => {
    const layout = scene();
    const { game, street } = layout;
    const s = 160;
    const center = add(street.lut.pointAt(s), { x: 0, y: halfAtS(street, s) + LOT_SETBACK + 25 });
    const shop = building(game, { center, w: 62, h: 50, angle: 0 }, { anchor: street.a, face: -1, kind: 'com', form: 'warehouse' });
    const town = game.townOf(shop)!;
    town.receivers = [{ b: shop.id, cargo: ['food'], w: 1, stock: {}, at: 0, depot: true }];
    const dock = game.dockFor(shop)!;
    expect(dock).toBeTruthy();
    const old = shop.fp;
    const plan = translate(layout, { x: 0, y: 37 });
    expect(plan.ok, plan.reason).toBe(true);
    game.checkpoint('перенос улицы');
    expect(game.roadBuilder.apply(plan)).toBe(true);
    game.commit();
    expect(dist(shop.fp.center, old.center)).toBeGreaterThan(30);
    expect(game.dockBuilding(dock)).toBe(shop);
    expect(dock.fp).toEqual(shop.fp);
    expect(game.undo()).toBe('перенос улицы');
    expect(game.dockBuilding(dock)?.fp).toEqual(old);
    expect(dock.fp).toEqual(old);
  });
});
