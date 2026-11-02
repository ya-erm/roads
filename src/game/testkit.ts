/** Помощники для тестов: дороги через строителя игры на сети полос. */
import type { Vec } from '../core/vec';
import { Anchor, anchorAt, RoadOptions } from '../lanes/edit';
import { Corridor, LaneNode, twoWay } from '../lanes/model';
import type { RoadClass } from '../world/roadTypes';
import type { Game } from './game';
import type { RoadPlan } from './roadbuild';

export const STREET = { cls: 'street' as RoadClass, lanes: twoWay(1, 1) };
export const AVENUE = { cls: 'avenue' as RoadClass, lanes: twoWay(2, 2) };

/** Узел (id), точка (привязка как у игрока: к узлу или дороге рядом) или свободная точка. */
export type End = number | Vec | { free: Vec };

export function anchorOf(game: Game, x: End): Anchor {
  const net = game.roads.net;
  if (typeof x === 'number') return { kind: 'node', node: x, pos: net.node(x).pos };
  if ('free' in x) return { kind: 'free', pos: x.free };
  return anchorAt(net, x, 14);
}

/** План дороги от a до b (kink — из тупика под углом, а не плавно). */
export function roadPlan(game: Game, a: End, b: End, profile: RoadOptions = STREET): RoadPlan {
  return game.roadBuilder.road(anchorOf(game, a), anchorOf(game, b), profile);
}

/** Строит дорогу от a до b; true — построилась. */
export function road(game: Game, a: End, b: End, profile: RoadOptions = STREET): boolean {
  const plan = roadPlan(game, a, b, profile);
  return plan.ok && game.roadBuilder.apply(plan);
}

/** Узел на другом конце выезда станции — там выезд примыкает к дороге (или кончается). */
export function stationExit(game: Game, nodeId: number): LaneNode {
  const net = game.roads.net;
  const c = net.corridor(net.node(nodeId).corridors[0]);
  return net.node(c.a === nodeId ? c.b : c.a);
}

/** Улицы города, которые есть сейчас. */
export function townStreets(game: Game, townId: number): Corridor[] {
  const town = game.towns.find((t) => t.id === townId)!;
  const net = game.roads.net;
  const own = town.streets.map((id) => net.corridors.get(id)).filter((c): c is Corridor => !!c);
  return own.length ? own : net.corridorsNear(town.center, town.radius);
}
