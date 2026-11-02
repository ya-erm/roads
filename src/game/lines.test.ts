import { describe, expect, it } from 'vitest';
import { CARGO } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import { ECONOMY, MONTH_LENGTH } from '../config';
import { dist, Vec } from '../core/vec';
import { twoWay } from '../lanes/model';
import { Game } from './game';
import { road, roadPlan, stationExit, townStreets } from './testkit';
import type { FleetVehicle, Line } from './transport';

function runMonths(game: Game, months: number, each?: () => void) {
  game.speed = 1;
  for (let t = 0; t < months * MONTH_LENGTH; t += 0.1) {
    game.update(0.1);
    each?.();
  }
}

/** Ферма и ближайший пищекомбинат: станции у обоих, выезды соединены трассой, маршрут без транспорта. */
function farmRoute(seed = 7) {
  const game = new Game(seed);
  game.money = 5_000_000;
  const { f, p } = game.industries
    .filter((i) => i.info.kind === 'farm')
    .flatMap((f) => game.industries.filter((i) => i.info.kind === 'foodplant').map((p) => ({ f, p, d: dist(f.fp.center, p.fp.center) })))
    .sort((a, b) => a.d - b.d)[0];
  const sA = stationAtIndustry(game, f, p.fp.center)!;
  const sB = stationAtIndustry(game, p, f.fp.center)!;
  const A = stationExit(game, sA.nodeId);
  const B = stationExit(game, sB.nodeId);
  const highway = { cls: 'highway' as const, lanes: twoWay(1, 1) };
  const d = { x: B.pos.x - A.pos.x, y: B.pos.y - A.pos.y };
  const n = { x: -d.y / Math.hypot(d.x, d.y), y: d.x / Math.hypot(d.x, d.y) };
  let ok = false;
  for (const off of [0, 150, -150, 300, -300]) {
    const M = { x: (A.pos.x + B.pos.x) / 2 + n.x * off, y: (A.pos.y + B.pos.y) / 2 + n.y * off };
    if (!roadPlan(game, A.id, { free: M }, highway).ok) continue;
    road(game, A.id, { free: M }, highway);
    if ((ok = road(game, M, B.id, highway))) break;
  }
  expect(ok).toBe(true);
  return { game, line: game.createLine([sA.id, sB.id])!, farm: f };
}

function stationAtIndustry(game: Game, ind: Industry, toward: Vec): Station | null {
  const base = Math.atan2(toward.y - ind.fp.center.y, toward.x - ind.fp.center.x);
  for (const k of [0, 1, -1, 2]) {
    const a = base + (k * Math.PI) / 2;
    const reach = Math.hypot(ind.fp.w, ind.fp.h) / 2 + 20;
    const st = game.placeStation({ x: ind.fp.center.x + Math.cos(a) * reach, y: ind.fp.center.y + Math.sin(a) * reach }, 14);
    if (st) return st;
  }
  return null;
}

/** Станция у улицы самого большого города — склад для пересадки. */
function townStation(game: Game): Station {
  const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
  for (const seg of townStreets(game, town.id)) {
    const p = seg.lut.pointAt(seg.length / 2);
    const t = seg.lut.tangentAt(seg.length / 2);
    const st = game.placeStation({ x: p.x - t.y * 40, y: p.y + t.x * 40 }, 14, 'road', { pax: false, cargo: true });
    if (st) return st;
  }
  throw new Error('нет места для станции');
}

type Internals = { handleStop(v: FleetVehicle, st: Station, line: Line): void };

describe('Маршруты и склады', () => {
  it('маршрут редактируется: станции добавляются, переставляются и удаляются', () => {
    const game = new Game(7);
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    const a = stationAtIndustry(game, farm, plant.fp.center)!;
    const b = stationAtIndustry(game, plant, farm.fp.center)!;
    const hub = townStation(game);
    const line = game.createLine([a.id, b.id])!;
    expect(game.addLineStop(line.id, hub.id)).toBeNull();
    expect(line.stops).toEqual([a.id, b.id, hub.id]);
    expect(game.moveLineStop(line.id, 2, -1)).toBeNull();
    expect(line.stops).toEqual([a.id, hub.id, b.id]);
    expect(game.removeLineStop(line.id, 0)).toBeNull();
    expect(line.stops).toEqual([hub.id, b.id]);
    // Меньше двух станций нельзя.
    expect(game.removeLineStop(line.id, 0)).not.toBeNull();
    expect(line.stops).toHaveLength(2);
  });

  it('склад: груз выгружается на пересадке и оплачивается при доставке от первой станции', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const plant = game.industries.find((i) => i.info.kind === 'foodplant')!;
    const a = stationAtIndustry(game, farm, plant.fp.center)!;
    const b = stationAtIndustry(game, plant, farm.fp.center)!;
    const hub = townStation(game);
    expect(hub.accepts.has('grain')).toBe(false);
    // Первая линия довозит зерно до склада, вторая — со склада на комбинат.
    const l1 = game.createLine([a.id, hub.id])!;
    game.setStopRule(l1.id, 1, { wait: 'none', maxWait: null, load: 'auto', unload: 'all' });
    const l2 = game.createLine([hub.id, b.id])!;
    const t1 = game.buyVehicle(l1.id, 'truck')!;
    const t2 = game.buyVehicle(l2.id, 'truck')!;
    const g = game as unknown as Internals;

    // Грузовик первой линии берёт зерно на ферме.
    a.cargo.grain = 40;
    t1.stop = 0;
    g.handleStop(t1, a, l1);
    expect(t1.cargo).toBe('grain');
    expect(t1.amount).toBe(16);
    // На складе выгружает всё, денег пока нет.
    const before = l1.revenueTotal;
    t1.stop = 1;
    g.handleStop(t1, hub, l1);
    expect(t1.amount).toBe(0);
    expect(hub.cargo.grain).toBe(16);
    expect(hub.cargoOrigin?.grain).toBe(a.id);
    expect(l1.revenueTotal).toBe(before);

    // Вторая линия забирает со склада и везёт на комбинат.
    t2.cargo = null;
    t2.amount = 0;
    t2.stop = 0;
    g.handleStop(t2, hub, l2);
    expect(t2.cargo).toBe('grain');
    expect(t2.loadedAt).toBe(a.id);
    t2.stop = 1;
    const r0 = l2.revenueTotal;
    g.handleStop(t2, b, l2);
    const expected = Math.round((16 * CARGO.grain.rate * ECONOMY.tariff * dist(a.fp.center, b.fp.center)) / 100);
    expect(l2.revenueTotal - r0).toBe(expected);
  });

  it('станция только для груза не набирает пассажиров', () => {
    const game = new Game(7);
    const hub = townStation(game);
    expect(hub.serves.pax).toBe(false);
    expect(hub.catchPop).toBe(0);
    game.setStationServes(hub.id, { pax: true, cargo: false });
    expect(hub.catchPop).toBeGreaterThan(0);
    expect(hub.accepts.size).toBe(0);
    // Хотя бы что-то одно остаётся включённым.
    game.setStationServes(hub.id, { pax: false, cargo: false });
    expect(hub.serves.pax).toBe(true);
  });
});

// Симуляции на месяцы вперёд — дольше стандартного лимита теста.
describe('Авто-парк и равномерный выпуск', { timeout: 90_000 }, () => {
  it('маршруту — подходящий транспорт: грузовому грузовики, пассажирскому автобусы, смешанному любой', () => {
    const { game, line } = farmRoute();
    expect(game.lineKind(line)).toBe('freight');
    expect(game.autoModel(line)).toBe('truck');
    game.buyVehicle(line.id, 'bus');
    game.buyVehicle(line.id, 'truck');
    expect(game.lineKind(line)).toBeNull();
    // Авто-парк и на смешанном докупает грузовик — по станциям маршрут грузовой.
    expect(game.autoModel(line)).toBe('truck');
    // Две станции в городе только для пассажиров — автобусный маршрут.
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const placed: Station[] = [];
    for (const seg of townStreets(game, town.id)) {
      const p = seg.lut.pointAt(seg.length / 2);
      const t = seg.lut.tangentAt(seg.length / 2);
      const q = { x: p.x - t.y * 40, y: p.y + t.x * 40 };
      if (placed.length >= 2 || placed.some((s) => dist(s.fp.center, q) < 300)) continue;
      const st = game.placeStation(q, 14, 'road', { pax: true, cargo: false });
      if (st) placed.push(st);
    }
    const bus = game.createLine(placed.map((s) => s.id))!;
    expect(game.lineKind(bus)).toBe('passengers');
    expect(game.autoModel(bus)).toBe('bus');
  });

  it('авто-парк докупает грузовик, когда зерно копится, но не больше максимума', () => {
    const { game, line, farm } = farmRoute();
    game.buyVehicle(line.id, 'truck');
    // Ферма выросла — одному грузовику зерно не вывезти.
    farm.level = 4;
    game.setLineAuto(line.id, { on: true, min: 1, max: 3 });
    expect(line.vehicles).toHaveLength(1);
    let most = 0;
    let months = 0;
    while (line.vehicles.length < 3 && months < 14) {
      runMonths(game, 1, () => (most = Math.max(most, line.vehicles.length)));
      months++;
    }
    expect(line.vehicles).toHaveLength(3);
    // Той же моделью и по одной: после покупки ждёт, пока она скажется.
    expect(line.vehicles.every((id) => game.fleet.get(id)!.model === 'truck')).toBe(true);
    expect(months).toBeGreaterThan(2);
    // Зерна всё ещё больше, чем вывозят, но выше максимума не идёт.
    runMonths(game, 4, () => (most = Math.max(most, line.vehicles.length)));
    expect(line.demandLast!.load).toBeGreaterThan(0.8);
    expect(most).toBe(3);
    expect(line.vehicles).toHaveLength(3);
  });

  it('авто-парк продаёт лишний, когда машины ездят пустыми, но не ниже минимума; пределы держит сразу', () => {
    const { game, line } = farmRoute();
    for (let i = 0; i < 3; i++) game.buyVehicle(line.id, 'truck');
    // На ферме ничего не грузим — рейсы пустые.
    game.setStopRule(line.id, 0, { wait: 'none', maxWait: null, load: [], unload: 'auto' });
    game.setLineAuto(line.id, { on: true, min: 2, max: 5 });
    expect(line.vehicles).toHaveLength(3);
    let least = 3;
    runMonths(game, 8, () => (least = Math.min(least, line.vehicles.length)));
    expect(line.vehicles).toHaveLength(2);
    expect(least).toBe(2);
    // Минимум выше, чем машин, — докупает сразу; максимум ниже — продаёт сразу.
    game.setLineAuto(line.id, { min: 4 });
    expect(line.vehicles).toHaveLength(4);
    expect(line.auto!.max).toBe(5);
    game.setLineAuto(line.id, { max: 1 });
    expect(line.vehicles).toHaveLength(1);
    expect(line.auto!.min).toBe(1);
    // Настройки — в сохранении; в старом сохранении их нет — авто-парк выключен.
    const save = JSON.parse(JSON.stringify(game.toSave()));
    expect(new Game(game.settings, save).lines.get(line.id)!.auto).toMatchObject({ on: true, min: 1, max: 1 });
    delete save.lines[0].auto;
    const old = new Game(game.settings, save);
    expect(old.lines.get(line.id)!.auto?.on ?? false).toBe(false);
    old.buyVehicle(line.id, 'truck');
    runMonths(old, 1);
    expect(old.lines.get(line.id)!.vehicles).toHaveLength(2);
  });

  it('купленные разом грузовики уходят с первой станции с интервалом, а не пачкой', () => {
    const { game, line } = farmRoute();
    const trucks = [0, 1, 2].map(() => game.buyVehicle(line.id, 'truck')!);
    const departed = new Map<number, number>();
    let waitedForInterval = false;
    game.speed = 1;
    for (let t = 0; t < MONTH_LENGTH * 6 && departed.size < 3; t += 0.1) {
      game.update(0.1);
      for (const v of trucks) {
        if (game.spacingLeft(v) !== null) waitedForInterval = true;
        if (!departed.has(v.id) && v.state === 'driving') departed.set(v.id, game.time);
      }
    }
    expect(departed.size).toBe(3);
    // Карточка маршрута показывает, что машина ждёт интервала.
    expect(waitedForInterval).toBe(true);
    const times = [...departed.values()].sort((a, b) => a - b);
    const interval = game.lineInterval(line)!;
    expect(interval).toBeGreaterThan(15);
    // Между отправлениями — заметная доля интервала (круг / 3), а не пара секунд.
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThan(interval * 0.6);
    // Одной машине ждать незачем.
    game.sellVehicle(trucks[1].id);
    game.sellVehicle(trucks[2].id);
    expect(game.lineInterval(line)).toBeNull();
  });
});
