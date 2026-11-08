import { describe, expect, it } from 'vitest';
import { add, dist, scale, type Vec } from '../core/vec';
import type { BuildBase, Station } from '../world/entities';
import { Network } from '../world/network';
import { RAIL_SPEC } from '../world/roadTypes';
import type { RoadRequest } from './build';
import { Game } from './game';
import { road, runSeconds, withoutCitizens } from './testkit';

/** Прямой путь от from до to (instant — готов сразу и «Со строительством»). */
function track(game: Game, from: Vec, to: Vec, instant = false): RoadRequest {
  return { start: game.builder.snap(from, 0, 14), end: { kind: 'free', pos: to, level: 0 }, spec: RAIL_SPEC, mode: 'straight', ...(instant ? { instant: true as const } : {}) };
}

/** Узел дороги в точке p (в пределах метра). */
function roadNode(game: Game, p: Vec): number {
  const n = [...game.roads.net.nodes.values()].find((k) => dist(k.pos, p) < 1);
  if (!n) throw new Error('нет узла дороги');
  return n.id;
}

/** Своя база с бригадой у узла дороги gate (бригады первой базы — прочь): ворота — этот узел. */
function baseAt(game: Game, pos: Vec, gate: number): BuildBase {
  const crews = game.construction.crews;
  crews.brigades.clear();
  const base: BuildBase = { type: 'base', id: 990_000 + crews.bases.size, fp: { center: { ...pos }, w: 36, h: 24, angle: 0 }, nodeId: gate };
  crews.bases.set(base.id, base);
  crews.hire(base.id);
  return base;
}

const building = (game: Game) => [...game.net.segments.values()].filter((s) => s.build);

/**
 * Партия «Со строительством»: готовый путь 1200 м с вокзалом a, от его конца — ж/д проект ещё на 1200 м с вокзалом b
 * на нём; к началу проекта — подъезд: улица, что кончается в 80 м от конца готового пути, у её дальнего конца — база с
 * бригадой. Пути — в чистом поле вдали от городов (без машин жителей).
 */
function railProject(): { game: Game; a: Station; b: Station; id: number; from: Vec; dir: Vec; gate: number; access: number } {
  const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' }));
  const len = 2400;
  for (let y = 500; y < game.terrain.height - 500; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      const from = { x, y };
      const dir = { x: 1, y: 0 };
      const mid = add(from, scale(dir, len / 2));
      const end = add(from, scale(dir, len));
      if (!game.builder.plan(track(game, from, end, true)).ok) continue;
      game.checkpoint('проба');
      const ok = (() => {
        if (!game.builder.build(track(game, from, mid, true))) return false;
        const a = game.stationPlan(add(add(from, scale(dir, 400)), { x: 0, y: 40 }), 14, 'rail');
        if (!a.ok) return false;
        // Подъезд к началу проекта: с севера, тупиком в 80 м от конца готового пути.
        if (!road(game, { free: { x: mid.x - 160, y: mid.y - 260 } }, { free: { x: mid.x, y: mid.y - 80 } })) return false;
        return game.builder.plan(track(game, mid, end)).ok;
      })();
      game.commit();
      if (!ok) {
        game.undo();
        continue;
      }
      const gate = roadNode(game, { x: mid.x - 160, y: mid.y - 260 });
      // Подъезд к пути — тупик улицы у конца готового пути.
      const access = roadNode(game, { x: mid.x, y: mid.y - 80 });
      baseAt(game, { x: mid.x - 190, y: mid.y - 280 }, gate);
      const id = game.construction.peekId();
      if (!game.builder.build(track(game, mid, end))) throw new Error('проект не лёг');
      const a = game.placeStation(add(add(from, scale(dir, 400)), { x: 0, y: 40 }), 14, 'rail')!;
      const b = game.placeStation(add(add(from, scale(dir, len - 400)), { x: 0, y: 40 }), 14, 'rail')!;
      if (!a || !b) throw new Error('вокзалы не встали');
      return { game, a, b, id, from, dir, gate, access };
    }
  }
  throw new Error('нет места');
}

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

  it('бригада едет по дорогам к подъезду, строит путь этапами; поезд не едет, пока путь не готов, потом едет', () => {
    const { game, id, a, b, access } = railProject();
    const line = game.createLine([a.id, b.id])!;
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    expect(game.buyVehicle(line.id, 'passengerTrain')).not.toBeNull();
    const train = () => [...game.rail.trains.values()][0];
    const crews = game.construction.crews;
    const brigade = [...crews.brigades.values()][0];
    let onSite = false;
    let reachedB = false;
    const startMoney = game.money;
    runSeconds(game, 60, () => {
      if (brigade.state === 'working') onSite = true;
      if (train()?.platform !== null && b.platforms.includes(train()!.platform!)) reachedB = true;
    });
    // Бригада на месте: доехала по улице от ворот базы до её тупика у пути, съехала оттуда и строит.
    expect(onSite).toBe(true);
    expect(brigade.at).toBe(access);
    const info = game.construction.info(id)!;
    expect(info.done).toBeGreaterThan(0);
    expect(info.stages[0]).toBeGreaterThan(info.stages[2]);
    expect(game.money).toBeLessThan(startMoney);
    // Пока путь строится, поезд до b не доехал.
    expect(reachedB).toBe(false);
    // Участки строятся цепочкой: колонна идёт вдоль пути от участка к участку, не возвращаясь к дороге.
    let back = false;
    runSeconds(game, 400, () => {
      if (train()?.platform !== null && b.platforms.includes(train()!.platform!)) reachedB = true;
      if (game.construction.projects.has(id) && brigade.trip?.back) back = true;
    });
    expect(back).toBe(false);
    expect(game.construction.projects.has(id)).toBe(false);
    expect(building(game)).toEqual([]);
    expect(reachedB).toBe(true);
    // Бригада вернулась к дороге (по полосе отвода к подъезду) и домой, а не осталась на путях.
    expect(brigade.state === 'idle' || brigade.state === 'back').toBe(true);
  });

  it('сохранение посреди стройки пути: та же стройка после загрузки, дальше — одинаково', () => {
    const { game, id } = railProject();
    runSeconds(game, 45);
    const done = game.construction.info(id)!.done;
    expect(done).toBeGreaterThan(0);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    expect(save.construction.projects.find((p: { id: number }) => p.id === id).rail).toBe(true);
    expect(save.net.segments.some((s: { build?: unknown }) => s.build)).toBe(true);
    const loaded = withoutCitizens(new Game(save.settings, save));
    expect(loaded.construction.info(id)!.done).toBeCloseTo(done, 9);
    expect(loaded.construction.projects.get(id)!.rail).toBe(true);
    for (const g of [game, loaded]) runSeconds(g, 60);
    expect(loaded.money).toBe(game.money);
    expect(JSON.stringify(loaded.net.serialize())).toBe(JSON.stringify(game.net.serialize()));
  });

  it('отмена проекта сносит недостроенный путь и возвращает заплаченное; под вокзалом путь достраивается', () => {
    const { game, id, b } = railProject();
    runSeconds(game, 45);
    const p = game.construction.projects.get(id)!;
    const spent = p.spent;
    expect(spent).toBeGreaterThan(0);
    const money = game.money;
    expect(game.cancelProject(id)).toBe(true);
    expect(game.money).toBeGreaterThan(money);
    // Остались только платформа вокзала b (её не сносят без вокзала) — её проект достроит.
    for (const s of building(game)) expect(s.platform).toBe(b.id);
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
    runSeconds(game, 45);
    const started = building(game).find((s) => s.build!.done > 0)!;
    expect(started).toBeDefined();
    const plan = game.builder.reshape({ curves: new Map([[started.id, { ...started.curve, p1: add(started.curve.p1, { x: 0, y: 15 }) }]]) });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('Путь уже строится');
  });

  it('путь без дороги рядом — нет подъезда: бригады не едут', () => {
    const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' }));
    // Самое пустое место карты: дальше всего от дорог.
    let best: { p: Vec; d: number } | null = null;
    for (let y = 400; y < game.terrain.height - 400; y += 150) {
      for (let x = 400; x < game.terrain.width - 900; x += 150) {
        const p = { x, y };
        const near = [...game.roads.net.nodes.values()].reduce((m, n) => Math.min(m, dist(n.pos, p), dist(n.pos, { x: x + 500, y })), Infinity);
        const req: RoadRequest = { start: { kind: 'free', pos: p, level: 0 }, end: { kind: 'free', pos: { x: x + 500, y }, level: 0 }, spec: RAIL_SPEC, mode: 'straight' };
        if (near > 400 && (!best || near > best.d) && game.builder.plan(req).ok) best = { p, d: near };
      }
    }
    expect(best).not.toBeNull();
    const p = best!.p;
    const id = game.construction.peekId();
    game.builder.build({ start: { kind: 'free', pos: p, level: 0 }, end: { kind: 'free', pos: { x: p.x + 500, y: p.y }, level: 0 }, spec: RAIL_SPEC, mode: 'straight' });
    const info = game.construction.info(id)!;
    expect(info.access).toBe(false);
    expect(game.construction.site(id)).toBeNull();
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
