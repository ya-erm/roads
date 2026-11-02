import { describe, expect, it } from 'vitest';
import { STATION } from '../config';
import { add, dist, scale, Vec } from '../core/vec';
import type { LaneNode } from '../lanes/model';
import type { TownBuilding } from '../world/entities';
import type { Footprint } from '../world/spatial';
import { DEFAULT_RULE } from './transport';
import { Game } from './game';
import { End, roadPlan, stationExit } from './testkit';

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
});
