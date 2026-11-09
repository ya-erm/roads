import { describe, expect, it } from 'vitest';
import { dist, scale, Vec } from '../core/vec';
import type { RoadClass } from '../world/roadTypes';
import { junctionRuts } from './dirtRuts';
import { LaneRenderer } from './draw';
import { pointOff, sFrom } from './geometry';
import { LaneNet, twoWay } from './model';

/** Перекрёсток в (0, 0) с ветками 1+1 по углам (рад) длиной 300 м, класс каждой ветки — classes[i]. */
function junction(angles: number[], classes: RoadClass[]) {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 });
  angles.forEach((a, i) => {
    const d: Vec = { x: Math.cos(a), y: Math.sin(a) };
    net.addCorridor(j.id, net.addSeam(scale(d, 300), d).id, { cls: classes[i], lanes: twoWay(1, 1) });
  });
  return { net, node: net.node(j.id) };
}

/** Холст, который запоминает линии: цвет, толщину и точки каждой (подпути — по moveTo). */
function recorder() {
  const strokes: { style: string; width: number; paths: Vec[][] }[] = [];
  let paths: Vec[][] = [];
  const state: Record<string | symbol, unknown> = {};
  const api: Record<string, (...a: number[]) => void> = {
    beginPath: () => void (paths = []),
    moveTo: (x, y) => void paths.push([{ x, y }]),
    lineTo: (x, y) => void paths[paths.length - 1]?.push({ x, y }),
    stroke: () => void strokes.push({ style: String(state.strokeStyle), width: Number(state.lineWidth), paths: paths.map((p) => [...p]) }),
  };
  const ctx = new Proxy(state, {
    get: (t, k) => (typeof k === 'string' && k in api ? api[k] : k in t ? t[k] : () => {}),
    set: (t, k, v) => ((t[k] = v), true),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

const RUT = 'rgba(150, 135, 105, 0.2)';

describe('Колеи грунтовки на перекрёстке', () => {
  it('на Т-образном перекрёстке грунтовок колея — с каждой полосы подъезда на каждую дорогу, кроме своей', () => {
    const { net, node } = junction([0, Math.PI / 2, Math.PI], ['dirt', 'dirt', 'dirt']);
    const r = new LaneRenderer();
    const cuts = r.cutsOf(net);
    const ruts = junctionRuts(net, node, cuts);
    // Три подъезда по одной полосе к узлу, с каждой — на две другие дороги.
    expect(ruts).toHaveLength(6);
    // Колеи начинаются и кончаются посередине полос у обреза подъезда — там, где кончаются колеи полотен.
    const lanes = net.ends(node).flatMap((e) => {
      const cut = cuts.get(e.corridor.id)![e.end === 'a' ? 0 : 1];
      const s = sFrom(e.corridor, e.end, cut);
      return e.corridor.lanes.map((l) => pointOff(e.corridor, s, l.offset));
    });
    const near = (p: Vec) => Math.min(...lanes.map((q) => dist(p, q)));
    for (const pts of ruts) {
      expect(near(pts[0])).toBeLessThan(0.5);
      expect(near(pts[pts.length - 1])).toBeLessThan(0.5);
    }
  });

  it('если хоть один подъезд асфальтовый — площадка асфальтовая, колей по ней нет', () => {
    const { net, node } = junction([0, Math.PI / 2, Math.PI], ['dirt', 'street', 'street']);
    expect(junctionRuts(net, node, new LaneRenderer().cutsOf(net))).toEqual([]);
  });

  it('отрисовка: колеи площадки — одной линией с колеями полотен; бордюров и белой разметки у грунтовки нет', () => {
    const { net } = junction([0, Math.PI / 2, Math.PI, -Math.PI / 2], ['dirt', 'dirt', 'dirt', 'dirt']);
    const { ctx, strokes } = recorder();
    new LaneRenderer().draw(ctx, net, 1);
    const ruts = strokes.filter((s) => s.style === RUT);
    expect(ruts).toHaveLength(1);
    // Четыре полотна по две колеи и по площадке: с каждой из четырёх полос подъезда — на три дороги.
    expect(ruts[0].paths).toHaveLength(8 + 12);
    // По площадке (около узла) колеи есть.
    expect(ruts[0].paths.some((p) => p.some((q) => Math.hypot(q.x, q.y) < 4))).toBe(true);
    const drawn = strokes.filter((s) => s.paths.some((p) => p.length > 1));
    expect(drawn.some((s) => s.style === '#4b525c' || s.style.startsWith('rgba(245, 243, 230'))).toBe(false);
  });
});
