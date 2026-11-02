import { describe, expect, it } from 'vitest';
import { add, dist, Vec } from '../core/vec';
import { Game } from './game';
import { road, roadPlan } from './testkit';

const RING = { lanes: 1, size: 'medium' as const };

function runSeconds(game: Game, seconds: number) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) game.update(0.1);
}

/** Перекрёсток двух улиц в чистом поле; концы — тупики на сторонах света. */
function crossroads(game: Game): { c: Vec; arms: Vec[] } {
  for (let y = 600; y < game.terrain.height - 600; y += 140) {
    for (let x = 600; x < game.terrain.width - 600; x += 170) {
      const c = { x, y };
      const arms = [
        { x: -300, y: 0 },
        { x: 300, y: 0 },
        { x: 0, y: -300 },
        { x: 0, y: 300 },
      ].map((d) => add(c, d));
      if (!roadPlan(game, { free: arms[0] }, { free: arms[1] }).ok || !roadPlan(game, { free: arms[2] }, { free: arms[3] }).ok) continue;
      if (game.roads.net.corridorsNear(c, 400).length) continue;
      road(game, { free: arms[0] }, { free: arms[1] });
      road(game, { free: arms[2] }, { free: arms[3] });
      return { c, arms };
    }
  }
  throw new Error('Нет места');
}

describe('Кольцо', () => {
  it('кольцо на месте перекрёстка: по нему проезжают со всех сторон, Ctrl+Z возвращает перекрёсток', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    const { c, arms } = crossroads(game);
    const net = () => game.roads.net;
    const junction = net().nodesNear(c, 1)[0];
    expect(junction.kind).toBe('junction');
    const plan = game.roundaboutPlan(c, 14, RING);
    expect(plan.reason ?? 'ok').toBe('ok');
    expect(plan.cost).toBeGreaterThan(0);
    game.checkpoint('кольцо');
    expect(game.buildRoundabout(c, 14, RING)).toBe(true);
    game.commit();
    expect(net().nodes.has(junction.id)).toBe(false);
    const entries = [...net().nodes.values()].filter((n) => n.roundabout === junction.id && n.kind === 'junction');
    expect(entries).toHaveLength(4);
    expect([...net().corridors.values()].filter((x) => x.ring).length).toBeGreaterThanOrEqual(4);
    expect(game.roundaboutCenters.get(junction.id)).toEqual(c);
    expect(net().problems()).toEqual([]);
    // На въездах кольцо главное.
    const g = game.roads.graph;
    for (const e of entries) {
      const prio = g.nodes.get(e.id)!.priorityLanes;
      for (const l of g.inLinks.get(e.id) ?? []) {
        const ring = net().corridor(l.corridor).ring;
        expect(l.lanes.every((lane) => prio.has(lane.id))).toBe(!!ring);
      }
    }
    // Светофор на кольцо не ставится.
    expect(game.lightsPlan(entries[0].id).reason).toBe('Это кольцо');
    // Машины со всех четырёх сторон во все стороны — доезжают.
    const ends = arms.map((p) => net().nodesNear(p, 1)[0].id);
    const ours = new Set<number>();
    const arrivals = game.traffic.arrivals;
    for (const from of ends) {
      for (const to of ends) {
        if (from === to) continue;
        const route = game.roads.route(from, to);
        expect(route).not.toBeNull();
        for (let k = 0; k < 50; k++) {
          const v = game.traffic.spawn({ kind: 'car', length: 7, width: 4, maxSpeed: 20, accel: 8, color: '#fff', targetNode: to, route: route! });
          runSeconds(game, 0.5);
          if (v) {
            ours.add(v.id);
            break;
          }
        }
      }
    }
    expect(ours.size).toBe(12);
    runSeconds(game, 90);
    // Все доехали: кольцо не запирается.
    expect([...ours].filter((id) => game.traffic.vehicles.has(id))).toEqual([]);
    expect(game.traffic.arrivals - arrivals).toBeGreaterThanOrEqual(12);
    // Новый въезд: дорога, которая кончается на дуге кольца, — ещё один узел кольца.
    const ring = [...net().corridors.values()].find((x) => x.ring)!;
    const mid = ring.lut.pointAt(ring.length / 2);
    const out = add(c, { x: (mid.x - c.x) * 4, y: (mid.y - c.y) * 4 });
    expect(road(game, { free: out }, mid)).toBe(true);
    expect([...net().nodes.values()].filter((n) => n.roundabout === junction.id && n.kind === 'junction')).toHaveLength(5);
    // Сохранение — с кольцом и его центром.
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.roundaboutCenters.get(junction.id)).toEqual(c);
    expect([...loaded.roads.net.corridors.values()].filter((x) => x.ring).length).toBe([...net().corridors.values()].filter((x) => x.ring).length);
    // Второе кольцо рядом не трогает центр первого; испорченный центр чинится сам.
    const other = crossroads(game);
    expect(game.buildRoundabout(other.c, 14, { lanes: 2, size: 'large' })).toBe(true);
    expect(game.roundaboutCenters.get(junction.id)).toEqual(c);
    const second = [...game.roundaboutCenters.entries()].find(([id]) => id !== junction.id)!;
    expect(dist(second[1], other.c)).toBeLessThan(1);
    game.roundaboutCenters.set(junction.id, { x: 0, y: 0 });
    const repaired = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(dist(repaired.roundaboutCenters.get(junction.id)!, c)).toBeLessThan(1);
    game.roundaboutCenters.set(junction.id, c);
    // Отмена до кольца: перекрёсток на месте.
    game.undo();
    game.undo();
    game.undo();
    expect(net().nodes.get(junction.id)?.kind).toBe('junction');
    expect([...net().corridors.values()].some((x) => x.ring)).toBe(false);
  });
});
