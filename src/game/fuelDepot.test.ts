import { describe, expect, it } from 'vitest';
import { ECONOMY, STATION } from '../config';
import { dist, dot, sub } from '../core/vec';
import { CARGO } from '../world/cargo';
import type { Station, Town, TownBuilding } from '../world/entities';
import { maxTruck, receiverOf, RETAIL, stockCap } from '../world/retail';
import { DEFAULT_SETTINGS } from '../world/settings';
import { formOf } from '../world/townForms';
import { Game } from './game';
import { freshGame, runSeconds } from './testkit';
import { type FleetVehicle, type Line, MODELS, type RoadModel } from './transport';

/**
 * Этап 3 получателей грузов (docs/RETAIL.md): АЗС со сквозным проездом бензовоза, оптовая база — склад-пересадка,
 * «🛒 все магазины с этим грузом», рост к снабжённым магазинам, две рампы у рынка.
 */

/** Партия с получателями (WorldSettings.retail) по миру seed 7. */
const RETAIL_WORLD = { ...DEFAULT_SETTINGS, seed: 7, retail: true };
const TRUCK = (MODELS.truck as RoadModel).spec;

type Inner = {
  handleStop(v: FleetVehicle, st: Station, line: Line): void;
  growTown(t: Town): void;
  retailGrowth(t: Town): { pulls: { x: number; y: number }[]; blocks: { x: number; y: number }[] };
};
const inner = (g: Game) => g as unknown as Inner;

/** Дома-получатели города вида form, к двору которых подъедет грузовик длины L. */
function receiversOf(game: Game, town: Town, form: string, L = TRUCK.length): TownBuilding[] {
  return (town.receivers ?? [])
    .map((r) => town.buildings.find((b) => b.id === r.b)!)
    .filter((b) => b && formOf(b) === form && game.docks.reachable(b, L));
}

/** Город с получателем вида form (и ещё одним получателем любого вида — вторая остановка маршрута). */
function townWith(game: Game, form: string, L = TRUCK.length): { town: Town; b: TownBuilding; other: TownBuilding } {
  for (const town of game.towns) {
    const [b] = receiversOf(game, town, form, L);
    const other = (town.receivers ?? [])
      .map((r) => town.buildings.find((x) => x.id === r.b)!)
      .find((x) => x && x !== b && formOf(x) !== form && maxTruck(x) >= L && game.docks.reachable(x, L));
    if (b && other) return { town, b, other };
  }
  throw new Error(`нет получателя «${form}»`);
}

/** Едет вперёд, пока cond не выполнится (не дольше seconds); true — дождались. */
function until(game: Game, seconds: number, cond: () => boolean, each?: () => void): boolean {
  for (let t = 0; t < seconds; t += 0.1) {
    runSeconds(game, 0.1);
    each?.();
    if (cond()) return true;
  }
  return false;
}

describe('Получатели грузов, этап 3', { timeout: 240_000 }, () => {
  it('АЗС и оптовая база — в новой партии: АЗС по 1 + жители/6000 (≤ 3) у городов, которым нужно топливо; база — от 2500', () => {
    const game = freshGame(RETAIL_WORLD);
    let fuels = 0;
    for (const t of game.towns) {
      const n = (f: string) => t.buildings.filter((b) => b.kind === 'com' && formOf(b) === f).length;
      const want = t.demands.includes('fuel') ? Math.min(3, 1 + Math.floor(t.population / 6000)) : 0;
      expect(n('fuel')).toBeLessThanOrEqual(want);
      fuels += n('fuel');
      expect(n('depot')).toBeLessThanOrEqual(t.population >= RETAIL.depotPop ? 1 : 0);
      // АЗС — получатель топлива: топливо город больше не принимает «по-старому».
      if (n('fuel')) {
        const r = t.receivers!.filter((x) => x.cargo.includes('fuel') && !x.depot);
        expect(r.length).toBe(n('fuel'));
        expect(r.every((x) => !x.depot && formOf(t.buildings.find((b) => b.id === x.b)!) === 'fuel')).toBe(true);
      }
      for (const b of t.buildings.filter((x) => formOf(x) === 'fuel' || formOf(x) === 'depot')) expect(maxTruck(b)).toBe(21);
    }
    expect(fuels).toBeGreaterThan(3);
    expect(game.towns.some((t) => t.buildings.some((b) => formOf(b) === 'depot'))).toBe(true);
    // Старая партия (без retail) — ни АЗС, ни баз.
    const old = freshGame({ ...DEFAULT_SETTINGS, seed: 7 });
    expect(old.towns.every((t) => t.buildings.every((b) => formOf(b) !== 'fuel' && formOf(b) !== 'depot'))).toBe(true);
  });

  it('бензовоз заезжает на АЗС сквозным проездом: въезд у одного края, слив у люков, выезд у другого — без заднего хода', () => {
    const game = freshGame(RETAIL_WORLD);
    const semi = MODELS.truck3 as RoadModel;
    const { town, b, other } = townWith(game, 'fuel', semi.spec.length);
    const sa = game.dockFor(other)!;
    const sb = game.dockFor(b)!;
    expect([...sb.accepts]).toEqual(['fuel']);
    const line = game.createLine([sa.id, sb.id])!;
    game.money = 5_000_000;
    game.openModelTier(3, true);
    const v = game.buyVehicle(line.id, 'truck3')!;
    v.cargo = 'fuel';
    v.amount = 6;
    v.loadedAt = sa.id;
    v.fromStore = true;
    const geo = game.docks.geoOf(b, semi.spec.length, semi.spec.width)!;
    expect(geo.yard.kind).toBe('through');
    expect(dist(geo.d.curb, geo.exitD!.curb)).toBeGreaterThan(20);
    const supplied = town.supplied.fuel ?? 0;
    // Во дворе — только передом: курс машины и её ход не расходятся.
    let prev: { x: number; y: number } | null = null;
    let back = 0;
    const track = () => {
      const p = game.docks.poseOf(v.id);
      if (p && prev && dist(p.pos, prev) > 0.05 && dot(sub(p.pos, prev), p.dir) < 0) back++;
      prev = p ? p.pos : null;
    };
    expect(until(game, 260, () => v.stop === 1 && v.state === 'loading' && game.docks.inYard(v.id) && !game.docks.entering(v.id), track)).toBe(true);
    // У люков: середина кузова — на проезде вдоль улицы, курс — вдоль него.
    const pose = game.docks.poseOf(v.id)!;
    expect(Math.abs(dot(pose.dir, geo.d.dir))).toBeLessThan(0.05);
    expect(town.supplied.fuel).toBe(supplied + 6);
    expect(v.amount).toBe(0);
    let joinAt: { x: number; y: number } | null = null;
    expect(
      until(
        game,
        160,
        () => v.state === 'driving' && !!game.fleetSim(v) && !game.docks.inYard(v.id),
        () => {
          track();
          const sim = game.fleetSim(v);
          if (sim && game.docks.inYard(v.id) && !joinAt) joinAt = { ...sim.pos };
        },
      ),
    ).toBe(true);
    expect(back).toBe(0);
    // Выехал из второго проезда — ближе к нему, чем к въезду.
    expect(dist(joinAt!, geo.exitD!.curb)).toBeLessThan(dist(joinAt!, geo.d.curb));
  });

  it('оптовая база оплачивает принятый груз сразу, магазин оплачивает развозку от базы', () => {
    const game = freshGame(RETAIL_WORLD);
    const town = game.towns.find((t) => t.receivers?.some((r) => r.depot) && t.demands.includes('food'))!;
    const depotB = town.buildings.find((b) => receiverOf(town, b.id)?.depot)!;
    expect(formOf(depotB)).toBe('depot');
    const shopB = receiversOf(game, town, 'shop').find((b) => receiverOf(town, b.id)!.cargo.includes('food'))!;
    const sd = game.dockFor(depotB)!;
    const ss = game.dockFor(shopB)!;
    expect(game.isDepotDock(sd)).toBe(true);
    for (const c of town.demands) expect(sd.accepts.has(c)).toBe(true);
    // Станция у дальнего завода — «первая погрузка».
    const far = [...game.stations.values()].find((s) => s.kind !== 'dock') ?? game.dockFor(receiversOf(game, game.towns.find((t) => t !== town)!, 'shop')[0])!;
    const line = game.createLine([sd.id, ss.id])!;
    game.money = 5_000_000;
    const fura = game.buyVehicle(line.id, 'truck')!;
    fura.stop = 0;
    fura.cargo = 'food';
    fura.amount = RETAIL.depotStock + 30;
    fura.loadedAt = far.id;
    fura.fromStore = true;
    const money = game.money;
    const revenue = line.revenueTotal;
    const supplied = town.supplied.food ?? 0;
    inner(game).handleStop(fura, sd, line);
    const pay = (n: number, distance: number) => Math.round((n * CARGO.food.rate * ECONOMY.tariff * distance) / 100);
    const wholesalePay = pay(RETAIL.depotStock, dist(far.fp.center, sd.fp.center));
    expect(wholesalePay).toBeGreaterThan(0);
    // На склад базы — до 150, оплачивается только принятое количество.
    expect(sd.cargo.food).toBe(RETAIL.depotStock);
    expect(fura.amount).toBe(30);
    expect(fura.paidAt).toBeUndefined();
    expect(game.money - money).toBe(wholesalePay);
    expect(line.revenueTotal - revenue).toBe(wholesalePay);
    expect(town.supplied.food ?? 0).toBe(supplied);
    expect(game.depotStock(depotB.id).fill).toBe(1);
    inner(game).handleStop(fura, sd, line);
    expect(game.money - money).toBe(wholesalePay);
    // Для развозки груз помнит исходного отправителя и оплаченное плечо.
    const van = game.buyVehicle(line.id, 'truck')!;
    van.stop = 0;
    van.cargo = null;
    van.amount = 0;
    const stored = sd.cargo.food!;
    inner(game).handleStop(van, sd, line);
    expect(van.cargo).toBe('food');
    expect(van.amount).toBeGreaterThan(0);
    expect(van.loadedAt).toBe(far.id);
    expect(van.paidAt).toBe(sd.id);
    expect(sd.cargo.food).toBe(stored - van.amount);
    // В магазине оплачивается только плечо от базы, принятое считается снабжением города.
    const r = receiverOf(town, shopB.id)!;
    r.stock.food = 0;
    r.at = game.time;
    const room = Math.min(van.amount, stockCap(town, r, 'food'));
    const before = game.money;
    van.stop = 1;
    inner(game).handleStop(van, ss, line);
    expect(game.money - before).toBe(pay(room, dist(sd.fp.center, ss.fp.center)));
    expect(town.supplied.food).toBe(supplied + room);
    // База без маршрутов, но с грузом на складе, остаётся (груз не пропадает).
    game.deleteLine(line.id);
    expect(game.stations.has(sd.id)).toBe(true);
    expect(game.stations.has(ss.id)).toBe(false);
  });

  it('на складе из старой партии сохраняется оплата за весь маршрут даже при поступлении новых партий того же груза', () => {
    const game = freshGame(RETAIL_WORLD);
    const town = game.towns.find((t) => t.receivers?.some((r) => r.depot) && t.demands.includes('food'))!;
    const depotB = town.buildings.find((b) => receiverOf(town, b.id)?.depot)!;
    const shopB = receiversOf(game, town, 'shop').find((b) => receiverOf(town, b.id)!.cargo.includes('food'))!;
    const otherTown = game.towns.find((t) => t !== town)!;
    const legacySource = game.dockFor(receiversOf(game, otherTown, 'shop')[0])!;
    const sd = game.dockFor(depotB)!;
    const ss = game.dockFor(shopB)!;
    const line = game.createLine([sd.id, ss.id])!;
    game.createLine([legacySource.id, sd.id]);
    const truck = game.buyVehicle(line.id, 'truck')!;
    // Запись старого формата без разбивки на партии.
    sd.cargo.food = 4;
    sd.cargoOrigin = { food: legacySource.id };
    truck.cargo = 'food';
    truck.amount = 9;
    truck.loadedAt = legacySource.id;
    truck.fromStore = true;
    inner(game).handleStop(truck, sd, line);
    expect(sd.cargo.food).toBe(13);

    const saved = JSON.parse(JSON.stringify(game.toSave()));
    const restored = new Game(RETAIL_WORLD, saved);
    const depot = restored.stations.get(sd.id)!;
    const shop = restored.stations.get(ss.id)!;
    const route = restored.lines.get(line.id)!;
    const van = restored.fleet.get(truck.id)!;
    van.stop = 0;
    inner(restored).handleStop(van, depot, route);
    expect(van.amount).toBe(4);
    expect(van.loadedAt).toBe(legacySource.id);
    expect(van.paidAt).toBeUndefined();
    expect(depot.cargo.food).toBe(9);
    const shopTown = restored.towns.find((t) => t.id === town.id)!;
    const receiver = receiverOf(shopTown, shopB.id)!;
    receiver.stock.food = 0;
    receiver.at = restored.time;
    const before = restored.money;
    van.stop = 1;
    inner(restored).handleStop(van, shop, route);
    const legacyPay = Math.round((4 * CARGO.food.rate * ECONOMY.tariff * dist(legacySource.fp.center, ss.fp.center)) / 100);
    expect(restored.money - before).toBe(legacyPay);

    van.stop = 0;
    inner(restored).handleStop(van, depot, route);
    expect(van.amount).toBe(9);
    expect(van.paidAt).toBe(sd.id);
    expect(depot.cargo.food).toBe(0);
  });

  it('местные магазины забирают оплаченный груз с базы по мере свободного места, дальний магазин ждёт развозку', () => {
    const game = freshGame(RETAIL_WORLD);
    const town = game.towns.find((t) => t.receivers?.some((r) => r.depot) && t.receivers.filter((r) => !r.depot && r.cargo.includes('food')).length >= 2)!;
    const depot = town.buildings.find((b) => receiverOf(town, b.id)?.depot)!;
    const dock = game.dockFor(depot)!;
    const shops = town.receivers!.filter((r) => !r.depot && r.cargo.includes('food'));
    const [near, far] = shops;
    const a = town.buildings.find((b) => b.id === near.b)!;
    const b = town.buildings.find((b) => b.id === far.b)!;
    a.fp = { ...a.fp, center: { x: depot.fp.center.x + 8, y: depot.fp.center.y } };
    b.fp = { ...b.fp, center: { x: depot.fp.center.x + STATION.cargoCatchment + 1, y: depot.fp.center.y } };
    const inRange = game.depotReceivers(depot.fp);
    expect(inRange.some((x) => x.b === a)).toBe(true);
    expect(inRange.some((x) => x.b === b || x.b === depot)).toBe(false);
    for (const { town: t, r } of inRange) if (r.cargo.includes('food')) r.stock.food = stockCap(t, r, 'food');
    near.stock.food = stockCap(town, near, 'food') - 3;
    far.stock.food = 0;
    dock.cargo.food = 12;
    dock.paidCargo = { food: [{ origin: 10000, paidAt: dock.id, amount: 2 }, { origin: 20000, paidAt: dock.id, amount: 10 }] };
    const supplied = town.supplied.food ?? 0;
    const income = game.incomeMonth;
    runSeconds(game, RETAIL.depotInterval + 0.1);
    expect(a.retailSupply?.at(-1)?.got.food).toBe(3);
    expect(b.retailSupply?.at(-1)?.got.food ?? 0).toBe(0);
    expect(town.supplied.food).toBe(supplied + 3);
    expect(dock.cargo.food).toBe(9);
    expect(dock.paidCargo.food).toEqual([{ origin: 20000, paidAt: dock.id, amount: 9 }]);
    expect(game.incomeMonth).toBe(income);
    near.stock.food = 0;
    near.at = game.time;
    runSeconds(game, RETAIL.depotInterval + 0.1);
    expect(town.supplied.food).toBe(supplied + 12);
    expect(dock.cargo.food).toBe(0);
    expect(dock.paidCargo.food).toEqual([]);
    expect(game.incomeMonth).toBe(income);
  });

  it('самостоятельная раздача старого запаса оплачивает только неоплаченный подвоз от исходной станции', () => {
    const game = freshGame(RETAIL_WORLD);
    const town = game.towns.find((t) => t.receivers?.some((r) => r.depot) && t.demands.includes('food'))!;
    const depot = town.buildings.find((b) => receiverOf(town, b.id)?.depot)!;
    const dock = game.dockFor(depot)!;
    const receiver = town.receivers!.find((r) => !r.depot && r.cargo.includes('food'))!;
    const shop = town.buildings.find((b) => b.id === receiver.b)!;
    shop.fp = { ...shop.fp, center: { x: depot.fp.center.x + 20, y: depot.fp.center.y } };
    receiver.stock.food = 0;
    const sourceTown = game.towns.find((t) => t !== town)!;
    const source = game.dockFor(receiversOf(game, sourceTown, 'shop')[0])!;
    game.createLine([source.id, dock.id]);
    dock.cargo = { food: 10 };
    dock.cargoOrigin = { food: source.id };
    dock.paidCargo = { food: [{ origin: source.id, paidAt: dock.id, amount: 6 }] };
    const restored = new Game(RETAIL_WORLD, JSON.parse(JSON.stringify(game.toSave())));
    const before = restored.incomeMonth;
    const expected = Math.round(4 * CARGO.food.rate * ECONOMY.tariff * dist(source.fp.center, dock.fp.center) / 100);
    runSeconds(restored, RETAIL.depotInterval * 2 + 0.1);
    expect(restored.stations.get(dock.id)!.cargo.food).toBe(0);
    expect(restored.incomeMonth - before).toBe(expected);
  });

  it('«🛒 все магазины с этим грузом»: магазины города — в конец маршрута, по порядку ближайшего соседа от последней остановки', () => {
    const game = freshGame(RETAIL_WORLD);
    const town = game.towns.find((t) => receiversOf(game, t, 'shop').filter((b) => receiverOf(t, b.id)!.cargo.includes('food')).length >= 3)!;
    const food = (town.receivers ?? [])
      .filter((r) => !r.depot && r.cargo.includes('food'))
      .map((r) => town.buildings.find((b) => b.id === r.b)!)
      .filter((b) => game.docks.reachable(b, TRUCK.length));
    const [a, b] = food;
    const line = game.createLine([game.dockFor(a)!.id, game.dockFor(b)!.id])!;
    game.money = 5_000_000;
    game.buyVehicle(line.id, 'truck');
    expect(game.shopCargo(line.stops)).toBe('food');
    const targets = game.shopTargets(line.stops, 'food', TRUCK.length);
    expect(targets.length).toBe(food.length - 2);
    // Ближайший сосед: каждый следующий — ближайший к предыдущему из оставшихся.
    let at = b.fp.center;
    const left = [...targets];
    for (const t of targets) {
      const best = Math.min(...left.map((x) => dist(x.fp.center, at)));
      expect(dist(t.fp.center, at)).toBeCloseTo(best);
      left.splice(left.indexOf(t), 1);
      at = t.fp.center;
    }
    const added = game.addShopStops(line.stops, line);
    expect(added.length).toBe(targets.length);
    expect(line.stops.slice(2).map((id) => game.stations.get(id)!.dock!.b)).toEqual(targets.map((x) => x.id));
    // Второй раз — добавлять нечего.
    expect(game.shopTargets(line.stops, 'food', TRUCK.length)).toEqual([]);
  });

  it('две рампы у рынка: второй грузовик встаёт ко второй, третьему — ждать', () => {
    const game = freshGame(RETAIL_WORLD);
    const town = game.towns.find((t) => receiversOf(game, t, 'market').some((b) => game.docks.rampCount(b) === 2))!;
    const market = receiversOf(game, town, 'market').find((b) => game.docks.rampCount(b) === 2)!;
    const g0 = game.docks.geoOf(market, TRUCK.length, TRUCK.width, 0)!;
    const g1 = game.docks.geoOf(market, TRUCK.length, TRUCK.width, 1)!;
    // Проезды — у разных краёв участка, с одной связи улицы.
    expect(dist(g0.d.curb, g1.d.curb)).toBeGreaterThan(20);
    expect(g0.in!.link.id).toBe(g1.in!.link.id);
    expect(game.docks.freeRamp(market, 1)).toBe(0);
    expect(game.docks.stand(1, market, TRUCK.length, TRUCK.width)).toBe(true);
    expect(game.docks.rampBusy(market, 2)).toBe(false);
    expect(game.docks.freeRamp(market, 2)).toBe(1);
    expect(game.docks.stand(2, market, TRUCK.length, TRUCK.width)).toBe(true);
    expect(game.docks.rampBusy(market, 3)).toBe(true);
    game.docks.forget(1);
    expect(game.docks.freeRamp(market, 3)).toBe(0);
  });

  it('рост тянется к снабжённым магазинам: у пустого 2 месяца (в снабжаемом городе) дома не прибавляются', () => {
    const game = freshGame(RETAIL_WORLD);
    // В Белогорье есть свободные участки вне зон, которые блокируют пустые магазины.
    const town = game.towns.find((t) => t.name === 'Белогорье')!;
    const list = town.receivers!.filter((r) => !r.depot);
    expect(list.length).toBeGreaterThanOrEqual(4);
    const pos = (id: number) => town.buildings.find((b) => b.id === id)!.fp.center;
    // Один снабжён (груз на складе), остальные пусты два месяца; город уже снабжают.
    const [fed, ...dry] = list;
    for (const r of list) {
      for (const c of r.cargo) r.stock[c] = 0;
      r.at = game.time;
      r.fed = true;
      r.dry = 1;
    }
    fed.stock[fed.cargo[0]] = stockCap(town, fed, fed.cargo[0]);
    delete fed.dry;
    const g = inner(game).retailGrowth(town);
    expect(g.pulls.length).toBe(1);
    expect(g.blocks.length).toBe(dry.length);
    expect(dist(g.pulls[0], pos(fed.b))).toBeLessThan(40);
    expect(dry.every((r) => (r.dry ?? 0) >= 2)).toBe(true);
    // Рост: новых домов у пустых магазинов (дальше от снабжённого) нет.
    for (const r of dry) r.dry = 1;
    fed.stock[fed.cargo[0]] = stockCap(town, fed, fed.cargo[0]);
    const had = new Set(town.buildings.map((b) => b.id));
    town.growthAcc = 4000;
    inner(game).growTown(town);
    const added = town.buildings.filter((b) => !had.has(b.id));
    expect(added.length).toBeGreaterThan(0);
    for (const b of added) for (const p of g.blocks) expect(dist(b.fp.center, p)).toBeGreaterThanOrEqual(RETAIL.block - 1e-6);
  });

  it('сохранение: АЗС, база и их получатели — как были', () => {
    const game = freshGame(RETAIL_WORLD);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const copy = new Game(RETAIL_WORLD, save);
    expect(copy.towns.map((t) => t.buildings.map((b) => b.form))).toEqual(game.towns.map((t) => t.buildings.map((b) => b.form)));
    expect(copy.towns.map((t) => t.receivers)).toEqual(game.towns.map((t) => t.receivers));
  });
});
