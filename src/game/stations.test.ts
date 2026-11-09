import { describe, expect, it } from 'vitest';
import { COST, STATION } from '../config';
import { add, dist, scale, Vec } from '../core/vec';
import { twoWay, type Corridor, type LaneNode } from '../lanes/model';
import { RoadTools } from '../input/roadtools';
import type { Station, TownBuilding } from '../world/entities';
import { ROAD_PRESETS, specKmh, type RoadSpec } from '../world/roadTypes';
import type { Footprint } from '../world/spatial';
import { fillStreet, nearHighway, type WorldContext } from '../world/worldgen';
import { DEFAULT_RULE } from './transport';
import { Game } from './game';
import { AVENUE, End, roadPlan, stationAtIndustry, stationExit, STREET, withoutCitizens } from './testkit';

const AVENUE_SPEC: RoadSpec = { cls: 'avenue', lanesF: 2, lanesB: 2 };

function runSeconds(game: Game, seconds: number) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) game.update(0.1);
}

/** Ищет чистое поле: ни домов, ни предприятий, ни дорог, ни воды на margin вокруг отрезка длиной length. */
function fieldSpot(game: Game, length: number, margin = 180): Vec {
  const { width, height } = game.terrain;
  for (let y = 300; y < height - 300; y += 83) {
    for (let x = 300; x < width - 300 - length; x += 97) {
      const mid = { x: x + length / 2, y };
      const reach = length / 2 + margin;
      if (game.index.near(mid, reach).some((s) => dist(s.fp.center, mid) < reach + 40)) continue;
      if (game.roads.net.corridorsNear(mid, reach).length || game.net.segmentsNear(mid, reach).length) continue;
      let wet = false;
      for (let s = -margin; s <= length + margin && !wet; s += 20) {
        for (const dy of [-margin, -margin / 2, 0, margin / 2, margin]) if (game.isWater({ x: x + s, y: y + dy }, 10)) wet = true;
      }
      if (!wet) return { x, y };
    }
  }
  throw new Error('Нет чистого поля');
}

/** Строит улицу и возвращает узел на её конце. */
function build(game: Game, a: End, b: Vec): LaneNode {
  const plan = roadPlan(game, a, { free: b });
  if (!plan.ok || !game.roadBuilder.apply(plan)) throw new Error(`Не построить: ${plan.reason}`);
  return game.roads.net.nodesNear(b, 2)[0];
}

/** Прямая улица с запада на восток в чистом поле. */
function fieldRoad(game: Game, length = 400) {
  const a = fieldSpot(game, length);
  const end = build(game, { free: a }, { x: a.x + length, y: a.y });
  return { a, b: end.pos, y: a.y };
}

/** Т-образный перекрёсток: улица запад — восток и ответвление на юг из середины. */
function fieldTee(game: Game) {
  const a = fieldSpot(game, 400, 220);
  const mid = build(game, { free: a }, { x: a.x + 200, y: a.y });
  build(game, mid.id, { x: a.x + 400, y: a.y });
  build(game, mid.id, { x: a.x + 200, y: a.y + 160 });
  return game.roads.net.node(mid.id);
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
    // Улица в чистом поле: машины жителей сюда не доезжают — без них счёт в разы быстрее.
    const game = withoutCitizens(new Game(42));
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
    // Каждый автобус — на своём посту, посты окрашены в цвет линии.
    const bays = () => new Set(b.occupied.map((id) => game.fleet.get(id)!.bay));
    expect(bays().size).toBe(STATION.bays);
    expect(game.stationBays(b)).toEqual(Array(STATION.bays).fill(line.color));
    expect(game.setStationBays(b.id, 5)).toBeNull();
    runSeconds(game, 20);
    expect(b.occupied.length).toBe(5);
    expect(bays()).toEqual(new Set([0, 1, 2, 3, 4]));
    // Посты сохраняются: после загрузки автобусы на тех же местах.
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.stationBays(loaded.stations.get(b.id)!)).toEqual(game.stationBays(b));
  }, 20_000);

  it('у перекрёстка выезд станции примыкает прямо к узлу', () => {
    const game = new Game(42);
    const tee = fieldTee(game);
    expect(tee.kind).toBe('junction');
    expect(tee.corridors).toHaveLength(3);
    // Курсор над перекрёстком с северной стороны: выезд напротив ответвления на юг.
    const p = { x: tee.pos.x, y: tee.pos.y - 20 };
    const plan = game.stationPlan(p, 14);
    expect(plan.ok).toBe(true);
    expect(plan.from).toMatchObject({ kind: 'node', node: tee.id });
    expect(plan.driveway?.changed.length).toBeGreaterThan(0);
    const st = game.placeStation(p, 14)!;
    expect(st).not.toBeNull();
    expect(stationExit(game, st.nodeId).id).toBe(tee.id);
    expect(game.roads.net.node(tee.id).corridors).toHaveLength(4);
    // Станция к северу от перекрёстка, ровно напротив ответвления.
    expect(st.fp.center.y).toBeLessThan(tee.pos.y - 30);
    expect(Math.abs(st.fp.center.x - tee.pos.x)).toBeLessThan(1);
  });

  it('выезд станции — сразу шоссе 1+1, 90 км/ч: у улицы, у перекрёстка и у предприятия; цена — по шоссе', () => {
    const game = new Game(42);
    game.money = 5_000_000;
    const net = () => game.roads.net;
    const shosse = ROAD_PRESETS.find((p) => p.id === 'road')!.spec;
    expect(shosse).toEqual({ cls: 'highway', lanesF: 1, lanesB: 1 });
    const expectShosse = (st: Station | null) => {
      expect(st).not.toBeNull();
      const node = net().node(st!.nodeId);
      expect(node.corridors).toHaveLength(1);
      const c = net().corridor(node.corridors[0]);
      const spec: RoadSpec = { cls: c.cls, lanesF: c.lanes.filter((l) => l.flow > 0).length, lanesB: c.lanes.filter((l) => l.flow < 0).length, limit: c.limit };
      expect(spec).toMatchObject(shosse);
      expect(specKmh(spec)).toBe(90);
    };
    // У улицы: выезд от середины полотна. Цена — станция и выезд по цене шоссе (дороже такого же выезда-улицы).
    const road = fieldRoad(game);
    const p = { x: road.a.x + 200, y: road.y - 30 };
    const plan = game.stationPlan(p, 14);
    expect(plan.ok).toBe(true);
    expect(plan.cost).toBe(COST.station + plan.driveway!.cost);
    const asStreet = game.roadBuilder.road(plan.from!, { kind: 'free', pos: plan.nodePos! }, STREET);
    expect(asStreet.ok).toBe(true);
    expect(plan.driveway!.cost).toBeGreaterThan(asStreet.cost * 1.5);
    expectShosse(game.placeStation(p, 14));
    // У перекрёстка: выезд прямо из узла.
    const tee = fieldTee(game);
    const atJunction = game.placeStation({ x: tee.pos.x, y: tee.pos.y - 20 }, 14);
    expectShosse(atJunction);
    expect(stationExit(game, atJunction!.nodeId).id).toBe(tee.id);
    // Главная дорога перекрёстка — по-прежнему улица запад — восток, а не ответвление с выездом напротив (шоссе быстрее).
    const main = game.junctionMain(tee.id);
    expect(main).not.toBeNull();
    expect(main).not.toContain(net().node(atJunction!.nodeId).corridors[0]);
    const farEnd = (id: number) => {
      const c = net().corridor(id);
      return net().node(c.a === tee.id ? c.b : c.a).pos;
    };
    for (const id of main!) expect(Math.abs(farEnd(id).y - tee.pos.y)).toBeLessThan(1);
    // У предприятия: выезд от ворот грузового двора.
    let dock: Station | null = null;
    for (const ind of game.industries) {
      dock = stationAtIndustry(game, ind, add(ind.fp.center, { x: 0, y: 300 }));
      if (dock) break;
    }
    expectShosse(dock);
    expect(dock!.industryId).not.toBeNull();
  });

  it('к перекрёстку с выездом-шоссе другой станции можно пристроить ещё одну станцию — напротив', () => {
    const game = new Game(42);
    const road = fieldRoad(game);
    const north = game.placeStation({ x: road.a.x + 200, y: road.y - 30 }, 14)!;
    const exit = stationExit(game, north.nodeId);
    expect(exit.corridors).toHaveLength(3);
    const p = { x: exit.pos.x, y: exit.pos.y + 20 };
    const plan = game.stationPlan(p, 14);
    expect(plan.reason).toBeUndefined();
    expect(plan.from).toMatchObject({ kind: 'node', node: exit.id });
    const south = game.placeStation(p, 14)!;
    expect(south.fp.center.y).toBeGreaterThan(exit.pos.y + 30);
    expect(stationExit(game, south.nodeId).id).toBe(exit.id);
  });

  it('у выезда-шоссе город застраивается, как у улицы: улица с автостанцией растёт, дома встают и рядом с выездом', () => {
    const game = new Game(42);
    const road = fieldRoad(game);
    const st = game.placeStation({ x: road.a.x + 200, y: road.y - 30 }, 14)!;
    const net = game.roads.net;
    const drivewayId = net.node(st.nodeId).corridors[0];
    const driveway = net.corridor(drivewayId);
    expect(driveway.cls).toBe('highway');
    const halves = stationExit(game, st.nodeId)
      .corridors.filter((id) => id !== drivewayId)
      .map((id) => net.corridor(id));
    expect(halves).toHaveLength(2);
    const ctx = (game as unknown as { worldContext(): WorldContext }).worldContext();
    const streetLike = (c: Corridor) => (game as unknown as { streetLike(c: Corridor): boolean }).streetLike(c);
    for (const c of halves) {
      // Шоссе в узле делает улицу «частью магистрали» — но выезд станции не в счёт: город вдоль неё растёт.
      expect(nearHighway(net, c)).toBe(true);
      expect(nearHighway(net, c, ctx.driveways)).toBe(false);
      expect(streetLike(c)).toBe(true);
    }
    // Дома встают и в паре десятков метров от выезда (от магистрали — не ближе 50 м от края).
    const town = game.towns[0];
    const before = new Set(town.buildings.map((b) => b.id));
    for (const c of halves) fillStreet(ctx, town, c, 1);
    const added = town.buildings.filter((b) => !before.has(b.id));
    expect(added.length).toBeGreaterThan(0);
    expect(Math.min(...added.map((b) => driveway.lut.closest(b.fp.center).d))).toBeLessThan(50);
  });

  it('курсор у самого перекрёстка вдоль дороги — тоже примыкание к узлу, а не отказ', () => {
    const game = new Game(42);
    const tee = fieldTee(game);
    // Вдоль дороги на восток, но в 20 м от перекрёстка: раньше здесь было «Слишком близко к перекрёстку».
    const north = game.stationPlan({ x: tee.pos.x + 20, y: tee.pos.y - 30 }, 14);
    expect(north.ok).toBe(true);
    expect(north.from).toMatchObject({ kind: 'node', node: tee.id });
    expect(Math.abs(north.fp!.center.x - tee.pos.x)).toBeLessThan(1);
    // Курсор между дорогой на восток и ответвлением на юг — выезд по диагонали в этот промежуток.
    const p = { x: tee.pos.x + 15, y: tee.pos.y + 15 };
    const plan = game.stationPlan(p, 14);
    expect(plan.ok).toBe(true);
    expect(plan.from).toMatchObject({ kind: 'node', node: tee.id });
    expect(plan.fp!.center.x).toBeGreaterThan(tee.pos.x + 20);
    expect(plan.fp!.center.y).toBeGreaterThan(tee.pos.y + 20);
    const st = game.placeStation(p, 14)!;
    expect(stationExit(game, st.nodeId).id).toBe(tee.id);
  });

  it('где станцию не поставить, её силуэт всё равно есть — для красного предпросмотра', () => {
    const game = new Game(42);
    // В чистом поле — под курсором.
    const spot = fieldSpot(game, 200, 300);
    const p = { x: spot.x + 100, y: spot.y };
    const far = game.stationPlan(p, 14);
    expect(far.ok).toBe(false);
    expect(far.reason).toBe('Поставьте рядом с дорогой');
    expect(far.fp).toMatchObject({ center: p, w: STATION.size.w, h: STATION.size.h });
    expect(game.placeStation(p, 14)).toBeNull();
    // У стыка остановки посреди улицы — у дороги со стороны курсора (к югу).
    const road = fieldRoad(game);
    const stop = game.placeStation({ x: road.a.x + 200, y: road.y - 14 }, 14, 'stop')!;
    expect(stop).not.toBeNull();
    const q = { x: road.a.x + 205, y: road.y + 30 };
    const seam = game.stationPlan(q, 14);
    expect(seam.ok).toBe(false);
    expect(seam.reason).toBe('Слишком близко к перекрёстку');
    expect(seam.fp!.center.y).toBeGreaterThan(road.y + 20);
    expect(Math.abs(seam.fp!.center.x - q.x)).toBeLessThan(10);
    expect(game.placeStation(q, 14)).toBeNull();
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

  it('выезд станции перестраивается в проспект: своя станция не мешает, чужое здание — мешает', () => {
    const game = new Game(42);
    game.money = 5_000_000;
    const tools = new RoadTools(() => game);
    const net = () => game.roads.net;
    const driveway = (st: { nodeId: number }) => net().corridor(net().node(st.nodeId).corridors[0]);
    // Станция у дороги: расширенный выезд у ворот заходит в контур станции.
    const road = fieldRoad(game);
    const st = game.placeStation({ x: road.a.x + 200, y: road.y - 30 }, 14)!;
    const c = driveway(st);
    expect(stationExit(game, st.nodeId).id).not.toBe(st.nodeId);
    expect(tools.upgradePlan(c.lut.pointAt(c.length / 2), AVENUE_SPEC, 4)?.plan.reason).toBeUndefined();
    expect(tools.upgrade(c.lut.pointAt(c.length / 2), AVENUE_SPEC, 4)).toBeNull();
    expect(driveway(st).cls).toBe('avenue');
    expect(driveway(st).lanes).toHaveLength(4);
    expect(game.stations.has(st.id)).toBe(true);
    // Станция у предприятия (как у лесопилки): выезд от ворот грузового двора.
    let checked = 0;
    for (const ind of game.industries) {
      for (const k of [0, 1, 2, 3]) {
        const a = ind.fp.angle + (k * Math.PI) / 2;
        const reach = (k % 2 ? ind.fp.h : ind.fp.w) / 2 + 30;
        const p = { x: ind.fp.center.x + Math.cos(a) * reach, y: ind.fp.center.y + Math.sin(a) * reach };
        const plan = game.stationPlan(p, 14);
        if (!plan.ok || plan.industryId !== ind.id) continue;
        const dock = game.placeStation(p, 14)!;
        const d = driveway(dock);
        expect(tools.upgrade(d.lut.pointAt(d.length / 2), AVENUE_SPEC, 4)).toBeNull();
        expect(driveway(dock).cls).toBe('avenue');
        checked++;
        break;
      }
      if (checked) break;
    }
    expect(checked).toBe(1);
    // Ратуша у выезда другой станции по-прежнему мешает расширению.
    const other = fieldRoad(game);
    const st2 = game.placeStation({ x: other.a.x + 200, y: other.y - 30 }, 14)!;
    const c2 = driveway(st2);
    const mid = c2.lut.pointAt(c2.length / 2);
    const t = c2.lut.tangentAt(c2.length / 2);
    addHouse(game, { center: add(mid, scale({ x: -t.y, y: t.x }, 13)), w: 6, h: 6, angle: 0 }, 'landmark');
    expect(tools.upgrade(mid, AVENUE_SPEC, 4)).toBe('Мешает здание');
    expect(driveway(st2).cls).toBe('highway');
  });

  it('у широкой дороги станция прилипает: у проспекта ставится, у магистрали — силуэт с понятной причиной', () => {
    const game = new Game(42);
    game.money = 5_000_000;
    // Проспект 2+2: курсор в 45 от оси (≈30 от края) — раньше «Поставьте рядом с дорогой».
    const a = fieldSpot(game, 400);
    const avenue = roadPlan(game, { free: a }, { free: { x: a.x + 400, y: a.y } }, AVENUE);
    expect(avenue.ok).toBe(true);
    game.roadBuilder.apply(avenue);
    const p = { x: a.x + 200, y: a.y - 45 };
    expect(game.stationPlan(p, 14).reason).toBeUndefined();
    const st = game.placeStation(p, 14)!;
    expect(st).not.toBeNull();
    expect(st.fp.center.y).toBeLessThan(a.y - 40);
    const net = game.roads.net;
    expect(stationExit(game, st.nodeId).corridors.map((id) => net.corridor(id).cls)).toContain('avenue');
    // Магистраль: выезд к ней не пристроить (вдоль быстрых дорог станций нет), но силуэт — у дороги, причина — про магистраль.
    const b = fieldSpot(game, 400);
    const highway = roadPlan(game, { free: b }, { free: { x: b.x + 400, y: b.y } }, { cls: 'highway', lanes: twoWay(2, 2) });
    expect(highway.ok).toBe(true);
    game.roadBuilder.apply(highway);
    const q = { x: b.x + 200, y: b.y - 45 };
    const plan = game.stationPlan(q, 14);
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe('К магистрали станцию не пристроить');
    expect(Math.abs(plan.fp!.center.x - q.x)).toBeLessThan(2);
    expect(plan.fp!.center.y).toBeLessThan(b.y - 40);
    expect(game.placeStation(q, 14)).toBeNull();
  });
});

describe('Машины в пути и сохранение', () => {
  it('после загрузки машина в пути едет дальше с того же места, а не со станции', () => {
    const game = new Game(42);
    const road = fieldRoad(game, 500);
    const a = game.placeStation({ x: road.a.x + 120, y: road.y - 30 }, 14)!;
    const b = game.placeStation({ x: road.a.x + 380, y: road.y - 30 }, 14)!;
    const line = game.createLine([a.id, b.id])!;
    for (const i of [0, 1]) game.setStopRule(line.id, i, { ...DEFAULT_RULE, wait: 'none' });
    const v = game.buyVehicle(line.id, 'bus')!;
    const reload = () => new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    game.speed = 1;
    let checks = 0;
    let midway: Game | null = null;
    for (let step = 1; step < 1200 && checks < 8; step++) {
      game.update(0.1);
      const sim = game.fleetSim(v);
      // Раз в полторы секунды пути — сохраняем и загружаем.
      if (!sim || step % 15) continue;
      const loaded = reload();
      const lv = loaded.fleet.get(v.id)!;
      const ls = loaded.fleetSim(lv);
      expect(lv.state).toBe('driving');
      expect(lv.stop).toBe(v.stop);
      expect(ls).toBeDefined();
      // На манёвре в узле машина встаёт в начало полосы выезда из него — чуть впереди (налево с выезда станции
      // через встречную — манёвр длиной ~28 м).
      expect(dist(ls!.pos, sim.pos)).toBeLessThan(sim.onMovement ? 30 : 3);
      expect(ls!.v).toBeCloseTo(sim.v);
      if (!midway && !sim.onMovement && dist(sim.pos, a.fp.center) > 100 && dist(sim.pos, b.fp.center) > 100) midway = loaded;
      checks++;
    }
    expect(checks).toBe(8);
    expect(midway).not.toBeNull();
    // Загруженная с полпути — доезжает до своей станции и заезжает на пост.
    const lv = midway!.fleet.get(v.id)!;
    const target = midway!.stations.get(midway!.lines.get(line.id)!.stops[lv.stop])!;
    for (let t = 0; t < 60 && lv.state === 'driving'; t += 0.1) midway!.update(0.1);
    expect(lv.state).toBe('loading');
    expect(target.occupied).toContain(lv.id);

    // Старое сохранение без места на дороге — как раньше: машина снова отправляется со станции.
    for (let t = 0; t < 30 && !game.fleetSim(v); t += 0.1) game.update(0.1);
    const old = JSON.parse(JSON.stringify(game.toSave()));
    for (const f of old.fleet) delete f.onRoad;
    const loaded = new Game(game.settings, old);
    expect(loaded.fleet.get(v.id)!.state).toBe('departing');
    expect(loaded.traffic.vehicles.size).toBe(0);
  }, 30_000);
});

describe('Перенос станции', { timeout: 60_000 }, () => {
  /** Бежит, пока машина v не встанет на посадку на станции st после того, как поездила; true — встала. */
  function untilLoadingAt(game: Game, vid: number, stId: number, seconds = 400): boolean {
    const v = game.fleet.get(vid)!;
    let drove = false;
    game.speed = 1;
    for (let t = 0; t < seconds; t += 0.1) {
      game.update(0.1);
      drove ||= v.state === 'driving';
      const line = game.lines.get(v.lineId)!;
      if (drove && v.state === 'loading' && line.stops[v.stop] === stId) return true;
    }
    return false;
  }

  it('остановка переезжает на другую улицу: имя, пассажиры и маршрут те же, автобус доезжает до нового места; Ctrl+Z возвращает', () => {
    // Улицы в чистом поле: машины жителей сюда не доезжают — без них счёт в разы быстрее.
    const game = withoutCitizens(new Game(42));
    game.money = 5_000_000;
    const road = fieldRoad(game, 600);
    // Улица на юг из середины — туда перенесём остановку.
    build(game, { x: road.a.x + 300, y: road.y }, { x: road.a.x + 300, y: road.y + 300 });
    const s1 = game.placeStation({ x: road.a.x + 120, y: road.y - 14 }, 14, 'stop')!;
    const s2 = game.placeStation({ x: road.a.x + 500, y: road.y - 14 }, 14, 'stop')!;
    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    const line = game.createLine([s1.id, s2.id])!;
    expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    s1.passengers.set(s2.id, 7);
    const name = s1.name;
    const fp0 = { ...s1.fp, center: { ...s1.fp.center } };
    const node0 = s1.nodeId;
    const to = { x: road.a.x + 314, y: road.y + 150 };
    const plan = game.stationMovePlan(s1.id, to, 14);
    expect(plan.ok).toBe(true);
    const money = game.money;
    game.checkpoint('перенос станции');
    expect(game.moveStation(s1.id, to, 14)).toBeNull();
    game.commit();
    expect(game.money).toBe(money - plan.cost);
    // Та же станция: id, имя, ожидающие, маршрут; навес — у южной улицы.
    expect(game.stations.get(s1.id)).toBe(s1);
    expect(s1.name).toBe(name);
    expect(s1.passengers.get(s2.id)).toBe(7);
    expect(line.stops).toEqual([s1.id, s2.id]);
    expect(dist(s1.fp.center, to)).toBeLessThan(10);
    expect(s1.nodeId).not.toBe(node0);
    expect(game.structureAt(fp0.center)).toBeNull();
    expect(game.structureAt(s1.fp.center)?.id).toBe(s1.id);
    // Автобус доезжает до нового места и стоит у него.
    expect(untilLoadingAt(game, line.vehicles[0], s1.id)).toBe(true);
    const sim = game.fleetSim(game.fleet.get(line.vehicles[0])!);
    expect(sim).toBeDefined();
    expect(dist(sim!.pos, game.roads.net.node(s1.nodeId).pos)).toBeLessThan(15);
    expect(line.problem).toBeNull();
    // Отмена — на старом месте, с прежним узлом.
    expect(game.undo()).toBe('перенос станции');
    expect(s1.fp.center).toEqual(fp0.center);
    expect(s1.nodeId).toBe(node0);
    expect(game.structureAt(fp0.center)?.id).toBe(s1.id);
  });

  it('станция у предприятия переезжает на другую его сторону: груз и посты те же, грузовики ездят; Ctrl+Z возвращает', () => {
    const game = new Game(42);
    game.money = 5_000_000;
    const net = () => game.roads.net;
    let done = false;
    for (const ind of game.industries) {
      const u = { x: Math.cos(ind.fp.angle), y: Math.sin(ind.fp.angle) };
      const v = { x: -u.y, y: u.x };
      const side = (n: Vec, half: number, k: number) => add(ind.fp.center, scale(n, half + k));
      const east = side(u, ind.fp.w / 2, 30);
      const south = side(v, ind.fp.h / 2, 30);
      if (!game.stationPlan(east, 14).ok || game.stationPlan(east, 14).industryId !== ind.id) continue;
      const dock = game.placeStation(east, 14)!;
      const exit = stationExit(game, dock.nodeId);
      // Дорога от выезда на восток (там вторая станция) и в обход угла с юга — тупиком к месту выезда с южной стороны,
      // чтобы новый выезд продолжал её прямо.
      const far = add(exit.pos, scale(u, 260));
      const corner = { ...STREET, kink: true };
      const low = ind.fp.h / 2 + 110;
      const path = [add(exit.pos, scale(v, low)), add(ind.fp.center, scale(v, low)), side(v, ind.fp.h / 2, 64)];
      let from: End = exit.id;
      let ok = roadPlan(game, exit.id, { free: far }).ok;
      if (ok) build(game, exit.id, far);
      for (const q of path) {
        const plan = ok ? roadPlan(game, from, { free: q }, corner) : null;
        ok = !!plan?.ok && game.roadBuilder.apply(plan);
        if (ok) from = net().nodesNear(q, 2)[0].id;
      }
      const other = ok ? game.placeStation(add(add(exit.pos, scale(u, 180)), scale(v, -30)), 14) : null;
      if (!other || !game.stationMovePlan(dock.id, south, 14).ok) continue;
      const line = game.createLine([dock.id, other.id])!;
      expect(line).not.toBeNull();
      expect(game.buyVehicle(line.id, 'truck')).not.toBeNull();
      expect(game.setStationBays(dock.id, 4)).toBeNull();
      dock.cargo = { ...dock.cargo, wood: 5 } as typeof dock.cargo;
      const fp0 = { ...dock.fp, center: { ...dock.fp.center } };
      const node0 = dock.nodeId;
      game.checkpoint('перенос станции');
      expect(game.moveStation(dock.id, south, 14)).toBeNull();
      game.commit();
      // На южной стороне того же предприятия, посты и груз — при ней.
      expect(dock.industryId).toBe(ind.id);
      expect(dock.bays).toBe(4);
      expect(dock.cargo).toMatchObject({ wood: 5 });
      expect(dist(dock.fp.center, ind.fp.center)).toBeLessThan(ind.fp.h / 2 + 30);
      expect(net().nodes.has(node0)).toBe(false);
      // Грузовик заезжает на новый двор.
      expect(untilLoadingAt(game, line.vehicles[0], dock.id)).toBe(true);
      expect(line.problem).toBeNull();
      expect(game.undo()).toBe('перенос станции');
      expect(dock.fp.center).toEqual(fp0.center);
      expect(dock.nodeId).toBe(node0);
      expect(net().nodes.has(node0)).toBe(true);
      done = true;
      break;
    }
    expect(done).toBe(true);
  });
});
