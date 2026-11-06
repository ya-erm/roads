import { describe, expect, it } from 'vitest';
import { add, dist, rightNormal, scale, type Vec } from '../core/vec';
import { LaneGraph } from './graph';
import { LIGHT_SIDE, lightSpot, underDeck } from './lightSpot';
import { LaneNet, twoWay } from './model';
import { deckLift } from './speedDisplay';

/**
 * Перекрёсток улиц 1+1 со светофором в (0, 0) на высоте level: плечи на запад, юг и север — до узлов той же высоты,
 * на восток — до узла высоты east (1 — плечо на восток — пандус на мост, как на картинке задачи).
 */
function junction(level = 0, east = level) {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 }, level);
  j.control = 'lights';
  const arm = (x: number, y: number, lvl: number) =>
    net.addCorridor(j.id, net.addSeam({ x, y }, { x: Math.sign(x), y: Math.sign(y) }, lvl).id, { cls: 'street', lanes: twoWay(1, 1) });
  const arms = { w: arm(-300, 0, level), e: arm(300, 0, east), n: arm(0, -300, level), s: arm(0, 300, level) };
  return { net, j, arms };
}

/** Светофоры перекрёстка: по полотну подъезда — где и как рисовать. */
function spots(net: LaneNet, j: { id: number }) {
  const g = new LaneGraph(net);
  const L = g.nodes.get(j.id)!.lights!;
  return new Map(
    L.heads.map((h) => {
      const link = g.links.get(h.link)!;
      return [link.corridor, { spot: lightSpot(g, link, h.arrows.length)!, link, g }] as const;
    }),
  );
}

/** Точка без подъёма: справа от крайней правой полосы въезда, у стоп-линии. */
function flatSpot(g: LaneGraph, link: ReturnType<LaneGraph['links']['get']> & object): Vec {
  const lane = link.lanes[link.lanes.length - 1];
  const end = g.lanePose(lane, lane.length);
  return add(end.pos, scale(rightNormal(end.dir), LIGHT_SIDE));
}

describe('Светофор и мосты: слой и место', () => {
  it('на земле — в слое земли у стоп-линии справа; спуск с моста к перекрёстку — в слое моста, над его полотном', () => {
    const { net, j, arms } = junction(0, 1);
    const all = spots(net, j);
    for (const id of [arms.w.id, arms.n.id, arms.s.id]) {
      const { spot, link, g } = all.get(id)!;
      expect(spot.layer).toBe(0);
      expect(spot.covered).toBe(false);
      expect(dist(spot.pos, flatSpot(g, link))).toBeLessThan(1e-6);
    }
    // Подъезд с моста: светофор рисуется после полотна пандуса (его парапет его больше не закрывает).
    const ramp = all.get(arms.e.id)!;
    expect(ramp.spot.layer).toBe(1);
    expect(ramp.spot.covered).toBe(false);
    const lane = ramp.link.lanes[ramp.link.lanes.length - 1];
    const lift = deckLift(net, arms.e, ramp.g.axisS(lane, lane.length));
    expect(dist(ramp.spot.pos, add(flatSpot(ramp.g, ramp.link), lift))).toBeLessThan(1e-6);
  });

  it('перекрёсток на эстакаде: все светофоры в слое моста и подняты вместе с полотном', () => {
    const { net, j } = junction(1);
    for (const { spot, link, g } of spots(net, j).values()) {
      expect(spot.layer).toBe(1);
      expect(spot.covered).toBe(false);
      // Поднят на экране (вверх — y меньше) ровно на подъём полотна у стоп-линии.
      const flat = flatSpot(g, link);
      expect(spot.pos.y).toBeLessThan(flat.y - 1);
      expect(spot.pos.x).toBeCloseTo(flat.x, 6);
    }
  });

  it('перекрёсток на земле под мостом: закрытые полотном моста светофоры помечены — их видно поверх', () => {
    const { net, j, arms } = junction(0);
    // Мост наискось с северо-запада на юго-восток прямо над перекрёстком.
    const a = net.addSeam({ x: -250, y: -250 }, { x: 1, y: 1 }, 1);
    const b = net.addSeam({ x: 250, y: 250 }, { x: 1, y: 1 }, 1);
    net.addCorridor(a.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
    const all = spots(net, j);
    // Светофоры у северо-западного и юго-восточного углов — под мостом, у двух других — нет.
    const covered = [...all.entries()].filter(([, x]) => x.spot.covered).map(([id]) => id).sort();
    expect(covered.length).toBe(2);
    for (const { spot } of all.values()) expect(spot.layer).toBe(0);
    // Подъезд с запада стоит справа (на юге) — открыт; с севера — справа (на западе), у северо-западного угла — под мостом.
    expect(all.get(arms.w.id)!.spot.covered).toBe(false);
    expect(all.get(arms.n.id)!.spot.covered).toBe(true);
  });

  it('под полотном — только выше своего слоя, в пределах его ширины и не за концом', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: -200, y: 0 }, { x: 1, y: 0 }, 1);
    const b = net.addSeam({ x: 200, y: 0 }, { x: 1, y: 0 }, 1);
    const bridge = net.addCorridor(a.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
    const lift = deckLift(net, bridge, 200);
    // Мост рисуется поднятым: на экране под ним — точка оси, сдвинутая на подъём.
    expect(underDeck(net, add({ x: 0, y: 0 }, lift), 0)).toBe(true);
    expect(underDeck(net, add({ x: 0, y: 6 }, lift), 0)).toBe(true);
    // Сбоку от полотна, за его концом и для светофора того же слоя — не закрыт.
    expect(underDeck(net, add({ x: 0, y: 30 }, lift), 0)).toBe(false);
    expect(underDeck(net, { x: 260, y: 0 }, 0)).toBe(false);
    expect(underDeck(net, add({ x: 0, y: 0 }, lift), 1)).toBe(false);
  });
});
