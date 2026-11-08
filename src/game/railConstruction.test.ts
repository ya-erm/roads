import { describe, expect, it } from 'vitest';
import { add, scale, type Vec } from '../core/vec';
import { Network } from '../world/network';
import { RAIL_SPEC } from '../world/roadTypes';
import type { RoadRequest } from './build';
import { Game } from './game';
import { RAIL_WORLD as WORLD, railProjectScene as railProject, railTrack as track, runSeconds, withoutCitizens } from './testkit';

const building = (game: Game) => [...game.net.segments.values()].filter((s) => s.build);

describe('Стройка ж/д путей: «Со строительством»', { timeout: 60_000 }, () => {
  it('путь ложится проектом: участки помечены стройкой, денег сразу не берёт, проект — «Ж/д путь»', () => {
    const { game, id, b } = railProject();
    const p = game.construction.projects.get(id)!;
    expect(p.rail).toBe(true);
    expect(p.label).toBe('Ж/д путь');
    const segs = building(game);
    // Вокзал на проекте разрезал путь — его куски строятся дальше тем же проектом.
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.build!.project).toBe(id);
    expect(segs.some((s) => s.platform === b.id)).toBe(true);
    const info = game.construction.info(id)!;
    expect(info.done).toBe(0);
    expect(info.length).toBeGreaterThan(1150);
    expect(info.left).toBeGreaterThan(0);
    expect(info.access).toBe(true);
    // Дорожные проекты не задеты: полотен со стройкой нет.
    expect(game.construction.corridorsOf(id)).toEqual([]);
  });

  it('продолжение строящегося пути — тот же проект; путь «Мгновенно» — готов сразу', () => {
    const { game, id, from, dir } = railProject();
    const end = add(from, scale(dir, 2400));
    const before = game.construction.projects.size;
    expect(game.builder.build(track(game, end, add(end, { x: 300, y: 0 })))).not.toBeNull();
    expect(game.construction.projects.size).toBe(before);
    expect(building(game).filter((s) => s.build!.project === id).length).toBeGreaterThan(0);
    const money = game.money;
    const instant = withoutCitizens(new Game({ ...game.settings, construction: 'instant' }));
    const at = { x: 400, y: 400 };
    const req: RoadRequest = { start: { kind: 'free', pos: at, level: 0 }, end: { kind: 'free', pos: { x: 700, y: 400 }, level: 0 }, spec: RAIL_SPEC, mode: 'straight' };
    if (instant.builder.plan(req).ok) {
      instant.builder.build(req);
      expect([...instant.net.segments.values()].some((s) => s.build)).toBe(false);
      expect(instant.construction.projects.size).toBe(0);
    }
    expect(game.money).toBe(money);
  });

  it('строительный поезд выходит с вокзала по путям и строит этапами — без дорог и баз; поезд линии ждёт готовности', () => {
    const { game, id, a, b } = railProject();
    expect(game.construction.crews.bases.size).toBe(0);
    const line = game.createLine([a.id, b.id])!;
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    const v = game.buyVehicle(line.id, 'passengerTrain')!;
    expect(v).not.toBeNull();
    const lineTrain = () => game.fleetTrain(v);
    const trains = game.construction.trains!;
    let onSite = false;
    let moved = false;
    let reachedB = false;
    let simId: number | undefined;
    const startMoney = game.money;
    runSeconds(game, 90, () => {
      const w = trains.of(id);
      if (w?.state === 'working') onSite = true;
      if (w?.train !== undefined) simId = w.train;
      const t = simId !== undefined ? game.rail.trains.get(simId) : undefined;
      if (t?.moving) moved = true;
      if (lineTrain()?.platform != null && b.platforms.includes(lineTrain()!.platform!)) reachedB = true;
    });
    // Поезд вышел с вокзала a (депо), доехал по готовому пути до начала проекта и строит.
    const w = trains.of(id)!;
    expect(w.depot).toBe(a.id);
    expect(moved).toBe(true);
    expect(onSite).toBe(true);
    expect(game.construction.crews.assigned(id)).toEqual([]);
    const info = game.construction.info(id)!;
    expect(info.done).toBeGreaterThan(0);
    expect(info.stages[0]).toBeGreaterThan(info.stages[2]);
    expect(game.money).toBeLessThan(startMoney);
    // Строительный поезд — в общем движении: стоит на готовом пути у края работ.
    const t = game.rail.trains.get(w.train!)!;
    expect(game.net.segment(t.platform!).build).toBeUndefined();
    // Пока путь строится, поезд линии до b не доехал.
    expect(reachedB).toBe(false);
    runSeconds(game, 500, () => {
      if (lineTrain()?.platform != null && b.platforms.includes(lineTrain()!.platform!)) reachedB = true;
    });
    expect(game.construction.projects.has(id)).toBe(false);
    expect(building(game)).toEqual([]);
    expect(reachedB).toBe(true);
    // Строительный поезд вернулся на свой вокзал и ушёл из движения.
    expect(trains.list.size).toBe(0);
    expect(game.rail.trains.has(simId!)).toBe(false);
  });

  it('нет вокзала — «нет вокзала»; путь не связан с вокзалом — «нет пути к стройке»: поезд не едет', () => {
    const game = withoutCitizens(new Game(WORLD));
    let at: Vec | null = null;
    for (let y = 500; y < game.terrain.height - 500 && !at; y += 170) {
      for (let x = 300; x < game.terrain.width - 900 && !at; x += 230) {
        if (game.builder.plan(track(game, { x, y }, { x: x + 600, y })).ok) at = { x, y };
      }
    }
    expect(at).not.toBeNull();
    const id = game.construction.peekId();
    game.builder.build(track(game, at!, { x: at!.x + 600, y: at!.y }));
    runSeconds(game, 1);
    const trains = game.construction.trains!;
    expect(trains.problem(id)).toBe('depot');
    expect(game.construction.info(id)!.access).toBe(false);
    // Вокзал на другом, готовом пути — до проекта по путям не доехать.
    const { game: g2, from } = railProject();
    const far = add(from, { x: 0, y: 340 });
    const other = g2.construction.peekId();
    if (g2.builder.plan(track(g2, far, add(far, { x: 500, y: 0 }))).ok) {
      g2.builder.build(track(g2, far, add(far, { x: 500, y: 0 })));
      runSeconds(g2, 3);
      expect(g2.construction.trains!.problem(other)).toBe('route');
      expect(g2.construction.trains!.status(other, () => '').text).toBe('нет пути к стройке');
      expect(g2.construction.trains!.of(other)).toBeUndefined();
    }
  });

  it('сохранение посреди стройки пути: та же стройка после загрузки, дальше — одинаково', () => {
    const { game, id } = railProject();
    runSeconds(game, 90);
    const done = game.construction.info(id)!.done;
    expect(done).toBeGreaterThan(0);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    expect(save.construction.projects.find((p: { id: number }) => p.id === id).rail).toBe(true);
    expect(save.net.segments.some((s: { build?: unknown }) => s.build)).toBe(true);
    const loaded = withoutCitizens(new Game(save.settings, save));
    expect(loaded.construction.info(id)!.done).toBeCloseTo(done, 9);
    expect(loaded.construction.projects.get(id)!.rail).toBe(true);
    // Строительный поезд — тот же: там же в движении и на том же участке.
    expect(save.construction.trains.trains).toHaveLength(1);
    expect(loaded.construction.trains!.toSave()).toEqual(game.construction.trains!.toSave());
    const w = loaded.construction.trains!.of(id)!;
    expect(loaded.rail.trains.has(w.train!)).toBe(true);
    for (const g of [game, loaded]) runSeconds(g, 60);
    expect(loaded.money).toBe(game.money);
    expect(JSON.stringify(loaded.net.serialize())).toBe(JSON.stringify(game.net.serialize()));
    expect(loaded.construction.trains!.toSave()).toEqual(game.construction.trains!.toSave());
  });

  it('отмена проекта сносит недостроенный путь и возвращает заплаченное; под вокзалом путь достраивается', () => {
    const { game, id, b } = railProject();
    runSeconds(game, 90);
    const p = game.construction.projects.get(id)!;
    const spent = p.spent;
    expect(spent).toBeGreaterThan(0);
    const money = game.money;
    expect(game.construction.trains!.of(id)?.state).toBe('working');
    expect(game.cancelProject(id)).toBe(true);
    expect(game.money).toBeGreaterThan(money);
    // Остались только платформа вокзала b (её не сносят без вокзала).
    for (const s of building(game)) expect(s.platform).toBe(b.id);
    // К ней по путям теперь не доехать — строительный поезд уходит домой.
    runSeconds(game, 3);
    expect(game.construction.trains!.of(id)).toBeUndefined();
    expect([...game.construction.trains!.list.values()].every((w) => w.state === 'back')).toBe(true);
  });

  it('Ctrl+Z: не начатый путь-проект убирается целиком, начатый — как «Отмена»; начатый путь не переложить', () => {
    const { game, id, from, dir } = railProject();
    // Ещё один путь проектом в стороне — от конца готового: не начат, отмена убирает его целиком.
    const end = add(from, scale(dir, 2400));
    game.checkpoint('путь');
    const next = game.construction.peekId();
    const far = add(end, { x: 0, y: 300 });
    const req: RoadRequest = { start: { kind: 'free', pos: add(far, { x: -500, y: 0 }), level: 0 }, end: { kind: 'free', pos: far, level: 0 }, spec: RAIL_SPEC, mode: 'straight' };
    const built = game.builder.plan(req).ok && game.builder.build(req);
    game.commit();
    expect(built).toBeTruthy();
    expect(game.construction.projects.get(next)?.rail).toBe(true);
    expect(game.undo()).not.toBeNull();
    expect(game.construction.projects.has(next)).toBe(false);
    expect(building(game).every((s) => s.build!.project === id)).toBe(true);
    // Начатый — уже строится: перекладка участка с готовым — отказ.
    runSeconds(game, 90);
    const started = building(game).find((s) => s.build!.done > 0)!;
    expect(started).toBeDefined();
    const plan = game.builder.reshape({ curves: new Map([[started.id, { ...started.curve, p1: add(started.curve.p1, { x: 0, y: 15 }) }]]) });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('Путь уже строится');
  });

  it('одни и те же действия дважды — тот же результат (поезд, стройка, деньги)', () => {
    const run = () => {
      const { game } = railProject();
      runSeconds(game, 120);
      return { money: game.money, net: JSON.stringify(game.net.serialize()), c: JSON.stringify(game.construction.toSave()), rail: JSON.stringify(game.rail.serialize()) };
    };
    expect(run()).toEqual(run());
  });

  it('разрез строящегося пути делит готовое по этапам с того же конца', () => {
    const net = new Network();
    const a = net.addNode({ x: 0, y: 0 });
    const b = net.addNode({ x: 100, y: 0 });
    const s = net.addSegment(a.id, b.id, { p0: { x: 0, y: 0 }, p1: { x: 33, y: 0 }, p2: { x: 66, y: 0 }, p3: { x: 100, y: 0 } }, RAIL_SPEC);
    s.build = { project: 7, done: 50, stages: [70, 40, 10] };
    const { first, second } = net.splitSegmentDetailed(s.id, 0.5);
    expect(first.build!.stages![0]).toBeCloseTo(first.length, 3);
    expect(first.build!.stages![1]).toBeCloseTo(40, 3);
    expect(second.build!.stages![0]).toBeCloseTo(70 - first.length, 3);
    expect(second.build!.stages![2]).toBe(0);
    // От конца b — готовое у второй части.
    const c = net.addSegment(a.id, b.id, { p0: { x: 0, y: 0 }, p1: { x: 33, y: 0 }, p2: { x: 66, y: 0 }, p3: { x: 100, y: 0 } }, RAIL_SPEC);
    c.build = { project: 7, done: 20, fromB: true, stages: [30, 0, 0] };
    const parts = net.splitSegmentDetailed(c.id, 0.5);
    expect(parts.second.build!.stages![0]).toBeCloseTo(Math.min(30, parts.second.length), 3);
    expect(parts.first.build!.stages![0]).toBeCloseTo(Math.max(0, 30 - parts.second.length), 3);
    expect(parts.first.build!.fromB).toBe(true);
    // Сохранение — со стройкой; загрузка — та же.
    const copy = new Network();
    copy.load(JSON.parse(JSON.stringify(net.serialize())));
    expect(copy.segment(parts.second.id).build).toEqual(parts.second.build);
  });
});
