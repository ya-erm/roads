import { describe, expect, it } from 'vitest';
import type { Cubic } from '../core/bezier';
import { add, dist, rightNormal, scale, sub, Vec } from '../core/vec';
import type { Station } from '../world/entities';
import { RAIL_SPEC, TRACK_GAP } from '../world/roadTypes';
import type { RoadRequest, Snap } from './build';
import { Game } from './game';

function runSeconds(game: Game, seconds: number, each?: () => void) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) {
    game.update(0.1);
    each?.();
  }
}

function straight(from: Vec, to: Vec): RoadRequest {
  return { start: { kind: 'free', pos: from, level: 0 }, end: { kind: 'free', pos: to, level: 0 }, spec: RAIL_SPEC, mode: 'straight' };
}

/** Длинный путь с вокзалами у концов (как в rail.test.ts); сбоку (−n) есть место для второго пути. */
function railWorld(): { game: Game; a: Station; b: Station; at: (k: number, side?: number) => Vec; dir: Vec; n: Vec } {
  const game = new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry' });
  const len = 2400;
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      for (const angle of [0, 0.3, -0.3]) {
        const dir = { x: Math.cos(angle), y: Math.sin(angle) };
        const n = rightNormal(dir);
        const from = { x, y };
        const at = (k: number, side = 0) => add(add(from, scale(dir, k)), scale(n, side));
        const req = straight(from, at(len));
        if (!game.builder.plan(req).ok || !game.builder.plan(straight(at(700, -TRACK_GAP), at(1700, -TRACK_GAP))).ok) continue;
        game.builder.build(req);
        const a = game.stationPlan(at(400, 40), 14, 'rail');
        const b = game.stationPlan(at(len - 400, 40), 14, 'rail');
        if (a.ok && b.ok) return { game, a: game.placeStation(at(400, 40), 14, 'rail')!, b: game.placeStation(at(len - 400, 40), 14, 'rail')!, at, dir, n };
        game.builder.bulldoze(at(len / 2), 4);
      }
    }
  }
  throw new Error('Нет места для пути');
}

/** Обгон: второй путь сбоку (−n) от 800 до 1600 м, плавно отходит от главного и возвращается на него стрелками. */
function passingLoop(game: Game, at: (k: number, side?: number) => Vec, dir: Vec): void {
  const s = (p0: Vec, p3: Vec): Cubic => ({ p0, p1: add(p0, scale(dir, 80)), p2: sub(p3, scale(dir, 80)), p3 });
  const out = game.builder.snap(at(800), 0, 4);
  expect(out.kind).toBe('split');
  const r1 = game.builder.build({ ...straight(out.pos, at(1000, -TRACK_GAP)), start: out, curve: s(out.pos, at(1000, -TRACK_GAP)) })!;
  expect(r1).not.toBeNull();
  const node = (id: number): Snap => ({ kind: 'node', nodeId: id, pos: game.net.node(id).pos, level: 0 });
  const r2 = game.builder.build({ ...straight(at(1000, -TRACK_GAP), at(1400, -TRACK_GAP)), start: node(r1.endNode) })!;
  expect(r2).not.toBeNull();
  const back = game.builder.snap(at(1600), 0, 4);
  expect(back.kind).toBe('split');
  const r3 = game.builder.build({ ...straight(at(1400, -TRACK_GAP), back.pos), start: node(r2.endNode), end: back, curve: s(game.net.node(r2.endNode).pos, back.pos) });
  expect(r3).not.toBeNull();
}

/** Участок пути у точки p. */
const segAt = (game: Game, p: Vec) => game.net.findSegmentNear(p, 2)!.seg.id;

describe('Сигналы без встречного', { timeout: 60_000 }, () => {
  it('двухпутка: поезда в каждую сторону едут по своему пути', () => {
    const { game, a, b, at, dir } = railWorld();
    passingLoop(game, at, dir);
    // Главный путь — только туда (к b), обгон — только обратно: курсор справа по ходу поезда.
    expect(game.signalPlan(at(1200, 3), 14, true).oneWay).toBe(true);
    expect(game.toggleSignal(at(1200, 3), 14, true)).toBe(true);
    expect(game.toggleSignal(at(1200, -TRACK_GAP - 3), 14, true)).toBe(true);
    const ways = [...game.net.nodes.values()].filter((x) => x.oneWay?.length);
    expect(ways).toHaveLength(2);
    // Маршрут линии на карте: туда — по главному, обратно — по обгону.
    const there = game.rail.previewRoute(a.platforms, b.platforms)!;
    const back = game.rail.previewRoute(b.platforms, a.platforms)!;
    const passes = (pts: Vec[], p: Vec) => pts.some((q) => dist(q, p) < 2);
    expect(passes(there, at(1200))).toBe(true);
    expect(passes(there, at(1200, -TRACK_GAP))).toBe(false);
    expect(passes(back, at(1200, -TRACK_GAP))).toBe(true);
    expect(passes(back, at(1200))).toBe(false);

    // Два поезда на линии: каждый в свою сторону по своему пути, оба доезжают.
    const main = [segAt(game, at(1000)), segAt(game, at(1400))];
    const loop = [segAt(game, at(1100, -TRACK_GAP)), segAt(game, at(1300, -TRACK_GAP))];
    const line = game.createLine([a.id, b.id])!;
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    game.setStopRule(line.id, 1, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    game.buyVehicle(line.id, 'passengerTrain');
    game.buyVehicle(line.id, 'passengerTrain');
    const used = { there: new Set<number>(), back: new Set<number>() };
    let arrivals = 0;
    const last = new Map<number, string>();
    runSeconds(game, 400, () => {
      for (const v of game.fleet.values()) {
        const t = game.fleetTrain(v);
        if (t?.moving) for (const e of t.path) used[v.stop === 1 ? 'there' : 'back'].add(e.seg);
        if (v.state === 'loading' && last.get(v.id) !== 'loading') arrivals++;
        last.set(v.id, v.state);
      }
    });
    expect(game.lines.get(line.id)!.problem).toBeNull();
    expect(arrivals).toBeGreaterThanOrEqual(4);
    expect(main.every((id) => used.there.has(id))).toBe(true);
    expect(loop.some((id) => used.there.has(id))).toBe(false);
    expect(loop.every((id) => used.back.has(id))).toBe(true);
    expect(main.some((id) => used.back.has(id))).toBe(false);
  });

  it('однопутка с сигналом только туда: обратно пути нет — линия сообщает; тип сигнала меняется, сохраняется и копируется', () => {
    const { game, a, b, at } = railWorld();
    expect(game.toggleSignal(at(1200, 3), 14, true)).toBe(true);
    expect(game.rail.previewRoute(a.platforms, b.platforms)).not.toBeNull();
    expect(game.rail.previewRoute(b.platforms, a.platforms)).toBeNull();
    expect(game.rail.blockedByOneWay(b.platforms, a.platforms)).toBe(true);
    expect(game.rail.blockedByOneWay(a.platforms, b.platforms)).toBe(false);

    const line = game.createLine([a.id, b.id])!;
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    game.buyVehicle(line.id, 'passengerTrain');
    const v = [...game.fleet.values()][0];
    let reached = false;
    runSeconds(game, 300, () => {
      if (v.state === 'loading' && v.stop === 1) reached = true;
    });
    // Туда доехал, обратно маршрута нет.
    expect(reached).toBe(true);
    expect(v.stop).toBe(1);
    expect(game.lines.get(line.id)!.problem).toMatch(/^Нет пути: .* — только против одностороннего сигнала$/);

    // Копия куска пути с сигналом: сигнал остаётся «без встречного».
    const frag = game.copyArea(at(1100, -40), at(1300, 40))!;
    expect(frag.rail!.nodes.some((x) => x.oneWay?.length === 1 && x.signals?.includes(x.oneWay[0]))).toBe(true);

    // Сохранение: тип сигнала на месте; старое сохранение (без поля) — все сигналы обычные.
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(game.settings, save);
    expect([...loaded.net.nodes.values()].filter((x) => x.oneWay?.length)).toHaveLength(1);
    for (const nd of save.net.nodes) delete nd.oneWay;
    const old = new Game(game.settings, save);
    expect([...old.net.nodes.values()].some((x) => x.signals?.length && !x.oneWay)).toBe(true);
    expect(old.rail.previewRoute(b.platforms, a.platforms)).not.toBeNull();

    // Тот же сигнал обычным — тип меняется бесплатно, обратно снова можно проехать.
    const plan = game.signalPlan(at(1200, 3), 14, false);
    expect(plan.retype).toBe(true);
    expect(plan.cost).toBe(0);
    expect(game.toggleSignal(at(1200, 3), 14, false)).toBe(true);
    expect(game.rail.previewRoute(b.platforms, a.platforms)).not.toBeNull();
    // Ещё раз тем же — снять.
    expect(game.signalPlan(at(1200, 3), 14, false).remove).toBe(true);
    runSeconds(game, 10);
    expect(game.lines.get(line.id)!.problem ?? '').not.toMatch(/одностороннего/);
  });
});
