import { Cubic, CurveLUT } from '../core/bezier';
import { add, cubicBezier, dist, dot, rightNormal, scale, sub, Vec } from '../core/vec';
import type { Plan, Snap } from '../game/build';
import type { Game, LaneEnd } from '../game/game';
import { bayFront, type Line } from '../game/transport';
import { LaneRenderer } from '../lanes/draw';
import { insideRuns } from '../lanes/edit';
import { edgesAt, laneBand, pointOff, stations as axisStations } from '../lanes/geometry';
import type { CorridorEnd, LaneNet, LaneNode } from '../lanes/model';
import type { Vehicle, VehicleLook } from '../sim/vehicle';
import { wagonFills } from '../sim/wagons';
import { cargoImage } from '../ui/cargoIcons';
import { CARGO, CargoType, FREIGHT } from '../world/cargo';
import { Industry, Station, TOWN_NEED, TownBuilding } from '../world/entities';
import type { Segment } from '../world/network';
import { halfWidth, LANE_W, RAIL_HALF, ROAD_MARGIN, roadEdges } from '../world/roadTypes';
import { Footprint, footprintCorners, footprintRadius } from '../world/spatial';
import { Camera } from './camera';
import { drawIndustryArt } from './industryArt';
import { drawTurnArrows } from './turnArrows';

export type Selection =
  | { type: 'station'; id: number }
  | { type: 'industry'; id: number }
  | { type: 'town'; id: number }
  | { type: 'building'; id: number }
  /** Машина жителя — по её id в симуляции. */
  | { type: 'vehicle'; simId: number }
  /** Машина или поезд компании: выбор сохраняется на остановках и после отправления. */
  | { type: 'fleet'; id: number }
  /** Перекрёсток: светофор, главная дорога, запреты поворотов. */
  | { type: 'junction'; id: number };

export interface ToolOverlay {
  hover: Vec | null;
  snap: Snap | null;
  chainStart: Snap | null;
  control: Vec | null;
  plan: Plan | null;
  /** Ещё дороги в предпросмотре — например, все дороги переносимого узла. */
  plans?: Plan[];
  /** Подсвеченный участок не сносим, а правим — синим. */
  highlightEdit?: boolean;
  /** Перья участка в режиме «Двигать»: концы, управляющие точки и какая из них в руке. */
  /** Перья: от конца участка (anchor) к управляющей точке (pos); partner — перо продолжающей дороги. */
  handles?: { anchor: Vec; pos: Vec; active: boolean; partner: boolean }[] | null;
  highlightSeg: number | null;
  highlightNode: { pos: Vec; ok: boolean; radius: number } | null;
  station: { fp: Footprint; ok: boolean } | null;
  catchmentAt: Vec | null;
  /** Радиус охвата: у вокзала больше. */
  catchmentR: number;
  /** Обгонный путь будущего вокзала. */
  railPreview: Cubic[] | null;
  /** Будущий ж/д сигнал: где и для какого направления (или какой снимем). */
  signal: { pos: Vec; dir: Vec; remove: boolean; oneWay?: boolean } | null;
  /** Будущая развязка по шаблону. */
  template: { curves: Cubic[]; ok: boolean } | null;
  /** Рамка копирования или вставки (углы по порядку): синяя, красная — если вставить нельзя. */
  frame?: { pts: Vec[]; ok: boolean } | null;
  lineStops: number[];
  selectedLine: number | null;
  selection: Selection | null;
  /** Предприятия, подсвеченные из панели цепочек. */
  highlight: number[];
  /** Место, на которое показали из карточки (пульсирующее кольцо на пару секунд). */
  ping: { pos: Vec; r: number } | null;
  /** Рамка сноса и что под неё попадёт. */
  area: { a: Vec; b: Vec; segs: number[]; corridors: number[]; fps: Footprint[] } | null;
  /** Отметки зданий: снос (bad) или место для переноса (ok/bad). */
  marks: { fp: Footprint; ok: boolean }[];
  label: { text: string; ok: boolean } | null;
  heatmap: boolean;
  /** Дороги с тем, что сейчас строим или правим: эта сеть рисуется вместо настоящей, изменённое подсвечено. */
  roads?: { net: LaneNet; ok: boolean; changed: number[] } | null;
  /** Полотно под курсором: снос — красным, правка — синим, перестройка — зелёным. */
  corridor?: { id: number; color: 'red' | 'blue' | 'green' } | null;
  /** Полоса под курсором, которую снесут, — красным. */
  lane?: { corridor: number; lane: number } | null;
  /** Кружки: начало дороги, куда примкнёт, узел под курсором. */
  points?: { pos: Vec; color: string; r?: number }[];
  /** Настройка полос выбранного перекрёстка: метки концов полос, выбранный въезд, метка под курсором. */
  laneEdit: { node: number; ends: LaneEnd[]; from: { seg: number; i: number } | null; hover: LaneEnd | null } | null;
  /** Курсор на варианте главной дороги в карточке перекрёстка: его и показываем (mainPair: null — «Авто», [] — равнозначный). */
  mainHover?: { node: number; mainPair: number[] | null } | null;
}

/** Радиус метки полосы: по ширине полосы, но не меньше нескольких пикселей — чтобы попасть и издалека. */
export const laneMarkRadius = (zoom: number) => Math.max(LANE_W * 0.36, 4 / zoom);

const C = {
  outside: '#a9b98c',
  grass: '#d6e2bd',
  water: '#8cc3e6',
  bank: '#c5e0ee',
  roadEdge: '#4b525c',
  road: '#646b76',
  deck: '#7a828e',
  rail: '#d3d8de',
  shadow: 'rgba(30, 40, 25, 0.25)',
  pillar: 'rgba(70, 76, 84, 0.55)',
  dash: 'rgba(245, 243, 230, 0.85)',
  divider: 'rgba(240, 205, 96, 0.9)',
  island: '#b4cf93',
  trees: ['#8fb46a', '#7aa55a', '#9cc177', '#6e9a52'],
};

/** Радиус кружка пера на экране, пикселей (и за сколько его можно схватить). */
export const HANDLE_PX = 6;
/** Докуда от перекрёстка подсвечена главная дорога (≈ 45 м: полоса — LANE_W ≈ 3,5 м). */
const MAIN_REACH = 90;

/** Стоп-линия шириной STOP_LINE_W — у самого края перекрёстка: линии полос кончаются ровно на ней. */
const STOP_LINE_W = 1.8;
const STOP_LINE_BACK = STOP_LINE_W / 2;
/** Слева стоп-линия не заходит на осевую (жёлтая — 1.4 шириной по оси). */
const STOP_LINE_INSET = 0.8;
/** Названия остановок — начиная с этого приближения; дальше — только значок. */
const STOP_NAMES_ZOOM = 0.75;
/** Плашки ожидающих у автостанций и вокзалов — начиная с этого приближения (у остановок — всегда). */
const STATION_BADGES_ZOOM = 0.3;
/**
 * Над станцией — столбик: внизу плашка ожидающих (её центр — на BADGE_RISE экранных пикселей выше здания),
 * над ней название (плашка 18 пикселей, название — 16,5, между ними зазор ≈ 3).
 */
const BADGE_RISE = 14;
const NAME_RISE = BADGE_RISE + 20;

/** Верхний край здания на карте — по углам повёрнутого прямоугольника, а не по его высоте. */
function topOf(fp: Footprint): number {
  return fp.center.y - (Math.abs(Math.sin(fp.angle)) * fp.w + Math.abs(Math.cos(fp.angle)) * fp.h) / 2;
}

/** Нижний край здания на карте. */
function bottomOf(fp: Footprint): number {
  return 2 * fp.center.y - topOf(fp);
}

/** Остановка, к которой дорога подходит сверху: её название и плашку — под ней, иначе закроют автобус на посадке. */
function labelsBelow(game: Game, st: Station): boolean {
  if (st.kind !== 'stop') return false;
  const node = game.roads.net.nodes.get(st.nodeId);
  return !!node && node.pos.y < st.fp.center.y;
}

/** Метка транспорта выбранной линии: кружок и значок. */
interface LineMark {
  pos: Vec;
  dir: Vec;
  /** Радиус по настоящему размеру машины. */
  r: number;
  cargo: CargoType | null;
  kind: 'truck' | 'bus' | 'freight' | 'passenger';
  color: string;
  load?: string;
}

interface TrainCar {
  pos: Vec;
  dir: Vec;
  level: number;
  loco: boolean;
  color: string;
  load?: string;
  /** Насколько заполнен этот вагон, 0..1: груз занимает вагоны по порядку от головы. */
  fill: number;
  kind: 'freight' | 'passenger';
  length: number;
  trainId: number;
}

/** Участок пути, готовый к рисованию. */
interface SegCache {
  /** Ось и ширина насыпи. */
  surface: Vec[];
  width: number;
  /** Высота вдоль поверхности для теней и тоннелей. */
  heights: number[];
  /** Два рельса и концы шпал парами. */
  rail: { rails: Vec[][]; sleepers: Vec[] };
  bbox: { x0: number; y0: number; x1: number; y1: number };
  maxLevel: number;
  minLevel: number;
  wet: boolean;
  rev: number;
}

/** Поворотники мигают с такой частотой (раз в секунду игрового времени). */
const BLINK_HZ = 1.5;
/** Поворотники рисуются, только если машина на экране не уже стольких пикселей. */
const BLINKER_MIN_PX = 3;
/** Мигают ли и задние огоньки поворотника (пока — только передние). */
const BLINK_REAR = false;

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private cache = new Map<number, SegCache>();
  private cacheVersion = -1;
  private treeVersion = '';
  /** Горят ли поворотники в этом кадре: мигают по игровому времени, на паузе — горят ровно. */
  private blinkOn = false;
  /** По чьей воде отрисовка дорог считает мосты над рекой. */
  private waterOf: unknown = null;
  /** Дороги из полос. */
  private readonly lanes = new LaneRenderer();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly camera: Camera,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D недоступен');
    this.ctx = ctx;
  }

  /** Сбрасывает кэши геометрии и деревьев (например, для новой игры). */
  reset(): void {
    this.cache.clear();
    this.cacheVersion = -1;
    this.treeVersion = '';
    this.lanes.reset();
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.camera.width = w;
    this.camera.height = h;
    this.camera.dpr = dpr;
  }

  private view() {
    const a = this.camera.toWorld(0, 0);
    const b = this.camera.toWorld(this.camera.width, this.camera.height);
    return { x0: a.x - 60, y0: a.y - 60, x1: b.x + 60, y1: b.y + 60 };
  }

  private visible(bb: { x0: number; y0: number; x1: number; y1: number }, v = this.view()): boolean {
    return !(bb.x1 < v.x0 || bb.x0 > v.x1 || bb.y1 < v.y0 || bb.y0 > v.y1);
  }

  draw(game: Game, o: ToolOverlay): void {
    const ctx = this.ctx;
    this.refreshCache(game);
    this.blinkOn = game.speed === 0 || (game.time * BLINK_HZ) % 1 < 0.5;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.outside;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.camera.apply(ctx);

    const view = this.view();
    const segs = [...game.net.segments.values()].filter((s) => this.visible(this.cache.get(s.id)!.bbox, view));
    const vehicles = [...game.traffic.vehicles.values()].filter(
      (v) => v.pos.x > view.x0 && v.pos.x < view.x1 && v.pos.y > view.y0 && v.pos.y < view.y1,
    );
    const band = (v: Vehicle) => v.layer ?? (v.level < -0.5 ? -1 : v.level < 0.5 ? 0 : v.level < 1.5 ? 1 : 2);

    const trains = this.trainCars(game, view);
    const trainBand = (lvl: number) => (lvl < -0.5 ? -1 : lvl < 0.5 ? 0 : lvl < 1.5 ? 1 : 2);

    this.drawTerrain(game, view);
    this.drawTunnels(segs);
    // Дороги — сеть полос (или её копия с тем, что сейчас строим), по слоям высоты; над рекой на земле — мостом.
    const roadNet = o.roads?.net ?? game.roads.net;
    // Вода — вместе со светлой полосой берега (её рисуют на 7 шире).
    // Карта сменилась (новая партия, загрузка) — мосты над рекой считаем по её воде заново.
    if (this.waterOf !== game.terrain) {
      const terrain = game.terrain;
      this.waterOf = terrain;
      this.lanes.reset();
      this.lanes.water = (p) => terrain.isWater(p, 7);
    }
    ctx.globalAlpha = 0.35;
    this.lanes.draw(ctx, roadNet, this.camera.zoom, false, view, -1);
    this.drawVehicles(vehicles.filter((v) => band(v) === -1));
    this.drawTrains(trains.filter((t) => trainBand(t.level) === -1));
    ctx.globalAlpha = 1;
    const groundRails = segs.filter((s) => this.cache.get(s.id)!.maxLevel <= 0.01);
    // Щебень и шпалы под дорогой (на переезде асфальт сверху), рельсы — поверх асфальта.
    this.drawRailBeds(groundRails, false);
    this.lanes.draw(ctx, roadNet, this.camera.zoom, false, view, 0);
    this.drawStationAprons(game, roadNet, view);
    if (o.roads) this.drawRoadPreview(o.roads);
    this.drawStopLines(game, view);
    drawTurnArrows(ctx, game, view, this.camera.zoom);
    this.drawRailSteel(groundRails);
    this.drawCrossings(game, view);
    this.drawSignals(game, view);
    if (o.heatmap) this.drawHeatmap(game);
    this.drawVehicles(vehicles.filter((v) => band(v) === 0));
    // Заезд на пост автостанции — тоже под площадкой: машина уходит под навес, как выезжает из-под него.
    this.drawVehicles(game.enteringLooks().filter((v) => v.pos.x > view.x0 && v.pos.x < view.x1 && v.pos.y > view.y0 && v.pos.y < view.y1));
    this.drawLights(game);
    this.drawStructures(game, view, o);
    this.drawTrains(trains.filter((t) => trainBand(t.level) === 0));
    for (const level of [1, 2]) {
      const rails = segs.filter((s) => {
        const c = this.cache.get(s.id)!;
        return c.maxLevel > level - 0.99 && c.maxLevel <= level + 0.01;
      });
      const roads = this.lanes.hasLayer(roadNet, level);
      if (!rails.length && !roads) continue;
      if (roads) this.lanes.draw(ctx, roadNet, this.camera.zoom, false, view, level);
      this.drawElevated(rails);
      this.drawRailBeds(rails, true);
      this.drawRailSteel(rails);
      this.drawVehicles(vehicles.filter((v) => band(v) === level));
      this.drawTrains(trains.filter((t) => trainBand(t.level) === level));
    }
    this.drawLabels(game, view);
    this.drawOverlay(game, o);
    this.drawStationBadges(game, view);
    this.drawFloaters(game);
    if (o.label && o.hover) this.drawTooltip(o.hover, o.label.text, o.label.ok);
  }

  // ---------- Кэш геометрии путей ----------

  /** Пересобирает кэш только для изменившихся участков. */
  private refreshCache(game: Game): void {
    if (this.cacheVersion === game.net.version) return;
    this.cacheVersion = game.net.version;
    for (const id of [...this.cache.keys()]) if (!game.net.segments.has(id)) this.cache.delete(id);
    for (const s of game.net.segments.values()) {
      if (this.cache.get(s.id)?.rev !== s.rev) this.cache.set(s.id, this.buildCache(game, s));
    }
  }

  private buildCache(game: Game, s: Segment): SegCache {
    const net = game.net;
    const width = halfWidth(s.spec) * 2;
    const surface = s.lut.offsetPolyline(0, 0, s.length, 3);
    const heights = surface.map((_, i) => net.levelAt(s, (s.length * i) / Math.max(1, surface.length - 1)));
    // Рельсы и шпалы — по всей длине, через узлы стрелок без разрывов; в тоннеле их не видно.
    const la = net.node(s.a).level;
    const lb = net.node(s.b).level;
    const cut = la === lb ? null : (-0.4 - la) / (lb - la);
    let v0 = 0;
    let v1 = s.length;
    if (la < -0.4 && lb < -0.4) v1 = 0;
    else if (cut !== null && cut > 0 && cut < 1) {
      if (la < -0.4) v0 = cut * s.length;
      else v1 = cut * s.length;
    }
    const sleepers: Vec[] = [];
    for (let at = v0 + 2; at < v1 - 1; at += 4.5) {
      const p = s.lut.pointAt(at);
      const t = s.lut.tangentAt(at);
      sleepers.push({ x: p.x - t.y * 4.3, y: p.y + t.x * 4.3 }, { x: p.x + t.y * 4.3, y: p.y - t.x * 4.3 });
    }
    const rails = v1 > v0 ? [s.lut.offsetPolyline(2.4, v0, v1, 3), s.lut.offsetPolyline(-2.4, v0, v1, 3)] : [];
    const hw = width / 2 + 8;
    const xs = surface.map((p) => p.x);
    const ys = surface.map((p) => p.y);
    let wet = false;
    for (let i = 0; i < surface.length; i += 3) if (game.terrain.isWater(surface[i], 0)) wet = true;
    return {
      surface,
      width,
      heights,
      rail: { rails, sleepers },
      bbox: { x0: Math.min(...xs) - hw, y0: Math.min(...ys) - hw, x1: Math.max(...xs) + hw, y1: Math.max(...ys) + hw },
      maxLevel: Math.max(...heights),
      minLevel: Math.min(...heights),
      wet,
      rev: s.rev,
    };
  }

  /** Деревья под путями, дорогами (кроме тоннелей), строениями и в кольцах прячутся. */
  private refreshTrees(game: Game): void {
    const key = `${game.net.version}:${game.roads.net.version}:${game.index.items.size}`;
    if (key === this.treeVersion) return;
    this.treeVersion = key;
    const trees = game.terrain.trees;
    const cell = 60;
    const grid = new Map<string, number[]>();
    trees.forEach((t, i) => {
      t.hidden = false;
      const k = `${Math.floor(t.pos.x / cell)}:${Math.floor(t.pos.y / cell)}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k)!.push(i);
    });
    const hideNear = (p: Vec, r: number) => {
      const x0 = Math.floor((p.x - r) / cell);
      const x1 = Math.floor((p.x + r) / cell);
      const y0 = Math.floor((p.y - r) / cell);
      const y1 = Math.floor((p.y + r) / cell);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (const i of grid.get(`${x}:${y}`) ?? []) if (dist(trees[i].pos, p) < r) trees[i].hidden = true;
        }
      }
    };
    for (const s of game.net.segments.values()) {
      const c = this.cache.get(s.id);
      if (!c || c.minLevel < -0.6) continue;
      const r = c.width / 2 + 6;
      for (let i = 0; i < c.surface.length; i += 2) hideNear(c.surface[i], r);
    }
    const roads = game.roads.net;
    for (const c of roads.corridors.values()) {
      for (const s of axisStations(c, 0, c.length, 6)) {
        const e = edgesAt(c, s);
        if (!e || roads.heightAt(c, s) < -0.6) continue;
        hideNear(pointOff(c, s, (e[0] + e[1]) / 2), (e[1] - e[0]) / 2 + 6);
      }
    }
    for (const it of game.index.items) hideNear(it.fp.center, Math.hypot(it.fp.w, it.fp.h) / 2 + 4);
    for (const c of game.roundaboutCenters.values()) hideNear(c, 50);
  }

  // ---------- Рельеф ----------

  private drawTerrain(game: Game, view: ReturnType<Renderer['view']>): void {
    const ctx = this.ctx;
    const t = game.terrain;
    ctx.fillStyle = C.grass;
    ctx.fillRect(0, 0, t.width, t.height);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, t.width, t.height);
    ctx.clip();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [color, extra] of [
      [C.bank, 14],
      [C.water, 0],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      for (const r of t.rivers) {
        ctx.lineWidth = r.width + extra;
        ctx.beginPath();
        smoothPath(ctx, r.points);
        ctx.stroke();
      }
      for (const lake of t.lakes) {
        ctx.beginPath();
        ctx.arc(lake.center.x, lake.center.y, lake.radius + extra / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    this.refreshTrees(game);
    if (this.camera.zoom < 0.18) return;
    for (const tree of t.trees) {
      if (tree.hidden) continue;
      const p = tree.pos;
      if (p.x < view.x0 || p.x > view.x1 || p.y < view.y0 || p.y > view.y1) continue;
      ctx.fillStyle = 'rgba(40, 60, 30, 0.16)';
      ctx.beginPath();
      ctx.arc(p.x + 2, p.y + 2.5, tree.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.trees[Math.floor(tree.shade * C.trees.length)];
      ctx.beginPath();
      ctx.arc(p.x, p.y, tree.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------- Дороги ----------

  private polyline(pts: Vec[]): void {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  }

  private drawTunnels(segs: Segment[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineCap = 'butt';
    for (const s of segs) {
      const c = this.cache.get(s.id)!;
      if (c.minLevel > -0.4) continue;
      const parts = this.splitBy(c, (h) => h < -0.4);
      ctx.strokeStyle = 'rgba(60, 66, 74, 0.35)';
      ctx.lineWidth = c.width + 2;
      for (const part of parts) {
        this.polyline(part);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Куски полилинии, где условие по высоте выполняется. */
  private splitBy(c: SegCache, pred: (h: number) => boolean): Vec[][] {
    const parts: Vec[][] = [];
    let cur: Vec[] = [];
    c.surface.forEach((p, i) => {
      if (pred(c.heights[i])) cur.push(p);
      else if (cur.length) {
        cur.push(p);
        parts.push(cur);
        cur = [];
      }
    });
    if (cur.length > 1) parts.push(cur);
    return parts;
  }

  /** Мосты и эстакады путей: тень со смещением по высоте, опоры и настил. */
  private drawElevated(segs: Segment[]): void {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Пандус с земли: тень — с середины подъёма.
    const isFoot = (c: SegCache) => c.minLevel > -0.01 && c.minLevel <= 0.01;
    ctx.fillStyle = C.shadow;
    for (const s of segs) {
      const c = this.cache.get(s.id)!;
      ctx.strokeStyle = C.shadow;
      ctx.lineWidth = c.width;
      ctx.lineCap = isFoot(c) ? 'butt' : 'round';
      ctx.beginPath();
      let first = true;
      c.surface.forEach((p, i) => {
        const h = Math.max(0, c.heights[i]);
        if (isFoot(c) && h < 0.5) return;
        const x = p.x + h * 6;
        const y = p.y + h * 9;
        if (!first) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        first = false;
      });
      ctx.stroke();
    }
    // Опоры.
    ctx.fillStyle = C.pillar;
    for (const s of segs) {
      const c = this.cache.get(s.id)!;
      for (let i = 6; i < c.surface.length - 3; i += 12) {
        if (c.heights[i] < 0.6) continue;
        const p = c.surface[i];
        const h = c.heights[i];
        ctx.fillRect(p.x - 2.5, p.y - 2.5, 5 + h * 6, 5 + h * 9);
      }
    }
    for (const pass of [0, 1]) {
      for (const s of segs) {
        const c = this.cache.get(s.id)!;
        const parts = c.minLevel < 0.2 ? this.splitBy(c, (h) => h >= -0.4) : [c.surface];
        ctx.lineCap = 'round';
        ctx.strokeStyle = pass === 0 ? C.rail : C.deck;
        ctx.lineWidth = c.width + (pass === 0 ? 5 : 0);
        for (const part of parts) {
          this.polyline(part);
          ctx.stroke();
        }
      }
    }
    ctx.lineCap = 'round';
  }

  /** Насыпь со щебнем и шпалы; на мосту и эстакаде — только шпалы на настиле. */
  private drawRailBeds(segs: Segment[], elevated: boolean): void {
    if (!segs.length) return;
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    if (!elevated) {
      for (const s of segs) {
        const c = this.cache.get(s.id)!;
        const parts = c.minLevel < -0.4 ? this.splitBy(c, (h) => h >= -0.4) : [c.surface];
        const passes: [string, number][] = c.wet
          ? [
              [C.rail, c.width + 6],
              [C.deck, c.width + 2],
            ]
          : [
              ['#9c948a', c.width + 1.5],
              ['#b9b1a6', c.width - 1],
            ];
        for (const [color, width] of passes) {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          for (const part of parts) {
            this.polyline(part);
            ctx.stroke();
          }
        }
      }
    }
    if (this.camera.zoom < 0.45) return;
    ctx.strokeStyle = '#7a5a3c';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const s of segs) {
      const sl = this.cache.get(s.id)!.rail.sleepers;
      for (let i = 0; i + 1 < sl.length; i += 2) {
        ctx.moveTo(sl[i].x, sl[i].y);
        ctx.lineTo(sl[i + 1].x, sl[i + 1].y);
      }
    }
    ctx.stroke();
  }

  /** Сами рельсы — поверх асфальта, чтобы на переезде было видно путь. */
  private drawRailSteel(segs: Segment[]): void {
    if (!segs.length) return;
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = '#4f5965';
    ctx.lineWidth = Math.max(1.1, 0.8 / this.camera.zoom);
    ctx.beginPath();
    for (const s of segs) {
      for (const r of this.cache.get(s.id)!.rail.rails) r.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    }
    ctx.stroke();
  }

  /**
   * Ж/д сигналы: столбик справа по ходу поезда. Зелёный — блок за сигналом свободен,
   * красный — там поезд или бронь.
   */
  private drawSignals(game: Game, view: ReturnType<Renderer['view']>): void {
    if (this.camera.zoom < 0.3) return;
    const net = game.net;
    for (const n of net.nodes.values()) {
      if (!n.signals?.length) continue;
      if (n.pos.x < view.x0 || n.pos.x > view.x1 || n.pos.y < view.y0 || n.pos.y > view.y1) continue;
      for (const out of n.signals) {
        if (!net.segments.has(out)) continue;
        const d = net.dirFrom(n.id, out);
        this.signalPost(add(n.pos, scale({ x: -d.y, y: d.x }, RAIL_HALF + 4)), d, game.rail.isReserved(out) ? '#e8483f' : '#3ad16b', !!n.oneWay?.includes(out));
      }
    }
  }

  /** oneWay — сигнал без встречного: с обратной стороны знак «въезд запрещён» (красный круг с белой чертой). */
  private signalPost(p: Vec, d: Vec, light: string, oneWay = false): void {
    const ctx = this.ctx;
    if (oneWay) {
      const q = add(p, scale(d, 4.4));
      ctx.fillStyle = '#d93a32';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(q.x - d.y * 1.6, q.y + d.x * 1.6);
      ctx.lineTo(q.x + d.y * 1.6, q.y - d.x * 1.6);
      ctx.stroke();
    }
    // Стойка поперёк пути и голова сигнала, смотрящая навстречу поезду.
    ctx.strokeStyle = '#2a2e33';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + d.y * 3, p.y - d.x * 3);
    ctx.stroke();
    ctx.fillStyle = '#2a2e33';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Переезды: шлагбаумы и мигающие красные огни, пока подходит поезд. */
  private drawCrossings(game: Game, view: ReturnType<Renderer['view']>): void {
    if (this.camera.zoom < 0.4) return;
    const ctx = this.ctx;
    const net = game.roads.net;
    const blink = Math.floor(performance.now() / 400) % 2 === 0;
    for (const x of game.levelCrossings) {
      if (x.pos.x < view.x0 || x.pos.x > view.x1 || x.pos.y < view.y0 || x.pos.y > view.y1) continue;
      const c = net.corridors.get(x.corridor);
      if (!c) continue;
      // Два въезда на переезд — с каждой стороны пути; у каждого справа столбик, при поезде — шлагбаум.
      for (const side of [-1, 1]) {
        const cs = Math.max(0, Math.min(c.length, x.s + side * (RAIL_HALF + 4)));
        const p = c.lut.pointAt(cs);
        const along = c.lut.tangentAt(cs);
        const t = scale(along, -side);
        const N = { x: -t.y, y: t.x };
        const e = edgesAt(c, cs) ?? [-LANE_W, LANE_W];
        const half = side < 0 ? e[1] : -e[0];
        const post = add(p, scale(N, half + 2));
        if (x.closed) {
          // Шлагбаум перекрывает въезд на переезд: красно-белая планка.
          const tip = add(p, scale(N, -1));
          ctx.lineCap = 'round';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.moveTo(post.x, post.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          ctx.strokeStyle = '#e8483f';
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(post.x, post.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = '#2a2e33';
        ctx.beginPath();
        ctx.arc(post.x, post.y, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = x.closed && blink ? '#ff4a3d' : '#5a2a28';
        ctx.beginPath();
        ctx.arc(post.x, post.y, 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** Стоп-линии — сплошные, поперёк всех полос подъезда к перекрёстку. */
  private drawStopLines(game: Game, view: ReturnType<Renderer['view']>): void {
    if (this.camera.zoom < 0.6) return;
    const ctx = this.ctx;
    const g = game.roads.graph;
    const net = game.roads.net;
    for (const n of g.nodes.values()) {
      // Стоп-линии — на всех подъездах перекрёстка (и на главной дороге); на кольце — только на въездах.
      const node = net.nodes.get(n.id);
      if (!node || node.kind !== 'junction' || node.corridors.length < 3) continue;
      if (n.pos.x < view.x0 || n.pos.x > view.x1 || n.pos.y < view.y0 || n.pos.y > view.y1) continue;
      const ring = (node.roundabout ?? null) !== null;
      for (const link of g.inLinks.get(n.id) ?? []) {
        if (ring && net.corridors.get(link.corridor)?.ring) continue;
        // Одной чертой поперёк всех полос подъезда (без щелей между полосами), чуть отступив от перекрёстка.
        const first = link.lanes[0];
        const last = link.lanes[link.lanes.length - 1];
        if (!first || !last) continue;
        const l = g.lanePose(first, Math.max(0, first.length - STOP_LINE_BACK));
        const r = g.lanePose(last, Math.max(0, last.length - STOP_LINE_BACK));
        const a = add(l.pos, scale(rightNormal(l.dir), -LANE_W / 2 + STOP_LINE_INSET));
        const b = add(r.pos, scale(rightNormal(r.dir), LANE_W / 2));
        // Белая без прозрачности: стоп-линия заметнее разметки полос.
        ctx.strokeStyle = '#f2f1ea';
        ctx.lineWidth = STOP_LINE_W;
        ctx.lineCap = 'butt';
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  /** Карта пробок: каждая связь графа движения — цветом загрузки (зелёный — свободно, красный — стоят). */
  private drawHeatmap(game: Game): void {
    const ctx = this.ctx;
    const g = game.roads.graph;
    const view = this.view();
    ctx.lineCap = 'round';
    for (const link of g.links.values()) {
      const c = g.net.corridors.get(link.corridor);
      if (!c) continue;
      const mid = c.lut.pointAt((link.s0 + link.s1) / 2);
      if (mid.x < view.x0 - link.length || mid.x > view.x1 + link.length || mid.y < view.y0 - link.length || mid.y > view.y1 + link.length) continue;
      let count = 0;
      let stopped = 0;
      for (const lane of link.lanes) {
        count += lane.vehicles.length;
        for (const v of lane.vehicles) if (v.v < 3) stopped++;
      }
      const density = Math.min(1, (count * 9) / Math.max(10, link.length * link.lanes.length));
      const load = Math.min(1, density * 0.7 + (count ? (stopped / count) * density : 0));
      const off = link.lanes.reduce((a, l) => a + l.offset, 0) / link.lanes.length;
      ctx.strokeStyle = `hsla(${120 - load * 120}, 80%, 46%, 0.8)`;
      ctx.lineWidth = Math.max(2.5, link.lanes.length * 2.5);
      this.polyline(c.lut.offsetPolyline(off, link.s0, link.s1, 6));
      ctx.stroke();
    }
  }

  /** Светофоры: столбик справа от крайней правой полосы каждого въезда, свет — по фазе. */
  private drawLights(game: Game): void {
    if (this.camera.zoom < 0.4) return;
    const ctx = this.ctx;
    const g = game.roads.graph;
    for (const n of g.nodes.values()) {
      const L = n.lights;
      if (!L) continue;
      for (const link of g.inLinks.get(n.id) ?? []) {
        const lane = link.lanes[link.lanes.length - 1];
        const inPhase = L.phases[L.phase].includes(lane.id);
        const color = !inPhase ? '#e8483f' : L.clearing ? '#f2c230' : '#3ad16b';
        const end = g.lanePose(lane, lane.length);
        const N = { x: -end.dir.y, y: end.dir.x };
        const p = add(end.pos, scale(N, LANE_W / 2 + 3));
        ctx.fillStyle = '#2a2e33';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.9, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // ---------- Машины ----------

  /** halo — белая обводка, чтобы машины линии читались поверх её маршрута. */
  private drawVehicles(list: VehicleLook[], halo = false): void {
    const ctx = this.ctx;
    const detailed = this.camera.zoom > 0.5;
    for (const v of list) {
      ctx.save();
      ctx.translate(v.pos.x, v.pos.y);
      ctx.rotate(Math.atan2(v.dir.y, v.dir.x));
      const L = v.length;
      const W = v.width;
      if (halo) {
        const h = Math.max(1.2, 1.6 / this.camera.zoom);
        ctx.fillStyle = '#ffffff';
        rr(ctx, -L - h, -W / 2 - h, L + 2 * h, W + 2 * h, 1.3 + h);
        ctx.fill();
      }
      if (detailed) {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        rr(ctx, -L + 0.8, -W / 2 + 0.9, L, W, 1.2);
        ctx.fill();
      }
      ctx.fillStyle = v.color;
      rr(ctx, -L, -W / 2, L, W, 1.3);
      ctx.fill();
      if (detailed) {
        if (v.kind === 'truck') {
          // Кузов окрашен в цвет груза, пустой — светлый.
          ctx.fillStyle = v.load ?? '#f4efe6';
          ctx.fillRect(-L + 0.6, -W / 2 + 0.6, L - 4.2, W - 1.2);
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.fillRect(-2.6, -W / 2 + 0.8, 1.3, W - 1.6);
        } else if (v.kind === 'bus') {
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          for (let x = -L + 1.5; x < -2; x += 2.4) ctx.fillRect(x, -W / 2 + 0.5, 1.5, 0.8);
          ctx.fillRect(-2.2, -W / 2 + 0.8, 1.2, W - 1.6);
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.45)';
          ctx.fillRect(-2.6, -W / 2 + 0.7, 1.4, W - 1.4);
          ctx.fillStyle = 'rgba(0,0,0,0.18)';
          ctx.fillRect(-L + 1, -W / 2 + 0.7, 1.4, W - 1.4);
        }
      }
      if (v.blinker && this.blinkOn && W * this.camera.zoom >= BLINKER_MIN_PX) this.drawBlinker(L, W, v.blinker);
      ctx.restore();
    }
  }

  /** Огоньки поворотника на углах кузова со стороны поворота: спереди, а с BLINK_REAR и сзади (в системе машины: нос в 0, справа +y). */
  private drawBlinker(L: number, W: number, side: number): void {
    const ctx = this.ctx;
    const r = Math.min(W * 0.2, Math.max(0.6, 1.1 / this.camera.zoom));
    const y = side * (W / 2 - r * 0.6);
    for (const x of BLINK_REAR ? [-r * 0.9, -L + r * 0.9] : [-r * 0.9]) {
      ctx.fillStyle = 'rgba(255, 166, 0, 0.38)';
      ctx.beginPath();
      ctx.arc(x, y, r * 2.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffc21a';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---------- Строения ----------

  private drawStructures(game: Game, view: ReturnType<Renderer['view']>, o: ToolOverlay): void {
    const ctx = this.ctx;
    const inView = (fp: Footprint) =>
      fp.center.x > view.x0 - 100 && fp.center.x < view.x1 + 100 && fp.center.y > view.y0 - 100 && fp.center.y < view.y1 + 100;
    for (const town of game.towns) {
      if (dist(town.center, { x: (view.x0 + view.x1) / 2, y: (view.y0 + view.y1) / 2 }) > (town.extent ?? town.radius) + (view.x1 - view.x0) * 1.2) continue;
      for (const b of town.buildings) if (inView(b.fp)) this.drawBuilding(b);
    }
    for (const ind of game.industries) if (inView(ind.fp)) this.drawIndustry(ind);
    const sel = o.selection;
    for (const st of game.stations.values()) {
      if (!inView(st.fp)) continue;
      const selected = (sel?.type === 'station' && sel.id === st.id) || o.lineStops.includes(st.id);
      if (st.kind === 'rail') this.drawRailStation(game, st, selected);
      else if (st.kind === 'stop') this.drawStop(game, st, selected);
      else this.drawStation(game, st, selected);
    }
    ctx.globalAlpha = 1;
  }

  /** Вокзал: островная платформа между путями, боковая у здания и само здание. */
  private drawRailStation(game: Game, st: Station, selected: boolean): void {
    const ctx = this.ctx;
    const tracks = st.platforms.map((id) => game.net.segments.get(id)).filter((s): s is Segment => !!s);
    const main = tracks[0];
    if (main && tracks.length > 1) {
      const mid = main.lut.pointAt(main.length / 2);
      const t = main.lut.tangentAt(main.length / 2);
      const nextMid = tracks[1].lut.pointAt(tracks[1].length / 2);
      const side = (nextMid.x - mid.x) * -t.y + (nextMid.y - mid.y) * t.x > 0 ? 1 : -1;
      const gap = dist(mid, nextMid);
      // Островные платформы между соседними путями и боковая — у здания за крайним путём.
      const strips: [Vec[], number][] = [];
      for (let i = 0; i < tracks.length - 1; i++) {
        const s = tracks[i];
        strips.push([s.lut.offsetPolyline((side * gap) / 2, 4, s.length - 4, 6), gap - 2 * RAIL_HALF - 1.5]);
      }
      const last = tracks[tracks.length - 1];
      strips.push([last.lut.offsetPolyline(side * (RAIL_HALF + 4.5), 4, last.length - 4, 6), 6]);
      ctx.lineCap = 'butt';
      for (const [pts, w] of strips) {
        ctx.strokeStyle = '#b9b2a6';
        ctx.lineWidth = w + 1.2;
        this.polyline(pts);
        ctx.stroke();
        ctx.strokeStyle = '#e4dfd4';
        ctx.lineWidth = w;
        this.polyline(pts);
        ctx.stroke();
      }
      // Жёлтая линия безопасности у края островных платформ.
      if (this.camera.zoom > 0.6) {
        ctx.strokeStyle = 'rgba(233, 181, 47, 0.8)';
        ctx.lineWidth = 0.6;
        for (let i = 0; i < tracks.length - 1; i++) {
          const s = tracks[i];
          for (const k of [-1, 1]) {
            this.polyline(s.lut.offsetPolyline((side * gap) / 2 + (k * (gap - 2 * RAIL_HALF - 3)) / 2, 6, s.length - 6, 6));
            ctx.stroke();
          }
        }
      }
    }
    const fp = st.fp;
    this.drawFootprint({ ...fp, center: { x: fp.center.x + 3, y: fp.center.y + 4 } }, 'rgba(30,40,25,0.22)');
    this.drawFootprint(fp, '#efe7d8', selected ? '#2f80ed' : '#6b5a4a', selected ? 3 : 1.4);
    ctx.save();
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    // Крыша с коньком и часами над входом.
    ctx.fillStyle = '#9a5a44';
    ctx.fillRect(-fp.w / 2 + 3, -fp.h / 2 + 3, fp.w - 6, fp.h - 6);
    ctx.strokeStyle = '#7a4434';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-fp.w / 2 + 6, 0);
    ctx.lineTo(fp.w / 2 - 6, 0);
    ctx.stroke();
    ctx.fillStyle = '#f7f3ea';
    ctx.beginPath();
    ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Вагоны всех поездов в кадре: середина, направление, высота и внешний вид. */
  private trainCars(game: Game, view: ReturnType<Renderer['view']>): TrainCar[] {
    const out: TrainCar[] = [];
    for (const train of game.rail.trains.values()) {
      // Первый — локомотив, груз — в остальных, по порядку от головы.
      const fills = wagonFills(train.fill ?? (train.load ? 1 : 0), 1, train.cars - 1);
      game.rail.cars(train).forEach((c, k) => {
        if (c.pos.x < view.x0 || c.pos.x > view.x1 || c.pos.y < view.y0 || c.pos.y > view.y1) return;
        const fill = k ? (fills[k - 1] ?? 0) : 0;
        out.push({ ...c, loco: k === 0, color: train.color, load: train.load, fill, kind: train.kind, length: train.carLength, trainId: train.id });
      });
    }
    return out;
  }

  private drawTrains(cars: TrainCar[], halo = false): void {
    const ctx = this.ctx;
    const detailed = this.camera.zoom > 0.5;
    for (const c of cars) {
      const L = c.length - 1.6;
      const W = 6.6;
      ctx.save();
      ctx.translate(c.pos.x, c.pos.y);
      ctx.rotate(Math.atan2(c.dir.y, c.dir.x));
      if (halo) {
        const h = Math.max(1.2, 1.6 / this.camera.zoom);
        ctx.fillStyle = '#ffffff';
        rr(ctx, -L / 2 - h, -W / 2 - h, L + 2 * h, W + 2 * h, 2 + h);
        ctx.fill();
      }
      if (detailed) {
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        rr(ctx, -L / 2 + 1, -W / 2 + 1.2, L, W, 1.6);
        ctx.fill();
      }
      if (c.loco) {
        // Локомотив: тёмный кузов с полосой цвета линии и кабиной впереди.
        ctx.fillStyle = '#34404b';
        rr(ctx, -L / 2, -W / 2, L, W, 2);
        ctx.fill();
        ctx.fillStyle = c.color;
        ctx.fillRect(-L / 2 + 1, -1, L - 2, 2);
        if (detailed) {
          ctx.fillStyle = 'rgba(200, 230, 255, 0.85)';
          ctx.fillRect(L / 2 - 3.2, -W / 2 + 1, 1.6, W - 2);
        }
      } else if (c.kind === 'passenger') {
        ctx.fillStyle = c.color;
        rr(ctx, -L / 2, -W / 2, L, W, 1.6);
        ctx.fill();
        if (detailed) {
          // Окна с пассажирами светятся, пустые — тёмные; занимаются от головы поезда (справа).
          const n = Math.ceil((L - 4) / 3);
          const busy = c.fill > 0 ? Math.ceil(c.fill * n - 1e-6) : 0;
          for (const lit of [false, true]) {
            ctx.fillStyle = lit ? 'rgba(255, 246, 210, 0.95)' : 'rgba(22, 34, 48, 0.5)';
            for (let i = lit ? n - busy : 0; i < (lit ? n : n - busy); i++) {
              const x = -L / 2 + 2 + i * 3;
              ctx.fillRect(x, -W / 2 + 0.7, 1.8, 1);
              ctx.fillRect(x, W / 2 - 1.7, 1.8, 1);
            }
          }
        }
      } else {
        // Грузовой вагон: рама цвета линии, внутри — груз его цветом от передней стенки, остальное — пустой светлый пол.
        // Издалека вагон либо полный, либо пустой: доли в пару пикселей только рябили бы.
        ctx.fillStyle = c.color;
        rr(ctx, -L / 2, -W / 2, L, W, 1.2);
        ctx.fill();
        const f = detailed ? c.fill : c.fill >= 0.5 ? 1 : 0;
        const w = L - 2.4;
        if (f < 1 || !c.load) {
          ctx.fillStyle = '#e6e0d4';
          ctx.fillRect(-L / 2 + 1.2, -W / 2 + 1.2, w, W - 2.4);
        }
        if (f > 0 && c.load) {
          ctx.fillStyle = c.load;
          ctx.fillRect(L / 2 - 1.2 - w * f, -W / 2 + 1.2, w * f, W - 2.4);
        }
      }
      ctx.restore();
    }
  }

  private drawFootprint(fp: Footprint, fill: string, stroke?: string, lw = 1): void {
    const ctx = this.ctx;
    ctx.beginPath();
    footprintCorners(fp).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  }

  private drawBuilding(b: TownBuilding): void {
    const detailed = this.camera.zoom > 0.25;
    const sh = 1.5 + b.floors * 1.4;
    if (detailed) this.drawFootprint({ ...b.fp, center: { x: b.fp.center.x + sh * 0.6, y: b.fp.center.y + sh } }, 'rgba(30,40,25,0.22)');
    if (b.kind === 'landmark') {
      this.drawLandmark(b);
      return;
    }
    this.drawFootprint(b.fp, b.color, detailed ? 'rgba(60,50,40,0.35)' : undefined, 0.8);
    if (!detailed) return;
    const roof = { ...b.fp, w: b.fp.w - 5, h: b.fp.h - 5 };
    this.drawFootprint(roof, b.roof);
    if (b.kind === 'com' && this.camera.zoom > 0.5) {
      this.drawFootprint({ ...roof, w: roof.w * 0.5, h: roof.h * 0.4 }, 'rgba(255,255,255,0.25)');
    } else if (b.floors >= 3 && this.camera.zoom > 0.5) {
      // Многоэтажка: светлые полосы окон на крыше.
      this.drawFootprint({ ...roof, w: roof.w * 0.8, h: 2 }, 'rgba(255,255,255,0.3)');
    }
  }

  /** Ратуша: площадь, здание с куполом и шпилем. */
  private drawLandmark(b: TownBuilding): void {
    const ctx = this.ctx;
    const fp = b.fp;
    this.drawFootprint({ ...fp, w: fp.w + 14, h: fp.h + 14 }, '#e6dcc6', 'rgba(120,100,70,0.35)', 1);
    this.drawFootprint({ ...fp, w: fp.w * 0.8, h: fp.h * 0.6 }, b.color, 'rgba(60,50,40,0.5)', 1);
    ctx.fillStyle = b.roof;
    ctx.beginPath();
    ctx.arc(fp.center.x, fp.center.y, fp.w * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2c94c';
    ctx.beginPath();
    ctx.arc(fp.center.x, fp.center.y, fp.w * 0.07, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Предприятие: участок с лёгкой тенью, постройки — в industryArt (мелочи только вблизи). */
  private drawIndustry(ind: Industry): void {
    const fp = ind.fp;
    this.drawFootprint({ ...fp, center: { x: fp.center.x + 3, y: fp.center.y + 4 } }, 'rgba(30,40,25,0.16)');
    drawIndustryArt(this.ctx, ind, this.camera.zoom, performance.now() / 1000);
  }

  /** Рисует картинку значка размером size в мировых единицах. */
  private icon(img: HTMLImageElement, p: Vec, size: number): void {
    if (!img.complete || !img.naturalWidth) return;
    this.ctx.drawImage(img, p.x - size / 2, p.y - size / 2, size, size);
  }

  /** Остановка: навес у края улицы, знак «А», у бордюра — автобусы на посадке. */
  private drawStop(game: Game, st: Station, selected: boolean): void {
    const ctx = this.ctx;
    const fp = st.fp;
    const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
    // Улица — в сторону узла остановки (он на оси улицы).
    const node = game.roads.net.nodes.get(st.nodeId);
    const toRoad = node ? sub(node.pos, fp.center) : { x: -u.y, y: u.x };
    const l = Math.hypot(toRoad.x, toRoad.y) || 1;
    const n = { x: toRoad.x / l, y: toRoad.y / l };
    // Автобусы на посадке — сами автобусы вдоль бордюра, в крайней полосе, носом по ходу (остановка справа).
    const ahead = dot(rightNormal(u), n) < 0 ? u : scale(u, -1);
    const buses: VehicleLook[] = [];
    for (let i = 0; i < st.occupied.length; i++) {
      const along = (i - (st.occupied.length - 1) / 2) * 14;
      const c = add(add(fp.center, scale(u, along)), scale(n, fp.h / 2 + 2 + LANE_W / 2));
      const look = game.fleetLookAt(st.occupied[i], c, ahead);
      if (look) buses.push(look);
      else this.drawFootprint({ center: c, w: 12, h: 4.6, angle: fp.angle }, '#e07b39', '#8a4a22', 0.8);
    }
    if (buses.length) this.drawVehicles(buses);
    this.drawFootprint({ ...fp, center: { x: fp.center.x + 1.5, y: fp.center.y + 2 } }, 'rgba(30,40,25,0.2)');
    this.drawFootprint(fp, '#f3f1ea', selected ? '#2f80ed' : '#5c6470', selected ? 2.4 : 1.2);
    // Крыша навеса — тёмная полоса со стороны тротуара.
    ctx.save();
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    ctx.fillStyle = '#5c6470';
    const back = dot(n, { x: -u.y, y: u.x }) > 0 ? -1 : 1;
    ctx.fillRect(-fp.w / 2 + 1.5, back > 0 ? fp.h / 2 - 2.6 : -fp.h / 2 + 1, fp.w - 3, 1.6);
    ctx.restore();
    // Знак остановки на краю навеса.
    const sign = add(fp.center, scale(u, fp.w / 2 + 2.5));
    ctx.fillStyle = '#2f80ed';
    ctx.beginPath();
    ctx.arc(sign.x, sign.y, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(sign.x, sign.y, 1, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Автостанция — боксы-посты под одной крышей: задняя стена, у каждого бокса открытые ворота к выезду
   * (площадку перед ними рисует drawStationAprons). Занятый бокс — цвета линии машины, что в нём стоит.
   */
  private drawStation(game: Game, st: Station, selected: boolean): void {
    const ctx = this.ctx;
    const fp = st.fp;
    const gate = game.roads.net.nodes.get(st.nodeId);
    this.drawFootprint({ ...fp, center: { x: fp.center.x + 3, y: fp.center.y + 4 } }, 'rgba(30,40,25,0.22)');
    this.drawFootprint(fp, '#f3f1ea', selected ? '#2f80ed' : '#5c6470', selected ? 3 : 1.4);
    ctx.save();
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    // Локальная +y — к воротам (у грузового двора предприятия площадка повёрнута наоборот).
    ctx.scale(1, gate ? bayFront(fp, gate.pos) : 1);
    const hh = fp.h / 2;
    ctx.fillStyle = '#5c6470';
    ctx.fillRect(-fp.w / 2 + 3, -hh + 3, fp.w - 6, 4);
    const bw = (fp.w - 10) / st.bays;
    const doors = this.camera.zoom > 0.35;
    game.stationBays(st).forEach((color, i) => {
      const x = -fp.w / 2 + 5 + i * bw;
      ctx.fillStyle = color ?? '#d5d2c8';
      ctx.fillRect(x, -1, bw - 2, hh + 1);
      // Открытые ворота — тёмный проём во всю ширину бокса: контур площадки здесь прерывается.
      if (doors) {
        ctx.fillStyle = '#3d434b';
        ctx.fillRect(x, hh - 2, bw - 2, 2.8);
      }
    });
    ctx.restore();
  }

  /**
   * Площадка перед воротами автостанций: прямоугольник во всю ширину здания, состыкованный с выездом
   * двумя скруглениями с каждой стороны — вогнутым у кромки улицы и выпуклым на углу площадки;
   * без бордюра поперёк. На площадке — «зубцы» между местами и стрелки к воротам.
   * Рисуется под машинами: по ней они и заезжают в боксы.
   */
  private drawStationAprons(game: Game, net: LaneNet, view: ReturnType<Renderer['view']>): void {
    const ctx = this.ctx;
    for (const st of game.stations.values()) {
      if (st.kind !== 'road') continue;
      const fp = st.fp;
      if (fp.center.x < view.x0 - 100 || fp.center.x > view.x1 + 100 || fp.center.y < view.y0 - 100 || fp.center.y > view.y1 + 100) continue;
      const node = net.nodes.get(st.nodeId);
      const end = node && net.ends(node)[0];
      if (!node || !end) continue;
      const front = bayFront(fp, node.pos);
      const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
      const v = { x: -u.y * front, y: u.x * front };
      // Координаты площадки: x вдоль боксов, y к выезду (здание — до hh).
      const local = (p: Vec) => ({ x: dot(sub(p, fp.center), u), y: dot(sub(p, fp.center), v) });
      const hh = fp.h / 2;
      // Кромки выезда у ворот — x слева и справа (выезд подходит к площадке поперёк фасада).
      const c = end.corridor;
      const s = end.end === 'a' ? 0 : c.length;
      const ed = edgesAt(c, s) ?? [-LANE_W / 2, LANE_W / 2];
      const [l, r] = [ed[0] - ROAD_MARGIN, ed[1] + ROAD_MARGIN].map((o) => local(pointOff(c, s, o)).x).sort((a, b) => a - b);
      /** Радиус скруглений, если хватает места. */
      const R0 = 6;
      // Глубина площадки — 16 от фасада, но скругление у улицы не ближе 14 к другому концу выезда (там перекрёсток).
      const gy = local(node.pos).y;
      const Y = Math.max(gy + 1.5, Math.min(hh + 16, gy + c.length - 14 - R0 - 1.5));
      // Бока площадки — по углам здания (и не уже выезда), чуть заходя под здание.
      const X0 = Math.min(-fp.w / 2 + 1, l);
      const X1 = Math.max(fp.w / 2 - 1, r);
      const y0 = hh - 1.5;
      // Два скругления поровну; места мало — оба меньше, прямого участка между ними нет.
      const rl = Math.min(R0, (l - X0) / 2);
      const rr = Math.min(R0, (X1 - r) / 2);
      ctx.save();
      ctx.translate(fp.center.x, fp.center.y);
      ctx.rotate(fp.angle);
      ctx.scale(1, front);
      // Бордюр — под асфальтом, как у дорог: от кромки улицы вогнутым скруглением наружу,
      // вдоль площадки, выпуклым скруглением на её углу — и вдоль улицы к углу здания.
      ctx.strokeStyle = C.roadEdge;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(l, Y + rl);
      ctx.arc(l - rl, Y + rl, rl, 0, -Math.PI / 2, true);
      ctx.lineTo(X0 + rl, Y);
      ctx.arc(X0 + rl, Y - rl, rl, Math.PI / 2, Math.PI);
      ctx.lineTo(X0, y0);
      ctx.moveTo(r, Y + rr);
      ctx.arc(r + rr, Y + rr, rr, Math.PI, Math.PI * 1.5);
      ctx.lineTo(X1 - rr, Y);
      ctx.arc(X1 - rr, Y - rr, rr, Math.PI / 2, 0, true);
      ctx.lineTo(X1, y0);
      ctx.stroke();
      // Асфальт: тот же контур; поперёк выезда (там уже асфальт) — чуть дальше, чтобы закрыть концы бордюра.
      ctx.fillStyle = C.road;
      ctx.beginPath();
      ctx.moveTo(X0, y0);
      ctx.lineTo(X0, Y - rl);
      ctx.arc(X0 + rl, Y - rl, rl, Math.PI, Math.PI / 2, true);
      ctx.lineTo(l - rl, Y);
      ctx.arc(l - rl, Y + rl, rl, -Math.PI / 2, 0);
      ctx.lineTo(l, Y + rl + 1.5);
      ctx.lineTo(r, Y + rr + 1.5);
      ctx.lineTo(r, Y + rr);
      ctx.arc(r + rr, Y + rr, rr, Math.PI, Math.PI * 1.5);
      ctx.lineTo(X1 - rr, Y);
      ctx.arc(X1 - rr, Y - rr, rr, Math.PI / 2, 0, true);
      ctx.lineTo(X1, y0);
      ctx.closePath();
      ctx.fill();
      if (this.camera.zoom >= 0.35) {
        const bw = (fp.w - 10) / st.bays;
        // «Зубцы» между местами — продолжают стенки между боксами.
        ctx.strokeStyle = C.dash;
        ctx.lineWidth = 0.8;
        ctx.lineCap = 'butt';
        ctx.beginPath();
        for (let i = 0; i <= st.bays; i++) {
          const x = -fp.w / 2 + 4 + i * bw;
          ctx.moveTo(x, hh);
          ctx.lineTo(x, hh + 3.5);
        }
        ctx.stroke();
        // Стрелка к воротам каждого бокса.
        ctx.fillStyle = C.dash;
        for (let i = 0; i < st.bays; i++) {
          const cx = -fp.w / 2 + 5 + i * bw + (bw - 2) / 2;
          ctx.beginPath();
          ctx.moveTo(cx, hh + 1.2);
          ctx.lineTo(cx + 1.8, hh + 3.6);
          ctx.lineTo(cx - 1.8, hh + 3.6);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  /**
   * Ожидающие на станциях грузы — поверх линий маршрутов, на белых плашках. У остановки в первой плашке
   * впереди — значок автобуса; никто не ждёт — плашка из одного значка (им остановка видна и издалека).
   */
  private drawStationBadges(game: Game, view: ReturnType<Renderer['view']>): void {
    const z = this.camera.zoom;
    if (z <= 0.22) return;
    const ctx = this.ctx;
    for (const st of game.stations.values()) {
      const fp = st.fp;
      if (fp.center.x < view.x0 || fp.center.x > view.x1 || fp.center.y < view.y0 || fp.center.y > view.y1) continue;
      const stop = st.kind === 'stop';
      if (!stop && z < STATION_BADGES_ZOOM) continue;
      const waiting: [CargoType, number][] = FREIGHT.map((c) => [c, Math.floor(st.cargo[c] ?? 0)] as [CargoType, number]).filter(([, n]) => n > 0);
      let pax = 0;
      for (const n of st.passengers.values()) pax += n;
      if (pax > 0) waiting.push(['passengers', pax]);
      if (!waiting.length && !stop) continue;
      ctx.font = `700 ${11 / z}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      /** Место под значок автобуса в начале плашки. */
      const lead = stop ? 18 / z : 0;
      const widths = waiting.length ? waiting.map(([, n], i) => (i ? 0 : lead) + 22 / z + ctx.measureText(String(n)).width + 6 / z) : [18 / z];
      const total = widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * (4 / z);
      let x = fp.center.x - total / 2;
      // Над зданием; название станции — ещё выше (drawLabels). Дорога сверху — под зданием, под названием.
      const y = labelsBelow(game, st) ? bottomOf(fp) + NAME_RISE / z : topOf(fp) - BADGE_RISE / z;
      widths.forEach((w, i) => {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.strokeStyle = 'rgba(60,70,80,0.25)';
        ctx.lineWidth = 1 / z;
        ctx.beginPath();
        ctx.roundRect(x, y - 9 / z, w, 18 / z, 9 / z);
        ctx.fill();
        ctx.stroke();
        if (stop && !i) this.busIcon({ x: x + 9 / z, y }, 17 / z);
        const item = waiting[i];
        if (item) {
          const x0 = x + (i ? 0 : lead);
          this.icon(cargoImage(item[0]), { x: x0 + 9 / z, y }, 15 / z);
          ctx.fillStyle = '#1f2933';
          ctx.fillText(String(item[1]), x0 + 19 / z, y + 0.5 / z);
        }
        x += w + 4 / z;
      });
    }
  }

  private drawLabels(game: Game, view: ReturnType<Renderer['view']>): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const text = (p: Vec, s: string, size: number, color: string, bg?: string) => {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(1 / z, 1 / z);
      ctx.font = `700 ${size}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (bg) {
        const w = ctx.measureText(s).width + 12;
        ctx.fillStyle = bg;
        rr(ctx, -w / 2, -size * 0.75, w, size * 1.5, 6);
        ctx.fill();
      }
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      if (!bg) ctx.strokeText(s, 0, 0);
      ctx.fillStyle = color;
      ctx.fillText(s, 0, 0);
      ctx.restore();
    };
    const near = (p: Vec, pad: number) => p.x > view.x0 - pad && p.x < view.x1 + pad && p.y > view.y0 - pad && p.y < view.y1 + pad;
    for (const t of game.towns) {
      if (!near(t.center, t.radius + 400)) continue;
      const top = { x: t.center.x, y: t.top - 26 / z };
      text(top, `${t.name} · ${t.population}`, 15, '#1f2933');
      // Потребности города: яркий значок — привозили достаточно в прошлом месяце.
      const n = t.demands.length;
      t.demands.forEach((c, i) => {
        const p = { x: t.center.x + ((i - (n - 1) / 2) * 24) / z, y: top.y + 20 / z };
        const ok = (t.lastSupplied[c] ?? 0) >= TOWN_NEED;
        ctx.globalAlpha = ok ? 1 : 0.55;
        this.icon(cargoImage(c), p, 20 / z);
        ctx.globalAlpha = 1;
        if (ok) {
          ctx.strokeStyle = '#2e9d57';
          ctx.lineWidth = 2.5 / z;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 11.5 / z, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
    }
    for (const ind of game.industries) {
      if (!near(ind.fp.center, 200)) continue;
      if (z <= 0.3) {
        // Издалека предприятие видно как значок продукции.
        this.icon(cargoImage(ind.info.produces), ind.fp.center, 24 / z);
        continue;
      }
      // Рецепт — по центру здания, название — под нижним краем.
      const bottom = ind.fp.center.y + Math.max(...footprintCorners(ind.fp).map((p) => p.y - ind.fp.center.y));
      this.drawRecipe(ind, ind.fp.center);
      text({ x: ind.fp.center.x, y: bottom + 14 / z }, ind.info.name, 12, '#3b4652');
    }
    if (z > 0.22) {
      for (const st of game.stations.values()) {
        if (st.industryId !== null) continue;
        // Остановок в городе много: издалека — только значок автобуса на плашке ожидающих, название — вблизи.
        if (st.kind === 'stop' && z < STOP_NAMES_ZOOM) continue;
        // Сверху вниз: название, плашка ожидающих, станция. Место плашки держим и пустым,
        // чтобы название не прыгало, когда груз забрали; плашек ещё не видно — название на её месте.
        const rise = st.kind === 'stop' || z >= STATION_BADGES_ZOOM ? NAME_RISE : BADGE_RISE;
        // Дорога сверху — столбик под остановкой: сначала название, под ним плашка.
        const y = labelsBelow(game, st) ? bottomOf(st.fp) + BADGE_RISE / z : topOf(st.fp) - rise / z;
        text({ x: st.fp.center.x, y }, st.name, 11, '#ffffff', 'rgba(35,45,60,0.82)');
      }
    }
  }

  /** Значок остановки: синий силуэт автобуса (вид сбоку, нос вправо) для белой плашки; size — квадрат 24×24 значка. */
  private busIcon(at: Vec, size: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.scale(size / 24, size / 24);
    ctx.translate(-12, -12);
    ctx.fillStyle = '#2f80ed';
    ctx.beginPath();
    ctx.roundRect(3, 6.3, 18, 9.6, [2, 3.2, 1.2, 1.2]);
    ctx.fill();
    // Два окна и лобовое стекло; колёса — с белым зазором от кузова, как арки.
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(4.6, 7.9, 4.2, 3.4, 0.5);
    ctx.roundRect(10, 7.9, 4.2, 3.4, 0.5);
    ctx.roundRect(15.4, 7.9, 4, 4.4, [0.5, 1.6, 0.5, 0.5]);
    for (const x of [7.6, 16.4]) {
      ctx.moveTo(x + 2.7, 15.9);
      ctx.arc(x, 15.9, 2.7, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = '#1f2933';
    ctx.beginPath();
    for (const x of [7.6, 16.4]) {
      ctx.moveTo(x + 1.9, 15.9);
      ctx.arc(x, 15.9, 1.9, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();
  }

  /** Плашка-рецепт под предприятием: [сырьё] + [сырьё] → [продукт]. */
  private drawRecipe(ind: Industry, at: Vec): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const icon = 16 / z;
    const gap = 5 / z;
    const arrow = 12 / z;
    const inputs = ind.info.accepts;
    const width = (inputs.length ? inputs.length * icon + (inputs.length - 1) * gap + arrow + gap * 2 : 0) + icon + 10 / z;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.roundRect(at.x - width / 2, at.y - 11 / z, width, 22 / z, 11 / z);
    ctx.fill();
    let x = at.x - width / 2 + 5 / z + icon / 2;
    for (const c of inputs) {
      this.icon(cargoImage(c), { x, y: at.y }, icon);
      x += icon + gap;
    }
    if (inputs.length) {
      ctx.strokeStyle = '#55606e';
      ctx.fillStyle = '#55606e';
      ctx.lineWidth = 1.6 / z;
      const ax = x - icon / 2;
      ctx.beginPath();
      ctx.moveTo(ax, at.y);
      ctx.lineTo(ax + arrow - 3 / z, at.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ax + arrow, at.y);
      ctx.lineTo(ax + arrow - 4 / z, at.y - 3 / z);
      ctx.lineTo(ax + arrow - 4 / z, at.y + 3 / z);
      ctx.fill();
      x += arrow + gap;
    }
    this.icon(cargoImage(ind.info.produces), { x, y: at.y }, icon);
  }

  // ---------- Оверлеи ----------

  private drawOverlay(game: Game, o: ToolOverlay): void {
    const ctx = this.ctx;
    if (o.corridor) {
      const color = { red: 'rgba(232,72,63,0.5)', blue: 'rgba(47,128,237,0.35)', green: 'rgba(46,157,87,0.4)' }[o.corridor.color];
      this.tintCorridor(o.roads?.net ?? game.roads.net, o.corridor.id, color);
    }
    if (o.lane) this.tintLane(game.roads.net, o.lane.corridor, o.lane.lane, 'rgba(232,72,63,0.55)');
    for (const pt of o.points ?? []) {
      const z = this.camera.zoom;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.strokeStyle = pt.color;
      ctx.lineWidth = 2 / z;
      ctx.beginPath();
      ctx.arc(pt.pos.x, pt.pos.y, (pt.r ?? 6) / z, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    this.drawPartners(game, o.selection);
    if (o.highlight.length) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
      ctx.strokeStyle = `rgba(47, 128, 237, ${0.5 + pulse * 0.5})`;
      ctx.lineWidth = 4 / this.camera.zoom;
      for (const id of o.highlight) {
        const ind = game.industries.find((i) => i.id === id);
        if (!ind) continue;
        ctx.beginPath();
        ctx.arc(ind.fp.center.x, ind.fp.center.y, footprintRadius(ind.fp) + (10 + pulse * 8) / this.camera.zoom, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (o.area) {
      // Рамка сноса: красный пунктир, всё, что снесётся, — красным.
      const z = this.camera.zoom;
      const { a, b } = o.area;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(232, 72, 63, 0.75)';
      for (const id of o.area.segs) {
        const s = game.net.segments.get(id);
        if (!s) continue;
        ctx.lineWidth = halfWidth(s.spec) * 2 + 4;
        this.polyline(s.lut.points);
        ctx.stroke();
      }
      // Дороги: снесётся только то, что внутри рамки.
      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y);
      const y1 = Math.max(a.y, b.y);
      const inside = (p: Vec) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
      for (const id of o.area.corridors) {
        const c = game.roads.net.corridors.get(id);
        if (!c) continue;
        ctx.lineWidth = c.lanes.length * LANE_W + 6;
        for (const [s0, s1] of insideRuns(c, inside)) {
          const n = Math.max(2, Math.ceil((s1 - s0) / 4));
          this.polyline(Array.from({ length: n + 1 }, (_, i) => c.lut.pointAt(s0 + ((s1 - s0) * i) / n)));
          ctx.stroke();
        }
      }
      for (const fp of o.area.fps) this.drawFootprint({ ...fp, w: fp.w + 4, h: fp.h + 4 }, 'rgba(232,72,63,0.35)', '#e8483f', 2 / z);
      ctx.fillStyle = 'rgba(232, 72, 63, 0.08)';
      ctx.strokeStyle = '#e8483f';
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([8 / z, 6 / z]);
      ctx.beginPath();
      ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (o.ping) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 150);
      ctx.strokeStyle = `rgba(47, 128, 237, ${0.6 + pulse * 0.4})`;
      ctx.lineWidth = 4 / this.camera.zoom;
      ctx.beginPath();
      ctx.arc(o.ping.pos.x, o.ping.pos.y, o.ping.r + (10 + pulse * 10) / this.camera.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (o.catchmentAt) {
      ctx.fillStyle = 'rgba(47, 128, 237, 0.08)';
      ctx.strokeStyle = 'rgba(47, 128, 237, 0.5)';
      ctx.lineWidth = 2 / this.camera.zoom;
      ctx.setLineDash([8 / this.camera.zoom, 6 / this.camera.zoom]);
      ctx.beginPath();
      ctx.arc(o.catchmentAt.x, o.catchmentAt.y, o.catchmentR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Выбрана машина или поезд компании — показываем маршрут её линии, чтобы было видно, куда она едет.
    const fleetLine = o.selection?.type === 'fleet' ? game.fleet.get(o.selection.id)?.lineId : undefined;
    const shownLine = o.selectedLine ?? fleetLine ?? null;
    if (shownLine !== null) this.drawLinePath(game, shownLine);
    if (o.selection?.type === 'fleet') {
      // Станция, к которой машина едет сейчас, — кольцом цвета линии.
      const v = game.fleet.get(o.selection.id);
      const line = v && game.lines.get(v.lineId);
      const st = line && game.stations.get(line.stops[v.stop]);
      if (st) {
        const z = this.camera.zoom;
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 250);
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 3 / z;
        ctx.beginPath();
        ctx.arc(st.fp.center.x, st.fp.center.y, footprintRadius(st.fp) + (8 + pulse * 6) / z, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (o.lineStops.length > 1) this.drawStopsRoute(game, o.lineStops, '#2f80ed', false);
    for (const m of o.marks) {
      ctx.globalAlpha = 0.8;
      this.drawFootprint(m.fp, m.ok ? '#cfe3ff' : 'rgba(232, 72, 63, 0.45)', m.ok ? '#2f80ed' : '#e8483f', 2 / this.camera.zoom);
      ctx.globalAlpha = 1;
    }
    if (o.selection?.type === 'building') {
      const b = game.buildingById(o.selection.id);
      if (b) this.drawFootprint({ ...b.fp, w: b.fp.w + 6, h: b.fp.h + 6 }, 'rgba(47,128,237,0.12)', '#2f80ed', 2.5 / this.camera.zoom);
    }
    if (o.template) {
      // Предпросмотр развязки: все дороги и съезды полупрозрачной полосой.
      ctx.lineCap = 'round';
      ctx.strokeStyle = o.template.ok ? 'rgba(80, 160, 255, 0.5)' : 'rgba(232, 72, 63, 0.5)';
      ctx.lineWidth = 9;
      for (const c of o.template.curves) {
        this.polyline(new CurveLUT(c).points);
        ctx.stroke();
      }
    }
    if (o.frame) {
      const z = this.camera.zoom;
      ctx.fillStyle = o.frame.ok ? 'rgba(47, 128, 237, 0.06)' : 'rgba(232, 72, 63, 0.06)';
      ctx.strokeStyle = o.frame.ok ? '#2f80ed' : '#e8483f';
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([8 / z, 6 / z]);
      ctx.beginPath();
      o.frame.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (o.signal) {
      // Будущий сигнал и стрелка — для поездов какого направления он будет.
      const { pos, dir, remove } = o.signal;
      const color = remove ? '#e8483f' : '#2f80ed';
      const z = this.camera.zoom;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2 / z;
      const a = add(pos, scale(dir, -14));
      const b = add(pos, scale(dir, 14));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b.x + dir.x * 4, b.y + dir.y * 4);
      ctx.lineTo(b.x - dir.y * 3.5, b.y + dir.x * 3.5);
      ctx.lineTo(b.x + dir.y * 3.5, b.y - dir.x * 3.5);
      ctx.fill();
      this.signalPost(add(pos, scale({ x: -dir.y, y: dir.x }, RAIL_HALF + 4)), dir, remove ? '#e8483f' : '#3ad16b', !!o.signal.oneWay && !remove);
    }
    if (o.station) {
      ctx.globalAlpha = 0.75;
      this.drawFootprint(o.station.fp, o.station.ok ? '#cfe3ff' : '#f5c3bf', o.station.ok ? '#2f80ed' : '#e8483f', 2);
      ctx.globalAlpha = 1;
      if (o.railPreview) {
        ctx.lineCap = 'round';
        ctx.strokeStyle = o.station.ok ? 'rgba(80, 160, 255, 0.6)' : 'rgba(232, 72, 63, 0.6)';
        ctx.lineWidth = 2 * RAIL_HALF;
        for (const c of o.railPreview) {
          this.polyline(new CurveLUT(c).points);
          ctx.stroke();
        }
      }
    }
    for (const p of [o.plan, ...(o.plans ?? [])]) {
      if (!p?.lut) continue;
      const e = roadEdges(p.spec);
      const off = (e.right - e.left) / 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = p.ok ? 'rgba(80, 160, 255, 0.55)' : 'rgba(232, 72, 63, 0.55)';
      ctx.lineWidth = e.left + e.right;
      this.polyline(p.lut!.offsetPolyline(off, 0, p.lut!.length, 3));
      ctx.stroke();
      // Высота: подписи уровня на концах, если они разные.
      ctx.fillStyle = '#ffffff';
      for (const c of p.crossings) {
        ctx.beginPath();
        ctx.arc(c.point.x, c.point.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (p.levelA !== p.levelB || p.levelA !== 0) {
        const lut = p.lut as CurveLUT;
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.2;
        this.polyline(lut.offsetPolyline(off, 0, lut.length, 6));
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    if (o.control && o.chainStart) {
      ctx.strokeStyle = 'rgba(47,128,237,0.7)';
      ctx.lineWidth = 1.5 / this.camera.zoom;
      ctx.setLineDash([4 / this.camera.zoom, 4 / this.camera.zoom]);
      ctx.beginPath();
      ctx.moveTo(o.chainStart.pos.x, o.chainStart.pos.y);
      ctx.lineTo(o.control.x, o.control.y);
      if (o.snap) ctx.lineTo(o.snap.pos.x, o.snap.pos.y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.marker(o.control, '#2f80ed', 'square');
    }
    if (o.handles?.length) {
      // Перья: линии от концов к управляющим точкам, сами точки — кружками; перья соседних дорог — бледнее.
      const z = this.camera.zoom;
      ctx.lineWidth = 1.5 / z;
      for (const partner of [true, false]) {
        ctx.strokeStyle = partner ? 'rgba(47,128,237,0.45)' : 'rgba(47,128,237,0.85)';
        ctx.beginPath();
        for (const h of o.handles) {
          if (h.partner !== partner) continue;
          ctx.moveTo(h.anchor.x, h.anchor.y);
          ctx.lineTo(h.pos.x, h.pos.y);
        }
        ctx.stroke();
      }
      for (const h of o.handles) {
        ctx.fillStyle = h.active ? '#2f80ed' : h.partner ? '#dce9fb' : '#ffffff';
        ctx.strokeStyle = h.partner && !h.active ? 'rgba(47,128,237,0.6)' : '#2f80ed';
        ctx.lineWidth = 2 / z;
        ctx.beginPath();
        ctx.arc(h.pos.x, h.pos.y, (h.partner ? HANDLE_PX * 0.85 : HANDLE_PX) / z, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (o.chainStart) this.marker(o.chainStart.pos, '#2f80ed', o.chainStart.kind === 'free' ? 'small' : 'ring');
    if (o.snap) this.marker(o.snap.pos, o.plan && !o.plan.ok ? '#e8483f' : '#2f80ed', o.snap.kind === 'free' ? 'small' : 'ring');
    if (o.highlightSeg !== null) {
      const s = game.net.segments.get(o.highlightSeg);
      const c = s && this.cache.get(s.id);
      if (c) {
        // Красным — под снос, синим — то, что двигаем или гнём.
        ctx.strokeStyle = o.highlightEdit ? 'rgba(47, 128, 237, 0.35)' : 'rgba(232, 72, 63, 0.55)';
        ctx.lineWidth = c.width + 6;
        ctx.lineCap = 'round';
        this.polyline(c.surface);
        ctx.stroke();
      }
    }
    if (o.highlightNode) {
      const h = o.highlightNode;
      ctx.strokeStyle = h.ok ? 'rgba(47, 128, 237, 0.85)' : 'rgba(232, 72, 63, 0.85)';
      ctx.lineWidth = 2.5 / this.camera.zoom;
      ctx.setLineDash([5 / this.camera.zoom, 4 / this.camera.zoom]);
      ctx.beginPath();
      ctx.arc(h.pos.x, h.pos.y, h.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Обводка выбранной машины или поезда (поезд — по середине состава).
    const sel = o.selection;
    if (sel?.type === 'junction') {
      const hover = o.mainHover?.node === sel.id ? o.mainHover : null;
      this.drawJunctionPaths(game, sel.id, o.laneEdit?.node === sel.id ? o.laneEdit : null, game.junctionMain(sel.id, hover ? hover.mainPair : undefined));
    }
    let ring: { x: number; y: number; r: number } | null = null;
    const fleet = sel?.type === 'fleet' ? game.fleet.get(sel.id) : undefined;
    const sim = sel?.type === 'vehicle' ? game.traffic.vehicles.get(sel.simId) : fleet && game.fleetLook(fleet);
    const train = fleet && game.fleetTrain(fleet);
    if (sim) ring = { x: sim.pos.x - (sim.dir.x * sim.length) / 2, y: sim.pos.y - (sim.dir.y * sim.length) / 2, r: sim.length * 0.9 + 3 };
    else if (train) {
      const mid = game.rail.pointAt(train, train.head - train.length / 2);
      if (mid) ring = { x: mid.pos.x, y: mid.pos.y, r: train.length / 2 + 8 };
    }
    if (ring) {
      ctx.strokeStyle = '#2f80ed';
      ctx.lineWidth = 2 / this.camera.zoom;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /**
   * Предпросмотр перестройки: будущая дорога поверх старой на зелёной подложке —
   * новая ширина, разметка полос и кромок, у односторонней — стрелки направления.
   */
  /** Что строим: изменённые полотна сети предпросмотра — зелёной (можно) или красной (нельзя) подсветкой. */
  private drawRoadPreview(p: NonNullable<ToolOverlay['roads']>): void {
    for (const id of p.changed) this.tintCorridor(p.net, id, p.ok ? 'rgba(46,157,87,0.28)' : 'rgba(232,72,63,0.4)');
  }

  /** Полупрозрачная заливка асфальта полотна. */
  /** Одна полоса полотна — заливкой по её ширине (с отгонами). */
  private tintLane(net: LaneNet, id: number, i: number, color: string): void {
    const c = net.corridors.get(id);
    const lane = c?.lanes[i];
    if (!c || !lane) return;
    const left: Vec[] = [];
    const right: Vec[] = [];
    for (const s of axisStations(c, 0, c.length, 4)) {
      const b = laneBand(c, lane, s);
      if (!b) continue;
      left.push(pointOff(c, s, b[0]));
      right.push(pointOff(c, s, b[1]));
    }
    if (left.length < 2) return;
    this.ctx.fillStyle = color;
    this.polyline([...left, ...right.reverse()]);
    this.ctx.closePath();
    this.ctx.fill();
  }

  private tintCorridor(net: LaneNet, id: number, color: string): void {
    const c = net.corridors.get(id);
    if (!c) return;
    const left: Vec[] = [];
    const right: Vec[] = [];
    for (const s of axisStations(c, 0, c.length, 5)) {
      const e = edgesAt(c, s);
      if (!e) continue;
      left.push(pointOff(c, s, e[0] - ROAD_MARGIN));
      right.push(pointOff(c, s, e[1] + ROAD_MARGIN));
    }
    if (left.length < 2) return;
    const ctx = this.ctx;
    ctx.fillStyle = color;
    this.polyline([...left, ...right.reverse()]);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Выбранный перекрёсток: разрешённые проезды — синие линии со стрелками, запрещённые — красный пунктир.
   * При настройке полос выбранная полоса въезда и её связи — зелёные, остальные проезды бледнее.
   * main — главная дорога (или та, на которую навели в карточке): жёлтая полоса и знаки у въездов.
   */
  private drawJunctionPaths(game: Game, nodeId: number, edit: ToolOverlay['laneEdit'], main: [number, number] | null): void {
    const ctx = this.ctx;
    const net = game.roads.net;
    const g = game.roads.graph;
    const n = net.nodes.get(nodeId);
    if (!n) return;
    const z = this.camera.zoom;
    const all = (g.inLinks.get(nodeId) ?? []).flatMap((l) => l.lanes.flatMap((lane) => g.movesFrom.get(lane.id) ?? [])).filter((m) => m.node === nodeId);
    const radius = Math.max(12, ...all.map((m) => dist(n.pos, m.points[0])));
    if (main) this.drawMainBand(net, n, main);
    ctx.strokeStyle = 'rgba(47,128,237,0.55)';
    ctx.lineWidth = 3 / z;
    ctx.beginPath();
    ctx.arc(n.pos.x, n.pos.y, radius + 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineCap = 'round';
    const from = edit?.from ?? null;
    const active = from ? edit?.ends.find((e) => e.kind === 'in' && e.seg === from.seg && e.i === from.i) : undefined;
    const mine = all.filter((m) => m.inLane === active?.lane);
    for (const m of [...all.filter((x) => !mine.includes(x)), ...mine]) {
      const bright = mine.includes(m);
      const color = bright ? '#27ae60' : '#2f80ed';
      ctx.globalAlpha = active && !bright ? 0.25 : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = (bright ? 3 : 1.6) / z;
      this.polyline(m.points);
      ctx.stroke();
      const end = m.points[m.points.length - 1];
      const prev = m.points[m.points.length - 2] ?? m.points[0];
      const d = { x: end.x - prev.x, y: end.y - prev.y };
      const l = Math.hypot(d.x, d.y) || 1;
      const u = { x: d.x / l, y: d.y / l };
      const s = (bright ? 4.5 : 3) / z;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(end.x + u.x * s, end.y + u.y * s);
      ctx.lineTo(end.x - u.x * s - u.y * s, end.y - u.y * s + u.x * s);
      ctx.lineTo(end.x - u.x * s + u.y * s, end.y - u.y * s - u.x * s);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (edit) this.drawLaneMarks(game, edit, active);
    // Запрещённые повороты: от подъезда к выезду.
    ctx.strokeStyle = 'rgba(232,72,63,0.85)';
    ctx.lineWidth = 2 / z;
    ctx.setLineDash([4 / z, 4 / z]);
    const ends = net.ends(n);
    for (const key of n.bans ?? []) {
      const [from, to] = key.split('>').map(Number);
      const ef = ends.find((e) => e.corridor.id === from);
      const et = ends.find((e) => e.corridor.id === to);
      if (!ef || !et) continue;
      const a = add(n.pos, scale(ef.away, radius + 8));
      const b = add(n.pos, scale(et.away, radius + 8));
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(n.pos.x, n.pos.y, b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (main) this.drawPrioritySigns(net, n, main, new Set((g.inLinks.get(nodeId) ?? []).map((l) => l.corridor)), radius);
  }

  /**
   * Главная дорога через перекрёсток — одна полупрозрачная жёлтая лента по середине полотна:
   * плечо A от дальнего конца к краю узла, через узел — кривая с касательными по плечам, плечо B наружу.
   * Ширина — ровно по полотну (в узле плавно переходит от плеча к плечу), к концам лента тает.
   */
  private drawMainBand(net: LaneNet, n: LaneNode, main: [number, number]): void {
    const ctx = this.ctx;
    const ends = net.ends(n);
    const arms = main.map((id) => ends.find((e) => e.corridor.id === id));
    if (!arms[0] || !arms[1]) return;
    const cuts = this.lanes.cutsOf(net);
    // Плечо от края узла наружу (до MAIN_REACH и не заходя в узел на том конце): середина и полуширина полотна.
    const arm = (e: CorridorEnd) => {
      const c = e.corridor;
      const [ca, cb] = cuts.get(c.id) ?? [0, 0];
      const [near, other] = e.end === 'a' ? [ca, cb] : [cb, ca];
      const far = Math.max(near, Math.min(MAIN_REACH, c.length - other));
      const ss = e.end === 'a' ? axisStations(c, near, far, 4) : axisStations(c, c.length - far, c.length - near, 4).reverse();
      const pts: { p: Vec; h: number }[] = [];
      for (const s of ss) {
        const ed = edgesAt(c, s);
        if (ed) pts.push({ p: pointOff(c, s, (ed[0] + ed[1]) / 2), h: (ed[1] - ed[0]) / 2 });
      }
      // Направление от узла на краю узла.
      const away = scale(c.lut.tangentAt(e.end === 'a' ? near : c.length - near), e.end === 'a' ? 1 : -1);
      return { pts, away };
    };
    const A = arm(arms[0]);
    const B = arm(arms[1]);
    if (A.pts.length < 2 || B.pts.length < 2) return;
    // Через узел — кривая Безье между краями плеч, касательные — по плечам; ширина меняется плавно.
    const a0 = A.pts[0];
    const b0 = B.pts[0];
    const k = dist(a0.p, b0.p) * 0.45;
    const c1 = sub(a0.p, scale(A.away, k));
    const c2 = sub(b0.p, scale(B.away, k));
    const through: { p: Vec; h: number }[] = [];
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      through.push({ p: cubicBezier(a0.p, c1, c2, b0.p, t), h: a0.h + (b0.h - a0.h) * t * t * (3 - 2 * t) });
    }
    const line = [...[...A.pts].reverse(), ...through, ...B.pts].filter((q, i, all) => i === 0 || dist(q.p, all[i - 1].p) > 0.05);
    if (line.length < 2) return;
    // Края ленты — на полуширину вправо и влево от середины по ходу ленты.
    const right: Vec[] = [];
    const left: Vec[] = [];
    line.forEach((q, i) => {
      const d = sub(line[Math.min(line.length - 1, i + 1)].p, line[Math.max(0, i - 1)].p);
      const nrm = rightNormal(scale(d, 1 / (Math.hypot(d.x, d.y) || 1)));
      right.push(add(q.p, scale(nrm, q.h)));
      left.push(sub(q.p, scale(nrm, q.h)));
    });
    // Тает от узла: до середины — ровно, к ближнему из дальних концов — до нуля.
    const reach = Math.max(40, Math.min(MAIN_REACH, dist(n.pos, line[0].p), dist(n.pos, line[line.length - 1].p)));
    const grad = ctx.createRadialGradient(n.pos.x, n.pos.y, 0, n.pos.x, n.pos.y, reach);
    grad.addColorStop(0, 'rgba(255,196,0,0.42)');
    grad.addColorStop(0.5, 'rgba(255,196,0,0.42)');
    grad.addColorStop(1, 'rgba(255,196,0,0)');
    ctx.fillStyle = grad;
    this.polyline([...right, ...left.reverse()]);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Знаки у въездов в перекрёсток, справа по ходу: жёлтый ромб «Главная дорога» — у главных плеч,
   * треугольник «Уступи дорогу» — у второстепенных. Только там, где в перекрёсток въезжают (inArms).
   */
  private drawPrioritySigns(net: LaneNet, n: LaneNode, main: [number, number], inArms: Set<number>, radius: number): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    // Издалека — 8 пикселей, вблизи растёт вместе с дорогой.
    const k = Math.max(8 / z, LANE_W * 0.3);
    ctx.lineJoin = 'round';
    for (const e of net.ends(n)) {
      const c = e.corridor;
      if (!inArms.has(c.id)) continue;
      const d = Math.min(c.length, radius + k * 1.5);
      const s = e.end === 'a' ? d : c.length - d;
      const ed = edgesAt(c, s) ?? [-LANE_W, LANE_W];
      // Справа по ходу въезда: у конца a едут против оси (левая кромка), у конца b — по оси (правая).
      const p = pointOff(c, s, e.end === 'a' ? ed[0] - ROAD_MARGIN - k * 1.3 : ed[1] + ROAD_MARGIN + k * 1.3);
      if (main.includes(c.id)) {
        // 2.1 «Главная дорога»: белый ромб, в нём жёлтый.
        const diamond = (r: number) => {
          ctx.beginPath();
          ctx.moveTo(p.x, p.y - r);
          ctx.lineTo(p.x + r, p.y);
          ctx.lineTo(p.x, p.y + r);
          ctx.lineTo(p.x - r, p.y);
          ctx.closePath();
        };
        diamond(k);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#1f2933';
        ctx.lineWidth = 1.2 / z;
        ctx.stroke();
        diamond(k * 0.6);
        ctx.fillStyle = '#f5b800';
        ctx.fill();
        ctx.lineWidth = 0.8 / z;
        ctx.stroke();
      } else {
        // 2.4 «Уступи дорогу»: белый треугольник вершиной вниз в красной кайме.
        const tri = (r: number) => {
          ctx.beginPath();
          ctx.moveTo(p.x - r, p.y - r * 0.6);
          ctx.lineTo(p.x + r, p.y - r * 0.6);
          ctx.lineTo(p.x, p.y + r * 1.05);
          ctx.closePath();
        };
        tri(k * 1.05);
        ctx.fillStyle = '#e8483f';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2 / z;
        ctx.stroke();
        tri(k * 0.55);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
    }
  }

  /**
   * Метки полос для настройки связей. Въезд — белый кружок с тёмной обводкой (настроенный — с зелёной),
   * выезд — оранжевый; выезд, связанный с выбранной полосой, — зелёный, недоступный ей — бледный.
   * Треугольник внутри показывает направление движения по полосе.
   */
  private drawLaneMarks(game: Game, edit: NonNullable<ToolOverlay['laneEdit']>, active: LaneEnd | undefined): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const r = laneMarkRadius(z);
    const linked = new Set(active ? (game.roads.graph.movesFrom.get(active.lane) ?? []).map((m) => m.outLane) : []);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 200);
    for (const e of edit.ends) {
      const isActive = e.lane === active?.lane;
      const hover = e.lane === edit.hover?.lane;
      const rr = r * (isActive ? 1.3 : 1) * (hover ? 1.25 : 1);
      ctx.globalAlpha = active && e.kind === 'out' && !active.exits.includes(e.seg) ? 0.3 : 1;
      let fill: string;
      let ring: string;
      let mark: string;
      if (e.kind === 'in') {
        fill = isActive ? '#27ae60' : '#ffffff';
        ring = e.custom || isActive ? '#1e8c4e' : '#1f2933';
        mark = isActive ? '#ffffff' : '#1f2933';
      } else {
        fill = linked.has(e.lane) ? '#27ae60' : '#f2994a';
        ring = '#ffffff';
        mark = '#ffffff';
      }
      ctx.fillStyle = fill;
      ctx.strokeStyle = ring;
      ctx.lineWidth = (e.custom ? 2.4 : 1.4) / z;
      ctx.beginPath();
      ctx.arc(e.pos.x, e.pos.y, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      const s = rr * 0.55;
      const d = e.dir;
      ctx.fillStyle = mark;
      ctx.beginPath();
      ctx.moveTo(e.pos.x + d.x * s, e.pos.y + d.y * s);
      ctx.lineTo(e.pos.x - d.x * s * 0.7 - d.y * s * 0.8, e.pos.y - d.y * s * 0.7 + d.x * s * 0.8);
      ctx.lineTo(e.pos.x - d.x * s * 0.7 + d.y * s * 0.8, e.pos.y - d.y * s * 0.7 - d.x * s * 0.8);
      ctx.fill();
      if (isActive) {
        ctx.strokeStyle = `rgba(39, 174, 96, ${0.35 + pulse * 0.45})`;
        ctx.lineWidth = 2 / z;
        ctx.beginPath();
        ctx.arc(e.pos.x, e.pos.y, rr + (3 + pulse * 3) / z, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Пунктиры от выбранного предприятия или города к ближайшим партнёрам по цепочке. */
  private drawPartners(game: Game, sel: Selection | null): void {
    if (!sel || (sel.type !== 'industry' && sel.type !== 'town')) return;
    const target = sel.type === 'industry' ? game.industries.find((i) => i.id === sel.id) : game.towns.find((t) => t.id === sel.id);
    if (!target) return;
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const from = 'fp' in target ? target.fp.center : target.center;
    for (const p of game.partners(target)) {
      const color = CARGO[p.cargo].color;
      const [a, b] = p.direction === 'out' ? [from, p.pos] : [p.pos, from];
      const d = { x: b.x - a.x, y: b.y - a.y };
      const len = Math.hypot(d.x, d.y) || 1;
      const u = { x: d.x / len, y: d.y / len };
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 3.5 / z;
      ctx.setLineDash([14 / z, 9 / z]);
      ctx.beginPath();
      ctx.moveTo(a.x + u.x * 40, a.y + u.y * 40);
      ctx.lineTo(b.x - u.x * 60, b.y - u.y * 60);
      ctx.stroke();
      ctx.setLineDash([]);
      // Стрелка у получателя.
      const tip = { x: b.x - u.x * 50, y: b.y - u.y * 50 };
      const s = 12 / z;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - u.x * s * 1.6 - u.y * s, tip.y - u.y * s * 1.6 + u.x * s);
      ctx.lineTo(tip.x - u.x * s * 1.6 + u.y * s, tip.y - u.y * s * 1.6 - u.x * s);
      ctx.fill();
      ctx.globalAlpha = 1;
      // Посередине пунктира — плашка «что везём · сколько км», прямо на линии,
      // чтобы не казалось, что партнёр стоит здесь.
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      ctx.save();
      ctx.translate(mid.x, mid.y);
      ctx.scale(1 / z, 1 / z);
      ctx.font = '700 11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const km = `${(p.distance * 0.0006).toFixed(1)} км`;
      const w = ctx.measureText(km).width + 30;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      rr(ctx, -w / 2, -10, w, 20, 10);
      ctx.fill();
      ctx.stroke();
      this.icon(cargoImage(p.cargo), { x: -w / 2 + 11, y: 0 }, 14);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#1f2933';
      ctx.fillText(km, -w / 2 + 21, 0.5);
      ctx.restore();
      // Сам партнёр — кольцом цвета груза, название — над ним (под ним уже своя подпись).
      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      ctx.scale(1 / z, 1 / z);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 24, 0, Math.PI * 2);
      ctx.stroke();
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(p.name, 0, -36);
      ctx.fillStyle = '#1f2933';
      ctx.fillText(p.name, 0, -36);
      ctx.restore();
    }
  }

  private drawLinePath(game: Game, lineId: number): void {
    const line = game.lines.get(lineId);
    if (!line) return;
    this.drawStopsRoute(game, line.stops, line.color, true, line);
    // Машины и поезда линии — поверх маршрута, иначе их не видно под цветной полосой.
    // Под каждой — кружок цвета линии постоянного экранного размера: видно и издалека.
    const z = this.camera.zoom;
    const own: VehicleLook[] = [];
    const trains = new Set<number>();
    const marks: LineMark[] = [];
    for (const vid of line.vehicles) {
      const fv = game.fleet.get(vid);
      if (!fv) continue;
      const cargo = fv.cargo && fv.amount > 0 ? fv.cargo : fv.passengers.some((p) => p.count > 0) ? 'passengers' : null;
      // На дороге или на заезде к посту.
      const sim = game.fleetLook(fv);
      if (sim) {
        own.push(sim);
        const pos = { x: sim.pos.x - (sim.dir.x * sim.length) / 2, y: sim.pos.y - (sim.dir.y * sim.length) / 2 };
        marks.push({ pos, dir: sim.dir, r: sim.length * 0.7 + 2, cargo, kind: sim.kind === 'bus' ? 'bus' : 'truck', color: sim.color, load: sim.load });
      }
      const train = game.fleetTrain(fv);
      if (train) {
        trains.add(train.id);
        const head = game.rail.pointAt(train, train.head - 6);
        if (head) marks.push({ pos: head.pos, dir: head.dir, r: 10, cargo, kind: train.kind, color: train.color, load: train.load });
      }
    }
    const ctx = this.ctx;
    const R = (m: LineMark) => Math.max(m.r, 12 / z);
    for (const m of marks) {
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 3 / z;
      ctx.beginPath();
      ctx.arc(m.pos.x, m.pos.y, R(m), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    this.drawVehicles(own, true);
    if (trains.size) this.drawTrains(this.trainCars(game, this.view()).filter((c) => trains.has(c.trainId)), true);
    for (const m of marks) {
      const r = R(m);
      // Издалека настоящая машина крошечная — рисуем внутри кружка её увеличенный значок.
      if (m.r < r * 0.75) this.markGlyph(m, r);
      // Что везёт — значок сбоку от кружка.
      if (m.cargo) this.icon(cargoImage(m.cargo), { x: m.pos.x + r * 0.8, y: m.pos.y - r * 0.8 }, 14 / z);
    }
  }

  /** Значок транспорта линии по размеру кружка: кабина и кузов цвета груза, автобус с окнами, локомотив с вагоном. */
  private markGlyph(m: LineMark, r: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(m.pos.x, m.pos.y);
    ctx.rotate(Math.atan2(m.dir.y, m.dir.x));
    const L = r * 1.5;
    const W = r * 0.62;
    const x0 = -L / 2;
    const empty = '#f4efe6';
    ctx.lineWidth = r * 0.06;
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    const box = (x: number, w: number, fill: string) => {
      ctx.fillStyle = fill;
      rr(ctx, x, -W / 2, w, W, W * 0.18);
      ctx.fill();
      ctx.stroke();
    };
    if (m.kind === 'truck') {
      box(x0, L * 0.68, m.load ?? empty);
      box(x0 + L * 0.72, L * 0.28, m.color);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x0 + L * 0.9, -W * 0.36, L * 0.06, W * 0.72);
    } else if (m.kind === 'bus') {
      box(x0, L, m.color);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      for (let i = 0; i < 4; i++) ctx.fillRect(x0 + L * (0.1 + i * 0.19), -W * 0.38, L * 0.12, W * 0.2);
      ctx.fillRect(x0 + L * 0.9, -W * 0.36, L * 0.06, W * 0.72);
    } else {
      // Вагон сзади — цвета груза (у пассажирского светлый с окнами), локомотив спереди.
      const wagon = m.kind === 'passenger' ? '#eef1f4' : (m.load ?? empty);
      box(x0, L * 0.46, wagon);
      if (m.kind === 'passenger') {
        ctx.fillStyle = 'rgba(60,80,100,0.6)';
        for (let i = 0; i < 3; i++) ctx.fillRect(x0 + L * (0.06 + i * 0.13), -W * 0.3, L * 0.08, W * 0.6);
      }
      box(x0 + L * 0.5, L * 0.5, m.color);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.fillRect(x0 + L * 0.88, -W * 0.36, L * 0.06, W * 0.72);
    }
    ctx.restore();
  }

  /**
   * Маршрут по станциям: по реальным полосам, со стрелками направления.
   * Если между станциями нет дороги — красный пунктир напрямую.
   */
  private drawStopsRoute(game: Game, stops: number[], color: string, loop: boolean, line?: Line): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const legs = loop ? stops.length : stops.length - 1;
    for (let i = 0; i < legs; i++) {
      const fromId = stops[i];
      const toId = stops[(i + 1) % stops.length];
      // У линии — до выбранных путей ж/д станций.
      const pts = line ? game.linePolyline(line, i) : game.routePolyline(fromId, toId);
      if (!pts || pts.length < 2) {
        const a = game.stations.get(fromId);
        const b = game.stations.get(toId);
        if (!a || !b) continue;
        ctx.strokeStyle = 'rgba(232, 72, 63, 0.85)';
        ctx.lineWidth = 3 / z;
        ctx.setLineDash([10 / z, 8 / z]);
        ctx.beginPath();
        ctx.moveTo(a.fp.center.x, a.fp.center.y);
        ctx.lineTo(b.fp.center.x, b.fp.center.y);
        ctx.stroke();
        ctx.setLineDash([]);
        continue;
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 6.5 / z;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      this.polyline(pts);
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 4 / z;
      this.polyline(pts);
      ctx.stroke();
      // Стрелки направления движения через равные промежутки экрана.
      const spacing = 90 / z;
      let acc = spacing / 2;
      ctx.fillStyle = '#ffffff';
      for (let k = 1; k < pts.length; k++) {
        const p0 = pts[k - 1];
        const p1 = pts[k];
        const seg = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        if (seg < 1e-6) continue;
        const ux = (p1.x - p0.x) / seg;
        const uy = (p1.y - p0.y) / seg;
        while (acc <= seg) {
          const cx = p0.x + ux * acc;
          const cy = p0.y + uy * acc;
          const s = 3.2 / z;
          ctx.beginPath();
          ctx.moveTo(cx + ux * s * 1.4, cy + uy * s * 1.4);
          ctx.lineTo(cx - ux * s - uy * s, cy - uy * s + ux * s);
          ctx.lineTo(cx - ux * s + uy * s, cy - uy * s - ux * s);
          ctx.fill();
          acc += spacing;
        }
        acc -= seg;
      }
    }
  }

  private marker(p: Vec, color: string, shape: 'ring' | 'small' | 'square'): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / z;
    ctx.beginPath();
    if (shape === 'square') ctx.rect(p.x - 4 / z, p.y - 4 / z, 8 / z, 8 / z);
    else ctx.arc(p.x, p.y, (shape === 'ring' ? 8 : 5) / z, 0, Math.PI * 2);
    ctx.stroke();
  }

  private drawTooltip(at: Vec, text: string, ok: boolean): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.scale(1 / z, 1 / z);
    ctx.font = '600 13px system-ui, -apple-system, sans-serif';
    const w = ctx.measureText(text).width + 14;
    ctx.fillStyle = ok ? 'rgba(25, 32, 45, 0.88)' : 'rgba(170, 40, 35, 0.92)';
    rr(ctx, 16, 14, w, 24, 6);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(text, 23, 31);
    ctx.restore();
  }

  private drawFloaters(game: Game): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    for (const f of game.floaters) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - f.age / 2.5);
      ctx.translate(f.pos.x, f.pos.y - 20 / z - (f.age * 18) / z);
      ctx.scale(1 / z, 1 / z);
      ctx.font = '800 14px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText(f.text, 0, 0);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, 0, 0);
      ctx.restore();
    }
  }
}

/** Гладкая линия через точки: квадратичные кривые между серединами отрезков. */
export function smoothPath(ctx: CanvasRenderingContext2D, pts: Vec[], k = 1): void {
  if (pts.length < 3) {
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x * k, p.y * k) : ctx.moveTo(p.x * k, p.y * k)));
    return;
  }
  ctx.moveTo(pts[0].x * k, pts[0].y * k);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x * k, pts[i].y * k, mx * k, my * k);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x * k, last.y * k);
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
