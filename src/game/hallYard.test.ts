import { describe, expect, it } from 'vitest';
import { add, type Vec } from '../core/vec';
import type { TownBuilding } from '../world/entities';
import { inPolygon, junctionPlate, lotOutline, polyDist } from '../world/lotClear';
import { WALK_EDGE } from '../world/roadTypes';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { yardOf } from '../world/townForms';
import { halfAtS, landmarkClear } from '../world/worldgen';
import type { Game } from './game';
import { breathe, fieldSpot, freshGame, road, STREET } from './testkit';

/**
 * Площадь вокруг ратуши и храма (townForms.yardOf) — за тротуаром, не ближе WALK_EDGE к асфальту полотен и площадок
 * перекрёстков: и в сгенерированном городе (worldgen.placeLandmark, curbTown), и после переноса с поворотом (Game.movePlan).
 */

/** Наименьший зазор от контура участка с площадью (через 1 м) до асфальта: края полотен и площадок перекрёстков, м. */
function asphaltGap(game: Game, b: TownBuilding): number {
  const net = game.roads.net;
  const yard = yardOf(b);
  let gap = Infinity;
  for (const q of lotOutline({ ...b.fp, w: b.fp.w + yard * 2, h: b.fp.h + yard * 2 }, 1)) {
    for (const c of net.corridorsNear(q, 120)) {
      const hit = c.lut.closest(q);
      gap = Math.min(gap, hit.d - halfAtS(c, hit.s));
    }
    for (const n of net.nodesNear(q, 150)) {
      const plate = junctionPlate(net, n);
      if (plate) gap = Math.min(gap, inPolygon(q, plate) ? -polyDist(q, plate) : polyDist(q, plate));
    }
  }
  return gap;
}

function expectClear(game: Game, hall: TownBuilding, what: string): void {
  expect(asphaltGap(game, hall), what).toBeGreaterThanOrEqual(WALK_EDGE - 0.05);
  expect(landmarkClear(game.roads.net, hall), what).toBe(true);
}

const halls = (game: Game) => game.towns.flatMap((town) => town.buildings.filter((b) => b.kind === 'landmark').map((hall) => ({ town, hall })));

describe('площадь вокруг ратуши — не на дороге', () => {
  it('в сгенерированных городах на нескольких seed (со стоянками у бордюра и без)', async () => {
    let all = 0;
    for (const setup of [42, { ...NEW_GAME_SETTINGS, seed: 1 }, { ...NEW_GAME_SETTINGS, seed: 4 }, { ...NEW_GAME_SETTINGS, seed: 5 }]) {
      const game = freshGame(setup);
      for (const { town, hall } of halls(game)) {
        expectClear(game, hall, `${JSON.stringify(setup)}: ${town.name}`);
        all++;
      }
      await breathe();
    }
    expect(all).toBeGreaterThan(25);
  }, 90_000);

  it('после переноса и поворота', () => {
    const game = freshGame(42);
    game.money = 10_000_000;
    const { hall } = halls(game).sort((a, b) => b.town.population - a.town.population)[0];
    const at = fieldSpot(game, 600);
    expect(road(game, { free: at }, { free: add(at, { x: 600, y: 0 }) }, STREET)).toBe(true);
    const beside = (off: number): Vec => add(at, { x: 300, y: off });
    expect(game.moveBuilding(hall, beside(60))).toBe(true);
    expectClear(game, hall, 'перенос');
    for (const turn of [Math.PI / 6, Math.PI / 4, Math.PI / 2]) {
      expect(game.moveBuilding(hall, beside(70), turn)).toBe(true);
      expectClear(game, hall, `поворот ${turn}`);
    }
  });
});
