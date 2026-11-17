import { describe, expect, it } from 'vitest';
import { addCurb } from '../world/curbStreets';
import { CURB, curbStalls } from './curb';
import { EditError, retypeLaneSpan } from './edit';
import { edgesAt, junctionCuts } from './geometry';
import { LaneGraph } from './graph';
import { LaneNet, taperLen, twoWay } from './model';

/** Проспект 2+2 со стоянками с обеих сторон, на восток — к перекрёстку B с поперечной улицей. */
function avenue(L = 300) {
  const net = new LaneNet();
  const A = net.addJunction({ x: 0, y: 0 });
  const B = net.addJunction({ x: L, y: 0 });
  const c = net.addCorridor(A.id, B.id, { cls: 'avenue', lanes: twoWay(2, 2) });
  net.addCorridor(B.id, net.addJunction({ x: L, y: 200 }).id, { cls: 'street', lanes: twoWay(1, 1) });
  net.addCorridor(B.id, net.addJunction({ x: L, y: -200 }).id, { cls: 'street', lanes: twoWay(1, 1) });
  expect(addCurb(net, net.corridor(c.id), 1)).toBe(true);
  expect(addCurb(net, net.corridor(c.id), -1)).toBe(true);
  return { net, id: c.id, L };
}

/** Места правой (по ходу на восток) стороны. */
const stalls = (net: LaneNet, id: number) => {
  const c = net.corridor(id);
  const cut = junctionCuts(net).get(id)!;
  return c.lanes.flatMap((l, i) => (l.park && l.offset > 0 ? curbStalls(net, c, i, cut, [false, false], []) : []));
};
const sorted = (net: LaneNet, id: number) => [...net.corridor(id).lanes].sort((x, y) => x.offset - y.offset || x.from - y.from);

describe('Участок полосы стоянки — полоса поворота (retypeLaneSpan)', () => {
  it('последние 60 перед перекрёстком — полоса поворота до стоп-линии, места — до границы участка, бордюр без «талии»', () => {
    const { net, id, L } = avenue();
    const T = taperLen('avenue');
    const before = stalls(net, id);
    const was = sorted(net, id);
    const i = net.corridor(id).lanes.findIndex((l) => l.park && l.offset > 0);
    // Тянут от перекрёстка до точки (как в игре — и чуть за узел).
    expect(retypeLaneSpan(net, net.corridor(id), i, L + 5, L - 60)).toBe('drive');
    expect(net.problems()).toEqual([]);
    const c = net.corridor(id);
    const P = c.lanes.find((l) => l.park && l.offset > 0)!;
    const D = c.lanes.find((l) => !l.park && l.offset > 15)!;
    // Полоса движения шириной LANE_W вплотную к правой полосе: отгон — внутри участка, дальше — до самого узла.
    expect(D).toMatchObject({ offset: 17.5, flow: 1, from: L - 60 + T, to: L });
    expect(P).toMatchObject({ offset: 15.75, from: 0, to: L - 60 + T });
    // По ней едут до стоп-линии: у перекрёстка в эту сторону три полосы.
    const g = new LaneGraph(net);
    const cut = junctionCuts(net).get(id)![1];
    const link = g
      .corridorLinks(id)
      .filter((k) => k.flow === 1)
      .reduce((x, y) => (y.s1 > x.s1 ? y : x));
    expect(link.s1).toBeGreaterThanOrEqual(L - cut - 1);
    expect(link.lanes).toHaveLength(3);
    expect(link.lanes.map((x) => c.lanes[x.laneIdx])).toContain(D);
    expect(link.s0).toBeLessThanOrEqual(L - cut - 10);
    // Места — до границы участка и ни одного на нём; прежние до неё — те же.
    const after = stalls(net, id);
    expect(after.every((s) => s.s + CURB.stallLen / 2 <= L - 60 + 1e-6)).toBe(true);
    expect(Math.max(...after.map((s) => s.s + CURB.stallLen / 2))).toBeGreaterThan(L - 60 - CURB.stallLen);
    const keys = new Set(after.map((s) => s.key));
    expect(before.filter((s) => s.s + CURB.stallLen / 2 <= L - 60).every((s) => keys.has(s.key))).toBe(true);
    // Кромка: до участка — по стоянке (17,5), у перекрёстка — по полосе поворота (21); между — только шире.
    let prev = edgesAt(c, L - 70)![1];
    expect(prev).toBeCloseTo(17.5, 6);
    for (let s = L - 70; s <= L; s += 1) {
      const e = edgesAt(c, s)![1];
      expect(e).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = e;
    }
    expect(prev).toBeCloseTo(21, 6);
    // Обратно: тянут вдоль полосы поворота — как было до правки.
    expect(retypeLaneSpan(net, c, c.lanes.indexOf(D), L, D.from)).toBe('park');
    expect(net.problems()).toEqual([]);
    expect(sorted(net, id)).toEqual(was);
    expect(stalls(net, id).map((s) => s.key)).toEqual(before.map((s) => s.key));
  });

  it('участок посреди полосы — отгоны с обеих сторон; вся полоса поворота обратно — как было', () => {
    const { net, id } = avenue();
    const T = taperLen('avenue');
    const was = sorted(net, id);
    const i = net.corridor(id).lanes.findIndex((l) => l.park && l.offset > 0);
    retypeLaneSpan(net, net.corridor(id), i, 100, 200);
    expect(net.problems()).toEqual([]);
    const c = net.corridor(id);
    expect(c.lanes.filter((l) => l.park && l.offset > 0)).toHaveLength(2);
    const D = c.lanes.find((l) => !l.park && l.offset > 15)!;
    expect(D.from).toBeCloseTo(100 + T, 6);
    expect(D.to).toBeCloseTo(200 - T, 6);
    expect(stalls(net, id).some((s) => s.s + CURB.stallLen / 2 > 100 && s.s - CURB.stallLen / 2 < 200)).toBe(false);
    retypeLaneSpan(net, c, c.lanes.indexOf(D), -Infinity, Infinity);
    expect(sorted(net, id)).toEqual(was);
  });

  it('не крайнюю полосу движения под стоянку — нельзя', () => {
    const { net, id } = avenue();
    const c = net.corridor(id);
    expect(() => retypeLaneSpan(net, c, c.lanes.findIndex((l) => l.offset === 3.5), 100, 200)).toThrow(EditError);
  });
});
