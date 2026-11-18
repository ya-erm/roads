import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { Game } from '../game/game';
import { MoveProject } from '../game/moveProject';
import { fieldSpot, road, withoutCitizens } from '../game/testkit';
import { laneStep, laneTipAt } from '../lanes/edit';
import type { LaneNet } from '../lanes/model';
import { twoWay } from '../lanes/model';
import { branchSeam } from '../lanes/slide';
import { TERRAIN_VERSION } from '../world/settings';
import { RoadTools } from './roadtools';

const joints = (net: LaneNet) => [...net.nodes.values()].flatMap((n) => branchSeam(net, n) ?? []);

function scene() {
  const game = withoutCitizens(new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 50_000_000, water: 'dry', terrainVersion: TERRAIN_VERSION }));
  const o = fieldSpot(game, 1000, 240);
  const at = (x: number, y: number): Vec => ({ x: o.x + x, y: o.y + y });
  expect(road(game, { free: at(0, 0) }, { free: at(1000, 0) }, { cls: 'avenue', lanes: twoWay(2, 2) })).toBe(true);
  const setup = game.roadBuilder.plan((net) => {
    for (const [from, to] of [[at(200, 200), at(400, 17.5)], [at(700, -200), at(450, -17.5)]]) {
      laneStep(net, laneTipAt(net, from, 14), to, 'avenue', 14);
    }
    laneStep(net, laneTipAt(net, at(440, -17.5), 14), at(370, -17.5), 'avenue', 14);
  });
  expect(setup.reason).toBeUndefined();
  expect(game.roadBuilder.apply(setup)).toBe(true);
  const mine = () => joints(game.roads.net).filter((j) => Math.abs(j.node.pos.y - o.y) < 1 && j.node.pos.x >= o.x && j.node.pos.x <= o.x + 1000);
  expect(mine()).toHaveLength(2);
  const source = mine().find((j) => j.node.pos.x < o.x + 425)!;
  const target = mine().find((j) => j.node.pos.x > o.x + 425)!;
  const start = game.roads.net.portPos(source.node, source.branches[0].port);
  const end = game.roads.net.portPos(target.node, target.branches[0].port);
  return { game, tools: new RoadTools(() => game), source, target, start, end, mine };
}

describe('«Двигать»: свести примыкания в один узел', () => {
  it('предпросмотр и отпускание объединяют примыкания; отмена и повтор возвращают оба состояния', () => {
    const { game, tools, source, target, start, end, mine } = scene();
    const money = game.money;
    game.checkpoint('объединение примыканий');
    expect(tools.moveDown(start, 3)).toBe(true);
    expect(tools.slide).toBe(source.node.id);
    const preview = tools.movePlan(end)!;
    expect(tools.hint).toBe('объединятся');
    expect(tools.joinPos).toEqual(target.node.pos);
    expect(preview.reason).toBeUndefined();
    expect(preview.ok).toBe(true);
    expect(preview.net!.node(target.node.id).corridors).toHaveLength(4);
    expect(mine()).toHaveLength(2);
    expect(tools.moveUp(end, true)).toBeNull();
    game.commit();
    expect(mine()).toHaveLength(1);
    expect(mine()[0].branches).toHaveLength(2);
    expect(game.roads.net.problems()).toEqual([]);
    expect(game.undo()).toBe('объединение примыканий');
    expect(mine()).toHaveLength(2);
    expect(game.money).toBe(money);
    expect(game.redo()).toBe('объединение примыканий');
    expect(mine()).toHaveLength(1);
  });

  it('та же протяжка в проекте сохраняет построенную дорогу до «Построить»', () => {
    const { game, tools, start, end, mine } = scene();
    const project = new MoveProject(() => game);
    tools.base = project.net();
    expect(tools.moveDown(start, 3)).toBe(true);
    const edit = tools.moveEdit(end)!;
    expect(tools.hint).toBe('объединятся');
    expect(project.add(edit)).toBeNull();
    tools.moveEnd();
    expect(mine()).toHaveLength(2);
    expect(project.plan().ok).toBe(true);
    expect(project.build()).toBeNull();
    expect(mine()).toHaveLength(1);
    expect(game.roads.net.problems()).toEqual([]);
  });

  it('Ctrl/Alt во время протяжки отключает слияние с соседним узлом', () => {
    const { tools, start, end } = scene();
    expect(tools.moveDown(start, 3)).toBe(true);
    const preview = tools.movePlan(end, false, [], true)!;
    expect(tools.hint).not.toBe('объединятся');
    expect(joints(preview.net!)).toHaveLength(2);
  });
});
