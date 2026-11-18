import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { dot, sub } from '../core/vec';
import { boxesOverlap } from '../lanes/curb';
import type { Vehicle } from '../sim/vehicle';
import { buildParkingScene } from '../testpages/parking';
import { CAR_SIZE } from '../world/houseAccess';
import { roadPlan, STREET } from './testkit';

const CAR = { kind: 'car' as const, length: CAR_SIZE.l, width: CAR_SIZE.w, maxSpeed: 60, accel: 10, color: '#888' };

describe('Машина пропускает поток при выезде', () => {
  it('задним ходом из тесного места — только на ближайшую полосу и после освобождения выезда', () => {
    const { game, cases } = buildParkingScene();
    const c = cases[0];
    const x = c.view.x0 + 35;
    const y = c.view.y0 + 110;
    const plan = roadPlan(game, { x: x + 155, y }, { x: x + 155, y: y + 145 }, STREET);
    expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
    const spot = game.shops.lotOf(c.destination)!.spots.find((s) => game.garages.leftSlotOf(s))!;
    const right = game.garages.slotOf(spot)!;
    const left = game.garages.leftSlotOf(spot)!;
    const blocker = game.traffic.placeOnLane({ ...CAR, targetNode: right.link.toNode! }, right.lane.id, (right.zone[0] + right.zone[1]) / 2)!;
    game.traffic.holdAfter(blocker, 0);
    game.garages.leave(spot, c.town, left.link.toNode!, { from: c.destination, to: c.car.home });
    game.speed = 1;
    for (let i = 0; i < 30 * 12; i++) game.update(SIM_DT);
    const waiting = game.garages.moveOf(spot.key)!;
    expect(waiting.phase).toBe('wait');
    expect(waiting.sim).toBeUndefined();
    game.traffic.release(blocker);
    let joined = false;
    for (let i = 0; i < 30 * 90 && !joined; i++) {
      game.update(SIM_DT);
      const m = game.garages.moves.find((m) => m.home.key === spot.key);
      if (m?.sim) {
        joined = true;
        expect(m.forward).toBe(false);
        expect(m.via?.lane.id).toBe(right.lane.id);
        expect(m.via?.cross).toBeUndefined();
        expect(m.blink).toBeTruthy();
      }
    }
    expect(joined).toBe(true);
  });

  it('передний выезд налево ждёт машины на ближней полосе и пересекает её без столкновения', () => {
    const scene = buildParkingScene();
    const { game } = scene;
    const c = scene.cases[9];
    scene.startAction(9, 'home-out');
    const spot = c.car.place!.spot;
    const near = game.garages.slotOf(spot)!;
    const u = near.mid + dot(sub(spot.curbSide, near.pos), near.f);
    let blocker: Vehicle | null = null;
    let waiting = 0;
    let joined = false;
    let hits = 0;
    const box = (v: Vehicle) => ({ c: { x: v.pos.x - v.dir.x * v.length / 2, y: v.pos.y - v.dir.y * v.length / 2 }, d: v.dir, hl: v.length / 2 - 0.2, hw: v.width / 2 - 0.2 });
    for (let i = 0; i < 30 * 90; i++) {
      game.update(SIM_DT);
      scene.tick();
      const m = game.garages.moves.find((m) => m.home.key === spot.key && m.kind === 'out');
      if (m && !m.sim && !blocker && m.run.i === m.run.legs.length - 1) {
        blocker = game.traffic.placeOnLane({ ...CAR, targetNode: near.link.toNode! }, near.lane.id, u + 5)!;
        game.traffic.holdAfter(blocker, 0);
      }
      if (m?.phase === 'wait') {
        waiting += SIM_DT;
        if (waiting > 1) game.traffic.release(blocker!);
      }
      if (m?.sim && m.via?.cross) {
        joined = true;
        expect(m.forward).toBe(true);
        if (blocker && game.traffic.vehicles.has(blocker.id) && boxesOverlap(box(m.sim), box(blocker))) hits++;
      }
      if (joined && !m) break;
    }
    expect(blocker).not.toBeNull();
    expect(waiting).toBeGreaterThan(1);
    expect(joined).toBe(true);
    expect(hits).toBe(0);
  });
});
