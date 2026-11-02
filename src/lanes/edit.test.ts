import { describe, expect, it } from 'vitest';
import { dot, Vec } from '../core/vec';
import {
  anchorAt,
  applyLane,
  buildRoad,
  bulldoze,
  bulldozeSpan,
  dragHandle,
  dragLane,
  flipLane,
  joinDeadEnd,
  lanePortsNear,
  laneStep,
  laneTipAt,
  removeEdgeLane,
  removeLaneSpan,
  startLane,
  taperDeadLanes,
} from './edit';
import { LaneGraph } from './graph';
import { LaneNet, twoWay } from './model';
import { findLaneRoute } from './routing';

const AVENUE = { cls: 'avenue' as const, lanes: twoWay(2, 2) };
const free = (x: number, y: number) => ({ kind: 'free' as const, pos: { x, y } });

/** Дорога 2+2 с запада на восток длиной 800. */
function road(): LaneNet {
  const net = new LaneNet();
  buildRoad(net, free(0, 0), free(800, 0), AVENUE);
  return net;
}

const deadEnds = (net: LaneNet) => [...net.nodes.values()].filter((n) => net.isDeadEnd(n));

/** Ведёт полосу мышью по точкам. */
function drawLane(net: LaneNet, points: Vec[]): boolean {
  let d = startLane(net, points[0], 14);
  for (const p of points.slice(1)) d = dragLane(net, d, p, 14);
  return applyLane(net, d, 'avenue');
}

/** Есть ли путь между тупиками. */
function reachable(net: LaneNet, from: number, to: number): boolean {
  const g = new LaneGraph(net);
  return !!findLaneRoute(g, g.outLinks.get(from) ?? [], to);
}

describe('Полосы: инструменты', () => {
  it('дорога в чистом поле — полотно с тупиками на концах', () => {
    const net = road();
    expect(net.corridors.size).toBe(1);
    expect(deadEnds(net)).toHaveLength(2);
    expect(net.problems()).toEqual([]);
  });

  it('продолжение тупика тем же профилем — стык, другим — перекрёсток', () => {
    const net = road();
    const east = deadEnds(net).find((n) => n.pos.x > 400)!;
    buildRoad(net, anchorAt(net, east.pos, 14), free(1400, 200), AVENUE);
    expect(net.node(east.id).kind).toBe('seam');
    expect(net.problems()).toEqual([]);
    const ends = deadEnds(net);
    expect(reachable(net, ends[0].id, ends[1].id)).toBe(true);

    const west = ends.find((n) => n.pos.x < 100)!;
    buildRoad(net, anchorAt(net, west.pos, 14), free(-500, 0), { cls: 'street', lanes: twoWay(1, 1) });
    expect(net.node(west.id).kind).toBe('junction');
  });

  it('дуга из тупика — окружность: конец смотрит по дуге, а не вдоль хорды', () => {
    const net = road();
    const east = deadEnds(net).find((n) => n.pos.x > 400)!;
    buildRoad(net, anchorAt(net, east.pos, 14), free(1200, 300), { ...AVENUE, arc: true });
    expect(net.node(east.id).kind).toBe('seam');
    const tip = deadEnds(net).find((n) => n.pos.x > 1100)!;
    // Касательная в конце дуги — отражение начальной (1, 0) относительно хорды (0.8, 0.6).
    const [e] = net.ends(tip);
    expect(e.away.x).toBeCloseTo(-0.28, 2);
    expect(e.away.y).toBeCloseTo(-0.96, 2);
    expect(net.problems()).toEqual([]);
  });

  it('ответвление из стыка с дорогами по обе стороны — перекрёсток, дорога идёт прямо к цели', () => {
    const net = road();
    const east = deadEnds(net).find((n) => n.pos.x > 400)!;
    buildRoad(net, anchorAt(net, east.pos, 14), free(1400, 0), AVENUE);
    expect(net.node(east.id).kind).toBe('seam');
    buildRoad(net, anchorAt(net, east.pos, 14), free(800, 400), AVENUE);
    const n = net.node(east.id);
    expect(n.kind).toBe('junction');
    const branch = net.ends(n).find((e) => Math.abs(e.away.y) > 0.5)!;
    expect(branch.away.y).toBeCloseTo(1, 3);
  });

  it('дорога поперёк другой — перекрёсток посередине; конец на полотне — Т-образный', () => {
    const net = road();
    buildRoad(net, free(400, -300), free(400, 300), { cls: 'street', lanes: twoWay(1, 1) });
    const junctions = [...net.nodes.values()].filter((n) => n.kind === 'junction');
    expect(junctions).toHaveLength(1);
    expect(net.ends(junctions[0])).toHaveLength(4);
    buildRoad(net, free(200, 300), anchorAt(net, { x: 200, y: 2 }, 14), { cls: 'street', lanes: twoWay(1, 1) });
    expect([...net.nodes.values()].filter((n) => n.kind === 'junction')).toHaveLength(2);
    expect(net.problems()).toEqual([]);
  });

  it('полоса вдоль края прилипает к полотну: третья полоса с отгонами', () => {
    const net = road();
    expect(drawLane(net, [{ x: 200, y: 17.5 }, { x: 350, y: 18 }, { x: 600, y: 17 }])).toBe(true);
    const c = [...net.corridors.values()][0];
    expect(net.corridors.size).toBe(1);
    const added = c.lanes.find((l) => l.offset === 17.5)!;
    expect(added.flow).toBe(1);
    expect(added.from).toBeCloseTo(200, 0);
    expect(added.to).toBeCloseTo(600, 0);
  });

  it('полоса вдоль края и в сторону — съезд: стык, свой тупик, туда можно доехать', () => {
    const net = road();
    const west = deadEnds(net).find((n) => n.pos.x < 100)!;
    expect(drawLane(net, [{ x: 200, y: 17.5 }, { x: 400, y: 17 }, { x: 500, y: 18 }, { x: 600, y: 40 }, { x: 750, y: 200 }])).toBe(true);
    expect(net.problems()).toEqual([]);
    const ramp = deadEnds(net).find((n) => n.pos.y > 150)!;
    expect(ramp).toBeDefined();
    expect(reachable(net, west.id, ramp.id)).toBe(true);
    // По главной дороге тоже можно проехать дальше.
    const east = deadEnds(net).find((n) => n.pos.x > 700 && n.pos.y < 50)!;
    expect(reachable(net, west.id, east.id)).toBe(true);
  });

  it('длинная полоса торможения: курсор отошёл от края и вернулся — полоса идёт дальше, съезд — там, где ушли окончательно', () => {
    const net = road();
    const west = deadEnds(net).find((n) => n.pos.x < 100)!;
    expect(drawLane(net, [{ x: 200, y: 17.5 }, { x: 300, y: 29 }, { x: 350, y: 45 }, { x: 520, y: 20 }, { x: 600, y: 50 }, { x: 750, y: 220 }])).toBe(true);
    expect(net.problems()).toEqual([]);
    const ramp = [...net.corridors.values()].find((c) => c.portA)!;
    expect(net.node(ramp.a).pos.x).toBeCloseTo(520, -1);
    expect(reachable(net, west.id, ramp.b)).toBe(true);

    // Снос полосы торможения убирает и съезд; по дороге ехать по-прежнему можно.
    const host = [...net.corridors.values()].find((c) => c.b === ramp.a && c.lanes.length === 5)!;
    const aux = host.lanes.findIndex((l) => l.offset > 15);
    const before = net.corridors.size;
    expect(removeEdgeLane(net, host, aux)).toBe(2);
    expect(net.corridors.size).toBe(before - 1);
    expect([...net.corridors.values()].some((c) => c.portA || c.portB)).toBe(false);
    expect(net.problems()).toEqual([]);
    const east = deadEnds(net).find((n) => n.pos.x > 700)!;
    expect(reachable(net, west.id, east.id)).toBe(true);
    // Не крайнюю полосу снести нельзя.
    const c = [...net.corridors.values()][0];
    const inner = c.lanes.findIndex((l) => Math.abs(l.offset) < 5);
    expect(() => removeEdgeLane(net, c, inner)).toThrow('крайнюю');
  });

  it('перестройка куска улицы в проспект: лишние полосы у стыка с улицей сходят отгоном', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: 0, y: 0 }, { x: 1, y: 0 });
    const s = net.addSeam({ x: 400, y: 0 }, { x: 1, y: 0 });
    const b = net.addSeam({ x: 800, y: 0 }, { x: 1, y: 0 });
    const left = net.addCorridor(a.id, s.id, { cls: 'street', lanes: twoWay(1, 1) });
    net.addCorridor(s.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
    left.cls = 'avenue';
    net.setLanes(left, twoWay(2, 2));
    expect(net.problems().length).toBeGreaterThan(0);
    taperDeadLanes(net, [left.a, left.b]);
    expect(net.problems()).toEqual([]);
    // Внутренние полосы продолжаются улицей, крайние кончаются отгоном перед стыком.
    const outer = left.lanes.filter((l) => Math.abs(l.offset) > 7);
    expect(outer).toHaveLength(2);
    for (const l of outer) expect(l.from === 0 ? l.to : l.from).toBeLessThan(left.length);
    expect(reachable(net, a.id, b.id)).toBe(true);
    expect(reachable(net, b.id, a.id)).toBe(true);
  });

  it('полосу продолжают: за стыком — стыкуется без отгона, внахлёст с такой же — сливается в одну', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: 0, y: 0 }, { x: 1, y: 0 });
    const s = net.addSeam({ x: 400, y: 0 }, { x: 1, y: 0 });
    const b = net.addSeam({ x: 800, y: 0 }, { x: 1, y: 0 });
    // Слева у улицы — третья полоса, доходящая до стыка; справа — просто улица.
    const left = net.addCorridor(a.id, s.id, { cls: 'street', lanes: [...twoWay(1, 1), { offset: 10.5, flow: 1, from: 100, to: Infinity }] });
    const right = net.addCorridor(s.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
    expect(net.problems().length).toBeGreaterThan(0);
    // Дорисовываем полосу от самого стыка вперёд — она продолжает левую, а не начинается отгоном.
    expect(drawLane(net, [{ x: 406, y: 10.5 }, { x: 600, y: 10.5 }])).toBe(true);
    expect(net.problems()).toEqual([]);
    const cont = right.lanes.find((l) => l.offset > 7)!;
    expect(cont.from).toBe(0);
    expect(net.across(left, left.lanes.findIndex((l) => l.offset > 7), 'b')).not.toBeNull();
    // Ещё кусок внахлёст с концом — та же полоса становится длиннее, новой не появляется.
    expect(drawLane(net, [{ x: 580, y: 10.5 }, { x: 720, y: 10.5 }])).toBe(true);
    expect(right.lanes.filter((l) => l.offset > 7)).toHaveLength(1);
    expect(right.lanes.find((l) => l.offset > 7)!.to).toBeGreaterThan(300);
    expect(net.problems()).toEqual([]);
  });

  it('снос куска: дороги — тупики по краям, полосы — она остаётся по обе стороны с отгонами', () => {
    const net = road();
    const c = [...net.corridors.values()][0];
    // Пристроенная полоса вдоль почти всей дороги — кусок из середины.
    expect(drawLane(net, [{ x: 100, y: 17.5 }, { x: 700, y: 17.5 }])).toBe(true);
    const i = c.lanes.findIndex((l) => l.offset > 15);
    removeLaneSpan(net, c, i, 300, 450);
    const extra = c.lanes.filter((l) => l.offset > 15).sort((x, y) => x.from - y.from);
    expect(extra).toHaveLength(2);
    expect(extra[0].to).toBeLessThan(300);
    expect(extra[1].from).toBeGreaterThan(450);
    expect(net.problems()).toEqual([]);
    // Кусок самой дороги — два тупика посередине, по дороге не проехать.
    const [west, east] = deadEnds(net).sort((x, y) => x.pos.x - y.pos.x);
    bulldozeSpan(net, c, 350, 500);
    expect(net.corridors.size).toBe(2);
    expect(deadEnds(net)).toHaveLength(4);
    expect(net.problems()).toEqual([]);
    expect(reachable(net, west.id, east.id)).toBe(false);
  });

  it('начало полосы торможения тянут вдоль дороги — она длиннее или короче, съезд на месте', () => {
    const net = road();
    expect(drawLane(net, [{ x: 300, y: 17.5 }, { x: 500, y: 17 }, { x: 600, y: 40 }, { x: 750, y: 200 }])).toBe(true);
    const host = () => [...net.corridors.values()].find((c) => c.lanes.some((l) => l.offset > 15))!;
    const aux = () => host().lanes.find((l) => l.offset > 15)!;
    const start = aux().from;
    // Тянем начало назад — полоса длиннее.
    expect(drawLane(net, [{ x: start + 4, y: 17.5 }, { x: start - 120, y: 17.5 }])).toBe(true);
    expect(aux().from).toBeCloseTo(start - 124, -1);
    expect(net.problems()).toEqual([]);
    // И вперёд — короче.
    const longer = aux().from;
    expect(drawLane(net, [{ x: longer + 4, y: 17.5 }, { x: longer + 200, y: 17.5 }])).toBe(true);
    expect(aux().from).toBeCloseTo(longer + 196, -1);
    expect(net.problems()).toEqual([]);
    expect([...net.corridors.values()].some((c) => c.portA)).toBe(true);
  });

  it('полоса по точкам, как путь: вдоль края → съезд → однополосная дальше; доехать можно', () => {
    const net = road();
    const west = deadEnds(net).find((n) => n.pos.x < 100)!;
    let tip = laneTipAt(net, { x: 200, y: 17.5 }, 14);
    expect(tip.kind).toBe('edge');
    tip = laneStep(net, tip, { x: 500, y: 17.5 }, 'avenue', 14).tip;
    expect(net.problems()).toEqual([]);
    const step = laneStep(net, tip, { x: 640, y: 130 }, 'avenue', 14);
    expect(step.what).toBe('Съезд');
    tip = laneStep(net, step.tip, { x: 760, y: 300 }, 'avenue', 14).tip;
    expect(tip.kind).toBe('point');
    expect(net.problems()).toEqual([]);
    const end = tip.kind === 'point' && tip.anchor.kind === 'node' ? tip.anchor.node : -1;
    expect(reachable(net, west.id, end)).toBe(true);
    // Съезд — там, где кончилась полоса вдоль края (x ≈ 500), а не раньше.
    const ramp = [...net.corridors.values()].find((c) => c.portA)!;
    expect(net.node(ramp.a).pos.x).toBeCloseTo(500, -1);
  });

  it('по точкам: полоса вдоль дороги проходит через стык; съезд с края без полосы — с полосой торможения', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: 0, y: 0 }, { x: 1, y: 0 });
    const s = net.addSeam({ x: 400, y: 0 }, { x: 1, y: 0 });
    const b = net.addSeam({ x: 900, y: 0 }, { x: 1, y: 0 });
    const left = net.addCorridor(a.id, s.id, { cls: 'street', lanes: twoWay(1, 1) });
    const right = net.addCorridor(s.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
    let tip = laneTipAt(net, { x: 200, y: 10.5 }, 14);
    tip = laneStep(net, tip, { x: 600, y: 10.5 }, 'street', 14).tip;
    expect(net.problems()).toEqual([]);
    const i = left.lanes.findIndex((l) => l.offset > 7);
    expect(net.across(left, i, 'b')).not.toBeNull();
    expect(right.lanes.find((l) => l.offset > 7)!.from).toBe(0);
    // Съезд прямо с края, где полосы нет: перед ним появляется полоса торможения.
    const fresh = laneTipAt(net, { x: 800, y: 10.5 }, 14);
    expect(fresh.kind).toBe('edge');
    const r = laneStep(net, fresh, { x: 880, y: 150 }, 'street', 14);
    expect(r.what).toBe('Съезд');
    expect(net.problems()).toEqual([]);
  });

  for (const x of [395, 406]) {
    it(`симметричная развязка: въезд у стыка съезда (клик в ${x}) — в том же узле, без куска дороги между ними`, () => {
      const net = new LaneNet();
      const a = net.addSeam({ x: 0, y: 0 }, { x: 1, y: 0 });
      const b = net.addSeam({ x: 800, y: 0 }, { x: 1, y: 0 });
      net.addCorridor(a.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
      // Съезд справа по ходу на восток: полоса вдоль до 400, оттуда — в сторону.
      let tip = laneTipAt(net, { x: 200, y: 10.5 }, 14);
      tip = laneStep(net, tip, { x: 400, y: 10.5 }, 'street', 14).tip;
      laneStep(net, tip, { x: 520, y: 150 }, 'street', 14);
      const exit = [...net.corridors.values()].find((c) => c.portA)!;
      // Въезд слева (едут на запад) — кликнули чуть до или чуть после стыка съезда.
      const step = laneStep(net, laneTipAt(net, { x: 520, y: -150 }, 14), { x, y: -10.5 }, 'street', 14);
      expect(step.what).toBe('Въезд');
      const entry = [...net.corridors.values()].find((c) => c.portB)!;
      expect(entry.b).toBe(exit.a);
      // Дорога разрезана один раз — в этом узле.
      const main = [...net.corridors.values()].filter((c) => !c.portA && !c.portB && c.lanes.length > 1);
      expect(main).toHaveLength(2);
      expect(net.problems()).toEqual([]);
      const east = deadEnds(net).find((n) => n.pos.x > 700)!;
      expect(reachable(net, deadEnds(net).find((n) => n.pos.y < -100)!.id, deadEnds(net).find((n) => n.pos.x < 100)!.id)).toBe(true);
      expect(reachable(net, deadEnds(net).find((n) => n.pos.x < 100)!.id, east.id)).toBe(true);
    });
  }

  it('с любой полосы у конца дороги — своя однополосная, как путь от конца пути: дорога расходится на две односторонние', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: 0, y: 0 }, { x: 1, y: 0 });
    const b = net.addSeam({ x: 800, y: 0 }, { x: 1, y: 0 });
    net.addCorridor(a.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
    expect(lanePortsNear(net, { x: 800, y: 0 }, 30)).toHaveLength(2);
    // Правая полоса (едут на восток, наружу) — однополосная дальше на северо-восток.
    const out = laneTipAt(net, { x: 800, y: 3.5 }, 14);
    expect(out).toMatchObject({ kind: 'port', out: true });
    expect(laneStep(net, out, { x: 1000, y: 200 }, 'street', 14).what).toBe('Однополосная');
    expect(net.problems()).toEqual([]);
    // Левая полоса (едут к нам) сошла на нет у конца, но с неё всё равно можно начать — однополосную внутрь.
    const inn = laneTipAt(net, { x: 800, y: -3.5 }, 14);
    expect(inn).toMatchObject({ kind: 'port', out: false });
    laneStep(net, inn, { x: 1000, y: -200 }, 'street', 14);
    expect(net.problems()).toEqual([]);
    expect(lanePortsNear(net, { x: 800, y: 0 }, 30)).toHaveLength(0);
    const west = deadEnds(net).find((n) => n.pos.x < 100)!;
    const ne = deadEnds(net).find((n) => n.pos.y > 150)!;
    const se = deadEnds(net).find((n) => n.pos.y < -150)!;
    expect(reachable(net, west.id, ne.id)).toBe(true);
    expect(reachable(net, se.id, west.id)).toBe(true);
  });

  it('снос полосы по участкам, как пути: кусок за стыком остаётся и сходит на нет отгоном', () => {
    const net = new LaneNet();
    const a = net.addSeam({ x: 0, y: 0 }, { x: 1, y: 0 });
    const s = net.addSeam({ x: 400, y: 0 }, { x: 1, y: 0 });
    const b = net.addSeam({ x: 900, y: 0 }, { x: 1, y: 0 });
    const left = net.addCorridor(a.id, s.id, { cls: 'street', lanes: twoWay(1, 1) });
    const right = net.addCorridor(s.id, b.id, { cls: 'street', lanes: twoWay(1, 1) });
    laneStep(net, laneTipAt(net, { x: 200, y: 10.5 }, 14), { x: 600, y: 10.5 }, 'street', 14);
    expect(left.lanes).toHaveLength(3);
    expect(right.lanes).toHaveLength(3);
    // Снесли кусок слева — справа полоса осталась, но начинается отгоном после стыка.
    expect(removeEdgeLane(net, left, left.lanes.findIndex((l) => l.offset > 7))).toBe(1);
    expect(left.lanes).toHaveLength(2);
    const rest = right.lanes.find((l) => l.offset > 7)!;
    expect(rest.from).toBeGreaterThan(0);
    expect(net.problems()).toEqual([]);
  });

  it('по точкам: из поля к краю дороги — въезд с полосой разгона, её можно тянуть дальше', () => {
    const net = road();
    const east = deadEnds(net).find((n) => n.pos.x > 700)!;
    let tip = laneTipAt(net, { x: 100, y: 260 }, 14);
    expect(tip.kind).toBe('point');
    const step = laneStep(net, tip, { x: 300, y: 17.5 }, 'avenue', 14);
    expect(step.what).toBe('Въезд');
    tip = step.tip;
    expect(tip.kind).toBe('edge');
    expect(net.problems()).toEqual([]);
    tip = laneStep(net, tip, { x: 600, y: 17.5 }, 'avenue', 14).tip;
    expect(net.problems()).toEqual([]);
    const start = deadEnds(net).find((n) => n.pos.y > 200)!;
    expect(reachable(net, start.id, east.id)).toBe(true);
  });

  it('полоса из поля к краю и вдоль — въезд с полосой разгона', () => {
    const net = road();
    const east = deadEnds(net).find((n) => n.pos.x > 700)!;
    expect(drawLane(net, [{ x: 50, y: 250 }, { x: 150, y: 120 }, { x: 300, y: 17.5 }, { x: 450, y: 18 }, { x: 500, y: 17 }])).toBe(true);
    expect(net.problems()).toEqual([]);
    const start = deadEnds(net).find((n) => n.pos.y > 200)!;
    expect(reachable(net, start.id, east.id)).toBe(true);
  });

  it('уровни: мост над дорогой — без перекрёстка, пандус пониже — мало места, автомагистраль — только мостом', () => {
    const net = road();
    const STREET = { cls: 'street' as const, lanes: twoWay(1, 1) };
    const at = (x: number, y: number, level: number) => ({ kind: 'free' as const, pos: { x, y }, level });
    // Мост на уровне 1 поперёк проспекта — перекрёстка нет, по мосту можно проехать.
    buildRoad(net, at(400, -200, 1), at(400, 200, 1), STREET);
    expect([...net.nodes.values()].filter((n) => n.kind === 'junction')).toHaveLength(0);
    expect(net.corridors.size).toBe(2);
    // Пандус с земли на мост, над проспектом ещё низко.
    expect(() => buildRoad(net, at(600, -150, 0), at(600, 300, 1), STREET)).toThrow('Мало места по высоте');
    // Пандус, который пересекает проспект на подъёме, — нельзя перекрёстком.
    expect(() => buildRoad(net, at(200, -40, 0), at(200, 400, 1), STREET)).toThrow();
    // Автомагистраль пересекает дорогу только мостом.
    const mw = new LaneNet();
    buildRoad(mw, free(0, 0), free(800, 0), { cls: 'motorway', lanes: twoWay(2, 2, 4) });
    expect(() => buildRoad(mw, free(400, -200), free(400, 200), STREET)).toThrow('Автомагистраль пересекается только мостом или тоннелем');
    // Высота вдоль пандуса — равномерно от уровня к уровню.
    const ramp = new LaneNet();
    const [c] = buildRoad(ramp, at(0, 0, 0), at(300, 0, 1), STREET);
    expect(ramp.heightAt(c, c.length / 2)).toBeCloseTo(0.5, 5);
    expect(ramp.isFlat(c)).toBe(false);
  });

  it('перо в стыке поворачивает стык: перо соседа на той же прямой; с изломом — перекрёсток', () => {
    const net = road();
    const east = deadEnds(net).find((n) => n.pos.x > 400)!;
    buildRoad(net, anchorAt(net, east.pos, 14), free(1400, 0), AVENUE);
    const seam = net.node(east.id);
    const [left, right] = net.ends(seam).sort((x, y) => x.away.x - y.away.x);
    // Тянем перо правого полотна вверх: стык поворачивается, у левого перо — по той же прямой назад.
    expect(dragHandle(net, { corridor: right.corridor.id, end: right.end }, { x: 1000, y: -100 })).toBe(true);
    const [l2, r2] = net.ends(seam).sort((x, y) => x.away.x - y.away.x);
    expect(dot(l2.away, r2.away)).toBeLessThan(-0.9999);
    expect(r2.away.y).toBeLessThan(-0.3);
    expect(net.node(seam.id).kind).toBe('seam');
    expect(net.problems()).toEqual([]);
    expect(left.corridor.id).toBe(l2.corridor.id);
    // С изломом стык становится перекрёстком, левое полотно не трогаем.
    const before = { ...net.corridor(l2.corridor.id).curve };
    expect(dragHandle(net, { corridor: r2.corridor.id, end: r2.end }, { x: 1000, y: 100 }, true)).toBe(true);
    expect(net.node(seam.id).kind).toBe('junction');
    expect(net.corridor(l2.corridor.id).curve).toEqual(before);
  });

  it('тупик примыкает: к середине дороги — перекрёсток, к тупику по ходу того же профиля — стык', () => {
    const net = road();
    // Улица с юга, её тупик бросаем на середину проспекта.
    buildRoad(net, free(400, 400), free(400, 150), { cls: 'street', lanes: twoWay(1, 1) });
    const tip = deadEnds(net).find((n) => n.pos.y > 100 && n.pos.y < 200)!;
    const south = deadEnds(net).find((n) => n.pos.y > 300)!;
    expect(joinDeadEnd(net, tip.id, anchorAt(net, { x: 400, y: 3 }, 14))).toBe(true);
    expect(net.nodes.has(tip.id)).toBe(false);
    const j = [...net.nodes.values()].find((n) => n.kind === 'junction')!;
    expect(net.ends(j)).toHaveLength(3);
    expect(net.problems()).toEqual([]);
    const west = deadEnds(net).find((n) => n.pos.x < 100)!;
    expect(reachable(net, south.id, west.id)).toBe(true);

    // Отдельный проспект восточнее: его западный тупик тянем к восточному тупику первого — продолжение.
    buildRoad(net, free(900, 0), free(1300, 0), AVENUE);
    const a = deadEnds(net).find((n) => Math.abs(n.pos.x - 800) < 1)!;
    const b = deadEnds(net).find((n) => Math.abs(n.pos.x - 900) < 1)!;
    expect(joinDeadEnd(net, b.id, { kind: 'node', node: a.id, pos: a.pos })).toBe(true);
    expect(net.node(a.id).kind).toBe('seam');
    expect(net.problems()).toEqual([]);
    const far = deadEnds(net).find((n) => n.pos.x > 1200)!;
    expect(reachable(net, west.id, far.id)).toBe(true);
  });

  it('снос перекрёстной дороги оставляет тупики, разворот полосы, сохранение', () => {
    const net = road();
    buildRoad(net, anchorAt(net, { x: 400, y: 0 }, 14), free(400, 300), { cls: 'street', lanes: twoWay(1, 1) });
    const j = [...net.nodes.values()].find((n) => n.kind === 'junction')!;
    const side = net.ends(j).find((e) => e.corridor.cls === 'street')!.corridor;
    bulldoze(net, side.id);
    // Две половины проспекта остались у перекрёстка на две дороги.
    expect(net.ends(j)).toHaveLength(2);
    const any = [...net.corridors.values()][0];
    flipLane(net, any, 0);
    expect(any.lanes[0].flow).toBe(1);
    const copy = LaneNet.fromJSON(JSON.parse(JSON.stringify(net.toJSON())));
    expect(copy.toJSON()).toEqual(net.toJSON());
  });
});
