import { describe, expect, it } from 'vitest';
import { add, scale, Vec } from '../core/vec';
import { ROAD_CLASSES } from '../world/roadTypes';
import { Game } from './game';
import { road, roadPlan, STREET } from './testkit';

const free = (pos: Vec, level = 0) => ({ kind: 'free' as const, pos, level });

function runSeconds(game: Game, seconds: number, each?: () => void) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) {
    game.update(0.1);
    each?.();
  }
}

describe('Уровни дорог', () => {
  it('через реку дорога на земле — мост (дороже), опора в воде — нельзя', () => {
    const game = new Game({ seed: 7, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'normal' });
    let checked = false;
    for (let y = 300; y < game.terrain.height - 300 && !checked; y += 40) {
      for (let x = 300; x < game.terrain.width - 300 && !checked; x += 40) {
        const w = { x, y };
        if (!game.isWater(w, 12)) continue;
        for (let k = 0; k < 8 && !checked; k++) {
          const d = { x: Math.cos((k * Math.PI) / 4), y: Math.sin((k * Math.PI) / 4) };
          const a = add(w, scale(d, -160));
          const b = add(w, scale(d, 160));
          if (game.isWater(a, 30) || game.isWater(b, 30)) continue;
          const plan = roadPlan(game, { free: a }, { free: b });
          if (!plan.ok) continue;
          checked = true;
          // Над водой — мост: заметно дороже такого же отрезка на земле.
          const dry = 320 * ROAD_CLASSES.street.cost * 2;
          expect(plan.cost).toBeGreaterThan(dry * 1.3);
          const pier = roadPlan(game, { free: w }, { free: b });
          expect(pier.reason).toBe('Опора в воде — нужен мост');
        }
      }
    }
    expect(checked).toBe(true);
  });

  it('эстакада над улицей с пандусами: перекрёстка нет, машины проезжают поверху', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    let o: Vec | null = null;
    for (let y = 600; y < game.terrain.height - 600 && !o; y += 120) {
      for (let x = 600; x < game.terrain.width - 600 && !o; x += 160) {
        const c = { x, y };
        const ok =
          roadPlan(game, { free: add(c, { x: -400, y: 0 }) }, { free: add(c, { x: 400, y: 0 }) }).ok &&
          roadPlan(game, { free: add(c, { x: -40, y: -400 }) }, { free: add(c, { x: -40, y: 400 }) }).ok &&
          roadPlan(game, { free: add(c, { x: 40, y: -400 }) }, { free: add(c, { x: 40, y: 400 }) }).ok;
        if (ok) o = c;
      }
    }
    expect(o).not.toBeNull();
    const c = o!;
    const corridors = game.roads.net.corridors.size;
    expect(road(game, { free: add(c, { x: -400, y: 0 }) }, { free: add(c, { x: 400, y: 0 }) })).toBe(true);
    // С севера: земля → пандус на мост → мост над улицей → пандус вниз → земля.
    const pts = [
      free(add(c, { x: 0, y: -400 })),
      free(add(c, { x: 0, y: -200 })),
      free(add(c, { x: 0, y: -90 }), 1),
      free(add(c, { x: 0, y: 90 }), 1),
      free(add(c, { x: 0, y: 200 })),
      free(add(c, { x: 0, y: 400 })),
    ];
    for (let i = 1; i < pts.length; i++) {
      const plan = game.roadBuilder.road(i === 1 ? pts[0] : { kind: 'node', node: game.roads.net.nodesNear(pts[i - 1].pos, 1)[0].id, pos: pts[i - 1].pos }, pts[i], STREET);
      expect(plan.reason ?? 'ok').toBe('ok');
      game.roadBuilder.apply(plan);
    }
    const net = game.roads.net;
    expect(net.corridors.size).toBe(corridors + 1 + 5);
    expect([...net.nodes.values()].filter((n) => n.kind === 'junction' && Math.hypot(n.pos.x - c.x, n.pos.y - c.y) < 50)).toHaveLength(0);
    expect(net.problems()).toEqual([]);
    const north = net.nodesNear(pts[0].pos, 1)[0].id;
    const south = net.nodesNear(pts[5].pos, 1)[0].id;
    const route = game.roads.route(north, south);
    expect(route).not.toBeNull();
    const car = game.traffic.spawn({ kind: 'car', length: 7, width: 4, maxSpeed: 20, accel: 8, color: '#fff', targetNode: south, route: route! });
    expect(car).not.toBeNull();
    let top = 0;
    let arrived = false;
    const before = game.traffic.arrivals;
    runSeconds(game, 60, () => {
      if (game.traffic.vehicles.has(car!.id)) top = Math.max(top, car!.level);
      else arrived = game.traffic.arrivals > before;
    });
    expect(top).toBeCloseTo(1, 5);
    expect(arrived).toBe(true);
  });
});
