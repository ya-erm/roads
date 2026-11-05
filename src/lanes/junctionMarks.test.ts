import { describe, expect, it } from 'vitest';
import { dist, scale, Vec } from '../core/vec';
import { LANE_W } from '../world/roadTypes';
import { setCornerRadius } from './corners';
import { cornerKey, junctionCuts } from './geometry';
import {
  clipGuide,
  curbSegments,
  freeIslands,
  GUIDE_CURB_GAP,
  guideLines,
  insidePoly,
  isSkewed,
  junctionMarks,
  loopArea,
  resample,
  TurnPath,
  wantsMarks,
} from './junctionMarks';
import { LaneNet, LaneSlot, twoWay } from './model';
import { LaneRenderer } from './draw';

const STREET = { cls: 'street' as const, lanes: twoWay(1, 1) };
const AVENUE = { cls: 'avenue' as const, lanes: twoWay(2, 2) };
const P = (x: number, y: number): Vec => ({ x, y });

/** Перекрёсток в (0, 0) с ветками по углам (рад) длиной 300 м; чётные — от узла, нечётные — к узлу. */
function junction(angles: number[], road: { cls: 'street' | 'avenue'; lanes: LaneSlot[] }) {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 });
  const ids = angles.map((a, i) => {
    const d: Vec = { x: Math.cos(a), y: Math.sin(a) };
    const far = scale(d, 300);
    return (i % 2 === 0 ? net.addCorridor(j.id, net.addSeam(far, d).id, road) : net.addCorridor(net.addSeam(far, scale(d, -1)).id, j.id, road)).id;
  });
  return { net, node: net.node(j.id), ids };
}

/** Площадка перекрёстка — как её рисует отрисовка. */
function plateOf(net: LaneNet, id: number): Vec[] {
  return new LaneRenderer().plateOf(net, id)!;
}

/** Ближе всего от точек контуров к ломаной. */
function nearest(loops: Vec[][], path: Vec[]): number {
  const fine = resample(path, 200);
  return Math.min(...loops.flat().map((p) => Math.min(...fine.map((q) => dist(p, q)))));
}

const path = (o: Partial<TurnPath> & { points: Vec[] }): TurnPath => {
  let length = 0;
  for (let i = 1; i < o.points.length; i++) length += dist(o.points[i - 1], o.points[i]);
  return { inLink: 1, inIndex: 0, outLink: 2, outIndex: 0, kind: 'straight', theta: 0, length, dirIn: P(1, 0), crosses: [], ...o };
};

describe('Островки штриховки: асфальт, по которому не ездят', () => {
  it('квадрат 100×100 и проезд посередине — два островка: дальше полполосы с запасом от траектории и отступа от бордюра', () => {
    const plate = [P(0, 0), P(100, 0), P(100, 100), P(0, 100)];
    const through = [P(-5, 50), P(105, 50)];
    const loops = freeIslands(plate, [through], { clear: 4.5, curb: 0.8 });
    expect(loops.length).toBe(2);
    for (const loop of loops) expect(Math.abs(loopArea(loop))).toBeCloseTo((50 - 4.5 - 0.8) * (100 - 1.6), -2);
    expect(nearest(loops, through)).toBeGreaterThan(4.5 - 0.05);
  });

  it('мелкие обрывки и узкие полоски — не штрихуем', () => {
    const plate = [P(0, 0), P(100, 0), P(100, 100), P(0, 100)];
    // Траектории оставляют посередине карман примерно 5×5 м — меньше порога площади.
    const paths = [
      [P(-5, 40), P(105, 40)],
      [P(-5, 60), P(105, 60)],
      [P(40, -5), P(40, 105)],
      [P(60, -5), P(60, 105)],
    ];
    const loops = freeIslands(plate, paths, { clear: 7.5, curb: 0.8, minArea: 30 });
    expect(loops.every((l) => Math.abs(loopArea(l)) > 30)).toBe(true);
    // Узкая полоска у бордюра шириной ~1 м — тоже нет.
    const strip = freeIslands(plate, [[P(-5, 7.5), P(105, 7.5)], [P(-5, 50), P(105, 50)], [P(-5, 92.5), P(105, 92.5)]], { clear: 6, curb: 0.5, minWidth: 2 });
    for (const l of strip) expect(Math.abs(loopArea(l))).toBeGreaterThan(500);
  });
});

describe('Направляющие пунктиры: только где без них путаются', () => {
  const straight = (inIndex: number, y: number, len = 60) => path({ inIndex, outIndex: inIndex, points: [P(0, y), P(len, y)] });

  it('прямо: границы попутных полос — на длинном или косом перекрёстке, на коротком прямом — нет', () => {
    const long = guideLines([straight(0, 0), straight(1, 7)], { skew: false });
    expect(long.length).toBe(1);
    expect(long[0].pts[0].y).toBeCloseTo(3.5, 6);
    expect(long[0].solid).toBe(false);
    expect(guideLines([straight(0, 0, 20), straight(1, 7, 20)], { skew: false })).toEqual([]);
    expect(guideLines([straight(0, 0, 20), straight(1, 7, 20)], { skew: true }).length).toBe(1);
    // Одна полоса — границы нет.
    expect(guideLines([straight(0, 0)], { skew: true })).toEqual([]);
  });

  /** Четверть окружности радиуса r: на восток и налево — на север вокруг (0, −50) (ось y вниз); sign −1 — зеркально, направо вокруг (0, 50). */
  const quarter = (r: number, sign: -1 | 1) =>
    Array.from({ length: 13 }, (_, k) => {
      const f = (k / 12) * (Math.PI / 2);
      return P(r * Math.sin(f), sign * (-50 + r * Math.cos(f)));
    });
  const turn = (kind: 'left' | 'right', inIndex: number, r: number, theta = kind === 'left' ? -Math.PI / 2 : Math.PI / 2) =>
    path({ kind, inIndex, outIndex: inIndex, theta, points: quarter(r, kind === 'left' ? 1 : -1) });

  it('параллельные потоки одного подъезда — линия между ними: сплошная, если её никто не пересекает, иначе пунктир', () => {
    // Два левых двумя полосами, концентрично: между ними 7 м всю дорогу.
    const pair = [turn('left', 0, 30), turn('left', 1, 37)];
    const solo = guideLines(pair, { skew: false });
    expect(solo.length).toBe(1);
    expect(solo[0].solid).toBe(true);
    // Посередине — 33,5 м от центра дуг.
    for (const p of solo[0].pts) expect(dist(p, P(0, -50))).toBeCloseTo(33.5, 0);
    // Поперёк проходит встречный поток — пунктир.
    const across = path({ inLink: 5, outLink: 6, points: [P(5, -100), P(40, 20)] });
    const crossed = guideLines([...pair, across], { skew: false });
    expect(crossed.length).toBe(1);
    expect(crossed[0].solid).toBe(false);
    // Направо двумя полосами — так же (правые теперь тоже).
    const rights = guideLines([turn('right', 1, 30), turn('right', 0, 37)], { skew: false });
    expect(rights.length).toBe(1);
    expect(rights[0].solid).toBe(true);
    // Круче SHARP_TURN (~126°) — с ветки на соседнюю ветку (Y): без линии.
    expect(guideLines([turn('left', 0, 30, -2.44), turn('left', 1, 37, -2.44)], { skew: false })).toEqual([]);
  });

  it('развилка одной полосы в две — линия не от стоп-линии, а с места, где потоки разошлись на ширину полосы', () => {
    const a = path({ kind: 'right', theta: 0.7, outIndex: 0, points: [P(0, 0), P(20, 0), P(60, 0)] });
    const b = path({ kind: 'right', theta: 0.7, outIndex: 1, points: [P(0, 0), P(20, 0), P(30, 7), P(60, 7)] });
    const g = guideLines([a, b], { skew: false });
    expect(g.length).toBe(1);
    expect(g[0].solid).toBe(true);
    expect(g[0].pts[0].x).toBeGreaterThan(25);
    for (const p of g[0].pts) expect(p.y).toBeCloseTo(3.5, 0);
  });

  it('пунктир — только по асфальту площадки и не ближе метра к бордюру', () => {
    // Площадка 0..100 × 0..40; нижняя сторона (y = 40, x 30..60) — обрез подъезда, остальное — бордюр.
    const plate = [P(0, 0), P(100, 0), P(100, 40), P(60, 40), P(30, 40), P(0, 40)];
    const curb = curbSegments(plate, [[P(60, 40), P(30, 40)]]);
    expect(curb.length).toBe(5);
    // Из подъезда вверх и вправо за край площадки: остаётся кусок внутри, у бордюра — обрезан.
    const out = clipGuide([P(45, 40), P(45, 20), P(140, 20)], plate, curb);
    expect(out.length).toBe(1);
    for (const p of out[0]) {
      expect(insidePoly(p, plate)).toBe(true);
      expect(p.x).toBeLessThanOrEqual(100 - GUIDE_CURB_GAP + 1e-6);
    }
    // Начало у обреза подъезда не обрезается — там площадка переходит в дорогу.
    expect(out[0][0].y).toBeGreaterThan(38);
    // Вдоль бордюра в полуметре — пунктира нет.
    expect(clipGuide([P(10, 0.5), P(90, 0.5)], plate, curb)).toEqual([]);
  });

  it('длинный левый, пересекающий встречный левый, — пунктир по его внешней (правой) кромке', () => {
    const a = path({ kind: 'left', inLink: 1, points: resample([P(0, 0), P(40, 0), P(40, -40)], 12), dirIn: P(1, 0), crosses: [1] });
    const b = path({ kind: 'left', inLink: 3, points: resample([P(60, -10), P(20, -10), P(20, 30)], 12), dirIn: P(-1, 0), crosses: [0] });
    const g = guideLines([a, b], { skew: false });
    expect(g.length).toBe(2);
    // Внешняя кромка — на полполосы правее траектории.
    expect(g[0].solid).toBe(false);
    expect(Math.min(...g[0].pts.map((p) => Math.min(...resample(a.points, 200).map((q) => dist(p, q)))))).toBeCloseTo(LANE_W / 2, 0);
    // Встречного левого нет (или он не пересекается) — без пунктира.
    expect(guideLines([{ ...a, crosses: [] }, { ...b, crosses: [] }], { skew: false })).toEqual([]);
  });
});

describe('Разметка перекрёстка целиком', () => {
  it('маленький городской 1+1 × 1+1 — ничего; косой X проспектов 2+2 × 2+2 — островки и пунктиры', () => {
    const small = junction([0, Math.PI / 2, Math.PI, -Math.PI / 2], STREET);
    const cuts = junctionCuts(small.net);
    expect(wantsMarks(small.net, small.node, small.net.ends(small.node).map((e) => cuts.get(e.corridor.id)![e.end === 'a' ? 0 : 1]))).toBe(false);
    expect(junctionMarks(small.net, small.node, plateOf(small.net, small.node.id), cuts)).toBeNull();

    const x = junction([0, Math.PI, -0.75, Math.PI - 0.75], AVENUE);
    setCornerRadius(x.net, x.node.id, cornerKey(x.ids[0], x.ids[2]), 30);
    setCornerRadius(x.net, x.node.id, cornerKey(x.ids[1], x.ids[3]), 30);
    expect(isSkewed(x.net, x.node)).toBe(true);
    const t = performance.now();
    const m = junctionMarks(x.net, x.net.node(x.node.id), plateOf(x.net, x.node.id), junctionCuts(x.net))!;
    expect(performance.now() - t).toBeLessThan(500);
    expect(m.islands.length).toBeGreaterThan(0);
    expect(m.islands.reduce((s, l) => s + Math.abs(loopArea(l)), 0)).toBeGreaterThan(200);
    // Прямо — по одной границе попутных полос на каждом из четырёх подъездов.
    expect(m.guides.length).toBeGreaterThanOrEqual(4);
  });
});
