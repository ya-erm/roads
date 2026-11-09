import { describe, expect, it } from 'vitest';
import { STOP } from '../config';
import { dist } from '../core/vec';
import { CURB_GAP } from '../lanes/traffic';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { buildBusScene } from './bus';

/** От оси улицы 1+1 до середины обычного навеса: полуширина 8.5 + зазор 2 + полнавеса. */
const AT_STOP = LANE_W + 1.5 + 2 + STOP.size.h / 2;

describe('Тестовая страница /test/bus', { timeout: 60_000 }, () => {
  it('сцена строится целиком, у остановок есть жители, автобусы каждого маршрута обходят все его остановки', () => {
    const scene = buildBusScene();
    expect(scene.errors).toEqual([]);
    const { game } = scene;
    expect(Object.keys(scene.lines).sort()).toEqual(['avenue', 'bay', 'block', 'block2', 'both', 'side', 'straight', 'terminal']);
    expect(game.terrain.rivers).toHaveLength(0);
    expect(game.terrain.lakes).toHaveLength(0);
    expect(game.industries).toHaveLength(0);
    expect(game.roads.net.problems()).toEqual([]);
    for (const st of game.stations.values()) expect(st.catchPop, st.name).toBeGreaterThan(0);
    const visited = new Map<number, Set<number>>();
    // Зазоры у стоящих на посадке автобусов «Кармашка» (улица идёт с запада на восток: поперёк неё — по y):
    // до бордюра справа и до разметки (или оси улицы) слева; у остановок с «кармашком» и без.
    const inBay: { curb: number; mark: number; yaw: number }[] = [];
    const plain: { curb: number; mark: number; yaw: number }[] = [];
    // Заезд к бордюру и выезд от него — плавно: на шаг вбок не больше, чем по ходу, и кузов не круче ASIDE_YAW.
    const prev = new Map<number, { x: number; y: number }>();
    let shifting = 0;
    game.speed = 1;
    // Круг с разворотами в тупиках и стоянками — около двух минут.
    for (let t = 0; t < 160; t += 0.1) {
      game.update(0.1);
      for (const v of game.fleet.values()) {
        const line = game.lines.get(v.lineId)!;
        const sim = game.fleetSim(v);
        if (line.id === scene.lines.bay && sim) {
          const was = prev.get(v.id);
          if (was && sim.curb !== undefined && !sim.lateral && !sim.onMovement) {
            shifting++;
            expect(Math.abs(sim.pos.y - was.y)).toBeLessThanOrEqual(0.25 * Math.abs(sim.pos.x - was.x) + 0.05);
            expect(Math.abs(sim.dir.y)).toBeLessThanOrEqual(Math.sin(0.25) + 0.01);
          }
          prev.set(v.id, { ...sim.pos });
        }
        if (v.state !== 'loading') continue;
        const seen = visited.get(line.id) ?? new Set<number>();
        seen.add(line.stops[v.stop]);
        visited.set(line.id, seen);
        const st = game.stations.get(line.stops[v.stop])!;
        const node = game.roads.net.node(st.nodeId).pos;
        if (line.id !== scene.lines.bay || !sim) continue;
        const d = Math.abs(sim.pos.y - node.y);
        const half = sim.width / 2;
        // С «кармашком» навес отодвинут от оси дальше обычного: полос у края две, бордюр — за второй.
        const bay = dist(st.fp.center, node) > AT_STOP + 4;
        const edge = (bay ? 2 * LANE_W : LANE_W) + ROAD_MARGIN;
        const mark = bay ? LANE_W : 0;
        (bay ? inBay : plain).push({ curb: edge - d - half, mark: d - half - mark, yaw: Math.abs(sim.dir.y) });
      }
    }
    expect(shifting).toBeGreaterThan(0);
    for (const spots of [inBay, plain]) {
      expect(spots.length).toBeGreaterThan(0);
      for (const s of spots) {
        // У бордюра — с зазором CURB_GAP, до разметки слева — дальше, чем до бордюра; ровно вдоль улицы.
        expect(s.curb).toBeCloseTo(CURB_GAP, 1);
        expect(s.curb).toBeLessThan(s.mark);
        expect(s.yaw).toBeLessThan(0.01);
      }
    }
    for (const id of Object.values(scene.lines)) {
      const line = game.lines.get(id)!;
      expect(line.problem, line.name).toBeNull();
      expect(visited.get(id)?.size, line.name).toBe(line.stops.length);
      expect(line.revenueTotal, line.name).toBeGreaterThan(0);
    }
  });
});
