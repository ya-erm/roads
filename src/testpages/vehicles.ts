import type { Vec } from '../core/vec';
import { emptyLedger, Game } from '../game/game';
import { AVENUE, type End, roadPlan, STREET } from '../game/testkit';
import { type ModelId, MODELS } from '../game/transport';
import { oneWay } from '../lanes/model';
import { hitchOf, jointOf, trailDir } from '../sim/body';
import type { Vehicle } from '../sim/vehicle';
import { CARGO, type CargoType, isTankCargo } from '../world/cargo';
import type { Station } from '../world/entities';
import { LANE_W } from '../world/roadTypes';
import { TERRAIN_VERSION } from '../world/settings';
import type { TestScene } from './index';

/**
 * Тестовая сцена «Транспорт» (/test/vehicles): все модели автобусов и грузовиков на одной сетке улиц —
 * посмотреть, как они выглядят и как поворачивают. Сетка — три квартала в ширину и два в высоту: улицы 1+1,
 * посередине проспект 2+2; на нём перекрёстки с улицами на четыре стороны, по краям — Т-образные.
 *  - Автобус — по часовой вокруг левого верхнего квартала (направо на каждом углу);
 *  - Автобус II — против часовой вокруг среднего нижнего (налево, через встречку);
 *  - Автобус III (сочленённый) — по часовой вокруг правого столбца, прямо через перекрёсток с проспектом;
 *  - Грузовик — с севера на юг через проспект, Грузовик II (тягач с полуприцепом) — с запада на восток,
 *    Фура — по кругу через все четыре автостанции у краёв сетки.
 * Над сеткой — машины без линий, они стоят: на одностороннем проспекте все шесть рядом, по полосе на модель,
 * носами на одной линии, а впереди пустых грузовиков — они же с разными грузами (самые передние — с топливом, газом
 * и нефтью — автоцистерны); выше — два ряда углов
 * (налево и направо), на каждом модель застыла посреди поворота.
 * Экран: y вниз, движение правостороннее — на улице с запада на восток едут у южного края.
 */
export function buildVehiclesScene(): TestScene {
  const game = new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 1_000_000_000, water: 'dry', terrainVersion: TERRAIN_VERSION });
  clearMap(game);
  // Все модели сразу — как на последнем этапе сценария.
  game.modelTier = 3;
  const sc = new Builder(game);

  const X = [2000, 2350, 2700, 3050];
  const Y = [1700, 2000, 2300];
  const [x0, x1, x2, x3] = X;
  const [y0, y1, y2] = Y;
  const corner = { ...STREET, kink: true };

  sc.step('Сетка улиц', () => {
    // Внешний прямоугольник: углы — изломом, последняя сторона замыкает его.
    sc.road({ free: { x: x0, y: y0 } }, { free: { x: x3, y: y0 } }, STREET);
    sc.road({ x: x3, y: y0 }, { free: { x: x3, y: y2 } }, corner);
    sc.road({ x: x3, y: y2 }, { free: { x: x0, y: y2 } }, corner);
    sc.road({ x: x0, y: y2 }, { x: x0, y: y0 }, corner);
    // Посередине — проспект от края до края (Т-образные перекрёстки с боковыми улицами).
    sc.road({ x: x0, y: y1 }, { x: x3, y: y1 }, AVENUE);
    // Поперёк — улицы сверху донизу: пересекают проспект (перекрёстки на четыре стороны).
    sc.road({ x: x1, y: y0 }, { x: x1, y: y2 }, STREET);
    sc.road({ x: x2, y: y0 }, { x: x2, y: y2 }, STREET);
  });

  sc.step('Автобус', () => {
    // По часовой вокруг левого верхнего квартала: на восток, направо на юг, направо на запад, направо на север.
    const stops = [south((x0 + x1) / 2, y0), west(x1, (y0 + y1) / 2), north((x0 + x1) / 2, y1), east(x0, (y0 + y1) / 2)].map((p) => sc.stop(p));
    sc.line('bus', 'Автобус: направо на углах', stops, 'bus', 2);
  });

  sc.step('Автобус II', () => {
    // Против часовой вокруг среднего нижнего квартала: на запад, налево на юг, налево на восток, налево на север.
    const stops = [north((x1 + x2) / 2, y1), west(x1, (y1 + y2) / 2), south((x1 + x2) / 2, y2), east(x2, (y1 + y2) / 2)].map((p) => sc.stop(p));
    sc.line('bus2', 'Автобус II: налево через встречку', stops, 'bus2', 2);
  });

  sc.step('Автобус III', () => {
    // По часовой вокруг правого столбца: прямо через перекрёсток с проспектом и Т-образный справа.
    const stops = [south((x2 + x3) / 2, y0), west(x3, (y1 + y2) / 2), north((x2 + x3) / 2, y2), east(x2, (y0 + y1) / 2 - 40)].map((p) => sc.stop(p));
    sc.line('bus3', 'Автобус III: сочленённый', stops, 'bus3', 2);
  });

  // Автостанции у краёв сетки — с выездом на крайнюю улицу.
  const out = 46;
  const depots: Record<'n' | 's' | 'w' | 'e', Station | null> = { n: null, s: null, w: null, e: null };
  sc.step('Автостанции', () => {
    depots.n = sc.depot({ x: (x1 + x2) / 2, y: y0 - out });
    depots.s = sc.depot({ x: (x1 + x2) / 2 + 60, y: y2 + out });
    depots.w = sc.depot({ x: x0 - out, y: (y1 + y2) / 2 });
    depots.e = sc.depot({ x: x3 + out, y: (y0 + y1) / 2 });
  });
  const { n, s, w, e } = depots;
  if (n && s && w && e) {
    sc.step('Грузовик', () => sc.line('truck', 'Грузовик: север — юг', [n, s], 'truck', 2));
    sc.step('Грузовик II', () => sc.line('truck2', 'Грузовик II: запад — восток', [w, e], 'truck2', 2));
    sc.step('Фура', () => sc.line('truck3', 'Фура: по кругу', [n, e, s, w], 'truck3', 2));
  }

  // ---------- Над сеткой: все модели рядом и застывшие на поворотах ----------
  const color = (model: ModelId) => {
    const id = sc.lines[model];
    return (id !== undefined && game.lines.get(id)?.color) || (MODELS[model].mode === 'road' ? MODELS[model].spec.color : '#888');
  };

  sc.step('Витрина', () => {
    // Односторонний проспект на 6 полос на восток: по модели в полосе, носы на одной линии.
    const y = 1560;
    sc.road({ free: { x: x0, y } }, { free: { x: x0 + 700, y } }, { cls: 'avenue', lanes: oneWay(SHOWCASE.length) });
    const end = sc.nodeAt({ x: x0 + 700, y });
    const laneY = (model: ModelId) => y + (SHOWCASE.indexOf(model) - (SHOWCASE.length - 1) / 2) * LANE_W;
    for (const model of SHOWCASE) game.traffic.holdAfter(sc.vehicle(model, color(model), { x: x0 + 360, y: laneY(model) }, end), 0);
    // Впереди пустых грузовиков — они же с грузом: кузов цвета груза, как в игре.
    for (const [model, cargos] of LOADED) {
      cargos.forEach((cargo, j) => {
        const veh = sc.vehicle(model, color(model), { x: x0 + 360 + 30 * (j + 1), y: laneY(model) }, end, cargo);
        game.traffic.holdAfter(veh, 0);
      });
    }
  });

  sc.step('Повороты', () => {
    // Два ряда углов: верхний — налево (на север), нижний — направо (на юг), по углу на модель.
    const turns: Turn[] = [];
    SHOWCASE.forEach((model, k) => {
      const x = x0 + k * 175;
      for (const [side, y] of [
        [-1, 1260],
        [1, 1360],
      ] as const) {
        sc.road({ free: { x, y } }, { free: { x: x + 110, y } }, STREET);
        sc.road({ x: x + 110, y }, { free: { x: x + 110, y: y + side * 90 } }, corner);
        const end = sc.nodeAt({ x: x + 110, y: y + side * 90 });
        turns.push({ veh: sc.vehicle(model, color(model), { x: x + 12, y: y + LANE_W / 2 }, end), best: 0 });
      }
    });
    freezeInTurns(game, turns);
  });

  // Стройка сцены — не расходы игрока: месяц начинается с чистого счёта.
  game.money = game.settings.money;
  game.incomeMonth = game.expensesMonth = 0;
  game.ledger = emptyLedger();
  return { game, view: sc.view(), lines: sc.lines, errors: sc.errors };
}

/** Модели на витрине и на поворотах — по порядку: автобусы, потом грузовики. */
const SHOWCASE: ModelId[] = ['bus', 'bus2', 'bus3', 'truck', 'truck2', 'truck3'];

/**
 * Грузовики на витрине с грузом — по три разных груза на модель, впереди пустого; самый передний везёт наливной
 * груз (топливо, газ, нефть) — он автоцистерна.
 */
const LOADED: [ModelId, CargoType[]][] = [
  ['truck', ['grain', 'food', 'fuel']],
  ['truck2', ['coal', 'logs', 'gas']],
  ['truck3', ['steel', 'stone', 'oil']],
];

/** Машина, что едет через угол, пока не застынет на повороте; best — наибольший излом кузова. */
interface Turn {
  veh: Vehicle;
  best: number;
  done?: boolean;
}

/** Угол между двумя направлениями, градусы. */
const angle = (a: Vec, b: Vec) => (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))) * 180) / Math.PI;

/** Излом кузова из двух частей: между курсом первой части и второй. */
function bendOf(veh: Vehicle): number {
  const h = hitchOf(veh.body);
  return h ? angle(veh.dir, trailDir(jointOf(veh.pos, veh.dir, veh.length, h), veh.trail, veh.dir)) : 0;
}

/**
 * Прогоняет движение, пока каждая машина не дойдёт до места на повороте, и останавливает её там: кузов из
 * двух частей — в самом большом изломе (вторая часть ещё в повороте, первая уже вышла), цельный — развернувшись
 * на 45°. Изгиб кузова получается только в движении — поэтому так, а не расстановкой.
 */
function freezeInTurns(game: Game, turns: Turn[]): void {
  const dt = 1 / 30;
  const east = { x: 1, y: 0 };
  for (let t = 0; t < 30 && turns.some((tr) => !tr.done); t += dt) {
    game.traffic.step(dt);
    for (const tr of turns) {
      if (tr.done) continue;
      const bend = bendOf(tr.veh);
      const ready = hitchOf(tr.veh.body) ? tr.best > 10 && bend < tr.best - 0.3 : angle(tr.veh.dir, east) >= 45;
      tr.best = Math.max(tr.best, bend);
      if (!ready) continue;
      tr.veh.v = 0;
      game.traffic.holdAfter(tr.veh, 0);
      tr.done = true;
    }
  }
  const late = turns.filter((tr) => !tr.done).map((tr) => tr.veh.body);
  if (late.length) throw new Error(`не дошли до поворота: ${late.join(', ')}`);
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

/** Строит сцену теми же действиями, что и игрок: дороги, остановки, автостанции, маршруты и транспорт. */
class Builder {
  readonly lines: Record<string, number> = {};
  readonly errors: string[] = [];

  constructor(readonly game: Game) {}

  /** Шаг сцены: не построился — ошибка в errors, остальные строятся. */
  step(name: string, build: () => void): void {
    try {
      build();
    } catch (err) {
      this.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  road(a: End, b: End, profile: Parameters<typeof roadPlan>[3]): void {
    const plan = roadPlan(this.game, a, b, profile);
    if (!plan.ok || !this.game.roadBuilder.apply(plan)) throw new Error(`дорога ${where(a)} → ${where(b)}: ${plan.reason ?? 'не построилась'}`);
  }

  /** Остановка у края улицы со стороны точки p. */
  stop(p: Vec): Station {
    const st = this.game.placeStation(p, 14, 'stop');
    if (!st) throw new Error(`остановка у (${p.x}, ${p.y}): ${this.game.stationPlan(p, 14, 'stop').reason ?? 'не встала'}`);
    return st;
  }

  /** Грузовая автостанция у точки p — выездом на ближайшую улицу. */
  depot(p: Vec): Station {
    const st = this.game.placeStation(p, 30, 'road', { pax: false, cargo: true });
    if (!st) throw new Error(`автостанция у (${p.x}, ${p.y}): ${this.game.stationPlan(p, 30, 'road').reason ?? 'не встала'}`);
    // Постов с запасом — машины трёх линий не толпятся у въезда.
    this.game.setStationBays(st.id, 4);
    return st;
  }

  /** Узел дороги в точке p (конец улицы). */
  nodeAt(p: Vec): number {
    const node = this.game.roads.net.nodesNear(p, 3)[0];
    if (!node) throw new Error(`нет узла у (${p.x}, ${p.y})`);
    return node.id;
  }

  /**
   * Машина модели model (без линии — для показа) носом в точку pos, на восток, едет к узлу target; cargo — груз
   * в кузове (его цвет), наливной — в цистерне.
   */
  vehicle(model: ModelId, color: string, pos: Vec, target: number, cargo?: CargoType): Vehicle {
    const m = MODELS[model];
    if (m.mode !== 'road') throw new Error(`${model} — не автомобиль`);
    const load = cargo ? CARGO[cargo].color : undefined;
    const veh = this.game.traffic.place({ ...m.spec, color, load, tank: isTankCargo(cargo), targetNode: target }, pos, { x: 1, y: 0 }, 0);
    if (!veh) throw new Error(`${m.name} не встал у (${pos.x}, ${pos.y})`);
    return veh;
  }

  /** Маршрут по станциям (по кругу) и n машин модели model; key — как его звать из консоли. */
  line(key: string, name: string, stops: Station[], model: ModelId, n: number): void {
    const ids = stops.map((st) => st.id);
    const line = this.game.createLine(ids);
    if (!line) throw new Error(`маршрут «${name}» не создался: ${this.game.lineProblem(ids) ?? 'мало станций'}`);
    this.game.renameLine(line.id, name);
    this.lines[key] = line.id;
    for (let i = 0; i < n; i++) if (!this.game.buyVehicle(line.id, model)) throw new Error(`${model} на «${name}» не купить`);
  }

  /** Рамка сцены: все дороги и станции. */
  view(): TestScene['view'] {
    const pts = [...this.game.roads.net.nodes.values()].map((nd) => nd.pos);
    for (const st of this.game.stations.values()) pts.push(st.fp.center);
    if (!pts.length) return { x0: 0, y0: 0, x1: this.game.terrain.width, y1: this.game.terrain.height };
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const pad = 60;
    // Справа — запас под панель маршрутов: сетка целиком видна левее неё.
    const right = (Math.max(...xs) - Math.min(...xs)) * 0.75;
    return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad + right, y1: Math.max(...ys) + pad };
  }
}
