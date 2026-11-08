import { describe, expect, it } from 'vitest';
import { add, dist, scale, Vec } from '../core/vec';
import type { Train } from '../sim/rail';
import type { Station } from '../world/entities';
import { RAIL_SPEC } from '../world/roadTypes';
import { Game } from './game';
import { withoutCitizens } from './testkit';

/** Поезд на стоянке уже стоит локомотивом к выезду — к следующей остановке линии (RailSim.orient). */

function runSeconds(game: Game, seconds: number, each?: () => void) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) {
    game.update(0.1);
    each?.();
  }
}

const SERVES = { pax: true, cargo: true };
const NO_WAIT = { wait: 'none' as const, maxWait: null, load: 'auto' as const, unload: 'auto' as const };

const world = () => withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 9_000_000, water: 'dry' }));

/** Прямой путь вдоль x длиной len (оба конца — тупики) в свободном месте, где у концов встают конечные. */
function layTrack(game: Game, len: number): (s: number, side?: number) => Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      const from = { x, y };
      const at = (s: number, side = 0) => add(add(from, { x: s, y: 0 }), scale({ x: 0, y: 1 }, side));
      const req = { start: { kind: 'free' as const, pos: from, level: 0 }, end: { kind: 'free' as const, pos: at(len), level: 0 }, spec: RAIL_SPEC, mode: 'straight' as const };
      if (!game.builder.plan(req).ok) continue;
      game.builder.build(req);
      const a = game.stationPlan(at(200, 40), 14, 'rail', 0, 2, 150, true);
      const b = game.stationPlan(at(len - 200, 40), 14, 'rail', 0, 2, 150, true);
      if (a.ok && b.ok) return at;
      game.builder.bulldoze(at(len / 2), 4);
    }
  }
  throw new Error('Нет места для пути');
}

/** Куда смотрит локомотив стоящего поезда вдоль пути: +1 — к большим x, −1 — к меньшим. */
function facing(game: Game, train: Train): number {
  const cars = game.rail.cars(train);
  return Math.sign(cars[0].pos.x - cars[cars.length - 1].pos.x);
}

/** Стоянки поезда: на какой станции и куда смотрел локомотив сразу по прибытии и в последний миг перед отправлением. */
function watchStops(game: Game, stations: Station[], seconds: number) {
  const stops: { st: number; arrived: number; left?: number }[] = [];
  let moving = true;
  let standing = 0;
  runSeconds(game, seconds, () => {
    const t = [...game.rail.trains.values()][0];
    if (!t) return;
    if (!t.moving && moving) {
      const st = stations.find((s) => t.platform !== null && s.platforms.includes(t.platform));
      if (st) stops.push({ st: st.id, arrived: facing(game, t) });
    }
    if (t.moving && !moving && stops.length) stops[stops.length - 1].left = standing;
    if (!t.moving) standing = facing(game, t);
    moving = t.moving;
  });
  return stops;
}

describe('Поезд на стоянке — локомотивом к выезду', { timeout: 60_000 }, () => {
  it('конечная: разворачивается сразу по прибытии и так и стоит до отправления', () => {
    const game = world();
    const at = layTrack(game, 2400);
    const t1 = game.placeStation(at(200, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const t2 = game.placeStation(at(2200, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const line = game.createLine([t1.id, t2.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, NO_WAIT);
    expect(game.buyVehicle(line.id, 'freightTrain')).toBeTruthy();
    const stops = watchStops(game, [t1, t2], 600);
    expect(stops.length).toBeGreaterThanOrEqual(4);
    for (const s of stops) {
      // t1 — слева (меньшие x): оттуда поезд уходит вправо, с t2 — влево.
      const out = s.st === t1.id ? 1 : -1;
      expect(s.arrived).toBe(out);
      if (s.left !== undefined) expect(s.left).toBe(out);
    }
    expect(line.problem).toBeNull();
  });

  it('проходная с возвратом: следующая станция позади — локомотив сразу в её сторону', () => {
    const game = world();
    const at = layTrack(game, 2400);
    const t = game.placeStation(at(200, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const s = game.placeStation(at(1800, 40), 14, 'rail', SERVES, 0, 2, 150)!;
    expect(s.terminal).toBeUndefined();
    const line = game.createLine([s.id, t.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, NO_WAIT);
    expect(game.buyVehicle(line.id, 'freightTrain')).toBeTruthy();
    const stops = watchStops(game, [s, t], 600);
    expect(stops.filter((x) => x.st === s.id).length).toBeGreaterThanOrEqual(2);
    expect(stops.filter((x) => x.st === t.id).length).toBeGreaterThanOrEqual(2);
    for (const x of stops) {
      // Проходная — справа: поезд приходит на неё с t слева и туда же уходит обратно.
      const out = x.st === s.id ? -1 : 1;
      expect(x.arrived).toBe(out);
      if (x.left !== undefined) expect(x.left).toBe(out);
    }
    expect(line.problem).toBeNull();
  });

  it('старое сохранение: поезд, стоявший задом к выезду, разворачивается при загрузке и ходит дальше; ход тот же', () => {
    const game = world();
    const at = layTrack(game, 2400);
    const t1 = game.placeStation(at(200, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const t2 = game.placeStation(at(2200, 40), 14, 'rail', SERVES, 0, 2, 150, true)!;
    const line = game.createLine([t1.id, t2.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, NO_WAIT);
    game.buyVehicle(line.id, 'freightTrain');
    const train = () => [...game.rail.trains.values()][0];
    // Доезжает до t2 и встаёт под выгрузку.
    let guard = 0;
    while (guard++ < 6000 && !(train() && !train().moving && t2.platforms.includes(train().platform ?? -1))) game.update(0.1);
    expect(t2.platforms).toContain(train().platform);
    expect(facing(game, train())).toBe(-1);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    // Как в старой версии: на стоянке голова — со стороны упора, откуда приехал.
    const old = save.rail.trains[0];
    const seg = game.net.segment(old.platform);
    const e = old.path[0];
    const front = e.dir === 0 ? old.head : seg.length - old.head;
    const x0 = e.dir === 0 ? front - old.length : front;
    const x1 = e.dir === 0 ? front : front + old.length;
    e.dir = e.dir === 0 ? 1 : 0;
    old.head = old.stopAt = e.dir === 0 ? x1 : seg.length - x0;
    const legacy = withoutCitizens(new Game(game.settings, save));
    const lt = [...legacy.rail.trains.values()][0];
    expect(lt.moving).toBe(false);
    expect(facing(legacy, lt)).toBe(-1);
    // Тот же отрезок платформы под поездом — и тот же ход дальше, что без перезагрузки.
    const mid = (g: Game, tr: Train) => g.rail.pointAt(tr, tr.head - tr.length / 2)!.pos;
    expect(dist(mid(legacy, lt), mid(game, train()))).toBeLessThan(0.01);
    runSeconds(game, 300);
    runSeconds(legacy, 300);
    const a = train();
    const b = [...legacy.rail.trains.values()][0];
    expect(b.moving).toBe(a.moving);
    expect(dist(game.rail.cars(a)[0].pos, legacy.rail.cars(b)[0].pos)).toBeLessThan(0.01);
    expect(legacy.lines.get(line.id)!.problem).toBeNull();
  });
});
