import { describe, expect, it } from 'vitest';
import { RoadTools } from '../input/roadtools';
import type { RoadSpec } from '../world/roadTypes';
import { footprintCorners } from '../world/spatial';
import { corridorHalf } from '../world/worldgen';
import { Game } from './game';
import { townStreets } from './testkit';

const AVENUE: RoadSpec = { cls: 'avenue', lanesF: 2, lanesB: 2 };

describe('Перестройка дороги', () => {
  it('расширенная улица отодвигает дома, которые на неё налезли', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    // Улица города с домами вдоль неё.
    const seg = townStreets(game, town.id).find(
      (s) => s.cls === 'street' && s.length > 120 && town.buildings.filter((b) => s.lut.closest(b.fp.center).d < 30).length >= 3,
    )!;
    expect(seg).toBeDefined();
    const near = town.buildings.filter((b) => seg.lut.closest(b.fp.center).d < 40 && b.kind !== 'landmark');
    const houses = town.buildings.length;
    const tools = new RoadTools(() => game);
    expect(tools.upgrade(seg.lut.pointAt(seg.length / 2), AVENUE, 4)).toBeNull();
    const wide = game.roads.net.corridor(seg.id);
    expect(wide.cls).toBe('avenue');
    expect(wide.lanes).toHaveLength(4);
    const edge = corridorHalf(wide);
    // Ни один дом не стоит на расширенной дороге.
    for (const b of town.buildings) {
      if (b.kind === 'landmark') continue;
      const hit = wide.lut.closest(b.fp.center);
      if (hit.s <= 1 || hit.s >= wide.length - 1) continue;
      for (const c of footprintCorners(b.fp)) expect(wide.lut.closest(c).d).toBeGreaterThan(edge);
    }
    // Большинство домов отодвинулось, а не снесено.
    const kept = near.filter((b) => town.buildings.includes(b)).length;
    expect(kept).toBeGreaterThan(near.length / 2);
    expect(town.buildings.length).toBeGreaterThan(houses - near.length);
  });
});
