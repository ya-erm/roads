import { describe, expect, it } from 'vitest';
import { CAR_SIZE } from '../world/houseAccess';
import { yardLotOf, yardSpots } from '../world/yardLots';
import { buildParkingScene } from '../testpages/parking';
import { carSpot } from './garages';
import { pocketExit } from './pocketExit';
import { stallKey } from './shopParking';

describe('Выезд из кармана передом', () => {
  it('у панельного дома есть места, откуда можно развернуться в кармане, не заезжая задом на дорогу', () => {
    const scene = buildParkingScene();
    const b = scene.cases[2].car.home;
    const lot = yardLotOf(b)!;
    const spots = yardSpots(b, lot, CAR_SIZE.l).spots;
    let found = 0;
    spots.forEach((s, k) => {
      if (!s.drive) return;
      const spot = carSpot(stallKey(b.id, k), b, s.drive, true, '#f00', CAR_SIZE.l);
      const plan = pocketExit(spot, [], CAR_SIZE.l, CAR_SIZE.w);
      if (plan) {
        expect(plan.at(-1)!.back).toBe(false);
        found++;
      }
    });
    expect(found).toBeGreaterThan(0);
  }, 30_000);
});
