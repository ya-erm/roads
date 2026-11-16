import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { Game } from '../game/game';
import { MoveProject } from '../game/moveProject';
import { minRadius } from '../core/bezier';
import { fieldSpot, freshGame, road, roadPlan } from '../game/testkit';
import { LaneGraph } from '../lanes/graph';
import { type LaneNet, oneWay, twoWay } from '../lanes/model';
import { findLaneRoute } from '../lanes/routing';
import { ROAD_CLASSES } from '../world/roadTypes';
import { RoadTools } from './roadtools';

const STREET = { cls: 'street' as const, lanesF: 1, lanesB: 1 };

/** Прямая улица из двух полотен со стыком посередине — в чистом поле. */
function streetWithSeam(game: Game): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - 1100; x += 160) {
      if (road(game, { free: { x, y } }, { free: { x: x + 400, y } }) && road(game, { x: x + 400, y }, { free: { x: x + 900, y } })) return { x, y };
    }
  }
  throw new Error('нет места');
}

/** Протяжка мышью: нажали в первой точке, провели через остальные, отпустили в последней. */
function drag(tools: RoadTools, pts: Vec[]): string | null {
  tools.laneDown(pts[0], 14);
  for (const p of pts.slice(1)) tools.laneMove(p, 14);
  return tools.laneUp(pts[pts.length - 1], 14, STREET, true);
}

describe('Инструмент «Полоса»: место рядом с другой дорогой', () => {
  it('полоса с дальней от соседней дороги стороны строится, с ближней — слишком близко', () => {
    const game = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    let o: Vec | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !o; y += 120) {
      for (let x = 300; x < game.terrain.width - 900 && !o; x += 160) {
        if (road(game, { free: { x, y } }, { free: { x: x + 500, y } }) && road(game, { free: { x, y: y - 20 } }, { free: { x: x + 500, y: y - 20 } })) o = { x, y };
      }
    }
    expect(o).not.toBeNull();
    const at = o!;
    const tools = new RoadTools(() => game);
    // Соседняя улица — выше (−y): снизу полоса встаёт, сверху ей нет места.
    expect(drag(tools, [{ x: at.x + 100, y: at.y + 10.5 }, { x: at.x + 250, y: at.y + 10.5 }, { x: at.x + 350, y: at.y + 10.5 }])).toBeNull();
    expect(drag(tools, [{ x: at.x + 100, y: at.y - 10.5 }, { x: at.x + 250, y: at.y - 10.5 }, { x: at.x + 350, y: at.y - 10.5 }])).toBe('Слишком близко к другой дороге');
  });
});

describe('Перестроить: разворот односторонней', () => {
  it('тот же профиль поверх односторонней из нескольких кусков разворачивает её всю, без встречных полос на стыках', () => {
    const game = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const ONE = { cls: 'street' as const, lanes: oneWay(1) };
    let o: Vec | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !o; y += 120) {
      for (let x = 300; x < game.terrain.width - 1000 && !o; x += 160) {
        if (road(game, { free: { x, y } }, { free: { x: x + 300, y } }, ONE)) o = { x, y };
      }
    }
    const at = o!;
    expect(road(game, { x: at.x + 300, y: at.y }, { free: { x: at.x + 600, y: at.y } }, ONE)).toBe(true);
    expect(road(game, { x: at.x + 600, y: at.y }, { free: { x: at.x + 900, y: at.y } }, ONE)).toBe(true);
    const mine = () => [...game.roads.net.corridors.values()].filter((c) => [c.a, c.b].every((id) => Math.abs(game.roads.net.node(id).pos.y - at.y) < 1));
    expect(mine()).toHaveLength(3);
    const dirs = () => mine().map((c) => Math.sign((game.roads.net.node(c.b).pos.x - game.roads.net.node(c.a).pos.x) * c.lanes[0].flow));
    expect(dirs()).toEqual([1, 1, 1]);
    const tools = new RoadTools(() => game);
    expect(tools.upgrade({ x: at.x + 450, y: at.y }, { cls: 'street', lanesF: 1, lanesB: 0 }, 4)).toBeNull();
    expect(dirs()).toEqual([-1, -1, -1]);
    expect(mine().every((c) => c.lanes[0].from === 0)).toBe(true);
    expect(game.roads.net.problems()).toEqual([]);
  });
});

describe('Инструмент «Полоса»: протяжка', () => {
  it('полоса, которую тянут вдоль края, проходит через стык дальше', () => {
    const game = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const o = streetWithSeam(game);
    const tools = new RoadTools(() => game);
    const edge = (dx: number) => ({ x: o.x + dx, y: o.y + 10.5 });
    expect(drag(tools, [edge(150), edge(300), edge(450), edge(600), edge(700)])).toBeNull();
    const net = game.roads.net;
    const mine = [...net.corridors.values()].filter((c) => [c.a, c.b].every((id) => Math.abs(net.node(id).pos.y - o.y) < 1));
    const pieces = mine.filter((c) => c.lanes.some((l) => Math.abs(Math.abs(l.offset) - 10.5) < 0.5));
    expect(mine).toHaveLength(2);
    expect(pieces).toHaveLength(2);
    expect(net.problems()).toEqual([]);
  });

  it('тянут вдоль и уводят в сторону — съезд там, где ушли от края; правой кнопкой — отмена протяжки', () => {
    const game = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const o = streetWithSeam(game);
    const tools = new RoadTools(() => game);
    const before = game.roads.net.corridors.size;
    tools.laneDown({ x: o.x + 100, y: o.y + 10.5 }, 14);
    tools.laneMove({ x: o.x + 200, y: o.y + 10.5 }, 14);
    expect(tools.cancel()).toBe(true);
    expect(tools.laneUp({ x: o.x + 200, y: o.y + 10.5 }, 14, STREET, true)).toBeNull();
    expect(game.roads.net.corridors.size).toBe(before);

    expect(drag(tools, [{ x: o.x + 100, y: o.y + 10.5 }, { x: o.x + 250, y: o.y + 10.5 }, { x: o.x + 320, y: o.y + 60 }, { x: o.x + 360, y: o.y + 160 }])).toBeNull();
    const net = game.roads.net;
    const ramp = [...net.corridors.values()].find((c) => c.portA || c.portB)!;
    expect(ramp).toBeDefined();
    const seam = net.node(ramp.portA ? ramp.a : ramp.b);
    expect(seam.pos.x - o.x).toBeCloseTo(250, -1);
    expect(net.problems()).toEqual([]);
  });

  it('въезд на магистраль за коротким куском после съезда: съезд из соседнего стыка — не «слишком близко»', () => {
    // Как у игрока: магистраль 1+1 на восток, в стыке S1 вправо уходит съезд, через 20 м — ещё стык S2.
    // Съезд за S2 идёт вплотную к магистрали («ёлочка» ещё не разошлась) — так построено, правке после S2 не мешает.
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 50_000_000, water: 'dry' });
    const HIGHWAY = { cls: 'highway' as const, lanes: twoWay(1, 1) };
    let o: Vec | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !o; y += 120) {
      for (let x = 300; x < game.terrain.width - 1000 && !o; x += 160) {
        const before = game.roads.net.clone();
        const fits = road(game, { free: { x, y: y - 100 } }, { free: { x: x + 700, y: y - 100 } }, HIGHWAY) && road(game, { free: { x, y: y + 100 } }, { free: { x: x + 700, y: y + 100 } }, HIGHWAY);
        game.roads.replace(before);
        game.networkChanged();
        if (fits && !game.roads.net.corridorsNear({ x: x + 350, y }, 450).length) o = { x, y };
      }
    }
    expect(o).not.toBeNull();
    const at = o!;
    const setup = game.roadBuilder.plan(
      (n) => {
        const seam = (dx: number, dy = 0, dir = { x: 1, y: 0 }) => n.addSeam({ x: at.x + dx, y: at.y + dy }, dir);
        const [W, S1, S2, E] = [seam(0), seam(300), seam(320), seam(700)];
        n.addCorridor(W.id, S1.id, { cls: 'highway', lanes: [...twoWay(1, 1), { offset: 10.5, flow: 1, from: 200, to: Infinity }] });
        n.addCorridor(S1.id, S2.id, { cls: 'highway', lanes: twoWay(1, 1) });
        n.addCorridor(S2.id, E.id, { cls: 'highway', lanes: twoWay(1, 1) });
        n.addCorridor(S1.id, seam(560, 90, { x: 0.95, y: 0.31 }).id, { cls: 'highway', portA: 10.5, lanes: oneWay(1) });
      },
      { raze: true },
    );
    expect(game.roadBuilder.apply(setup)).toBe(true);
    const net = () => game.roads.net;
    expect(net().problems()).toEqual([]);
    const before = net().corridors.size;
    // Въезд из поля с севера на полосы на запад, с полосой разгона — по куску после S2.
    expect(drag(new RoadTools(() => game), [{ x: at.x + 640, y: at.y - 80 }, { x: at.x + 600, y: at.y - 40 }, { x: at.x + 560, y: at.y - 8.5 }, { x: at.x + 400, y: at.y - 8.5 }])).toBeNull();
    expect(net().corridors.size).toBe(before + 2);
    expect(net().problems()).toEqual([]);
    // А дорога, что просто идёт рядом и ни с чем тут не сходится, по-прежнему слишком близко.
    expect(roadPlan(game, { free: { x: at.x + 330, y: at.y - 14 } }, { free: { x: at.x + 390, y: at.y - 14 } }, HIGHWAY).reason).toBe('Слишком близко к другой дороге');
  });
});

describe('Инструмент «Полоса»: въезд и съезд одним путём', () => {
  const HIGHWAY = { cls: 'highway' as const, lanes: twoWay(1, 1) };
  /** Магистраль 1+1 с запада на восток в чистом поле: с севера (y−) едут на запад, с юга — на восток. */
  function scene() {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 50_000_000, water: 'dry' });
    const o = fieldSpot(game, 800, 200);
    expect(road(game, { free: o }, { free: { x: o.x + 800, y: o.y } }, HIGHWAY)).toBe(true);
    const at = (dx: number, dy: number) => ({ x: o.x + dx, y: o.y + dy });
    // Тупики у магистрали (в игре есть и улицы городов).
    const ends = () => [...game.roads.net.nodes.values()].filter((n) => game.roads.net.isDeadEnd(n) && Math.abs(n.pos.x - o.x - 400) < 410 && Math.abs(n.pos.y - o.y) < 200);
    const west = ends().find((n) => n.pos.x < o.x + 1 && Math.abs(n.pos.y - o.y) < 1)!;
    const east = ends().find((n) => n.pos.x > o.x + 799 && Math.abs(n.pos.y - o.y) < 1)!;
    return { game, o, at, ends, west, east, net: () => game.roads.net };
  }
  const reachable = (net: LaneNet, from: number, to: number) => {
    const g = new LaneGraph(net);
    return !!findLaneRoute(g, g.outLinks.get(from) ?? [], to);
  };
  /** Пристроенная полоса магистрали с севера (едут на запад): где она на полную ширину, по x. */
  const northLane = (net: LaneNet, o: Vec) =>
    [...net.corridors.values()]
      .filter((c) => !c.portA && !c.portB && c.lanes.length > 2 && [c.a, c.b].every((id) => Math.abs(net.node(id).pos.y - o.y) < 1))
      .flatMap((c) => c.lanes.filter((l) => Math.abs(l.offset) > 7).map((l) => [c.lut.pointAt(Math.max(0, l.from)).x, c.lut.pointAt(Math.min(c.length, l.to)).x]))
      .flat();

  it('из поля к краю и вдоль — одной протяжкой: однополосная до примыкания, дальше полоса слияния до конца пути', () => {
    const { game, o, at, ends, west, net } = scene();
    const tools = new RoadTools(() => game);
    // Полого, с севера, на запад: край — у x 470, путь вдоль — до x 250.
    const path = [at(620, -60), at(560, -40), at(500, -20), at(470, -10.5), at(400, -10.5), at(320, -10.5), at(250, -10.5)];
    // Как контроллер: снимок для отмены — при нажатии, итог — при отпускании.
    game.checkpoint('полоса');
    tools.laneDown(path[0], 14);
    for (const p of path.slice(1)) tools.laneMove(p, 14);
    // Предпросмотр и цена — всего пути разом.
    const preview = tools.lanePlan(STREET)!;
    expect(preview.what).toBe('Въезд → Полоса');
    expect(preview.plan.ok).toBe(true);
    expect(preview.plan.cost).toBeGreaterThan(0);
    const corridors = net().corridors.size;
    expect(tools.laneUp(path[path.length - 1], 14, STREET, true)).toBeNull();
    game.commit();
    expect(net().problems()).toEqual([]);
    // Однополосная от первой точки к стыку сбоку; магистраль разрезана стыком.
    const entry = [...net().corridors.values()].find((c) => c.portB)!;
    expect(entry).toBeDefined();
    expect(net().corridors.size).toBe(corridors + 2);
    // Примыкание — где въезд подходит к краю плавно (не круче радиуса магистрали), полоса слияния — до конца пути.
    expect(minRadius(entry.curve)).toBeGreaterThan(ROAD_CLASSES.highway.minRadius * 0.95);
    const xs = northLane(net(), o);
    expect(Math.min(...xs) - o.x).toBeCloseTo(250, -1);
    expect(Math.max(...xs) - o.x).toBeLessThanOrEqual(471);
    // Из поля можно выехать на магистраль на запад.
    const start = ends().find((n) => n.pos.y < o.y - 50)!;
    expect(reachable(net(), start.id, west.id)).toBe(true);

    // Отмена — одним шагом: ни въезда, ни полосы.
    expect(game.undo()).toBe('полоса');
    expect(net().corridors.size).toBe(corridors);
    expect(northLane(net(), o)).toEqual([]);
    expect([...net().corridors.values()].some((c) => c.portA || c.portB)).toBe(false);
  });

  it('с конца односторонней, что подходит к магистрали вплотную, — въезд в полосу слияния, а не «слишком близко»', () => {
    const { game, o, at, ends, west, net } = scene();
    // Односторонняя на запад кончается в 22 м от оси магистрали, глядя полого к ней (как у гостя).
    expect(road(game, { free: at(700, -60) }, { free: at(560, -22) }, { cls: 'street', lanes: oneWay(1) })).toBe(true);
    const tip = [...net().nodes.values()].find((n) => net().isDeadEnd(n) && Math.abs(n.pos.x - o.x - 560) < 1)!;
    const tools = new RoadTools(() => game);
    const path = [tip.pos, at(545, -17), at(530, -12), ...[480, 420, 360, 300].map((x) => at(x, -10.5))];
    // Как контроллер: снимок для отмены — при нажатии, итог — при отпускании.
    game.checkpoint('полоса');
    tools.laneDown(path[0], 14);
    for (const p of path.slice(1)) tools.laneMove(p, 14);
    const preview = tools.lanePlan(STREET)!;
    expect(preview.plan.reason).toBeUndefined();
    expect(preview.what).toBe('Въезд → Полоса');
    expect(tools.laneUp(path[path.length - 1], 14, STREET, true)).toBeNull();
    game.commit();
    expect(net().problems()).toEqual([]);
    // Въезд продолжает одностороннюю из её конца: тупика там больше нет, изгиб — не круче радиуса магистрали.
    const entry = [...net().corridors.values()].find((c) => c.portB)!;
    expect(entry.a).toBe(tip.id);
    expect(net().isDeadEnd(net().node(tip.id))).toBe(false);
    expect(minRadius(entry.curve)).toBeGreaterThan(ROAD_CLASSES.highway.minRadius * 0.95);
    expect(Math.min(...northLane(net(), o)) - o.x).toBeCloseTo(300, -1);
    const start = ends().find((n) => n.pos.x > o.x + 650 && n.pos.y < o.y - 50)!;
    expect(reachable(net(), start.id, west.id)).toBe(true);
    expect(game.undo()).toBe('полоса');
    expect(net().isDeadEnd(net().node(tip.id))).toBe(true);
  });

  it('вдоль края и в сторону — одной протяжкой: полоса торможения и съезд в поле', () => {
    const { game, o, at, east, ends, net } = scene();
    const tools = new RoadTools(() => game);
    // С юга едут на восток: полоса от x 200 до 400, оттуда — в поле на юго-восток.
    const path = [at(200, 10.5), at(300, 10.5), at(400, 10.5), at(460, 30), at(520, 70), at(580, 140)];
    // Как контроллер: снимок для отмены — при нажатии, итог — при отпускании.
    game.checkpoint('полоса');
    tools.laneDown(path[0], 14);
    for (const p of path.slice(1)) tools.laneMove(p, 14);
    const preview = tools.lanePlan(STREET)!;
    expect(preview.what).toBe('Полоса → Съезд');
    expect(preview.plan.ok).toBe(true);
    const corridors = net().corridors.size;
    expect(tools.laneUp(path[path.length - 1], 14, STREET, true)).toBeNull();
    game.commit();
    expect(net().problems()).toEqual([]);
    const exit = [...net().corridors.values()].find((c) => c.portA)!;
    expect(net().node(exit.a).pos.x - o.x).toBeCloseTo(400, -1);
    // Полоса торможения — от начала пути до съезда.
    const decel = [...net().corridors.values()].filter((c) => !c.portA && c.lanes.some((l) => l.offset > 7 || l.offset < -7));
    expect(decel.length).toBeGreaterThan(0);
    const end = ends().find((n) => n.pos.y > o.y + 100)!;
    const westStart = ends().find((n) => n.pos.x < o.x + 1 && Math.abs(n.pos.y - o.y) < 1)!;
    expect(reachable(net(), westStart.id, end.id)).toBe(true);
    expect(reachable(net(), westStart.id, east.id)).toBe(true);
    expect(game.undo()).toBe('полоса');
    expect(net().corridors.size).toBe(corridors);
  });
});

describe('Инструмент «Полоса»: направление новой полосы', () => {
  /** Куда едут по пристроенным полосам улицы (|смещение| > 7) с её стороны side (1 — юг, y+; −1 — север): 1 — на восток, −1 — на запад. */
  const extraFlows = (net: LaneNet, o: Vec, side: 1 | -1) =>
    [...net.corridors.values()]
      .filter((c) => [c.a, c.b].every((id) => Math.abs(net.node(id).pos.y - o.y) < 1))
      .flatMap((c) => c.lanes.filter((l) => Math.abs(l.offset) > 7 && Math.sign(l.offset) * Math.sign(net.node(c.b).pos.x - net.node(c.a).pos.x) === side).map((l) => l.flow * Math.sign(net.node(c.b).pos.x - net.node(c.a).pos.x)));

  it('тянут против движения — полоса всё равно по движению с этой стороны; с Alt — встречная; в проекте так же', () => {
    const game = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const o = streetWithSeam(game);
    const at = (dx: number, dy: number) => ({ x: o.x + dx, y: o.y + dy });
    const tools = new RoadTools(() => game);
    // Улица на восток: справа по ходу (y+) едут на восток, слева (y−) — на запад. Тянем справа на запад, слева на восток.
    expect(drag(tools, [at(850, 10.5), at(700, 10.5), at(500, 10.5)])).toBeNull();
    expect(drag(tools, [at(500, -10.5), at(650, -10.5), at(850, -10.5)])).toBeNull();
    expect(game.roads.net.problems()).toEqual([]);
    expect(extraFlows(game.roads.net, o, 1)).toEqual([1]);
    expect(extraFlows(game.roads.net, o, -1)).toEqual([-1]);

    // Alt — встречная: справа на западном куске, тянут на восток — едут на запад.
    tools.reverse = true;
    expect(drag(tools, [at(50, 10.5), at(200, 10.5), at(350, 10.5)])).toBeNull();
    expect(extraFlows(game.roads.net, o, 1).sort()).toEqual([-1, 1]);
    tools.reverse = false;

    // Проект «Полосы»: та же правка копится в проекте — слева на западном куске, тянут на восток, едут на запад.
    const project = new MoveProject(() => game, { shove: true, label: 'полоса' });
    tools.base = project.net();
    tools.lanePrefix = project.edits;
    tools.laneSink = (edit) => project.add(edit);
    expect(drag(tools, [at(50, -10.5), at(200, -10.5), at(350, -10.5)])).toBeNull();
    const plan = project.plan();
    expect(plan.ok).toBe(true);
    expect(extraFlows(plan.net!, o, -1)).toEqual([-1, -1]);
  });
});
