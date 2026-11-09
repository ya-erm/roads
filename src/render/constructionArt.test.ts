import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { CurveLUT } from '../core/bezier';
import type { Vec } from '../core/vec';
import { nextSite, pickSite } from '../game/constructionWork';
import { Game } from '../game/game';
import { wasCorridor } from '../game/rebuild';
import { anchorOf, AVENUE, clearStrip, HIGHWAY, road, STREET, withoutCitizens } from '../game/testkit';
import { closureOf, keepsPavement } from '../lanes/closure';
import { type RoadOptions, splitCorridor } from '../lanes/edit';
import { edgesAt } from '../lanes/geometry';
import { type Corridor, oneWay, slot, twoWay } from '../lanes/model';
import { openNet } from '../lanes/open';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { buildingCorridors, crewConvoy, crewRows, wideningBands } from './constructionArt';

/** Прямой проект улицы вдоль x длиной len в чистом поле, разрезанный стыком посередине: два участка подряд. */
function straightProject(len: number): { game: Game; y: number } {
  const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' }));
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 160) {
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + len, y } }), STREET, { project: true });
      if (!plan.ok || plan.demolish.length || !game.roadBuilder.apply(plan)) continue;
      const net = game.roads.net;
      const cs = buildingCorridors(net);
      if (cs.length !== 1 || cs.some((c) => net.node(c.a).level !== 0 || net.node(c.b).level !== 0)) continue;
      splitCorridor(net, cs[0], cs[0].length / 2, 'seam');
      return { game, y };
    }
  }
  throw new Error('нет места');
}

describe('Колонна техники стройки', () => {
  it('следующий участок, прямо продолжающий этот, колонна проходит по оси: без съезда на обочину и без скачков', () => {
    const { game, y } = straightProject(600);
    const net = game.roads.net;
    const list = () => [...buildingCorridors(net)].sort((p, q) => p.id - q.id);
    const first = pickSite(list(), () => false)!.c;
    const next = nextSite(net, first, buildingCorridors(net))!;
    expect(next.c).not.toBe(first);
    const track: { pos: Vec; site: Corridor; done: number }[][] = [];
    const run = (c: Corridor, fromB: boolean) => {
      for (let done = 0; ; done = Math.min(c.length, done + 0.1)) {
        c.build = { project: c.build!.project, done, ...(fromB ? { fromB: true } : {}) };
        track.push(crewConvoy(net, c).map((m) => ({ pos: m.pos, site: c, done })));
        if (done >= c.length) break;
      }
    };
    run(first, false);
    // Первый участок готов — открыт; второй заполняется от общего стыка.
    delete first.build;
    net.touch(first);
    expect(pickSite(list(), (n) => n === first.a || n === first.b)).toEqual(next);
    run(next.c, next.fromB);
    // Ни одна машина нигде не прыгает: за шаг 0,1 м работы край этапа уходит не дальше 0,7 м (разметка одна).
    for (let i = 1; i < track.length; i++) {
      for (let k = 0; k < 3; k++) {
        const [p, q] = [track[i - 1][k].pos, track[i][k].pos];
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1);
      }
    }
    // На стыке участков (конец первого, начало второго) вся колонна — на оси дороги, не на обочине.
    const join = track.filter((t) => (t[0].site === first && t[0].done > first.length - 1) || (t[0].site === next.c && t[0].done < 1));
    expect(join.length).toBeGreaterThan(2);
    for (const t of join) for (const m of t) expect(Math.abs(m.pos.y - y)).toBeLessThan(0.5);
    // Проект кончился — дальше идти некуда: колонна стоит у конца на оси, на обочину никто не съезжает (и нигде —
    // ни боком, ни по диагонали): курс каждой машины — вдоль оси.
    for (const t of track) for (const m of t) expect(Math.abs(m.pos.y - y)).toBeLessThan(0.5);
    const last = track[track.length - 1];
    expect(last[0].pos.x).toBeGreaterThan(last[1].pos.x);
    expect(last[1].pos.x).toBeGreaterThan(last[2].pos.x);
  });

  it('ряды бригад — поровну по ширине полотна, каждая посередине своей полосы; на однополосном — бок о бок в пределах полотна', () => {
    const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' }));
    /** Полотно проекта профилем lanes вдоль x в поле, заполняется от конца fromB. */
    const site = (lanes: RoadOptions['lanes'], fromB: boolean): Corridor => {
      for (let y = 400; y < game.terrain.height - 400; y += 120) {
        for (let x = 300; x < game.terrain.width - 700; x += 160) {
          const plan = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + 300, y } }), { cls: 'street', lanes }, { project: true });
          if (!plan.ok || plan.demolish.length || !game.roadBuilder.apply(plan)) continue;
          const c = buildingCorridors(game.roads.net).find((k) => Math.abs(k.lut.pointAt(0).y - y) < 1 && Math.abs(k.lut.pointAt(0).x - x) < 1)!;
          c.build = { project: c.build!.project, done: 100, ...(fromB ? { fromB: true } : {}) };
          return c;
        }
      }
      throw new Error('нет места');
    };
    /** Ряды n бригад — в пределах полотна с обочиной поперёк (вправо по ходу), по порядку, и их шаг; e — кромки (по ходу). */
    const check = (c: Corridor, n: number) => {
      const rows = crewRows(c, n);
      expect(rows).toHaveLength(n);
      const k = edgesAt(c, c.length / 2)!;
      const e = c.build!.fromB ? [-k[1], -k[0]] : [k[0], k[1]];
      for (const r of rows) {
        expect(r - 2.4).toBeGreaterThanOrEqual(e[0] - ROAD_MARGIN - 1e-6);
        expect(r + 2.4).toBeLessThanOrEqual(e[1] + ROAD_MARGIN + 1e-6);
      }
      for (let i = 1; i < n; i++) expect(rows[i]).toBeGreaterThan(rows[i - 1]);
      return { step: n > 1 ? rows[1] - rows[0] : 0, rows, e };
    };
    expect(crewRows(site(oneWay(1), false), 1)).toEqual([0]);
    for (const fromB of [false, true]) {
      const narrow = site(oneWay(1), fromB);
      // Два ряда на однополосном — плотно, но не друг на друге.
      expect(check(narrow, 2).step).toBeGreaterThan(3);
      // Широкий проспект 3+3: ширина поровну — каждая бригада посередине своей трети (шаг — треть ширины, больше 5 м).
      const wide = site(twoWay(3, 3), fromB);
      const w = check(wide, 3);
      const W = w.e[1] - w.e[0];
      expect(W / 3).toBeGreaterThan(5.2);
      w.rows.forEach((r, i) => expect(r).toBeCloseTo(w.e[0] + ((i + 0.5) * W) / 3, 6));
      const two = check(wide, 2);
      two.rows.forEach((r, i) => expect(r).toBeCloseTo(two.e[0] + ((i + 0.5) * W) / 2, 6));
    }
  });

  it('«◐ с проездом» на широкой и пристройка «Полосой»: ряды бригад — вне открытых прежних полос, не по оси среди машин', () => {
    const L = 300;
    const strip = (lanes: Corridor['lanes'], build: Corridor['build']): Corridor => {
      const curve = { p0: { x: 0, y: 0 }, p1: { x: L / 3, y: 0 }, p2: { x: (2 * L) / 3, y: 0 }, p3: { x: L, y: 0 } };
      const lut = new CurveLUT(curve);
      return { id: 1, a: 1, b: 2, portA: 0, portB: 0, curve, lut, length: lut.length, cls: 'highway', lanes, rev: 1, build } as Corridor;
    };
    const was = (lanes: Corridor['lanes'], more: object = {}) => ({ cls: 'highway' as const, lanes, len: L, value: 1, price: 1, work: 0.5, part: true as const, ...more });
    const MH = 2.6;
    for (const fromB of [false, true]) {
      // Магистраль 2+2 → 3+3: открыты внутренние прежние (|x| ≤ 7) — бригады на внешних, не ближе машины друг к другу.
      const c = strip(twoWay(3, 3), { project: 1, done: 50, ...(fromB ? { fromB: true } : {}), was: was(twoWay(2, 2)) });
      for (const n of [1, 2, 3]) {
        const rows = crewRows(c, n);
        expect(rows).toHaveLength(n);
        for (const r of rows) {
          expect(Math.abs(r) - MH).toBeGreaterThanOrEqual(LANE_W - 1e-6);
          expect(Math.abs(r) + MH).toBeLessThanOrEqual(3 * LANE_W + ROAD_MARGIN + 1e-6);
        }
        for (let i = 1; i < n; i++) expect(rows[i] - rows[i - 1]).toBeGreaterThanOrEqual(2 * MH - 1e-6);
      }
      // Одна бригада — справа по ходу заполнения (раньше — по оси, прямо по открытым полосам).
      expect(crewRows(c, 1)[0]).toBeGreaterThan(LANE_W);
      // ⛔ целиком — как раньше: одна по оси.
      expect(crewRows(strip(twoWay(3, 3), { project: 1, done: 50, was: { ...was(twoWay(2, 2)), part: undefined } }), 1)).toEqual([0]);
    }
    // Пристройка полосы справа к 1+1: прежние полосы открыты все — ряд на месте новой.
    const edge = strip([...twoWay(1, 1), slot(10.5, 1)], { project: 1, done: 50, was: was(twoWay(1, 1), { edge: true }) });
    const [row] = crewRows(edge, 1);
    expect(row - MH).toBeGreaterThanOrEqual(LANE_W - 1e-6);
    expect(row + MH).toBeLessThanOrEqual(2 * LANE_W + ROAD_MARGIN + 1e-6);
  });
});

describe('Расширение дороги: прежний асфальт остаётся', () => {
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });

  /**
   * Готовая дорога профиля from вдоль x длиной 400 м с кусками за концами, перестроенная в to «Со строительством»;
   * part — «◐ с проездом», иначе «⛔ целиком»; работы начаты (этапы stages от a).
   */
  function widened(to: RoadOptions, from: RoadOptions = HIGHWAY, part = true, stages: [number, number, number] = [260, 180, 100]): { game: Game; c: Corridor; y: number } {
    const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' }));
    for (let y = 400; y < game.terrain.height - 400; y += 120) {
      for (let x = 400; x < game.terrain.width - 900; x += 160) {
        if (!clearStrip(game, { x: x - 140, y }, { x: x + 540, y }, 200)) continue;
        const pts = [x - 120, x, x + 400, x + 520];
        const ok = pts.slice(1).every((px, i) => {
          const a = [...game.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - pts[i], n.pos.y - y) < 1);
          return road(game, a ? a.id : { free: { x: pts[i], y } }, { free: { x: px, y } }, from);
        });
        if (!ok) continue;
        const c = [...game.roads.net.corridors.values()].find((k) => Math.abs(k.lut.pointAt(k.length / 2).x - (x + 200)) < 2 && Math.abs(k.lut.pointAt(k.length / 2).y - y) < 2)!;
        const plan = game.roadBuilder.rebuild(c.id, { cls: to.cls, lanes: to.lanes });
        expect(plan.ok).toBe(true);
        expect(game.roadBuilder.apply(plan)).toBe(true);
        const k = game.roads.net.corridor(c.id);
        expect(k.build?.was).toBeTruthy();
        if (!part) delete k.build!.was!.part;
        k.build = { ...k.build!, stages, done: stages[0] / 2 };
        game.roads.net.touch(k);
        return { game, c: k, y };
      }
    }
    throw new Error('нет места');
  }

  it('тот же класс на месте — расширение (асфальт остаётся); другой класс и перенос — переукладка целиком', () => {
    const { c } = widened({ cls: 'highway', lanes: twoWay(2, 2) });
    expect(keepsPavement(c)).toBe(true);
    expect(keepsPavement(widened(AVENUE, STREET).c)).toBe(false);
    // Не перестройка (новая дорога) и перенос — не расширение.
    expect(keepsPavement({ ...c, build: { ...c.build!, was: undefined } })).toBe(false);
    expect(keepsPavement({ ...c, build: { ...c.build!, was: { ...c.build!.was!, moved: true } } })).toBe(false);
  });

  it('шоссе 1+1 → магистраль 2+2: отсыпка — от прежней кромки (7 м от оси) наружу, по прежнему полотну — нет', () => {
    const { game, c, y } = widened({ cls: 'highway', lanes: twoWay(2, 2) });
    const old = wasCorridor(c, c.build!.was!);
    const pad = ROAD_MARGIN + 1.2;
    const off = (p: Vec) => p.y - y;
    // Посередине (у концов новые полосы сходят отгоном к шоссе 1+1 за стыками).
    const bands = wideningBands(c, old, 150, 250, pad);
    expect(bands).toHaveLength(2);
    // С обеих сторон: внутренняя граница — прежняя кромка (7 от оси), внешняя — новая кромка с обочиной (14 + pad).
    for (const b of bands) {
      const inner = b === bands[0] ? b.right : b.left;
      const outer = b === bands[0] ? b.left : b.right;
      for (const p of inner) expect(Math.abs(off(p))).toBeCloseTo(7, 6);
      for (const p of outer) expect(Math.abs(off(p))).toBeCloseTo(14 + pad, 6);
    }
    // «С проездом» — только своя половина.
    const half = wideningBands(c, old, 50, 350, pad, 1);
    expect(half).toHaveLength(1);
    const sign = Math.sign(off(half[0].right[0]));
    for (const p of [...half[0].left, ...half[0].right]) expect(Math.sign(off(p))).toBe(sign);
    // Узкая «◐»: на карте прежняя дорога целиком (обе полосы) — её не размеченное рисуется поверх стройки.
    expect(closureOf(c.build)).toBe('part');
    expect(openNet(game.roads.net, true).corridors.get(c.id)?.lanes).toHaveLength(2);
  });

  it('«Полоса» — прибавка только там, где новая полоса: в стороне от неё у прежней кромки отсыпки нет', () => {
    const lanes = [...twoWay(1, 1), slot(LANE_W * 1.5, 1, 150, 300)];
    const { c, y } = widened({ cls: 'highway', lanes });
    const old = wasCorridor(c, c.build!.was!);
    const pad = ROAD_MARGIN + 1.2;
    const [lo, hi] = wideningBands(c, old, 0, c.length, pad);
    // Слева прибавки нет нигде — полоса нулевой ширины.
    lo.left.forEach((p, i) => expect(Math.hypot(p.x - lo.right[i].x, p.y - lo.right[i].y)).toBeLessThan(1e-6));
    // Справа: до отгона новой полосы — ноль, на ней — от прежней кромки до новой с обочиной.
    const width = (s: number) => {
      const x = c.lut.pointAt(s).x;
      const i = hi.left.reduce((best, p, k) => (Math.abs(p.x - x) < Math.abs(hi.left[best].x - x) ? k : best), 0);
      return Math.abs(hi.right[i].y - y) - Math.abs(hi.left[i].y - y);
    };
    expect(width(20)).toBeCloseTo(0, 6);
    expect(width(225)).toBeCloseTo(LANE_W + pad, 1);
  });

  it('«⛔ целиком»: расширение на карте — прежней дорогой (асфальт на месте), переукладка — нет; движению — перекрыто', () => {
    const wide = widened({ cls: 'highway', lanes: twoWay(2, 2) }, HIGHWAY, false);
    expect(closureOf(wide.c.build)).toBe('closed');
    expect(openNet(wide.game.roads.net, true).corridors.get(wide.c.id)?.lanes).toHaveLength(2);
    expect(openNet(wide.game.roads.net).corridors.get(wide.c.id)).toBeUndefined();
    const relay = widened(AVENUE, STREET, false);
    expect(closureOf(relay.c.build)).toBe('closed');
    expect(openNet(relay.game.roads.net, true).corridors.get(relay.c.id)).toBeUndefined();
  });
});
