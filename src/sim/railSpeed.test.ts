import { describe, expect, it } from 'vitest';
import { type Cubic, straightCubic } from '../core/bezier';
import { Network } from '../world/network';
import { RAIL_SPEC } from '../world/roadTypes';
import { RailSim } from './rail';
import { mapSpeedsUnder, railUnder, trackKmh, trackKmhExact, trackSpeed } from './railSpeed';

function line(net: Network, a: { x: number; y: number }, b: { x: number; y: number }, level = 0) {
  const na = net.addNode(a, level);
  const nb = net.addNode(b, level);
  return net.addSegment(na.id, nb.id, straightCubic(a, b), RAIL_SPEC);
}

/** Дуга радиуса r на угол sweep вокруг c — один участок пути. */
function arc(net: Network, c: { x: number; y: number }, r: number, sweep: number) {
  const at = (a: number) => ({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  const k = (4 / 3) * Math.tan(sweep / 4) * r;
  const p0 = at(0);
  const p3 = at(sweep);
  const curve: Cubic = { p0, p1: { x: p0.x, y: p0.y + k }, p2: { x: p3.x + k * Math.sin(sweep), y: p3.y - k * Math.cos(sweep) }, p3 };
  const na = net.addNode(p0);
  const nb = net.addNode(p3);
  return net.addSegment(na.id, nb.id, curve, RAIL_SPEC);
}

describe('скорость ж/д пути на карте скоростей', () => {
  it('прямой путь — предел пути 120 км/ч, крутой изгиб — ниже, кратно 10', () => {
    const net = new Network();
    const straight = line(net, { x: 0, y: 0 }, { x: 400, y: 0 });
    const sharp = arc(net, { x: 0, y: 1000 }, 120, Math.PI / 4);
    const wide = arc(net, { x: 3000, y: 1000 }, 800, Math.PI / 8);
    expect(trackKmh(straight)).toBe(120);
    // v² = 5·R: R 120 → ≈24.5 ед. ≈ 54 км/ч — подписью 50.
    expect(trackKmhExact(sharp)).toBeGreaterThan(50);
    expect(trackKmhExact(sharp)).toBeLessThan(60);
    expect(trackKmh(sharp)).toBe(50);
    // Пологий изгиб скорость не снижает.
    expect(trackKmh(wide)).toBe(120);
  });

  it('та же скорость, по которой едут поезда', () => {
    const net = new Network();
    const sharp = arc(net, { x: 0, y: 0 }, 200, Math.PI / 3);
    const sim = new RailSim(net, { onArrive: () => {}, onLost: () => {} });
    expect(sim.segSpeed(sharp.id)).toBeCloseTo(trackSpeed(sharp), 6);
  });

  it('путь под курсором: на земле дорога поверх пути, на мосту — путь', () => {
    const net = new Network();
    line(net, { x: 0, y: 0 }, { x: 400, y: 0 });
    line(net, { x: 0, y: 300 }, { x: 400, y: 300 }, 1);
    expect(railUnder(net, { x: 200, y: 2 })?.level).toBe(0);
    expect(railUnder(net, { x: 200, y: 40 })).toBeNull();
    // Пусто под курсором — пусто и в подписи; только путь — его скорость.
    expect(mapSpeedsUnder(net, { x: 200, y: 80 }, [])).toEqual([]);
    expect(mapSpeedsUnder(net, { x: 200, y: 0 }, [])).toEqual([120]);
    // Переезд: дорога на земле — её скорость.
    expect(mapSpeedsUnder(net, { x: 200, y: 0 }, [40])).toEqual([40]);
    // Путь на мосту над дорогой — его.
    expect(mapSpeedsUnder(net, { x: 200, y: 300 }, [40])).toEqual([120]);
  });
});
