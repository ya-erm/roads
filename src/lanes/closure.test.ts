import { describe, expect, it } from 'vitest';
import { CurveLUT } from '../core/bezier';
import { CONSTRUCTION } from '../config';
import { laneDone, laneWise, partLanes, reverseLanes, reverseStops, reverseZone, reversible, workSide } from './closure';
import { type Corridor, type CorridorBuild, LaneNet, oneWay, taperLen, twoWay } from './model';
import { openNet } from './open';

const K = CONSTRUCTION.rebuild;

/** Прямое полотно длиной len вдоль x (сети не нужно — только ось и полосы). */
function strip(len: number, build: CorridorBuild): Corridor {
  const curve = { p0: { x: 0, y: 0 }, p1: { x: len / 3, y: 0 }, p2: { x: (2 * len) / 3, y: 0 }, p3: { x: len, y: 0 } };
  const lut = new CurveLUT(curve);
  return { id: 1, a: 1, b: 2, portA: 0, portB: 0, curve, lut, length: lut.length, cls: 'highway', lanes: twoWay(1, 1), rev: 1, build } as Corridor;
}

const was = (len: number) => ({ cls: 'dirt' as const, lanes: twoWay(1, 1), len, value: 1000, price: 4000, work: 0.6, part: true as const });

describe('«С проездом» на узкой дороге', () => {
  it('узкая — 1+1 и 2+1 (половина полос оставила бы одно направление); 2+2 и одностороняя — нет', () => {
    expect(reversible(twoWay(1, 1))).toBe(true);
    expect(reversible(twoWay(2, 1))).toBe(true);
    expect(reversible(twoWay(2, 2))).toBe(false);
    expect(reversible(twoWay(3, 3))).toBe(false);
    expect(reversible(oneWay(2))).toBe(false);
    expect(laneWise({ project: 1, done: 0, was: was(100) })).toBe(true);
    // ⛔ целиком и перенос — не «с проездом».
    expect(laneWise({ project: 1, done: 0, was: { ...was(100), part: undefined } })).toBe(false);
    expect(laneWise({ project: 1, done: 0, was: { ...was(100), moved: true } })).toBe(false);
  });

  it('проходы: правая по ходу заполнения половина, второй — навстречу и другая; готовое — половина за проход', () => {
    expect(workSide({ project: 1, done: 0 })).toBe(1);
    expect(workSide({ project: 1, done: 0, fromB: true })).toBe(-1);
    expect(laneDone(false, 100, 200)).toBe(50);
    expect(laneDone(true, 0, 200)).toBe(100);
    expect(laneDone(true, 200, 200)).toBe(200);
  });

  it('участок под реверсом: куски не длиннее chunk, от края площадки — половина отгона и 15 м; идёт за бригадой', () => {
    const L = 900;
    const c = strip(L, { project: 1, done: 0, was: was(L) });
    const m = taperLen('dirt') / 2 + 15;
    // Не начато — первый кусок по ходу заполнения.
    const first = reverseZone(c, c.build!, [0, 0]);
    const n = Math.ceil((L - 2 * m) / K.reverse.chunk);
    const size = (L - 2 * m) / n;
    expect(first[0]).toBeCloseTo(m, 3);
    expect(first[1]).toBeCloseTo(m + size, 3);
    expect(size).toBeLessThanOrEqual(K.reverse.chunk);
    // Бригада ушла во второй кусок — участок с ней; разрыто на стыке кусков — оба.
    const at = (x: number): CorridorBuild => ({ ...c.build!, done: 10, stages: [x, x - 40, x - 80] });
    expect(reverseZone(c, at(m + size + 120), [0, 0])).toEqual([m + size, m + 2 * size]);
    const both = reverseZone(c, at(m + size + 30), [0, 0]);
    expect(both[0]).toBeCloseTo(m, 3);
    expect(both[1]).toBeCloseTo(m + 2 * size, 3);
    // От конца b — с другого конца; площадка перекрёстка отодвигает участок.
    const back = reverseZone(c, { ...c.build!, fromB: true }, [0, 20]);
    expect(back[1]).toBeCloseTo(L - 20 - m, 3);
    // Короткое полотно — 20 м посередине.
    const short = strip(50, { project: 1, done: 0, was: was(50) });
    expect(reverseZone(short, short.build!, [0, 0])).toEqual([15, 35]);
  });

  it('полосы для движения: вне участка — обе стороны, на нём — одна полоса открытой половины в обе стороны', () => {
    const L = 600;
    const c = strip(L, { project: 1, done: 5, stages: [10, 0, 0], was: was(L) });
    const zone = reverseZone(c, c.build!, [0, 0]);
    const lanes = reverseLanes(c, c.build!, zone);
    const at = (s: number) => lanes.filter((l) => l.from <= s && l.to >= s);
    // Первый проход от a — перекладывают правую половину (смещение больше нуля), открыта левая.
    const mid = at((zone[0] + zone[1]) / 2);
    expect(mid.map((l) => l.flow).sort()).toEqual([-1, 1]);
    expect(mid.every((l) => l.offset < 0)).toBe(true);
    for (const s of [zone[0] / 2, (zone[1] + L) / 2]) {
      const out = at(s);
      expect(out.map((l) => l.offset).sort((p, q) => p - q)).toEqual([-3.5, 3.5]);
    }
    // Стоп-линии — до съезда на открытую половину (половина отгона и 3 м) с обеих сторон участка.
    const [s0, s1] = reverseStops(c, c.build!, zone);
    expect(s0).toBeCloseTo(zone[0] - taperLen('dirt') / 2 - 3, 3);
    expect(s1).toBeCloseTo(zone[1] + taperLen('dirt') / 2 + 3, 3);
    // Открыто (для карточки) — левая половина: 1 полоса из 2.
    expect(partLanes(new LaneNet(), c).map((l) => l.offset)).toEqual([-3.5]);
  });
});

describe('Перекрытие: сеть для движения и для карты', () => {
  /** Готовый сосед (west) — 0…300, перестраиваемое полотно — 300…900, дальше — ещё готовый кусок. */
  function scene(old: ReturnType<typeof twoWay>, now: ReturnType<typeof twoWay>) {
    const net = new LaneNet();
    const a = net.addSeam({ x: 0, y: 0 }, { x: -1, y: 0 });
    const m = net.addSeam({ x: 300, y: 0 }, { x: 1, y: 0 });
    const n = net.addSeam({ x: 900, y: 0 }, { x: 1, y: 0 });
    const b = net.addSeam({ x: 1100, y: 0 }, { x: 1, y: 0 });
    const west = net.addCorridor(a.id, m.id, { cls: 'avenue', lanes: old });
    const c = net.addCorridor(m.id, n.id, { cls: 'avenue', lanes: now });
    net.addCorridor(n.id, b.id, { cls: 'avenue', lanes: old });
    c.build = { project: 1, done: 10, stages: [30, 0, 0], was: { cls: 'avenue', lanes: old, len: c.length, value: 1, price: 1, work: 0.6, part: true } };
    net.touch(c);
    return { net, west, c };
  }

  it('широкая «по полосам»: у соседа движение сходит на нет отгоном, а на карте асфальт не сужается', () => {
    const { net, west } = scene(twoWay(2, 2), twoWay(3, 3));
    const traffic = openNet(net);
    const view = openNet(net, true);
    expect(traffic.corridors.get(west.id)!.lanes.some((l) => l.to < west.length - 1)).toBe(true);
    expect(view.corridors.get(west.id)!.lanes).toEqual(west.lanes);
  });

  it('узкая «с проездом»: у соседей ничего не обрывается — в обе стороны едут и по участку', () => {
    const { net, west, c } = scene(twoWay(1, 1), twoWay(2, 2));
    const traffic = openNet(net);
    expect(traffic.corridors.get(west.id)!.lanes).toEqual(west.lanes);
    // На карте — прежняя дорога целиком (не разрытое рисуется поверх стройки), для движения — с полосой встречных.
    expect(openNet(net, true).corridors.get(c.id)!.lanes.length).toBe(2);
    expect(traffic.corridors.get(c.id)!.lanes.length).toBe(4);
  });
});
