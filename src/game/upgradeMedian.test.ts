import { describe, expect, it } from 'vitest';
import { edgesAt } from '../lanes/geometry';
import { profileOf, taperLen } from '../lanes/model';
import type { RoadSpec } from '../world/roadTypes';
import { TERRAIN_VERSION } from '../world/settings';
import { Game } from './game';
import { fieldSpot, road, withoutCitizens } from './testkit';

const HIGHWAY: RoadSpec = { cls: 'highway', lanesF: 2, lanesB: 2 };
const MOTORWAY: RoadSpec = { cls: 'motorway', lanesF: 2, lanesB: 2 };

function scene(reverse = false, initial = HIGHWAY, curved = false) {
  const game = withoutCitizens(new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 50_000_000, water: 'dry', terrainVersion: TERRAIN_VERSION }));
  const p = fieldSpot(game, 1000, 240);
  const rise = curved ? 80 : 0;
  const at = (x: number) => ({ x: p.x + x, y: p.y + Math.max(0, Math.min(1, (x - 300) / 300)) * rise });
  const profile = profileOf(initial);
  const forward = { p0: at(300), p1: { x: p.x + 400, y: p.y }, p2: { x: p.x + 500, y: p.y + rise }, p3: at(600) };
  const curve = reverse ? { p0: forward.p3, p1: forward.p2, p2: forward.p1, p3: forward.p0 } : forward;
  expect(road(game, { free: at(0) }, { free: at(300) }, profile)).toBe(true);
  expect(reverse
    ? road(game, { free: at(600) }, at(300), { ...profile, curve })
    : road(game, at(300), { free: at(600) }, { ...profile, curve })).toBe(true);
  expect(road(game, at(600), { free: at(900) }, profile)).toBe(true);
  const c = game.roads.net.corridorNear(at(450), 1)!;
  const west = game.roads.net.nodesNear(at(0), 1)[0].id;
  const east = game.roads.net.nodesNear(at(900), 1)[0].id;
  return { game, id: c.id, west, east };
}

describe('Перестройка дороги с разделителем', () => {
  it.each([false, true])('переход с магистрали на автомагистраль не сводит все полосы в остриё (обратная ось: %s)', (reverse) => {
    const { game, id, west, east } = scene(reverse);
    const plan = game.roadBuilder.rebuild(id, profileOf(MOTORWAY));
    expect(plan.ok).toBe(true);
    const c = plan.net!.corridor(id);
    // В предпросмотре оба конца имеют ширину двух проезжих частей, а не исчезают перед стыком.
    for (const s of [0, 1, c.length - 1, c.length]) {
      const edges = edgesAt(c, s);
      expect(edges).not.toBeNull();
      expect(edges![1] - edges![0]).toBeGreaterThanOrEqual(28);
    }
    expect(game.roadBuilder.apply(plan)).toBe(true);
    expect(game.roads.route(west, east)).not.toBeNull();
    expect(game.roads.route(east, west)).not.toBeNull();
    expect(game.roads.net.problems()).toEqual([]);
    // Следующие куски перестроили в тот же профиль: связность сохраняется.
    for (const other of [...game.roads.net.corridors.values()]) {
      if (other.id !== id) expect(game.roadBuilder.apply(game.roadBuilder.rebuild(other.id, profileOf(MOTORWAY)))).toBe(true);
    }
    expect(game.roads.route(west, east)).not.toBeNull();
    expect(game.roads.route(east, west)).not.toBeNull();
  });

  it.each([
    { from: HIGHWAY, to: MOTORWAY },
    { from: MOTORWAY, to: HIGHWAY },
  ])('разделитель добавляют или снимают на изогнутой дороге: $from.cls → $to.cls', ({ from, to }) => {
    const { game, id, west, east } = scene(false, from, true);
    const before = game.roads.net.corridor(id);
    const plan = game.roadBuilder.rebuild(id, profileOf(to));
    expect(plan.ok).toBe(true);
    const c = plan.net!.corridor(id);
    expect(c.curve).toEqual(before.curve);
    for (const s of [0, 1, c.length / 2, c.length - 1, c.length]) {
      const e = edgesAt(c, s);
      expect(e).not.toBeNull();
      expect(e![1] - e![0]).toBeGreaterThanOrEqual(28);
    }
    expect(game.roadBuilder.apply(plan)).toBe(true);
    expect(game.roads.route(west, east)).not.toBeNull();
    expect(game.roads.route(east, west)).not.toBeNull();
    expect(game.roads.net.problems()).toEqual([]);
  });

  it('на переходе восстанавливает автоотгоны соседа, оставшиеся после прежней перестройки', () => {
    const { game, id, west, east } = scene();
    const net = game.roads.net;
    const middle = net.corridor(id);
    const neighbor = net.corridor(net.node(middle.a).corridors.find((sid) => sid !== id)!);
    // Старый ошибочный переход: все полосы соседа сходили на нет у стыка.
    net.setLanes(neighbor, neighbor.lanes.map((l) => neighbor.a === middle.a
      ? { ...l, from: taperLen(neighbor.cls) }
      : { ...l, to: neighbor.length - taperLen(neighbor.cls) }));
    const plan = game.roadBuilder.rebuild(id, profileOf(MOTORWAY));
    expect(plan.ok).toBe(true);
    const fixed = plan.net!.corridor(neighbor.id);
    expect(edgesAt(fixed, fixed.a === middle.a ? 0 : fixed.length)).not.toBeNull();
    expect(game.roadBuilder.apply(plan)).toBe(true);
    expect(game.roads.route(west, east)).not.toBeNull();
    expect(game.roads.route(east, west)).not.toBeNull();
  });
});
