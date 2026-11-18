import { describe, expect, it } from 'vitest';
import { TERRAIN_VERSION } from '../world/settings';
import { Game, type SaveData } from './game';
import { fieldSpot, road, STREET, withoutCitizens } from './testkit';
import { DEFAULT_RULE } from './transport';

function scene() {
  const game = withoutCitizens(new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 50_000_000, water: 'dry', terrainVersion: TERRAIN_VERSION }));
  const p = fieldSpot(game, 800);
  expect(road(game, { free: p }, { free: { x: p.x + 800, y: p.y } }, STREET)).toBe(true);
  const west = game.roads.net.nodesNear(p, 1)[0].id;
  const east = game.roads.net.nodesNear({ x: p.x + 800, y: p.y }, 1)[0].id;
  const st = game.placeStation({ x: p.x + 200, y: p.y + 40 }, 14)!;
  expect(st).toBeTruthy();
  return { game, st, west, east, p };
}

/** Машина уже выехала с западного конца на восток, а цель позади: где ей развернуться? */
function returnRoute(game: Game, west: number) {
  return game.roads.routeFrom((game.roads.graph.outLinks.get(west) ?? []).map((l) => l.id), west)!;
}

function passes(game: Game, route: number[], node: number) {
  return route.some((id) => game.roads.graph.links.get(id)?.toNode === node);
}

describe('Автостанция не служит разворотом', () => {
  it('попутная машина разворачивается в обычном тупике, а не на ближайшей автостанции', () => {
    const { game, st, west, east } = scene();
    const route = returnRoute(game, west);
    expect(route).toBeTruthy();
    expect(passes(game, route, st.nodeId)).toBe(false);
    expect(passes(game, route, east)).toBe(true);
    // Контроль воспроизведения: разрешили разворот — путь сразу сокращается через станцию.
    const gate = game.roads.net.node(st.nodeId);
    delete gate.bans;
    game.roads.net.version++;
    game.roads.changed();
    const oldRoute = returnRoute(game, west);
    expect(passes(game, oldRoute, st.nodeId)).toBe(true);
    const car = game.traffic.spawn({ kind: 'car', length: 7, width: 3, maxSpeed: 30, accel: 4, color: '#888888', targetNode: west, route: oldRoute })!;
    expect(car).toBeTruthy();
    // Правка дороги восстанавливает запрет и пересчитывает граф.
    game.networkChanged();
    game.speed = 1;
    for (let i = 0; i < 5; i++) game.update(0.1);
    expect(game.traffic.vehicles.has(car.id)).toBe(true);
    expect(passes(game, car.route, st.nodeId)).toBe(false);
    expect(passes(game, returnRoute(game, west), st.nodeId)).toBe(false);
    expect(game.roads.route(west, st.nodeId)).toBeTruthy();
    expect(game.roads.route(st.nodeId, west)).toBeTruthy();
  });

  it.each(['truck', 'bus'] as const)('%s заезжает на посты обеих станций и уезжает дальше', (model) => {
    const { game, st, p } = scene();
    const b = game.placeStation({ x: p.x + 600, y: p.y - 40 }, 14)!;
    expect(b).toBeTruthy();
    const line = game.createLine([st.id, b.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { ...DEFAULT_RULE, wait: 'none' });
    const v = game.buyVehicle(line.id, model)!;
    expect(v).toBeTruthy();
    const visited = new Set<number>();
    let drove = false;
    game.speed = 1;
    for (let t = 0; t < 300 && visited.size < 2; t += 0.1) {
      game.update(0.1);
      drove ||= v.state === 'driving';
      if (drove && v.enter) visited.add(line.stops[v.stop]);
    }
    expect([...visited].sort()).toEqual([st.id, b.id].sort());
    expect(line.problem).toBeNull();
  });

  it('станция из старого сохранения тоже не используется для разворота', () => {
    const { game, st, west, east } = scene();
    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    const gate = save.roads.nodes.find((n) => n.id === st.nodeId)!;
    delete gate.bans;
    const loaded = withoutCitizens(new Game(game.settings, save));
    const route = returnRoute(loaded, west);
    expect(route).toBeTruthy();
    expect(passes(loaded, route, st.nodeId)).toBe(false);
    expect(passes(loaded, route, east)).toBe(true);
    expect(loaded.roads.route(west, st.nodeId)).toBeTruthy();
    expect(loaded.roads.route(st.nodeId, west)).toBeTruthy();
  });

  it('после переноса станции и его отмены запрет действует у её ворот', () => {
    const { game, st, west, p } = scene();
    const was = st.nodeId;
    game.checkpoint('перенос');
    expect(game.moveStation(st.id, { x: p.x + 450, y: p.y - 40 }, 14)).toBeNull();
    game.commit();
    expect(st.nodeId).not.toBe(was);
    expect(passes(game, returnRoute(game, west), st.nodeId)).toBe(false);
    expect(game.roads.route(west, st.nodeId)).toBeTruthy();
    game.undo();
    const restored = game.stations.get(st.id)!;
    expect(restored.nodeId).toBe(was);
    expect(passes(game, returnRoute(game, west), restored.nodeId)).toBe(false);
    expect(game.roads.route(restored.nodeId, west)).toBeTruthy();
  });
});
