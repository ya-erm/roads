import { describe, expect, it } from 'vitest';
import { ECONOMY } from '../config';
import { add, dist, dot, scale } from '../core/vec';
import { CARGO } from '../world/cargo';
import type { Station, Town, TownBuilding } from '../world/entities';
import { legacyCargo, pickReceivers, receiverOf, RETAIL, stockAt, stockCap } from '../world/retail';
import { DEFAULT_SETTINGS } from '../world/settings';
import { Game, type SaveData } from './game';
import { freshGame, runSeconds } from './testkit';
import { type FleetVehicle, type Line, MODELS, type RoadModel } from './transport';

/** Кузов Грузовика (фургон): длина и ширина. */
const TRUCK = (MODELS.truck as RoadModel).spec;

/** Партия с получателями (WorldSettings.retail) по миру seed 7. */
const RETAIL_WORLD = { ...DEFAULT_SETTINGS, seed: 7, retail: true };

/** Приватное игры — для сцен без долгой езды (handleStop, nextStop). */
type Inner = {
  handleStop(v: FleetVehicle, st: Station, line: Line): void;
  nextStop(v: FleetVehicle, line: Line): number | null;
};
const inner = (g: Game) => g as unknown as Inner;

/** Город и два получателя продуктов, к дворам которых можно подъехать (первый — рынок). */
function twoFood(game: Game): { town: Town; a: TownBuilding; b: TownBuilding } {
  for (const town of game.towns) {
    const list = (town.receivers ?? [])
      // Оптовая база — не магазин (склад-пересадка).
      .filter((r) => r.cargo.includes('food') && !r.depot)
      .map((r) => town.buildings.find((x) => x.id === r.b)!)
      .filter((b) => game.docks.reachable(b));
    if (list.length >= 2) return { town, a: list[0], b: list[1] };
  }
  throw new Error('нет двух продуктовых получателей');
}

/** Маршрут между двумя магазинами и грузовик на нём с грузом продуктов «с другой станции» (платят за путь от неё). */
function shopLine(game: Game) {
  const { town, a, b } = twoFood(game);
  const sa = game.dockFor(a)!;
  const sb = game.dockFor(b)!;
  const line = game.createLine([sa.id, sb.id])!;
  game.money = 5_000_000;
  const v = game.buyVehicle(line.id, 'truck')!;
  return { town, a, b, sa, sb, line, v };
}

/** Едет вперёд, пока cond не выполнится (не дольше seconds); true — дождались. */
function until(game: Game, seconds: number, cond: () => boolean): boolean {
  for (let t = 0; t < seconds; t += 0.1) {
    runSeconds(game, 0.1);
    if (cond()) return true;
  }
  return false;
}

describe('Получатели грузов в партии', { timeout: 240_000 }, () => {
  it('новая партия: у городов подобраны получатели, их склады наполовину полны; к большинству можно подъехать', () => {
    const game = freshGame(RETAIL_WORLD);
    expect(game.retail).toBe(true);
    let n = 0;
    let reach = 0;
    for (const t of game.towns) {
      expect(t.receivers).toBeDefined();
      for (const r of t.receivers!) {
        n++;
        const b = t.buildings.find((x) => x.id === r.b)!;
        if (game.docks.reachable(b)) reach++;
        for (const c of r.cargo) expect(t.demands).toContain(c);
      }
    }
    expect(n).toBeGreaterThan(20);
    expect(reach / n).toBeGreaterThan(0.8);
    // Подбор — без случайных чисел: та же партия — те же получатели.
    expect(freshGame(RETAIL_WORLD).towns.map((t) => t.receivers)).toEqual(game.towns.map((t) => t.receivers));
  });

  it('клик по магазину в «Маршруте» — невидимая станция у его двора; ушёл из последнего маршрута — её нет', () => {
    const game = freshGame(RETAIL_WORLD);
    const { a, b } = twoFood(game);
    const sa = game.dockFor(a)!;
    expect(sa.kind).toBe('dock');
    expect(game.dockFor(a)).toBe(sa);
    // Невидима: по клику — сам магазин, не станция.
    expect(game.structureAt(a.fp.center)?.type).toBe('building');
    expect(game.stationNear(a.fp.center, 1)).toBeNull();
    expect(game.receiverAt(a.fp.center)?.b).toBe(a);
    expect([...sa.accepts]).toContain('food');
    expect(game.roads.net.nodes.has(sa.nodeId)).toBe(true);
    const sb = game.dockFor(b)!;
    const line = game.createLine([sa.id, sb.id])!;
    game.pruneDocks();
    expect(game.stations.has(sa.id)).toBe(true);
    game.deleteLine(line.id);
    expect(game.stations.has(sa.id)).toBe(false);
    expect(game.stations.has(sb.id)).toBe(false);
    // Не получатель (жилой дом) — станции нет.
    const house = game.towns[0].buildings.find((x) => x.kind === 'res')!;
    expect(game.dockFor(house)).toBeNull();
  });

  it('грузовик заезжает во двор передом, встаёт задом к рампе, выгружается и выезжает передом в просвет', () => {
    const game = freshGame(RETAIL_WORLD);
    const { b, sa, sb, v } = shopLine(game);
    v.cargo = 'food';
    v.amount = 10;
    v.loadedAt = sa.id;
    v.fromStore = true;
    const geo = game.docks.geoOf(b, TRUCK.length, TRUCK.width)!;
    expect(geo.yard.kind).toBe('turn');
    // Пока сворачивает с полосы — в потоке и стоит (его держит манёвр); дальше — во дворе, без машины в потоке.
    let turning = false;
    expect(
      until(game, 200, () => {
        const sim = game.fleetSim(v);
        if (sim && game.docks.inYard(v.id)) turning = true;
        return v.stop === 1 && v.state === 'loading' && game.docks.inYard(v.id) && !game.docks.entering(v.id);
      }),
    ).toBe(true);
    expect(turning).toBe(true);
    expect(v.simId).toBeNull();
    // У рампы: корма у стены, нос — от неё.
    const pose = game.docks.poseOf(v.id)!;
    const center = add(pose.pos, scale(pose.dir, -TRUCK.length / 2));
    expect(dist(center, geo.ramp.c)).toBeLessThan(0.5);
    expect(dot(pose.dir, geo.d.dir)).toBeGreaterThan(0.99);
    // Выгрузил: в магазин B (продукты везли «со» станции A).
    const stop = game.journal.entries.filter((e) => e.k === 'stop' && e.st === sb.id).pop()!;
    expect(stop.drop).toEqual({ food: 10 });
    expect(v.amount).toBe(0);
    // Выезжает: от рампы к бордюру, ждёт просвета, встаёт на полосу передом по ходу и едет к следующей остановке.
    let joinDir: { x: number; y: number } | null = null;
    expect(
      until(game, 120, () => {
        const sim = game.fleetSim(v);
        if (sim && game.docks.inYard(v.id) && !joinDir) joinDir = { ...sim.dir };
        return v.state === 'driving' && !!sim && !game.docks.inYard(v.id);
      }),
    ).toBe(true);
    // Начинает выезд носом к улице (не задом).
    expect(dot(joinDir!, geo.d.dir)).toBeLessThan(-0.6);
    expect(v.stop).toBe(0);
    const sim = game.fleetSim(v)!;
    // Граф движения мог смениться (город вырос в конце месяца) — полоса выезда по нынешнему графу.
    expect(sim.lane).toBe(game.docks.geoOf(b, TRUCK.length, TRUCK.width)!.out!.lane.id);
    expect(game.docks.count).toBe(0);
  });

  it('частичная выгрузка: магазин берёт, сколько влезает на склад, платят только за принятое, остальное — в кузове', () => {
    const game = freshGame(RETAIL_WORLD);
    const { town, b, sa, sb, line, v } = shopLine(game);
    const r = receiverOf(town, b.id)!;
    const cap = stockCap(town, r, 'food');
    r.stock.food = cap - 5.4;
    r.at = game.time;
    v.stop = 1;
    v.cargo = 'food';
    v.amount = 20;
    v.loadedAt = sa.id;
    v.fromStore = true;
    const supplied = town.supplied.food ?? 0;
    const money = game.money;
    inner(game).handleStop(v, sb, line);
    expect(v.amount).toBe(15);
    expect(v.cargo).toBe('food');
    expect(town.supplied.food).toBe(supplied + 5);
    const pay = Math.round((5 * CARGO.food.rate * ECONOMY.tariff * dist(sa.fp.center, sb.fp.center)) / 100);
    expect(game.money - money).toBe(pay);
    // У рампы — по выгруженному: 6 с + 0,4 с за единицу.
    expect(v.timer).toBeCloseTo(RETAIL.unloadBase + 5 * RETAIL.unloadPer);
    // Склад полон — ничего не принял и ничего не заплатили; задание «в город» засчитало принятое городу.
    const again = game.money;
    inner(game).handleStop(v, sb, line);
    expect(v.amount).toBe(15);
    expect(game.money).toBe(again);
  });

  it('станция у магазинов: груз расходится по складам получателей в её охвате, не больше их места; дальних не касается', () => {
    const game = freshGame(RETAIL_WORLD);
    const { town, a } = twoFood(game);
    // Грузовая станция у рынка: в её охвате — несколько получателей продуктов.
    const st: Station = {
      type: 'station',
      id: game.nextId(),
      kind: 'road',
      name: 'У рынка',
      fp: { center: { ...a.fp.center }, w: 30, h: 20, angle: 0 },
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
    const near = game.stationReceivers(st).filter((x) => x.r.cargo.includes('food'));
    expect(near.length).toBeGreaterThanOrEqual(1);
    expect(st.accepts.has('food')).toBe(true);
    const far = town.receivers!.filter((r) => r.cargo.includes('food') && !near.some((x) => x.r === r));
    const farStock = far.map((r) => stockAt(town, r, 'food', game.time));
    const room = near.reduce((s, x) => s + Math.floor(stockCap(town, x.r, 'food') - stockAt(town, x.r, 'food', game.time) + 1e-9), 0);
    const line = game.createLine([st.id, game.dockFor(a)!.id])!;
    game.money = 5_000_000;
    const v = game.buyVehicle(line.id, 'truck')!;
    v.stop = 0;
    v.cargo = 'food';
    v.amount = room + 7;
    v.loadedAt = -1;
    v.fromStore = true;
    inner(game).handleStop(v, st, line);
    // Каждому в охвате — до полного склада; что не влезло — в кузове.
    expect(v.amount).toBe(7);
    // Принимают целыми единицами: до полного — меньше единицы.
    for (const x of near) expect(stockAt(town, x.r, 'food', game.time)).toBeGreaterThan(stockCap(town, x.r, 'food') - 1);
    far.forEach((r, i) => expect(stockAt(town, r, 'food', game.time)).toBeCloseTo(farStock[i]));
  });

  it('станция завода в городе без получателей рядом городской груз не принимает (кроме потребностей без получателей)', () => {
    const game = freshGame(RETAIL_WORLD);
    const town = game.towns.find((t) => t.demands.includes('fuel') && t.receivers?.length)!;
    const edge = town.buildings.filter((b) => b.kind === 'res').sort((p, q) => dist(q.fp.center, town.center) - dist(p.fp.center, town.center))[0];
    const st: Station = {
      type: 'station',
      id: game.nextId(),
      kind: 'road',
      name: 'На окраине',
      fp: { center: add(edge.fp.center, { x: 0, y: 0 }), w: 30, h: 20, angle: 0 },
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
    expect(st.townIds).toContain(town.id);
    const rec = new Set(game.stationReceivers(st).flatMap((x) => x.r.cargo));
    // Потребность без получателей (топливо в городе без АЗС) — по-старому: принимает любая станция.
    const legacy = legacyCargo(town);
    for (const c of town.demands) {
      if (legacy.includes(c)) expect(st.accepts.has(c)).toBe(true);
      else expect(st.accepts.has(c)).toBe(rec.has(c));
    }
  });

  it('рампа одна: второй грузовик ждёт на прошлой остановке до 20 с, потом пропускает магазин', () => {
    const game = freshGame(RETAIL_WORLD);
    const { b, line, v } = shopLine(game);
    const w = game.buyVehicle(line.id, 'truck')!;
    // Первый стоит у рампы магазина B, второй готов уехать с A.
    v.stop = 1;
    v.state = 'loading';
    expect(game.docks.stand(v.id, b, TRUCK.length, TRUCK.width)).toBe(true);
    // У рынка рамп две: вторую занимает ещё один грузовик (id вне парка — только место у рампы).
    if (game.docks.rampCount(b, TRUCK.length, TRUCK.width) > 1) expect(game.docks.stand(-77, b, TRUCK.length, TRUCK.width)).toBe(true);
    expect(game.docks.rampBusy(b, w.id)).toBe(true);
    if (game.docks.rampCount(b, TRUCK.length, TRUCK.width) === 1) expect(game.docks.rampBusy(b, v.id)).toBe(false);
    w.stop = 0;
    w.state = 'departing';
    expect(inner(game).nextStop(w, line)).toBeNull();
    (game as unknown as { time: number }).time += RETAIL.rampWait - 1;
    expect(inner(game).nextStop(w, line)).toBeNull();
    (game as unknown as { time: number }).time += 2;
    // Пропускает B — следующая снова A (маршрут из двух): ждать больше некого, грузовик стоит.
    expect(inner(game).nextStop(w, line)).toBeNull();
    expect(game.journal.entries.some((e) => e.k === 'skip' && e.why === 'busy')).toBe(true);
    // Рампа свободна (первый уехал) — едет.
    game.docks.forget(v.id);
    expect(inner(game).nextStop(w, line)).toBe(1);
  });

  it('Фура (21 м) к магазину не едет — во двор не влезет; Грузовик II (15 м) — едет', () => {
    const game = freshGame(RETAIL_WORLD);
    game.openModelTier(3, true);
    const { line } = shopLine(game);
    const semi = game.buyVehicle(line.id, 'truck2')!;
    semi.stop = 0;
    semi.state = 'departing';
    expect(inner(game).nextStop(semi, line)).toBe(1);
    const long = game.buyVehicle(line.id, 'truck3')!;
    long.stop = 0;
    long.state = 'departing';
    expect(inner(game).nextStop(long, line)).toBeNull();
    expect(line.problem).toMatch(/не влезет/);
  });

  it('пока грузовик на манёвре во дворе, машины покупателей на стоянку не заезжают', () => {
    const game = freshGame(RETAIL_WORLD);
    const { b, v } = shopLine(game);
    v.cargo = 'food';
    v.amount = 5;
    v.fromStore = true;
    expect(until(game, 200, () => game.docks.entering(v.id) && !game.fleetSim(v))).toBe(true);
    expect(game.docks.yardBusy(b.id)).toBe(true);
    const lot = game.shops.lotOf(b);
    if (lot) {
      const free = (game.shops as unknown as { free(t: Town, l: typeof lot, k: number): boolean }).free.bind(game.shops);
      const town = game.towns.find((t) => t.id === b.townId)!;
      for (let k = 0; k < lot.spots.length; k++) expect(free(town, lot, k)).toBe(false);
    }
  });

  it('сохранение: получатели, их склады и станции у магазинов — как были; грузовик во дворе — у рампы', () => {
    const game = freshGame(RETAIL_WORLD);
    const { sb, v, line } = shopLine(game);
    v.cargo = 'food';
    v.amount = 4;
    v.fromStore = true;
    expect(until(game, 200, () => v.stop === 1 && v.state === 'loading' && !game.docks.entering(v.id))).toBe(true);
    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    const copy = new Game(RETAIL_WORLD, save);
    expect(copy.retail).toBe(true);
    expect(copy.towns.map((t) => t.receivers)).toEqual(game.towns.map((t) => t.receivers));
    const dock = copy.stations.get(sb.id)!;
    expect(dock.kind).toBe('dock');
    expect(dock.dock).toEqual(sb.dock);
    expect([...dock.accepts]).toEqual([...sb.accepts]);
    expect(copy.lines.get(line.id)!.stops).toEqual(line.stops);
    // Невидима и после загрузки.
    expect(copy.structureAt(sb.fp.center)?.type).toBe('building');
    // Грузовик стоял у рампы — после загрузки там же и выедет от неё.
    expect(copy.docks.inYard(v.id)).toBe(true);
    const cv = copy.fleet.get(v.id)!;
    expect(until(copy, 120, () => cv.state === 'driving' && !!copy.fleetSim(cv))).toBe(true);
    // Сохранение после загрузки — то же (детерминизм получателей).
    expect(JSON.parse(JSON.stringify(new Game(RETAIL_WORLD, save).toSave())).towns.map((t: Town) => t.receivers)).toEqual(save.towns.map((t) => t.receivers));
  });

  it('старая партия (без retail): получателей нет, станция в городе принимает всё нужное городу и сразу весь кузов', () => {
    const game = freshGame({ ...DEFAULT_SETTINGS, seed: 7 });
    expect(game.retail).toBe(false);
    for (const t of game.towns) expect(t.receivers).toBeUndefined();
    const town = game.towns[0];
    const st: Station = {
      type: 'station',
      id: game.nextId(),
      kind: 'road',
      name: 'В центре',
      fp: { center: { ...town.center }, w: 30, h: 20, angle: 0 },
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
    for (const c of town.demands) expect(st.accepts.has(c)).toBe(true);
    const other: Station = { ...st, id: game.nextId(), name: 'У завода', fp: { ...game.industries[0].fp }, passengers: new Map(), accepts: new Set() };
    game.stations.set(other.id, other);
    const line = game.createLine([st.id, other.id])!;
    game.money = 5_000_000;
    const v = game.buyVehicle(line.id, 'truck')!;
    const c = town.demands[0];
    v.stop = 0;
    v.cargo = c;
    v.amount = 500;
    v.loadedAt = -1;
    v.fromStore = true;
    const was = town.supplied[c] ?? 0;
    inner(game).handleStop(v, st, line);
    expect(town.supplied[c]).toBe(was + 500);
    expect(v.amount).toBe(0);
    // Старое сохранение после загрузки — тоже без получателей.
    const copy = new Game({ ...DEFAULT_SETTINGS, seed: 7 }, JSON.parse(JSON.stringify(game.toSave())));
    expect(copy.retail).toBe(false);
    expect(copy.towns.every((t) => !t.receivers)).toBe(true);
    // И подбор в такой город ничего не трогает без флага.
    copy.refreshReceivers(copy.towns[0]);
    expect(copy.towns[0].receivers).toBeUndefined();
    void pickReceivers;
  });
});
