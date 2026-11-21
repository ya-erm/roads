import { describe, expect, it } from 'vitest';
import { ECONOMY, MONTH_LENGTH, STATION } from '../config';
import { dist } from '../core/vec';
import type { Station, Town, TownBuilding } from '../world/entities';
import { receiverOf } from '../world/retail';
import { DEFAULT_SETTINGS } from '../world/settings';
import { formOf } from '../world/townForms';
import { advise, adviceOf, QUEUE_SECONDS, STUCK_SECONDS } from './advisor';
import { Game } from './game';
import { connectStations, freshGame, HIGHWAY, stationAtIndustry } from './testkit';
import type { FleetVehicle, Line } from './transport';

/** Песочница с маршрутом сырьё → ближайший завод: станции у обоих и грузовик. */
function setup(seed = 42) {
  const game = freshGame({ ...DEFAULT_SETTINGS, seed });
  game.money = 5_000_000;
  const plant = game.industries.find((i) => i.info.accepts.length === 1)!;
  const input = plant.info.accepts[0];
  const near = (a: { fp: { center: { x: number; y: number } } }) => Math.hypot(a.fp.center.x - plant.fp.center.x, a.fp.center.y - plant.fp.center.y);
  const raw = game.industries.filter((i) => i.info.produces === input).sort((a, b) => near(a) - near(b))[0];
  const a = stationAtIndustry(game, raw, plant.fp.center)!;
  const b = stationAtIndustry(game, plant, raw.fp.center)!;
  const line = game.createLine([a.id, b.id])!;
  const truck = game.buyVehicle(line.id, 'truck')!;
  return { game, raw, plant, input, a, b, line, truck };
}

const find = (game: Game, kind: string) => advise(game).filter((x) => x.kind === kind);

describe('Советник', () => {
  it('груз копится, а машин мало: совет купить машину; авто-парк упёрся в максимум — поднять максимум', () => {
    const { game, a, line, input } = setup();
    expect(find(game, 'waiting')).toHaveLength(0);
    a.cargo[input] = 200;
    const [w] = find(game, 'waiting');
    expect(w).toMatchObject({ level: 'warn', line: line.id, station: a.id, cargo: input, count: 200, fix: { kind: 'buy', line: line.id } });
    // Авто-парк может докупать сам — совета нет; упёрся в максимум — поднять максимум.
    game.setLineAuto(line.id, { on: true, min: 1, max: 4 });
    expect(find(game, 'waiting')).toHaveLength(0);
    game.setLineAuto(line.id, { max: 1 });
    expect(find(game, 'waiting')[0].fix).toEqual({ kind: 'autoMax', line: line.id });
  });

  it('авто-парку не хватает денег — сколько нужно и сколько есть, совет взять кредит; на грани банкротства — срочный совет', () => {
    const { game, line } = setup();
    game.setLineAuto(line.id, { on: true });
    line.auto!.noMoney = true;
    // Денег на счёте с запасом — покупка ждала их, но теперь хватает: совета нет (случай из задачи).
    expect(find(game, 'noMoney')).toHaveLength(0);
    // Выручки ещё не было — нужна цена грузовика и запас на месяц содержания двух грузовиков.
    game.money = 10_000;
    const [a] = find(game, 'noMoney');
    const f = game.autoFunds(line);
    expect(f).toMatchObject({ ok: false, price: 22_000, have: 10_000 });
    expect(f.reserve).toBeGreaterThan(0);
    expect(a).toMatchObject({ level: 'warn', line: line.id, fix: { kind: 'loan' }, funds: { have: 10_000, need: f.need } });
    expect(a.detail).toContain(`нужно $${f.need.toLocaleString('ru-RU')}`);
    expect(a.detail).toContain('на содержание транспорта на 30 с вперёд');
    expect(a.detail).toContain('а на счёте $10');
    // Маршрут окупает содержание — запас не нужен, не хватает только на саму машину.
    line.revenueLast = 1_000_000;
    game.money = -5_000;
    const [b] = find(game, 'noMoney');
    expect(b.funds).toEqual({ have: -5_000, need: 22_000 });
    expect(b.detail).toMatch(/^«.+» ждёт машину: машина стоит \$22.000, а на счёте −\$5.000\. Кредит — ещё до/);
    game.money = 22_000;
    expect(find(game, 'noMoney')).toHaveLength(0);
    // Грань банкротства — по счёту и темпу содержания: над кредитным пределом — на 20 с содержания — ещё нет, на 10 с — да.
    const perSecond = game.upkeepForecast().total / MONTH_LENGTH;
    game.money = ECONOMY.creditLimit + perSecond * 20;
    expect(find(game, 'debt')).toHaveLength(0);
    game.money = ECONOMY.creditLimit + perSecond * 10;
    const list = advise(game);
    expect(list[0]).toMatchObject({ kind: 'debt', level: 'alert', fix: { kind: 'loan' } });
    expect(list[0].detail).toContain('без выручки через 10 с станет меньше −$200');
    // Ниже предела — уже банкротство.
    game.money = ECONOMY.creditLimit - 1;
    expect(find(game, 'debt')[0].detail).toMatch(/^На счёте −\$200.001, ниже −\$200.000 — банкротство\./);
    // Кредит на пределе — брать нечего.
    game.loan = game.loanMax;
    expect(find(game, 'debt')[0].fix).toBeUndefined();
  });

  it('машины не могут выехать со станции дольше полуминуты — срочный совет у станции', () => {
    const { game, a, truck } = setup();
    truck.state = 'departing';
    truck.simId = null;
    truck.stop = 0;
    (game as unknown as { readyAt: Map<number, number> }).readyAt.set(truck.id, game.time - (STUCK_SECONDS + 10));
    expect(game.departWait(truck)).toBeCloseTo(STUCK_SECONDS + 10);
    expect(find(game, 'stuck')[0]).toMatchObject({ level: 'alert', station: a.id, count: 1, at: a.fp.center });
    // Уехал — совета нет.
    truck.state = 'driving';
    expect(find(game, 'stuck')).toHaveLength(0);
  });

  it('очередь на въезд — совет добавить пост; постов уже максимум — без кнопки', () => {
    const { game, b, line } = setup();
    const second = game.buyVehicle(line.id, 'truck')!;
    const waits = (game as unknown as { bayWaitSince: Map<number, number> }).bayWaitSince;
    for (const v of [line.vehicles.map((id) => game.fleet.get(id)!)[0], second]) {
      v.state = 'driving';
      v.stop = 1;
      v.simId = 999_000 + v.id;
      waits.set(v.id, game.time - (QUEUE_SECONDS + 5));
    }
    expect(find(game, 'queue')[0]).toMatchObject({ level: 'warn', station: b.id, count: 2, fix: { kind: 'bay', station: b.id } });
    b.bays = STATION.maxBays;
    expect(find(game, 'queue')[0].fix).toBeUndefined();
  });

  it('маршрут не работает, маршрут без машин, машины ездят полупустыми', () => {
    const { game, line, a, b, input } = setup(3);
    line.problem = 'Нет дороги: A → B';
    expect(find(game, 'noRoute')[0]).toMatchObject({ level: 'alert', line: line.id, station: line.stops[0] });
    line.problem = null;
    const empty = game.createLine([b.id, a.id])!;
    // Между станциями нет дороги — совет о дороге, а не о машинах (и без кнопки «купить»).
    expect(find(game, 'noVehicles').filter((x) => x.line === empty.id)).toHaveLength(0);
    const noRoad = find(game, 'noRoute').find((x) => x.line === empty.id)!;
    expect(noRoad).toMatchObject({ level: 'tip', title: 'Маршрут без дороги', key: `noRoad:${empty.id}` });
    expect(noRoad.fix).toBeUndefined();
    expect(connectStations(game, a, b, HIGHWAY)).toBe(true);
    expect(find(game, 'noRoute').filter((x) => x.line === empty.id)).toHaveLength(0);
    expect(find(game, 'noVehicles')[0]).toMatchObject({ level: 'tip', line: empty.id, fix: { kind: 'buy', line: empty.id } });
    expect(find(game, 'noVehicles')[0].detail).not.toContain('ждут');
    // Груз копится на станциях маршрута и без машин — совет говорит, сколько уже ждёт.
    a.cargo[input] = 12;
    expect(find(game, 'noVehicles')[0].detail).toContain('ждут 12 ед. груза');
    game.buyVehicle(line.id, 'truck');
    line.loadLast = 0.1;
    expect(find(game, 'empty')[0]).toMatchObject({ level: 'tip', line: line.id, fix: { kind: 'sell', line: line.id } });
    expect(game.spareOf(line)).not.toBeNull();
  });

  it('продукцию завода не вывозит ни один маршрут; заводу на два сырья привезли одно', () => {
    const { game, plant } = setup();
    plant.producedLast = 50;
    // Маршрут только привозит сырьё на завод — его продукцию никто не забирает.
    expect(find(game, 'unsold')[0]).toMatchObject({ industry: plant.id, cargo: plant.info.produces, count: 50 });
    plant.producedLast = 0;
    expect(find(game, 'unsold')).toHaveLength(0);

    const two = game.industries.find((i) => i.info.accepts.length >= 2)!;
    expect(stationAtIndustry(game, two, { x: two.fp.center.x, y: two.fp.center.y - 500 })).not.toBeNull();
    const [have, lack] = two.info.accepts;
    two.stock[have] = 40;
    two.stock[lack] = 0;
    two.producedLast = 0;
    expect(find(game, 'missingInput')[0]).toMatchObject({ industry: two.id, cargo: lack });
    two.stock[lack] = 10;
    expect(find(game, 'missingInput')).toHaveLength(0);
  });

  it('срочные советы — первыми; для кадра советы пересчитываются не чаще раза в полсекунды', () => {
    const { game, a, line, input } = setup();
    a.cargo[input] = 200;
    line.problem = 'Нет дороги';
    const list = advise(game);
    expect(list.map((x) => x.level)).toEqual([...list.map((x) => x.level)].sort((p, q) => ['alert', 'warn', 'tip'].indexOf(p) - ['alert', 'warn', 'tip'].indexOf(q)));
    expect(list[0].kind).toBe('noRoute');
    const first = adviceOf(game);
    expect(adviceOf(game)).toBe(first);
    game.time += 1;
    expect(adviceOf(game)).not.toBe(first);
  });
});

/** Приватное игры — рейс без долгой езды. */
type Inner = { handleStop(v: FleetVehicle, st: Station, line: Line): void };
const inner = (g: Game) => g as unknown as Inner;

/** Грузовая станция у дома города, которая продукты не принимает (в охвате нет магазинов с ними). */
function stationWithoutShops(game: Game): { town: Town; st: Station } {
  for (const town of game.towns) {
    if (!town.receivers?.some((r) => !r.depot && r.cargo.includes('food'))) continue;
    const houses = town.buildings.filter((b) => b.kind === 'res').sort((p, q) => dist(q.fp.center, town.center) - dist(p.fp.center, town.center));
    for (const h of houses.slice(0, 12)) {
      const st: Station = {
        type: 'station',
        id: game.nextId(),
        kind: 'road',
        name: 'На окраине',
        fp: { center: { ...h.fp.center }, w: 30, h: 20, angle: 0 },
        nodeId: -1,
        platforms: [],
        serves: { pax: false, cargo: true },
        industryId: null,
        cargo: {},
        passengers: new Map(),
        occupied: [],
        bays: 2,
        townIds: [],
        industryIds: [],
        accepts: new Set(),
        catchPop: 0,
        paxAcc: 0,
      };
      game.stations.set(st.id, st);
      game.computeCatchment(st);
      if (st.townIds.includes(town.id) && !st.accepts.has('food')) return { town, st };
      game.stations.delete(st.id);
    }
  }
  throw new Error('нет станции без магазинов');
}

/** Продуктовый магазин города (не рынок), к которому подъехать. */
function foodShop(game: Game, town: Town): TownBuilding {
  return (town.receivers ?? [])
    .filter((r) => !r.depot && r.cargo.includes('food'))
    .map((r) => town.buildings.find((b) => b.id === r.b)!)
    .find((b) => b && formOf(b) !== 'market' && game.docks.reachable(b, 15) && !game.docks.reachable(b, 21))!;
}

describe('Советник: получатели грузов (docs/RETAIL.md)', () => {
  const RETAIL_WORLD = { ...DEFAULT_SETTINGS, seed: 7, retail: true };

  it('груз привезли на станцию в городе, а там его не берут — «Груз остался в кузове», кнопка «🛒 все магазины»', () => {
    const game = freshGame(RETAIL_WORLD);
    game.money = 5_000_000;
    const { town, st } = stationWithoutShops(game);
    const line = game.createLine([st.id, game.dockFor(foodShop(game, town))!.id])!;
    const v = game.buyVehicle(line.id, 'truck')!;
    v.stop = 0;
    v.cargo = 'food';
    v.amount = 12;
    v.loadedAt = -1;
    v.fromStore = true;
    expect(find(game, 'kept')).toHaveLength(0);
    inner(game).handleStop(v, st, line);
    expect(v.amount).toBe(12);
    const [a] = find(game, 'kept');
    expect(a).toMatchObject({ level: 'warn', line: line.id, station: st.id, cargo: 'food', count: 12 });
    expect(a.title).toBe('Груз остался в кузове');
    expect(a.detail).toContain('магазинах 🛒');
    // Не все продуктовые магазины в маршруте — быстрое действие: добавить их.
    if (game.shopTargets(line.stops, 'food').length) expect(a.fix).toEqual({ kind: 'shops', line: line.id });
    // Давно (больше полутора месяцев) — совета нет.
    game.time += MONTH_LENGTH * 2;
    expect(find(game, 'kept')).toHaveLength(0);
  });

  it('грузовики возвращаются на станцию погрузки с грузом — «Магазины полны — лишняя машина»', () => {
    const game = freshGame(RETAIL_WORLD);
    game.money = 5_000_000;
    const { town, st } = stationWithoutShops(game);
    const line = game.createLine([st.id, game.dockFor(foodShop(game, town))!.id])!;
    const v = game.buyVehicle(line.id, 'truck')!;
    const w = game.buyVehicle(line.id, 'truck')!;
    for (const x of [v, w]) {
      x.stop = 0;
      x.cargo = 'food';
      x.amount = 14;
      x.loadedAt = st.id;
      inner(game).handleStop(x, st, line);
      expect(find(game, 'shopsFull')).toHaveLength(x === v ? 0 : 1);
    }
    expect(find(game, 'shopsFull')[0]).toMatchObject({ level: 'tip', line: line.id, cargo: 'food', fix: { kind: 'sell', line: line.id } });
    // Вернулся пустым — счёт заново.
    w.cargo = null;
    w.amount = 0;
    w.loadedAt = null;
    inner(game).handleStop(w, st, line);
    expect(find(game, 'shopsFull')).toHaveLength(0);
  });

  it('магазин пустует месяцами, а город снабжают — «пустует N мес.»; город не снабжают — совета нет', () => {
    const game = freshGame(RETAIL_WORLD);
    const town = game.towns.find((t) => (t.receivers ?? []).filter((r) => !r.depot).length >= 2)!;
    const [r, other] = town.receivers!.filter((x) => !x.depot);
    r.dry = 3;
    expect(find(game, 'shopDry')).toHaveLength(0);
    other.fed = true;
    const [a] = find(game, 'shopDry');
    expect(a.title).toMatch(/пустует 3 мес\.$/);
    expect(a.detail).toContain('не растёт');
    expect(a.at).toEqual(town.buildings.find((b) => b.id === r.b)!.fp.center);
  });

  it('Фура на маршруте к магазинам — «Фура не заезжает к магазинам»: на базу ⇄, если она в городе есть', () => {
    const game = freshGame(RETAIL_WORLD);
    game.money = 5_000_000;
    game.openModelTier(3, true);
    const town = game.towns.find((t) => t.receivers?.some((r) => r.depot) && t.receivers.some((r) => !r.depot && r.cargo.includes('food')))!;
    const depot = town.buildings.find((b) => receiverOf(town, b.id)?.depot)!;
    const line = game.createLine([game.dockFor(foodShop(game, town))!.id, game.dockFor(depot)!.id])!;
    game.buyVehicle(line.id, 'truck2');
    expect(find(game, 'semiShop')).toHaveLength(0);
    game.buyVehicle(line.id, 'truck3');
    const [a] = find(game, 'semiShop');
    expect(a).toMatchObject({ level: 'warn', line: line.id, title: 'Фура не заезжает к магазинам' });
    expect(a.detail).toContain('базу ⇄');
  });

  it('старая партия (без получателей) — этих советов нет', () => {
    const { game } = setup();
    for (const t of game.towns) for (const r of t.receivers ?? []) r.dry = 5;
    expect(advise(game).filter((a) => ['kept', 'shopsFull', 'shopDry', 'semiShop'].includes(a.kind))).toHaveLength(0);
  });
});
