import { describe, expect, it } from 'vitest';
import { STOP } from '../config';
import { dist } from '../core/vec';
import { LANE_W } from '../world/roadTypes';
import { buildBusScene } from './bus';

/** От оси улицы 1+1 до середины обычного навеса: полуширина 8.5 + зазор 2 + полнавеса. */
const AT_STOP = LANE_W + 1.5 + 2 + STOP.size.h / 2;

describe('Тестовая страница /test/bus', { timeout: 60_000 }, () => {
  it('сцена строится целиком, у остановок есть жители, автобусы каждого маршрута обходят все его остановки', () => {
    const scene = buildBusScene();
    expect(scene.errors).toEqual([]);
    const { game } = scene;
    expect(Object.keys(scene.lines).sort()).toEqual(['avenue', 'bay', 'block', 'block2', 'both', 'straight', 'terminal']);
    expect(game.terrain.rivers).toHaveLength(0);
    expect(game.terrain.lakes).toHaveLength(0);
    expect(game.industries).toHaveLength(0);
    expect(game.roads.net.problems()).toEqual([]);
    for (const st of game.stations.values()) expect(st.catchPop, st.name).toBeGreaterThan(0);
    const visited = new Map<number, Set<number>>();
    // Где стоят автобусы у остановок с «кармашком» (навес отодвинут от оси дальше обычного): от оси улицы.
    const inBay: number[] = [];
    game.speed = 1;
    // Круг с разворотами в тупиках и стоянками — около двух минут.
    for (let t = 0; t < 160; t += 0.1) {
      game.update(0.1);
      for (const v of game.fleet.values()) {
        if (v.state !== 'loading') continue;
        const line = game.lines.get(v.lineId)!;
        const seen = visited.get(line.id) ?? new Set<number>();
        seen.add(line.stops[v.stop]);
        visited.set(line.id, seen);
        const st = game.stations.get(line.stops[v.stop])!;
        const node = game.roads.net.node(st.nodeId).pos;
        const sim = game.fleetSim(v);
        // Улица «Кармашка» идёт с запада на восток: поперёк неё — по y.
        if (line.id === scene.lines.bay && sim && dist(st.fp.center, node) > AT_STOP + 4) inBay.push(Math.abs(sim.pos.y - node.y));
      }
    }
    expect(inBay.length).toBeGreaterThan(0);
    for (const d of inBay) expect(d).toBeCloseTo(LANE_W * 1.5, 0);
    for (const id of Object.values(scene.lines)) {
      const line = game.lines.get(id)!;
      expect(line.problem, line.name).toBeNull();
      expect(visited.get(id)?.size, line.name).toBe(line.stops.length);
      expect(line.revenueTotal, line.name).toBeGreaterThan(0);
    }
  });
});
