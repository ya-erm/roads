import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../sim/vehicle';
import { buildRoad, laneStep, laneTipAt } from './edit';
import { LaneGraph } from './graph';
import { Corridor, LaneNet, twoWay } from './model';
import { findLaneRoute } from './routing';
import { autoSolids, onSolid, solidEnds, solidLength } from './solid';
import { LaneTraffic } from './traffic';

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff' };
const corridorOf = (cls: Corridor['cls'], limit?: number) => ({ cls, limit }) as Corridor;

/** Магистраль 2+2 с запада на восток и въезд на неё с юга у x = 300: стык, за ним полоса разгона. */
function entry(): { net: LaneNet; ramp: number; west: number; east: number; after: Corridor } {
  const net = new LaneNet();
  buildRoad(net, { kind: 'free', pos: { x: 0, y: 0 } }, { kind: 'free', pos: { x: 1000, y: 0 } }, { cls: 'highway', lanes: twoWay(2, 2) });
  expect(laneStep(net, laneTipAt(net, { x: 120, y: 240 }, 14), { x: 300, y: 17.5 }, 'highway', 14).what).toBe('Въезд');
  const dead = [...net.nodes.values()].filter((n) => net.isDeadEnd(n));
  const ramp = dead.find((n) => n.pos.y > 100)!.id;
  const west = dead.find((n) => n.pos.x < 10)!.id;
  const east = dead.find((n) => n.pos.x > 990)!.id;
  const after = [...net.corridors.values()].find((c) => c.lanes.length === 5)!;
  return { net, ramp, west, east, after };
}

describe('Сплошная у стыков и перекрёстков', () => {
  it('длина — по скорости дороги, короче прежних 20 м: улица и проспект 10, магистраль 12, автомагистраль 15', () => {
    expect(solidLength(corridorOf('street'))).toBe(10);
    expect(solidLength(corridorOf('avenue'))).toBe(10);
    expect(solidLength(corridorOf('highway'))).toBe(12);
    expect(solidLength(corridorOf('motorway'))).toBe(15);
    // Своё ограничение скорости — своя длина.
    expect(solidLength(corridorOf('highway', 60))).toBe(10);
    for (const cls of ['street', 'avenue', 'highway', 'motorway'] as const) expect(solidLength(corridorOf(cls))).toBeLessThan(20);
  });

  it('после вливания — между полосой разгона и соседней, сразу за стыком; в графе движения — тот же отрезок', () => {
    const { net, after } = entry();
    const L = solidLength(after);
    const at = (offset: number) => after.lanes.findIndex((l) => Math.abs(l.offset - offset) < 0.1);
    const [aux, right, left] = [at(17.5), at(10.5), at(3.5)];
    expect(autoSolids(net, after, right, aux, 0, after.length)).toEqual([[0, L]]);
    // Между сквозными полосами — пунктир.
    expect(autoSolids(net, after, left, right, 0, after.length)).toEqual([]);
    // Граф: у правой сквозной полосы первой связи за стыком линия к полосе разгона — сплошная на те же L м.
    const graph = new LaneGraph(net);
    const link = [...graph.links.values()].find((k) => k.corridor === after.id && k.flow === 1 && k.s0 < 0.5)!;
    const lane = link.lanes.find((l) => Math.abs(l.offset - 10.5) < 0.1)!;
    expect(lane.solidZones).toEqual([[0, L]]);
    expect(link.lanes.filter((l) => l.solidZones).length).toBe(1);
    expect(solidEnds(link.lanes, link.length)).toEqual([L, 0]);
    // Машина рядом со сплошной (от хвоста до места, где пересечёт линию) — перестраиваться нельзя.
    expect(onSolid(lane.solidZones, 5, 7)).toBe(true);
    expect(onSolid(lane.solidZones, L + 6, 7)).toBe(true);
    expect(onSolid(lane.solidZones, L + 8, 7)).toBe(false);
  });

  it('машины с въезда не перестраиваются через сплошную и успевают уйти с полосы разгона; никто не теряется', () => {
    const { net, ramp, west, east, after } = entry();
    const graph = new LaneGraph(net);
    let lost = 0;
    let arrived = 0;
    const traffic = new LaneTraffic(graph, { onArrive: () => arrived++, onLost: () => lost++ });
    const fromRamp = findLaneRoute(graph, graph.outLinks.get(ramp)!, east)!;
    const through = findLaneRoute(graph, graph.outLinks.get(west)!, east)!;
    expect(fromRamp && through).toBeTruthy();
    const L = solidLength(after);
    const last = new Map<Vehicle, number>();
    const changes: { s: number; zones?: [number, number][]; length: number }[] = [];
    let spawned = 0;
    for (let t = 0; t < 90; t += 1 / 30) {
      if (Math.round(t * 30) % 45 === 0 && t < 60) {
        if (traffic.spawn({ ...CAR, targetNode: east, route: fromRamp })) spawned++;
        traffic.spawn({ ...CAR, targetNode: east, route: through });
      }
      traffic.step(1 / 30);
      for (const v of traffic.vehicles.values()) {
        const prev = last.get(v);
        last.set(v, v.lane);
        if (prev === undefined || prev === v.lane) continue;
        const a = graph.lanes.get(prev);
        const b = graph.lanes.get(v.lane);
        // Перестроение — смена полосы внутри той же связи; линия между ними — у левой из двух.
        if (!a || !b || a.link !== b.link) continue;
        const leftOne = a.index < b.index ? a : b;
        changes.push({ s: v.s, zones: leftOne.solidZones, length: v.length });
      }
    }
    expect(spawned).toBeGreaterThan(20);
    expect(lost).toBe(0);
    expect(arrived).toBeGreaterThan(spawned);
    // С полосы разгона уходят все — и ни одна машина не пересекла сплошную у стыка.
    const atMerge = changes.filter((c) => c.zones);
    expect(atMerge.length).toBeGreaterThan(10);
    for (const c of atMerge) expect(onSolid(c.zones, c.s, c.length)).toBe(false);
    // Перестраиваются сразу за сплошной, а не где-то потом: до конца полосы разгона.
    for (const c of atMerge) expect(c.s).toBeLessThan(L + 120);
  });
});
