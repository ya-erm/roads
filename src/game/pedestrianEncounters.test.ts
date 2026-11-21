import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { add as plus, dist, norm, scale, sub, type Vec } from '../core/vec';
import { setWalk } from '../lanes/crosswalk';
import { LaneNet, twoWay } from '../lanes/model';
import { freshGame } from './testkit';
import { walkingNetwork } from './pedestrians';
import type { Game } from './game';
import { walkKey } from './crosswalks';

const origin = -100_000;
const at = (x: number, y: number) => ({ x: origin + x, y: origin + y });
const horizontal = { id: 1, a: at(-100, 0), b: at(100, 0) };
const vertical = { id: 2, a: at(0, -100), b: at(0, 100) };
const emptySidewalks = { lines: [], ends: [], spans: new Map() };

function populate(game: Game, paths: typeof horizontal[]) {
  game.footpaths = paths;
  game.setPedestrians(true);
  game.pedestrians.step(game);
  game.pedestrians.walkers.length = 0;
  const edges = [...walkingNetwork(emptySidewalks, paths, game.roads.graph.crosswalks.values()).values()];
  const add = (line: number, along: number, reverse: boolean, speed: number) => {
    const edge = edges[line];
    const start = game.time - (reverse ? edge.length - along : along) / speed;
    const w = { edge, seed: game.pedestrians.walkers.length + 1, visits: 0, reverse, speed, start, end: start + edge.length / speed };
    game.pedestrians.walkers.push(w);
    return game.pedestrians.walkers.at(-1)!;
  };
  return { game, add, edges };
}

function encounter(paths = [horizontal]) {
  const game = freshGame(7);
  game.roads.replace(new LaneNet());
  return populate(game, paths);
}

function trace(game: Game, seconds: number): Vec[][] {
  const frames: Vec[][] = [];
  for (let tick = 0; tick < seconds / SIM_DT; tick++) {
    game.time += SIM_DT;
    game.crosswalks.step(game.time, game.roads.graph, game.traffic);
    game.pedestrians.step(game);
    frames.push([...game.pedestrians.visible(game.time)].map(w => ({ x: w.pos.x - origin, y: w.pos.y - origin })));
  }
  return frames;
}

describe('Дистанция между видимыми пешеходами', () => {
  it('на двухметровой дорожке встречные расходятся по правым сторонам, затем возвращаются к оси', () => {
    const { game, add } = encounter();
    add(0, 94, false, 3);
    add(0, 106, true, 3);
    const frames = trace(game, 5);
    expect(Math.min(...frames.map(([a, b]) => dist(a, b)))).toBeGreaterThan(0.99);
    const meeting = frames.find(([a, b]) => a.x > b.x)!;
    expect(meeting[0].y).toBeGreaterThan(0.49);
    expect(meeting[1].y).toBeLessThan(-0.49);
    expect(Math.max(...frames.flat().map(p => Math.abs(p.y)))).toBeLessThan(0.55);
    expect(frames.at(-1)!.map(p => p.y)).toEqual([0, 0]);
  });

  it('догнавший замедляется, идёт за соседом и сохраняет дистанцию', () => {
    const { game, add } = encounter();
    add(0, 80, false, 3.5);
    add(0, 84, false, 2.4);
    const frames = trace(game, 6);
    expect(Math.min(...frames.map(([a, b]) => b.x - a.x))).toBeGreaterThan(1.1);
    expect(frames.at(-1)![0].x).toBeGreaterThan(-4);
    expect(frames.every(([a, b]) => a.y === 0 && b.y === 0)).toBe(true);
  });

  it('при пересечении дорожек люди проходят узел по очереди и продолжают движение', () => {
    const { game, add, edges } = encounter([horizontal, vertical]);
    for (const path of [horizontal, vertical]) {
      const approach = edges.findIndex(e => dist(e.a, path.a) < 0.01);
      add(approach, 94, false, 3).next = edges.find(e => dist(e.b, path.b) < 0.01)!;
    }
    const frames = trace(game, 5);
    expect(Math.min(...frames.map(([a, b]) => dist(a, b)))).toBeGreaterThan(0.99);
    const [a, b] = frames.at(-1)!;
    expect(a.x).toBeGreaterThan(5);
    expect(b.y).toBeGreaterThan(5);
  });

  it('на Т-развилке с двух ветвей можно свернуть на одну и дальше идти следом', () => {
    const { game, add, edges } = encounter([
      { ...horizontal, b: at(0, 0) }, { ...vertical, b: at(0, 0) }, { ...horizontal, id: 3, a: at(0, 0) },
    ]);
    add(0, 94, false, 3).next = edges[2];
    add(1, 94, false, 3).next = edges[2];
    const frames = trace(game, 6);
    expect(Math.min(...frames.map(([a, b]) => dist(a, b)))).toBeGreaterThan(0.99);
    for (const p of frames.at(-1)!) {
      expect(p.y).toBe(0);
      expect(p.x).toBeGreaterThan(6);
    }
  });

  it('очередь стоит перед красным сигналом с промежутком, затем оба человека переходят зебру', () => {
    const game = freshGame(7);
    const roads = new LaneNet();
    const centre = roads.addJunction(at(0, 0));
    centre.control = 'lights';
    for (const dir of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }]) {
      const tip = roads.addSeam(plus(centre.pos, scale(dir, 100)), dir);
      const arm = roads.addCorridor(centre.id, tip.id, { cls: 'street', lanes: twoWay(1, 1) });
      if (dir.x === 1) setWalk(centre, arm.id, true);
    }
    game.roads.replace(roads);
    const graph = game.roads.graph;
    const surface = graph.crosswalks.get(centre.id)![0];
    const [near, far] = surface.geo.ends;
    const along = norm(sub(far, near));
    const start = plus(near, scale(along, -40));
    const { add, edges } = populate(game, [{ id: 1, a: start, b: near }, { id: 2, a: far, b: plus(far, scale(along, 40)) }]);
    const approach = edges.findIndex(e => dist(e.a, start) < .01);
    const crossing = edges.find(e => e.crossing)!;
    add(approach, 37, false, 3).next = crossing;
    add(approach, 34, false, 3).next = crossing;
    const lights = graph.nodes.get(centre.id)!.lights!;
    const vehicleGreen = (phase: typeof lights.phases[number]) => [...phase.moves].some(key => graph.moves.get(key)?.inLink === surface.inLink);
    lights.timer = 200;
    lights.phase = lights.phases.findIndex(vehicleGreen);
    const waiting = trace(game, 4);
    const nearShown = sub(near, at(0, 0));
    const [first, second] = waiting.at(-1)!;
    expect(dist(first, nearShown)).toBeLessThan(.01);
    expect(dist(first, second)).toBeGreaterThan(1.1);
    expect(game.traffic.walks.size).toBe(0);
    lights.phase = lights.phases.findIndex(p => !vehicleGreen(p));
    const crossingFrames = trace(game, 2);
    expect(game.crosswalks.crossings.get(walkKey(surface))!.barriers[0].closed).toBe(true);
    const onward = trace(game, crossing.length / 3 + 2);
    expect(Math.min(...[...waiting, ...crossingFrames, ...onward].map(([a, b]) => dist(a, b)))).toBeGreaterThan(.99);
    expect(game.pedestrians.walkers.every(w => !w.edge.crossing && w.edge.a === crossing.b)).toBe(true);
    expect(game.traffic.walks.size).toBe(0);
  });
});
