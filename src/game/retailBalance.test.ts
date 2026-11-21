import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import type { Station, Town, TownBuilding } from '../world/entities';
import { receiverOf, RETAIL, stockCap } from '../world/retail';
import { DEFAULT_SETTINGS } from '../world/settings';
import { townNeed } from '../world/townSupply';
import { formOf } from '../world/townForms';
import type { Game } from './game';
import { freshGame, runMonths, townStreets, withoutCitizens } from './testkit';
import type { FleetVehicle, Line } from './transport';

/**
 * Этап 4 получателей грузов (docs/RETAIL.md): баланс развозки. Грузовик заезжает во двор только к магазину, которому
 * есть что сдать и где для этого есть место, — за крохами мимо; так одна линия «🛒 все магазины» закрывает норму
 * разумным числом грузовиков (замер — scripts/retail-balance.ts).
 */

const RETAIL_WORLD = { ...DEFAULT_SETTINGS, seed: 7, retail: true };

type Inner = { nextStop(v: FleetVehicle, line: Line): number | null };
const inner = (g: Game) => g as unknown as Inner;

/** Город и его продуктовые магазины, к которым подъехать (не меньше min), и ещё получатель не продуктов — «склад» линии. */
function foodTown(game: Game, min = 3, maxPop = Infinity): { town: Town; shops: TownBuilding[]; src: TownBuilding } {
  for (const town of [...game.towns].sort((a, b) => a.population - b.population)) {
    if (town.population > maxPop) continue;
    const of = (pred: (b: TownBuilding) => boolean) =>
      (town.receivers ?? [])
        .filter((r) => !r.depot)
        .map((r) => town.buildings.find((b) => b.id === r.b)!)
        .filter((b) => b && pred(b) && game.docks.reachable(b, 12));
    const shops = of((b) => receiverOf(town, b.id)!.cargo.includes('food'));
    const src = of((b) => !receiverOf(town, b.id)!.cargo.includes('food') && formOf(b) !== 'fuel')[0];
    if (shops.length >= min && src) return { town, shops, src };
  }
  throw new Error('нет города с продуктовыми магазинами');
}

/** Грузовая станция ближе к центру, чей съезд оставляет доступными все дворы проверяемого маршрута. */
function centerStation(game: Game, town: Town, shops: TownBuilding[]): Station {
  const ids = shops.map((b) => b.id);
  const mid = (c: ReturnType<typeof townStreets>[number]) => c.lut.pointAt(c.length / 2);
  const streets = townStreets(game, town.id).sort((a, b) => dist(mid(a), town.center) - dist(mid(b), town.center));
  for (const seg of streets) {
    const p = mid(seg);
    const t = seg.lut.tangentAt(seg.length / 2);
    for (const side of [1, -1]) {
      const point = { x: p.x - t.y * side * 40, y: p.y + t.x * side * 40 };
      const plan = game.stationPlan(point, 14);
      if (!plan.ok || plan.demolish?.length) continue;
      game.checkpoint('подбор станции для развозки');
      const st = game.placeStation(point, 14);
      game.commit();
      if (!st) continue;
      const targets = game.shopTargets([st.id], 'food');
      if (ids.every((id) => targets.some((b) => b.id === id))) return st;
      game.undo(false);
    }
  }
  throw new Error('станцию не поставить');
}

/** Склад получателя-дома b полон до доли fill. */
function fill(game: Game, town: Town, b: TownBuilding, share: number): void {
  const r = receiverOf(town, b.id)!;
  r.stock.food = stockCap(town, r, 'food') * share;
  r.at = game.time;
}

describe('Развозка по магазинам: баланс', { timeout: 240_000 }, () => {
  it('магазин с полным складом — мимо, к следующему; за крохами не заезжает, если весь остаток туда не влезет', () => {
    const game = freshGame(RETAIL_WORLD);
    game.money = 5_000_000;
    const { town, shops } = foodTown(game);
    const [a, b, c] = shops;
    const line = game.createLine([a, b, c].map((x) => game.dockFor(x)!.id))!;
    const v = game.buyVehicle(line.id, 'truck')!;
    v.stop = 0;
    v.state = 'departing';
    v.cargo = 'food';
    v.amount = 10;
    for (const x of [a, b, c]) fill(game, town, x, 0.2);
    expect(inner(game).nextStop(v, line)).toBe(1);
    // Склад B полон — сразу к C.
    fill(game, town, b, 1);
    expect(inner(game).nextStop(v, line)).toBe(2);
    // У B место на 5 ед.: меньше остатка кузова и (на большом складе) меньше трети склада — мимо; весь остаток
    // влезает — заезжает.
    const r = receiverOf(town, b.id)!;
    const cap = stockCap(town, r, 'food');
    r.stock.food = cap - 5;
    r.at = game.time;
    expect(inner(game).nextStop(v, line)).toBe(5 < cap * RETAIL.worthVisit ? 2 : 1);
    v.amount = 5;
    expect(inner(game).nextStop(v, line)).toBe(1);
    // Крохи в кузове (меньше пятой части) — ни к кому: везти по кругу некуда — к первому по порядку.
    v.amount = 2;
    for (const x of [a, b, c]) fill(game, town, x, 0);
    expect(inner(game).nextStop(v, line)).toBe(1);
    expect((inner(game) as unknown as { dockIdle(...a: unknown[]): boolean }).dockIdle(v, line, 2, game.dockFor(c)!)).toBe(true);
  });

  it('место в магазине, куда уже едет другой грузовик, — за вычетом его груза', () => {
    const game = freshGame(RETAIL_WORLD);
    game.money = 5_000_000;
    const { town, shops } = foodTown(game);
    const [a, b] = shops;
    const line = game.createLine([a, b].map((x) => game.dockFor(x)!.id))!;
    for (const x of [a, b]) fill(game, town, x, 0.5);
    const room = Math.floor(stockCap(town, receiverOf(town, b.id)!, 'food') * 0.5);
    const [v, w] = [game.buyVehicle(line.id, 'truck')!, game.buyVehicle(line.id, 'truck')!];
    for (const x of [v, w]) {
      x.stop = 0;
      x.state = 'departing';
      x.cargo = 'food';
      x.amount = room;
    }
    expect(inner(game).nextStop(v, line)).toBe(1);
    // w уже едет к B со всем, что туда влезет: v туда незачем — по кругу к A.
    w.stop = 1;
    w.state = 'driving';
    expect(inner(game).nextStop(v, line)).toBe(1);
    expect((inner(game) as unknown as { dockIdle(...a: unknown[]): boolean }).dockIdle(v, line, 1, game.dockFor(b)!)).toBe(true);
  });

  it('пустой грузовик в магазины не заезжает — едет туда, где грузят; везти некуда — к следующему по порядку', () => {
    const game = freshGame(RETAIL_WORLD);
    game.money = 5_000_000;
    const { shops, src } = foodTown(game);
    const sSrc = game.dockFor(src)!;
    const line = game.createLine([sSrc.id, ...shops.slice(0, 2).map((x) => game.dockFor(x)!.id)])!;
    // Первая остановка — «склад»: здесь грузят продукты.
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: ['food'], unload: 'auto' });
    const v = game.buyVehicle(line.id, 'truck')!;
    // Сдал всё в первом магазине — второй мимо, обратно к «складу».
    v.stop = 1;
    v.state = 'departing';
    v.cargo = null;
    v.amount = 0;
    expect(inner(game).nextStop(v, line)).toBe(0);
    // Маршрут только из магазинов: пустому везти некуда — по порядку, не стоит на месте.
    const only = game.createLine(shops.slice(0, 2).map((x) => game.dockFor(x)!.id))!;
    const w = game.buyVehicle(only.id, 'truck')!;
    w.stop = 0;
    w.state = 'departing';
    expect(inner(game).nextStop(w, only)).toBe(1);
  });

  it('одна линия «🛒 все магазины» закрывает продуктовую норму города; на загрузку — не больше двух заездов', () => {
    const game = withoutCitizens(freshGame(RETAIL_WORLD));
    game.money = 5_000_000;
    const { town, shops } = foodTown(game, 2, 4500);
    // «Склад» — грузовая станция у улицы в городе (как станция завода в черте), продукты не принимает (правило ниже).
    const sSrc = centerStation(game, town, shops);
    game.setStationBays(sSrc.id, 4);
    // «🛒 все магазины» с продуктами — по порядку ближайшего соседа от «склада».
    const food = game.shopTargets([sSrc.id], 'food').map((b) => game.dockFor(b)!.id);
    expect(food.length).toBe(town.receivers!.filter((r) => !r.depot && r.cargo.includes('food')).length);
    const line = game.createLine([sSrc.id, ...food])!;
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: ['food'], unload: [] });
    const need = townNeed(town.population);
    // Круг по городу — около двух минут (заезды во дворы ~45 с, магазины на разных концах): Грузовик сдаёт ~5 ед. в
    // месяц; с запасом — на 4.
    const trucks = Math.max(2, Math.ceil(need / 4));
    const vs = Array.from({ length: trucks }, () => game.buyVehicle(line.id, 'truck')!);
    let loads = 0;
    const loaded = new Set<number>();
    const each = () => {
      for (const v of vs) {
        if (v.stop === 0 && v.state === 'loading' && !loaded.has(v.id)) {
          loaded.add(v.id);
          loads++;
          // На «складе» — всегда полный кузов продуктов (как с завода).
          v.cargo = 'food';
          v.amount = 16;
          v.loadedAt = sSrc.id;
          v.fromStore = true;
        } else if (v.stop !== 0) loaded.delete(v.id);
      }
    };
    const from = game.journal.entries.length;
    runMonths(game, 5, each);
    const got = (town.supplyHistory ?? []).slice(-3).map((m) => m.got.food ?? 0);
    expect(got.filter((g) => g >= need).length).toBeGreaterThanOrEqual(2);
    // Заездов во дворы с выгрузкой — не больше двух на загрузку: за крохами не ездят.
    const docks = new Set(food);
    const visits = game.journal.entries.slice(from).filter((e) => e.k === 'stop' && docks.has(e.st as number)).length;
    expect(visits / Math.max(1, loads)).toBeLessThanOrEqual(2.2);
  });

  it('к магазину не подъехать — он не получатель, пока есть досягаемые: норма закрывается без него', () => {
    const game = freshGame(RETAIL_WORLD);
    for (const town of game.towns) {
      const food = (town.receivers ?? []).filter((r) => !r.depot && r.cargo.includes('food'));
      if (!food.length) continue;
      const reach = food.filter((r) => {
        const b = town.buildings.find((x) => x.id === r.b)!;
        return game.docks.reachable(b, 12);
      });
      // Хоть один досягаем — недосягаемых среди получателей нет.
      if (reach.length) expect(reach.length).toBe(food.length);
    }
  });
});
