import { hash } from '../core/math';
import { add, dist, scale, type Vec } from '../core/vec';
import type { FleetCar, PlaceKind } from '../game/carHomes';
import { emptyLedger, Game } from '../game/game';
import { AVENUE, roadPlan, STREET, withoutCitizens } from '../game/testkit';
import { oneWay } from '../lanes/model';
import { addCurb } from '../world/curbStreets';
import type { HouseForm, ParkingLot, Town, TownBuilding } from '../world/entities';
import { CAR_SIZE, cottagePlan, LOT_SETBACK } from '../world/houseAccess';
import { lotLayout } from '../world/parkingLots';
import { yardLotOf, yardSpots } from '../world/yardLots';
import { stallKey } from '../game/shopParking';
import type { VehicleLook } from '../sim/vehicle';
import { TERRAIN_VERSION } from '../world/settings';
import type { TestScene } from './index';

export type ParkingPhase = 'home' | 'outbound' | 'parked' | 'returning';
export type ParkingAction = 'home-out' | 'home-in' | 'parking-out' | 'parking-in';
export type ParkingSpawn = 'parked' | 'road' | 'oncoming' | 'stopped';

export interface ParkingCase {
  title: string;
  description: string;
  town: Town;
  car: FleetCar;
  destination: TownBuilding;
  lot?: ParkingLot;
  target: 'shop' | 'curb' | 'lot';
  direction?: 'across' | 'reverse' | 'detour';
  phase: ParkingPhase;
  until: number;
  arrivals: number;
  returns: number;
  view: TestScene['view'];
  obstacles: VehicleLook[];
  action?: ParkingAction;
}

export interface ParkingScene extends TestScene {
  cases: ParkingCase[];
  /** После game.update: решения о поездках, сами манёвры выполняет игра. */
  tick(): void;
  /** Подготовить выбранную машину к одному манёвру. Остальные машины остаются на местах. */
  startAction(index: number, action: ParkingAction): void;
  spawn(index: number, kind: ParkingSpawn, at?: Vec): void;
}

const CASES: { title: string; description: string; form: HouseForm; place: PlaceKind; target: ParkingCase['target']; direction?: ParkingCase['direction']; avenue?: boolean; oneway?: boolean; rows?: 1 | 2 }[] = [
  { title: '01 · Гараж частного дома', description: 'Улица 1+1 · ворота гаража → магазин → домой', form: 'cottage', place: 'garage', target: 'shop' },
  { title: '02 · Площадка у дома', description: 'Улица 1+1 · открытое место → сельский магазин', form: 'cottage', place: 'pad', target: 'shop' },
  { title: '03 · Карман панельного дома', description: 'Проспект 2+2 · выезд задним ходом через тротуар', form: 'slab', place: 'stall', target: 'shop', avenue: true },
  { title: '04 · Двор жилого дома', description: 'Улица 1+1 · открытые места у фасада → рынок', form: 'courtyard', place: 'stall', target: 'shop' },
  { title: '05 · Параллельная парковка', description: 'Улица 1+1 · место у бордюра → выезд в поток', form: 'cottage', place: 'pad', target: 'curb' },
  { title: '06 · Парковка на проспекте', description: 'Проспект 2+2 · парковочная полоса рядом с потоком', form: 'cottage', place: 'garage', target: 'curb', avenue: true },
  { title: '07 · Стоянка в один ряд', description: 'Улица 1+1 · поворот к въезду и проезд до места', form: 'cottage', place: 'pad', target: 'lot', rows: 1 },
  { title: '08 · Стоянка в два ряда', description: 'Односторонняя улица · проезды между рядами мест', form: 'cottage', place: 'garage', target: 'lot', rows: 2, oneway: true },
  { title: '09 · Въезд налево', description: 'Улица 1+1 · поворот к магазину через встречную полосу', form: 'cottage', place: 'pad', target: 'shop', direction: 'across' },
  { title: '10 · Выезд налево', description: 'Улица 1+1 · цель позади, выезд на противоположную полосу', form: 'cottage', place: 'pad', target: 'shop', direction: 'reverse' },
  { title: '11 · Через проспект — в объезд', description: 'Проспект 2+2 · пересекать осевую нельзя, заезд с другой стороны', form: 'cottage', place: 'pad', target: 'shop', avenue: true, direction: 'detour' },
];

/** Верхний правый участок пуст — как в других сценах, там панель маршрутов. */
const CELLS = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2], [0, 3], [1, 3], [2, 3]];

/** Отдельные кварталы, настоящие машины жителей и настоящие манёвры парковки. Без случайных поездок и роста. */
export function buildParkingScene(manual = false): ParkingScene {
  const game = withoutCitizens(new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 1e9, water: 'dry', relief: 'plains', parking: true, terrainVersion: TERRAIN_VERSION }));
  // Фиксированная застройка стенда: месячные правила города иначе превращают единственный магазин в школу.
  (game as unknown as { growTown(): void }).growTown = () => {};
  game.townLots = () => false;
  game.terrain.clearWater();
  game.terrain.trees.length = 0;
  game.terrain.extraForests.length = 0;
  for (const ind of game.industries) game.index.remove(ind);
  game.industries = [];
  const cases: ParkingCase[] = [];
  const errors: string[] = [];
  let automatic = !manual;
  if (manual) game.speed = 0;
  const parkedLooks: VehicleLook[] = [];
  let debugId = -1;
  const baseLooks = game.garageLooks.bind(game);
  game.garageLooks = (box, parked) => [...baseLooks(box, parked), ...parked ? parkedLooks.filter((v) => v.pos.x > box[0] - 10 && v.pos.x < box[2] + 10 && v.pos.y > box[1] - 10 && v.pos.y < box[3] + 10).map((look) => ({ look })) : []];
  // Отдельный диапазон id: не пересекается с сущностями, которые создал генератор.
  let buildingId = 100_000;
  for (const [i, spec] of CASES.entries()) {
    try {
      const [col, row] = CELLS[i];
      const x = 1300 + col * 430;
      const y = 1400 + row * 310;
      const angle = 0;
      const at = (u: number, v: number): Vec => ({ x: x + u, y: y + v });
      const profile = spec.oneway ? { cls: 'street' as const, lanes: oneWay(2) } : spec.avenue ? AVENUE : STREET;
      const corners = [at(0, 0), at(310, 0), at(310, 145), at(0, 145)];
      for (let j = 0; j < 4; j++) {
        const a = j === 0 ? { free: corners[j] } : corners[j];
        const b = j === 3 ? corners[0] : { free: corners[(j + 1) % 4] };
        const plan = roadPlan(game, a, b, { ...profile, kink: true });
        if (!plan.ok || !game.roadBuilder.apply(plan)) throw new Error(plan.reason ?? 'не построилась улица');
      }
      if (spec.direction === 'detour') {
        // Переехать на другую сторону проспекта можно через соседний квартал с двумя Т-перекрёстками.
        const plan = roadPlan(game, at(155, 0), at(155, 145), STREET);
        if (!plan.ok || !game.roadBuilder.apply(plan)) throw new Error(plan.reason ?? 'не построилась улица объезда');
      }
      const corridors = [...game.roads.net.corridors.values()].filter((c) => c.lut.closest(at(155, 72)).d < 180 && c.lut.closest(at(155, 72)).d > 50);
      const bottom = game.roads.net.corridorNear(at(155, 145), 10)!;
      if (spec.target === 'curb' && !addCurb(game.roads.net, bottom, 1)) throw new Error('не добавилась полоса стоянки');
      const top = game.roads.net.corridorNear(at(155, 0), 10)!;
      const town: Town = {
        id: i + 1, name: spec.title, center: at(155, 72), radius: 185, top: y, style: 'linear', population: 0,
        buildings: [], streets: corridors.map((c) => c.id), demands: [], supplied: {}, lastSupplied: {}, tripAcc: 0, growthAcc: 0, autoStreets: false, labelOnly: true,
      };
      game.towns.push(town);
      const half = spec.avenue ? 15.5 : 8.5;
      const building = (form: HouseForm, u: number, v: number, face: 1 | -1, w: number, h: number, anchor: number): TownBuilding => {
        const b: TownBuilding = { type: 'building', id: buildingId++, townId: town.id, fp: { center: at(u, v), w, h, angle }, kind: form === 'shop' || form === 'store' || form === 'market' || form === 'office' ? 'com' : 'res', floors: form === 'cottage' ? 1 : 4, people: form === 'cottage' ? 4 : 100, anchor, color: '#ded3bb', roof: '#ad7055', form, face };
        town.buildings.push(b);
        return b;
      };
      const home = spec.direction
        ? building(spec.form, spec.direction === 'reverse' ? 85 : 220, 145 - half - LOT_SETBACK - 30, 1, 64, 60, bottom.b)
        : building(spec.form, 85, half + LOT_SETBACK + 30, -1, 64, 60, top.b);
      if (spec.form === 'cottage') {
        home.homeSpaces = 1;
        home.garageSpaces = 1;
        while ((spec.place === 'garage' ? !cottagePlan(home).garage : !cottagePlan(home).pad) || (spec.place === 'garage' && hash(home.id, 18) < 0.2)) home.id = buildingId++;
      }
      const destinationForm = spec.target === 'shop' ? i === 1 ? 'store' : i === 3 ? 'market' : 'shop' : 'office';
      const dest = spec.direction
        ? building(destinationForm, spec.direction === 'reverse' ? 220 : 85, 145 + (spec.direction === 'reverse' ? -1 : 1) * (half + LOT_SETBACK + 34), spec.direction === 'reverse' ? 1 : -1, 65, 68, bottom.b)
        : building(destinationForm, 220, 145 - half - LOT_SETBACK - 34, 1, 65, 68, bottom.b);
      let lot: ParkingLot | undefined;
      if (spec.target === 'lot') {
        // Офис — за пределами участка стоянки, въезд которой обращён к нижней улице.
        dest.fp.center = at(220, 45);
        dest.fp.w = 40;
        dest.fp.h = 28;
        const result = game.placeLot(at(220, 145 - 25), { cols: 5, rows: spec.rows! });
        if (typeof result !== 'object' || !result) throw new Error(String(result));
        lot = result;
      }
      for (const b of town.buildings) game.index.add(b);
      const car = game.carHomes.fleet(town).cars.find((c) => c.home === home && c.place?.kind === spec.place && game.garages.slotOf(c.place.spot));
      if (!car) throw new Error(`нет машины с местом «${spec.place}»`);
      car.color = ['#3f74b5', '#d87a45', '#d8b74d', '#9d6cba', '#4a9a87', '#d26779', '#789cc5', '#db9b5a', '#4a8a42', '#c75c44', '#996cbd'][i];
      cases.push({ title: spec.title, description: spec.description, town, car, destination: dest, lot, target: spec.target, direction: spec.direction, phase: 'home', until: manual ? Infinity : i * 1.5 + 1, arrivals: 0, returns: 0, obstacles: [], view: { x0: x - 35, y0: y - 110, x1: x + 355, y1: y + 230 } });
    } catch (e) {
      errors.push(`${spec.title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const tick = () => {
    for (const c of cases) {
      if (c.phase === 'home' && game.time >= c.until) depart(game, c, errors);
      const away = game.carHomes.awayOf(c.town, c.car.key);
      if (c.phase === 'outbound' && !game.carHomes.isMoving(c.car.key) && (away?.spot !== undefined || away?.curb !== undefined || away?.lot !== undefined)) {
        c.phase = 'parked';
        c.arrivals++;
        c.until = automatic ? game.time + 7 : Infinity;
        const shop = c.town.shopParked?.find((s) => s.car === c.car.key);
        if (shop) shop.until = c.until;
      }
      if (c.phase === 'parked' && game.time >= c.until) {
        const trip = { kind: 'back' as const, car: c.car, town: c.town, from: c.destination };
        if (away?.curb) {
          const st = game.curb.stall(away.curb);
          if (st && game.carHomes.leaveCurb({ ...trip, curb: st })) c.phase = 'returning';
        } else if (away?.lot !== undefined && away.ls !== undefined) {
          const ref = game.lots.get(away.lot);
          if (ref && game.carHomes.leaveLot({ ...trip, lot: { ref, stall: away.ls } })) c.phase = 'returning';
        } else if (game.carHomes.isMoving(c.car.key) || game.carHomes.isHome(c.town, c.car.key)) c.phase = 'returning';
      }
      if (c.phase === 'returning' && game.carHomes.isHome(c.town, c.car.key)) {
        c.returns++;
        c.phase = 'home';
        c.until = automatic ? game.time + 5 : Infinity;
      }
    }
  };
  game.money = game.settings.money;
  game.incomeMonth = game.expensesMonth = 0;
  game.ledger = emptyLedger();
  const startAction = (index: number, action: ParkingAction) => {
    const c = cases[index];
    if (!c) throw new Error('нет такого участка');
    automatic = false;
    c.action = action;
    for (const other of cases) other.until = Infinity;
    game.speed = 1;
    game.monthBudget = Infinity;
    depart(game, c, errors);
    const until = (ready: () => boolean) => {
      for (let frames = 0; !ready() && frames < 30 * 240; frames++) {
        game.update(1 / 30);
        tick();
      }
      if (!ready()) throw new Error(`${c.title}: не удалось подготовить манёвр`);
    };
    const approaching = (home: boolean) => {
      const sim = [...game.traffic.vehicles.values()].find((v) => {
        const owner = game.carHomes.carOfSim(v.id);
        return owner?.car === c.car.key && owner.home === home;
      });
      return !!sim && !sim.onMovement && game.traffic.currentLane(sim)?.link === sim.endLink && !game.garages.moves.some((m) => m.town === c.town && m.kind === 'out');
    };
    if (action === 'parking-in') until(() => approaching(false));
    if (action === 'parking-out' || action === 'home-in') {
      until(() => c.phase === 'parked');
      c.until = game.time;
      const parked = c.town.shopParked?.find((p) => p.car === c.car.key);
      if (parked) parked.until = game.time;
      if (action === 'home-in') until(() => c.phase === 'returning' && approaching(true));
    }
  };
  const spawn = (index: number, kind: ParkingSpawn, at?: Vec) => {
    const c = cases[index];
    if (!c) throw new Error('нет такого участка');
    const color = ['#637f99', '#b6656c', '#a5a5a0', '#9b8251'][(-debugId - 1) % 4];
    const spec = { kind: 'car' as const, length: CAR_SIZE.l, width: CAR_SIZE.w, maxSpeed: 60, accel: 10, color };
    if (kind === 'parked') {
      let pose: { pos: Vec; dir: Vec } | undefined;
      if (c.car.place?.kind === 'stall') {
        const b = c.car.home;
        const lot = yardLotOf(b)!;
        const places = yardSpots(b, lot, CAR_SIZE.l).spots;
        const reserved = new Set(game.carHomes.fleet(c.town).cars.map((v) => v.place?.spot.key));
        const clicked = at ? places.map((s, k) => ({ k, d: dist(s.nose, at) })).sort((a, b) => a.d - b.d)[0] : undefined;
        if (clicked && clicked.d > 8) throw new Error('Кликните по парковочному месту у выбранного дома');
        const free = clicked ? !reserved.has(stallKey(b.id, clicked.k)) && !c.obstacles.some((v) => dist(v.pos, places[clicked.k].nose) < 1) ? clicked.k : -1 : places.findIndex((s, k) => !!s.drive && !reserved.has(stallKey(b.id, k)) && !c.obstacles.some((v) => dist(v.pos, s.nose) < 1));
        if (free >= 0) pose = { pos: places[free].nose, dir: places[free].dir };
      } else if (c.lot) {
        const clicked = at ? lotLayout(c.lot).stalls.map((s, k) => ({ k, d: dist(s.pos, at) })).sort((a, b) => a.d - b.d)[0] : undefined;
        if (clicked && clicked.d > 6) throw new Error('Кликните по месту на выбранной площадке');
        const k = clicked ? game.lots.freeStall(c.lot.id, clicked.k) ? clicked.k : -1 : game.lots.pick(c.lot, c.destination.fp.center);
        if (k >= 0) {
          const stall = lotLayout(c.lot).stalls[k];
          game.lots.park(c.lot.id, k, debugId);
          pose = { pos: stall.nose, dir: stall.dir };
        }
      } else if (c.target === 'curb') {
        const places = game.curb.near(c.destination.fp.center, 150);
        const clicked = at ? places.slice().sort((a, b) => dist(a.pos, at) - dist(b.pos, at))[0] : undefined;
        if (clicked && dist(clicked.pos, at!) > 6) throw new Error('Кликните по месту на полосе стоянки');
        const st = clicked ? !game.curb.isTaken(clicked.key) ? clicked : undefined : places.find((s) => !game.curb.isTaken(s.key));
        if (st) {
          game.curb.park(st.key, debugId);
          pose = { pos: add(st.pos, scale(st.dir, CAR_SIZE.l / 2)), dir: st.dir };
        }
      } else {
        const lot = game.shops.lotOf(c.destination);
        const clicked = at && lot ? lot.spots.map((s, k) => ({ k, d: dist(s.spot, at) })).sort((a, b) => a.d - b.d)[0] : undefined;
        if (clicked && clicked.d > 6) throw new Error('Кликните по месту у выбранного магазина');
        const free = (k: number) => !!lot && !game.garages.isBusy(lot.spots[k].key) && !c.town.shopParked?.some((v) => v.b === c.destination.id && v.k === k);
        const k = clicked ? free(clicked.k) ? clicked.k : -1 : lot?.spots.findIndex((_, j) => free(j)) ?? -1;
        if (k >= 0) {
          (c.town.shopParked ??= []).push({ b: c.destination.id, k, color, until: Infinity });
          debugId--;
          return;
        }
      }
      if (!pose) throw new Error(at ? 'Это место занято или закреплено за машиной дома' : 'Свободных мест не осталось');
      const look = { ...spec, ...pose };
      parkedLooks.push(look);
      c.obstacles.push(look);
    } else {
      const parking = c.action?.startsWith('parking');
      const spot = parking ? c.lot ? game.lots.spotFor(c.lot, true)[0] : game.shops.lotOf(c.destination)?.spots[0] : c.car.place!.spot;
      const right = spot && game.garages.slotOf(spot);
      const curb = parking && c.target === 'curb' ? game.curb.near(c.destination.fp.center, 150)[0] : undefined;
      const base = right?.link ?? (curb && game.curb.slotOf(curb)?.link);
      if (!base) throw new Error('Не найдена полоса у выезда');
      let link = kind === 'oncoming' ? game.roads.graph.corridorLinks(base.corridor).find((l) => l.flow !== base.flow) : base;
      let lane = link?.lanes.at(-1);
      let placedAt: number | undefined;
      if (at) {
        const corridor = game.roads.net.corridorNear(at, 24);
        if (!corridor) throw new Error('Кликните по полосе движения');
        const axis = corridor.lut.closest(at).s;
        const choices = game.roads.graph.corridorLinks(corridor.id).flatMap((l) => l.lanes.map((v) => {
          const u = l.flow > 0 ? axis - l.s0 : l.s1 - axis;
          return { link: l, lane: v, u, d: dist(game.roads.graph.lanePose(v, u).pos, at) };
        })).filter((v) => v.u > 4 && v.u < v.lane.length - 4).sort((a, b) => a.d - b.d);
        const choice = choices[0];
        if (!choice || choice.d > 4) throw new Error('Кликните по полосе вдали от перекрёстка');
        link = choice.link;
        lane = choice.lane;
        placedAt = choice.u + CAR_SIZE.l / 2;
      }
      if (!link || !lane || link.toNode === null) throw new Error('На этой улице нет встречной полосы');
      const axis = game.roads.net.corridor(link.corridor).lut.closest((spot ?? c.car.place!.spot).d.curb).s;
      const near = link.flow > 0 ? axis - link.s0 : link.s1 - axis;
      const start = placedAt ?? Math.max(5, near - 40);
      let sim = null;
      for (let u = start; u > 3 && !sim; u -= 18) {
        if (game.traffic.clearToJoin(lane.id, u - CAR_SIZE.l - 1, u + 1)) sim = game.traffic.placeOnLane({ ...spec, targetNode: link.toNode }, lane.id, u);
        if (placedAt !== undefined) break;
      }
      if (!sim) throw new Error('Место появления на полосе занято');
      if (kind === 'stopped') game.traffic.holdAfter(sim, 0);
      else sim.v = 12;
    }
    debugId--;
  };
  return { game, cases, errors, tick, startAction, spawn, lines: {}, view: { x0: 1260, y0: 850, x1: 2515, y1: 2620 } };
}

function depart(game: Game, c: ParkingCase, errors: string[]): void {
  const trip = { kind: 'out' as const, car: c.car, town: c.town };
  const g = game.garages;
  if (c.target === 'curb') {
    const v = game.carHomes.curbVisit(c.destination, c.car.home.anchor);
    if (!v) return;
    game.carHomes.depart(trip, c.destination, { parked: c.obstacles, target: v.link.toNode!, endLink: v.link.id, then: (sim) => game.carHomes.toCurbVisit(sim, trip, v) });
  } else {
    const shop = c.target === 'shop' ? game.shops.lotOf(c.destination) : null;
    const spot = shop?.spots.find((s) => g.slotOf(s)) ?? (c.lot && game.lots.spotFor(c.lot, false)[0]);
    const slot = spot && g.slotOf(spot);
    if (!spot || !slot) {
      const error = `${c.title}: нет подъезда к цели`;
      if (!errors.includes(error)) errors.push(error);
      return;
    }
    game.carHomes.depart(trip, c.destination, {
      parked: c.obstacles, target: slot.link.toNode!, endLink: slot.link.id, to: spot,
      then: (sim) => {
        if (shop) game.shops.start(sim, { town: c.town, lot: shop, planned: spot, slot, n: c.arrivals + 1 }, game.carHomes.visit(c.car, c.town));
        else if (c.lot) game.carHomes.toLotVisit(sim, trip, { town: c.town, lot: c.lot }, { spot, slot }, () => errors.push(`${c.title}: машина не припарковалась`), c.destination);
      },
    });
  }
  c.phase = 'outbound';
}
