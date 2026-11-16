import { describe, expect, it } from 'vitest';
import { STOP } from '../config';
import { dist, dot, sub, type Vec } from '../core/vec';
import { buildPairScene } from '../testpages/bus';
import type { Station } from '../world/entities';
import { residentsOf } from '../world/townForms';
import { Game } from './game';
import { curbHeading, headingArrow, mergeStops, nearerHalf, rideAhead } from './stopPairs';
import { runSeconds, withoutCitizens } from './testkit';

/** От оси улицы до точки, у которой ставим остановку (как в сцене /test/bus). */
const AT = 18;
const Y = 1500;
const south = (x: number): Vec => ({ x, y: Y + AT });
const north = (x: number): Vec => ({ x, y: Y - AT });

/** Узел остановки на оси улицы. */
const nodeOf = (game: Game, st: Station) => game.roads.net.node(st.nodeId);

/** Жители домов в охвате остановки вокруг хотя бы одной из точек — каждый дом по разу. */
function popWithin(game: Game, centers: Vec[]): number {
  let pop = 0;
  for (const town of game.towns) {
    for (const b of town.buildings) {
      if (centers.some((c) => dist(b.fp.center, c) <= STOP.catchment)) pop += b.kind === 'res' ? residentsOf(b) : b.floors * 6;
    }
  }
  return pop;
}

describe('Пары остановок: правила', () => {
  it('маршрут после замены половин склеивает соседние одинаковые, и по кругу', () => {
    expect(mergeStops([1, 2, 2, 3])).toEqual({ stops: [1, 2, 3], index: [0, 1, 1, 2] });
    expect(mergeStops([1, 2, 3, 1])).toEqual({ stops: [1, 2, 3], index: [0, 1, 2, 0] });
    expect(mergeStops([4, 4])).toBeNull();
  });

  it('сколько ехать по линии — вперёд по кругу до ближайшей встречи', () => {
    const pos = (id: number) => ({ x: id * 100, y: 0 });
    // 1 → 2 → 3 → 2 → (1): от 3 до 2 — один перегон назад по линии, а не через 1.
    expect(rideAhead([1, 2, 3, 2], pos, 3, 2)).toBe(100);
    expect(rideAhead([1, 2, 3, 2], pos, 2, 1)).toBe(100);
    expect(rideAhead([1, 2, 3], pos, 1, 9)).toBe(Infinity);
  });

  it('дом — у ближней половины, поровну — у меньшего номера; стрелка и ход автобуса по навесу', () => {
    const a = { id: 5, fp: { center: { x: 0, y: 10 } } };
    const b = { id: 3, fp: { center: { x: 0, y: -10 } } };
    expect(nearerHalf({ x: 0, y: 40 }, a, b)).toBe(5);
    expect(nearerHalf({ x: 50, y: 0 }, a, b)).toBe(3);
    // Улица с запада на восток (y вниз): навес у южного края — автобусы на восток, у северного — на запад.
    expect(curbHeading({ x: 0, y: 10 }, { x: 0, y: 0 })).toEqual({ x: 1, y: -0 });
    expect(headingArrow(curbHeading({ x: 0, y: 10 }, { x: 0, y: 0 }))).toBe('→');
    expect(headingArrow(curbHeading({ x: 0, y: -10 }, { x: 0, y: 0 }))).toBe('←');
  });
});

describe('Пары остановок в игре', { timeout: 120_000 }, () => {
  it('напротив встаёт парой: то же название, свои стороны, сдвиг не меньше shift; дальше reach — нельзя', () => {
    const { game, pairs, errors } = buildPairScene();
    expect(errors).toEqual([]);
    const [ws, wn, es, en] = pairs;
    expect(ws.pair).toBe(wn.id);
    expect(wn.pair).toBe(ws.id);
    expect(es.pair).toBe(en.id);
    expect(wn.name).toBe(ws.name);
    expect(en.name).toBe(es.name);
    expect(es.name).not.toBe(ws.name);
    // Курсор ровно напротив — узлы через STOP.pair.shift; на 20 м дальше — так и встала.
    expect(Math.abs(nodeOf(game, wn).pos.x - nodeOf(game, ws).pos.x)).toBeCloseTo(STOP.pair.shift, 0);
    expect(Math.abs(nodeOf(game, en).pos.x - nodeOf(game, es).pos.x)).toBeCloseTo(20, 0);
    // У южной половины автобусы на восток, у северной — на запад; узел — цель только со своей стороны.
    expect(game.stopHeading(ws)!.x).toBeGreaterThan(0.99);
    expect(game.stopHeading(wn)!.x).toBeLessThan(-0.99);
    for (const st of pairs) {
      const node = nodeOf(game, st);
      expect(node.arrive).toBeDefined();
      expect(dot(node.dir, game.stopHeading(st)!) * node.arrive!).toBeGreaterThan(0);
    }
    // Новая остановка посередине — обычная; напротив неё дальше reach вдоль оси — «рядом уже есть», ближе — пара.
    const mid = game.placeStation(south(2450), 14, 'stop')!;
    expect(mid.pair).toBeUndefined();
    expect(nodeOf(game, mid).arrive).toBeUndefined();
    const far = game.stationPlan(north(2450 + STOP.pair.reach + 10), 14, 'stop');
    expect(far.ok).toBe(false);
    expect(far.reason).toBe('Рядом уже есть остановка');
    const near = game.stationPlan(north(2450 + STOP.pair.reach - 4), 14, 'stop');
    expect(near.ok).toBe(true);
    expect(near.pair).toBe(mid.id);
    // На той же стороне — не пара, а «рядом».
    expect(game.stationPlan(south(2450 + 20), 14, 'stop').ok).toBe(false);
    // У половины готовой пары третью напротив не поставить.
    const third = game.stationPlan(north(2250 + 20), 14, 'stop');
    expect(third.ok).toBe(false);
    expect(third.pair).toBeUndefined();
  });

  it('жители пары — по разу: каждый дом у ближней половины, вместе — как охват обеих без повторов', () => {
    const { game, pairs } = buildPairScene();
    const [ws, wn] = pairs;
    const union = popWithin(game, [ws.fp.center, wn.fp.center]);
    const alone = popWithin(game, [ws.fp.center]);
    expect(ws.catchPop).toBeGreaterThan(0);
    expect(wn.catchPop).toBeGreaterThan(0);
    // Без потерь за переходы (на прямой улице без перекрёстков их нет) — ровно охват обеих без двойного счёта.
    expect(ws.catchPop + wn.catchPop).toBe(union);
    expect(game.paxPop(ws)).toBe(union);
    expect(game.paxPop(wn)).toBe(union);
    // Без пары у каждой было бы почти столько же — вдвое больше на двоих.
    expect(union).toBeLessThan(1.5 * alone);
  });

  it('маршрут через пары: автобус встаёт у половины по ходу, пассажиры ждут там, откуда едут в свою сторону', () => {
    const { game, pairs, lines } = buildPairScene();
    withoutCitizens(game);
    const [ws, wn, es, en] = pairs;
    const line = game.lines.get(lines.pair)!;
    // Клики «запад, восток, восток, запад» по южным навесам — маршрут по половинам по ходу: на восток у южных, назад у северных.
    expect(line.stops).toEqual([ws.id, es.id, en.id, wn.id]);
    const stoppedAt = new Map<number, { x: number; n: number }>();
    let wrongWait = 0;
    let rightWait = 0;
    runSeconds(game, 240, () => {
      for (const v of game.fleet.values()) {
        const sim = game.fleetSim(v);
        if (v.state !== 'loading' || !sim) continue;
        const st = game.stations.get(line.stops[v.stop])!;
        const s = stoppedAt.get(st.id) ?? { x: 0, n: 0 };
        s.x += sim.dir.x;
        s.n++;
        stoppedAt.set(st.id, s);
      }
      // На западной конечной ждут только у южной половины (оттуда — на восток), на восточной — у северной.
      for (const st of [wn, es]) for (const n of st.passengers.values()) wrongWait += n;
      for (const st of [ws, en]) for (const n of st.passengers.values()) rightWait += n;
    });
    expect(rightWait).toBeGreaterThan(0);
    for (const st of pairs) expect(stoppedAt.get(st.id)?.n ?? 0, st.name).toBeGreaterThan(0);
    // Стоят по ходу своей половины: у южных — носом на восток, у северных — на запад.
    for (const st of [ws, es]) expect(stoppedAt.get(st.id)!.x / stoppedAt.get(st.id)!.n).toBeGreaterThan(0.9);
    for (const st of [wn, en]) expect(stoppedAt.get(st.id)!.x / stoppedAt.get(st.id)!.n).toBeLessThan(-0.9);
    expect(wrongWait).toBe(0);
    expect(line.revenueTotal).toBeGreaterThan(0);
    expect(line.problem).toBeNull();
  });

  it('пара посередине линии: кто едет на восток, ждёт у южной половины, на запад — у северной', () => {
    const { game, pairs } = buildPairScene();
    withoutCitizens(game);
    const [ws, wn, es, en] = pairs;
    const ms = game.placeStation(south(2450), 14, 'stop')!;
    const mn = game.placeStation(north(2450), 14, 'stop')!;
    expect(mn.pair).toBe(ms.id);
    // Клики по одному навесу пары посередине дважды — туда и обратно автобус встаёт у разных; на конечных — у той
    // половины, к которой подъезжает (до разворота в тупике).
    const line = game.createLine([ws.id, ms.id, es.id, ms.id])!;
    expect(line.stops).toEqual([wn.id, ms.id, es.id, mn.id]);
    game.buyVehicle(line.id, 'bus');
    game.buyVehicle(line.id, 'bus');
    const east = new Set([es.id, en.id]);
    const west = new Set([ws.id, wn.id]);
    let wrong = 0;
    const seen = { ms: 0, mn: 0 };
    runSeconds(game, 240, () => {
      for (const [to, n] of ms.passengers) if (n > 0) east.has(to) ? (seen.ms += n) : (wrong += n);
      for (const [to, n] of mn.passengers) if (n > 0) west.has(to) ? (seen.mn += n) : (wrong += n);
    });
    expect(wrong).toBe(0);
    expect(seen.ms).toBeGreaterThan(0);
    expect(seen.mn).toBeGreaterThan(0);
    // Тариф внутри пары не нужен: с одной половины на другую никто не едет.
    expect(game.paxRoutes(ms).has(mn.id)).toBe(false);
  });

  it('снос половины: вторая остаётся обычной остановкой, маршрут встаёт у неё, автобусы ездят дальше', () => {
    const { game, pairs, lines } = buildPairScene();
    withoutCitizens(game);
    const [ws, wn, es, en] = pairs;
    const line = game.lines.get(lines.pair)!;
    runSeconds(game, 30);
    expect(game.removeStation(en)).toBe(true);
    expect(game.stations.has(en.id)).toBe(false);
    expect(es.pair).toBeUndefined();
    expect(nodeOf(game, es).arrive).toBeUndefined();
    expect(game.pairOf(es)).toBeUndefined();
    // Восточная половина «назад» ушла — маршрут разворачивается у оставшейся.
    expect(line.stops).toEqual([ws.id, es.id, wn.id]);
    expect(ws.pair).toBe(wn.id);
    // Её жители — снова все свои: весь охват вокруг неё, без деления с той стороной.
    expect(es.catchPop).toBe(popWithin(game, [es.fp.center]));
    for (const v of game.fleet.values()) for (const g of v.passengers) expect(g.to).not.toBe(en.id);
    const before = line.revenueTotal;
    const visited = new Set<number>();
    runSeconds(game, 180, () => {
      for (const v of game.fleet.values()) if (v.state === 'loading') visited.add(line.stops[v.stop]);
    });
    expect([...visited].sort()).toEqual([...line.stops].sort());
    expect(line.revenueTotal).toBeGreaterThan(before);
    expect(line.problem).toBeNull();
  });

  it('перенос дальше reach рвёт пару (у перенесённой — своё название), назад напротив — снова пара', () => {
    const { game, pairs } = buildPairScene();
    const [, , es, en] = pairs;
    const name = es.name;
    expect(game.moveStation(en.id, north(2800), 14)).toBeNull();
    expect(en.pair).toBeUndefined();
    expect(es.pair).toBeUndefined();
    expect(nodeOf(game, es).arrive).toBeUndefined();
    expect(nodeOf(game, en).arrive).toBeUndefined();
    expect(en.name).not.toBe(name);
    expect(es.name).toBe(name);
    expect(game.moveStation(en.id, north(2640), 14)).toBeNull();
    expect(en.pair).toBe(es.id);
    expect(en.name).toBe(name);
    expect(dot(sub(en.fp.center, es.fp.center), { x: 0, y: 1 })).toBeLessThan(0);
  });

  it('сохранение: пара, стороны узлов и очереди те же, дальше партия идёт одинаково', () => {
    const { game, pairs } = buildPairScene();
    withoutCitizens(game);
    runSeconds(game, 40);
    const json = JSON.stringify(game.toSave());
    const a = withoutCitizens(new Game(game.settings, JSON.parse(json)));
    const b = withoutCitizens(new Game(game.settings, JSON.parse(json)));
    for (const st of pairs) {
      const got = a.stations.get(st.id)!;
      expect(got.pair).toBe(st.pair);
      expect(got.name).toBe(st.name);
      expect(got.catchPop).toBe(st.catchPop);
      expect(a.roads.net.node(got.nodeId).arrive).toBe(nodeOf(game, st).arrive);
      expect([...got.passengers]).toEqual([...st.passengers]);
    }
    runSeconds(a, 30);
    runSeconds(b, 30);
    const queues = (g: Game) => pairs.map((st) => [...g.stations.get(st.id)!.passengers]);
    expect(queues(a)).toEqual(queues(b));
    // Сохранение без пар (старое) — остановки обычные.
    const old = JSON.parse(json);
    for (const s of old.stations) delete s.pair;
    const plain = new Game(game.settings, old);
    for (const st of pairs) expect(plain.pairOf(plain.stations.get(st.id))).toBeUndefined();
  });
});
