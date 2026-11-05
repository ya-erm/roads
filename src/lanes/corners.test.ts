import { describe, expect, it } from 'vitest';
import { add, dist, norm, scale, Vec } from '../core/vec';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { cornerCost, cornerHandles, cornerLimitText, cornerRadiusAt, cornerTurn, setCornerRadius } from './corners';
import {
  CORNER_CUT_MAX,
  CORNER_GAP,
  CORNER_R_MAX,
  cornerCurb,
  cornerKey,
  cutCap,
  filletArea,
  filletDepth,
  filletPath,
  filletRadius,
  filletTangent,
  junctionCorners,
  nodeCuts,
} from './geometry';
import { LaneRenderer } from './draw';
import { laneSpeed, LaneGraph, turnSpeed } from './graph';
import { LaneNet, type LaneNode, remapCorners, renameArm, twoWay } from './model';

const STREET = { cls: 'street' as const, lanes: twoWay(1, 1) };
/** Полуширина асфальта улицы 1+1: две полосы и бордюрный запас. */
const HALF = LANE_W + ROAD_MARGIN;
/** От бордюра до оси крайней полосы. */
const CURB_TO_LANE = LANE_W / 2 + ROAD_MARGIN;

/** Перекрёсток в (0, 0) с улицами по направлениям angles (рад, 0 — на восток; экран: y вниз). Чётные — от узла, нечётные — к узлу. */
function junction(angles: number[], length = 400) {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 });
  const ids = angles.map((a, i) => {
    const d: Vec = { x: Math.cos(a), y: Math.sin(a) };
    const far = scale(d, length);
    return (i % 2 === 0 ? net.addCorridor(j.id, net.addSeam(far, d).id, STREET) : net.addCorridor(net.addSeam(far, scale(d, -1)).id, j.id, STREET)).id;
  });
  return { net, node: net.node(j.id), ids };
}

/** Правый поворот вдоль угла key в графе: с подъезда b на подъезд a. */
function rightTurn(net: LaneNet, nodeId: number, key: string) {
  const g = new LaneGraph(net);
  const k = junctionCorners(net, net.node(nodeId)).find((x) => x.key === key)!;
  const moves = [...g.moves.values()].filter((m) => m.node === nodeId && g.links.get(m.inLink)!.corridor === k.b.corridor.id && g.links.get(m.outLink)!.corridor === k.a.corridor.id);
  expect(moves.length).toBeGreaterThan(0);
  return { k, move: moves[0] };
}

describe('Скругление угла: геометрия дуги', () => {
  it('касательная, глубина и радиус — согласованы; у прямого угла касательная равна радиусу', () => {
    expect(filletTangent(10, Math.PI / 2)).toBeCloseTo(10, 6);
    expect(filletDepth(10, Math.PI / 2)).toBeCloseTo(10 * (Math.SQRT2 - 1), 6);
    for (const theta of [0.4, 1, Math.PI / 2, 2.2]) {
      for (const r of [3, 17, 60]) expect(filletRadius(filletDepth(r, theta), theta)).toBeCloseTo(r, 6);
    }
    // Площадь асфальта угла: у прямого — квадрат r×r без четверти круга.
    expect(filletArea(10, Math.PI / 2)).toBeCloseTo(100 * (1 - Math.PI / 4), 6);
    // Острый угол — асфальта при том же радиусе намного больше.
    expect(filletArea(10, 0.5)).toBeGreaterThan(filletArea(10, Math.PI / 2) * 10);
  });

  it('траектория «прямо — дуга — прямо»: самая широкая дуга, касается обеих полос', () => {
    // На восток от (−20, 0), направо — на юг (экран: y вниз) к (10, 20): прямо до (−10, 0), дуга радиуса 20.
    const path = filletPath({ pos: { x: -20, y: 0 }, dir: { x: 1, y: 0 } }, { pos: { x: 10, y: 20 }, dir: { x: 0, y: 1 } })!;
    expect(path.r).toBeCloseTo(20, 6);
    expect(path.points[0]).toEqual({ x: -20, y: 0 });
    expect(path.points[1].x).toBeCloseTo(-10, 6);
    const end = path.points[path.points.length - 1];
    expect(end.x).toBeCloseTo(10, 6);
    expect(end.y).toBeCloseTo(20, 6);
    const center = { x: -10, y: 20 };
    for (const p of path.points.slice(1)) expect(dist(p, center)).toBeCloseTo(20, 6);
    expect(dist(path.mid.pos, center)).toBeCloseTo(20, 6);
    // Параллельные и разворот — не дуга.
    expect(filletPath({ pos: { x: 0, y: 0 }, dir: { x: 1, y: 0 } }, { pos: { x: 10, y: 5 }, dir: { x: 1, y: 0 } })).toBeNull();
    expect(filletPath({ pos: { x: 0, y: 0 }, dir: { x: 1, y: 0 } }, { pos: { x: 0, y: 7 }, dir: { x: -1, y: 0 } })).toBeNull();
  });

  it('бордюр угла — дуга окружности, касательная к кромкам, до ближнего из обрезов; дальше по другой кромке — прямо', () => {
    // Кромки: вдоль +x от (17, 5) и вдоль +y от (5, 30) — сходятся в (5, 5); ближний обрез — в 12 м от вершины.
    const curb = cornerCurb({ x: 17, y: 5 }, { x: 1, y: 0 }, { x: 5, y: 30 }, { x: 0, y: 1 });
    const center = { x: 17, y: 17 };
    for (const p of curb.pts) expect(dist(p, center)).toBeCloseTo(12, 6);
    expect(curb.pts[0].x).toBeCloseTo(17, 6);
    expect(curb.pts[0].y).toBeCloseTo(5, 6);
    // По кромке b дуга кончается в 12 м от вершины, до (5, 30) — прямо.
    expect(curb.pts[curb.pts.length - 1].y).toBeCloseTo(17, 6);
    expect(dist(curb.mid, { x: 5, y: 5 })).toBeCloseTo(filletDepth(12, Math.PI / 2), 6);
    // Внешняя сторона излома — прежняя плавная кривая.
    expect(cornerCurb({ x: 30, y: 5 }, { x: 1, y: 0 }, { x: 5, y: 30 }, { x: 0, y: 1 }, true).pts.length).toBe(11);
  });

  it('поворот вдоль угла — дуга с тем же центром, что бордюр: на асфальте при любых обрезах', () => {
    // Кромки угла 60°: a — вдоль +x от вершины (0, 0), b — под 60°. Полоса — в 5 м от кромки (полполосы и запас).
    const th = Math.PI / 3;
    const eb = { x: Math.cos(th), y: Math.sin(th) };
    const nb = { x: -eb.y, y: eb.x };
    for (const [la, lb] of [
      [20, 20],
      [80, 20],
      [15, 90],
    ]) {
      const curb = cornerCurb({ x: la, y: 0 }, { x: 1, y: 0 }, scale(eb, lb), eb);
      // Концы полос у тех же обрезов, на 5 м внутрь (к перекрёстку): въезд по b к вершине, выезд по a от неё.
      const from = { pos: add(scale(eb, lb), scale(nb, 5)), dir: scale(eb, -1) };
      const to = { pos: { x: la, y: -5 }, dir: { x: 1, y: 0 } };
      const path = filletPath(from, to)!;
      // Центр дуги бордюра и дуги поворота — общий; поворот внутри бордюра на те же 5 м.
      const T = Math.min(la, lb);
      const c = scale(norm(add({ x: 1, y: 0 }, eb)), (T * Math.tan(th / 2)) / Math.sin(th / 2));
      for (const p of curb.pts) expect(dist(p, c)).toBeCloseTo(T * Math.tan(th / 2), 4);
      expect(path.r).toBeCloseTo(T * Math.tan(th / 2) + 5, 4);
      for (const p of path.points) expect(dist(p, c)).toBeGreaterThan(T * Math.tan(th / 2) + 5 - 1e-6);
    }
  });
});

describe('Скругление угла на перекрёстке', () => {
  it('углы — между соседними подъездами, вершина — где сходятся их кромки', () => {
    const { net, node } = junction([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    const corners = junctionCorners(net, node);
    expect(corners.length).toBe(4);
    for (const k of corners) {
      expect(k.theta).toBeCloseTo(Math.PI / 2, 6);
      expect(k.da).toBeCloseTo(HALF, 6);
      expect(k.db).toBeCloseTo(HALF, 6);
      expect(Math.abs(k.apex.x)).toBeCloseTo(HALF, 6);
      expect(Math.abs(k.apex.y)).toBeCloseTo(HALF, 6);
      // Биссектриса — от узла наружу, через вершину.
      expect(dist(add(k.apex, k.out), { x: 0, y: 0 })).toBeGreaterThan(dist(k.apex, { x: 0, y: 0 }));
    }
    // Прямой проезд без поперечных дорог — не угол.
    const straight = junction([0, Math.PI]);
    expect(junctionCorners(straight.net, straight.node)).toEqual([]);
  });

  it('радиус угла отодвигает обрезы только двух его подъездов — до начала дуги', () => {
    const { net, node, ids } = junction([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    const ends = net.ends(node);
    const plain = nodeCuts(net, node, ends);
    // Как и раньше: за краем поперечной улицы и запас на угол.
    for (const c of plain) expect(c).toBeCloseTo(HALF + 6, 6);
    const key = cornerKey(ids[0], ids[1]);
    setCornerRadius(net, node.id, key, 30);
    const cuts = nodeCuts(net, node, ends);
    ends.forEach((e, i) => {
      const mine = e.corridor.id === ids[0] || e.corridor.id === ids[1];
      expect(cuts[i]).toBeCloseTo(mine ? HALF + 30 : HALF + 6, 6);
    });
  });

  it('правый поворот вдоль скруглённого угла — по дуге вокруг бордюра, быстрее, чем у острого угла', () => {
    // Острый угол ~34°, как на «косом» перекрёстке: восток и северо-восток.
    const { net, node, ids } = junction([0, Math.PI, -0.6, Math.PI - 0.6]);
    const key = cornerKey(ids[0], ids[2]);
    const before = rightTurn(net, node.id, key).move;
    expect(junctionCorners(net, node).find((k) => k.key === key)!.theta).toBeCloseTo(0.6, 6);
    setCornerRadius(net, node.id, key, 30);
    const { k, move } = rightTurn(net, node.id, key);
    // Дуга полосы — вокруг того же центра, что дуга бордюра, на расстоянии бордюр—ось полосы.
    const center = add(k.apex, scale(k.out, 30 / Math.sin(k.theta / 2)));
    for (const p of move.points) expect(dist(p, center)).toBeGreaterThan(30 + CURB_TO_LANE - 0.3);
    const radius = Math.min(...move.points.map((p) => dist(p, center)));
    expect(radius).toBeCloseTo(30 + CURB_TO_LANE, 0);
    expect(move.speed).toBeCloseTo(Math.min(laneSpeed(k.a.corridor), turnSpeed(30 + CURB_TO_LANE)), 1);
    expect(move.speed).toBeGreaterThan(before.speed * 1.5);
    // То же — в подсказке инструмента: скорость поворота и середина дуги.
    const turn = cornerTurn(net, node, k)!;
    expect(turn.r).toBeCloseTo(30 + CURB_TO_LANE, 1);
    expect(turn.kmh).toBeGreaterThan(before.speed * 2.2 * 1.5);
    // Левый поворот через встречку и прочие манёвры — прежней кривой.
    const g = new LaneGraph(net);
    const left = [...g.moves.values()].find((m) => m.node === node.id && g.links.get(m.inLink)!.corridor === ids[0] && g.links.get(m.outLink)!.corridor === ids[2]);
    expect(left?.points.length).toBe(11);
  });

  it('ручка — середина бордюра: тянут по биссектрисе — радиус по положению курсора, не больше предела', () => {
    const { net, node, ids } = junction([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    const key = cornerKey(ids[0], ids[1]);
    const h = cornerHandles(net, node).find((x) => x.corner.key === key)!;
    expect(h.radius).toBeUndefined();
    // Сам угол — по запасу в 6 м: у прямого угла радиус тоже 6.
    expect(h.auto).toBeCloseTo(6, 6);
    const at = (r: number) => add(h.corner.apex, scale(h.corner.out, filletDepth(r, h.corner.theta)));
    expect(cornerRadiusAt(h, at(25))).toBe(25);
    // Внутрь, ближе, чем угол скруглён сам, — снова само.
    expect(cornerRadiusAt(h, at(4))).toBe(0);
    // Дальше предела — предел: не больше CORNER_R_MAX — и почему.
    expect(cornerRadiusAt(h, at(1000))).toBe(Math.round(h.max));
    expect(h.max).toBe(CORNER_R_MAX);
    expect(h.limit).toBe('radius');
    // Короткие ветки до тупиков: обрез — до CORNER_GAP от тупика (стоп-линии у тупика нет), держит узел дороги.
    const short = junction([0, Math.PI / 2, Math.PI, -Math.PI / 2], 100);
    const tight = cornerHandles(short.net, short.node)[0];
    expect(tight.max).toBeCloseTo(100 - CORNER_GAP - HALF, 3);
    expect(tight.limit).toBe('node');
    expect(cornerLimitText(tight.limit)).toBe('упирается в узел на дороге');
    // Скруглили — ручка на новой дуге.
    setCornerRadius(net, node.id, key, 25);
    const after = cornerHandles(net, node).find((x) => x.corner.key === key)!;
    expect(after.radius).toBe(25);
    expect(dist(after.pos, at(25))).toBeLessThan(0.01);
    // И асфальт угла стоит денег.
    expect(cornerCost(net, node)).toBeGreaterThan(0);
    setCornerRadius(net, node.id, key, 0);
    expect(node.corners).toBeUndefined();
  });

  it('настройка угла — новым объектом: копия сети (предпросмотр, отмена) не меняет оригинал; разрезанное полотно — под новым именем', () => {
    const { net, node, ids } = junction([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    const key = cornerKey(ids[0], ids[1]);
    setCornerRadius(net, node.id, key, 20);
    const copy = net.clone();
    setCornerRadius(copy, node.id, key, 40);
    expect(net.node(node.id).corners).toEqual({ [key]: 20 });
    expect(copy.node(node.id).corners).toEqual({ [key]: 40 });
    // Сохранение — как есть.
    expect(LaneNet.fromJSON(JSON.parse(JSON.stringify(net.toJSON()))).node(node.id).corners).toEqual({ [key]: 20 });
    renameArm(net.node(node.id), ids[0], 99);
    expect(net.node(node.id).corners).toEqual({ [cornerKey(99, ids[1])]: 20 });
    expect(remapCorners({ '1-2': 5, '2-3': 7 }, (x) => (x === 3 ? undefined : x + 10))).toEqual({ '11-12': 5 });
  });
});

const HIGHWAY = { cls: 'highway' as const, lanes: twoWay(2, 2) };
const P = (x: number, y: number) => ({ x, y });
const seam = (id: number, pos: Vec, dir: Vec) => ({ id, kind: 'seam' as const, pos, dir, level: 0 });
const line = (id: number, a: number, b: number, p0: Vec, p3: Vec) => ({
  id,
  a,
  b,
  portA: 0,
  portB: 0,
  ...HIGHWAY,
  lanes: HIGHWAY.lanes.map((l) => ({ ...l, to: 1e9 })),
  curve: { p0, p1: add(p0, scale(add(p3, scale(p0, -1)), 1 / 3)), p2: add(p0, scale(add(p3, scale(p0, -1)), 2 / 3)), p3 },
});

/**
 * Перекрёсток игрока из замечания («А почему больше не помещается?»): косые магистрали 2+2, западная ветка — 139 м до
 * узла, юго-западная — 211 м; острый угол между ними (~39°) раньше упирался в 45% длины западной ветки — радиус 7 м.
 */
function playerJunction(): { net: LaneNet; node: number } {
  const J = P(-21.21, -14.24);
  const net = LaneNet.fromJSON({
    nextId: 2000,
    nodes: [
      seam(1471, P(-197.64, 101.62), P(0.8359, -0.5489)),
      { id: 1476, kind: 'junction', pos: J, dir: P(1, 0), level: 0 },
      seam(1474, P(-159.6, -28.58), P(0.9947, 0.1031)),
      seam(1472, P(125.25, -111.02), P(0.8343, -0.5513)),
      seam(1475, P(142.18, 2.7), P(0.9947, 0.1031)),
    ],
    corridors: [
      line(1477, 1471, 1476, P(-197.64, 101.62), J),
      line(1479, 1474, 1476, P(-159.6, -28.58), J),
      line(1478, 1476, 1472, J, P(125.25, -111.02)),
      line(1480, 1476, 1475, J, P(142.18, 2.7)),
    ],
  });
  return { net, node: 1476 };
}

describe('Предел скругления угла', () => {
  it('у перекрёстка игрока острый угол скругляется до ~30 м, а не 7: обрез идёт почти до узла на ветке', () => {
    const { net, node } = playerJunction();
    const h = cornerHandles(net, net.node(node)).find((x) => x.corner.key === '1477-1479')!;
    expect(h.corner.theta).toBeCloseTo(0.687, 2);
    expect(h.max).toBeGreaterThan(28);
    // Держит западная ветка: до узла на ней — CORNER_GAP.
    expect(h.limit).toBe('node');
    const west = net.ends(net.node(node)).find((e) => e.corridor.id === 1479)!;
    expect(cutCap(net, west)).toEqual({ cap: west.corridor.length - CORNER_GAP, why: 'node' });
    setCornerRadius(net, node, h.corner.key, h.max);
    const cuts = nodeCuts(net, net.node(node));
    const i = net.ends(net.node(node)).findIndex((e) => e.corridor.id === 1479);
    expect(cuts[i]).toBeGreaterThan(west.corridor.length - CORNER_GAP - 1.5);
    expect(cuts[i]).toBeLessThanOrEqual(west.corridor.length - CORNER_GAP + 1e-6);
  });

  it('перекрёсток на том конце полотна: обрез — до его стоп-линии; оба скругляют это полотно — каждому по 45%', () => {
    const net = new LaneNet();
    const j1 = net.addJunction({ x: 0, y: 0 });
    const j2 = net.addJunction({ x: 150, y: 0 });
    const mid = net.addCorridor(j1.id, j2.id, STREET);
    const arm = (j: { id: number }, d: Vec) => net.addCorridor(j.id, net.addSeam(add(net.node(j.id).pos, scale(d, 300)), d).id, STREET);
    const n1 = arm(j1, P(0, -1));
    arm(j1, P(-1, 0));
    const n2 = arm(j2, P(0, -1));
    arm(j2, P(1, 0));
    const at1 = net.ends(j1).find((e) => e.corridor.id === mid.id)!;
    // У перекрёстка j2 обрез полотна сам — за краем поперечной улицы и запасом на угол.
    const far = nodeCuts(net, j2)[net.ends(j2).findIndex((e) => e.corridor.id === mid.id)];
    expect(cutCap(net, at1)).toEqual({ cap: 150 - far - CORNER_GAP, why: 'junction' });
    // j2 скругляет свой угол на этом полотне: ему — до стоп-линии j1 (та на месте), а j1 — уже не дальше 45%.
    setCornerRadius(net, j2.id, cornerKey(mid.id, n2.id), 20);
    const at2 = net.ends(j2).find((e) => e.corridor.id === mid.id)!;
    const near = nodeCuts(net, j1)[net.ends(j1).findIndex((e) => e.corridor.id === mid.id)];
    expect(cutCap(net, at2)).toEqual({ cap: 150 - near - CORNER_GAP, why: 'junction' });
    expect(cutCap(net, at1)).toEqual({ cap: 150 * 0.45, why: 'junction' });
    // Скругляют оба — каждому не дальше 45%: друг на друга не наедут.
    setCornerRadius(net, j1.id, cornerKey(mid.id, n1.id), 20);
    expect(cutCap(net, at1).cap).toBeCloseTo(150 * 0.45, 6);
    expect(cutCap(net, at2).cap).toBeCloseTo(150 * 0.45, 6);
    // Дальше CORNER_CUT_MAX стоп-линию не уводим: держит она.
    const north = net.ends(j1).find((e) => e.corridor.id === n1.id)!;
    expect(cutCap(net, north)).toEqual({ cap: CORNER_CUT_MAX, why: 'stop' });
    expect(cornerLimitText('stop')).toContain(`${CORNER_CUT_MAX} м`);
    expect(cornerLimitText('junction')).toBe('упирается в соседний перекрёсток');
  });

  it('скругление угла не растягивает соседний угол того же подъезда: его бордюр — прежний, до отодвинутого обреза прямо', () => {
    const { net, node, ids } = junction([0, Math.PI, -0.75, Math.PI - 0.75]);
    const r = new LaneRenderer();
    const plate = (n: LaneNet) => {
      r.cutsOf(n);
      return (r as unknown as { plateGeo(net: LaneNet, n: LaneNode): { curbs: Vec[][] } }).plateGeo(n, n.node(node.id)).curbs;
    };
    const before = plate(net);
    const after = net.clone();
    setCornerRadius(after, node.id, cornerKey(ids[0], ids[2]), 30);
    const curbs = plate(after);
    const kept = (old: Vec[]) => curbs.some((c) => old.every((p) => c.some((q) => dist(p, q) < 1e-6)));
    // Меняется только скруглённый угол; у остальных трёх — те же точки бордюра (плюс прямой кусок вдоль кромки).
    expect(before.filter(kept).length).toBe(3);
  });
});
