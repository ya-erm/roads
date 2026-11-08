import { describe, expect, it } from 'vitest';
import { RAIL_STATION } from '../config';
import { add, dist, Vec } from '../core/vec';
import type { Station } from '../world/entities';
import { RAIL_SPEC } from '../world/roadTypes';
import { Game, railStationFee } from './game';
import { stationShape } from './railStationEdit';
import { road, runSeconds, withoutCitizens } from './testkit';

const SERVES = { pax: true, cargo: true };
const world = () => withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 9_000_000, water: 'dry' }));

/** Прямой путь длиной len (оба конца — тупики) в свободном месте (и с запасом поперёк); at(s, side) — точка вдоль него и сбоку. */
function layTrack(game: Game, len: number): { at: (s: number, side?: number) => Vec } {
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      const from = { x, y };
      const at = (s: number, side = 0) => add(from, { x: s, y: side });
      const req = { start: { kind: 'free' as const, pos: from, level: 0 }, end: { kind: 'free' as const, pos: at(len), level: 0 }, spec: RAIL_SPEC, mode: 'straight' as const };
      if (!game.builder.plan(req).ok) continue;
      game.builder.build(req);
      const mid = game.stationPlan(at(len / 2, 40), 14, 'rail', 0, 4, 400);
      const end = game.stationPlan(at(len - 200, 60), 14, 'rail', 0, 4, 400, true);
      if (mid.ok && end.ok) return { at };
      game.builder.bulldoze(at(len / 2), 4);
    }
  }
  throw new Error('Нет места для пути');
}

const railCount = (game: Game) => ({ segs: game.net.segments.size, nodes: game.net.nodes.size });
const lengths = (game: Game, st: Station) => st.platforms.map((id) => game.net.segment(id).length);

describe('Удлинение платформ ж/д станции', { timeout: 60_000 }, () => {
  it('проходная 150 → 200 → … → 400 м: все пути длиннее поровну в обе стороны, стрелки отъехали, участки те же', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const st = game.placeStation(at(1200, 40), 14, 'rail', SERVES, 0, 3)!;
    expect(st.platforms).toHaveLength(3);
    const shape0 = stationShape(game.net, st)!;
    const sw0 = shape0.switches.map((id) => ({ ...game.net.node(id!).pos }));
    const throat0 = dist(game.net.node(shape0.ends[0]).pos, sw0[0]);
    const fp0 = { ...st.fp, center: { ...st.fp.center } };
    const before = railCount(game);
    const platforms = [...st.platforms];
    const plan = game.railExtendPlan(st.id);
    expect(plan.reason ?? 'ok').toBe('ok');
    expect(plan.length).toBe(150);
    expect(plan.next).toBe(200);
    // Цена — новые метры путей и прибавка к цене вокзала за длину.
    expect(plan.cost).toBeGreaterThan(railStationFee(3, 200) - railStationFee(3, 150));
    const money = game.money;
    expect(game.extendRailPlatforms(st.id)).toBeNull();
    expect(game.money).toBe(money - plan.cost);
    for (const L of lengths(game, st)) expect(L).toBeCloseTo(200, 0);
    // Узлы и участки — те же: поезда и маршруты на них остаются.
    expect(st.platforms).toEqual(platforms);
    expect(railCount(game)).toEqual(before);
    // Стрелки горловин — на 25 м дальше каждая, по главному пути; здание — посередине, как было.
    const shape = stationShape(game.net, st)!;
    expect(shape.switches).toEqual(shape0.switches);
    shape.switches.forEach((id, k) => {
      const p = game.net.node(id!).pos;
      expect(dist(p, sw0[k])).toBeCloseTo(25, 3);
      expect(Math.abs(p.y - sw0[k].y)).toBeLessThan(0.01);
    });
    expect(dist(st.fp.center, fp0.center)).toBeLessThan(0.01);
    // Съезды не изменились — такие же пологие.
    const main = game.net.segment(st.platforms[0]);
    expect(dist(game.net.node(shape.ends[0]).pos, game.net.node(shape.switches[0]!).pos)).toBeCloseTo(throat0, 3);
    expect(main.length).toBeCloseTo(200, 0);
    // И дальше — до предела.
    for (const L of [250, 300, 350, 400]) {
      expect(game.extendRailPlatforms(st.id)).toBeNull();
      for (const x of lengths(game, st)) expect(x).toBeCloseTo(L, 0);
    }
    const max = game.railExtendPlan(st.id);
    expect(max.ok).toBe(false);
    expect(max.reason).toMatch(/400 м/);
    expect(game.extendRailPlatforms(st.id)).toBe(max.reason);
    // Здание у длинной платформы — во всю длину, как у станции, построенной сразу длинной.
    expect(st.fp.w).toBe(RAIL_STATION.size.w);
  });

  it('станция с достроенным путём (своя стрелка дальше по главному): удлиняется, съезды на месте; Ctrl+Z — как было', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const st = game.placeStation(at(1200, 40), 14, 'rail', SERVES, 0, 2)!;
    expect(game.addRailTrack(st.id)).toBeNull();
    expect(game.addRailTrack(st.id, -1)).toBeNull();
    expect(st.platforms).toHaveLength(4);
    const before = railCount(game);
    const save = JSON.stringify(game.net.serialize());
    const fp = structuredClone(st.fp);
    const money = game.money;
    // Съезды — участки от стрелок к концам платформ.
    const ramps = () =>
      [...game.net.segments.values()]
        .filter((s) => s.platform === undefined && [s.a, s.b].some((n) => game.net.node(n).buildingId === st.id))
        .map((s) => [s.id, Math.round(s.length * 100) / 100]);
    const ramps0 = ramps();
    expect(game.extendRailPlatforms(st.id)).toBeNull();
    for (const L of lengths(game, st)) expect(L).toBeCloseTo(200, 0);
    expect(railCount(game)).toEqual(before);
    // Каждый съезд — той же формы: отъехал вместе со стрелкой.
    expect(ramps()).toEqual(ramps0);
    expect(game.undo()).toBe('длина платформ');
    expect(JSON.stringify(game.net.serialize())).toBe(save);
    expect(st.fp).toEqual(fp);
    expect(game.money).toBe(money);
    for (const L of lengths(game, st)) expect(L).toBeCloseTo(150, 0);
  });

  it('конечная: длиннее в сторону горловины — упоры и здание на месте', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const st = game.placeStation(at(2400 - 150, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    expect(st.terminal).toBe(true);
    const shape0 = stationShape(game.net, st)!;
    const buffer0 = { ...game.net.node(shape0.ends[1]).pos };
    const throat0 = { ...game.net.node(shape0.switches[0]!).pos };
    const fp0 = structuredClone(st.fp);
    expect(game.extendRailPlatforms(st.id)).toBeNull();
    for (const L of lengths(game, st)) expect(L).toBeCloseTo(200, 0);
    expect(game.net.node(shape0.ends[1]).pos).toEqual(buffer0);
    expect(dist(game.net.node(shape0.switches[0]!).pos, throat0)).toBeCloseTo(50, 3);
    expect(st.fp).toEqual(fp0);
  });

  it('конечная: горловине мешает дорога — длиннее от упоров, здание отъезжает; переезд не тронут', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    // Дорога поперёк пути чуть дальше горловины будущей конечной: стрелку туда не отодвинуть.
    const throat = 2400 - 150 - RAIL_STATION.switchLen;
    expect(road(game, { free: at(throat - 30, -200) }, { free: at(throat - 30, 200) })).toBe(true);
    expect(game.levelCrossings.length).toBeGreaterThan(0);
    // Конечная — у тупика пути; за упорами — свободное поле.
    const st = game.placeStation(at(2400 - 150, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    expect(st).toBeTruthy();
    const shape0 = stationShape(game.net, st)!;
    const throat0 = { ...game.net.node(shape0.switches[0]!).pos };
    const buffer0 = { ...game.net.node(shape0.ends[1]).pos };
    const fp0 = structuredClone(st.fp);
    const plan = game.railExtendPlan(st.id);
    expect(plan.reason ?? 'ok').toBe('ok');
    expect(game.extendRailPlatforms(st.id)).toBeNull();
    for (const L of lengths(game, st)) expect(L).toBeCloseTo(200, 0);
    expect(game.net.node(shape0.switches[0]!).pos).toEqual(throat0);
    expect(dist(game.net.node(shape0.ends[1]).pos, buffer0)).toBeCloseTo(50, 3);
    expect(dist(st.fp.center, fp0.center)).toBeCloseTo(50, 3);
    expect(game.levelCrossings.length).toBeGreaterThan(0);
  });

  it('проходная: у одной горловины дорога — весь шаг в другую сторону, здание — посередине новых платформ', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const half = 75 + RAIL_STATION.switchLen;
    expect(road(game, { free: at(1200 - half - 30, -200) }, { free: at(1200 - half - 30, 200) })).toBe(true);
    const st = game.placeStation(at(1200, 40), 14, 'rail', SERVES, 0, 2)!;
    expect(st).toBeTruthy();
    const shape0 = stationShape(game.net, st)!;
    const sw0 = shape0.switches.map((id) => ({ ...game.net.node(id!).pos }));
    const x0 = st.fp.center.x;
    expect(game.extendRailPlatforms(st.id)).toBeNull();
    for (const L of lengths(game, st)) expect(L).toBeCloseTo(200, 0);
    const moved = shape0.switches.map((id, k) => dist(game.net.node(id!).pos, sw0[k]));
    // Стрелка у дороги — на месте, другая — на весь шаг дальше.
    expect(moved.sort((a, b) => a - b)[0]).toBeLessThan(0.01);
    expect(moved[1]).toBeCloseTo(50, 3);
    expect(Math.abs(st.fp.center.x - x0)).toBeCloseTo(25, 3);
  });

  it('мешает: дорога у обеих горловин — причина, сеть и деньги не меняются', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const half = 75 + RAIL_STATION.switchLen;
    for (const x of [1200 - half - 30, 1200 + half + 30]) expect(road(game, { free: at(x, -200) }, { free: at(x, 200) })).toBe(true);
    const st = game.placeStation(at(1200, 40), 14, 'rail', SERVES, 0, 2)!;
    expect(st).toBeTruthy();
    const v = game.net.version;
    const money = game.money;
    const plan = game.railExtendPlan(st.id);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('Мешает дорога');
    expect(game.extendRailPlatforms(st.id)).toBe('Мешает дорога');
    expect(game.net.version).toBe(v);
    expect(game.money).toBe(money);
    for (const L of lengths(game, st)) expect(L).toBeCloseTo(150, 0);
  });

  it('проходная в чистом поле: главный путь за горловиной короткий — тупик продлевается', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    // Поодаль от пути — вокзал со своим главным путём в чистом поле (короткие хвосты за стрелками).
    const st = game.placeStation(at(1200, 300), 14, 'rail', SERVES, 0, 2)!;
    expect(st).toBeTruthy();
    const before = railCount(game);
    expect(game.extendRailPlatforms(st.id)).toBeNull();
    for (const L of lengths(game, st)) expect(L).toBeCloseTo(200, 0);
    expect(railCount(game)).toEqual(before);
    // Хвосты за стрелками — не короче, чем были у станции такой длины.
    const shape = stationShape(game.net, st)!;
    for (const sw of shape.switches) {
      const tail = game.net
        .node(sw!)
        .segments.map((id) => game.net.segment(id))
        .find((s) => s.platform === undefined && ![s.a, s.b].some((n) => game.net.node(n).buildingId === st.id))!;
      expect(tail.length).toBeGreaterThan(20);
    }
  });

  it('поезд ходит после удлинения, состав можно сделать длиннее; сохранение открывается с той же длиной', () => {
    const game = world();
    const { at } = layTrack(game, 2400);
    const a = game.placeStation(at(500, 40), 14, 'rail', SERVES, 0, 2, 100)!;
    const b = game.placeStation(at(1700, 40), 14, 'rail', SERVES, 0, 2, 100)!;
    const line = game.createLine([a.id, b.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    const v = game.buyVehicle(line.id, 'passengerTrain')!;
    expect(v).not.toBeNull();
    const cars0 = game.maxCars(v);
    runSeconds(game, 60);
    expect(game.extendRailPlatforms(a.id)).toBeNull();
    expect(game.extendRailPlatforms(b.id)).toBeNull();
    expect(game.maxCars(v)).toBeGreaterThan(cars0);
    expect(game.rail.trains.size).toBe(1);
    const visited = new Set<number>();
    runSeconds(game, 400, () => {
      for (const t of game.rail.trains.values()) if (!t.moving && t.platform !== null) visited.add(t.platform);
    });
    expect(a.platforms.some((p) => visited.has(p))).toBe(true);
    expect(b.platforms.some((p) => visited.has(p))).toBe(true);
    expect(game.rail.trains.size).toBe(1);
    expect(game.journal.entries.some((e) => e.k === 'station=')).toBe(true);
    const back = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    const again = back.stations.get(a.id)!;
    expect(again.platforms).toEqual(a.platforms);
    for (const id of again.platforms) expect(back.net.segment(id).length).toBeCloseTo(150, 0);
    expect(back.railExtendPlan(a.id).next).toBe(200);
  });

  it('у автостанции и несуществующей — нельзя', () => {
    const game = world();
    expect(game.railExtendPlan(-1).ok).toBe(false);
    const road = [...game.stations.values()].find((s) => s.kind !== 'rail');
    if (road) expect(game.railExtendPlan(road.id).ok).toBe(false);
  });
});
