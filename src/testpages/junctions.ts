import type { Vec } from '../core/vec';
import { emptyLedger, Game } from '../game/game';
import { AVENUE, type End, roadPlan, STREET, withoutCitizens } from '../game/testkit';
import { RoadTools } from '../input/roadtools';
import { cornerHandles, setCornerRadius } from '../lanes/corners';
import type { RoadOptions } from '../lanes/edit';
import { type LaneNode, oneWay, twoWay } from '../lanes/model';
import type { Station, Town } from '../world/entities';
import { LANE_W, type RoadClass } from '../world/roadTypes';
import { TERRAIN_VERSION } from '../world/settings';
import type { TestScene } from './index';

/** Перекрёсток сцены: подпись, где стоит, узел игры и сколько у него подъездов. */
export interface SceneJunction {
  name: string;
  center: Vec;
  /** Узел перекрёстка (ближайший к центру); null — не построился. */
  node: number | null;
  arms: number;
}

export interface JunctionsScene extends TestScene {
  junctions: SceneJunction[];
}

/**
 * Тестовая сцена «Перекрёстки» (/test/junctions): на ровной пустой карте сеткой разные перекрёстки игры, у каждого —
 * подпись. Смотреть разметку перекрёстков (настройка `junctionMarks`: штриховка пустого асфальта, направляющие) —
 * на простых, косых, многолучевых, разных классов и с полосами поворота. Каждый перекрёсток построен штатно, как
 * игроком: дороги строителем игры, углы — скруглением («Двигать»), полосы — инструментом «Полоса».
 *  - верхний ряд: крест 2+2 × 2+2, косой X 2+2 × 2+2 под 32° (и он же со скруглёнными углами), широкий 3+3 × 2+2;
 *    справа пусто — там панель маршрутов;
 *  - средний: маленький 1+1 × 1+1 (разметки там быть не должно — порог), проспект 2+2 × улица 1+1, Т-образный,
 *    Y-образный (40° между ветками), пятилучевой, шестилучевой;
 *  - нижний: магистраль 2+2 × улица 1+1, односторонняя × проспект, две односторонние, смещённый (боковые улицы не
 *    напротив друг друга), излом ветки рядом с перекрёстком, полоса правого поворота и съезд в обход перекрёстка;
 *  - четвёртый: Т с изогнутой веткой (дорога 1+1 подходит дугой почти вдоль магистрали 2+2 — площадка не тянется
 *    клином вдоль дуги), косой Т с ограниченными манёврами (с ветки два потока в две полосы проспекта — сплошная между ними).
 * На кресте, косом X и широком ходят автобусы — через перекрёсток с поворотами.
 * Экран: y вниз, движение правостороннее — на улице с запада на восток едут у южного края.
 */
export function buildJunctionsScene(): JunctionsScene {
  const game = withoutCitizens(
    new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 1_000_000_000, water: 'dry', terrainVersion: TERRAIN_VERSION }),
  );
  clearMap(game);
  const sc = new SceneBuilder(game);

  const X = [1300, 1750, 2200, 2650, 3100, 3550];
  const Y = [1100, 1550, 2000, 2450];
  const cell = (i: number, j: number): Vec => ({ x: X[i], y: Y[j] });
  const R = 140;

  // ---------- Верхний ряд: кресты ----------

  sc.junction('Крест 2+2 × 2+2', cell(0, 0), (c) => {
    sc.cross(c, 0, R, AVENUE);
    sc.cross(c, 90, R, AVENUE);
    // Автобус: с запада налево на север и обратно направо.
    sc.line('cross', 'Крест: налево и направо', [sc.stop(c, 180, 90, 'right'), sc.stop(c, -90, 90, 'right')], 2);
  });

  sc.junction('Косой X 2+2 × 2+2, 32°', cell(1, 0), (c) => {
    sc.skewX(c, 32, AVENUE);
    sc.line('skew', 'Косой X: острый поворот', [sc.stop(c, 164, 120, 'right'), sc.stop(c, 196, 120, 'right')], 2);
  });

  sc.junction('Косой X, углы скруглены', cell(2, 0), (c) => {
    sc.skewX(c, 32, AVENUE);
    // Острые углы — радиусом 15 м (предел тут ~27 м: дальше стоп-линии ушли бы за 150 м от перекрёстка).
    sc.roundCorners(c, 15);
  });

  sc.junction('Широкий 3+3 × 2+2', cell(3, 0), (c) => {
    sc.cross(c, 0, R, { cls: 'avenue', lanes: twoWay(3, 3) });
    sc.cross(c, 90, R, AVENUE);
    // С запада направо на юг и обратно налево.
    sc.line('wide', 'Широкий: направо и налево', [sc.stop(c, 180, 100, 'right'), sc.stop(c, 90, 100, 'right')], 2);
  });

  // ---------- Средний ряд: маленькие, Т, Y, много лучей ----------

  sc.junction('Маленький 1+1 × 1+1', cell(0, 1), (c) => {
    sc.cross(c, 0, 110, STREET);
    sc.cross(c, 90, 110, STREET);
  });

  sc.junction('Проспект 2+2 × улица 1+1', cell(1, 1), (c) => {
    sc.cross(c, 0, R, AVENUE);
    sc.cross(c, 90, R, STREET);
  });

  sc.junction('Т-образный 2+2', cell(2, 1), (c) => {
    sc.cross(c, 0, R, AVENUE);
    sc.arm(c, 90, R, AVENUE);
  });

  sc.junction('Y-образный, 40°', cell(3, 1), (c) => {
    // Ствол с юга до центра, от тупика — две ветки изломом: между ними 40°.
    sc.road({ free: at(c, 90, R) }, { free: c }, AVENUE);
    const n = sc.nodeAt(c);
    sc.road(n, { free: at(c, -110, R) }, { ...AVENUE, kink: true });
    sc.road(n, { free: at(c, -70, R) }, { ...AVENUE, kink: true });
  });

  sc.junction('Пятилучевой', cell(4, 1), (c) => {
    sc.cross(c, 0, R, AVENUE);
    sc.cross(c, 90, R, STREET);
    sc.arm(c, -45, R, STREET);
  });

  sc.junction('Шестилучевой', cell(5, 1), (c) => {
    sc.cross(c, 0, R, AVENUE);
    sc.cross(c, 60, R, STREET);
    // Третья дорога — двумя половинами к уже готовому перекрёстку.
    sc.arm(c, 120, R, STREET);
    sc.arm(c, -60, R, STREET);
  });

  // ---------- Нижний ряд: классы, односторонние, смещённый, излом, полосы поворота ----------

  sc.junction('Магистраль 2+2 × 1+1', cell(0, 2), (c) => {
    sc.cross(c, 0, R, { cls: 'highway', lanes: twoWay(2, 2) });
    sc.cross(c, 90, R, STREET);
  });

  sc.junction('Односторонняя 2→ × 2+2', cell(1, 2), (c) => {
    sc.cross(c, 0, R, AVENUE);
    // С севера на юг.
    sc.cross(c, 90, R, ONE_WAY);
  });

  sc.junction('Две односторонние 2→', cell(2, 2), (c) => {
    // На восток и на север.
    sc.cross(c, 0, R, ONE_WAY);
    sc.cross(c, -90, R, ONE_WAY);
  });

  sc.junction('Смещённый', cell(3, 2), (c) => {
    // Проспект с севера на юг; боковые улицы примыкают с запада и с востока не напротив друг друга.
    sc.cross(c, 90, R, AVENUE);
    sc.road({ free: { x: c.x - R, y: c.y - 20 } }, { x: c.x, y: c.y - 20 }, STREET);
    sc.road({ free: { x: c.x + R, y: c.y + 20 } }, { x: c.x, y: c.y + 20 }, STREET);
  });

  sc.junction('Излом ветки', cell(4, 2), (c) => {
    sc.cross(c, 0, R, AVENUE);
    // С севера через перекрёсток и ещё 45 м на юг, там излом на 35° к востоку.
    const k = at(c, 90, 45);
    sc.road({ free: at(c, -90, R) }, { free: k }, AVENUE);
    sc.road(sc.nodeAt(k), { free: at(k, 55, R - 45) }, { ...AVENUE, kink: true });
  });

  sc.junction('Правый поворот и съезд', cell(5, 2), (c) => {
    sc.cross(c, 0, 170, AVENUE);
    // С севера на юг; южная ветка короче — внизу справа миникарта.
    sc.road({ free: at(c, -90, 170) }, { free: at(c, 90, 120) }, AVENUE);
    // С запада на восток — полоса правого поворота вдоль южного края перед перекрёстком.
    const e = LANE_W * 2.5;
    sc.lane([c.x - 120, c.x - 75, c.x - 30].map((x) => ({ x, y: c.y + e })), 'avenue');
    // С востока на запад — съезд направо (на север) в обход перекрёстка: полоса торможения у северного края, съезд
    // в сторону, въезд на северную ветку (полосу разгона за ним въезд пристраивает сам).
    sc.laneClicks(
      [
        { x: c.x + 160, y: c.y - e },
        { x: c.x + 110, y: c.y - e },
        { x: c.x + 65, y: c.y - 55 },
        { x: c.x + e, y: c.y - 110 },
      ],
      'avenue',
    );
  });

  // ---------- Четвёртый ряд: площадка у изогнутых веток ----------

  sc.junction('Т с изогнутой веткой', cell(0, 3), (c) => {
    // Как у игрока: магистраль 1+1 с севера к перекрёстку, из него — изломом на запад и дугой вниз; с востока к нему —
    // магистраль 2+2. Нижний угол между дугой и магистралью почти развёрнутый: кромка дуги у обреза смотрит мимо.
    const one = { cls: 'highway' as RoadClass, lanes: twoWay(1, 1) };
    sc.road({ free: at(c, -95, 120) }, { free: c }, one);
    sc.road(sc.nodeAt(c), { free: { x: c.x - 170, y: c.y + 70 } }, { ...one, kink: true, control: { x: c.x - 95, y: c.y - 14 } });
    sc.arm(c, 12, R, { cls: 'highway', lanes: twoWay(2, 2) });
  });

  sc.junction('Косой Т, два потока в две полосы', cell(1, 3), (c) => {
    // Проспект 2+2 с востока; на запад от перекрёстка он односторонний (на запад), с юго-запада под 45° — односторонняя
    // ветка в две полосы к перекрёстку. Манёвры ограничены: с востока — прямо на запад, с ветки — только направо (налево
    // на запад запрещено), на восток обеими полосами в обе полосы проспекта. Между двумя потоками с ветки поперёк никто
    // не едет — сплошная.
    const oneWayAvenue: RoadOptions = { cls: 'avenue', lanes: oneWay(2) };
    sc.road({ free: at(c, 0, R) }, { free: c }, AVENUE);
    sc.road(sc.nodeAt(c), { free: at(c, 180, R) }, { ...oneWayAvenue, kink: true });
    sc.road({ free: at(c, 135, R) }, sc.nodeAt(c), oneWayAvenue);
    const node = sc.nodeAt(c);
    const ends = game.roads.net.ends(game.roads.net.node(node));
    const west = ends.find((e) => e.away.x < -0.9)!.corridor.id;
    const branch = ends.find((e) => Math.abs(e.away.x) <= 0.9)!.corridor.id;
    game.setJunction(node, { bans: [`${branch}>${west}`] });
  });

  // Стройка сцены — не расходы игрока: месяц начинается с чистого счёта.
  game.money = game.settings.money;
  game.incomeMonth = game.expensesMonth = 0;
  game.ledger = emptyLedger();
  return { game, view: sc.view(), lines: sc.lines, errors: sc.errors, junctions: sc.junctions };
}

/** Односторонняя улица в две полосы — как «Односторонняя» на панели дорог. */
const ONE_WAY: RoadOptions = { cls: 'street', lanes: oneWay(2) };

/** Точка в r от c в направлении deg градусов (0 — восток, 90 — юг: y вниз). */
function at(c: Vec, deg: number, r: number): Vec {
  const a = (deg * Math.PI) / 180;
  return { x: Math.round((c.x + Math.cos(a) * r) * 100) / 100, y: Math.round((c.y + Math.sin(a) * r) * 100) / 100 };
}

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

/** Строит сцену теми же действиями, что и игрок: дороги, скругления углов, полосы, остановки и маршруты. */
class SceneBuilder {
  readonly lines: Record<string, number> = {};
  readonly errors: string[] = [];
  readonly junctions: SceneJunction[] = [];
  /** Полотна, что были до текущего перекрёстка: всё новое — его. */
  private before = new Set<number>();

  constructor(readonly game: Game) {}

  /**
   * Перекрёсток с подписью name в точке center. Подпись — «город» без домов (как участки сцены «Автобусы»): его
   * имя на карте и в названиях остановок. Что-то не построилось — ошибка в errors, остальные строятся.
   */
  junction(name: string, center: Vec, build: (c: Vec) => void): void {
    this.before = new Set(this.game.roads.net.corridors.keys());
    const town: Town = {
      id: this.game.towns.length + 1,
      name,
      center,
      radius: 200,
      top: center.y - 150,
      style: 'radial',
      population: 0,
      buildings: [],
      streets: [],
      demands: [],
      supplied: {},
      lastSupplied: {},
      tripAcc: 0,
      growthAcc: 0,
      // Сам улиц не прокладывает и не растёт: жителей нет.
      autoStreets: false,
      // Подпись — одно имя, без «· 0» жителей.
      labelOnly: true,
    };
    this.game.towns.push(town);
    try {
      build(center);
    } catch (e) {
      this.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const net = this.game.roads.net;
    const mine = [...net.corridors.values()].filter((c) => !this.before.has(c.id));
    town.streets = mine.map((c) => c.id);
    // Подпись — над самой северной точкой его дорог.
    if (mine.length) town.top = Math.min(...mine.flatMap((c) => [c.curve.p0.y, c.curve.p3.y])) - 10;
    const node = this.junctionNear(center);
    this.junctions.push({ name, center, node: node?.id ?? null, arms: node ? net.ends(node).length : 0 });
  }

  /** Перекрёсток игры ближе всех к точке p (не дальше 30 м). */
  private junctionNear(p: Vec): LaneNode | null {
    const near = this.game.roads.net.nodesNear(p, 30).filter((n) => n.kind === 'junction');
    near.sort((a, b) => Math.hypot(a.pos.x - p.x, a.pos.y - p.y) - Math.hypot(b.pos.x - p.x, b.pos.y - p.y));
    return near[0] ?? null;
  }

  road(a: End, b: End, profile: RoadOptions): void {
    const plan = roadPlan(this.game, a, b, profile);
    if (!plan.ok || !this.game.roadBuilder.apply(plan)) throw new Error(`дорога ${where(a)} → ${where(b)}: ${plan.reason ?? 'не построилась'}`);
  }

  /** Дорога через c под углом deg: от r до r по обе стороны (пересекла готовую — перекрёсток). */
  cross(c: Vec, deg: number, r: number, profile: RoadOptions): void {
    this.road({ free: at(c, deg + 180, r) }, { free: at(c, deg, r) }, profile);
  }

  /**
   * Косой X: две дороги profile пересекаются в c под углом angle (градусы), симметрично к оси запад — восток.
   * Прямыми под острым углом не построить — полотна дальше 45 м от перекрёстка шли бы вплотную («Слишком близко»),
   * поэтому, как сделал бы игрок, каждая ветка выходит из перекрёстка под своим углом и дугой расходится с соседней
   * (через точку изгиба). Сначала первая дорога — с запада в c и дальше на восток, потом вторая — к её узлу.
   */
  skewX(c: Vec, angle: number, profile: RoadOptions): void {
    const half = angle / 2;
    const spread = 22;
    const len = 170;
    const bend = 70;
    // Ветка под углом deg у перекрёстка; away — куда отворачивает от соседней (−1 — к меньшему углу).
    const end = (deg: number, away: number) => at(c, deg + away * spread, len);
    const control = (deg: number) => at(c, deg, bend);
    this.road({ free: end(180 - half, -1) }, { free: c }, { ...profile, control: control(180 - half) });
    const n = this.nodeAt(c);
    this.road(n, { free: end(-half, -1) }, { ...profile, control: control(-half) });
    this.road({ free: end(180 + half, 1) }, n, { ...profile, control: control(180 + half) });
    this.road(n, { free: end(half, 1) }, { ...profile, control: control(half) });
  }

  /** Ветка из поля к перекрёстку (или дороге) в c под углом deg, длиной r. */
  arm(c: Vec, deg: number, r: number, profile: RoadOptions): void {
    const node = this.game.roads.net.nodesNear(c, 3)[0];
    this.road({ free: at(c, deg, r) }, node ? node.id : c, profile);
  }

  /** Узел дороги в точке p. */
  nodeAt(p: Vec): number {
    const node = this.game.roads.net.nodesNear(p, 3)[0];
    if (!node) throw new Error(`нет узла у (${p.x}, ${p.y})`);
    return node.id;
  }

  /** Скругляет острые углы перекрёстка в c радиусом r (не больше предела угла) — как «Двигать» за угол. */
  roundCorners(c: Vec, r: number): void {
    const node = this.junctionNear(c);
    if (!node) throw new Error('скругление: перекрёстка нет');
    const handles = cornerHandles(this.game.roads.net, node).filter((h) => h.corner.theta < Math.PI / 2);
    if (!handles.length) throw new Error('скругление: острых углов нет');
    const plan = this.game.roadBuilder.plan((net) =>
      handles.every((h) => setCornerRadius(net, node.id, h.corner.key, Math.min(r, Math.floor(h.max)))),
    );
    if (!plan.ok || !this.game.roadBuilder.apply(plan)) throw new Error(`скругление: ${plan.reason ?? 'не вышло'}`);
  }

  /** Полоса вдоль края — протяжкой инструментом «Полоса» через точки pts, как это делает игрок мышью. */
  lane(pts: Vec[], cls: RoadClass): void {
    const tools = new RoadTools(() => this.game);
    tools.laneDown(pts[0], 14);
    for (const p of pts.slice(1)) tools.laneMove(p, 14);
    const err = tools.laneUp(pts[pts.length - 1], 14, { cls, lanesF: 1, lanesB: 1 }, true);
    if (err) throw new Error(`полоса от (${pts[0].x}, ${pts[0].y}): ${err}`);
  }

  /**
   * «Полоса по точкам» — кликами, как игрок: первая точка — начало у края дороги, каждая следующая — кусок до неё
   * (вдоль края — полоса, в сторону — съезд, к краю другой дороги — въезд).
   */
  laneClicks(pts: Vec[], cls: RoadClass): void {
    const tools = new RoadTools(() => this.game);
    const spec = { cls, lanesF: 1, lanesB: 1 };
    for (const p of pts) {
      tools.laneDown(p, 14);
      const err = tools.laneUp(p, 14, spec, false);
      if (err) throw new Error(`полоса по точкам у (${p.x}, ${p.y}): ${err}`);
    }
  }

  /**
   * Остановка на ветке перекрёстка c, что уходит под углом deg, в s по дороге от узла; side — у какого края по ходу
   * к перекрёстку (right — для тех, кто едет к нему, left — от него).
   */
  stop(c: Vec, deg: number, s: number, side: 'right' | 'left'): Station {
    const net = this.game.roads.net;
    const node = this.junctionNear(c);
    if (!node) throw new Error(`остановка: нет перекрёстка у (${c.x}, ${c.y})`);
    const want = at({ x: 0, y: 0 }, deg, 1);
    const arm = net.ends(node).sort((a, b) => b.away.x * want.x + b.away.y * want.y - (a.away.x * want.x + a.away.y * want.y))[0];
    const k = arm.corridor;
    const along = arm.end === 'a' ? s : k.length - s;
    const p = k.lut.pointAt(along);
    const t = k.lut.tangentAt(along);
    // К перекрёстку — против хода полотна, если он у его начала.
    const toward = arm.end === 'a' ? { x: -t.x, y: -t.y } : t;
    // Правый край по ходу: направление, повёрнутое направо (y вниз: (x, y) → (−y, x)).
    const sign = side === 'right' ? 1 : -1;
    const q = { x: p.x - toward.y * 22 * sign, y: p.y + toward.x * 22 * sign };
    const st = this.game.placeStation(q, 14, 'stop');
    if (!st) throw new Error(`остановка у (${Math.round(q.x)}, ${Math.round(q.y)}): ${this.game.stationPlan(q, 14, 'stop').reason ?? 'не встала'}`);
    return st;
  }

  /** Маршрут по остановкам (по кругу) и автобусы на нём; key — как его звать из консоли. */
  line(key: string, name: string, stops: Station[], buses: number): void {
    const ids = stops.map((s) => s.id);
    const line = this.game.createLine(ids);
    if (!line) throw new Error(`маршрут «${name}» не создался: ${this.game.lineProblem(ids) ?? 'мало остановок'}`);
    this.game.renameLine(line.id, name);
    this.lines[key] = line.id;
    for (let i = 0; i < buses; i++) if (!this.game.buyVehicle(line.id, 'bus')) throw new Error(`автобус на «${name}» не купить`);
  }

  /** Рамка всей сцены: дороги; сверху — место под подписи. */
  view(): TestScene['view'] {
    const pts = [...this.game.roads.net.nodes.values()].map((n) => n.pos);
    if (!pts.length) return { x0: 0, y0: 0, x1: this.game.terrain.width, y1: this.game.terrain.height };
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const pad = 40;
    return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad - 50, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
  }
}
