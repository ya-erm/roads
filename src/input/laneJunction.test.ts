import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { MoveProject } from '../game/moveProject';
import { fieldSpot, freshGame, road } from '../game/testkit';
import { laneStep, laneTipAt } from '../lanes/edit';
import type { LaneNet } from '../lanes/model';
import { RoadTools } from './roadtools';

const STREET = { cls: 'street' as const, lanesF: 1, lanesB: 1 };

function scene(branchSide = -1) {
  const game = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
  const o = fieldSpot(game, 800, 220);
  const at = (x: number, y = 10.5): Vec => ({ x: o.x + x, y: o.y + y });
  expect(road(game, { free: at(0, 0) }, { free: at(800, 0) })).toBe(true);
  expect(road(game, { free: at(400, branchSide * 180) }, at(400, 0))).toBe(true);
  const node = game.roads.net.nodesNear(at(400, 0), 1)[0];
  expect(node.kind).toBe('junction');
  const extra = (net: LaneNet) => [...net.corridors.values()].filter((c) =>
    [c.a, c.b].every((id) => Math.abs(net.node(id).pos.y - o.y) < 1) && c.lanes.some((l) => Math.abs(l.offset) === 10.5),
  );
  return { game, tools: new RoadTools(() => game), at, extra };
}

function drag(tools: RoadTools, points: Vec[]) {
  tools.laneDown(points[0], 14);
  for (const p of points.slice(1)) tools.laneMove(p, 14);
  const preview = tools.lanePlan(STREET)!;
  expect(preview.what).toBe('Полоса');
  expect(preview.plan.reason).toBeUndefined();
  expect(preview.plan.ok).toBe(true);
  expect(tools.laneUp(points[points.length - 1], 14, STREET, true)).toBeNull();
  return preview;
}

describe('Инструмент «Полоса» через перекрёсток', () => {
  it('одна протяжка расширяет оба подъезда; отмена возвращает дорогу и деньги', () => {
    const { game, tools, at, extra } = scene();
    const before = game.roads.net.corridors.size;
    const money = game.money;
    game.checkpoint('полоса');
    const preview = drag(tools, [at(200), at(350), at(410), at(550), at(650)]);
    game.commit();
    expect(extra(preview.plan.net!)).toHaveLength(2);
    expect(extra(game.roads.net)).toHaveLength(2);
    expect(game.roads.net.corridors.size).toBe(before);
    expect(game.roads.net.problems()).toEqual([]);
    expect(game.money).toBe(money - preview.plan.cost);
    expect(game.undo()).toBe('полоса');
    expect(extra(game.roads.net)).toHaveLength(0);
    expect(game.money).toBe(money);
  });

  for (const backwards of [false, true]) {
    it(`продолжает конец полосы, уже доведённый до перекрёстка, назад: ${backwards}`, () => {
      const { game, tools, at, extra } = scene(backwards ? 1 : -1);
      const start = backwards ? at(650, -10.5) : at(200);
      const end = backwards ? at(400, -10.5) : at(400);
      const target = backwards ? at(180, -10.5) : at(650);
      // Уже построенная полоса доходит на полную ширину до узла, как на скриншоте.
      laneStep(game.roads.net, laneTipAt(game.roads.net, start, 14), end, 'street', 14);
      game.networkChanged();
      expect(extra(game.roads.net)).toHaveLength(1);
      drag(tools, [end, target]);
      expect(extra(game.roads.net)).toHaveLength(2);
      expect(game.roads.net.problems()).toEqual([]);
    });
  }

  it('по кликам продолжает полосу через перекрёсток', () => {
    const { game, tools, at, extra } = scene();
    tools.laneDown(at(200), 14);
    expect(tools.laneUp(at(200), 14, STREET, false)).toBeNull();
    const first = tools.laneStepPlan(at(400), STREET, 14)!;
    expect(first.plan.ok).toBe(true);
    tools.laneDown(at(400), 14);
    expect(tools.laneUp(at(400), 14, STREET, false)).toBeNull();
    const next = tools.laneStepPlan(at(650), STREET, 14)!;
    expect(next.step?.what).toBe('Полоса');
    expect(next.plan.ok).toBe(true);
    tools.laneDown(at(650), 14);
    expect(tools.laneUp(at(650), 14, STREET, false)).toBeNull();
    expect(extra(game.roads.net)).toHaveLength(2);
  });

  it('в проекте меняет оба подъезда только после постройки проекта', () => {
    const { game, tools, at, extra } = scene();
    const project = new MoveProject(() => game, { shove: true, label: 'полоса' });
    tools.base = project.net();
    tools.lanePrefix = project.edits;
    tools.laneSink = (edit) => project.add(edit);
    drag(tools, [at(200), at(350), at(450), at(650)]);
    expect(extra(game.roads.net)).toHaveLength(0);
    expect(extra(project.plan().net!)).toHaveLength(2);
    expect(project.build()).toBeNull();
    expect(extra(game.roads.net)).toHaveLength(2);
    expect(game.roads.net.problems()).toEqual([]);
  });
});
