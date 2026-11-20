import { describe, expect, it } from 'vitest';
import { add, norm, scale, sub } from '../core/vec';
import { boxesOverlap } from './curb';
import { LaneDemand } from './demand';
import { LaneGraph } from './graph';
import { LaneNet, twoWay } from './model';
import { LaneTraffic } from './traffic';
import type { Vehicle } from '../sim/vehicle';

const CAR = { kind: 'car' as const, length: 7.5, width: 3.6, maxSpeed: 60, accel: 10, color: '#aaa' };

/** Геометрия приложенного шаблона «Моя развязка»: широкий остроугольный узел у скруглённого квартала. */
function roundedJunction(lights = false) {
  const net = new LaneNet();
  const center = { x: 11.9786372124845, y: 1.5680152699987957 };
  const j = net.addJunction(center);
  const sw = net.addSeam({ x: -120.68045896717103, y: 47.94623777497873 }, norm(sub(center, { x: -120.68045896717103, y: 47.94623777497873 })));
  const nw = net.addSeam({ x: -118.85848435748903, y: -84.87861507087655 }, { x: -0.84350782545605, y: -0.5371168852255584 });
  const e = net.addSeam({ x: 120.6803237956401, y: 4.38732969042394 }, { x: 0.9996586206174396, y: 0.026127422858717213 });
  const s = net.addSeam({ x: 17.14594279913308, y: 84.8751223588315 }, { x: 0.06065626577567463, y: 0.9981587135431673 });
  const a = net.addCorridor(sw.id, j.id, { cls: 'street', lanes: twoWay(1, 1) });
  const b = net.addCorridor(j.id, nw.id, { cls: 'street', lanes: twoWay(1, 1), curve: { p0: center, p1: { x: -11.388952943480945, y: -13.28916284252773 }, p2: { x: -64.35747969252134, y: -50.17424246889823 }, p3: nw.pos } });
  const c = net.addCorridor(j.id, e.id, { cls: 'avenue', lanes: twoWay(2, 2) });
  const d = net.addCorridor(j.id, s.id, { cls: 'street', lanes: twoWay(1, 1) });
  j.corners = { [`${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`]: 13 };
  j.mainPair = [a.id, c.id];
  if (lights) j.control = 'lights';
  const graph = new LaneGraph(net);
  const minor = [...graph.moves.values()].find((m) => graph.links.get(m.inLink)?.corridor === b.id && graph.links.get(m.outLink)?.corridor === c.id)!;
  const major = [...graph.moves.values()].find((m) => graph.links.get(m.inLink)?.corridor === c.id && graph.links.get(m.outLink)?.corridor === a.id)!;
  return { graph, minor, major, j, corridors: { a, b, c, d } };
}

describe('Уступание внутри широкого скруглённого перекрёстка', () => {
  it('подъезжает к зоне уступания внутри узла, пропускает главную и заканчивает поездку без пересечения кузовов', () => {
    const { graph, minor, major } = roundedJunction();
    const traffic = new LaneTraffic(graph, { onArrive() {}, onLost() {} });
    const place = (m: typeof minor) => traffic.placeOnLane({ ...CAR, targetNode: graph.links.get(m.outLink)!.toNode!, endLink: m.outLink }, m.inLane, graph.lanes.get(m.inLane)!.length - 1)!;
    const white = place(major);
    for (let i = 0; i < 150 && !white.onMovement; i++) traffic.step(1 / 30);
    expect(white.onMovement).toBe(major.key);
    const conflict = major.zones.get(minor.key)!;
    traffic.holdAfter(white, Math.max(0, (conflict[0] + conflict[1]) / 2 - white.s));
    const gray = place(minor);
    const clear = () => {
      if (!traffic.vehicles.has(gray.id) || !traffic.vehicles.has(white.id)) return;
      const box = (v: typeof gray) => ({ c: add(v.pos, scale(v.dir, -v.length / 2)), d: v.dir, hl: v.length / 2, hw: v.width / 2 });
      expect(boxesOverlap(box(gray), box(white))).toBe(false);
    };
    for (let i = 0; i < 30 * 10; i++) { traffic.step(1 / 30); clear(); }
    expect(gray.onMovement).toBe(minor.key);
    expect(gray.s).toBeGreaterThan(CAR.length + 3);
    expect(gray.s).toBeLessThan(minor.length / 2);
    expect(gray.v).toBeLessThan(0.5);
    const stoppedAt = gray.s;
    traffic.rebind(new LaneGraph(graph.net, undefined, graph));
    for (let i = 0; i < 30 * 2; i++) { traffic.step(1 / 30); clear(); }
    expect(gray.s).toBeCloseTo(stoppedAt, 1);
    traffic.release(white);
    for (let i = 0; i < 30 * 30; i++) { traffic.step(1 / 30); clear(); }
    expect(traffic.arrivals).toBe(2);
  });

  it('красный и занятая зебра сохраняют остановку до въезда в узел', () => {
    for (const lights of [true, false]) {
      const { graph, minor, major } = roundedJunction(lights);
      const traffic = new LaneTraffic(graph, { onArrive() {}, onLost() {} });
      const lane = graph.lanes.get(minor.inLane)!;
      if (lights) {
        const L = graph.nodes.get(minor.node!)!.lights!;
        L.phase = L.phases.findIndex((p) => p.moves.has(major.key) && !p.moves.has(minor.key));
        expect(L.phase).toBeGreaterThanOrEqual(0);
        L.timer = 1000;
      } else {
        const link = graph.links.get(lane.link)!;
        traffic.walks.set(link.corridor, [{ s: graph.axisS(lane, lane.length - 5), flow: link.flow, stop: 0, closed: true, busy: false }]);
      }
      const gray = traffic.placeOnLane({ ...CAR, targetNode: graph.links.get(minor.outLink)!.toNode!, endLink: minor.outLink }, lane.id, lane.length - 20)!;
      for (let i = 0; i < 30 * 10; i++) traffic.step(1 / 30);
      expect(gray.onMovement).toBeNull();
      expect(gray.s).toBeLessThan(lane.length);
    }
  });

  it('не задерживает автомобиль на главной, который едет через центр узла', () => {
    const simulate = (withMinor: boolean) => {
      const { graph, minor, major } = roundedJunction();
      const traffic = new LaneTraffic(graph, { onArrive() {}, onLost() {} });
      const lane = graph.lanes.get(major.inLane)!;
      const white = traffic.placeOnLane({ ...CAR, targetNode: graph.links.get(major.outLink)!.toNode!, endLink: major.outLink }, lane.id, lane.length - 15)!;
      white.v = 10;
      if (withMinor) traffic.placeOnLane({ ...CAR, targetNode: graph.links.get(minor.outLink)!.toNode!, endLink: minor.outLink }, minor.inLane, graph.lanes.get(minor.inLane)!.length - 1);
      const speeds: number[] = [];
      let advanced = false;
      for (let i = 0; i < 30 * 8; i++) {
        traffic.step(1 / 30);
        speeds.push(white.v);
        if (withMinor) advanced ||= [...traffic.vehicles.values()].some((v) => v !== white && v.onMovement === minor.key && v.s > 1 && white.onMovement === major.key);
      }
      return { speeds, advanced };
    };
    const alone = simulate(false);
    const together = simulate(true);
    expect(together.advanced).toBe(true);
    expect(together.speeds).toEqual(alone.speeds);
  });

  it('при повторных поездках по разным направлениям узел не запирается частичными бронями', () => {
    const { graph } = roundedJunction();
    let lost = 0;
    const traffic = new LaneTraffic(graph, { onArrive() {}, onLost() { lost++; } });
    let seed = 7;
    const demand = new LaneDemand(traffic, 2, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; });
    for (let i = 0; i < 30 * 180; i++) {
      demand.update(1 / 30);
      traffic.step(1 / 30);
    }
    for (let i = 0; i < 30 * 180 && traffic.vehicles.size; i++) traffic.step(1 / 30);
    expect(lost).toBe(0);
    expect(traffic.arrivals).toBeGreaterThan(50);
    expect(traffic.vehicles.size).toBe(0);
  });

  it.each([
    { name: 'скорая с мигалкой', move: '14>4', siren: true },
    { name: 'обычная машина с более ранней очередью', move: '18>4', siren: false },
  ])('$name ждёт, пока частично въехавшая машина освободит её путь', ({ move, siren }) => {
    const { graph } = roundedJunction();
    const arrived: Vehicle[] = [];
    const traffic = new LaneTraffic(graph, { onArrive: (v) => arrived.push(v), onLost() {} });
    const stand = (key: string, emergency = false) => {
      const m = graph.moves.get(key)!;
      const lane = graph.lanes.get(m.inLane)!;
      const v = traffic.placeOnLane({
        ...CAR, siren: emergency, targetNode: graph.links.get(m.outLink)!.toNode!, endLink: m.outLink,
      }, lane.id, lane.length - 1)!;
      v.planned = m.key;
      v.lcCooldown = Infinity;
      return v;
    };
    const step = () => traffic.step(1 / 30);
    const first = stand('2>11');
    for (let i = 0; i < 150 && !first.onMovement; i++) step();
    expect(first.onMovement).toBe('2>11');
    const zone = graph.moves.get(first.onMovement!)!.zones.get('8>16')!;
    traffic.holdAfter(first, (zone[0] + zone[1]) / 2 - first.s);
    const inside = stand('8>16');
    for (let i = 0; i < 30 * 20; i++) step();
    expect(inside.onMovement).toBe('8>16');
    expect(inside.v).toBeLessThan(0.5);

    const approaching = stand(move, siren);
    for (let i = 0; i < 60; i++) step();
    expect(approaching.onMovement).toBeNull();
    if (!siren) approaching.requestTime = inside.requestTime - 1;
    traffic.remove(first);

    const box = (v: Vehicle) => ({ c: add(v.pos, scale(v.dir, -v.length / 2)), d: v.dir, hl: v.length / 2, hw: v.width / 2 });
    for (let i = 0; i < 30 * 20 && traffic.vehicles.size; i++) {
      step();
      if (traffic.vehicles.has(inside.id) && traffic.vehicles.has(approaching.id)) {
        expect(boxesOverlap(box(inside), box(approaching))).toBe(false);
      }
    }
    expect(arrived).toHaveLength(2);
  });
});
