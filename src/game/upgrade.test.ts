import { describe, expect, it } from 'vitest';
import { halfWidth, RoadSpec } from '../world/roadTypes';
import { footprintCorners } from '../world/spatial';
import { Game } from './game';

const AVENUE: RoadSpec = { cls: 'avenue', lanesF: 2, lanesB: 2 };

describe('Перестройка дороги', () => {
  it('расширенная улица отодвигает дома, которые на неё налезли', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    // Улица города с домами вдоль неё.
    const seg = town.streets
      .map((id) => game.net.segments.get(id))
      .find((s) => s && s.spec.cls === 'street' && s.length > 120 && town.buildings.filter((b) => s.lut.closest(b.fp.center).d < 30).length >= 3)!;
    expect(seg).toBeDefined();
    const near = town.buildings.filter((b) => seg.lut.closest(b.fp.center).d < 40 && b.kind !== 'landmark');
    const houses = town.buildings.length;
    expect(game.builder.upgrade(seg.lut.pointAt(seg.length / 2), AVENUE, 4)).toBe(true);
    const edge = halfWidth(AVENUE);
    // Ни один дом не стоит на расширенной дороге.
    for (const b of town.buildings) {
      if (b.kind === 'landmark') continue;
      const hit = seg.lut.closest(b.fp.center);
      if (hit.s <= 1 || hit.s >= seg.length - 1) continue;
      for (const c of footprintCorners(b.fp)) expect(seg.lut.closest(c).d).toBeGreaterThan(edge);
    }
    // Большинство домов отодвинулось, а не снесено.
    const kept = near.filter((b) => town.buildings.includes(b)).length;
    expect(kept).toBeGreaterThan(near.length / 2);
    expect(town.buildings.length).toBeGreaterThan(houses - near.length);
  });
});
