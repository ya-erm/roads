import { describe, expect, it } from 'vitest';
import { COST, RAIL_STATION } from '../config';
import { bezPoint, splitBezier, straightCubic } from '../core/bezier';
import { add, dist, Vec } from '../core/vec';
import type { Station } from '../world/entities';
import { RAIL_SPEC } from '../world/roadTypes';
import { Game, railStationFee } from './game';
import { joinCubics, stationShape, switchLenFor } from './railStationEdit';
import { runSeconds, withoutCitizens } from './testkit';

const SERVES = { pax: true, cargo: true };
const world = () => withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 9_000_000, water: 'dry' }));

/** Прямой путь длиной len (оба конца — тупики) в свободном месте; at(s, side) — точка вдоль него и сбоку. */
function layTrack(game: Game, len: number): { at: (s: number, side?: number) => Vec } {
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      const from = { x, y };
      const at = (s: number, side = 0) => add(from, { x: s, y: side });
      const req = { start: { kind: 'free' as const, pos: from, level: 0 }, end: { kind: 'free' as const, pos: at(len), level: 0 }, spec: RAIL_SPEC, mode: 'straight' as const };
      if (!game.builder.plan(req).ok) continue;
      game.builder.build(req);
      const mid = game.stationPlan(at(len / 2, 40), 14, 'rail', 0, 4, 150);
      const end = game.stationPlan(at(len - 200, 60), 14, 'rail', 0, 4, 150, true);
      if (mid.ok && end.ok) return { at };
      game.builder.bulldoze(at(len / 2), 4);
    }
  }
  throw new Error('Нет места для пути');
}

/** Рельсовые участки и узлы сети — для сравнения «как было». */
const railCount = (game: Game) => ({ segs: game.net.segments.size, nodes: game.net.nodes.size });

/** Расстояние от точки до оси главного пути станции (её главной платформы). */
const offMain = (game: Game, st: Station, p: Vec) => game.net.segment(st.platforms[0]).lut.closest(p).d;

describe('Склейка половин пути', () => {
  it('разрезанная кривая склеивается обратно точно', () => {
    const c = { p0: { x: 0, y: 0 }, p1: { x: 40, y: 30 }, p2: { x: 90, y: -20 }, p3: { x: 140, y: 10 } };
    const [a, b] = splitBezier(c, 0.37);
    const j = joinCubics(a, b)!;
    for (const t of [0, 0.25, 0.5, 0.8, 1]) expect(dist(bezPoint(j, t), bezPoint(c, t))).toBeLessThan(1e-6);
  });

  it('две прямые на одной линии — одна прямая; излом не склеивается', () => {
    const j = joinCubics(straightCubic({ x: 0, y: 0 }, { x: 50, y: 0 }), straightCubic({ x: 50, y: 0 }, { x: 200, y: 0 }))!;
    expect(j.p0).toEqual({ x: 0, y: 0 });
    expect(j.p3).toEqual({ x: 200, y: 0 });
    expect(joinCubics(straightCubic({ x: 0, y: 0 }, { x: 50, y: 0 }), straightCubic({ x: 50, y: 0 }, { x: 100, y: 40 }))).toBeNull();
  });
});

describe('Достроить путь ж/д станции', { timeout: 40_000 }, () => {
  it('проходная на 2 пути → 3: платформа за крайней, здание отодвинулось, стрелка — пологая, как у станции на 3 пути', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const st = game.placeStation(at(1200, 40), 14, 'rail', SERVES, 0, 2)!;
    expect(st.platforms).toHaveLength(2);
    const fp0 = { ...st.fp.center };
    const plan = game.railTrackPlan(st.id);
    expect(plan.ok).toBe(true);
    // Цена — путь и прибавка за платформу.
    expect(plan.cost).toBeGreaterThan(railStationFee(3) - railStationFee(2));
    const money = game.money;
    expect(game.addRailTrack(st.id)).toBeNull();
    expect(game.money).toBe(money - plan.cost);
    expect(st.platforms).toHaveLength(3);
    expect(st.bays).toBe(3);
    const added = game.net.segment(st.platforms[2]);
    expect(added.platform).toBe(st.id);
    // Новая платформа — на три пути от главного по ту же сторону, что и вторая, длиной как остальные.
    const mid = added.lut.pointAt(added.length / 2);
    expect(offMain(game, st, mid)).toBeCloseTo(RAIL_STATION.spacing * 2, 0);
    expect(Math.abs(added.length - game.net.segment(st.platforms[0]).length)).toBeLessThan(1);
    const second = game.net.segment(st.platforms[1]);
    expect(dist(mid, second.lut.pointAt(second.length / 2))).toBeCloseTo(RAIL_STATION.spacing, 0);
    // Здание — на путь дальше, за новым путём.
    expect(dist(st.fp.center, fp0)).toBeCloseTo(RAIL_STATION.spacing, 3);
    expect(added.lut.closest(st.fp.center).d).toBeGreaterThan(st.fp.h / 2 + 4);
    // Съезд нового пути — от новой стрелки дальше по главному: такой же длины, как у станции, построенной на 3 пути.
    const shape = stationShape(game.net, st)!;
    const down = game.net.node(added.a).segments.map((id) => game.net.segment(id)).find((s) => s.id !== added.id)!;
    const sw = down.a === added.a ? down.b : down.a;
    expect(sw).not.toBe(shape.switches[0]);
    expect(dist(game.net.node(sw).pos, game.net.node(added.a).pos)).toBeGreaterThan(switchLenFor(3) - 1);
    // Ещё один — четвёртый, дальше нельзя.
    expect(game.addRailTrack(st.id)).toBeNull();
    expect(st.platforms).toHaveLength(4);
    expect(game.railTrackPlan(st.id).ok).toBe(false);
    expect(game.addRailTrack(st.id)).toMatch(/4 путей/);
  });

  it('конечная на 1 путь → 2: второй тупик с упором, здание в торце шире; Ctrl+Z — как было', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const st = game.placeStation(at(2400 - 150, 40), 14, 'rail', SERVES, 0, 1, 150, true)!;
    expect(st.terminal).toBe(true);
    expect(st.platforms).toHaveLength(1);
    const w0 = st.fp.w;
    const before = railCount(game);
    const money = game.money;
    expect(game.addRailTrack(st.id)).toBeNull();
    expect(st.platforms).toHaveLength(2);
    const added = game.net.segment(st.platforms[1]);
    // Тупик нового пути — упор (узел станции, больше путей в нём нет).
    const ends = [added.a, added.b].filter((id) => game.net.node(id).segments.length === 1);
    expect(ends).toHaveLength(1);
    expect(game.net.node(ends[0]).buildingId).toBe(st.id);
    expect(st.fp.w).toBeGreaterThanOrEqual(w0);
    expect(game.undo()).toBe('путь станции');
    expect(st.platforms).toHaveLength(1);
    expect(railCount(game)).toEqual(before);
    expect(game.money).toBe(money);
  });

  it('со стороны здания мешает — путь ложится с другой стороны от путей, здание на месте; Ctrl+Z — как было', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    // Чужой путь вдоль станции со стороны здания: здание, отодвинутое на путь дальше, легло бы на него.
    const wall = { start: { kind: 'free' as const, pos: at(700, 72), level: 0 }, end: { kind: 'free' as const, pos: at(1700, 72), level: 0 }, spec: RAIL_SPEC, mode: 'straight' as const };
    expect(game.builder.plan(wall).ok).toBe(true);
    game.builder.build(wall);
    // Курсор — ближе к главному, чем к чужому пути: станция встаёт на главный, здание — к чужому.
    const st = game.placeStation(at(1200, 25), 14, 'rail', SERVES, 0, 2)!;
    expect(st.platforms).toHaveLength(2);
    expect(offMain(game, st, at(1200))).toBeLessThan(1);
    expect(game.railTrackPlan(st.id, 1).ok).toBe(false);
    const plan = game.railTrackPlan(st.id);
    expect(plan.ok).toBe(true);
    expect(plan.side).toBe(-1);
    const fp0 = { ...st.fp, center: { ...st.fp.center } };
    const before = railCount(game);
    const money = game.money;
    expect(game.addRailTrack(st.id)).toBeNull();
    expect(game.money).toBe(money - plan.cost);
    expect(st.platforms).toHaveLength(3);
    const main = game.net.segment(st.platforms[0]);
    const mainMid = main.lut.pointAt(main.length / 2);
    const second = game.net.segment(st.platforms[1]);
    const added = game.net.segment(st.platforms[2]);
    expect(added.platform).toBe(st.id);
    // Новый путь — на путь от главного, по другую сторону от второго пути и здания (здание — в сторону +y).
    const mid = added.lut.pointAt(added.length / 2);
    expect(offMain(game, st, mid)).toBeCloseTo(RAIL_STATION.spacing, 0);
    expect(mid.y).toBeLessThan(mainMid.y);
    expect(dist(mid, second.lut.pointAt(second.length / 2))).toBeCloseTo(RAIL_STATION.spacing * 2, 0);
    expect(Math.abs(added.length - main.length)).toBeLessThan(1);
    expect(st.fp).toEqual(fp0);
    // Сторона здания у станции — прежняя: следующий путь со стороны здания по-прежнему мешает, с другой — за новым.
    expect(stationShape(game.net, st)!.n.y).toBeGreaterThan(0.99);
    const next = game.railTrackPlan(st.id);
    expect(next.ok).toBe(true);
    expect(next.side).toBe(-1);
    expect(game.addRailTrack(st.id)).toBeNull();
    const fourth = game.net.segment(st.platforms[3]);
    const mid4 = fourth.lut.pointAt(fourth.length / 2);
    expect(offMain(game, st, mid4)).toBeCloseTo(RAIL_STATION.spacing * 2, 0);
    expect(mid4.y).toBeLessThan(mid.y);
    // Съезд на дальний путь — такой же пологий, как у станции, построенной сразу на 3 пути.
    const down = game.net.node(fourth.a).segments.map((id) => game.net.segment(id)).find((s) => s.id !== fourth.id)!;
    const sw = down.a === fourth.a ? down.b : down.a;
    expect(dist(game.net.node(sw).pos, game.net.node(fourth.a).pos)).toBeGreaterThan(switchLenFor(3) - 1);
    expect(st.fp).toEqual(fp0);
    expect(game.undo()).toBe('путь станции');
    expect(game.undo()).toBe('путь станции');
    expect(st.platforms).toHaveLength(2);
    expect(railCount(game)).toEqual(before);
    expect(game.money).toBe(money);
  });

  it('конечная: путь с другой стороны — здание в торце шире, поперёк всех путей; сохранение открывается', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const st = game.placeStation(at(2400 - 150, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const side1 = game.net.segment(st.platforms[1]);
    const y1 = side1.lut.pointAt(side1.length / 2).y;
    const w0 = st.fp.w;
    const plan = game.railTrackPlan(st.id, -1);
    expect(plan.ok).toBe(true);
    expect(game.addRailTrack(st.id, -1)).toBeNull();
    expect(st.platforms).toHaveLength(3);
    const added = game.net.segment(st.platforms[2]);
    const mid = added.lut.pointAt(added.length / 2);
    expect(offMain(game, st, mid)).toBeCloseTo(RAIL_STATION.spacing, 0);
    // По другую сторону от главного, чем второй путь.
    const y0 = game.net.segment(st.platforms[0]).lut.pointAt(10).y;
    expect(Math.sign(mid.y - y0)).toBe(-Math.sign(y1 - y0));
    // Тупик нового пути — упор, здание в торце шире на путь и накрывает все три пути.
    expect([added.a, added.b].filter((id) => game.net.node(id).segments.length === 1)).toHaveLength(1);
    expect(st.fp.w).toBeCloseTo(w0 + RAIL_STATION.spacing, 3);
    for (const y of [y1, y0, mid.y]) expect(Math.abs(y - st.fp.center.y)).toBeLessThan(st.fp.w / 2 - 4);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const back = new Game(game.settings, save);
    expect(back.stations.get(st.id)!.platforms).toEqual(st.platforms);
  });

  it('у автостанции путей нет', () => {
    const game = world();
    const road = [...game.stations.values()].find((s) => s.kind !== 'rail');
    if (road) expect(game.railTrackPlan(road.id).ok).toBe(false);
    expect(game.railTrackPlan(-1).ok).toBe(false);
  });
});

describe('Перенос ж/д станции', { timeout: 60_000 }, () => {
  it('проходная → конечная на том же пути: старые пути разобраны, главный цельный, маршрут тот же', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const a = game.placeStation(at(500, 40), 14, 'rail', SERVES, 0, 2)!;
    const b = game.placeStation(at(1700, 40), 14, 'rail', SERVES, 0, 2)!;
    const line = game.createLine([a.id, b.id])!;
    const tracks = b.platforms.length;
    // Конечная — у тупика пути: туда, где был путь за проходной.
    const plan = game.stationMovePlan(b.id, at(2400 - 150, 40), 14, { terminal: true });
    expect(plan.ok).toBe(true);
    // Возврат — как при сносе: здание с платформами и боковые пути.
    expect(plan.refund).toBeGreaterThan(Math.round(railStationFee(2) * COST.refundRatio));
    const money = game.money;
    expect(game.moveStation(b.id, at(2400 - 150, 40), 14, { terminal: true })).toBeNull();
    expect(game.money).toBe(money - plan.cost);
    expect(b.terminal).toBe(true);
    expect(b.platforms).toHaveLength(tracks);
    expect(game.stations.get(b.id)).toBe(b);
    expect(line.stops).toEqual([a.id, b.id]);
    for (const id of b.platforms) expect(game.net.segment(id).platform).toBe(b.id);
    // От старой станции ничего: узлов станции нет, кроме новых, и между вокзалами — один цельный участок пути.
    const own = [...game.net.nodes.values()].filter((n) => n.buildingId === b.id);
    for (const n of own) expect(n.pos.x).toBeGreaterThan(at(2400 - 400).x);
    const near = game.net.findSegmentNear(at(1700), 4)!;
    expect(near.seg.platform).toBeUndefined();
    expect(near.seg.length).toBeGreaterThan(800);
  });

  it('конечная → проходная, и обратно отменой: пути и тип — как были', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const st = game.placeStation(at(2400 - 150, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const before = railCount(game);
    const platforms = [...st.platforms];
    const fp = { ...st.fp };
    game.checkpoint('перенос станции');
    expect(game.moveStation(st.id, at(1200, 40), 14, { terminal: false })).toBeNull();
    game.commit();
    expect(st.terminal).toBeUndefined();
    expect(st.platforms).toHaveLength(2);
    // Проходная: у главной платформы оба конца ведут дальше (не тупики).
    const main = game.net.segment(st.platforms[0]);
    for (const id of [main.a, main.b]) expect(game.net.node(id).segments.length).toBeGreaterThan(1);
    expect(game.undo()).toBe('перенос станции');
    expect(st.terminal).toBe(true);
    expect(st.platforms).toEqual(platforms);
    expect(st.fp).toEqual(fp);
    expect(railCount(game)).toEqual(before);
  });

  it('примерка не трогает сеть; нельзя — причина и прежнее место', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const st = game.placeStation(at(1200, 40), 14, 'rail', SERVES, 0, 2)!;
    const v = game.net.version;
    const before = railCount(game);
    const money = game.money;
    // Конечная посреди пути (тупика рядом нет) не встанет.
    const plan = game.stationMovePlan(st.id, at(1200, 40), 14, { terminal: true });
    expect(plan.ok).toBe(false);
    expect(game.moveStation(st.id, at(1200, 40), 14, { terminal: true })).toBe(plan.reason);
    expect(game.net.version).toBe(v);
    expect(railCount(game)).toEqual(before);
    expect(game.money).toBe(money);
    expect(st.terminal).toBeUndefined();
    // На то же место тем же типом — можно (станция «встаёт» на свой же путь).
    expect(game.stationMovePlan(st.id, at(1200, 40), 14).ok).toBe(true);
  });

  it('поезд ходит и после переноса со сменой типа, и после нового пути', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const a = game.placeStation(at(500, 40), 14, 'rail', SERVES, 0, 2)!;
    const b = game.placeStation(at(1700, 40), 14, 'rail', SERVES, 0, 2)!;
    const line = game.createLine([a.id, b.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    expect(game.buyVehicle(line.id, 'passengerTrain')).not.toBeNull();
    runSeconds(game, 60);
    expect(game.moveStation(b.id, at(2400 - 150, 40), 14, { terminal: true })).toBeNull();
    expect(game.addRailTrack(a.id)).toBeNull();
    const visited = new Set<number>();
    runSeconds(game, 400, () => {
      for (const t of game.rail.trains.values()) if (!t.moving && t.platform !== null) visited.add(t.platform);
    });
    expect(b.platforms.some((p) => visited.has(p))).toBe(true);
    expect(a.platforms.some((p) => visited.has(p))).toBe(true);
    expect(game.rail.trains.size).toBe(1);
  });

  it('путь с другой стороны от здания: к его платформе и от неё есть маршрут, поезд ходит, сохранение открывается', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const a = game.placeStation(at(500, 25), 14, 'rail', SERVES, 0, 2)!;
    const b = game.placeStation(at(1700, 25), 14, 'rail', SERVES, 0, 2)!;
    const line = game.createLine([a.id, b.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    expect(game.buyVehicle(line.id, 'passengerTrain')).not.toBeNull();
    runSeconds(game, 30);
    // С другой стороны — явно (со стороны здания здесь тоже есть место).
    expect(game.addRailTrack(b.id, -1)).toBeNull();
    const far = b.platforms[2];
    expect(game.rail.previewRoute(a.platforms, [far])).not.toBeNull();
    expect(game.rail.previewRoute([far], a.platforms)).not.toBeNull();
    let moving = 0;
    runSeconds(game, 300, () => {
      for (const t of game.rail.trains.values()) if (t.moving) moving++;
    });
    expect(moving).toBeGreaterThan(0);
    expect(game.rail.trains.size).toBe(1);
    // Сохранение с таким путём открывается: платформы и их участки — те же.
    const back = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(back.stations.get(b.id)!.platforms).toEqual(b.platforms);
    for (const id of b.platforms) expect(back.net.segment(id).platform).toBe(b.id);
  });

  it('сохранение с достроенным путём и перенесённой станцией открывается', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const st = game.placeStation(at(2400 - 150, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    expect(game.moveStation(st.id, at(1200, 40), 14, { terminal: false })).toBeNull();
    expect(game.addRailTrack(st.id)).toBeNull();
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const back = new Game(game.settings, save);
    const again = back.stations.get(st.id)!;
    expect(again.platforms).toEqual(st.platforms);
    expect(again.terminal).toBeUndefined();
    for (const id of again.platforms) expect(back.net.segment(id).platform).toBe(st.id);
  });
});

