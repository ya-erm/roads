import { describe, expect, it } from 'vitest';
import { LaneRenderer } from '../lanes/draw';
import { buildRoad } from '../lanes/edit';
import { LaneNet, twoWay } from '../lanes/model';
import type { ParkingLot } from './entities';
import { defaultGates, LOT, lotDepth, lotGateNode, lotGateNodes, lotIsBig, lotLayout, lotLocal, lotStallCount, lotWidth, type LotRows } from './parkingLots';

/** Площадка cols × rows у улицы по оси x (y = 0): край у улицы — в 20 ед. от оси, ворота посередине. */
function lotAt(cols: number, rows: LotRows): Pick<ParkingLot, 'id' | 'fp' | 'gates'> {
  const W = lotWidth(cols);
  const H = lotDepth(rows);
  // Угол 0 — улица со стороны −y участка.
  return { id: 1, fp: { center: { x: 0, y: 20 + H / 2 }, w: W, h: H, angle: 0 }, gates: defaultGates(W) };
}

/** Перекрываются ли место (в осях участка) и полосы тупика-выезда ворот x до узла. */
const underStub = (r: { x: number; y: number; w: number }, x: number, nodeY: number): boolean =>
  r.y < nodeY - 0.05 && r.x + r.w > x - LOT.stubHalf + 0.05 && r.x < x + LOT.stubHalf - 0.05;

describe('Площадка: въезд большой через тупик-выезд', () => {
  it('под полосами тупика-выезда мест нет — они убраны из вместимости', () => {
    for (const [cols, rows] of [
      [7, 4],
      [11, 4],
      [13, 2],
      [20, 2],
    ] as [number, LotRows][]) {
      const lot = lotAt(cols, rows);
      const L = lotLayout(lot);
      expect(L.big).toBe(true);
      expect(lotIsBig(lot)).toBe(true);
      for (const g of lot.gates) expect(L.stalls.some((s) => underStub(s.rect, g.x, L.nodeY))).toBe(false);
      // Убраны только места переднего ряда у въезда: по одному с каждой стороны поперечного проезда.
      expect(lotStallCount(lot)).toBe(cols * rows - 2);
    }
    // 2 × 13 = 26 мест — больше LOT.big, хоть без двух под въездом их 24: ворота всё так же через узел.
    expect(lotStallCount(lotAt(13, 2))).toBe(LOT.big);
    expect(lotIsBig(lotAt(13, 2))).toBe(true);
  });

  it('маленькая площадка и большая в 1 ряд (проезд у улицы) — места те же', () => {
    expect(lotStallCount(lotAt(6, 2))).toBe(12);
    expect(lotIsBig(lotAt(6, 2))).toBe(false);
    expect(lotStallCount(lotAt(10, 4))).toBe(38);
    // Один ряд: узел — в проезде у края, места — за ним.
    expect(lotStallCount(lotAt(26, 1))).toBe(26);
  });

  it('у тупика-выезда на площадке нет разворота: полотно обрывается у узла ворот', () => {
    const lot = lotAt(11, 4);
    const g = lot.gates[0];
    const net = new LaneNet();
    const [street] = buildRoad(net, { kind: 'free', pos: { x: -200, y: 0 } }, { kind: 'free', pos: { x: 200, y: 0 } }, { cls: 'street', lanes: twoWay(1, 1) });
    const { node: end, curb } = lotGateNode(lot, g);
    const s = street.lut.closest(curb).s;
    buildRoad(net, { kind: 'corridor', corridor: street.id, s, pos: street.lut.pointAt(s) }, { kind: 'free', pos: end }, { cls: 'highway', lanes: twoWay(1, 1) });
    const node = net.nodesNear(end, 2)[0];
    expect(net.isDeadEnd(node)).toBe(true);
    // Узел ворот — внутри площадки, в первом проезде.
    expect(lotLocal(lot.fp, node.pos).y).toBeCloseTo(lotLayout(lot).nodeY, 1);
    const box = (r: LaneRenderer) => {
      let b = { x0: 0, y0: 0, x1: 0, y1: 0 };
      r.eachItem(net, (kind, id, _sig, bb) => {
        if (kind === 'node' && id === node.id) b = bb;
      });
      return Math.max(b.x1 - b.x0, b.y1 - b.y0);
    };
    // Обычный тупик — с разворотом во всю ширину полотна.
    const plain = new LaneRenderer();
    expect(box(plain)).toBeGreaterThan(2 * LOT.stubHalf);
    // Узел ворот большой площадки — без разворота (рамка узла — сама точка), и сразу — у уже нарисованной сети.
    const nodes = lotGateNodes([{ lots: [{ ...lot, owner: 'player', tariff: 0, nodes: [node.id] }] }]);
    expect([...nodes]).toEqual([node.id]);
    plain.setOpenEnds(nodes);
    expect(box(plain)).toBeLessThan(0.01);
    // Площадку снесли — ворот нет, разворот снова есть.
    plain.setOpenEnds(lotGateNodes([{ lots: [{ ...lot, owner: 'player', tariff: 0, nodes: [node.id], removed: true }] }]));
    expect(box(plain)).toBeGreaterThan(2 * LOT.stubHalf);
  });
});
