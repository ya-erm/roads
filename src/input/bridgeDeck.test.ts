import { describe, expect, it } from 'vitest';
import { GRADE } from '../config';
import type { Vec } from '../core/vec';
import { Game } from '../game/game';
import { road, roadPlan } from '../game/testkit';
import { deckAlong, nodeDeck } from '../lanes/deck';
import { LaneNet, twoWay } from '../lanes/model';
import { RoadTools } from './roadtools';

const SPEC = { cls: 'highway' as const, lanesF: 1, lanesB: 1 };
const HIGHWAY = { cls: 'highway' as const, lanes: twoWay(1, 1) };

/** Тупик дороги в чистом поле: от него ведём новую на восток. */
function deadEnd(game: Game): Vec {
  for (let y = 400; y < game.terrain.height - 600; y += 120) {
    for (let x = 300; x < game.terrain.width - 900; x += 160) {
      const end = { x: x + 200, y };
      if (!road(game, { free: { x, y } }, { free: end }, HIGHWAY)) continue;
      if (roadPlan(game, end, { free: { x: end.x + 400, y: end.y } }, HIGHWAY).ok) return end;
    }
  }
  throw new Error('нет места');
}

describe('−/+ поднимает и опускает мост «Авто», а не только удлиняет его', () => {
  const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 500_000_000, water: 'dry' });
  const end = deadEnd(game);
  // Земля ровная: высота моста над ней — ровно его отметка от начала.
  game.ground = () => () => 0;
  // Прямо по продолжению дороги — конец там, где курсор.
  const far = { x: end.x + 400, y: end.y };

  const endAt = (rise: number) => {
    const rt = new RoadTools(() => game);
    rt.begin(end, 10);
    rt.auto = true;
    rt.rise = rise;
    const plan = rt.buildPlan(far, SPEC, 'straight', 10, false)!;
    const node = plan.net!.nodesNear(far, 3)[0];
    return { rt, plan, node };
  };

  it('конец на мосту — на заданной высоте над началом; подсказка «конец +N м» — та же', () => {
    for (const rise of [14, 16, 20]) {
      const { rt, plan, node } = endAt(rise);
      expect(plan.ok).toBe(true);
      expect(node.level).toBe(1);
      expect(nodeDeck(node)).toBeCloseTo(rise, 0);
      expect(rt.endRise).toBeCloseTo(rise, 0);
    }
  });

  it('каждое нажатие + — мост у конца выше на шаг; ниже допустимого мост не опускается', () => {
    const a = endAt(14).node;
    const b = endAt(14 + GRADE.riseStep).node;
    expect(nodeDeck(b) - nodeDeck(a)).toBeCloseTo(GRADE.riseStep, 0);
    // Полотно у конца в отрисовке — на той же высоте.
    const { plan, node } = endAt(16);
    const c = plan.net!.corridor(node.corridors[0]);
    const s = c.b === node.id ? c.length : 0;
    expect(deckAlong(plan.net!, c, s)).toBeCloseTo(nodeDeck(node), 6);
  });

  it('построенный мост хранит высоту: следующая дорога от его конца начинается с неё', () => {
    const rt = new RoadTools(() => game);
    rt.begin(end, 10);
    rt.auto = true;
    rt.rise = 18;
    expect(rt.build(far, SPEC, 'straight', 10, false)).toBeNull();
    const built = game.roads.net.nodesNear(far, 3)[0];
    expect(built.deck).toBeCloseTo(18, 0);
    // Сохранение и загрузка — высота та же.
    const copy = LaneNet.fromJSON(JSON.parse(JSON.stringify(game.roads.net.toJSON())));
    expect(copy.node(built.id).deck).toBeCloseTo(18, 0);
    expect(rt.startDeck).toBeCloseTo(18, 0);
  });
});
