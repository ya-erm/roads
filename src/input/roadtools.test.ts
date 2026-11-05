import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { Game } from '../game/game';
import { road, roadPlan } from '../game/testkit';
import { RoadTools } from './roadtools';

const STREET = { cls: 'street' as const, lanesF: 1, lanesB: 1 };

/** Прямая улица на 400 м с запада на восток в чистом поле; от её восточного тупика можно вести дорогу дальше. */
function streetEnd(game: Game): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - 800; x += 160) {
      const end = { x: x + 400, y };
      if (road(game, { free: { x, y } }, { free: end }) && roadPlan(game, end, { free: { x: end.x + 200, y: y + 10 } }).ok) return end;
    }
  }
  throw new Error('нет места');
}

describe('Прямая без прилипания (Cmd / Ctrl или Alt)', () => {
  const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
  const end = streetEnd(game);
  const tools = new RoadTools(() => game);
  tools.begin(end, 14);

  it('чуть в стороне от продолжения: без клавиши — ровно прямо, с клавишей — под курсором', () => {
    // 200 м вперёд и 10 м вбок — меньше 6° от продолжения улицы.
    const p = { x: end.x + 200, y: end.y + 10 };
    const snapped = tools.endAnchor(p, 14, false);
    expect(snapped.kind).toBe('free');
    expect(snapped.pos.x).toBeCloseTo(end.x + 200, 6);
    expect(snapped.pos.y).toBeCloseTo(end.y, 6);
    expect(tools.hint).toBe('прямо');

    const free = tools.endAnchor(p, 14, false, true);
    expect(free).toMatchObject({ kind: 'free', pos: p });
    expect(tools.hint).toBeNull();
  });

  it('почти под прямым углом: без клавиши — ровно 90°, с клавишей — под курсором', () => {
    const p = { x: end.x + 10, y: end.y + 200 };
    const snapped = tools.endAnchor(p, 14, false);
    expect(snapped.pos.x).toBeCloseTo(end.x, 6);
    expect(snapped.pos.y).toBeCloseTo(end.y + 200, 6);
    expect(tools.hint).toBe('90°');

    expect(tools.endAnchor(p, 14, false, true).pos).toEqual(p);
    expect(tools.hint).toBeNull();
  });

  it('к узлам дорога примыкает и с клавишей; Shift (шаг 15°) — как был', () => {
    // Западный тупик той же улицы — в 3 м от курсора.
    expect(tools.endAnchor({ x: end.x - 397, y: end.y + 2 }, 14, false, true).kind).toBe('node');
    const stepped = tools.endAnchor({ x: end.x + 200, y: end.y + 10 }, 14, true, true);
    expect(stepped.pos.y).toBeCloseTo(end.y, 6);
  });

  it('построенная с клавишей дорога кончается под курсором, а не на продолжении', () => {
    const p = { x: end.x + 200, y: end.y + 10 };
    expect(tools.build(p, STREET, 'straight', 14, false, true)).toBeNull();
    const net = game.roads.net;
    expect(net.nodesNear(p, 0.5).length).toBe(1);
    expect(net.nodesNear({ x: end.x + 200, y: end.y }, 3).length).toBe(0);
  });
});

/**
 * Две сцены рядом: изгиб B дороги (x, y) → B → (x + 400, y) и тупик T улицы, что идёт сверху к прямой улице
 * на y + 200 и не доходит до неё 60 м.
 */
function moveScene(game: Game): { B: Vec; T: Vec; line: number } {
  for (let y = 400; y < game.terrain.height - 700; y += 450) {
    for (let x = 300; x < game.terrain.width - 800; x += 600) {
      const B = { x: x + 200, y: y + 20 };
      const T = { x: x + 200, y: y + 260 };
      if (
        road(game, { free: { x, y } }, { free: B }) &&
        road(game, B, { free: { x: x + 400, y } }) &&
        road(game, { free: { x, y: y + 200 } }, { free: { x: x + 400, y: y + 200 } }) &&
        road(game, { free: { x: x + 200, y: y + 330 } }, { free: T })
      )
        return { B, T, line: y + 200 };
    }
  }
  throw new Error('нет места');
}

describe('«Двигать» без прилипания (Cmd / Ctrl или Alt)', () => {
  const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
  const { B, T, line } = moveScene(game);
  const tools = new RoadTools(() => game);
  const nodeAt = (p: Vec) => game.roads.net.nodesNear(p, 1)[0];
  const bend = nodeAt(B).id;

  it('изгиб у прямой: без клавиши встаёт ровно на неё, с клавишей — под курсором', () => {
    const id = bend;
    // В 6 м от прямой между дальними концами дороги.
    const p = { x: B.x, y: B.y - 14 };
    expect(tools.moveDown(B, 14)).toBe(true);
    const snapped = tools.movePlan(p)!;
    expect(tools.hint).toBe('ровно');
    expect(snapped.net!.node(id).pos.y).toBeCloseTo(B.y - 20, 6);

    const free = tools.movePlan(p, false, [], true)!;
    expect(tools.hint).toBeNull();
    expect(free.net!.node(id).pos).toEqual(p);

    expect(tools.moveUp(p, true, false, true)).toBeNull();
    expect(game.roads.net.node(id).pos).toEqual(p);
  });

  it('тупик у дороги: без клавиши примыкает к ней, с клавишей остаётся тупиком под курсором', () => {
    const id = nodeAt(T).id;
    // В 20 м от оси улицы — в радиусе прилипания (30 м).
    const p = { x: T.x, y: line + 20 };
    expect(tools.moveDown(T, 30)).toBe(true);
    const joined = tools.movePlan(p)!;
    expect(tools.hint).toBe('примкнёт');
    expect(tools.joinPos).not.toBeNull();
    expect(joined.net!.nodes.has(id)).toBe(false);

    const free = tools.movePlan(p, false, [], true)!;
    expect(tools.hint).toBeNull();
    expect(tools.joinPos).toBeNull();
    expect(free.net!.node(id).pos).toEqual(p);

    expect(tools.moveUp(p, true, false, true)).toBeNull();
    const net = game.roads.net;
    expect(net.node(id).pos).toEqual(p);
    expect(net.isDeadEnd(net.node(id))).toBe(true);
  });

  it('проект перемещения: правка с клавишей — тоже без прилипания', () => {
    const id = bend;
    const at = game.roads.net.node(id).pos;
    const p = { x: at.x + 30, y: B.y - 16 };
    expect(tools.moveDown(at, 14)).toBe(true);
    const edit = tools.moveEdit(p, false, true)!;
    tools.moveEnd();
    const net = game.roads.net.clone();
    edit(net);
    expect(net.node(id).pos).toEqual(p);
  });
});

describe('Знак скорости: с Cmd / Ctrl — только участок под курсором', () => {
  const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
  // Улица из трёх участков со стыками: (x, y) → +200 → +400 → +600.
  let o: Vec | null = null;
  for (let y = 400; y < game.terrain.height - 400 && !o; y += 150) {
    for (let x = 300; x < game.terrain.width - 900 && !o; x += 700) {
      if (
        road(game, { free: { x, y } }, { free: { x: x + 200, y } }) &&
        road(game, { x: x + 200, y }, { free: { x: x + 400, y } }) &&
        road(game, { x: x + 400, y }, { free: { x: x + 600, y } })
      )
        o = { x, y };
    }
  }
  const at = o!;
  const tools = new RoadTools(() => game);
  const net = () => game.roads.net;
  const under = (x: number) => [...net().corridors.values()].find((c) => c.lut.closest({ x, y: at.y }).d < 1)!;
  // Средний участок — под курсором.
  const mid = { x: at.x + 300, y: at.y };

  it('без клавиши — вся улица до перекрёстков, с клавишей — один участок', () => {
    const all = tools.limitPlan(mid, 60, 5)!;
    expect(all.parts).toBe(3);
    expect(all.plan.ok).toBe(true);
    expect([...all.plan.changed].sort()).toEqual([under(at.x + 100).id, under(at.x + 300).id, under(at.x + 500).id].sort());

    const one = tools.limitPlan(mid, 60, 5, true)!;
    expect(one.parts).toBe(3);
    expect(one.plan.changed).toEqual([under(at.x + 300).id]);
  });

  it('отпустили с клавишей — скорость только у участка, одна отмена возвращает как было', () => {
    game.checkpoint('скорость участка');
    expect(tools.setLimitAt(mid, 60, 5, true)).toBeNull();
    game.commit();
    expect(under(at.x + 300).limit).toBe(60);
    expect(under(at.x + 100).limit).toBeUndefined();
    expect(under(at.x + 500).limit).toBeUndefined();

    expect(game.undo()).toBe('скорость участка');
    expect(under(at.x + 300).limit).toBeUndefined();
  });
});
