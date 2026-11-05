import { describe, expect, it } from 'vitest';
import { dist, scale, Vec } from '../core/vec';
import { turnArrowMarks } from '../render/turnArrows';
import { setCornerRadius } from './corners';
import { cornerKey, junctionCuts } from './geometry';
import { LaneGraph } from './graph';
import { LaneNet, twoWay } from './model';
import { changedJunctions, junctionPreview, localGraph, previewHides } from './preview';

const AVENUE = { cls: 'avenue' as const, lanes: twoWay(2, 2) };

/** Косой перекрёсток проспектов в (0, 0) и второй — в стороне: правка первого второй не трогает. */
function scene() {
  const net = new LaneNet();
  const cross = (at: Vec) => {
    const j = net.addJunction(at);
    const ids = [0, Math.PI, -0.75, Math.PI - 0.75].map((a, i) => {
      const d: Vec = { x: Math.cos(a), y: Math.sin(a) };
      const far = { x: at.x + d.x * 400, y: at.y + d.y * 400 };
      return (i % 2 === 0 ? net.addCorridor(j.id, net.addSeam(far, d).id, AVENUE) : net.addCorridor(net.addSeam(far, scale(d, -1)).id, j.id, AVENUE)).id;
    });
    return { node: j.id, ids };
  };
  return { net, a: cross({ x: 0, y: 0 }), b: cross({ x: 3000, y: 0 }) };
}

/** Стоп-линии перекрёстка node: где кончаются полосы подъездов (полотно → s конца связи у узла). */
function stops(g: LaneGraph, node: number): Map<number, number> {
  const res = new Map<number, number>();
  for (const l of g.inLinks.get(node) ?? []) res.set(l.corridor, l.flow > 0 ? l.s1 : l.s0);
  return res;
}

describe('Предпросмотр правки: стоп-линии и стрелки у перекрёстков, что она меняет', () => {
  it('изменённые перекрёстки: скругление угла, перенос узла; остальные — как в игре', () => {
    const { net, a, b } = scene();
    expect(changedJunctions(net, net.clone()).size).toBe(0);
    const round = net.clone();
    setCornerRadius(round, a.node, cornerKey(a.ids[0], a.ids[2]), 30);
    expect([...changedJunctions(net, round)]).toEqual([a.node]);
    const moved = net.clone();
    moved.moveNode(b.node, { x: 3010, y: 5 });
    expect([...changedJunctions(net, moved)]).toEqual([b.node]);
    // Перекрёстка в правке больше нет (стал стыком) — его стоп-линии из графа игры не рисуем.
    const gone = net.clone();
    gone.node(b.node).kind = 'seam';
    const p = junctionPreview(net, gone, () => junctionCuts(gone))!;
    expect(previewHides(p, b.node)).toBe(true);
    expect(previewHides(p, a.node)).toBe(false);
    expect(junctionPreview(net, net, () => junctionCuts(net))).toBeNull();
  });

  it('граф вокруг перекрёстка — те же стоп-линии, что у графа всей сети с правкой; во время протяжки они уже на новом месте', () => {
    const { net, a } = scene();
    const next = net.clone();
    setCornerRadius(next, a.node, cornerKey(a.ids[0], a.ids[2]), 30);
    const cuts = junctionCuts(next);
    const local = localGraph(next, new Set([a.node]), cuts);
    const full = new LaneGraph(next);
    expect(stops(local, a.node)).toEqual(stops(full, a.node));
    // Подъезды скруглённого угла — дальше от узла, чем было.
    const was = stops(new LaneGraph(net), a.node);
    const now = stops(local, a.node);
    const back = (id: number, m: Map<number, number>) => {
      const c = net.corridor(id);
      const s = m.get(id)!;
      return c.a === a.node ? s : c.length - s;
    };
    expect(back(a.ids[0], now)).toBeGreaterThan(back(a.ids[0], was) + 30);
    expect(back(a.ids[2], now)).toBeGreaterThan(back(a.ids[2], was) + 30);
    expect(back(a.ids[1], now)).toBeCloseTo(back(a.ids[1], was), 6);
  });

  it('стрелки перекрёстка в предпросмотре — по сети с правкой, у прочих — из графа игры', () => {
    const { net, a, b } = scene();
    const game = new LaneGraph(net);
    const next = net.clone();
    setCornerRadius(next, a.node, cornerKey(a.ids[0], a.ids[2]), 30);
    const preview = junctionPreview(net, next, () => junctionCuts(next))!;
    const marks = turnArrowMarks(game, preview);
    const want = turnArrowMarks(new LaneGraph(next));
    const at = (list: typeof marks, node: number) => list.filter((m) => m.node === node).map((m) => ({ x: m.x, y: m.y }));
    expect(at(want, a.node).length).toBeGreaterThan(0);
    // У скруглённого перекрёстка — новые места (как у графа сети с правкой), у второго — как были.
    const mine = at(marks, a.node);
    expect(mine.length).toBe(at(want, a.node).length);
    for (const p of at(want, a.node)) expect(Math.min(...mine.map((q) => dist(p, q)))).toBeLessThan(1e-6);
    expect(at(marks, a.node).some((p) => at(turnArrowMarks(game), a.node).every((q) => dist(p, q) > 5))).toBe(true);
    expect(at(marks, b.node)).toEqual(at(turnArrowMarks(game), b.node));
  });
});
