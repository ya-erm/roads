import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { dist } from '../core/vec';
import { Game } from '../game/game';
import { breathe, freshGame, withoutCitizens } from '../game/testkit';
import { withSeed } from '../ui/newGame';
import type { Town } from './entities';
import { areaFactor, DEFAULT_SETTINGS, industryFactor, MAP_SCALE, MAP_SIZES, mapDims, NEW_GAME_SETTINGS, type WorldSettings } from './settings';
import { Terrain } from './terrain';

const edge = (t: Town) => t.extent ?? t.radius;

/** До края застройки ближайшего соседа от края каждого города, м. */
function edgeGaps(game: Game): number[] {
  return game.towns.map((t) => Math.min(...game.towns.filter((o) => o !== t).map((o) => dist(t.center, o.center) - edge(t) - edge(o))));
}

describe('Масштаб карты (WorldSettings.mapScale)', () => {
  it('новая партия — на карте в MAP_SCALE раз больше по стороне; без поля (старое сохранение) — прежний размер', () => {
    expect(MAP_SCALE).toBeGreaterThanOrEqual(1.4);
    expect(MAP_SCALE).toBeLessThanOrEqual(1.6);
    expect(NEW_GAME_SETTINGS.mapScale).toBe(MAP_SCALE);
    expect(DEFAULT_SETTINGS.mapScale).toBeUndefined();
    for (const size of ['small', 'medium', 'large'] as const) {
      expect(mapDims({ size })).toEqual({ w: MAP_SIZES[size].w, h: MAP_SIZES[size].h });
      expect(mapDims({ size, mapScale: MAP_SCALE })).toEqual({ w: Math.round(MAP_SIZES[size].w * MAP_SCALE), h: Math.round(MAP_SIZES[size].h * MAP_SCALE) });
    }
    const old = new Terrain(new Rng(3), { ...DEFAULT_SETTINGS, seed: 3 });
    expect([old.width, old.height]).toEqual([MAP_SIZES.medium.w, MAP_SIZES.medium.h]);
    const big = new Terrain(new Rng(3), { ...DEFAULT_SETTINGS, seed: 3, mapScale: MAP_SCALE });
    expect([big.width, big.height]).toEqual([mapDims({ size: 'medium', mapScale: MAP_SCALE }).w, mapDims({ size: 'medium', mapScale: MAP_SCALE }).h]);
  });

  it('вода, лес и деревья — той же густоты на гектар; предприятий — в mapScale раз больше, а не в mapScale²', () => {
    const big: WorldSettings = { ...DEFAULT_SETTINGS, mapScale: MAP_SCALE };
    expect(areaFactor(DEFAULT_SETTINGS)).toBe(1);
    expect(areaFactor(big)).toBeCloseTo(MAP_SCALE * MAP_SCALE, 2);
    expect(industryFactor(DEFAULT_SETTINGS)).toBe(1);
    expect(industryFactor(big)).toBeCloseTo(MAP_SCALE, 6);
    const old = new Terrain(new Rng(5), { ...DEFAULT_SETTINGS, seed: 5 });
    const now = new Terrain(new Rng(5), { ...big, seed: 5 });
    const density = (t: Terrain) => t.trees.length / (t.width * t.height);
    expect(density(now) / density(old)).toBeGreaterThan(0.85);
    expect(density(now) / density(old)).toBeLessThan(1.15);
  });

  it('новая игра из окна — всегда нового масштаба, даже после старой партии', () => {
    expect(withSeed({ ...DEFAULT_SETTINGS }, 77).mapScale).toBe(MAP_SCALE);
    expect(withSeed({ ...DEFAULT_SETTINGS, mapScale: 1 }, 77).mapScale).toBe(MAP_SCALE);
  });

  it('между соседними городами — поле: на средней карте край до края соседа в среднем больше 700 м, а не ~100 м', async () => {
    let sumNew = 0;
    let sumOld = 0;
    let n = 0;
    for (const seed of [1, 2, 3]) {
      const now = edgeGaps(withoutCitizens(freshGame({ ...NEW_GAME_SETTINGS, seed })));
      const old = edgeGaps(withoutCitizens(freshGame({ ...DEFAULT_SETTINGS, industryMode: 'player', seed })));
      sumNew += now.reduce((s, x) => s + x, 0) / now.length;
      sumOld += old.reduce((s, x) => s + x, 0) / old.length;
      n++;
      await breathe();
    }
    expect(sumNew / n).toBeGreaterThan(700);
    expect(sumNew / n).toBeGreaterThan(sumOld / n + 500);
  }, 90_000);

  it('старое сохранение открывается на карте прежнего размера, с той же водой; новое — на своей', () => {
    for (const settings of [{ ...DEFAULT_SETTINGS, seed: 4, size: 'small' as const }, { ...NEW_GAME_SETTINGS, seed: 4, size: 'small' as const }]) {
      const game = withoutCitizens(new Game(settings));
      const save = JSON.parse(JSON.stringify(game.toSave()));
      const loaded = withoutCitizens(new Game(save.settings, save));
      expect([loaded.terrain.width, loaded.terrain.height]).toEqual([game.terrain.width, game.terrain.height]);
      expect(loaded.terrain.rivers.map((r) => r.points.length)).toEqual(game.terrain.rivers.map((r) => r.points.length));
      expect(loaded.terrain.lakes).toEqual(game.terrain.lakes);
      expect(loaded.towns.length).toBe(game.towns.length);
    }
    const old = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 4, size: 'small' }));
    expect([old.terrain.width, old.terrain.height]).toEqual([MAP_SIZES.small.w, MAP_SIZES.small.h]);
  });
});
