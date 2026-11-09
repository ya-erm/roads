import { STATION } from '../config';
import type { Vec } from '../core/vec';
import { emptyLedger, Game, type RoadStationOptions } from '../game/game';
import { AVENUE, type End, roadPlan, STREET } from '../game/testkit';
import type { ModelId } from '../game/transport';
import { RoadTools } from '../input/roadtools';
import type { RoadOptions } from '../lanes/edit';
import { oneWay } from '../lanes/model';
import type { Station, Town, TownStyle } from '../world/entities';
import { LANE_W } from '../world/roadTypes';
import { TERRAIN_VERSION } from '../world/settings';
import { fillStreet, measureTown, recountPopulation, type WorldContext } from '../world/worldgen';
import type { TestScene } from './index';

/**
 * Тестовая сцена «Автобусы» (/test/bus): на ровной пустой карте несколько участков рядом, у каждого — свои
 * улицы, остановки, маршрут и автобусы, а вдоль улиц — дома (жители дают пассажиров):
 *  - «Прямая» — улица 1+1 с тупиками, по остановке в каждую сторону;
 *  - «Туда и обратно» — улица 1+1, пары остановок по обе стороны улицы;
 *  - «Проспект» — 2+2, остановки у правого края в обе стороны;
 *  - «Кармашек» — улица 1+1, у двух остановок полоса вдоль края до и после навеса (в обе стороны);
 *  - «Автовокзалы» — два автовокзала по обе стороны улицы, между ними четыре автобуса разных моделей: каждый
 *    встаёт на свой перрон; выезд у южного — самый короткий, у северного — длиннее обычного;
 *  - «Вдоль дороги» — два автовокзала боком к улице, у края — карман: автобусы съезжают в него, встают на перроны
 *    и едут дальше;
 *  - «Кварталы» — четыре квартала с перекрёстками и односторонней улицей посередине: один маршрут
 *    поворачивает налево, другой направо, общая остановка — на односторонней.
 * Экран: y вниз, движение правостороннее — на улице с запада на восток едут у южного края, остановки
 * у каждого маршрута стоят справа по ходу.
 */
export function buildBusScene(): TestScene {
  const game = new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 1_000_000_000, water: 'dry', terrainVersion: TERRAIN_VERSION });
  clearMap(game);
  // Все модели сразу: у автовокзалов — автобусы разной длины.
  game.modelTier = 3;
  const sc = new SceneBuilder(game);

  // Слева столбиком улицы, справа кварталы; правый верхний угол пуст — там панель маршрутов.

  // ---------- Прямая: улица 1+1, тупики на концах (там автобус разворачивается) ----------
  sc.section('Прямая', { x: 2450, y: 1500 }, 'linear', () => {
    const y = 1500;
    sc.road({ free: { x: 2000, y } }, { free: { x: 2900, y } }, STREET);
    // На восток — у южного края, на запад — у северного.
    const eastward = sc.stop(south(2600, y));
    const westward = sc.stop(north(2300, y));
    sc.houses();
    sc.line('straight', 'Прямая', [eastward, westward], 2);
  });

  // ---------- Туда и обратно: пары остановок по обе стороны улицы ----------
  sc.section('Туда и обратно', { x: 2450, y: 1900 }, 'linear', () => {
    const y = 1900;
    sc.road({ free: { x: 2000, y } }, { free: { x: 2900, y } }, STREET);
    // Пара — навесы друг против друга со сдвигом (вплотную две остановки не ставятся).
    const out1 = sc.stop(south(2250, y));
    const out2 = sc.stop(south(2650, y));
    const back2 = sc.stop(north(2590, y));
    const back1 = sc.stop(north(2190, y));
    sc.houses();
    sc.line('both', 'Туда и обратно', [out1, out2, back2, back1], 2);
  });

  // ---------- Проспект 2+2: остановки у правого края, автобусы держатся правой полосы ----------
  sc.section('Проспект', { x: 2500, y: 2300 }, 'linear', () => {
    const y = 2300;
    sc.road({ free: { x: 2000, y } }, { free: { x: 3000, y } }, AVENUE);
    const a = sc.stop(south(2250, y));
    const b = sc.stop(south(2750, y));
    const c = sc.stop(north(2650, y));
    const d = sc.stop(north(2150, y));
    sc.houses();
    sc.line('avenue', 'Проспект', [a, b, c, d], 3);
  });

  // ---------- Кармашек: полоса вдоль края у остановки, до и после навеса ----------
  sc.section('Кармашек', { x: 2450, y: 2700 }, 'linear', () => {
    const y = 2700;
    sc.road({ free: { x: 2000, y } }, { free: { x: 2900, y } }, STREET);
    // Остановки ставим сначала: протяжка «Полосы» мимо навеса отодвигает его к новому бордюру.
    const bayEast = sc.stop(south(2300, y));
    const plainEast = sc.stop(south(2800, y));
    const bayWest = sc.stop(north(2620, y));
    const plainWest = sc.stop(north(2100, y));
    // Полоса — по ходу движения у своего края: на восток у южного, на запад у северного.
    const edge = LANE_W * 1.5;
    sc.lane([2180, 2300, 2420].map((x) => ({ x, y: y + edge })));
    sc.lane([2740, 2620, 2500].map((x) => ({ x, y: y - edge })));
    sc.houses();
    sc.line('bay', 'Кармашек', [bayEast, plainEast, bayWest, plainWest], 2);
  });

  // ---------- Автовокзалы: по обе стороны улицы, автобусы встают на разные перроны ----------
  sc.section('Автовокзалы', { x: 2450, y: 3100 }, 'linear', () => {
    const y = 3100;
    sc.road({ free: { x: 2000, y } }, { free: { x: 2900, y } }, STREET);
    // Сперва дома, потом вокзалы: под площадками дома снесутся, как у игрока.
    sc.houses();
    // Выезды разной длины: у южного — самый короткий, у северного — длиннее обычного.
    const southTerminal = sc.terminal({ x: 2250, y: y + 40 }, { driveway: STATION.drivewayRange.min });
    const northTerminal = sc.terminal({ x: 2650, y: y - 40 }, { driveway: 30 });
    sc.line('terminal', 'Автовокзалы', [southTerminal, northTerminal], 4, ['bus', 'bus2', 'bus3', 'bus']);
  });

  // ---------- Вдоль дороги: автовокзалы боком к улице, у края — карман, автобусы едут дальше ----------
  sc.section('Вдоль дороги', { x: 2450, y: 3500 }, 'linear', () => {
    const y = 3500;
    sc.road({ free: { x: 2000, y } }, { free: { x: 2900, y } }, STREET);
    sc.houses();
    // На восток — у южного края (карман по ходу), на запад — у северного.
    const eastward = sc.terminal({ x: 2300, y: y + 40 }, { side: true });
    const westward = sc.terminal({ x: 2600, y: y - 40 }, { side: true });
    sc.line('side', 'Вдоль дороги', [eastward, westward], 3, ['bus2', 'bus3', 'bus']);
  });

  // ---------- Кварталы: перекрёстки, повороты, односторонняя посередине ----------
  sc.section('Кварталы', { x: 3700, y: 2300 }, 'radial', () => {
    const [x0, y0, n, h] = [3400, 2000, 600, 300];
    const corner = { ...STREET, kink: true };
    // Квадрат: углы — изломом из тупика (перекрёсток на две улицы), последняя сторона замыкает его.
    sc.road({ free: { x: x0, y: y0 } }, { free: { x: x0 + n, y: y0 } }, STREET);
    sc.road({ x: x0 + n, y: y0 }, { free: { x: x0 + n, y: y0 + n } }, corner);
    sc.road({ x: x0 + n, y: y0 + n }, { free: { x: x0, y: y0 + n } }, corner);
    sc.road({ x: x0, y: y0 + n }, { x: x0, y: y0 }, corner);
    // Поперёк — двусторонняя с запада на восток, вдоль — односторонняя с севера на юг; в центре перекрёсток.
    sc.road({ x: x0, y: y0 + h }, { x: x0 + n, y: y0 + h }, STREET);
    sc.road({ x: x0 + h, y: y0 }, { x: x0 + h, y: y0 + n }, { cls: 'street', lanes: oneWay(1) });
    const oneway = sc.stop(west(x0 + h, y0 + 150));
    // Восточная половина против часовой: с односторонней на юг, налево на восток, налево на север, налево на запад.
    const k2 = sc.stop(south(x0 + 450, y0 + n));
    const k3 = sc.stop(east(x0 + n, y0 + 150));
    const k4 = sc.stop(north(x0 + 450, y0));
    // Западная половина по часовой: на восток, направо на одностороннюю, направо на запад, направо на север.
    const l1 = sc.stop(south(x0 + 150, y0));
    const l2 = sc.stop(north(x0 + 150, y0 + n));
    const l3 = sc.stop(east(x0, y0 + 450));
    // Улиц много — дома пореже, чтобы машин жителей было не больше, чем на других участках.
    sc.houses(0.4);
    sc.line('block', 'Кварталы: налево', [oneway, k2, k3, k4], 2);
    sc.line('block2', 'Кварталы: направо', [l1, oneway, l2, l3], 1);
  });

  // Стройка сцены — не расходы игрока: месяц начинается с чистого счёта.
  game.money = game.settings.money;
  game.incomeMonth = game.expensesMonth = 0;
  game.ledger = emptyLedger();
  return { game, view: sc.view(), lines: sc.lines, errors: sc.errors };
}

/** От оси улицы до точки, у которой ставим остановку: навес встаёт с этой стороны улицы. */
const AT = 18;
const south = (x: number, y: number): Vec => ({ x, y: y + AT });
const north = (x: number, y: number): Vec => ({ x, y: y - AT });
const east = (x: number, y: number): Vec => ({ x: x + AT, y });
const west = (x: number, y: number): Vec => ({ x: x - AT, y });

/** Ровная пустая карта: генератор ставит реку, озёра, леса и предприятия всегда — убираем их. */
function clearMap(game: Game): void {
  const t = game.terrain;
  t.clearWater();
  t.trees.length = 0;
  t.extraForests.length = 0;
  for (const ind of game.industries) game.index.remove(ind);
  game.industries = [];
}

const where = (x: End) => (typeof x === 'number' ? `узел ${x}` : 'free' in x ? `(${x.free.x}, ${x.free.y})` : `(${x.x}, ${x.y})`);

/** Строит сцену теми же действиями, что и игрок: дороги, остановки, полосы, маршруты и автобусы. */
class SceneBuilder {
  readonly lines: Record<string, number> = {};
  readonly errors: string[] = [];
  /** Полотна, что были до текущего участка: всё новое — его улицы. */
  private before = new Set<number>();
  private town: Town | null = null;

  constructor(readonly game: Game) {}

  /**
   * Контекст мира — тот же, которым игру застраивает генератор (у игры он закрытый): у домов свои id.
   * Каждый раз заново: после стройки у игры уже другая сеть дорог.
   */
  private get ctx(): WorldContext {
    return (this.game as unknown as { worldContext(): WorldContext }).worldContext();
  }

  /**
   * Участок со своим «городом»: его имя — подпись на карте и в названиях остановок, его дома — жители
   * у остановок. Что-то не построилось — участок остаётся как есть, ошибка — в errors, остальные строятся.
   */
  section(name: string, center: Vec, style: TownStyle, build: () => void): void {
    this.before = new Set(this.game.roads.net.corridors.keys());
    this.town = {
      id: this.game.towns.length + 1,
      name,
      center,
      // Пока домов нет — с запасом, чтобы остановки назвались по участку; после застройки — по домам.
      radius: 500,
      top: center.y - 100,
      style,
      population: 0,
      buildings: [],
      streets: [],
      demands: [],
      supplied: {},
      lastSupplied: {},
      tripAcc: 0,
      growthAcc: 0,
      // Сам улиц не прокладывает: участки не срастаются.
      autoStreets: false,
    };
    this.game.towns.push(this.town);
    try {
      build();
    } catch (e) {
      this.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  road(a: End, b: End, profile: RoadOptions): void {
    const plan = roadPlan(this.game, a, b, profile);
    if (!plan.ok || !this.game.roadBuilder.apply(plan)) throw new Error(`дорога ${where(a)} → ${where(b)}: ${plan.reason ?? 'не построилась'}`);
  }

  /** Остановка у края улицы со стороны точки p. */
  stop(p: Vec): Station {
    const st = this.game.placeStation(p, 14, 'stop');
    if (!st) throw new Error(`остановка у (${p.x}, ${p.y}): ${this.game.stationPlan(p, 14, 'stop').reason ?? 'не встала'}`);
    return st;
  }

  /**
   * Автовокзал (только пассажиры) у ближайшей к точке p улицы, с её стороны, где p: выездом к ней (road.driveway —
   * его длина) или вдоль неё с карманом (road.side).
   */
  terminal(p: Vec, road: RoadStationOptions = {}): Station {
    const st = this.game.placeStation(p, 30, 'road', { pax: true, cargo: false }, 0, 2, undefined, false, road);
    if (!st) throw new Error(`автовокзал у (${p.x}, ${p.y}): ${this.game.stationPlan(p, 30, 'road', 0, 2, undefined, false, road).reason ?? 'не встал'}`);
    return st;
  }

  /** Полоса вдоль края — протяжкой инструментом «Полоса» через точки pts, как это делает игрок мышью. */
  lane(pts: Vec[]): void {
    const tools = new RoadTools(() => this.game);
    tools.laneDown(pts[0], 14);
    for (const p of pts.slice(1)) tools.laneMove(p, 14);
    const err = tools.laneUp(pts[pts.length - 1], 14, { cls: 'street', lanesF: 1, lanesB: 1 }, true);
    if (err) throw new Error(`полоса от (${pts[0].x}, ${pts[0].y}): ${err}`);
  }

  /** Дома вдоль всех улиц участка; охват остановок — уже с ними. */
  houses(density = 0.75): void {
    const town = this.town!;
    const net = this.game.roads.net;
    const mine = [...net.corridors.values()].filter((c) => !this.before.has(c.id));
    town.streets = mine.map((c) => c.id);
    const ctx = this.ctx;
    for (const c of mine) fillStreet(ctx, town, c, density);
    recountPopulation(town);
    measureTown(town);
    // Подпись — над застройкой.
    const ys = [...mine.flatMap((c) => [c.curve.p0.y, c.curve.p3.y]), ...town.buildings.map((b) => b.fp.center.y - b.fp.h)];
    town.top = Math.min(...ys) - 10;
    for (const st of this.game.stations.values()) this.game.computeCatchment(st);
  }

  /**
   * Маршрут по остановкам (по кругу) и автобусы на нём; key — как его звать из консоли, models — модели по порядку
   * (не хватит — обычные автобусы).
   */
  line(key: string, name: string, stops: Station[], buses: number, models: ModelId[] = []): void {
    const ids = stops.map((s) => s.id);
    const line = this.game.createLine(ids);
    if (!line) throw new Error(`маршрут «${name}» не создался: ${this.game.lineProblem(ids) ?? 'мало остановок'}`);
    this.game.renameLine(line.id, name);
    this.lines[key] = line.id;
    for (let i = 0; i < buses; i++) {
      const model = models[i] ?? 'bus';
      if (!this.game.buyVehicle(line.id, model)) throw new Error(`${model} на «${name}» не купить`);
    }
  }

  /** Рамка всей сцены: дороги и дома. */
  view(): TestScene['view'] {
    const pts = [...this.game.roads.net.nodes.values()].map((n) => n.pos);
    for (const t of this.game.towns) for (const b of t.buildings) pts.push(b.fp.center);
    if (!pts.length) return { x0: 0, y0: 0, x1: this.game.terrain.width, y1: this.game.terrain.height };
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const pad = 40;
    // Сверху — место под подписи участков.
    return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad - 40, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
  }
}
