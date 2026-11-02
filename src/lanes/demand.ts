import type { VehicleSpec } from '../sim/vehicle';
import { findLaneRoute } from './routing';
import type { LaneTraffic } from './traffic';

const CAR_COLORS = ['#e5534b', '#2f80ed', '#f2c94c', '#27ae60', '#9b51e0', '#f2994a', '#56ccf2', '#eb5757', '#ffffff'];

/**
 * Поток машин для лаборатории и тестов: из каждого тупика, откуда можно выехать, время от времени
 * выезжает машина в случайный другой тупик, куда есть путь.
 */
export class LaneDemand {
  private timers = new Map<number, number>();

  constructor(
    private readonly traffic: LaneTraffic,
    /** Средний промежуток между машинами из одного тупика, с. */
    public interval = 4,
    private readonly rng: () => number = Math.random,
    /** Во сколько раз реже выезжают из отдельных тупиков (у перекрёстка без светофора поток поменьше). */
    private readonly sparse: Map<number, number> = new Map(),
  ) {}

  update(dt: number): void {
    const g = this.traffic.graph;
    for (const [nodeId, outs] of g.outLinks) {
      if (!g.net.isDeadEnd(g.net.node(nodeId))) continue;
      let t = (this.timers.get(nodeId) ?? this.rng() * this.interval) - dt;
      if (t <= 0) {
        const targets = [...g.inLinks.keys()].filter((id) => id !== nodeId && g.net.isDeadEnd(g.net.node(id)));
        // Цели — в случайном порядке, первая, куда есть путь.
        for (let i = targets.length - 1; i > 0; i--) {
          const j = Math.floor(this.rng() * (i + 1));
          [targets[i], targets[j]] = [targets[j], targets[i]];
        }
        for (const target of targets) {
          const route = findLaneRoute(g, outs, target);
          if (!route) continue;
          this.traffic.spawn({ ...this.spec(), targetNode: target, route });
          break;
        }
        t = this.interval * (this.sparse.get(nodeId) ?? 1) * (0.5 + this.rng());
      }
      this.timers.set(nodeId, t);
    }
  }

  private spec(): VehicleSpec {
    const color = CAR_COLORS[Math.floor(this.rng() * CAR_COLORS.length)];
    return this.rng() < 0.15
      ? { kind: 'truck', length: 12, width: 4.6, maxSpeed: 38, accel: 6, color, load: '#c9b28f' }
      : { kind: 'car', length: 7, width: 4, maxSpeed: 55 + this.rng() * 10, accel: 10, color };
  }
}
