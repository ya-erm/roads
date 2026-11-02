import { describe, expect, it } from 'vitest';
import { Vec } from '../core/vec';
import { autoMainPair, mainPairOf } from './graph';
import { LaneNet, LaneSlot, twoWay } from './model';

const STREET = { cls: 'street' as const, lanes: twoWay(1, 1) };
const AVENUE = { cls: 'avenue' as const, lanes: twoWay(2, 2) };

/**
 * Перекрёсток в (0, 0) и плечи по направлениям (угол в радианах, 0 — на восток).
 * Чётные плечи — от узла, нечётные — к узлу: у перекрёстка бывают оба конца полотна.
 */
function junction(arms: { angle: number; road?: { cls: 'street' | 'avenue'; lanes: LaneSlot[] } }[]) {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 });
  const ids = arms.map((arm, i) => {
    const d: Vec = { x: Math.cos(arm.angle), y: Math.sin(arm.angle) };
    const far = { x: d.x * 300, y: d.y * 300 };
    const road = arm.road ?? STREET;
    const c =
      i % 2 === 0
        ? net.addCorridor(j.id, net.addSeam(far, d).id, road)
        : net.addCorridor(net.addSeam(far, { x: -d.x, y: -d.y }).id, j.id, road);
    return c.id;
  });
  return { ends: net.ends(net.node(j.id)), ids };
}

const sorted = (p: [number, number] | null) => (p ? [...p].sort((a, b) => a - b) : null);

describe('Главная дорога перекрёстка', () => {
  it('«Авто»: из прямых проездов — самый вместительный', () => {
    // Проспект запад–восток, улица север–юг: главный — проспект.
    const { ends, ids } = junction([{ angle: 0, road: AVENUE }, { angle: Math.PI / 2 }, { angle: Math.PI, road: AVENUE }, { angle: -Math.PI / 2 }]);
    expect(sorted(autoMainPair(ends))).toEqual(sorted([ids[0], ids[2]]));
    // Те же дороги, но проспект — север–юг.
    const turned = junction([{ angle: 0 }, { angle: Math.PI / 2, road: AVENUE }, { angle: Math.PI }, { angle: -Math.PI / 2, road: AVENUE }]);
    expect(sorted(autoMainPair(turned.ends))).toEqual(sorted([turned.ids[1], turned.ids[3]]));
  });

  it('«Авто»: при равных дорогах — самый прямой проезд; излом больше 0,6 рад — не проезд', () => {
    // Улицы: запад–восток прямо, север–юг с изломом 0,4 рад.
    const { ends, ids } = junction([{ angle: 0 }, { angle: Math.PI / 2 }, { angle: Math.PI }, { angle: -Math.PI / 2 + 0.4 }]);
    expect(sorted(autoMainPair(ends))).toEqual(sorted([ids[0], ids[2]]));
    // Т-образный: проспект-примыкание без прямого продолжения главным не станет.
    const t = junction([{ angle: 0 }, { angle: Math.PI / 2, road: AVENUE }, { angle: Math.PI }]);
    expect(sorted(autoMainPair(t.ends))).toEqual(sorted([t.ids[0], t.ids[2]]));
    // Излом 0,7 рад — прямого проезда нет, главной тоже.
    const bent = junction([{ angle: 0 }, { angle: Math.PI + 0.7 }, { angle: Math.PI / 2 + 0.3 }]);
    expect(autoMainPair(bent.ends)).toBeNull();
  });

  it('«Авто»: Y-развилка и узел на две дороги — без главной', () => {
    const y = junction([{ angle: 0 }, { angle: (2 * Math.PI) / 3 }, { angle: (-2 * Math.PI) / 3 }]);
    expect(autoMainPair(y.ends)).toBeNull();
    const two = junction([{ angle: 0 }, { angle: Math.PI }]);
    expect(autoMainPair(two.ends)).toBeNull();
    expect(mainPairOf(two.ends, null)).toBeNull();
  });

  it('выбор игрока: пара — она, [] — равнозначный, не задано или чужая пара — «Авто»', () => {
    const { ends, ids } = junction([{ angle: 0, road: AVENUE }, { angle: Math.PI / 2 }, { angle: Math.PI, road: AVENUE }, { angle: -Math.PI / 2 }]);
    const auto = sorted([ids[0], ids[2]]);
    expect(mainPairOf(ends, [ids[1], ids[3]])).toEqual([ids[1], ids[3]]);
    expect(mainPairOf(ends, [])).toBeNull();
    expect(sorted(mainPairOf(ends, null))).toEqual(auto);
    expect(sorted(mainPairOf(ends, undefined))).toEqual(auto);
    // Полотно пары снесли или переименовали — снова «Авто»; кривая пара — тоже.
    expect(sorted(mainPairOf(ends, [ids[1], 999]))).toEqual(auto);
    expect(sorted(mainPairOf(ends, [ids[1]]))).toEqual(auto);
  });
});
