import { describe, expect, it } from 'vitest';
import { CurveLUT } from '../core/bezier';
import { CONSTRUCTION } from '../config';
import { approachAt, laneDone, laneWise, partLanes, REACH, reverseLanes, reverseSite, reverseStops, reverseZone, reversible, workSide } from './closure';
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
    // Не начато — первый кусок по ходу заполнения; бригада начинает у самого конца — участок до конца полотна.
    const first = reverseZone(c, c.build!, [0, 0]);
    const n = Math.ceil((L - 2 * m) / K.reverse.chunk);
    const size = (L - 2 * m) / n;
    expect(first[0]).toBe(0);
    expect(first[1]).toBeCloseTo(m + size, 3);
    expect(size).toBeLessThanOrEqual(K.reverse.chunk);
    // Бригада ушла во второй кусок — участок с ней; разрыто на стыке кусков — оба.
    const at = (x: number): CorridorBuild => ({ ...c.build!, done: 10, stages: [x, x - 40, x - 80] });
    expect(reverseZone(c, at(m + size + 120), [0, 0])).toEqual([m + size, m + 2 * size]);
    const both = reverseZone(c, at(m + size + 30), [0, 0]);
    expect(both[0]).toBeCloseTo(m, 3);
    expect(both[1]).toBeCloseTo(m + 2 * size, 3);
    // Разметка ещё в запасе у начала (разрыто у самого конца a) — участок от конца; отсыпка дошла до запаса у b — до b.
    expect(reverseZone(c, at(m + 60), [0, 0])[0]).toBe(0);
    expect(reverseZone(c, at(L - m + 10), [0, 0])[1]).toBe(L);
    // От конца b — с другого конца, до самого конца b (площадка перекрёстка — тоже: машины ждут перед перекрёстком).
    const back = reverseZone(c, { ...c.build!, fromB: true }, [0, 20]);
    expect(back[1]).toBe(L);
    expect(back[0]).toBeCloseTo(L - 20 - m - (L - 20 - 2 * m) / Math.ceil((L - 20 - 2 * m) / K.reverse.chunk), 3);
    // Короткое полотно — 20 м посередине (и до конца, где разрыто).
    const short = strip(50, { project: 1, done: 0, was: was(50) });
    expect(reverseZone(short, short.build!, [0, 0])).toEqual([0, 35]);
  });

  it('полосы для движения: вне участка — обе стороны, на нём — одна полоса открытой половины в обе стороны', () => {
    const L = 600;
    const m = taperLen('dirt') / 2 + 15;
    const size = (L - 2 * m) / Math.ceil((L - 2 * m) / K.reverse.chunk);
    // Бригада во втором куске: участок посреди полотна.
    const x = m + size + 120;
    const c = strip(L, { project: 1, done: 5, stages: [x, x - 40, x - 80], was: was(L) });
    const zone = reverseZone(c, c.build!, [0, 0]);
    expect(zone[0]).toBeGreaterThan(0);
    expect(zone[1]).toBeLessThan(L);
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
    // Закрытая половина кончается за половину отгона до участка (граф держит полосу ещё половину отгона за её концом):
    // съезжают до участка, а не на нём; назад — после него.
    const h = taperLen('dirt') / 2;
    for (const l of lanes.filter((k) => k.offset > 0)) expect(l.to <= zone[0] - h + 1e-6 || l.from >= zone[1] + h - 1e-6).toBe(true);
    // Стоп-линии — до съезда на открытую половину (половина отгона и 3 м) с обеих сторон участка.
    const [s0, s1] = reverseStops(c, c.build!, zone);
    expect(s0).toBeCloseTo(zone[0] - h - 3, 3);
    expect(s1).toBeCloseTo(zone[1] + h + 3, 3);
    // Открыто (для карточки) — левая половина: 1 полоса из 2.
    expect(partLanes(new LaneNet(), c).map((l) => l.offset)).toEqual([-3.5]);
    // Участок до конца a: закрытой половины у конца нет совсем, полоса встречных — от самого конца; стоп-линия — у узла.
    const start = strip(L, { project: 1, done: 5, stages: [10, 0, 0], was: was(L) });
    const z = reverseZone(start, start.build!, [0, 0]);
    expect(z[0]).toBe(0);
    const near = reverseLanes(start, start.build!, z).filter((l) => l.from <= 0.01);
    expect(near.every((l) => l.offset < 0)).toBe(true);
    expect(near.map((l) => l.flow).sort()).toEqual([-1, 1]);
    expect(reverseStops(start, start.build!, z)[0]).toBe(0);
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

  it('узкая «с проездом»: участок посреди полотна — у соседей ничего не обрывается, в обе стороны едут и по участку', () => {
    const { net, west, c } = scene(twoWay(1, 1), twoWay(2, 2));
    c.build = { ...c.build!, stages: [330, 290, 250] };
    net.touch(c);
    const traffic = openNet(net);
    expect(traffic.corridors.get(west.id)!.lanes).toEqual(west.lanes);
    // На карте — прежняя дорога целиком (не разрытое рисуется поверх стройки), для движения — с полосой встречных.
    expect(openNet(net, true).corridors.get(c.id)!.lanes.length).toBe(2);
    expect(traffic.corridors.get(c.id)!.lanes.length).toBe(4);
  });

  it('узкая «с проездом»: разрыто у стыка — съезд на открытую половину на соседе, через стык едут в обе стороны', () => {
    const { net, west, c } = scene(twoWay(1, 1), twoWay(2, 2));
    const site = reverseSite(net, c, c.build!);
    // Бригада у самого стыка с западным соседом: участок заходит на него, стоп-линия идущих на восток — на нём.
    expect(site.reach[0]?.corridor.id).toBe(west.id);
    expect(site.zone[0]).toBe(-REACH);
    const h = taperLen('avenue') / 2;
    expect(site.stops[0]).toBeCloseTo(-REACH - h - 3, 6);
    const traffic = openNet(net);
    const w = traffic.corridors.get(west.id)!;
    // У соседа полоса на восток (правая) кончается за половину отгона до захода участка, у стыка — полоса встречных
    // по левой (на восток — по полосе открытой половины).
    const east = w.lanes.filter((l) => l.flow === 1);
    expect(east.find((l) => l.offset > 0)!.to).toBeCloseTo(w.length - REACH - h, 6);
    expect(east.find((l) => l.offset < 0)).toMatchObject({ offset: -3.5, from: w.length - REACH, to: w.length });
    // Перестраиваемое полотно у стыка — только открытая половина, в обе стороны; полосы через стык продолжаются.
    const o = traffic.corridors.get(c.id)!;
    const atA = o.lanes.map((l, i) => ({ l, i })).filter(({ l }) => l.from <= 0.01);
    expect(atA.every(({ l }) => l.offset < 0)).toBe(true);
    expect(atA.map(({ l }) => l.flow).sort()).toEqual([-1, 1]);
    for (const { i } of atA) expect(traffic.across(o, i, 'a')?.corridor.id).toBe(west.id);
    // На карте у соседа асфальт как был.
    expect(openNet(net, true).corridors.get(west.id)!.lanes).toEqual(west.lanes);
  });

  it('сосед за стыком — не продолжение или короткий: съезда на нём нет, участок — до самого узла', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: 0, y: 0 }, { x: -1, y: 0 });
    const m = net.addSeam({ x: 30, y: 0 }, { x: 1, y: 0 });
    const n = net.addJunction({ x: 630, y: 0 });
    const b = net.addSeam({ x: 900, y: 0 }, { x: 1, y: 0 });
    net.addCorridor(a.id, m.id, { cls: 'avenue', lanes: twoWay(1, 1) });
    const c = net.addCorridor(m.id, n.id, { cls: 'avenue', lanes: twoWay(2, 2) });
    net.addCorridor(n.id, b.id, { cls: 'avenue', lanes: twoWay(1, 1) });
    c.build = { project: 1, done: 10, stages: [30, 0, 0], was: { cls: 'avenue', lanes: twoWay(1, 1), len: c.length, value: 1, price: 1, work: 0.6, part: true } };
    net.touch(c);
    // Сосед в 30 м — короче съезда; на конце b — перекрёсток.
    expect(approachAt(net, c, 'a')).toBeNull();
    expect(approachAt(net, c, 'b')).toBeNull();
    const site = reverseSite(net, c, c.build);
    expect(site.zone[0]).toBe(0);
    expect(site.stops[0]).toBe(0);
  });
});
