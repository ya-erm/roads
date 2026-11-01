import { describe, expect, it } from 'vitest';
import { STATION } from '../config';
import { add, dist, scale, Vec } from '../core/vec';
import type { TownBuilding } from '../world/entities';
import type { RoadNode } from '../world/network';
import type { Footprint } from '../world/spatial';
import type { RoadRequest } from './build';
import { DEFAULT_RULE } from './transport';
import { Game } from './game';

const STREET = { cls: 'street' as const, lanesF: 1, lanesB: 1 };

function runSeconds(game: Game, seconds: number) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) game.update(0.1);
}

const free = (pos: Vec) => ({ kind: 'free' as const, pos, level: 0 });
const at = (n: RoadNode) => ({ kind: 'node' as const, nodeId: n.id, pos: n.pos, level: 0 });

/** Ищет чистое поле: ни домов, ни предприятий, ни дорог, ни воды на margin вокруг отрезка длиной length. */
function fieldSpot(game: Game, length: number, margin = 180): Vec {
  const { width, height } = game.terrain;
  for (let y = 300; y < height - 300; y += 83) {
    for (let x = 300; x < width - 300 - length; x += 97) {
      const mid = { x: x + length / 2, y };
      const reach = length / 2 + margin;
      if (game.index.near(mid, reach).some((s) => dist(s.fp.center, mid) < reach + 40)) continue;
      if (game.net.segmentsNear(mid, reach).length) continue;
      let wet = false;
      for (let s = -margin; s <= length + margin && !wet; s += 20) {
        for (const dy of [-margin, -margin / 2, 0, margin / 2, margin]) if (game.isWater({ x: x + s, y: y + dy }, 10)) wet = true;
      }
      if (!wet) return { x, y };
    }
  }
  throw new Error('Нет чистого поля');
}

function build(game: Game, req: RoadRequest): RoadNode {
  const built = game.builder.build(req);
  if (!built) throw new Error(`Не построить: ${game.builder.plan(req).reason}`);
  return game.net.node(built.endNode);
}

/** Прямая улица с запада на восток в чистом поле. */
function fieldRoad(game: Game, length = 400) {
  const a = fieldSpot(game, length);
  const end = build(game, { start: free(a), end: free({ x: a.x + length, y: a.y }), spec: STREET, mode: 'straight' });
  return { a, b: end.pos, y: a.y };
}

/** Т-образный перекрёсток: улица запад — восток и ответвление на юг из середины. */
function fieldTee(game: Game) {
  const a = fieldSpot(game, 400, 220);
  const mid = build(game, { start: free(a), end: free({ x: a.x + 200, y: a.y }), spec: STREET, mode: 'straight' });
  build(game, { start: at(mid), end: free({ x: a.x + 400, y: a.y }), spec: STREET, mode: 'straight' });
  build(game, { start: at(mid), end: free({ x: a.x + 200, y: a.y + 160 }), spec: STREET, mode: 'straight' });
  return game.net.node(mid.id);
}

/** Дом (или ратуша), поставленный прямо в указанное место. */
function addHouse(game: Game, fp: Footprint, kind: TownBuilding['kind'] = 'res'): TownBuilding {
  const town = game.towns[0];
  const b: TownBuilding = {
    type: 'building',
    id: 900_000 + town.buildings.length,
    townId: town.id,
    fp,
    kind,
    floors: 2,
    anchor: town.buildings[0]?.anchor ?? 0,
    color: '#d9c9a8',
    roof: '#a0603c',
  };
  town.buildings.push(b);
  game.index.add(b);
  return b;
}

describe('Станции', () => {
  it('посты погрузки можно добавлять и убирать, они сохраняются вместе со станцией', () => {
    const game = new Game(42);
    const road = fieldRoad(game);
    const st = game.placeStation({ x: road.a.x + 200, y: road.y - 30 }, 14)!;
    expect(st).not.toBeNull();
    expect(st.bays).toBe(STATION.bays);
    const w = st.fp.w;
    const money = game.money;
    // Добавляем два поста: станция длиннее и дороже.
    expect(game.setStationBays(st.id, 5)).toBeNull();
    expect(st.bays).toBe(5);
    expect(st.fp.w).toBeCloseTo(w + 2 * STATION.bayWidth);
    expect(game.money).toBe(money - 2 * STATION.bayCost);
    // Новый край площадки — тоже станция.
    const u = { x: Math.cos(st.fp.angle), y: Math.sin(st.fp.angle) };
    const edge = add(st.fp.center, scale(u, st.fp.w / 2 - 2));
    expect(game.structureAt(edge)?.id).toBe(st.id);
    // Ctrl+Z возвращает и посты, и деньги.
    expect(game.undo()).toBe('посты станции');
    expect(st.bays).toBe(STATION.bays);
    expect(st.fp.w).toBeCloseTo(w);
    expect(game.money).toBe(money);
    expect(game.structureAt(edge)).toBeNull();
    expect(game.setStationBays(st.id, 5)).toBeNull();
    // Пределы.
    expect(game.setStationBays(st.id, STATION.maxBays + 1)).not.toBeNull();
    expect(game.setStationBays(st.id, STATION.minBays - 1)).not.toBeNull();
    expect(game.setStationBays(st.id, STATION.maxBays)).toBeNull();
    // Убираем пост — часть денег возвращается.
    const before = game.money;
    expect(game.setStationBays(st.id, STATION.maxBays - 1)).toBeNull();
    expect(game.money).toBeGreaterThan(before);
    expect(st.fp.w).toBeCloseTo(w + (STATION.maxBays - 1 - STATION.bays) * STATION.bayWidth);

    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    const ls = loaded.stations.get(st.id)!;
    expect(ls.bays).toBe(STATION.maxBays - 1);
    expect(ls.fp.w).toBeCloseTo(st.fp.w);
    expect(loaded.structureAt(add(ls.fp.center, scale(u, ls.fp.w / 2 - 2)))?.id).toBe(st.id);
    expect(loaded.setStationBays(st.id, STATION.maxBays)).toBeNull();
  });

  it('станция не растёт, если мешает дом, и называет причину', () => {
    const game = new Game(42);
    const road = fieldRoad(game);
    const st = game.placeStation({ x: road.a.x + 200, y: road.y - 30 }, 14)!;
    const u = { x: Math.cos(st.fp.angle), y: Math.sin(st.fp.angle) };
    addHouse(game, { center: add(st.fp.center, scale(u, st.fp.w / 2 + 8)), w: 8, h: 8, angle: st.fp.angle });
    const money = game.money;
    const plan = game.stationBaysPlan(st.id, st.bays + 1);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('Мешает здание');
    expect(game.setStationBays(st.id, st.bays + 1)).toBe('Мешает здание');
    expect(st.bays).toBe(STATION.bays);
    expect(game.money).toBe(money);
    // Убрать пост можно всегда.
    expect(game.setStationBays(st.id, st.bays - 1)).toBeNull();
  });

  it('с бóльшим числом постов грузится больше машин одновременно', () => {
    const game = new Game(42);
    const road = fieldRoad(game, 500);
    const a = game.placeStation({ x: road.a.x + 120, y: road.y - 30 }, 14)!;
    const b = game.placeStation({ x: road.a.x + 380, y: road.y - 30 }, 14)!;
    const line = game.createLine([a.id, b.id])!;
    expect(line).not.toBeNull();
    // На второй остановке автобусы ждут полной загрузки, а пассажиров в поле нет — стоят на постах.
    game.setStopRule(line.id, 1, { ...DEFAULT_RULE, wait: 'full', maxWait: null });
    for (let i = 0; i < 6; i++) expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    runSeconds(game, 60);
    expect(b.occupied.length).toBe(STATION.bays);
    expect(game.setStationBays(b.id, 5)).toBeNull();
    runSeconds(game, 20);
    expect(b.occupied.length).toBe(5);
  }, 20_000);

  it('у перекрёстка выезд станции примыкает прямо к узлу', () => {
    const game = new Game(42);
    const tee = fieldTee(game);
    expect(tee.segments).toHaveLength(3);
    // Курсор над перекрёстком с северной стороны: выезд напротив ответвления на юг.
    const p = { x: tee.pos.x, y: tee.pos.y - 20 };
    const plan = game.stationPlan(p, 14);
    expect(plan.ok).toBe(true);
    expect(plan.request?.start).toMatchObject({ kind: 'node', nodeId: tee.id });
    expect(plan.driveway?.plan.lut).toBeTruthy();
    const st = game.placeStation(p, 14)!;
    expect(st).not.toBeNull();
    expect(game.net.segmentBetween(tee.id, st.nodeId)).not.toBeNull();
    expect(game.net.node(tee.id).segments).toHaveLength(4);
    // Станция к северу от перекрёстка, ровно напротив ответвления.
    expect(st.fp.center.y).toBeLessThan(tee.pos.y - 30);
    expect(Math.abs(st.fp.center.x - tee.pos.x)).toBeLessThan(1);
  });

  it('курсор у самого перекрёстка вдоль дороги — тоже примыкание к узлу, а не отказ', () => {
    const game = new Game(42);
    const tee = fieldTee(game);
    // Вдоль дороги на восток, но в 20 м от перекрёстка: раньше здесь было «Слишком близко к перекрёстку».
    const north = game.stationPlan({ x: tee.pos.x + 20, y: tee.pos.y - 30 }, 14);
    expect(north.ok).toBe(true);
    expect(north.request?.start).toMatchObject({ kind: 'node', nodeId: tee.id });
    expect(Math.abs(north.fp!.center.x - tee.pos.x)).toBeLessThan(1);
    // Курсор между дорогой на восток и ответвлением на юг — выезд по диагонали в этот промежуток.
    const p = { x: tee.pos.x + 15, y: tee.pos.y + 15 };
    const plan = game.stationPlan(p, 14);
    expect(plan.ok).toBe(true);
    expect(plan.request?.start).toMatchObject({ kind: 'node', nodeId: tee.id });
    expect(plan.fp!.center.x).toBeGreaterThan(tee.pos.x + 20);
    expect(plan.fp!.center.y).toBeGreaterThan(tee.pos.y + 20);
    const st = game.placeStation(p, 14)!;
    expect(game.net.segmentBetween(tee.id, st.nodeId)).not.toBeNull();
  });

  it('дом на месте станции сносится за доплату, а Ctrl+Z его возвращает', () => {
    const game = new Game(42);
    const road = fieldRoad(game);
    const p = { x: road.a.x + 200, y: road.y - 30 };
    const clean = game.stationPlan(p, 14);
    expect(clean.ok).toBe(true);
    const house = addHouse(game, { center: clean.fp!.center, w: 12, h: 8, angle: clean.fp!.angle });
    const plan = game.stationPlan(p, 14);
    expect(plan.ok).toBe(true);
    expect(plan.demolish).toContain(house.id);
    expect(plan.cost).toBe(clean.cost + game.demolishCost(house.id));
    const money = game.money;
    game.checkpoint('станция');
    const st = game.placeStation(p, 14);
    game.commit();
    expect(st).not.toBeNull();
    expect(game.buildingById(house.id)).toBeUndefined();
    expect(game.money).toBe(money - plan.cost);
    // Отмена: станции нет, дом на месте, деньги вернулись.
    expect(game.undo()).not.toBeNull();
    expect(game.stations.has(st!.id)).toBe(false);
    expect(game.buildingById(house.id)).toBeDefined();
    expect(game.money).toBe(money);
  });

  it('ратуша по-прежнему мешает: её не сносим', () => {
    const game = new Game(42);
    const road = fieldRoad(game);
    const p = { x: road.a.x + 200, y: road.y - 30 };
    const clean = game.stationPlan(p, 14);
    addHouse(game, { center: clean.fp!.center, w: 14, h: 14, angle: 0 }, 'landmark');
    const plan = game.stationPlan(p, 14);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('Мешает ратуша');
    expect(game.placeStation(p, 14)).toBeNull();
  });

  it('дом на месте площадки у предприятия тоже идёт под снос', () => {
    const game = new Game(42);
    let checked = 0;
    for (const ind of game.industries) {
      for (const k of [0, 1, 2, 3]) {
        const a = ind.fp.angle + (k * Math.PI) / 2;
        const reach = (k % 2 ? ind.fp.h : ind.fp.w) / 2 + 30;
        const p = { x: ind.fp.center.x + Math.cos(a) * reach, y: ind.fp.center.y + Math.sin(a) * reach };
        const clean = game.stationPlan(p, 14);
        if (!clean.ok || clean.industryId !== ind.id) continue;
        const house = addHouse(game, { center: clean.fp!.center, w: 8, h: 8, angle: clean.fp!.angle });
        const plan = game.stationPlan(p, 14);
        expect(plan.ok).toBe(true);
        expect(plan.demolish).toContain(house.id);
        const st = game.placeStation(p, 14)!;
        expect(st.industryId).toBe(ind.id);
        expect(game.buildingById(house.id)).toBeUndefined();
        checked++;
        break;
      }
      if (checked) break;
    }
    expect(checked).toBe(1);
  });
});
