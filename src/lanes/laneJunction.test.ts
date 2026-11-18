import { describe, expect, it } from 'vitest';
import { add, rightNormal, scale } from '../core/vec';
import { laneAlong, laneStep, laneTipAt } from './edit';
import { LaneGraph } from './graph';
import { LaneNet, twoWay } from './model';

const STREET = { cls: 'street' as const, lanes: twoWay(1, 1) };

function junction(angle: number, reversed: boolean, cross: boolean) {
  const net = new LaneNet();
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  const at = (s: number, offset = 0) => add(scale(dir, s), scale(rightNormal(dir), offset));
  const node = net.addJunction(at(0));
  const a = net.addSeam(at(-300), dir);
  const b = net.addSeam(at(300), reversed ? scale(dir, -1) : dir);
  const before = net.addCorridor(a.id, node.id, STREET);
  const after = net.addCorridor(reversed ? b.id : node.id, reversed ? node.id : b.id, STREET);
  const branches = (cross ? [-1, 1] : [-1]).map((side) => {
    const end = net.addSeam(at(0, side * 200), scale(rightNormal(dir), side));
    return net.addCorridor(node.id, end.id, STREET);
  });
  return { net, node, before, after, branches, at };
}

describe('Продолжение полосы через перекрёсток', () => {
  for (const angle of [0, Math.PI / 2, 2.1]) {
    for (const reversed of [false, true]) {
      for (const cross of [false, true]) {
        it(`сохраняет сторону и ход: угол ${angle}, обратная ось ${reversed}, четыре подъезда ${cross}`, () => {
          const { net, node, before, after, branches, at } = junction(angle, reversed, cross);
          const tip = laneTipAt(net, at(-150, 10.5), 14);
          expect(tip.kind).toBe('edge');
          if (tip.kind !== 'edge') throw new Error('нет края дороги');
          expect(laneAlong(net, tip, at(180, 10.5))).toBe(true);
          const step = laneStep(net, tip, at(180, 10.5), 'street', 14);
          expect(step.what).toBe('Полоса');
          expect(step.tip).toMatchObject({ kind: 'edge', corridor: after.id, offset: reversed ? -10.5 : 10.5, flow: reversed ? -1 : 1 });
          const first = before.lanes.find((l) => l.offset === 10.5)!;
          const last = after.lanes.find((l) => Math.abs(l.offset) === 10.5)!;
          expect(first).toBeDefined();
          expect(last).toBeDefined();
          expect(net.reaches(before, first, 'b')).toBe(true);
          expect(net.reaches(after, last, reversed ? 'b' : 'a')).toBe(true);
          expect(branches.every((c) => c.lanes.length === 2)).toBe(true);
          expect(net.corridors.size).toBe(cross ? 4 : 3);
          expect(net.problems()).toEqual([]);
          const graph = new LaneGraph(net);
          const incoming = graph.inLinks.get(node.id)!.find((l) => l.corridor === before.id)!.lanes.find((l) => l.offset === 10.5)!;
          expect(incoming).toBeDefined();
          expect((graph.movesFrom.get(incoming.id) ?? []).some((turn) => {
            const out = graph.links.get(turn.outLink)!;
            return out.corridor === after.id && Math.abs(graph.lanes.get(turn.outLane)!.offset) === 10.5;
          })).toBe(true);
        });
      }
    }
  }

  it('из конца уже построенной полосы у начала полотна продолжается назад через узел', () => {
    const { net, before, after, at } = junction(Math.PI / 2, false, false);
    net.setLanes(after, [...after.lanes, { offset: -10.5, flow: -1, from: 0, to: 180 }]);
    const tip = { kind: 'edge' as const, corridor: after.id, offset: -10.5, flow: -1 as const, s: 0 };
    const step = laneStep(net, tip, at(-180, -10.5), 'street', 14);
    expect(step.what).toBe('Полоса');
    expect(step.tip).toMatchObject({ corridor: before.id, offset: -10.5, flow: -1 });
    expect(net.reaches(before, before.lanes.find((l) => l.offset === -10.5)!, 'b')).toBe(true);
    expect(net.problems()).toEqual([]);
  });

  it('не принимает боковую улицу и уход в поле за продолжение полосы', () => {
    const { net, at } = junction(0, false, false);
    const tip = laneTipAt(net, at(-150, 10.5), 14);
    if (tip.kind !== 'edge') throw new Error('нет края дороги');
    expect(laneAlong(net, tip, at(10.5, -150))).toBe(false);
    expect(laneAlong(net, tip, at(150, 80))).toBe(false);
  });
});
