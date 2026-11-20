import { describe, expect, it } from 'vitest';
import { ProjectTools, type DrawSettings } from '../input/projecttools';
import { RoadTools } from '../input/roadtools';
import { Game } from './game';
import { stationGatePoints } from './stationAccess';
import { fieldSpot, freshGame, road, runUntil, withoutCitizens } from './testkit';

describe('Отдельные подъезды автостанции', () => {
  it.each([false, true])('грузовик въезжает и выезжает через разные узлы (проект: %s)', (project) => {
    const game = withoutCitizens(freshGame(42));
    game.money = 5_000_000;
    const p = fieldSpot(game, 480);
    expect(road(game, { free: p }, { free: { x: p.x + 480, y: p.y } })).toBe(true);
    const yard = game.placeStation({ x: p.x + 135, y: p.y - 38 }, 14)!;
    const other = game.placeStation({ x: p.x + 350, y: p.y - 38 }, 14)!;
    expect(yard && other).toBeTruthy();
    const points = stationGatePoints(yard, game.roads.net).sort((a, b) => a.pos.x - b.pos.x);
    expect(points).toHaveLength(2);

    const tools = new RoadTools(() => game);
    const planner = new ProjectTools(() => game);
    tools.auto = false;
    const oneWay = { cls: 'street', lanesF: 1, lanesB: 0 } as const;
    const draw: DrawSettings = { kind: 'road', spec: oneWay, mode: 'straight', level: 0, auto: false, reverse: false };
    const connect = (from: typeof p, to: typeof p) => {
      if (project) {
        for (const pos of [from, to]) {
          planner.down('road', pos, 8, 4);
          planner.up(draw, pos, 8, false, false);
        }
        planner.cancel('road');
        return;
      }
      tools.clear();
      expect(tools.begin(from, 8)).toBe(true);
      expect(tools.build(to, oneWay, 'straight', 8, false)).toBeNull();
    };
    // Основной двусторонний подъезд убираем, боковые подключаем как обычные односторонние дороги.
    const main = game.roads.net.node(yard.nodeId);
    expect(game.roadBuilder.apply(game.roadBuilder.bulldoze([...main.corridors]))).toBe(true);
    connect({ x: points[0].pos.x, y: p.y }, points[0].pos);
    connect(points[1].pos, { x: points[1].pos.x, y: p.y });
    if (project) {
      expect(planner.plan('road').ok).toBe(true);
      expect(planner.build('road')).toBeNull();
    }

    const graph = game.roads.graph;
    const gates = game.stationRoadNodes(yard);
    const inbound = gates.find((id) => graph.inLinks.has(id))!;
    const outbound = gates.find((id) => graph.outLinks.has(id))!;
    expect(inbound).toBeDefined();
    expect(outbound).toBeDefined();
    expect(inbound).not.toBe(outbound);
    expect(graph.inLinks.has(outbound)).toBe(false);
    expect(graph.outLinks.has(inbound)).toBe(false);
    expect(stationGatePoints(yard, game.roads.net)).toHaveLength(0);

    const line = game.createLine([other.id, yard.id])!;
    expect(game.lineGap(line)).toBeNull();
    const truck = game.buyVehicle(line.id, 'truck')!;
    expect(runUntil(game, 90, () => game.fleetSim(truck)?.targetNode === inbound)).toBe(true);
    const loaded = new Game(game.settings, structuredClone(game.toSave()));
    expect(loaded.fleetSim(loaded.fleet.get(truck.id)!)?.targetNode).toBe(inbound);
    expect(runUntil(game, 90, () => truck.stop === 0 && truck.state === 'driving')).toBe(true);
    const sim = game.fleetSim(truck)!;
    expect(game.roads.graph.links.get(sim.route[0])?.fromNode).toBe(outbound);
  });
});
