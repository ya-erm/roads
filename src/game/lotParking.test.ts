import { describe, expect, it } from 'vitest';
import { add, dist, scale, type Vec } from '../core/vec';
import type { ParkingLot, Town, TownBuilding, TownCar } from '../world/entities';
import { footprintsOverlap } from '../world/spatial';
import { LOT, lotGateDriveway, lotGateNodes, lotStallCount } from '../world/parkingLots';
import { NEW_GAME_SETTINGS, type WorldSettings } from '../world/settings';
import { formOf } from '../world/townForms';
import type { FleetCar, FleetTrip } from './carHomes';
import { Game, type LotShape, type SaveData } from './game';
import type { ParkChoice } from './parkSearch';
import { PARK_SEARCH } from './parkSearch';
import { PARKING_LAYER } from './parkingLayer';
import { freshGame, runSeconds, runUntil } from './testkit';

/** Новая партия — с парковками (WorldSettings.parking): город ставит площадки у рынка и ратуши. */
const PARK: WorldSettings = { ...NEW_GAME_SETTINGS, seed: 1, size: 'medium' };

const biggest = (g: Game): Town => [...g.towns].sort((a, b) => b.population - a.population)[0];

/** Точка у улицы большого города, где площадка shape встаёт без сноса (не дальше far от центра). */
function lotSpot(g: Game, shape: LotShape, skip: Vec[] = []): Vec {
  const town = biggest(g);
  const net = g.roads.net;
  const list = net.corridorsNear(town.center, town.radius).sort((a, b) => a.id - b.id);
  for (const c of list) {
    for (let s = 25; s < c.length - 25; s += 8) {
      const pt = c.lut.pointAt(s);
      const t = c.lut.tangentAt(s);
      for (const side of [1, -1]) {
        const p = add(pt, scale({ x: -t.y * side, y: t.x * side }, 25));
        if (skip.some((q) => dist(q, p) < 80)) continue;
        const plan = g.lotPlan(p, shape);
        if (plan.ok && !plan.demolish.length) return p;
      }
    }
  }
  throw new Error('нет места под площадку');
}

/** Машина парка дома, которая может выехать со своего места (заезд к полосе есть). */
function homeCar(g: Game, town: Town, near: Vec): FleetCar {
  const f = g.carHomes.fleet(town);
  const ok = f.cars
    .filter((c) => c.place && !c.place.curb && !c.place.lot && c.place.kind !== 'box' && g.carHomes.isHome(town, c.key) && g.garages.slotOf(c.place.spot))
    .sort((a, b) => dist(a.home.fp.center, near) - dist(b.home.fp.center, near));
  return ok[Math.min(ok.length - 1, 5)];
}

const away = (town: Town, key: number): TownCar | undefined => town.cars?.find((e) => e.car === key);

describe('Площадки-стоянки', { timeout: 300_000 }, () => {
  it('ставится у улицы: места, ворота, размер, поворот, перенос, снос и Ctrl+Z', () => {
    const g = freshGame(PARK);
    const shape: LotShape = { cols: 6, rows: 2 };
    const p = lotSpot(g, shape);
    const money0 = g.money;
    g.checkpoint('площадка');
    const res = g.placeLot(p, shape);
    g.commit();
    expect(typeof res).toBe('object');
    const lot = res as ParkingLot;
    // 6 мест в ряду × 2 ряда, одни ворота ⬌ посередине; цена — ворота и места.
    expect(lotStallCount(lot)).toBe(12);
    expect(lot.gates).toEqual([{ x: expect.any(Number), mode: 'both' }]);
    expect(money0 - g.money).toBe(LOT.gateCost + 12 * LOT.stallCost);
    expect(lot.owner).toBe('player');
    expect(lot.nodes).toBeUndefined();
    // Не на домах и не на дороге: край — за тротуаром.
    expect(g.towns.flatMap((t) => t.buildings).some((b) => footprintsOverlap(b.fp, lot.fp, 0))).toBe(false);
    expect(g.roadUnder(lot.fp, 0.5)).toBeNull();
    // Ворота: одни — в обе стороны (въезд или выезд у единственных нельзя); клик мимо — новые ⬌; по ним — ⇥ въезд.
    const gate0 = lotGateDriveway(lot, lot.gates[0]).gate;
    expect(g.toggleLotGate(lot.id, gate0)).toMatch(/ворота/i);
    const far = { x: lot.gates[0].x + (lot.gates[0].x > 0 ? -14 : 14) };
    const edge = lotGateDriveway(lot, far).gate;
    expect(g.toggleLotGate(lot.id, edge)).toBeNull();
    const cur = () => g.lotById(lot.id)!.lot;
    expect(cur().gates.length).toBe(2);
    expect(g.toggleLotGate(lot.id, gate0)).toBeNull();
    expect(cur().gates[0].mode).toBe('in');
    expect(lotStallCount(cur())).toBeLessThan(12);
    // Размер: 8 мест в ряду — 16 мест (минус проезд вторых ворот); доплата — разница.
    const before = g.money;
    expect(g.editLot(lot.id, g.lotResizePlan(lot.id, 8, 2, 1), 'размер площадки')).toBeNull();
    expect(cur().fp.w).toBeCloseTo(LOT.aisle + 8 * LOT.stall.w, 5);
    expect(g.money).toBeLessThan(before);
    // Ctrl+Z — снова 6 в ряду.
    expect(g.undo()).toBe('размер площадки');
    expect(cur().fp.w).toBeCloseTo(LOT.aisle + 6 * LOT.stall.w, 5);
    // Поворот на 15° — участок тот же по середине, угол другой (у улицы — встаёт, если ворота дотягиваются).
    const rot = g.lotRotatePlan(lot.id, cur().fp.angle + LOT.turn);
    expect(rot).not.toBeNull();
    // Перенос — к другой улице; Ctrl+Z — обратно.
    const q = lotSpot(g, { ...shape, gates: cur().gates }, [p]);
    const was = { ...cur().fp.center };
    expect(g.editLot(lot.id, g.lotMovePlan(lot.id, q), 'перенос площадки')).toBeNull();
    expect(dist(cur().fp.center, was)).toBeGreaterThan(40);
    expect(g.undo()).toBe('перенос площадки');
    expect(dist(cur().fp.center, was)).toBeLessThan(0.01);
    // Снос — возврат половины; Ctrl+Z — снова на месте.
    const m0 = g.money;
    expect(g.removeLot(lot.id)).toBe(true);
    expect(g.lotById(lot.id)).toBeUndefined();
    expect(g.money).toBeGreaterThan(m0);
    g.undo();
    expect(g.lotById(lot.id)?.lot.gates.length).toBe(2);
  });

  it('город ставит площадку у рынка и ратуши: 12–20 мест, без сноса, ворота — к улице', () => {
    const g = freshGame(PARK);
    const all = g.towns.flatMap((t) => (t.lots ?? []).map((lot) => ({ lot, t })));
    const market = g.towns.flatMap((t) => t.buildings).find((b) => formOf(b) === 'market' && all.some((x) => x.lot.for === b.id));
    expect(market).toBeDefined();
    const lot = all.find((x) => x.lot.for === market!.id)!.lot;
    expect(lot.owner).toBe('town');
    const n = lotStallCount(lot);
    expect(n).toBeGreaterThanOrEqual(12);
    expect(n).toBeLessThanOrEqual(20);
    expect(dist(lot.fp.center, market!.fp.center)).toBeLessThan(200);
    for (const { lot: l } of all) {
      expect(g.towns.flatMap((t) => t.buildings).some((b) => footprintsOverlap(b.fp, l.fp, 0))).toBe(false);
      const spot = g.lots.gateSpots(l)[0]!;
      expect(g.garages.slotOf(spot)).not.toBeNull();
    }
    // Старая партия (без парковок) — город площадок не ставит.
    const old = new Game({ ...PARK, parking: undefined, seed: 2, size: 'small' });
    expect(old.towns.some((t) => t.lots?.length)).toBe(false);
  });

  it('машины встают на площадки у целей и уезжают с них домой; счёт месяца; сохранение — на тех же местах', () => {
    const g = freshGame(PARK);
    let left = 0;
    const wasOn = new Map<number, number>();
    // До 200 с — пока не уехал хоть один и всего гостей площадок больше трёх (обычно — за первые десятки секунд).
    const onLots = () => g.towns.reduce((n, t) => n + (t.cars ?? []).filter((e) => e.lot !== undefined).length, 0);
    runUntil(g, 200, () => left > 0 && onLots() + left > 3, () => {
      for (const t of g.towns) {
        for (const e of t.cars ?? []) if (e.lot !== undefined) wasOn.set(e.car, e.lot);
      }
      for (const [car, lot] of wasOn) {
        const t = g.carHomes.carOf(car)?.town;
        const e = t && away(t, car);
        if (!e || e.lot !== lot) {
          left++;
          wasOn.delete(car);
        }
      }
    });
    const on = g.towns.flatMap((t) => (t.cars ?? []).filter((e) => e.lot !== undefined));
    expect(on.length + left).toBeGreaterThan(3);
    expect(left).toBeGreaterThan(0);
    // Счёт месяца (месяц — минута: этот и прошлый).
    const stats = g.lots.all().flatMap((x) => [x.lot.month, x.lot.last]);
    expect(stats.reduce((s, m) => s + (m?.cars ?? 0), 0)).toBeGreaterThan(0);
    // Стоящие гости видны на своих местах (вблизи).
    const looks = g.garageLooks([-1e6, -1e6, 1e6, 1e6], true);
    for (const e of on.slice(0, 5)) {
      const pose = g.lots.poseOf(e)!;
      expect(looks.some((l) => dist(l.look.pos, pose.nose) < 0.01)).toBe(true);
    }
    // Сохранение: площадки и машины на них — те же.
    const save = JSON.parse(JSON.stringify(g.toSave())) as SaveData;
    const h = new Game(save.settings, save);
    // Места ночёвки — по геометрии, заново (парк машин городов).
    for (const t of h.towns) h.carHomes.fleet(t);
    const lotsOf = (x: Game) => x.towns.flatMap((t) => (t.lots ?? []).map((l) => ({ id: l.id, fp: l.fp, gates: l.gates, used: x.lots.usedCount(l) })));
    expect(lotsOf(h)).toEqual(lotsOf(g));
    const onH = h.towns.flatMap((t) => (t.cars ?? []).filter((e) => e.lot !== undefined).map((e) => [e.car, e.lot, e.ls]));
    expect(onH).toEqual(on.map((e) => [e.car, e.lot, e.ls]));
  });

  it('старое сохранение (без площадок) открывается: площадок нет, поездки идут', () => {
    const g = freshGame(PARK);
    const save = JSON.parse(JSON.stringify(g.toSave())) as SaveData;
    for (const t of save.towns) {
      delete t.lots;
      delete t.parkRefused;
      for (const e of t.cars ?? []) {
        delete e.lot;
        delete e.ls;
        delete e.lt;
        delete e.yard;
      }
    }
    const h = new Game(save.settings, save);
    expect(h.lots.all().length).toBe(0);
    runSeconds(h, 30);
    expect(h.citizenCars).toBeGreaterThan(0);
  });

  it('больше 24 мест — ворота через перекрёсток: тупик-выезд, машина доезжает до узла и встаёт на место, потом уезжает', () => {
    const g = freshGame(PARK);
    const shape: LotShape = { cols: 7, rows: 4 };
    const p = lotSpot(g, shape);
    const plan = g.lotPlan(p, shape);
    expect(plan.big).toBe(true);
    expect(plan.roads).toBeDefined();
    g.checkpoint('площадка');
    const lot = g.placeLot(p, shape) as ParkingLot;
    g.commit();
    // 7 × 4 = 28, без двух под полосами тупика-выезда.
    expect(lotStallCount(lot)).toBe(26);
    expect(lot.nodes?.length).toBe(1);
    const node = g.roads.net.nodes.get(lot.nodes![0])!;
    // Узел ворот — тупик выезда, внутри площадки; к нему есть путь по графу; на карте — без разворота.
    expect(node.corridors.length).toBe(1);
    expect([...lotGateNodes(g.towns)]).toEqual([node.id]);
    const ref = g.lotById(lot.id)!;
    const town = ref.town;
    const dest = town.buildings.filter((b) => b.kind === 'com').sort((a, b) => dist(a.fp.center, lot.fp.center) - dist(b.fp.center, lot.fp.center))[0];
    const car = homeCar(g, town, lot.fp.center);
    const way = g.lots.wayToBig(lot, g.roads.graph.outLinks.get(car.home.anchor) ?? []);
    expect(way).not.toBeNull();
    const trip: Extract<FleetTrip, { kind: 'out' }> = { kind: 'out', car, town };
    const choice: ParkChoice = { kind: 'lot', key: `l${lot.id}`, ref, node: way!.node, route: way!.route, full: false };
    g.carHomes.depart(trip, dest, { target: way!.node, then: (sim) => g.parkSearch.start(sim, trip, dest, choice) });
    let parked: TownCar | undefined;
    let counted = 0;
    runUntil(g, 240, () => !!parked, () => {
      const e = away(town, car.key);
      if (!parked && e?.lot === lot.id) {
        parked = { ...e };
        counted = lot.month?.cars ?? 0;
      }
    });
    expect(parked?.lot).toBe(lot.id);
    expect(counted).toBeGreaterThan(0);
    // Уезжает: встаёт в поток у узла ворот (с места, а не «из ниоткуда») и едет домой.
    const e = away(town, car.key);
    if (e?.lot === lot.id) {
      expect(g.carHomes.leaveLot({ kind: 'back', car, town, from: dest, lot: { ref, stall: e.ls! } })).toBe(true);
      let home = false;
      let left = 0;
      runUntil(g, 240, () => home && left > 0, () => {
        left = Math.max(left, lot.month?.left ?? 0);
        home ||= g.carHomes.isHome(town, car.key);
      });
      expect(home).toBe(true);
      expect(left).toBeGreaterThan(0);
    }
  });

  it('мест у цели нет — до трёх попыток рядом, потом домой; отказ — на слое 🅿️, «🅿️✕» над целью', () => {
    const g = freshGame(PARK);
    const town = biggest(g);
    // Цель — деловой дом в центре, у которого есть места на полосах стоянки.
    const dest = town.buildings
      .filter((b): b is TownBuilding => b.kind === 'com' && formOf(b) === 'office' && g.curb.near(b.fp.center, 150).length > 4)
      .sort((a, b) => dist(a.fp.center, town.center) - dist(b.fp.center, town.center))[0];
    expect(dest).toBeDefined();
    // Всё вокруг занято (и остаётся занятым: кто уехал — место снова чьё-то): полосы стоянки и площадки в
    // PARK_SEARCH.range.
    const block = () => {
      for (const st of g.curb.near(dest.fp.center, PARK_SEARCH.range + 200)) if (!g.curb.isTaken(st.key)) g.curb.park(st.key, -1);
      for (const { lot } of g.lots.near(dest.fp.center, PARK_SEARCH.range + 200))
        for (let i = 0; i < lotStallCount(lot); i++) if (g.lots.freeStall(lot.id, i)) g.lots.park(lot.id, i, -1);
    };
    block();
    const car = homeCar(g, town, dest.fp.center);
    const plan = g.parkSearch.plan(dest, g.roads.graph.outLinks.get(car.home.anchor) ?? []);
    expect(plan?.full).toBe(true);
    const trip: Extract<FleetTrip, { kind: 'out' }> = { kind: 'out', car, town };
    let simId = -1;
    const target = plan!.kind === 'curb' ? plan!.link : plan!.kind === 'lot' ? plan!.slot!.link : plan!.slot.link;
    g.carHomes.depart(trip, dest, {
      target: target.toNode!,
      endLink: target.id,
      then: (sim) => {
        simId = sim.id;
        g.parkSearch.start(sim, trip, dest, plan!);
      },
    });
    let tries = 0;
    let homeward = false;
    let badge = false;
    let home = false;
    let refused = false;
    // Клетка цели на слое 🅿️ (счёт отказов — за месяц, Town.parkRefused).
    const cell = `${Math.floor(dest.fp.center.x / PARKING_LAYER.cell)}:${Math.floor(dest.fp.center.y / PARKING_LAYER.cell)}`;
    // Предел — с запасом: машина из кармана панельки у проспекта возвращается на место только поворотом направо —
    // кругом по кварталу (~2 мин после поиска).
    runUntil(g, 600, () => home && refused && badge, () => {
      block();
      const s = g.parkSearch.of(simId);
      if (s) tries = Math.max(tries, s.tries);
      if (g.parkSearch.badges().some((p) => dist(p, dest.fp.center) < 1)) badge = true;
      if (simId >= 0 && g.carHomes.carOfSim(simId)?.home) homeward = true;
      if (homeward && !refused) refused = (town.parkRefused?.[cell] ?? 0) > 0 && g.parkingLayer().some((c) => c.refused && `${c.x / c.size}:${c.y / c.size}` === cell);
      home ||= homeward && g.carHomes.isHome(town, car.key);
    });
    expect(tries).toBeGreaterThanOrEqual(1);
    expect(tries).toBeLessThanOrEqual(PARK_SEARCH.tries);
    expect(badge).toBe(true);
    // Не нашла — поехала домой, на своё место (а не «исчезла у узла»), доехала; отказ — в клетке цели (красная).
    expect(homeward).toBe(true);
    expect(home).toBe(true);
    expect(refused).toBe(true);
  });
});
