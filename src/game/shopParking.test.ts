import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { dist, dot, sub } from '../core/vec';
import type { Town, TownBuilding } from '../world/entities';
import { CAR_SIZE } from '../world/houseAccess';
import { Game, type SaveData } from './game';
import type { GarageSlot } from './garages';
import { SHOP_PARKING, stallKey, type ShopVisit } from './shopParking';
import { freshGame, runSeconds, withoutCitizens } from './testkit';

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#3f74b5' };
const WORLD: [number, number, number, number] = [-1e6, -1e6, 1e6, 1e6];
const step = (game: Game) => game.update(SIM_DT);

/** Магазин со стоянкой, к которой можно подъехать всеми местами одной полосы, — первый подходящий; стоянка пустая. */
function shopLot(game: Game, minStalls = 2): { town: Town; b: TownBuilding; visit: ShopVisit } {
  for (const town of game.towns)
    for (const b of town.buildings) {
      const lot = b.kind === 'com' ? game.shops.lotOf(b) : null;
      if (!lot || lot.spots.length < minStalls) continue;
      const slots = lot.spots.map((s) => game.garages.slotOf(s));
      if (slots.some((s) => !s || s.lane.id !== slots[0]!.lane.id)) continue;
      town.shopParked = (town.shopParked ?? []).filter((c) => c.b !== b.id);
      const mid = Math.floor(lot.spots.length / 2);
      return { town, b, visit: { town, lot, planned: lot.spots[mid], slot: slots[mid] as GarageSlot, n: 1 } };
    }
  throw new Error('нет магазина со стоянкой');
}

/** Машина едет на стоянку: от начала связи у неё, как машина жителя (в счёте машин жителей). */
function drive(game: Game, visit: ShopVisit) {
  const route = game.garages.routeHome(visit.slot.link.fromNode!, visit.slot)!;
  const sim = game.traffic.spawn({ ...CAR, targetNode: visit.slot.link.toNode!, route })!;
  game.citizenCars++;
  game.shops.start(sim, visit);
  return sim;
}

describe('Стоянки магазинов', { timeout: 120_000 }, () => {
  it('в начале партии на стоянках 0–2 машины, на местах, носом от улицы; видны вблизи', () => {
    const game = freshGame(7);
    let lots = 0;
    let cars = 0;
    for (const t of game.towns) {
      expect(t.shopParked).toBeDefined();
      const by = new Map<number, number>();
      for (const c of t.shopParked!) by.set(c.b, (by.get(c.b) ?? 0) + 1);
      for (const n of by.values()) expect(n).toBeLessThanOrEqual(SHOP_PARKING.startMax);
      lots += t.buildings.filter((b) => b.kind === 'com' && game.shops.lotOf(b)).length;
      cars += t.shopParked!.length;
      // Два машины на одном месте не стоят.
      expect(new Set(t.shopParked!.map((c) => `${c.b}:${c.k}`)).size).toBe(t.shopParked!.length);
    }
    // В среднем — по машине на стоянку.
    expect(cars / lots).toBeGreaterThan(0.6);
    expect(cars / lots).toBeLessThan(1.4);
    const looks = game.shops.looks(game.towns, WORLD, true);
    expect(looks.length).toBe(cars);
    expect(game.shops.looks(game.towns, WORLD, false).length).toBe(0);
    // Машина на месте — целиком в своём месте: нос до упора, по ширине — с запасом.
    const t = game.towns.find((x) => x.shopParked!.length)!;
    const car = t.shopParked![0];
    const lot = game.shops.lotOf(t.buildings.find((b) => b.id === car.b)!)!;
    const spot = lot.spots[car.k];
    const look = looks.find((l) => dist(l.look.pos, spot.d.gate) < CAR_SIZE.l)!;
    expect(look).toBeDefined();
    expect(dot(look.look.dir, spot.d.dir)).toBeGreaterThan(0.999);
    expect(dot(sub(spot.d.gate, look.look.pos), spot.d.dir)).toBeGreaterThan(0.3);
    expect(spot.d.width - CAR_SIZE.w).toBeGreaterThanOrEqual(0.6 - 1e-9);
  });

  it('машина подъезжает, с поворотником сворачивает на свободное место передом, стоит 1–4 минуты, выезжает задним ходом и уезжает', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, b, visit } = shopLot(game);
    const sim = drive(game, visit);
    const color = sim.color;
    const arrivals = game.traffic.arrivals;
    let blinked = false;
    let turned = false;
    let parkedAt = -1;
    for (let i = 0; i < 30 * 90 && parkedAt < 0; i++) {
      step(game);
      if (sim.holdDist !== undefined && sim.blinker) blinked = true;
      if (visit.lot.spots.some((s) => game.garages.moveOf(s.key)?.kind === 'in')) turned = true;
      if (game.shops.parkedAt(town, b.id).length) parkedAt = game.time;
    }
    expect(blinked).toBe(true);
    expect(turned).toBe(true);
    expect(parkedAt).toBeGreaterThan(0);
    // Поездка в потоке кончилась на месте: машины в потоке нет, поездка засчитана.
    expect(game.traffic.vehicles.has(sim.id)).toBe(false);
    expect(game.traffic.arrivals).toBe(arrivals + 1);
    const [car] = game.shops.parkedAt(town, b.id);
    expect(car.color).toBe(color);
    const stay = car.until - parkedAt;
    expect(stay).toBeGreaterThanOrEqual(SHOP_PARKING.stay.min - 1);
    expect(stay).toBeLessThanOrEqual(SHOP_PARKING.stay.max + 1);
    // Стоит на своём месте, вблизи её видно.
    const spot = visit.lot.spots[car.k];
    expect(game.shops.looks(game.towns, WORLD, true).some((l) => dist(l.look.pos, spot.d.gate) < CAR_SIZE.l)).toBe(true);
    // Пора — выезжает задним ходом к бордюру, ждёт просвета, встаёт в поток.
    car.until = game.time;
    let backed = false;
    let waited = false;
    let joined: number | null = null;
    for (let i = 0; i < 30 * 90 && joined === null; i++) {
      step(game);
      const m = game.garages.moveOf(spot.key);
      if (m?.kind === 'out' && m.phase === 'yard' && dot(m.dir, spot.d.dir) > 0.95) backed = true;
      if (m?.phase === 'wait') waited = true;
      if (m?.sim && !game.shops.parkedAt(town, b.id).length) joined = m.sim.id;
    }
    expect(backed).toBe(true);
    expect(waited).toBe(true);
    expect(joined).not.toBeNull();
    // Уезжает домой — в жилой дом города; место свободно.
    const trip = game.tripOf(joined!)!;
    expect(trip.from).toBe(b);
    expect(trip.to.kind).toBe('res');
    expect(game.shops.parkedAt(town, b.id).length).toBe(0);
    for (let i = 0; i < 30 * 30 && game.garages.moveOf(spot.key); i++) step(game);
    expect(game.garages.moveOf(spot.key)).toBeNull();
    expect(game.garages.isBusy(stallKey(b.id, car.k))).toBe(false);
    // Тронулась по полосе носом по ходу — направо или налево, через встречку (домой может быть ближе туда).
    const out = game.traffic.vehicles.get(joined!)!;
    const link = game.roads.graph.lanes.get(out.lane)!.link;
    const via = [game.garages.slotOf(spot), game.garages.leftSlotOf(spot)].find((s) => s?.link.id === link)!;
    expect(via).toBeDefined();
    expect(dot(out.dir, via.f)).toBeGreaterThan(0.95);
  });

  it('встаёт между двумя стоящими, не задевая их: в заезде и на месте кузов — в своём месте', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, b, visit } = shopLot(game, 3);
    const free = Math.floor(visit.lot.spots.length / 2);
    town.shopParked = [
      ...(town.shopParked ?? []),
      ...visit.lot.spots.flatMap((_, k) => (k === free ? [] : [{ b: b.id, k, color: '#c94f43', until: 1e9 }])),
    ];
    const spot = visit.lot.spots[free];
    const sim = drive(game, visit);
    // Кузов (нос pos, курс dir) против стоящих машин: пересекаются ли прямоугольники (ужатые на 0,2 м).
    const box = (pos: { x: number; y: number }, dir: { x: number; y: number }) => {
      const c = { x: pos.x - (dir.x * CAR.length) / 2, y: pos.y - (dir.y * CAR.length) / 2 };
      return { c, u: dir, n: { x: -dir.y, y: dir.x }, hl: CAR.length / 2 - 0.2, hw: CAR.width / 2 - 0.2 };
    };
    const hit = (a: ReturnType<typeof box>, o: ReturnType<typeof box>) => {
      const d = sub(o.c, a.c);
      for (const ax of [a.u, a.n, o.u, o.n]) {
        const ra = a.hl * Math.abs(dot(a.u, ax)) + a.hw * Math.abs(dot(a.n, ax));
        const rb = o.hl * Math.abs(dot(o.u, ax)) + o.hw * Math.abs(dot(o.n, ax));
        if (Math.abs(dot(d, ax)) > ra + rb) return false;
      }
      return true;
    };
    const parked = game.shops.looks(game.towns, WORLD, true).filter((l) => visit.lot.spots.some((s) => dist(l.look.pos, s.d.gate) < CAR_SIZE.l));
    expect(parked.length).toBe(visit.lot.spots.length - 1);
    let hits = 0;
    let done = false;
    for (let i = 0; i < 30 * 90 && !done; i++) {
      step(game);
      const m = game.garages.moveOf(spot.key);
      if (m) for (const p of parked) if (hit(box(m.pos, m.dir), box(p.look.pos, p.look.dir))) hits++;
      done = game.shops.parkedAt(town, b.id).length === visit.lot.spots.length;
    }
    expect(done).toBe(true);
    expect(hits).toBe(0);
    expect(game.traffic.vehicles.has(sim.id)).toBe(false);
  });

  it('стоянка полная — машина проезжает мимо: не сворачивает, поездка кончается у узла', () => {
    const game = withoutCitizens(freshGame(7));
    const { town, b, visit } = shopLot(game);
    const full = visit.lot.spots.map((_, k) => ({ b: b.id, k, color: '#c94f43', until: 1e9 }));
    town.shopParked = [...(town.shopParked ?? []), ...full];
    const sim = drive(game, visit);
    const arrivals = game.traffic.arrivals;
    let turned = false;
    for (let i = 0; i < 30 * 90 && game.traffic.vehicles.has(sim.id); i++) {
      step(game);
      if (visit.lot.spots.some((s) => game.garages.moveOf(s.key))) turned = true;
    }
    expect(turned).toBe(false);
    expect(game.traffic.vehicles.has(sim.id)).toBe(false);
    expect(game.traffic.arrivals).toBe(arrivals + 1);
    expect(game.shops.parkedAt(town, b.id).length).toBe(visit.lot.spots.length);
  });

  it('по seed: одна и та же партия — те же машины на стоянках; сохранение несёт их, старое сохранение — расставляет', () => {
    const a = freshGame(7);
    const state = (g: Game) => g.towns.map((t) => [t.shopVisits ?? 0, JSON.stringify(t.shopParked ?? [])]);
    let visits = 0;
    let parked = 0;
    runSeconds(a, 90, () => {
      for (const m of a.garages.moves) if (m.home.key < 0 && m.kind === 'in') visits++;
    });
    for (const t of a.towns) parked += t.shopParked?.length ?? 0;
    expect(visits).toBeGreaterThan(0);
    expect(parked).toBeGreaterThan(0);
    const save = JSON.stringify(a.toSave());
    const c = new Game(structuredClone(a.settings), JSON.parse(save));
    const d = new Game(structuredClone(a.settings), JSON.parse(save));
    expect(state(c)).toEqual(state(a));
    runSeconds(c, 20);
    runSeconds(d, 20);
    expect(state(c)).toEqual(state(d));
    expect(c.traffic.arrivals).toBe(d.traffic.arrivals);
    // Старое сохранение (без стоянок): открывается, машины на стоянках — как в начале партии.
    const fresh = freshGame(7);
    const old = JSON.parse(JSON.stringify(fresh.toSave())) as SaveData;
    for (const t of old.towns) {
      delete t.shopParked;
      delete t.shopVisits;
    }
    const e = new Game(structuredClone(fresh.settings), old);
    expect(e.towns.map((t) => t.shopParked)).toEqual(fresh.towns.map((t) => t.shopParked));
    runSeconds(e, 5);
  });
});
