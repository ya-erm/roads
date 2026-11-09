import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH, STOP, TERM_SCALE } from '../config';
import { dist } from '../core/vec';
import { RoadTools } from '../input/roadtools';
import { twoWay } from '../lanes/model';
import type { Station, TownBuilding } from '../world/entities';
import { halfAtS } from '../world/worldgen';
import { Game } from './game';
import { clearStrip, freshGame, road, townStreets } from './testkit';

const STREET_SPEC = { cls: 'street' as const, lanesF: 1, lanesB: 1 };

/** Остановки на улицах крупнейшего города — не ближе minGap друг к другу. */
function placeStops(game: Game, count: number, minGap = 350): Station[] {
  const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
  const placed: Station[] = [];
  for (const seg of townStreets(game, town.id)) {
    if (placed.length >= count) break;
    if (seg.length < 80) continue;
    const p = seg.lut.pointAt(seg.length / 2);
    const t = seg.lut.tangentAt(seg.length / 2);
    const q = { x: p.x - t.y * 14, y: p.y + t.x * 14 };
    if (placed.some((s) => dist(s.fp.center, q) < minGap)) continue;
    const st = game.placeStation(q, 14, 'stop');
    if (st) placed.push(st);
  }
  return placed;
}

describe('Автобусные остановки', { timeout: 60_000 }, () => {
  it('маршрут по остановкам на улицах приносит доход; грузовики к остановкам не ездят', () => {
    const game = freshGame(7);
    game.money = 5_000_000;
    const corridorsBefore = game.roads.net.corridors.size;
    const stops = placeStops(game, 3);
    expect(stops).toHaveLength(3);
    // Остановка — стык прямо на улице: улица разрезана, заезда нет.
    expect(game.roads.net.corridors.size).toBe(corridorsBefore + 3);
    for (const st of stops) {
      expect(st.kind).toBe('stop');
      expect(st.serves).toEqual({ pax: true, cargo: false });
      expect(game.roads.net.node(st.nodeId).kind).toBe('seam');
      expect(st.name).toMatch(/ост\. \d/);
    }
    const line = game.createLine(stops.map((s) => s.id))!;
    expect(line).not.toBeNull();
    // С интервалом второй автобус набирает пассажиров на первой остановке и успевает довезти их за 2 мин.
    game.setLineSpacing(line.id, true);
    expect(game.buyVehicle(line.id, 'truck')).toBeNull();
    expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    // Первый доход — не позже чем за 2 мин: дальше ждать незачем.
    game.speed = 1;
    for (let t = 0; t < TERM_SCALE * MONTH_LENGTH + 0.1 && line.revenueTotal <= 0; t += 0.1) game.update(0.1);
    expect(line.revenueTotal).toBeGreaterThan(0);
    expect(line.problem).toBeNull();
    // Сохранение — с остановками.
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect([...loaded.stations.values()].filter((s) => s.kind === 'stop')).toHaveLength(3);
    // Снос остановки (без маршрута) улицу не трогает.
    game.deleteLine(line.id);
    const corridors = game.roads.net.corridors.size;
    expect(game.removeStation(stops[0])).toBe(true);
    expect(game.roads.net.corridors.size).toBe(corridors);
  });

  it('автобус на остановке стоит на дороге — его видно и можно выбрать — и едет дальше оттуда же, не появляясь заново', () => {
    const game = freshGame(7);
    game.money = 5_000_000;
    const stops = placeStops(game, 2);
    const line = game.createLine(stops.map((s) => s.id))!;
    expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    const bus = game.fleet.get(line.vehicles[0])!;
    let dwellSim: number | null = null;
    let continued = false;
    // Новый автобус ждёт первого рейса «в депо» у первой остановки — смотрим с первой поездки.
    let drove = false;
    game.speed = 1;
    for (let t = 0; t < 2 * MONTH_LENGTH && !continued; t += 0.1) {
      game.update(0.1);
      drove ||= bus.state === 'driving';
      const st = game.stations.get(line.stops[bus.stop])!;
      if (drove && bus.state === 'loading' && st.kind === 'stop') {
        const sim = game.fleetSim(bus);
        expect(sim).toBeDefined();
        // Центр автобуса (pos — его нос) — напротив остановки: вдоль улицы почти ноль, поперёк — его полоса.
        const center = { x: sim!.pos.x - (sim!.dir.x * sim!.length) / 2, y: sim!.pos.y - (sim!.dir.y * sim!.length) / 2 };
        const node = game.roads.net.node(st.nodeId).pos;
        const along = Math.abs((center.x - node.x) * sim!.dir.x + (center.y - node.y) * sim!.dir.y);
        expect(along).toBeLessThan(2);
        expect(game.vehicleAt(sim!.pos)?.fleet?.id).toBe(bus.id);
        dwellSim = sim!.id;
      } else if (dwellSim !== null && bus.state === 'driving') {
        expect(bus.simId).toBe(dwellSim);
        continued = true;
      }
    }
    expect(continued).toBe(true);
    expect(line.problem).toBeNull();
  });

  it('остановки и автостанции — в одном маршруте; рядом с остановкой вторую не поставить', () => {
    const game = freshGame(7);
    game.money = 5_000_000;
    const [stop] = placeStops(game, 1);
    const near = game.stationPlan({ x: stop.fp.center.x + 10, y: stop.fp.center.y }, 14, 'stop');
    expect(near.ok).toBe(false);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    let station: Station | null = null;
    for (const seg of townStreets(game, town.id)) {
      const p = seg.lut.pointAt(seg.length / 2);
      const t = seg.lut.tangentAt(seg.length / 2);
      if (dist(p, stop.fp.center) < 300) continue;
      station = game.placeStation({ x: p.x - t.y * 40, y: p.y + t.x * 40 }, 14);
      if (station) break;
    }
    expect(station).not.toBeNull();
    expect(game.lineProblem([stop.id, station!.id])).toBeNull();
    expect(game.createLine([stop.id, station!.id])).not.toBeNull();
  });

  it('станцию можно переименовать: пробелы обрезаются, пустое имя не принимается, имя переживает загрузку', () => {
    const game = freshGame(7);
    game.money = 5_000_000;
    const [a, b, c] = placeStops(game, 3);
    const auto = game.createLine([a.id, b.id])!;
    const own = game.createLine([a.id, c.id])!;
    game.renameLine(own.id, 'Кольцевая');
    expect(auto.name).toBe(`${a.name} — ${b.name}`);
    game.renameStation(a.id, '  Рынок  ');
    expect(game.stations.get(a.id)!.name).toBe('Рынок');
    // Пустое имя — остаётся прежнее; слишком длинное обрезается.
    game.renameStation(a.id, '   ');
    expect(a.name).toBe('Рынок');
    game.renameStation(c.id, 'Очень длинное название остановки у самого рынка');
    expect(c.name).toHaveLength(40);
    // Название маршрута «Откуда — Куда» следует за станцией, своё название маршрута — нет.
    expect(auto.name).toBe(`Рынок — ${b.name}`);
    expect(own.name).toBe('Кольцевая');
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.stations.get(a.id)!.name).toBe('Рынок');
    expect(loaded.stations.get(c.id)!.name).toBe(c.name);
    expect(loaded.lines.get(auto.id)!.name).toBe(`Рынок — ${b.name}`);
    // Несуществующая станция — ничего не происходит.
    expect(() => game.renameStation(999_999, 'Пусто')).not.toThrow();
  });

  it('где остановку не поставить, её силуэт всё равно есть — для красного предпросмотра', () => {
    const game = freshGame(7);
    const net = game.roads.net;
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    // У самого перекрёстка — навес у края улицы.
    const seg = townStreets(game, town.id).find((c) => c.length > 80 && net.node(c.a).kind === 'junction')!;
    expect(seg).toBeDefined();
    const q = seg.lut.pointAt(10);
    const t = seg.lut.tangentAt(10);
    const near = game.stationPlan({ x: q.x - t.y * 14, y: q.y + t.x * 14 }, 14, 'stop');
    expect(near.ok).toBe(false);
    expect(near.reason).toBe('Слишком близко к перекрёстку');
    expect(near.fp).toMatchObject({ w: STOP.size.w, h: STOP.size.h });
    expect(dist(near.fp!.center, q)).toBeLessThan(30);
    // Вдали от улиц — под курсором.
    let p: { x: number; y: number } | null = null;
    for (let x = 300; x < game.terrain.width - 300 && !p; x += 97) {
      for (let y = 300; y < game.terrain.height - 300 && !p; y += 83) {
        const c = { x, y };
        if (!net.corridorsNear(c, 200).length && !game.isWater(c, 20) && !game.index.near(c, 120).length) p = c;
      }
    }
    expect(p).not.toBeNull();
    const far = game.stationPlan(p!, 14, 'stop');
    expect(far.ok).toBe(false);
    expect(far.reason).toBe('Поставьте у городской улицы');
    expect(far.fp).toMatchObject({ center: p, w: STOP.size.w, h: STOP.size.h });
    expect(game.placeStation(p!, 14, 'stop')).toBeNull();
  });
});

describe('Линия автобусного маршрута на карте', { timeout: 60_000 }, () => {
  it('от остановки линия идёт дальше по улице, как автобус (разворот — в тупике), а не обратно из её узла', () => {
    const game = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    let o: { x: number; y: number } | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !o; y += 120) {
      for (let x = 300; x < game.terrain.width - 900 && !o; x += 160) {
        if (road(game, { free: { x, y } }, { free: { x: x + 800, y } })) o = { x, y };
      }
    }
    expect(o).not.toBeNull();
    const at = o!;
    // Остановки справа по ходу на восток: A у x+200, B у x+600.
    const a = game.placeStation({ x: at.x + 200, y: at.y + 14 }, 14, 'stop')!;
    const b = game.placeStation({ x: at.x + 600, y: at.y + 14 }, 14, 'stop')!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const line = game.createLine([a.id, b.id])!;
    // B → A: автобус приехал к B на восток и едет дальше — до тупика в x+800, там разворот.
    const back = game.linePolyline(line, 1)!;
    expect(Math.max(...back.map((p) => p.x))).toBeGreaterThan(at.x + 750);
  });
});

describe('Полоса у остановки («кармашек»)', { timeout: 60_000 }, () => {
  it('полоса вдоль края у остановки строится: навес отходит к новому бордюру, дом на его пути сносится, автобусы ходят', () => {
    const game = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    let o: { x: number; y: number } | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !o; y += 120) {
      for (let x = 300; x < game.terrain.width - 1100 && !o; x += 160) {
        // В чистом поле: улица ни с чем не пересекается (стартовые просёлки, дома).
        if (clearStrip(game, { x, y }, { x: x + 900, y }, 120) && road(game, { free: { x, y } }, { free: { x: x + 900, y } })) o = { x, y };
      }
    }
    expect(o).not.toBeNull();
    const at = o!;
    // Остановка посередине улицы, навес — с южной стороны (+y); вторая — для маршрута.
    const stop = game.placeStation({ x: at.x + 450, y: at.y + 14 }, 14, 'stop')!;
    const other = game.placeStation({ x: at.x + 800, y: at.y + 14 }, 14, 'stop')!;
    expect(stop).not.toBeNull();
    expect(other).not.toBeNull();
    const node = stop.nodeId;
    // Дом там, куда навес встанет у нового бордюра (на саму полосу он не заходит).
    const town = game.towns[0];
    const house: TownBuilding = {
      type: 'building',
      id: 900_000,
      townId: town.id,
      fp: { center: { x: at.x + 455, y: at.y + 24 }, w: 8, h: 6, angle: 0 },
      kind: 'res',
      floors: 2,
      anchor: 0,
      color: '#d9c9a8',
      roof: '#a0603c',
    };
    town.buildings.push(house);
    game.index.add(house);
    // «Кармашек»: полоса вдоль южного края мимо остановки. Предпросмотр: навес не мешает, дом — под снос.
    const tools = new RoadTools(() => game);
    const edge = (dx: number) => ({ x: at.x + dx, y: at.y + 10.5 });
    tools.laneDown(edge(330), 14);
    tools.laneMove(edge(450), 14);
    tools.laneMove(edge(570), 14);
    const preview = tools.lanePlan(STREET_SPEC)?.plan;
    expect(preview?.reason).toBeUndefined();
    expect(preview?.demolish).toContain(house.id);
    expect(preview?.moved).toHaveLength(1);
    expect(tools.laneUp(edge(570), 14, STREET_SPEC, true)).toBeNull();
    // Навес — у нового бордюра: кромка полосы 14 + обочина 1.5 + зазор 2 + полнавеса; узел на оси тот же.
    expect(stop.fp.center.y - at.y).toBeCloseTo(14 + 1.5 + 2 + STOP.size.h / 2, 1);
    expect(Math.abs(stop.fp.center.x - (at.x + 450))).toBeLessThan(0.5);
    expect(stop.nodeId).toBe(node);
    expect(game.roads.net.nodes.has(node)).toBe(true);
    expect(game.structureAt(stop.fp.center)?.id).toBe(stop.id);
    expect(game.buildingById(house.id)).toBeUndefined();
    // Остановка работает: автобус доезжает до неё и встаёт на посадку.
    const line = game.createLine([other.id, stop.id])!;
    expect(line).not.toBeNull();
    expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    const bus = game.fleet.get(line.vehicles[0])!;
    let visited = false;
    game.speed = 1;
    for (let t = 0; t < 2 * MONTH_LENGTH && !visited; t += 0.1) {
      game.update(0.1);
      visited = bus.state === 'loading' && line.stops[bus.stop] === stop.id;
    }
    expect(visited).toBe(true);
    expect(line.problem).toBeNull();
  });

  it('«Перестроить» улицу у остановки в проспект: навес отходит к новому бордюру, а не мешает', () => {
    const game = freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    let o: { x: number; y: number } | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !o; y += 120) {
      for (let x = 300; x < game.terrain.width - 1100 && !o; x += 160) {
        // В чистом поле: улица ни с чем не пересекается (стартовые просёлки, дома).
        if (clearStrip(game, { x, y }, { x: x + 900, y }, 120) && road(game, { free: { x, y } }, { free: { x: x + 900, y } })) o = { x, y };
      }
    }
    const at = o!;
    const stop = game.placeStation({ x: at.x + 450, y: at.y - 14 }, 14, 'stop')!;
    expect(stop).not.toBeNull();
    const tools = new RoadTools(() => game);
    // Остановка режет улицу стыком: перестроили кусок с запада — у стыка отгон к улице, навес встаёт по фактической кромке.
    expect(tools.upgrade({ x: at.x + 300, y: at.y }, { cls: 'avenue', lanesF: 2, lanesB: 2 }, 4)).toBeNull();
    expect(at.y - stop.fp.center.y).toBeGreaterThan(8.5 + 2 + STOP.size.h / 2);
    const clear = () => {
      const net = game.roads.net;
      for (let i = 0; i <= 6; i++) {
        const q = { x: stop.fp.center.x + (i / 6 - 0.5) * STOP.size.w, y: stop.fp.center.y + STOP.size.h / 2 };
        for (const c of net.corridorsNear(q, 40)) {
          const hit = c.lut.closest(q);
          expect(hit.d).toBeGreaterThan(halfAtS(c, hit.s) + 1.9);
        }
      }
    };
    clear();
    // Вся улица у остановки разом — проспект: кромка 14 + обочина 1.5 + зазор 2 + полнавеса, с северной стороны (−y).
    const ids = game.roads.net.node(stop.nodeId).corridors;
    const plan = game.roadBuilder.plan(
      (n) => {
        for (const id of ids) {
          const c = n.corridor(id);
          c.cls = 'avenue';
          n.setLanes(c, twoWay(2, 2));
        }
      },
      { shove: true },
    );
    expect(plan.reason).toBeUndefined();
    expect(plan.moved).toHaveLength(1);
    expect(game.roadBuilder.apply(plan)).toBe(true);
    for (const id of plan.changed) game.roadWidened(id);
    expect(at.y - stop.fp.center.y).toBeCloseTo(14 + 1.5 + 2 + STOP.size.h / 2, 1);
    clear();
    expect(game.roads.net.nodes.has(stop.nodeId)).toBe(true);
  });
});
