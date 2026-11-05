import { describe, expect, it } from 'vitest';
import { GRADE } from '../config';
import { angleOf, dist, sub, type Vec } from '../core/vec';
import { bridgeLook, deckAlong, levelDeck, MAX_LOOK, nodeDeck } from './deck';
import { LaneRenderer } from './draw';
import { LaneNet, twoWay } from './model';

/** Прямое полотно на 100 м с запада на восток между узлами на уровнях la и lb (с высотами моста da, db). */
function span(la: number, lb: number, da?: number, db?: number) {
  const net = new LaneNet();
  const A = net.addSeam({ x: 0, y: 0 }, { x: 1, y: 0 }, la);
  const B = net.addSeam({ x: 100, y: 0 }, { x: 1, y: 0 }, lb);
  if (da !== undefined) A.deck = da;
  if (db !== undefined) B.deck = db;
  const c = net.addCorridor(A.id, B.id, { cls: 'street', lanes: twoWay(1, 1) });
  return { net, c };
}

/**
 * Длинный мост по дуге (радиус 300 м) из кусков ~90 м: с земли на мост, выше, ещё выше (выше MAX_LOOK),
 * ниже и снова на землю — как мост «Авто» из нескольких дорог с разным −/+.
 */
function curvedBridge(decks: (number | undefined)[], levels: number[]) {
  const net = new LaneNet();
  const R = 300;
  const nodes = levels.map((level, i) => {
    const a = -0.9 + i * 0.3;
    const n = net.addSeam({ x: R * Math.sin(a), y: R - R * Math.cos(a) }, { x: Math.cos(a), y: Math.sin(a) }, level);
    if (decks[i] !== undefined) n.deck = decks[i];
    return n;
  });
  const corridors = nodes.slice(1).map((n, i) => net.addCorridor(nodes[i].id, n.id, { cls: 'highway', lanes: twoWay(1, 1) }));
  return { net, corridors };
}

/** Холст, который запоминает заливки и линии: стиль и точки. */
function recorder() {
  const fills: { style: string; pts: Vec[] }[] = [];
  const strokes: { style: string; width: number; pts: Vec[] }[] = [];
  let pts: Vec[] = [];
  const state: Record<string | symbol, unknown> = {};
  const api: Record<string, (...a: number[]) => void> = {
    beginPath: () => void (pts = []),
    moveTo: (x, y) => void pts.push({ x, y }),
    lineTo: (x, y) => void pts.push({ x, y }),
    fill: () => void fills.push({ style: String(state.fillStyle), pts: [...pts] }),
    stroke: () => void strokes.push({ style: String(state.strokeStyle), width: Number(state.lineWidth), pts: [...pts] }),
  };
  const ctx = new Proxy(state, {
    get: (t, k) => (typeof k === 'string' && k in api ? api[k] : k in t ? t[k] : () => {}),
    set: (t, k, v) => ((t[k] = v), true),
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, strokes };
}

/** Тени и кромки полотен моста (слой layer) по порядку полотен: левая кромка и её тень. */
function shadows(net: LaneNet, layer = 1) {
  const { ctx, fills, strokes } = recorder();
  new LaneRenderer().draw(ctx, net, 1, false, undefined, layer);
  const shade = fills.filter((f) => f.style === 'rgba(20, 30, 20, 0.28)');
  // Бордюры — сначала левая, потом правая кромка каждого полотна.
  const edges = strokes.filter((s) => s.style === '#4b525c' && s.width === 2.5);
  return net.corridors.size
    ? [...net.corridors.values()].map((_, i) => {
        const all = edges[i * 2].pts;
        const sh = shade[i].pts.slice(0, all.length);
        // Совпавшие соседние отметки (две отметки на одном месте) — одна точка.
        const keep = all.map((p, k) => k === 0 || dist(p, all[k - 1]) > 1e-6);
        return { left: all.filter((_, k) => keep[k]), shadow: sh.filter((_, k) => keep[k]) };
      })
    : [];
}

/** Угол от направления u к направлению v, градусы (−180…180). */
const between = (u: Vec, v: Vec) => {
  let d = angleOf(v) - angleOf(u);
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return (d * 180) / Math.PI;
};
/** Поворот ломаной в точке b, градусы. */
const turn = (a: Vec, b: Vec, c: Vec) => between(sub(b, a), sub(c, b));

describe('Высота моста для вида', () => {
  it('по уровню — обычная, у моста «Авто» — своя; у земли и тоннеля своя высота не в счёт', () => {
    expect(levelDeck(0)).toBe(0);
    expect(levelDeck(1)).toBe(GRADE.bridgeDeck);
    expect(levelDeck(-1)).toBe(-GRADE.tunnelDepth);
    expect(nodeDeck({ level: 1 })).toBe(GRADE.bridgeDeck);
    expect(nodeDeck({ level: 1, deck: 14 })).toBe(14);
    expect(nodeDeck({ level: 0, deck: 14 })).toBe(0);
  });

  it('вдоль полотна — от узла к узлу плавно: у узлов не меняется, посередине — среднее', () => {
    const { net, c } = span(1, 1, 6, 14);
    expect(deckAlong(net, c, 0)).toBeCloseTo(6, 6);
    expect(deckAlong(net, c, c.length / 2)).toBeCloseTo(10, 6);
    expect(deckAlong(net, c, c.length)).toBeCloseTo(14, 6);
    // У узлов высота стоит на месте — на стыке с соседним полотном нет излома.
    expect(deckAlong(net, c, 0.5) - 6).toBeLessThan(0.01);
    expect(14 - deckAlong(net, c, c.length - 0.5)).toBeLessThan(0.01);
    const ramp = span(0, 1, undefined, 12);
    expect(deckAlong(ramp.net, ramp.c, 0)).toBe(0);
    expect(deckAlong(ramp.net, ramp.c, ramp.c.length)).toBeCloseTo(12, 6);
    // Выше MAX_LOOK и ниже земли — не бывает.
    const high = span(1, 1, 30, 40);
    expect(deckAlong(high.net, high.c, 50)).toBe(MAX_LOOK);
    expect(deckAlong(span(-1, 0).net, span(-1, 0).c, 10)).toBe(0);
  });

  it('через стык кусков — та же высота и тот же наклон; растёт без ступенек, между узлами не выходит за их высоты', () => {
    const { net, corridors } = curvedBridge([undefined, 6, 12, 18, 14, undefined], [0, 1, 1, 1, 1, 0]);
    const e = 0.01;
    for (let k = 1; k < corridors.length; k++) {
      const a = corridors[k - 1];
      const b = corridors[k];
      expect(deckAlong(net, a, a.length)).toBeCloseTo(deckAlong(net, b, 0), 9);
      const before = (deckAlong(net, a, a.length) - deckAlong(net, a, a.length - e)) / e;
      const after = (deckAlong(net, b, e) - deckAlong(net, b, 0)) / e;
      expect(Math.abs(before - after)).toBeLessThan(0.002);
    }
    // Подъём 6 → 12 → 18: на узлах 12 м высота не замирает (иначе тень идёт волнами), на вершине 18 м — замирает.
    const slope = (c: (typeof corridors)[number]) => (deckAlong(net, c, e) - deckAlong(net, c, 0)) / e;
    expect(slope(corridors[2])).toBeGreaterThan(0.03);
    expect(Math.abs(slope(corridors[3]))).toBeLessThan(0.002);
    for (const c of corridors) {
      const ends = [nodeDeck(net.node(c.a)), nodeDeck(net.node(c.b))];
      for (let s = 0; s <= c.length; s += c.length / 50) {
        const h = deckAlong(net, c, s);
        expect(h).toBeGreaterThanOrEqual(Math.min(...ends) - 1e-9);
        expect(h).toBeLessThanOrEqual(Math.max(...ends) + 1e-9);
      }
    }
  });

  it('вид моста: на земле — без сдвигов; у обычного моста тень та же, что была (9 × 14)', () => {
    expect(bridgeLook(0)).toEqual({ shadow: { x: 0, y: 0 }, lift: { x: 0, y: 0 } });
    const usual = bridgeLook(GRADE.bridgeDeck);
    expect(usual.shadow.x).toBeCloseTo(9, 6);
    expect(usual.shadow.y).toBeCloseTo(14, 6);
  });

  it('выше мост — дальше тень и выше полотно; каждые 2 м (−/+) заметны; дальше MAX_LOOK — не уходит', () => {
    let prev = bridgeLook(4);
    for (let m = 6; m <= MAX_LOOK; m += GRADE.riseStep) {
      const v = bridgeLook(m);
      expect(v.shadow.y - prev.shadow.y).toBeGreaterThan(3);
      expect(v.shadow.x).toBeGreaterThan(prev.shadow.x);
      // Полотно поднимается (на экране вверх), тень уходит вниз — расходятся.
      expect(v.lift.y).toBeLessThan(prev.lift.y);
      prev = v;
    }
    expect(bridgeLook(60)).toEqual(bridgeLook(MAX_LOOK));
    expect(bridgeLook(-5)).toEqual(bridgeLook(0));
  });
});

describe('Тень длинного изогнутого моста из кусков разной высоты', () => {
  const { net, corridors } = curvedBridge([undefined, 10, 26, 16, 6, undefined], [0, 1, 1, 1, 1, 0]);
  const parts = shadows(net);
  const far = dist(bridgeLook(MAX_LOOK).shadow, bridgeLook(MAX_LOOK).lift);

  it('у каждого полотна своя тень — по всем точкам его кромки', () => {
    expect(parts).toHaveLength(corridors.length);
    for (const p of parts) expect(p.shadow.length).toBe(p.left.length);
  });

  it('тень — та же кривая, что кромка: сдвиг меняется плавно, без ломаной и уступов', () => {
    for (const { left, shadow } of parts) {
      for (let i = 1; i < left.length; i++) {
        // Кусок тени идёт почти туда же, куда кусок кромки над ним.
        expect(Math.abs(between(sub(left[i], left[i - 1]), sub(shadow[i], shadow[i - 1])))).toBeLessThan(25);
      }
      for (let i = 2; i < left.length; i++) {
        // И поворачивает так же — без углов: тень гнётся вместе с мостом, а не идёт ломаной.
        expect(Math.abs(turn(shadow[i - 2], shadow[i - 1], shadow[i]) - turn(left[i - 2], left[i - 1], left[i]))).toBeLessThan(4);
      }
    }
  });

  it('на стыках кусков тень непрерывна и без излома', () => {
    for (let k = 1; k < parts.length; k++) {
      const a = parts[k - 1];
      const b = parts[k];
      expect(dist(a.left[a.left.length - 1], b.left[0])).toBeLessThan(1e-6);
      expect(dist(a.shadow[a.shadow.length - 1], b.shadow[0])).toBeLessThan(1e-6);
      // Поворот тени на стыке — как у кромки.
      const kinkShadow = turn(a.shadow[a.shadow.length - 2], b.shadow[0], b.shadow[1]);
      const kinkEdge = turn(a.left[a.left.length - 2], b.left[0], b.left[1]);
      expect(Math.abs(kinkShadow - kinkEdge)).toBeLessThan(3);
    }
  });

  it('тень не уходит от моста дальше, чем у моста высотой MAX_LOOK; у съезда на землю — под ним', () => {
    for (const { left, shadow } of parts) for (let i = 0; i < left.length; i++) expect(dist(left[i], shadow[i])).toBeLessThanOrEqual(far + 1e-6);
    expect(dist(parts[0].left[0], parts[0].shadow[0])).toBeLessThan(1e-6);
    const last = parts[parts.length - 1];
    expect(dist(last.left[last.left.length - 1], last.shadow[last.shadow.length - 1])).toBeLessThan(1e-6);
  });

  it('эстакада (уровень 2) — тень ровно параллельна полотну', () => {
    const est = curvedBridge([], [2, 2, 2]);
    const parts = shadows(est.net, 2);
    expect(parts).toHaveLength(2);
    for (const { left, shadow } of parts) {
      const d0 = sub(shadow[0], left[0]);
      for (let i = 0; i < left.length; i++) expect(dist(sub(shadow[i], left[i]), d0)).toBeLessThan(1e-6);
      expect(dist(d0, { x: 0, y: 0 })).toBeCloseTo(dist(bridgeLook(2 * GRADE.bridgeDeck).shadow, bridgeLook(2 * GRADE.bridgeDeck).lift), 6);
    }
  });
});
