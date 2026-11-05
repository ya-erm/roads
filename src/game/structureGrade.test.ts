import { describe, expect, it } from 'vitest';
import { GRADE } from '../config';
import type { Vec } from '../core/vec';
import { RoadTools } from '../input/roadtools';
import { RAIL_SPEC } from '../world/roadTypes';
import { Game } from './game';
import { steepText, structureGradeProblem } from './grade';
import { roadPlan } from './testkit';

const SPEC = { cls: 'highway' as const, lanesF: 1, lanesB: 1 };

describe('Уклон моста, эстакады и тоннеля', () => {
  it('не круче, чем у дороги на земле: мост 220 м с перепадом 96 м — нельзя, пологий — можно', () => {
    expect(structureGradeProblem(10, 106, 220, GRADE.road)).toBe('Слишком крутой подъём: 44% (можно до 10%) — удлините дорогу');
    expect(structureGradeProblem(106, 10, 220, GRADE.road)).toMatch(/44%/);
    expect(structureGradeProblem(10, 25, 220, GRADE.road)).toBeUndefined();
    // Ровно на пределе (и в пределах округления высот) — можно.
    expect(structureGradeProblem(0, 22.4, 220, GRADE.road)).toBeUndefined();
    // У ж/д предел меньше.
    expect(structureGradeProblem(0, 15, 220, GRADE.rail)).toBe('Слишком крутой подъём: 7% (можно до 3,5%) — удлините дорогу');
  });

  it('пандус — с запасом на насыпь у подножия: обычный съезд на мост в 70 м проходит, по крутому склону — нет', () => {
    expect(structureGradeProblem(0, GRADE.bridgeDeck, 70, GRADE.road, GRADE.roadDepth)).toBeUndefined();
    expect(structureGradeProblem(0, GRADE.bridgeDeck, 70, GRADE.road)).toMatch(/Слишком крутой подъём/);
    expect(structureGradeProblem(0, 60 + GRADE.bridgeDeck, 200, GRADE.road, GRADE.roadDepth)).toMatch(/34%/);
  });

  it('чуть круче предела — с десятыми', () => {
    expect(steepText(0.104, 0.1)).toBe('Слишком крутой подъём: 10,4% (можно до 10%) — удлините дорогу');
    expect(steepText(-0.33, 0.1)).toBe('Слишком крутой подъём: 33% (можно до 10%) — удлините дорогу');
  });
});

describe('Стройка моста по склону', () => {
  /** Чистое место и склон: земля поднимается на slope м на метр к востоку от x0. */
  function slope(k: number) {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 500_000_000, water: 'dry' });
    let from: Vec | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !from; y += 120) {
      for (let x = 300; x < game.terrain.width - 700 && !from; x += 160) {
        if (roadPlan(game, { free: { x, y } }, { free: { x: x + 300, y } }).ok) from = { x, y };
      }
    }
    if (!from) throw new Error('нет места');
    const x0 = from.x;
    game.ground = () => (p: Vec) => 20 + k * (p.x - x0);
    return { game, from };
  }

  const bridge = (game: Game, from: Vec, length: number, auto: boolean, rise: number | null = null, level = 1) => {
    const rt = new RoadTools(() => game);
    rt.level = auto ? 0 : level;
    rt.auto = auto;
    rt.begin(from, 10);
    rt.rise = rise;
    return rt.buildPlan({ x: from.x + length, y: from.y }, SPEC, 'straight', 10, false, true, auto ? undefined : level)!;
  };

  it('«Тоннель» вручную — тоже: под склоном 44% нельзя, под пологим — можно', () => {
    const steep = slope(96 / 220);
    expect(bridge(steep.game, steep.from, 220, false, null, -1).reason).toMatch(/^Слишком крутой подъём: 44%/);
    const gentle = slope(0.05);
    expect(bridge(gentle.game, gentle.from, 220, false, null, -1).reason).toBeUndefined();
  });

  it('«Мост» вручную: 220 м по склону 44% (96 м) — нельзя, красным с причиной; по склону 5% — можно', () => {
    const steep = slope(96 / 220);
    const bad = bridge(steep.game, steep.from, 220, false);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/^Слишком крутой подъём: 44% \(можно до 10%\)/);
    const gentle = slope(0.05);
    expect(bridge(gentle.game, gentle.from, 220, false).ok).toBe(true);
  });

  it('«Авто»: до цели на 96 м выше за 220 м не дотянуть — та же ошибка; на 14 м выше за 220 м — мост строится', () => {
    const flat = slope(0);
    const bad = bridge(flat.game, flat.from, 220, true, 96);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/^Слишком крутой подъём: 44% \(можно до 10%\)/);
    const ok = bridge(flat.game, flat.from, 220, true, 14);
    expect(ok.reason).toBeUndefined();
    expect(ok.ok).toBe(true);
    // Мост там и правда есть.
    expect([...ok.net!.nodes.values()].some((n) => n.level > 0)).toBe(true);
  });

  it('ж/д мост по склону 10% — нельзя (у путей предел 3,5%), по склону 2% — можно', () => {
    for (const [k, ok] of [
      [0.1, false],
      [0.02, true],
    ] as const) {
      const { game, from } = slope(k);
      const plan = game.builder.plan({
        start: { kind: 'free', pos: from, level: 1 },
        end: { kind: 'free', pos: { x: from.x + 260, y: from.y }, level: 1 },
        spec: RAIL_SPEC,
        mode: 'straight',
      });
      if (ok) expect(plan.reason).toBeUndefined();
      else expect(plan.reason).toMatch(/^Слишком крутой подъём: 10% \(можно до 3,5%\)/);
    }
  });
});
