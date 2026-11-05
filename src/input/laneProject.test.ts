import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { Game } from '../game/game';
import { MoveProject } from '../game/moveProject';
import { road, roadPlan } from '../game/testkit';
import type { LaneNet } from '../lanes/model';
import { RoadTools } from './roadtools';

const STREET = { cls: 'street' as const, lanesF: 1, lanesB: 1 };

/** Улица в чистом поле (с запасом места по обе стороны). */
function street(game: Game): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - 900; x += 160) {
      // Место и выше улицы — под полосу сверху.
      if (!roadPlan(game, { free: { x, y: y - 60 } }, { free: { x: x + 500, y: y - 60 } }).ok) continue;
      if (road(game, { free: { x, y } }, { free: { x: x + 500, y } })) return { x, y };
    }
  }
  throw new Error('нет места');
}

/** Инструмент «Полоса» в проекте: тянет от сети с проектом, готовые правки — в проект. */
function wire(tools: RoadTools, project: MoveProject): void {
  tools.base = project.net();
  tools.lanePrefix = project.edits;
  tools.laneSink = (edit) => project.add(edit);
}

function drag(tools: RoadTools, pts: Vec[]): string | null {
  tools.laneDown(pts[0], 14);
  for (const p of pts.slice(1)) tools.laneMove(p, 14);
  return tools.laneUp(pts[pts.length - 1], 14, STREET, true);
}

/** Сколько полос у полотен улицы на оси y. */
const lanesAt = (net: LaneNet, y: number) =>
  [...net.corridors.values()].filter((c) => [c.a, c.b].every((id) => Math.abs(net.node(id).pos.y - y) < 1)).reduce((k, c) => k + c.lanes.length, 0);

describe('Проект полос', () => {
  it('протяжки «Полосы» копятся проектом, дорога не меняется; «Построить» — все разом одним Ctrl+Z', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const o = street(game);
    const tools = new RoadTools(() => game);
    const project = new MoveProject(() => game, { shove: true, label: 'полоса' });
    const money = game.money;
    const before = lanesAt(game.roads.net, o.y);
    // Полоса снизу, потом — сверху (вторую тянут уже от сети с первой).
    wire(tools, project);
    expect(drag(tools, [{ x: o.x + 100, y: o.y + 10.5 }, { x: o.x + 250, y: o.y + 10.5 }, { x: o.x + 350, y: o.y + 10.5 }])).toBeNull();
    wire(tools, project);
    expect(drag(tools, [{ x: o.x + 120, y: o.y - 10.5 }, { x: o.x + 260, y: o.y - 10.5 }, { x: o.x + 380, y: o.y - 10.5 }])).toBeNull();
    expect(project.edits.length).toBe(2);
    expect(lanesAt(game.roads.net, o.y)).toBe(before);
    expect(game.money).toBe(money);
    const plan = project.plan();
    expect(plan.ok).toBe(true);
    expect(lanesAt(plan.net!, o.y)).toBeGreaterThan(before + 1);
    // Ctrl+Z в проекте — последняя полоса прочь.
    expect(project.undo()).toBe(true);
    expect(lanesAt(project.net()!, o.y)).toBeLessThan(lanesAt(plan.net!, o.y));
    wire(tools, project);
    expect(drag(tools, [{ x: o.x + 120, y: o.y - 10.5 }, { x: o.x + 260, y: o.y - 10.5 }, { x: o.x + 380, y: o.y - 10.5 }])).toBeNull();
    const total = project.plan();
    expect(project.build()).toBeNull();
    expect(lanesAt(game.roads.net, o.y)).toBe(lanesAt(total.net!, o.y));
    expect(game.money).toBe(money - total.cost);
    expect(game.roads.net.problems()).toEqual([]);
    expect(game.undo()).toBe('полоса');
    expect(lanesAt(game.roads.net, o.y)).toBe(before);
    expect(game.money).toBe(money);
  });

  it('невалидный съезд попадает в проект (красным), построить нельзя; узел съезда перетащили — проект исправлен и строится', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'wet' });
    // Улица у воды: конец съезда (в 45 м от неё) — в воде, в 25 м — ещё на берегу.
    let o: Vec | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !o; y += 20) {
      for (let x = 300; x < game.terrain.width - 900 && !o; x += 40) {
        if (!game.isWater({ x: x + 300, y: y + 45 }, 4) || game.isWater({ x: x + 300, y: y + 25 }, 6)) continue;
        if (road(game, { free: { x, y } }, { free: { x: x + 500, y } })) o = { x, y };
      }
    }
    expect(o).not.toBeNull();
    const at = o!;
    const tools = new RoadTools(() => game);
    const project = new MoveProject(() => game, { shove: true, label: 'полоса' });
    const corridors = game.roads.net.corridors.size;
    wire(tools, project);
    // Вдоль края — и в сторону, концом в воду: без проекта так не построить.
    const pts = [
      { x: at.x + 100, y: at.y + 10.5 },
      { x: at.x + 200, y: at.y + 10.5 },
      { x: at.x + 300, y: at.y + 45 },
    ];
    expect(drag(tools, pts)).toBeNull();
    expect(project.edits.length).toBe(1);
    const bad = project.plan();
    expect(bad.ok).toBe(false);
    expect(bad.reason).toBeTruthy();
    expect(project.build()).toBe(bad.reason);
    expect(game.roads.net.corridors.size).toBe(corridors);
    // Тот же съезд без проекта — отказ, как раньше.
    const plain = new RoadTools(() => game);
    expect(drag(plain, pts)).toBe(bad.reason);
    // Конец съезда — от соседней улицы подальше: тянем его узел (от сети с проектом), как в «Двигать».
    const net = project.net()!;
    const end = net.nodesNear({ x: at.x + 300, y: at.y + 45 }, 12).find((n) => net.isDeadEnd(n))!;
    expect(end).toBeDefined();
    wire(tools, project);
    expect(tools.moveDown(end.pos, 14)).toBe(true);
    const edit = tools.moveEdit({ x: at.x + 300, y: at.y + 25 });
    tools.moveEnd();
    expect(project.add(edit!)).toBeNull();
    const fixed = project.plan();
    expect(fixed.ok).toBe(true);
    expect(project.build()).toBeNull();
    expect(game.roads.net.corridors.size).toBeGreaterThan(corridors);
    expect(game.roads.net.problems()).toEqual([]);
  });

  it('без проекта «Полоса» строит сразу, как раньше', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const o = street(game);
    const tools = new RoadTools(() => game);
    const before = lanesAt(game.roads.net, o.y);
    expect(drag(tools, [{ x: o.x + 100, y: o.y + 10.5 }, { x: o.x + 250, y: o.y + 10.5 }, { x: o.x + 350, y: o.y + 10.5 }])).toBeNull();
    expect(lanesAt(game.roads.net, o.y)).toBe(before + 1);
  });
});
