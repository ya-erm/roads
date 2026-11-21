import { describe, expect, it } from 'vitest';
import { dist, scale, sub } from '../core/vec';
import { boxesOverlap } from '../lanes/curb';
import { steerBase, vehicleBoxes } from '../sim/body';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { bayPose, industryYardWidth, MODELS, type Pose } from './transport';
import { YARD_EXIT_SPEED, yardEntryMotion, yardExitArcs, yardExitMotion, yardPathsConflict, type YardPose } from './yardManeuver';

describe('Траектории у соседних грузовых постов', () => {
  const bays = 5;
  const yard = { center: { x: 0, y: 0 }, w: industryYardWidth(bays), h: 56, angle: 0 };
  const gateX = yard.w / 2 + 5;
  const model = MODELS.truck3;
  if (model.mode !== 'road') throw new Error('Фура должна быть дорожным транспортом');
  const truck = model.spec;
  const parked = Array.from({ length: bays }, (_, i) => bayPose(yard, bays, i, truck.length, 1, true));
  const boxes = (pose: Pose & { trail?: Pose['pos'] }) => vehicleBoxes(pose.pos, pose.dir, truck.length, truck.width, truck.body, pose.trail);

  it('у центрального выезда фура входит в полосу одной дугой с обеих половин двора', () => {
    const bays = 8;
    const yard = { center: { x: 0, y: 0 }, w: industryYardWidth(bays), h: 39, angle: 0 };
    const road = { pos: { x: LANE_W / 2, y: yard.h / 2 + 5 + truck.length * 0.9 }, dir: { x: 0, y: 1 } };
    const base = truck.length * steerBase(truck.body);
    for (const bay of [3, 4]) {
      const spot = bayPose(yard, bays, bay, truck.length, 1, true);
      const { path, arc } = yardExitArcs(spot, road, truck, yard)[0];
      expect(arc).toBe('smooth');
      expect(path.forwardRadius).toBeGreaterThan(base);
      const side = Math.sign(road.pos.x - spot.pos.x);
      const stopped = path(path.reverseUntil);
      expect(stopped.dir.x).toBe(side);
      expect(stopped.dir.y).toBeCloseTo(0);
      const axle = (p: YardPose) => sub(p.pos, scale(p.dir, base));
      const neighbors = Array.from({ length: bays }, (_, i) => i === bay ? [] : boxes(bayPose(yard, bays, i, truck.length, 1, true))).flat();
      let previous = axle(stopped);
      let finished = false;
      for (let t = 0; t < 60; t += 0.05) {
        const p = path(t);
        expect(boxes(p).some((a) => neighbors.some((b) => boxesOverlap(a, b))), `пост ${bay}, ${t.toFixed(2)} с, реверс до ${path.reverseUntil.toFixed(2)} с (${p.pos.x.toFixed(1)}, ${p.pos.y.toFixed(1)})`).toBe(false);
        if (t >= path.reverseUntil) {
          const at = axle(p);
          expect(at.y).toBeGreaterThanOrEqual(previous.y - 0.001);
          expect((at.x - previous.x) * side).toBeGreaterThanOrEqual(-0.001);
          expect((at.x - road.pos.x) * side).toBeLessThanOrEqual(0.001);
          previous = at;
        }
        if (p.done) {
          finished = true;
          break;
        }
      }
      expect(finished).toBe(true);
    }
  });

  it('замечает касание кормой соседней фуры между двумя отсчётами прогноза', () => {
    const bays = 8;
    const yard = { center: { x: 0, y: 0 }, w: industryYardWidth(bays), h: 56, angle: 0 };
    const spot = bayPose(yard, bays, 5, truck.length, -1, true);
    const neighbor = bayPose(yard, bays, 4, truck.length, -1, true);
    const road = { pos: { x: LANE_W / 2, y: -43 }, dir: { x: 0, y: -1 } };
    const path = yardExitMotion(spot, road, truck, yard, 'smooth');
    expect(path.smooth).toBe(true);
    expect(yardPathsConflict(
      { pose: (t) => path(t * YARD_EXIT_SPEED), spec: truck, parks: true },
      { pose: () => ({ ...neighbor, done: true }), spec: truck, parks: true },
    )).toBe(true);
  });

  it('автобус с крайнего поста выпрямляется вдоль поперечного проезда перед боковым выездом', () => {
    const model = MODELS.bus2;
    if (model.mode !== 'road') throw new Error('Нужен автобус');
    const { spec } = model;
    const spot = bayPose(yard, bays, bays - 1, spec.length, 1, true);
    const road = { pos: { x: gateX + 8, y: yard.h / 2 + 9 }, dir: { x: 1, y: 0 } };
    const motion = yardExitMotion(spot, road, spec, yard);
    let aligned = false;
    for (let t = 0; t < 30; t += 0.05) {
      const p = motion(t);
      if (p.pos.x < spot.pos.x && p.dir.x > 0.999) {
        expect(Math.abs(p.pos.y - road.pos.y)).toBeLessThan(1);
        aligned = true;
        break;
      }
    }
    expect(aligned).toBe(true);
  });

  it('длинный прицеп остаётся на площадке при выезде к двухполосной дороге', () => {
    const bays = 8;
    const yard = { center: { x: 0, y: 0 }, w: industryYardWidth(bays), h: 56, angle: 0 };
    const gateY = yard.h / 2 + 5;
    const road = { pos: { x: LANE_W / 2, y: gateY + truck.length * 0.6 }, dir: { x: 0, y: 1 } };
    for (let i = 0; i < bays; i++) {
      const motion = yardExitMotion(bayPose(yard, bays, i, truck.length, 1, true), road, truck, yard);
      for (let t = 0; t < 60; t += 0.1) {
        const pose = motion(t);
        const trailer = boxes(pose)[1];
        for (const end of [-trailer.hl, trailer.hl]) {
          for (const side of [-trailer.hw, trailer.hw]) {
            const x = trailer.c.x + end * trailer.d.x - side * trailer.d.y;
            const y = trailer.c.y + end * trailer.d.y + side * trailer.d.x;
            if (Math.abs(x) > LANE_W + ROAD_MARGIN) expect(y, `пост ${i + 1}, ${t.toFixed(1)} с`).toBeLessThanOrEqual(gateY + 1.5);
          }
        }
        if (pose.done) break;
      }
    }
  });

  it.each(['truck', 'truck2', 'truck3'] as const)('выезд %s из заполненного ряда на восемь постов', (id) => {
    const bays = 8;
    const yard = { center: { x: 0, y: 0 }, w: industryYardWidth(bays), h: 56, angle: 0 };
    const model = MODELS[id];
    if (model.mode !== 'road') throw new Error('Нужен грузовик');
    const { spec } = model;
    for (const x of [3.5, 10.5, -10.5]) {
      for (let bay = 0; bay < bays; bay++) {
        const spot = bayPose(yard, bays, bay, spec.length, 1, true);
        const neighbors = Array.from({ length: bays }, (_, i) => i === bay ? [] : boxes(bayPose(yard, bays, i, truck.length, 1, true))).flat();
        const motion = yardExitMotion(spot, { pos: { x, y: 33 + spec.length * 0.6 }, dir: { x: 0, y: 1 } }, spec, yard);
        let finished = false;
        for (let t = 0; t < 60; t += 0.1) {
          const p = motion(t);
          const body = vehicleBoxes(p.pos, p.dir, spec.length, spec.width, spec.body, p.trail);
          expect(body.some((a) => neighbors.some((b) => boxesOverlap(a, b))), `полоса ${x}, пост ${bay + 1}, ${t.toFixed(1)} c`).toBe(false);
          if (p.done) {
            finished = true;
            break;
          }
        }
        expect(finished).toBe(true);
      }
    }
  });

  it.each([
    { name: 'фасад', enter: { pos: { x: -3.5, y: 33 }, dir: { x: 0, y: -1 } }, exit: { pos: { x: 3.5, y: 46 }, dir: { x: 0, y: 1 } } },
    { name: 'левый торец', enter: { pos: { x: -gateX, y: 34.5 }, dir: { x: 1, y: 0 } }, exit: { pos: { x: -gateX - 13, y: 41.5 }, dir: { x: -1, y: 0 } } },
    { name: 'правый торец', enter: { pos: { x: gateX, y: 34.5 }, dir: { x: -1, y: 0 } }, exit: { pos: { x: gateX + 13, y: 41.5 }, dir: { x: 1, y: 0 } } },
  ])('фура проезжает через $name между занятыми постами', ({ enter, exit }) => {
    const issues: string[] = [];
    for (const [i, spot] of parked.entries()) {
      const neighbors = parked.filter((_, j) => i !== j).flatMap(boxes);
      const check = (label: string, poseAt: (t: number) => YardPose) => {
        let previous = poseAt(0);
        for (let t = 0; t < 60; t += 0.1) {
          const pose = poseAt(t);
          expect(dist(previous.pos, pose.pos)).toBeLessThan(2);
          previous = pose;
          if (boxes(pose).some((a) => neighbors.some((b) => boxesOverlap(a, b)))) {
            issues.push(`${label} ${i} @ ${t.toFixed(1)} (${pose.pos.x.toFixed(1)}, ${pose.pos.y.toFixed(1)})`);
            break;
          }
          if (pose.done) break;
        }
      };
      check('въезд', yardEntryMotion({ ...enter, v0: 6, t: 0 }, spot, truck));
      check('выезд', yardExitMotion(spot, exit, truck, yard));
    }
    expect(issues).toEqual([]);
  });
});
