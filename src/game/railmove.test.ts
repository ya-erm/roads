import { describe, expect, it } from 'vitest';
import { add, dist, dot, rightNormal, scale, sub, Vec } from '../core/vec';
import { RailTools } from '../input/railtools';
import type { Station } from '../world/entities';
import { RAIL_SPEC, TRACK_GAP } from '../world/roadTypes';
import type { RoadRequest } from './build';
import { Game } from './game';
import { besideTrack, trackHandlePoints } from './railEdit';
import { withoutCitizens } from './testkit';

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

const dryGame = (money = 9_000_000) => new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money, water: 'dry' });

/** Прямой путь длиной len в свободном месте (с запасом по бокам): начало и направление. */
function freeTrack(game: Game, len: number, margin = 80): { from: Vec; dir: Vec } {
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      const from = { x, y };
      const dir = { x: 1, y: 0 };
      const n = rightNormal(dir);
      // Место по бокам: туда потом ляжет второй путь или уйдёт перенесённый узел.
      const sides = [-margin, margin].map((k) => straight(add(from, scale(n, k)), add(add(from, scale(dir, len)), scale(n, k))));
      if (!sides.every((r) => game.builder.plan(r).ok)) continue;
      const req = straight(from, add(from, scale(dir, len)));
      if (game.builder.plan(req).ok && game.builder.build(req)) return { from, dir };
    }
  }
  throw new Error('Нет места для пути');
}

/** Длинный путь с вокзалами у концов (как в rail.test.ts) — в чистом поле, без машин жителей (сюда они не доезжают). */
function railWorld(): { game: Game; a: Station; b: Station; from: Vec; dir: Vec } {
  const game = withoutCitizens(dryGame(5_000_000));
  const len = 2400;
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      for (const angle of [0, 0.3, -0.3]) {
        const dir = { x: Math.cos(angle), y: Math.sin(angle) };
        const from = { x, y };
        const req = straight(from, add(from, scale(dir, len)));
        if (!game.builder.plan(req).ok) continue;
        game.builder.build(req);
        const n = rightNormal(dir);
        const a = game.stationPlan(add(add(from, scale(dir, 400)), scale(n, 40)), 14, 'rail');
        const b = game.stationPlan(add(add(from, scale(dir, len - 400)), scale(n, 40)), 14, 'rail');
        if (a.ok && b.ok) {
          const sa = game.placeStation(add(add(from, scale(dir, 400)), scale(n, 40)), 14, 'rail')!;
          const sb = game.placeStation(add(add(from, scale(dir, len - 400)), scale(n, 40)), 14, 'rail')!;
          return { game, a: sa, b: sb, from, dir };
        }
        game.builder.bulldoze(add(from, scale(dir, len / 2)), 4);
      }
    }
  }
  throw new Error('Нет места для пути');
}

/** Поворот вектора на угол a. */
const turn = (v: Vec, a: number): Vec => ({ x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) });

describe('Второй путь рядом', () => {
  it('начало у тупика прилипает ровно напротив него, вдоль пути — на междупутье сбоку; второй путь ложится рядом', () => {
    const game = dryGame();
    const { from, dir } = freeTrack(game, 600);
    const n = rightNormal(dir);
    const end = add(from, scale(dir, 600));
    // Курсор у тупика, чуть мимо: начало — ровно напротив тупика, вдоль пути.
    const b = besideTrack(game.net, add(add(end, scale(n, 11)), scale(dir, 4)), 0, 8)!;
    expect(b).not.toBeNull();
    expect(b.end).toBe(true);
    expect(dist(b.pos, add(end, scale(n, TRACK_GAP)))).toBeLessThan(1e-6);
    expect(Math.abs(dot(b.axis, dir))).toBeGreaterThan(0.999);
    // Вдоль пути — сбоку от ближайшей точки, со стороны курсора.
    const side = besideTrack(game.net, add(add(from, scale(dir, 300)), scale(n, -15)), 0, 8)!;
    expect(side.end).toBe(false);
    expect(dist(side.pos, add(add(from, scale(dir, 300)), scale(n, -TRACK_GAP)))).toBeLessThan(0.01);
    // Не на междупутье — не прилипает.
    expect(besideTrack(game.net, add(add(from, scale(dir, 300)), scale(n, 30)), 0, 8)).toBeNull();
    expect(besideTrack(game.net, add(add(from, scale(dir, 300)), scale(n, 12)), 1, 8)).toBeNull();

    // Второй путь — от места напротив одного тупика до места напротив другого, как его кладёт инструмент:
    // из начала вдоль соседнего пути, в конец — параллельно ему.
    const a = besideTrack(game.net, add(from, scale(n, 14)), 0, 8)!;
    expect(a.end).toBe(true);
    const t = dot(b.axis, sub(a.pos, b.pos)) >= 0 ? b.axis : scale(b.axis, -1);
    const h = dist(a.pos, b.pos) * 0.4;
    const req: RoadRequest = { ...straight(b.pos, a.pos), curve: { p0: b.pos, p1: add(b.pos, scale(t, h)), p2: sub(a.pos, scale(t, h)), p3: a.pos } };
    expect(game.builder.plan(req).reason ?? 'ok').toBe('ok');
    expect(game.builder.build(req)).not.toBeNull();
    for (const k of [0, 150, 300, 450, 600]) {
      const hit = game.net.findSegmentNear(add(add(from, scale(dir, k)), scale(n, TRACK_GAP)), 1);
      expect(hit).not.toBeNull();
      expect(hit!.d).toBeLessThan(0.05);
    }
    // Там уже второй путь — на него больше не прилипает.
    expect(besideTrack(game.net, add(end, scale(n, 12)), 0, 8)).toBeNull();
  });
});

describe('Двигать пути', { timeout: 60_000 }, () => {
  it('стык переносится вбок, перо поворачивает его, середина выгибается — поезд по-прежнему ездит между вокзалами', () => {
    const { game, a, b, from, dir } = railWorld();
    const n = rightNormal(dir);
    // Стык посреди пути — узел сигнала.
    expect(game.toggleSignal(add(add(from, scale(dir, 1200)), scale(n, 6)), 14)).toBe(true);
    const node = [...game.net.nodes.values()].find((x) => x.signals?.length)!;
    expect(node.segments).toHaveLength(2);
    const tools = new RailTools(() => game);
    expect(tools.nodeAt(node.pos, 14)?.id).toBe(node.id);
    // Поезд уже в пути: перестройка не должна его потерять.
    const line = game.createLine([a.id, b.id])!;
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' });
    game.buyVehicle(line.id, 'passengerTrain');
    const v = [...game.fleet.values()][0];
    runSeconds(game, 25);
    expect(v.state).toBe('driving');

    // Узел — на 30 м вбок: оба участка тянутся к нему, направление пути в узле прежнее.
    const target = add(node.pos, scale(n, -30));
    expect(tools.moveDown(node.pos, 14)).toBe(true);
    const plan = tools.movePlan(target)!;
    expect(plan.reason ?? 'ok').toBe('ok');
    expect(plan.plans).toHaveLength(2);
    const money = game.money;
    expect(tools.moveUp(target, true)).toBeNull();
    expect(Math.abs(money - game.money - plan.cost)).toBeLessThanOrEqual(1);
    expect(dist(game.net.node(node.id).pos, target)).toBeLessThan(1e-6);
    const [s1, s2] = node.segments.map((id) => game.net.segment(id));
    const dirs = [s1, s2].map((s) => game.net.dirFrom(node.id, s.id));
    expect(dot(dirs[0], dirs[1])).toBeLessThan(-0.999);
    expect(game.net.findSegmentNear(add(add(from, scale(dir, 1200)), scale(n, -30)), 1)).not.toBeNull();
    // Маршрут поезда идёт через перенесённый стык — длины участков в нём уже новые.
    const train = game.fleetTrain(v)!;
    expect(train).toBeDefined();
    expect(train.path.some((e) => e.seg === s1.id || e.seg === s2.id)).toBe(true);
    for (const e of train.path) expect(e.len).toBeCloseTo(game.net.segment(e.seg).length, 6);

    // Перо стыка: поворот на 3° — оба пути поворачивают вместе, стык остаётся гладким.
    tools.editSeg = s1.id;
    const h = tools.handles().find((x) => !x.partner && (x.end === 'a' ? s1.a : s1.b) === node.id)!;
    expect(h).toBeDefined();
    const hp = trackHandlePoints(s1, h.end);
    const grip = add(hp.anchor, turn(sub(hp.pos, hp.anchor), 0.05));
    expect(tools.moveDown(hp.pos, 14, 10)).toBe(true);
    expect(tools.handle).toEqual({ seg: h.seg, end: h.end });
    expect(tools.moveUp(grip, true)).toBeNull();
    const after = [s1, s2].map((s) => game.net.dirFrom(node.id, s.id));
    expect(dot(after[0], after[1])).toBeLessThan(-0.999);
    expect(Math.acos(Math.min(1, dot(after[0], dirs[0])))).toBeCloseTo(0.05, 2);

    // Середина участка к вокзалу b — выгнуть на 20 м: узел у стыка поворачивает следом, у вокзала направление прежнее.
    const far = s2.a === node.id ? s2.b : s2.a;
    const farDir = game.net.dirFrom(far, s2.id);
    const mid = s2.lut.pointAt(s2.length / 2);
    const bulge = add(mid, scale(n, -20));
    expect(tools.moveDown(mid, 14)).toBe(true);
    expect(tools.bend).toBe(s2.id);
    const bent = tools.movePlan(bulge)!;
    expect(bent.reason ?? 'ok').toBe('ok');
    expect(tools.moveUp(bulge, true)).toBeNull();
    expect(game.net.segment(s2.id).lut.closest(bulge).d).toBeLessThan(6);
    expect(dot(game.net.dirFrom(far, s2.id), farDir)).toBeGreaterThan(0.9999);

    // Поезд доезжает и возвращается — по новой форме путей.
    let arrivals = 0;
    let last = v.state;
    runSeconds(game, 260, () => {
      if (v.state === 'loading' && last !== 'loading') arrivals++;
      last = v.state;
    });
    expect(game.lines.get(line.id)!.problem).toBeNull();
    expect(arrivals).toBeGreaterThanOrEqual(2);
  });

  it('нельзя — с понятной причиной: крутой поворот, излом в стыке, пересечение, вода; станции не двигаются', () => {
    const { game, a, from, dir } = railWorld();
    const tools = new RailTools(() => game);
    // Узлы станции и её горловины не берутся, платформу не выгнуть.
    const own = [...game.net.nodes.values()].filter((x) => x.buildingId === a.id);
    expect(own.length).toBeGreaterThan(0);
    for (const x of own) expect(tools.nodeAt(x.pos, 1)).toBeNull();
    const platform = game.net.segment(a.platforms[0]);
    expect(tools.segAt(platform.lut.pointAt(platform.length / 2), 4)).toBeNull();
    // Горловина: стрелка у платформ тоже стоит на месте.
    const ownIds = new Set(own.map((x) => x.id));
    const throat = [...game.net.nodes.values()].find(
      (x) => x.buildingId === null && x.segments.some((sid) => ownIds.has(game.net.segment(sid).a) || ownIds.has(game.net.segment(sid).b)),
    )!;
    expect(throat).toBeDefined();
    expect(tools.nodeAt(throat.pos, 1)).toBeNull();

    const n = rightNormal(dir);
    expect(game.toggleSignal(add(add(from, scale(dir, 1200)), scale(n, 6)), 14)).toBe(true);
    const node = [...game.net.nodes.values()].find((x) => x.signals?.length)!;
    const seg = game.net.segment(node.segments[0]);
    const end = seg.a === node.id ? 'a' : 'b';
    // Перо только одного пути (Shift) на 60° — в стыке излом.
    tools.editSeg = seg.id;
    const hp = trackHandlePoints(seg, end);
    tools.handle = { seg: seg.id, end };
    const kink = tools.movePlan(add(hp.anchor, turn(sub(hp.pos, hp.anchor), 1)), true)!;
    expect(kink.ok).toBe(false);
    expect(kink.reason).toBe('Путь примыкает только плавно, как стрелка');
    expect(kink.plans.every((p) => !p.ok)).toBe(true);
    // Перо тупика в начале пути — поперёк: путь круто поворачивает.
    const dead = game.net.nodesNear(from, 1)[0];
    expect(dead.segments).toHaveLength(1);
    const first = game.net.segment(dead.segments[0]);
    tools.editSeg = first.id;
    const deadEnd = first.a === dead.id ? 'a' : 'b';
    expect(tools.handles().some((x) => x.seg === first.id && x.end === deadEnd)).toBe(true);
    tools.handle = { seg: first.id, end: deadEnd };
    const across = add(from, scale(n, -30));
    const sharp = tools.movePlan(across)!;
    expect(sharp.reason).toBe('Слишком крутой поворот');
    // Отпустили там, где нельзя, — ничего не изменилось.
    const before = JSON.stringify(game.net.serialize());
    expect(tools.moveUp(across, true)).toBe('Слишком крутой поворот');
    expect(JSON.stringify(game.net.serialize())).toBe(before);
  });

  it('тупик нельзя увести через другой путь и в воду; можно — по суше, с ценой', () => {
    const game = dryGame();
    const { from, dir } = freeTrack(game, 600, 120);
    const n = rightNormal(dir);
    // Короткий путь сбоку, тупиками: его конец тянут через первый путь.
    const req = straight(add(add(from, scale(dir, 100)), scale(n, 60)), add(add(from, scale(dir, 300)), scale(n, 60)));
    expect(game.builder.build(req)).not.toBeNull();
    const tip = game.net.nodesNear(add(add(from, scale(dir, 300)), scale(n, 60)), 1)[0];
    const tools = new RailTools(() => game);
    expect(tools.moveDown(tip.pos, 14)).toBe(true);
    const across = tools.movePlan(add(add(from, scale(dir, 300)), scale(n, -60)))!;
    expect(across.reason).toBe('Пересекает другой путь');
    // По суше — можно: длиннее путь — дороже.
    const longer = tools.movePlan(add(add(from, scale(dir, 400)), scale(n, 60)))!;
    expect(longer.reason ?? 'ok').toBe('ok');
    expect(longer.cost).toBeGreaterThan(0);
    // Короче — возврат части денег.
    const shorter = tools.movePlan(add(add(from, scale(dir, 250)), scale(n, 60)))!;
    expect(shorter.ok).toBe(true);
    expect(shorter.cost).toBeLessThan(0);
    tools.cancel();

    // Тупик в воду — нужен мост.
    const wet = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 9_000_000, water: 'wet' });
    const wt = new RailTools(() => wet);
    let tried = false;
    for (let y = 300; y < wet.terrain.height - 300 && !tried; y += 60) {
      for (let x = 300; x < wet.terrain.width - 300 && !tried; x += 60) {
        const w = { x, y };
        if (!wet.isWater(w)) continue;
        for (let k = 0; k < 8 && !tried; k++) {
          const d = { x: Math.cos((k * Math.PI) / 4), y: Math.sin((k * Math.PI) / 4) };
          const near = add(w, scale(d, 140));
          const back = add(w, scale(d, 340));
          if (wet.isWater(near, 20) || wet.isWater(back, 20) || !wet.builder.plan(straight(back, near)).ok) continue;
          wet.builder.build(straight(back, near));
          const end = wet.net.nodesNear(near, 1)[0];
          expect(wt.moveDown(end.pos, 14)).toBe(true);
          expect(wt.movePlan(w)!.reason).toBe('Опора в воде — нужен мост');
          tried = true;
        }
      }
    }
    expect(tried).toBe(true);
  });
});
