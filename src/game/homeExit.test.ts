import { describe, expect, it } from 'vitest';
import { dot } from '../core/vec';
import { CAR_SIZE } from '../world/houseAccess';
import { buildParkingScene } from '../testpages/parking';
import { homeExit } from './homeExit';
import { legPose } from './lotMoves';

describe('Разворот машины дома', () => {
  it('закрытый гараж выпускает машину передом, на открытом участке она разворачивается в пределах двора', () => {
    const scene = buildParkingScene();
    expect(scene.errors).toEqual([]);
    for (const c of scene.cases.filter((c) => c.car.place?.kind === 'garage' || c.car.place?.kind === 'pad')) {
      const spot = c.car.place!.spot;
      const legs = homeExit(spot, CAR_SIZE.l, CAR_SIZE.w);
      expect(legs, c.title).not.toBeNull();
      const end = legPose(legs!.at(-1)!, legs!.at(-1)!.len);
      expect(dot(end.h, spot.d.dir), c.title).toBeLessThan(-0.99);
      if (c.car.place!.kind === 'garage') expect(legs!.every((l) => !l.back)).toBe(true);
      else {
        expect(legs!.length).toBeLessThanOrEqual(5);
        const last = legs!.at(-1)!;
        expect(last.len).toBeCloseTo(5);
        expect(dot(legPose(last, 0).h, spot.d.dir)).toBeLessThan(-0.99);
      }
    }
  }, 30_000);
});
