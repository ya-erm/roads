import { Cubic, CurveLUT } from '../core/bezier';
import { add, cross, cubicBezier, dist, dot, scale, sub, Vec } from '../core/vec';
import type { Plan, Snap } from '../game/build';
import type { Game, LaneEnd } from '../game/game';
import { LaneRenderer } from '../lanes/draw';
import { insideRuns } from '../lanes/edit';
import { edgesAt, pointOff, stations as axisStations } from '../lanes/geometry';
import type { LaneNet } from '../lanes/model';
import type { Vehicle } from '../sim/vehicle';
import { cargoImage } from '../ui/cargoIcons';
import { CARGO, CargoType, FREIGHT } from '../world/cargo';
import { Industry, Station, TOWN_NEED, TownBuilding } from '../world/entities';
import type { Segment } from '../world/network';
import { halfWidth, isOneWay, isRail, isTrunk, LANE_W, medianHalf, RAIL_HALF, ROAD_MARGIN, roadEdges, RoadSpec } from '../world/roadTypes';
import { Footprint, footprintCorners, footprintRadius } from '../world/spatial';
import { Camera } from './camera';

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
  /** Перестройка: будущая дорога на месте участка — ширина, полосы, направление. */
  upgrade?: { curve: Cubic; spec: RoadSpec } | null;
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
  signal: { pos: Vec; dir: Vec; remove: boolean } | null;
  /** Будущая развязка по шаблону. */
  template: { curves: Cubic[]; ok: boolean } | null;
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
  /** Кружки: начало дороги, куда примкнёт, узел под курсором. */
  points?: { pos: Vec; color: string; r?: number }[];
  /** Настройка полос выбранного перекрёстка: метки концов полос, выбранный въезд, метка под курсором. */
  laneEdit: { node: number; ends: LaneEnd[]; from: { seg: number; i: number } | null; hover: LaneEnd | null } | null;
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

/** С какой стороны (в системе a→b сегмента) к нему в узле примыкают другие дороги. */
interface Sides {
  r: boolean;
  l: boolean;
}
const NO_SIDES: Sides = { r: false, l: false };

/** Отгон у стыка: длина зоны и полуширина более широкой дороги с этой стороны. */
interface Taper {
  T: number;
  wide: number;
}
const NO_TAPERS: { r: Taper | null; l: Taper | null } = { r: null, l: null };

/** Радиус кружка пера на экране, пикселей (и за сколько его можно схватить). */
export const HANDLE_PX = 6;

/**
 * Съезд: любая односторонняя дорога — у неё свои сплошные кромки, а у развилки с ней —
 * островок со штриховкой (съезд часто строят и «Односторонней» улицей).
 */
const isRamp = (spec: RoadSpec) => isOneWay(spec);
/** Съезд отходит от дороги под углом меньше этого — между ними островок со штриховкой. */
const GORE_ANGLE = 0.75;

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
  kind: 'freight' | 'passenger';
  length: number;
  trainId: number;
}

interface SegCache {
  surface: Vec[];
  width: number;
  /** Высота вдоль поверхности для теней и тоннелей. */
  heights: number[];
  /** divdash — осевая жёлтым пунктиром: через неё в перекрёстке разрешён поворот. */
  markings: { pts: Vec[]; style: 'dash' | 'divider' | 'divdash' | 'edge' | 'barrier' }[];
  /** Для путей: два рельса и концы шпал парами. */
  rail: { rails: Vec[][]; sleepers: Vec[] } | null;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  maxLevel: number;
  minLevel: number;
  wet: boolean;
  rev: number;
  /** Пересекают ли повороты осевую в узлах a и b — при смене запретов разметку надо пересобрать. */
  crossA: boolean;
  crossB: boolean;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private cache = new Map<number, SegCache>();
  private cacheVersion = -1;
  /** Узлы, через которые главная дорога проходит насквозь (кэш на версию сети). */
  private readonly through = new Map<number, [number, number] | null>();
  /** Узлы, где разрешённые повороты пересекают осевую главной дороги (кэш на версию сети). */
  private readonly crossing = new Map<number, boolean>();
  private treeVersion = '';
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
    this.through.clear();
    this.crossing.clear();
    this.treeVersion = '';
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.outside;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.camera.apply(ctx);

    const view = this.view();
    const segs = [...game.net.segments.values()].filter((s) => this.visible(this.cache.get(s.id)!.bbox, view));
    const vehicles = [...game.traffic.vehicles.values()].filter(
      (v) => v.pos.x > view.x0 && v.pos.x < view.x1 && v.pos.y > view.y0 && v.pos.y < view.y1,
    );
    const band = (v: Vehicle) => (v.level < -0.5 ? -1 : v.level < 0.5 ? 0 : v.level < 1.5 ? 1 : 2);

    const trains = this.trainCars(game, view);
    const trainBand = (lvl: number) => (lvl < -0.5 ? -1 : lvl < 0.5 ? 0 : lvl < 1.5 ? 1 : 2);

    this.drawTerrain(game, view);
    this.drawTunnels(segs);
    // Дороги — сеть полос (или её копия с тем, что сейчас строим), по слоям высоты.
    const roadNet = o.roads?.net ?? game.roads.net;
    ctx.globalAlpha = 0.35;
    this.lanes.draw(ctx, roadNet, this.camera.zoom, false, view, -1);
    this.drawVehicles(vehicles.filter((v) => band(v) === -1));
    this.drawTrains(trains.filter((t) => trainBand(t.level) === -1));
    ctx.globalAlpha = 1;
    const ground = segs.filter((s) => this.cache.get(s.id)!.maxLevel <= 0.01);
    const groundRoads = ground.filter((s) => !isRail(s.spec));
    const groundRails = ground.filter((s) => isRail(s.spec));
    // Пандусы с земли: нижняя половина — обычная дорога, вместе с землёй (и под машинами на ней).
    const feet = segs.filter((s) => {
      const c = this.cache.get(s.id)!;
      return !isRail(s.spec) && c.maxLevel > 0.01 && c.minLevel > -0.01 && c.minLevel <= 0.01;
    });
    // Щебень и шпалы под дорогой (на переезде асфальт сверху), рельсы — поверх асфальта.
    this.drawRailBeds(groundRails, false);
    this.lanes.draw(ctx, roadNet, this.camera.zoom, false, view, 0);
    if (o.roads) this.drawRoadPreview(o.roads);
    this.drawSurfaces([...groundRoads, ...feet], false);
    this.drawTapers(game, 0, view);
    // Площадка перекрёстка, поверх — скруглённые углы (закрывают её срезанные края) и островки.
    this.drawJunctions(game, 0);
    this.drawCorners(game, 0, view);
    this.drawGores(game, 0, view, 'fill');
    this.drawMarkings(groundRoads);
    this.drawGores(game, 0, view, 'paint');
    this.drawCrosswalks(game, view);
    this.drawStopLines(game, view);
    this.drawRailSteel(groundRails);
    this.drawCrossings(game, view);
    this.drawSignals(game, view);
    if (o.heatmap) this.drawHeatmap(game, 0);
    this.drawVehicles(vehicles.filter((v) => band(v) === 0));
    this.drawLights(game);
    this.drawStructures(game, view, o);
    this.drawTrains(trains.filter((t) => trainBand(t.level) === 0));
    for (const level of [1, 2]) {
      const layer = segs.filter((s) => {
        const c = this.cache.get(s.id)!;
        return c.maxLevel > level - 0.99 && c.maxLevel <= level + 0.01;
      });
      const roads = this.lanes.hasLayer(roadNet, level);
      if (!layer.length && !roads) continue;
      const rails = layer.filter((s) => isRail(s.spec));
      if (roads) this.lanes.draw(ctx, roadNet, this.camera.zoom, false, view, level);
      this.drawElevated(layer);
      this.drawTapers(game, level, view);
      this.drawJunctions(game, level);
      this.drawCorners(game, level, view);
      this.drawGores(game, level, view, 'fill');
      this.drawMarkings(layer.filter((s) => !isRail(s.spec)));
      this.drawGores(game, level, view, 'paint');
      this.drawRailBeds(rails, true);
      this.drawRailSteel(rails);
      if (o.heatmap) this.drawHeatmap(game, level);
      this.drawVehicles(vehicles.filter((v) => band(v) === level));
      this.drawTrains(trains.filter((t) => trainBand(t.level) === level));
    }
    this.drawLabels(game, view);
    this.drawOverlay(game, o);
    this.drawStationBadges(game, view);
    this.drawFloaters(game);
    if (o.label && o.hover) this.drawTooltip(o.hover, o.label.text, o.label.ok);
  }

  // ---------- Кэш геометрии ----------

  /** Пересобирает кэш только для изменившихся сегментов. */
  /**
   * Главная дорога, проходящая узел насквозь: два почти соосных сегмента, не уже остальных.
   * Это стык (в том числе со сменой числа полос) или примыкание сбоку — съезд, улица.
   * Такой узел рисуется без площадки перекрёстка: дорога непрерывна, разметка продолжается.
   */
  private throughPair(game: Game, nodeId: number): [number, number] | null {
    if (this.through.has(nodeId)) return this.through.get(nodeId)!;
    const net = game.net;
    const n = net.nodes.get(nodeId);
    let best: [number, number] | null = null;
    if (n && !net.isCrossing(n) && n.roundabout === null && n.segments.length === net.roadSegs(n).length) {
      const roads = net.roadSegs(n);
      // Сквозная — и с изгибом в узле до ~30°. Из таких пар — самая широкая (ответвление бывает
      // прямее изогнутой главной дороги), при равной ширине — самая прямая.
      let bestDot = -0.86;
      let bestWidth = -1;
      for (let i = 0; i < roads.length; i++) {
        for (let j = i + 1; j < roads.length; j++) {
          const d = dot(net.dirFrom(nodeId, roads[i]), net.dirFrom(nodeId, roads[j]));
          if (d >= -0.86) continue;
          const w = Math.min(halfWidth(net.segment(roads[i]).spec), halfWidth(net.segment(roads[j]).spec));
          if (w > bestWidth + 0.5 || (Math.abs(w - bestWidth) <= 0.5 && d < bestDot)) {
            bestDot = d;
            bestWidth = w;
            best = [roads[i], roads[j]];
          }
        }
      }
      if (best && roads.length > 2) {
        const w = Math.min(...best.map((id) => halfWidth(net.segment(id).spec)));
        if (roads.some((id) => !best!.includes(id) && halfWidth(net.segment(id).spec) > w + 0.5)) best = null;
      }
      // Боковые дороги с обеих сторон — это уже перекрёсток: площадка без сквозной разметки.
      if (best && roads.length > 2) {
        const d = net.dirFrom(nodeId, best[0]);
        const sides = new Set(
          roads.filter((id) => !best!.includes(id)).map((id) => Math.sign(cross(d, net.dirFrom(nodeId, id)))),
        );
        if (sides.size > 1) best = null;
      }
    }
    this.through.set(nodeId, best);
    return best;
  }

  /**
   * Пересекает ли хоть один разрешённый проезд в узле осевую сквозной дороги: поворот налево
   * в боковую, налево из боковой, прямо с одной боковой на другую. Тогда осевая там — пунктиром.
   */
  private crossesCenter(game: Game, nodeId: number): boolean {
    const known = this.crossing.get(nodeId);
    if (known !== undefined) return known;
    const net = game.net;
    const n = net.nodes.get(nodeId);
    const pair = this.throughPair(game, nodeId);
    let res = false;
    if (n && pair && net.roadSegs(n).length > 2) {
      const dm = net.dirFrom(nodeId, pair[0]);
      const N = { x: -dm.y, y: dm.x };
      const side = (p: Vec) => dot(sub(p, n.pos), N);
      for (const m of net.nodeMovements.get(nodeId) ?? []) {
        const a = side(m.points[0]);
        const b = side(m.points[m.points.length - 1]);
        if (a * b < 0 && Math.abs(a) > 1 && Math.abs(b) > 1) {
          res = true;
          break;
        }
      }
    }
    this.crossing.set(nodeId, res);
    return res;
  }

  /**
   * Отгоны участка s у узла (стороны в системе a→b): где соседняя дорога на стыке шире,
   * кромка s расходится к ней на длине T — так же, как рисует асфальт drawTapers.
   */
  private tapersAt(game: Game, nodeId: number, s: Segment): { r: Taper | null; l: Taper | null } {
    const net = game.net;
    const n = net.nodes.get(nodeId);
    const pair = this.throughPair(game, nodeId);
    if (!n || n.segments.length !== 2 || !pair || !pair.includes(s.id)) return NO_TAPERS;
    const o = net.segment(pair[0] === s.id ? pair[1] : pair[0]);
    const e = roadEdges(s.spec);
    const eo = roadEdges(o.spec);
    const res: { r: Taper | null; l: Taper | null } = { r: null, l: null };
    for (const sigma of [1, -1]) {
      const mine = sigma > 0 ? e.right : e.left;
      // Та же кромка у соседа: сторона «от узла» у него противоположная.
      const out = s.a === nodeId ? sigma : -sigma;
      const so = o.a === nodeId ? -out : out;
      const theirs = so > 0 ? eo.right : eo.left;
      if (theirs > mine + 0.5) res[sigma > 0 ? 'r' : 'l'] = { T: Math.min(s.length * 0.45, 16 + (theirs - mine) * 4), wide: theirs };
    }
    return res;
  }

  /** Стороны сегмента s (в системе a→b), с которых в узле примыкают боковые дороги. */
  private branchSides(game: Game, nodeId: number, s: Segment): Sides {
    const net = game.net;
    const pair = this.throughPair(game, nodeId);
    const res = { r: false, l: false };
    if (!pair) return res;
    const away = net.dirFrom(nodeId, s.id);
    const right = { x: -away.y, y: away.x };
    // Правая сторона «от узла» — это правая сторона сегмента, если узел в его начале.
    const flip = s.a === nodeId ? 1 : -1;
    for (const id of net.roadSegs(net.node(nodeId))) {
      if (pair.includes(id)) continue;
      const dir = net.dirFrom(nodeId, id);
      // Пологий съезд — не боковая улица: кромка остаётся сплошной и переходит в контур островка.
      if (pair.some((p) => dot(dir, net.dirFrom(nodeId, p)) > Math.cos(GORE_ANGLE))) continue;
      const side = dot(dir, right) > 0 ? 1 : -1;
      if (side * flip > 0) res.r = true;
      else res.l = true;
    }
    return res;
  }

  private refreshCache(game: Game): void {
    if (this.cacheVersion === game.net.version) return;
    this.cacheVersion = game.net.version;
    this.through.clear();
    this.crossing.clear();
    for (const id of [...this.cache.keys()]) if (!game.net.segments.has(id)) this.cache.delete(id);
    for (const s of game.net.segments.values()) {
      const cached = this.cache.get(s.id);
      // Участок сам не менялся, но в узле запретили или разрешили поворот — осевая другая.
      const stale = !cached || cached.rev !== s.rev || cached.crossA !== this.crossesCenter(game, s.a) || cached.crossB !== this.crossesCenter(game, s.b);
      if (stale) this.cache.set(s.id, this.buildCache(game, s));
    }
  }

  private buildCache(game: Game, s: Segment): SegCache {
    const net = game.net;
    const e = roadEdges(s.spec);
    const off = (e.right - e.left) / 2;
    const surface = s.lut.offsetPolyline(off, 0, s.length, 3);
    const heights = surface.map((_, i) => net.levelAt(s, (s.length * i) / Math.max(1, surface.length - 1)));
    const ra = net.node(s.a).radius;
    const rb = net.node(s.b).radius;
    // Если дорога проходит узел насквозь (стык или примыкание сбоку), разметка идёт до центра узла.
    const thruA = this.throughPair(game, s.a)?.includes(s.id) ?? false;
    const thruB = this.throughPair(game, s.b)?.includes(s.id) ?? false;
    // Съезд, отходящий островком, размечается с того места, где он отделился от дороги.
    const s0 = thruA ? 0 : Math.max(ra + 1, this.goreStartOf(game, s.a, s));
    const s1 = thruB ? s.length : s.length - Math.max(rb + 1, this.goreStartOf(game, s.b, s));
    // Сплошные линии — только вне зоны примыкания.
    const z0 = ra + 1;
    const z1 = s.length - rb - 1;
    const sideA = thruA ? this.branchSides(game, s.a, s) : NO_SIDES;
    const sideB = thruB ? this.branchSides(game, s.b, s) : NO_SIDES;
    // Отгоны: у стыка с более широкой дорогой кромка уходит по скосу.
    const tapA = thruA ? this.tapersAt(game, s.a, s) : NO_TAPERS;
    const tapB = thruB ? this.tapersAt(game, s.b, s) : NO_TAPERS;
    const crossA = this.crossesCenter(game, s.a);
    const crossB = this.crossesCenter(game, s.b);
    const markings: SegCache['markings'] = [];
    let rail: SegCache['rail'] = null;
    if (isRail(s.spec)) {
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
      rail = { rails, sleepers };
    } else if (s1 > s0) {
      const m = medianHalf(s.spec);
      const half = s.length / 2;
      const in0 = thruA ? Math.min(z0, half) : s0;
      const in1 = thruB ? Math.max(z1, half) : s1;
      /**
       * Линия разметки: в зоне примыкания кромка со стороны съезда становится прерывистой;
       * осевая — жёлтым пунктиром, если через неё разрешён поворот, иначе остаётся сплошной.
       * Барьер идёт насквозь. cutA/cutB — длина отгона у конца: там линия не нужна.
       */
      const line = (offset: number, style: SegCache['markings'][number]['style'], side: 'r' | 'l' | null = null, cutA = 0, cutB = 0) => {
        const inner = (sides: Sides, cross: boolean) =>
          style === 'edge' && side && sides[side] ? 'dash' : style === 'divider' && cross ? 'divdash' : style;
        const a0 = cutA || in0;
        const a1 = cutB ? s.length - cutB : in1;
        if (a1 > a0) markings.push({ pts: s.lut.offsetPolyline(offset, a0, a1, 4), style });
        if (!cutA && thruA && in0 > 0.5) markings.push({ pts: s.lut.offsetPolyline(offset, 0, in0, 4), style: inner(sideA, crossA) });
        if (!cutB && thruB && s.length - in1 > 0.5) markings.push({ pts: s.lut.offsetPolyline(offset, in1, s.length, 4), style: inner(sideB, crossB) });
      };
      if (isOneWay(s.spec)) {
        for (let i = 1; i < s.spec.lanesF; i++) line((i - s.spec.lanesF / 2) * LANE_W, 'dash');
      } else {
        line(0, m ? 'barrier' : s.spec.lanesF + s.spec.lanesB > 2 ? 'divider' : 'dash');
        for (let i = 1; i < s.spec.lanesF; i++) line(m + i * LANE_W, 'dash');
        for (let i = 1; i < s.spec.lanesB; i++) line(-m - i * LANE_W, 'dash');
      }
      // Сплошные кромки — у магистралей и у съездов развязок (отгон есть только у двусторонних).
      if (isTrunk(s.spec.cls) || isRamp(s.spec)) {
        const cut = (t: Taper | null) => (isOneWay(s.spec) ? 0 : (t?.T ?? 0));
        line(e.right - 1.8, 'edge', 'r', cut(tapA.r), cut(tapB.r));
        line(-e.left + 1.8, 'edge', 'l', cut(tapA.l), cut(tapB.l));
      }
      // Отгон: граница новой полосы — пунктир до стыка, кромка — по скосу от узкой дороги к широкой.
      if (!isOneWay(s.spec)) {
        for (const [tap, atA] of [
          [tapA, true],
          [tapB, false],
        ] as const) {
          for (const sigma of [1, -1] as const) {
            const t = tap[sigma > 0 ? 'r' : 'l'];
            if (!t) continue;
            const lanes = sigma > 0 ? s.spec.lanesF : s.spec.lanesB;
            const [r0, r1] = atA ? [0, t.T] : [s.length - t.T, s.length];
            markings.push({ pts: s.lut.offsetPolyline(sigma * (m + lanes * LANE_W), r0, r1, 4), style: 'dash' });
            if (!isTrunk(s.spec.cls)) continue;
            const mine = sigma > 0 ? e.right : e.left;
            const pts: Vec[] = [];
            for (let k = 0; k <= 12; k++) {
              const u = k / 12;
              const smooth = u * u * (3 - 2 * u);
              const cs = atA ? t.T * u : s.length - t.T * u;
              const p = s.lut.pointAt(cs);
              const tg = s.lut.tangentAt(cs);
              const off = sigma * (t.wide + (mine - t.wide) * smooth - 1.8);
              pts.push({ x: p.x - tg.y * off, y: p.y + tg.x * off });
            }
            markings.push({ pts, style: 'edge' });
          }
        }
      }
      // Сплошная линия у барьера с обеих сторон.
      if (m) {
        line(m + 0.6, 'edge');
        line(-m - 0.6, 'edge');
      }
    }
    const hw = halfWidth(s.spec) + 8;
    const xs = surface.map((p) => p.x);
    const ys = surface.map((p) => p.y);
    let wet = false;
    for (let i = 0; i < surface.length; i += 3) if (game.terrain.isWater(surface[i], 0)) wet = true;
    return {
      surface,
      width: e.left + e.right,
      heights,
      // Пунктир нарезан заранее: на концах — по половине пробела, тогда на стыках шаг ровный.
      markings: markings.flatMap((mk) => (mk.style === 'dash' || mk.style === 'divdash' ? cutDashes(mk.pts).map((pts) => ({ pts, style: mk.style })) : [mk])),
      rail,
      bbox: { x0: Math.min(...xs) - hw, y0: Math.min(...ys) - hw, x1: Math.max(...xs) + hw, y1: Math.max(...ys) + hw },
      maxLevel: Math.max(...heights),
      minLevel: Math.min(...heights),
      wet,
      rev: s.rev,
      crossA,
      crossB,
    };
  }

  private refreshTrees(game: Game): void {
    const key = `${game.net.version}:${game.index.items.size}`;
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

  private drawSurfaces(segs: Segment[], elevated: boolean): void {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const s of segs) {
        const c = this.cache.get(s.id)!;
        // Пандус вверх: здесь только нижняя половина, верхнюю рисует слой эстакад.
        const parts =
          c.maxLevel > 0.01 ? this.splitBy(c, (h) => h <= 0.5) : c.minLevel < -0.4 ? this.splitBy(c, (h) => h >= -0.4) : [c.surface];
        const bridge = c.wet && !elevated && c.maxLevel <= 0.01;
        ctx.strokeStyle = pass === 0 ? (bridge ? C.rail : C.roadEdge) : bridge ? C.deck : C.road;
        ctx.lineWidth = c.width + (pass === 0 ? (bridge ? 5 : 2.5) : 0);
        for (const part of parts) {
          this.polyline(part);
          ctx.stroke();
        }
        // Портал тоннеля.
        if (pass === 1 && c.minLevel < -0.4 && c.maxLevel > -0.4) {
          for (let i = 1; i < c.surface.length; i++) {
            if ((c.heights[i - 1] < -0.4) !== (c.heights[i] < -0.4)) {
              const p = c.surface[i];
              const q = c.surface[i - 1];
              const d = { x: p.x - q.x, y: p.y - q.y };
              const l = Math.hypot(d.x, d.y) || 1;
              const n = { x: (-d.y / l) * (c.width / 2 + 3), y: (d.x / l) * (c.width / 2 + 3) };
              ctx.strokeStyle = '#3a3f46';
              ctx.lineWidth = 4;
              ctx.beginPath();
              ctx.moveTo(p.x + n.x, p.y + n.y);
              ctx.lineTo(p.x - n.x, p.y - n.y);
              ctx.stroke();
            }
          }
        }
      }
    }
  }

  private drawElevated(segs: Segment[]): void {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Пандус с земли: настил начинается с середины подъёма, без скругления (низ нарисован как дорога).
    const isFoot = (c: SegCache) => c.minLevel > -0.01 && c.minLevel <= 0.01;
    // Тени со смещением, зависящим от высоты.
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
        const foot = isFoot(c) && !isRail(s.spec);
        const parts = foot ? this.splitBy(c, (h) => h >= 0.5) : c.minLevel < 0.2 ? this.splitBy(c, (h) => h >= -0.4) : [c.surface];
        ctx.lineCap = foot ? 'butt' : 'round';
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

  private drawJunctions(game: Game, level: number): void {
    const ctx = this.ctx;
    const net = game.net;
    const view = this.view();
    for (const n of net.nodes.values()) {
      // Площадка перекрёстка — только из дорог; стрелки путей её не дают, переезд — даёт.
      const roads = net.roadSegs(n);
      if (roads.length < (net.isCrossing(n) ? 2 : 3) || Math.abs(n.level - level) > 0.01 || n.radius <= 0) continue;
      // Примыкание к сквозной дороге: асфальт уже непрерывен, площадка не нужна.
      if (this.throughPair(game, n.id)) continue;
      if (n.pos.x < view.x0 || n.pos.x > view.x1 || n.pos.y < view.y0 || n.pos.y > view.y1) continue;
      const pts: Vec[] = [];
      for (const sid of roads) {
        const s = net.segment(sid);
        const e = roadEdges(s.spec);
        const cs = s.a === n.id ? Math.min(s.length, n.radius + 1) : Math.max(0, s.length - n.radius - 1);
        const p = s.lut.pointAt(cs);
        const t = s.lut.tangentAt(cs);
        const N = { x: -t.y, y: t.x };
        pts.push(add(p, scale(N, e.right)), add(p, scale(N, -e.left)));
      }
      pts.sort((a, b) => Math.atan2(a.y - n.pos.y, a.x - n.pos.x) - Math.atan2(b.y - n.pos.y, b.x - n.pos.x));
      ctx.fillStyle = level > 0 ? C.deck : C.road;
      ctx.strokeStyle = level > 0 ? C.rail : C.roadEdge;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      this.polyline(pts);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
    }
  }

  /**
   * Смена ширины на стыке (добавилась или пропала полоса): кромка плавно сходится
   * от широкой дороги к узкой на длине отгона, а не обрывается уступом.
   */
  private drawTapers(game: Game, level: number, view: ReturnType<Renderer['view']>): void {
    const ctx = this.ctx;
    const net = game.net;
    const fill = level > 0 ? C.deck : C.road;
    const edge = level > 0 ? C.rail : C.roadEdge;
    for (const n of net.nodes.values()) {
      if (n.segments.length !== 2 || Math.abs(n.level - level) > 0.01) continue;
      if (n.pos.x < view.x0 || n.pos.x > view.x1 || n.pos.y < view.y0 || n.pos.y > view.y1) continue;
      const pair = this.throughPair(game, n.id);
      if (!pair) continue;
      const [s1, s2] = pair.map((id) => net.segment(id));
      // Полуширина сегмента справа (+1) или слева (−1) от направления «от узла».
      const halfOn = (s: Segment, sign: number) => {
        const e = roadEdges(s.spec);
        const right = s.a === n.id ? e.right : e.left;
        const left = s.a === n.id ? e.left : e.right;
        return sign > 0 ? right : left;
      };
      // Точка кромки на расстоянии d от узла вдоль сегмента, со стороны sign.
      const edgeAt = (s: Segment, d: number, w: number, sign: number) => {
        const cs = s.a === n.id ? d : s.length - d;
        const p = s.lut.pointAt(cs);
        let t = s.lut.tangentAt(cs);
        if (s.a !== n.id) t = scale(t, -1);
        return add(p, scale({ x: -t.y, y: t.x }, w * sign));
      };
      for (const sign of [1, -1]) {
        // Правая сторона первого сегмента — это левая сторона второго.
        const w1 = halfOn(s1, sign);
        const w2 = halfOn(s2, -sign);
        if (Math.abs(w1 - w2) < 0.5) continue;
        const [narrow, wide, wn, nSign] = w1 > w2 ? [s2, w1, w2, -sign] : [s1, w2, w1, sign];
        const T = Math.min(narrow.length * 0.45, 16 + (wide - wn) * 4);
        const pts: Vec[] = [];
        for (let k = 0; k <= 10; k++) {
          const u = k / 10;
          const smooth = u * u * (3 - 2 * u);
          pts.push(edgeAt(narrow, T * u, wide + (wn - wide) * smooth, nSign));
        }
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = edge;
        ctx.lineWidth = 2.5;
        this.polyline(pts);
        ctx.stroke();
        ctx.fillStyle = fill;
        this.polyline([...pts, edgeAt(narrow, T, wn - 1.5, nSign), edgeAt(narrow, 0, wn - 1.5, nSign)]);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  /**
   * Примыкание к сквозной дороге (Т-перекрёсток, съезд): углы между кромкой боковой дороги
   * и кромкой главной скругляются, как бордюр, а не сходятся под прямым углом.
   */
  private drawCorners(game: Game, level: number, view: ReturnType<Renderer['view']>): void {
    const ctx = this.ctx;
    const net = game.net;
    const fill = level > 0 ? C.deck : C.road;
    const edge = level > 0 ? C.rail : C.roadEdge;
    // Полуширина участка x справа (+1) или слева (−1) от направления «от узла».
    const halfOut = (x: Segment, nodeId: number, sign: number) => {
      const e = roadEdges(x.spec);
      return x.a === nodeId ? (sign > 0 ? e.right : e.left) : sign > 0 ? e.left : e.right;
    };
    const right = (d: Vec): Vec => ({ x: -d.y, y: d.x });
    for (const n of net.nodes.values()) {
      if (n.segments.length < 3 || Math.abs(n.level - level) > 0.01 || n.roundabout !== null || net.isCrossing(n)) continue;
      if (n.pos.x < view.x0 || n.pos.x > view.x1 || n.pos.y < view.y0 || n.pos.y > view.y1) continue;
      // Соседние по кругу дороги — между каждой парой свой угол.
      const roads = net
        .roadSegs(n)
        .map((id) => ({ id, d: net.dirFrom(n.id, id) }))
        .sort((x, y) => Math.atan2(x.d.y, x.d.x) - Math.atan2(y.d.y, y.d.x));
      if (roads.length < 3) continue;
      for (let i = 0; i < roads.length; i++) {
        const bid = roads[i].id;
        const kid = roads[(i + 1) % roads.length].id;
        const b = net.segment(bid);
        const db = roads[i].d;
        {
          const k = net.segment(kid);
          const dk = roads[(i + 1) % roads.length].d;
          // Угол между соседями по кругу (может быть и больше развёрнутого — тогда это не угол перекрёстка).
          let between = Math.atan2(dk.y, dk.x) - Math.atan2(db.y, db.x);
          if (between < 0) between += Math.PI * 2;
          // Почти прямо — угла нет; под острым углом — островок с носом (drawGores), не скругление.
          if (between > 2.95 || between < GORE_ANGLE) continue;
          // Кромки, обращённые друг к другу: у боковой — в сторону k, у главной — в сторону боковой.
          const sb = dot(dk, right(db)) > 0 ? 1 : -1;
          const sk = dot(db, right(dk)) > 0 ? 1 : -1;
          const pb = add(n.pos, scale(right(db), sb * halfOut(b, n.id, sb)));
          const pk = add(n.pos, scale(right(dk), sk * halfOut(k, n.id, sk)));
          // Угол P — пересечение двух кромок.
          const den = db.x * dk.y - db.y * dk.x;
          if (Math.abs(den) < 0.2) continue;
          const w = sub(pk, pb);
          const tb = (w.x * dk.y - w.y * dk.x) / den;
          const P = add(pb, scale(db, tb));
          // Кромки сходятся впереди по обеим дорогам — иначе это выпуклая сторона изгиба, угла нет.
          if (tb <= 0 || dot(sub(P, pk), dk) <= 0) continue;
          const theta = Math.acos(Math.max(-1, Math.min(1, dot(db, dk))));
          // Длинная дуга тупого угла — только у сквозной дороги: у площадки перекрёстка она легла бы на асфальт.
          if (theta > 2.2 && !this.throughPair(game, n.id)) continue;
          const R = 9;
          // Тупой угол (широкая дорога переходит в ответвление почти по прямой) — длинная плавная дуга.
          const t = theta > 2.2 ? 25 : Math.min(R / Math.tan(theta / 2), 18);
          if (!Number.isFinite(t) || t <= 0.5) continue;
          const A = add(P, scale(dk, t));
          const B = add(P, scale(db, t));
          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.moveTo(P.x, P.y);
          ctx.lineTo(A.x - dk.x * 0.5, A.y - dk.y * 0.5);
          ctx.quadraticCurveTo(P.x, P.y, B.x, B.y);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = edge;
          ctx.lineWidth = 2.5;
          ctx.lineCap = 'butt';
          ctx.beginPath();
          ctx.moveTo(A.x, A.y);
          ctx.quadraticCurveTo(P.x, P.y, B.x, B.y);
          ctx.stroke();
        }
      }
    }
  }

  /**
   * Островок съезда, как в Node Controller: где съезд под острым углом отходит от дороги
   * (или вливается в неё), между их сплошными кромками — асфальт до скруглённого носа
   * и штриховка «ёлочкой». Вершины ёлочки смотрят навстречу движению по съезду.
   */
  private drawGores(game: Game, level: number, view: ReturnType<Renderer['view']>, phase: 'fill' | 'paint'): void {
    const net = game.net;
    const z = this.camera.zoom;
    if (phase === 'paint' && z < 0.35) return;
    const fill = level > 0 ? C.deck : C.road;
    const curb = level > 0 ? C.rail : C.roadEdge;
    for (const n of net.nodes.values()) {
      if (n.segments.length < 3 || Math.abs(n.level - level) > 0.01 || n.roundabout !== null || net.isCrossing(n)) continue;
      if (n.pos.x < view.x0 - 100 || n.pos.x > view.x1 + 100 || n.pos.y < view.y0 - 100 || n.pos.y > view.y1 + 100) continue;
      // Пары соседних дорог под острым углом: развилка, съезд или вливание.
      const roads = net.roadSegs(n);
      for (let i = 0; i < roads.length; i++) {
        for (let j = i + 1; j < roads.length; j++) {
          const x = net.segment(roads[i]);
          const y = net.segment(roads[j]);
          if (dot(net.dirFrom(n.id, x.id), net.dirFrom(n.id, y.id)) <= Math.cos(GORE_ANGLE)) continue;
          // «Съезд» — односторонняя или более узкая из двух: по ней видно, куда едут.
          const yIsBranch = (isRamp(y.spec) && !isRamp(x.spec)) || (isRamp(y.spec) === isRamp(x.spec) && halfWidth(y.spec) <= halfWidth(x.spec));
          const [b, k] = yIsBranch ? [y, x] : [x, y];
          this.drawGore(game, n.id, b, k, phase, fill, curb);
        }
      }
    }
  }

  /** Островок между дорогами b и k, которые расходятся от узла под острым углом. */
  /**
   * Геометрия островка между b (съезд) и k (дорога), расходящимися от узла под острым углом:
   * с какой стороны кромки смотрят друг на друга, где нарисованные кромки расходятся (d0)
   * и где нос (d1). Нет островка — null.
   */
  private goreGeom(game: Game, nodeId: number, b: Segment, k: Segment) {
    const net = game.net;
    const right = (d: Vec): Vec => ({ x: -d.y, y: d.x });
    const halfOut = (x: Segment, sign: number) => {
      const e = roadEdges(x.spec);
      return x.a === nodeId ? (sign > 0 ? e.right : e.left) : sign > 0 ? e.left : e.right;
    };
    // Точка на расстоянии d от узла вдоль участка, смещённая вбок (вправо «от узла» — плюс).
    const along = (x: Segment, d: number, off: number): Vec => {
      const cs = x.a === nodeId ? Math.min(d, x.length) : Math.max(0, x.length - d);
      const p = x.lut.pointAt(cs);
      let t = x.lut.tangentAt(cs);
      if (x.a !== nodeId) t = scale(t, -1);
      return add(p, scale(right(t), off));
    };
    // Направление участка «от узла» на расстоянии d.
    const away = (x: Segment, d: number): Vec => {
      const t = x.lut.tangentAt(x.a === nodeId ? Math.min(d, x.length) : Math.max(0, x.length - d));
      return x.a === nodeId ? t : scale(t, -1);
    };
    const db = net.dirFrom(nodeId, b.id);
    const dk = net.dirFrom(nodeId, k.id);
    const sb = dot(dk, right(db)) > 0 ? 1 : -1;
    const sk = dot(db, right(dk)) > 0 ? 1 : -1;
    const hb = halfOut(b, sb);
    const hk = halfOut(k, sk);
    // Расхождение кромок (нарисованных линий) на расстоянии d: плюс — съезд уже снаружи.
    const gap = (d: number) => dot(sub(along(b, d, sb * (hb - 1.8)), along(k, d, sk * (hk - 1.8))), scale(right(dk), sk));
    const maxD = Math.min(b.length, k.length) * 0.9;
    let d0 = -1;
    let d1 = -1;
    for (let d = 2; d <= maxD; d += 2) {
      const g = gap(d);
      if (d0 < 0 && g > 0) d0 = d;
      if (d0 >= 0 && (g > 12 || d - d0 > 90)) {
        d1 = d;
        break;
      }
    }
    if (d0 < 0 || d1 < 0 || d1 - d0 < 10) return null;
    return { d0, d1, db, dk, sb, sk, hb, hk, along, away, right };
  }

  /**
   * Дорога, которая подходит к узлу почти напротив съезда: её кромка с внешней стороны съезда
   * переходит во внешнюю кромку съезда. drop — она шире дороги k с этой стороны:
   * лишняя полоса уходит в съезд.
   */
  private goreFeed(game: Game, nodeId: number, b: Segment, k: Segment, geom: NonNullable<ReturnType<Renderer['goreGeom']>>) {
    const net = game.net;
    const n = net.node(nodeId);
    const { d0, d1, db, sb, hb, hk, along, away, right } = geom;
    const inc = net
      .roadSegs(n)
      .filter((id) => id !== b.id && id !== k.id)
      .map((id) => net.segment(id))
      .sort((x, y) => dot(net.dirFrom(nodeId, x.id), db) - dot(net.dirFrom(nodeId, y.id), db))[0];
    if (!inc || dot(net.dirFrom(nodeId, inc.id), db) > -Math.cos(0.7)) return null;
    const outer = scale(right(db), -sb);
    const si = dot(outer, right(net.dirFrom(nodeId, inc.id))) > 0 ? 1 : -1;
    const ei = roadEdges(inc.spec);
    const hi = inc.a === nodeId ? (si > 0 ? ei.right : ei.left) : si > 0 ? ei.left : ei.right;
    const T = Math.min(inc.length * 0.6, Math.max(25, (d1 - d0) * 0.6, n.radius + 10));
    // Наружу от входящей дороги (в сторону внешней кромки съезда).
    const lat = scale(right(net.dirFrom(nodeId, inc.id)), si);
    const ctrl = (inset: number, r: number): [Vec, Vec, Vec, Vec] => {
      const p0 = along(inc, T, si * (hi - inset));
      const p3 = along(b, r, -sb * (hb - inset));
      const t3 = away(b, r);
      const reach = dist(p0, p3) * 0.4;
      // Если съезд уходит вбок круче, чем расходятся кромки, подход к нему короче — иначе кривая провиснет внутрь.
      const slope = dot(t3, lat);
      const reach3 = slope > 0.01 ? Math.min(reach, Math.max(reach * 0.35, dot(sub(p3, p0), lat) / slope)) : reach;
      return [p0, sub(p0, scale(away(inc, T), reach)), sub(p3, scale(t3, reach3)), p3];
    };
    // Съезд со своей разметкой начинается там, где выходит из полосы дороги. Если в него уходит
    // своя полоса, там он ещё не дальше кромки входящей дороги — кривая встречает его дальше.
    const drop = hi > hk + 3;
    const rs = Math.max(n.radius + 1, d0);
    let r = rs;
    for (let at = rs; drop && at <= Math.min(b.length * 0.8, rs + 300); at += 5) {
      const [p0, p1, p2, p3] = ctrl(0, at);
      r = at;
      if (dot(sub(p2, p0), lat) > -0.5 && dist(p2, p3) > dist(p0, p1) * 0.9) break;
    }
    /** Кривая от кромки входящей дороги (в T от узла) до внешней кромки съезда (в r); inset — отступ внутрь асфальта. */
    const curve = (inset: number): Vec[] => {
      const [p0, p1, p2, p3] = ctrl(inset, r);
      return Array.from({ length: 25 }, (_, i) => cubicBezier(p0, p1, p2, p3, i / 24));
    };
    return { inc, si, hi, T, rs, r, curve, drop };
  }

  /**
   * Где у съезда начинается своя разметка: если он отходит от дороги островком — там,
   * где его кромка выходит из полосы дороги (иначе линии съезда легли бы поперёк её полосы).
   */
  private goreStartOf(game: Game, nodeId: number, s: Segment): number {
    const net = game.net;
    const n = net.nodes.get(nodeId);
    if (!n || !isRamp(s.spec) || n.roundabout !== null || net.roadSegs(n).length < 3) return 0;
    const ds = net.dirFrom(nodeId, s.id);
    let k: Segment | null = null;
    let best = Math.cos(GORE_ANGLE);
    for (const id of net.roadSegs(n)) {
      if (id === s.id) continue;
      const c = dot(ds, net.dirFrom(nodeId, id));
      if (c > best) {
        best = c;
        k = net.segment(id);
      }
    }
    // Съезд — тот же выбор, что в drawGores: односторонняя или более узкая из двух.
    if (!k || (isRamp(k.spec) && halfWidth(k.spec) < halfWidth(s.spec))) return 0;
    return this.goreGeom(game, nodeId, s, k)?.d0 ?? 0;
  }

  /**
   * Островок между b (съезд) и k (дорога). fill — асфальт до круглого носа и бордюр носа
   * (до разметки); paint — сплошной контур, «ёлочка», отвод внешней кромки съезда от кромки
   * дороги и стёртая кромка дороги там, где в съезд въезжают (после разметки, поверх неё).
   */
  private drawGore(game: Game, nodeId: number, b: Segment, k: Segment, phase: 'fill' | 'paint', fill: string, curb: string): void {
    const ctx = this.ctx;
    const n = game.net.node(nodeId);
    const geom = this.goreGeom(game, nodeId, b, k);
    if (!geom) return;
    const { d0, d1, db, dk, sb, sk, hb, hk, right, along } = geom;
    const feed = (isTrunk(b.spec.cls) || isRamp(b.spec)) && (isTrunk(k.spec.cls) || isRamp(k.spec)) ? this.goreFeed(game, nodeId, b, k, geom) : null;
    const span = (x: Segment, a: number, z: number, off: number) => {
      const steps = Math.max(8, Math.ceil(Math.abs(z - a) / 5));
      return Array.from({ length: steps + 1 }, (_, i) => along(x, a + ((z - a) * i) / steps, off));
    };
    // Ось островка (от узла); нос — круглое «U», обращённое к узлу.
    const axis = add(dk, db);
    const u = scale(axis, 1 / (Math.hypot(axis.x, axis.y) || 1));
    /** Контур от узла вдоль кромки k (смещение offK), «U» у носа и обратно вдоль кромки b. */
    const outline = (offK: number, offB: number, end: number): { pts: Vec[]; nose: Vec[] } => {
      const steps = Math.max(4, Math.ceil((end - d0) / 4));
      const ds = Array.from({ length: steps + 1 }, (_, i) => d0 + ((end - d0) * i) / steps);
      const pk = ds.map((d) => along(k, d, sk * offK));
      const pb = ds.map((d) => along(b, d, sb * offB));
      const e1 = pk[pk.length - 1];
      const e2 = pb[pb.length - 1];
      const w = dist(e1, e2);
      const c1 = sub(e1, scale(u, w * 0.6));
      const c2 = sub(e2, scale(u, w * 0.6));
      const nose: Vec[] = [];
      for (let i = 0; i <= 12; i++) nose.push(cubicBezier(e1, c1, c2, e2, i / 12));
      return { pts: [...pk, ...nose.slice(1, -1), ...pb.reverse()], nose };
    };
    if (phase === 'fill') {
      // Асфальт от кромки входящей дороги до внешней кромки съезда: без ступеньки и травы в углу у узла.
      if (feed) {
        const edge = feed.curve(0);
        ctx.strokeStyle = curb;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        this.polyline(edge);
        ctx.stroke();
        ctx.fillStyle = fill;
        this.polyline([...edge, ...span(b, feed.r, 0, 0), ...span(feed.inc, 0, feed.T, 0)]);
        ctx.closePath();
        ctx.fill();
        // Бордюр, зашедший на проезжую часть самих дорог, закрываем их асфальтом.
        ctx.strokeStyle = fill;
        ctx.lineCap = 'butt';
        for (const [x, z] of [
          [feed.inc, feed.T],
          [b, feed.r],
        ] as const) {
          const e = roadEdges(x.spec);
          ctx.lineWidth = e.left + e.right;
          this.polyline(span(x, 0, z, ((x.a === nodeId ? 1 : -1) * (e.right - e.left)) / 2));
          ctx.stroke();
        }
      }
      // Асфальт между кромками дорог до носа: закрывает траву клина.
      const asphalt = outline(hk, hb, d1);
      ctx.fillStyle = fill;
      this.polyline(asphalt.pts);
      ctx.closePath();
      ctx.fill();
      // Бордюр носа — тонкий, как кромка дороги.
      ctx.strokeStyle = curb;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      this.polyline(asphalt.nose);
      ctx.stroke();
      return;
    }
    // Нарисованные кромки и «ёлочка» — только если у обеих дорог есть свои кромки.
    if (!((isTrunk(b.spec.cls) || isRamp(b.spec)) && (isTrunk(k.spec.cls) || isRamp(k.spec)))) return;
    const erase = (pts: Vec[]) => {
      ctx.strokeStyle = fill;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'butt';
      this.polyline(pts);
      ctx.stroke();
    };
    const solid = (pts: Vec[]) => {
      ctx.strokeStyle = C.dash;
      ctx.lineWidth = 1;
      this.polyline(pts);
      ctx.stroke();
    };
    // Там, где в съезд перестраиваются, кромки дороги нет: от узла до островка полоса съезда открыта.
    // Если же в съезд уходит своя полоса, кромка дороги — это граница этой полосы, она остаётся.
    if (!feed?.drop) erase(span(k, 0, d0, sk * (hk - 1.8)));
    if (feed) {
      const { inc, si, hi, T, rs, r } = feed;
      // Внешняя кромка съезда плавно продолжает кромку входящей дороги — до места, откуда у съезда своя разметка.
      erase(span(inc, 0, T, si * (hi - 1.8)));
      if (r > rs) erase(span(b, rs, r, -sb * (hb - 1.8)));
      solid(feed.curve(1.8));
      if (feed.drop) {
        // Пунктир между уходящей полосой и остальными перед узлом становится сплошным и переходит в кромку дороги.
        const div = hi - ROAD_MARGIN - Math.round((hi - hk) / LANE_W) * LANE_W;
        erase(span(inc, 0, T, si * div));
        solid(
          Array.from({ length: 13 }, (_, i) => {
            const t = i / 12;
            return along(inc, T * (1 - t), si * (div + (hk - 1.8 - div) * t * t * (3 - 2 * t)));
          }),
        );
      }
    }
    // Контур островка — на 1.8 внутри асфальта, с таким же круглым носом.
    const paint = outline(hk - 1.8, hb - 1.8, d1 - 5);
    ctx.save();
    this.polyline(paint.pts);
    ctx.closePath();
    ctx.clip();
    // Навстречу движению: на съезде с дороги едут от узла — вершины к узлу, на въезде — наоборот.
    const diverge = (b.a === n.id) === b.spec.lanesF > 0;
    const v = right(u);
    const back = diverge ? 1 : -1;
    const armLen = dist(along(k, d1, sk * hk), along(b, d1, sb * hb)) + 4;
    const start = scale(add(paint.pts[0], paint.pts[paint.pts.length - 1]), 0.5);
    ctx.strokeStyle = C.dash;
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    // Плечи — под 60° к оси островка: чёткие «галочки», не сливаются в зигзаг.
    for (let t = -4; t <= d1 - d0 + 8; t += 5) {
      const apex = add(start, scale(u, t));
      for (const side of [1, -1]) {
        const arm = add(scale(u, back * 0.5), scale(v, side * 0.87));
        const end = add(apex, scale(arm, armLen));
        ctx.moveTo(apex.x, apex.y);
        ctx.lineTo(end.x, end.y);
      }
    }
    ctx.stroke();
    ctx.restore();
    ctx.lineWidth = 1;
    this.polyline(paint.pts);
    ctx.stroke();
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
      const sl = this.cache.get(s.id)!.rail?.sleepers ?? [];
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
      for (const r of this.cache.get(s.id)!.rail?.rails ?? []) r.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
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
        this.signalPost(add(n.pos, scale({ x: -d.y, y: d.x }, RAIL_HALF + 4)), d, game.rail.isReserved(out) ? '#e8483f' : '#3ad16b');
      }
    }
  }

  private signalPost(p: Vec, d: Vec, light: string): void {
    const ctx = this.ctx;
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

  private drawMarkings(segs: Segment[]): void {
    if (this.camera.zoom < 0.35) return;
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    // Барьер автомагистрали: бетонная полоса с отбойником посередине.
    for (const [color, width] of [
      ['#9aa1aa', 4],
      ['#e8ebee', 1.6],
    ] as const) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const s of segs) {
        for (const m of this.cache.get(s.id)!.markings) {
          if (m.style === 'barrier') m.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        }
      }
      ctx.stroke();
    }
    for (const style of ['dash', 'divider', 'divdash', 'edge'] as const) {
      const yellow = style === 'divider' || style === 'divdash';
      ctx.strokeStyle = yellow ? C.divider : C.dash;
      ctx.lineWidth = yellow ? 1.4 : 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      for (const s of segs) {
        for (const m of this.cache.get(s.id)!.markings) {
          if (m.style !== style) continue;
          m.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.fillStyle = C.dash;
    for (const s of segs) {
      if (!isOneWay(s.spec) || s.length < 40) continue;
      for (const frac of s.length > 160 ? [0.3, 0.7] : [0.5]) {
        const at = s.length * frac;
        const p = s.lut.pointAt(at);
        const d = s.lut.tangentAt(at);
        const nrm = { x: -d.y, y: d.x };
        for (let i = 0; i < s.spec.lanesF; i++) {
          const o = (i - (s.spec.lanesF - 1) / 2) * LANE_W;
          const c = add(p, scale(nrm, o));
          ctx.beginPath();
          ctx.moveTo(c.x + d.x * 3.5, c.y + d.y * 3.5);
          ctx.lineTo(c.x - d.x * 2 + nrm.x * 2, c.y - d.y * 2 + nrm.y * 2);
          ctx.lineTo(c.x - d.x * 2 - nrm.x * 2, c.y - d.y * 2 - nrm.y * 2);
          ctx.fill();
        }
      }
    }
  }

  /**
   * Пешеходные переходы («зебра») на городских перекрёстках: поперёк каждого подъезда
   * у самого входа в перекрёсток — машины останавливаются перед ними. На примыкании к сквозной
   * улице — только поперёк боковой. У магистралей, съездов и переездов переходов нет.
   */
  private drawCrosswalks(game: Game, view: ReturnType<Renderer['view']>): void {
    if (this.camera.zoom < 0.6) return;
    const ctx = this.ctx;
    const net = game.net;
    // Улицы (и односторонние) и двусторонние проспекты; односторонний проспект — это съезд развязки.
    const town = (sp: RoadSpec) => sp.cls === 'street' || (sp.cls === 'avenue' && !isOneWay(sp));
    ctx.strokeStyle = C.dash;
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    for (const n of net.nodes.values()) {
      if (n.level !== 0 || n.roundabout !== null || n.buildingId !== null || net.isCrossing(n)) continue;
      const roads = net.roadSegs(n);
      if (roads.length < 3 || roads.length !== n.segments.length) continue;
      if (n.pos.x < view.x0 || n.pos.x > view.x1 || n.pos.y < view.y0 || n.pos.y > view.y1) continue;
      const segs = roads.map((id) => net.segment(id));
      if (!segs.every((s) => town(s.spec))) continue;
      const pair = this.throughPair(game, n.id);
      // Сквозная улица: переход на боковой — за кромкой главной.
      const mainHalf = pair ? Math.max(...pair.map((id) => halfWidth(net.segment(id).spec))) : 0;
      for (const s of segs) {
        if (pair?.includes(s.id)) continue;
        const from = pair ? mainHalf + 2 : n.radius - 6.5;
        const to = from + 5.5;
        if (from < 1 || to > s.length * 0.4) continue;
        const e = roadEdges(s.spec);
        const atA = s.a === n.id;
        const c0 = atA ? from : s.length - from;
        const c1 = atA ? to : s.length - to;
        const p0 = s.lut.pointAt(c0);
        const p1 = s.lut.pointAt(c1);
        const t = s.lut.tangentAt((c0 + c1) / 2);
        const N = { x: -t.y, y: t.x };
        for (let o = -e.left + 2; o <= e.right - 1.5; o += 3.2) {
          ctx.moveTo(p0.x + N.x * o, p0.y + N.y * o);
          ctx.lineTo(p1.x + N.x * o, p1.y + N.y * o);
        }
      }
    }
    ctx.stroke();
  }

  /** Стоп-линии на въездах перекрёстков: пунктир — «уступи дорогу», сплошная — у светофора. */
  private drawStopLines(game: Game, view: ReturnType<Renderer['view']>): void {
    if (this.camera.zoom < 0.6) return;
    const ctx = this.ctx;
    const g = game.roads.graph;
    for (const n of g.nodes.values()) {
      if (!(n.priorityLanes.size || n.lights)) continue;
      if (n.pos.x < view.x0 || n.pos.x > view.x1 || n.pos.y < view.y0 || n.pos.y > view.y1) continue;
      for (const link of g.inLinks.get(n.id) ?? []) {
        const yieldHere = !n.lights && !n.priorityLanes.has(link.lanes[0].id);
        if (!yieldHere && !n.lights) continue;
        ctx.strokeStyle = C.dash;
        ctx.lineWidth = yieldHere ? 1.2 : 1.6;
        ctx.setLineDash(yieldHere ? [2, 2] : []);
        ctx.beginPath();
        for (const lane of link.lanes) {
          const end = g.lanePose(lane, lane.length);
          const N = { x: -end.dir.y, y: end.dir.x };
          const a = add(end.pos, scale(N, LANE_W / 2 - 0.5));
          const b = add(end.pos, scale(N, -LANE_W / 2 + 0.5));
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  /** Карта пробок: каждая связь графа движения — цветом загрузки (зелёный — свободно, красный — стоят). */
  private drawHeatmap(game: Game, level: number): void {
    if (level !== 0) return;
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
  private drawVehicles(list: Vehicle[], halo = false): void {
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
      ctx.restore();
    }
  }

  // ---------- Строения ----------

  private drawStructures(game: Game, view: ReturnType<Renderer['view']>, o: ToolOverlay): void {
    const ctx = this.ctx;
    const inView = (fp: Footprint) =>
      fp.center.x > view.x0 - 100 && fp.center.x < view.x1 + 100 && fp.center.y > view.y0 - 100 && fp.center.y < view.y1 + 100;
    for (const town of game.towns) {
      if (dist(town.center, { x: (view.x0 + view.x1) / 2, y: (view.y0 + view.y1) / 2 }) > town.radius + (view.x1 - view.x0) * 1.2) continue;
      for (const b of town.buildings) if (inView(b.fp)) this.drawBuilding(b);
    }
    for (const ind of game.industries) if (inView(ind.fp)) this.drawIndustry(ind);
    const sel = o.selection;
    for (const st of game.stations.values()) {
      if (!inView(st.fp)) continue;
      const selected = (sel?.type === 'station' && sel.id === st.id) || o.lineStops.includes(st.id);
      if (st.kind === 'rail') this.drawRailStation(game, st, selected);
      else this.drawStation(st, selected);
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
      game.rail.cars(train).forEach((c, k) => {
        if (c.pos.x < view.x0 || c.pos.x > view.x1 || c.pos.y < view.y0 || c.pos.y > view.y1) return;
        out.push({ ...c, loco: k === 0, color: train.color, load: train.load, kind: train.kind, length: train.carLength, trainId: train.id });
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
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          for (let x = -L / 2 + 2; x < L / 2 - 2; x += 3) ctx.fillRect(x, -W / 2 + 0.7, 1.8, 1);
          for (let x = -L / 2 + 2; x < L / 2 - 2; x += 3) ctx.fillRect(x, W / 2 - 1.7, 1.8, 1);
        }
      } else {
        // Грузовой вагон: рама цвета линии, внутри — груз его цветом.
        ctx.fillStyle = c.color;
        rr(ctx, -L / 2, -W / 2, L, W, 1.2);
        ctx.fill();
        ctx.fillStyle = c.load ?? '#5b636d';
        ctx.fillRect(-L / 2 + 1.2, -W / 2 + 1.2, L - 2.4, W - 2.4);
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

  private drawIndustry(ind: Industry): void {
    const ctx = this.ctx;
    const fp = ind.fp;
    this.drawFootprint({ ...fp, center: { x: fp.center.x + 5, y: fp.center.y + 7 } }, 'rgba(30,40,25,0.2)');
    this.drawFootprint(fp, ind.info.color, 'rgba(60,50,40,0.45)', 1.2);
    ctx.save();
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    const W = fp.w;
    const H = fp.h;
    const rect = (x: number, y: number, w: number, h: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(x * W, y * H, w * W, h * H);
    };
    const circle = (x: number, y: number, r: number, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x * W, y * H, r, 0, Math.PI * 2);
      ctx.fill();
    };
    const roof = ind.info.roof;
    switch (ind.info.kind) {
      case 'farm':
        for (let i = 0; i < 5; i++) rect(-0.45, -0.42 + i * 0.12, 0.5, 0.06, '#c9a94a');
        rect(0.1, -0.3, 0.32, 0.42, roof);
        circle(0.3, 0.3, 7, '#e8e2d6');
        break;
      case 'forest':
        for (let i = 0; i < 9; i++) circle(-0.32 + (i % 3) * 0.14, -0.28 + Math.floor(i / 3) * 0.16, 6, '#6e9a52');
        for (let i = 0; i < 4; i++) rect(0.08, -0.2 + i * 0.08, 0.34, 0.045, '#9b7550');
        break;
      case 'coalmine':
      case 'ironmine': {
        const heap = ind.info.kind === 'coalmine' ? '#3d4148' : '#a0603c';
        circle(-0.25, 0.15, 14, heap);
        circle(-0.05, 0.25, 10, heap);
        rect(0.15, -0.35, 0.25, 0.5, roof);
        // Копёр шахты.
        ctx.strokeStyle = '#5c5f66';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(-0.35 * W, -0.35 * H);
        ctx.lineTo(-0.2 * W, -0.05 * H);
        ctx.lineTo(-0.05 * W, -0.35 * H);
        ctx.stroke();
        circle(-0.2, -0.35, 4, '#5c5f66');
        break;
      }
      case 'oilwell':
        circle(0.25, -0.2, 11, '#c9c4ba');
        circle(0.25, 0.22, 11, '#c9c4ba');
        circle(0.25, -0.2, 5, roof);
        circle(0.25, 0.22, 5, roof);
        for (const y of [-0.25, 0.15]) {
          rect(-0.4, y, 0.32, 0.06, '#3d4148');
          circle(-0.38, y + 0.03, 4, '#3d4148');
        }
        break;
      case 'quarry':
        for (let i = 0; i < 4; i++) {
          ctx.fillStyle = ['#b9b4ad', '#a7a29b', '#959089', '#837e78'][i];
          ctx.beginPath();
          ctx.roundRect((-0.42 + i * 0.07) * W, (-0.38 + i * 0.07) * H, (0.84 - i * 0.14) * W, (0.76 - i * 0.14) * H, 8);
          ctx.fill();
        }
        break;
      case 'foodplant':
        rect(-0.42, -0.35, 0.5, 0.7, roof);
        for (let i = 0; i < 3; i++) circle(0.2 + (i % 2) * 0.14, -0.2 + i * 0.2, 6, '#d6d1c4');
        break;
      case 'sawmill':
        rect(-0.42, -0.35, 0.45, 0.7, roof);
        for (let i = 0; i < 5; i++) rect(0.1, -0.35 + i * 0.13, 0.3, 0.07, '#c99a5b');
        break;
      case 'steelmill':
        rect(-0.45, -0.35, 0.55, 0.7, roof);
        for (let i = 0; i < 3; i++) circle(0.22 + i * 0.08, -0.22 + i * 0.18, 5.5, '#3d4148');
        circle(0.3, 0.25, 9, '#b5543c');
        break;
      case 'refinery':
        for (let i = 0; i < 4; i++) circle(-0.3 + (i % 2) * 0.22, -0.18 + Math.floor(i / 2) * 0.38, 10, '#e6e1d8');
        rect(0.18, -0.38, 0.08, 0.76, roof);
        circle(0.36, -0.2, 5, '#6a4f9e');
        break;
      case 'buildmat':
        rect(-0.42, -0.35, 0.45, 0.7, roof);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) rect(0.1 + j * 0.16, -0.3 + i * 0.22, 0.13, 0.15, '#c96a4f');
        break;
      case 'factory':
        for (let i = 0; i < 5; i++) rect(-0.45 + i * 0.12, -0.35, 0.1, 0.7, i % 2 ? roof : '#3fa8a8');
        circle(0.32, 0.22, 7, '#5c5f66');
        rect(0.2, -0.35, 0.22, 0.3, '#b9c2c9');
        break;
    }
    ctx.restore();
  }

  /** Рисует картинку значка размером size в мировых единицах. */
  private icon(img: HTMLImageElement, p: Vec, size: number): void {
    if (!img.complete || !img.naturalWidth) return;
    this.ctx.drawImage(img, p.x - size / 2, p.y - size / 2, size, size);
  }

  private drawStation(st: Station, selected: boolean): void {
    const ctx = this.ctx;
    const fp = st.fp;
    this.drawFootprint({ ...fp, center: { x: fp.center.x + 3, y: fp.center.y + 4 } }, 'rgba(30,40,25,0.22)');
    this.drawFootprint(fp, '#f3f1ea', selected ? '#2f80ed' : '#5c6470', selected ? 3 : 1.4);
    ctx.save();
    ctx.translate(fp.center.x, fp.center.y);
    ctx.rotate(fp.angle);
    ctx.fillStyle = '#5c6470';
    ctx.fillRect(-fp.w / 2 + 3, -fp.h / 2 + 3, fp.w - 6, 4);
    for (let i = 0; i < st.bays; i++) {
      ctx.fillStyle = i < st.occupied.length ? '#e07b39' : '#d5d2c8';
      ctx.fillRect(-fp.w / 2 + 5 + i * ((fp.w - 10) / st.bays), -1, (fp.w - 10) / st.bays - 2, fp.h / 2 - 2);
    }
    ctx.restore();
  }

  /** Ожидающие на станциях грузы — поверх линий маршрутов, на белых плашках. */
  private drawStationBadges(game: Game, view: ReturnType<Renderer['view']>): void {
    const z = this.camera.zoom;
    if (z < 0.3) return;
    const ctx = this.ctx;
    for (const st of game.stations.values()) {
      const fp = st.fp;
      if (fp.center.x < view.x0 || fp.center.x > view.x1 || fp.center.y < view.y0 || fp.center.y > view.y1) continue;
      const waiting: [CargoType, number][] = FREIGHT.map((c) => [c, Math.floor(st.cargo[c] ?? 0)] as [CargoType, number]).filter(([, n]) => n > 0);
      let pax = 0;
      for (const n of st.passengers.values()) pax += n;
      if (pax > 0) waiting.push(['passengers', pax]);
      if (!waiting.length) continue;
      ctx.font = `700 ${11 / z}px system-ui, sans-serif`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const widths = waiting.map(([, n]) => 22 / z + ctx.measureText(String(n)).width + 6 / z);
      const total = widths.reduce((a, b) => a + b, 0) + (waiting.length - 1) * (4 / z);
      let x = fp.center.x - total / 2;
      const y = fp.center.y - fp.h / 2 - 14 / z;
      waiting.forEach(([c, n], i) => {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.strokeStyle = 'rgba(60,70,80,0.25)';
        ctx.lineWidth = 1 / z;
        ctx.beginPath();
        ctx.roundRect(x, y - 9 / z, widths[i], 18 / z, 9 / z);
        ctx.fill();
        ctx.stroke();
        this.icon(cargoImage(c), { x: x + 9 / z, y }, 15 / z);
        ctx.fillStyle = '#1f2933';
        ctx.fillText(String(n), x + 19 / z, y + 0.5 / z);
        x += widths[i] + 4 / z;
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
        text({ x: st.fp.center.x, y: st.fp.center.y + st.fp.h / 2 + 11 / z }, st.name, 11, '#ffffff', 'rgba(35,45,60,0.82)');
      }
    }
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
      this.signalPost(add(pos, scale({ x: -dir.y, y: dir.x }, RAIL_HALF + 4)), dir, remove ? '#e8483f' : '#3ad16b');
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
    if (o.upgrade) this.drawUpgradePreview(o.upgrade.curve, o.upgrade.spec);
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
    if (sel?.type === 'junction') this.drawJunctionPaths(game, sel.id, o.laneEdit?.node === sel.id ? o.laneEdit : null);
    let ring: { x: number; y: number; r: number } | null = null;
    const fleet = sel?.type === 'fleet' ? game.fleet.get(sel.id) : undefined;
    const sim = sel?.type === 'vehicle' ? game.traffic.vehicles.get(sel.simId) : fleet && game.fleetSim(fleet);
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

  private drawUpgradePreview(curve: Cubic, spec: RoadSpec): void {
    const ctx = this.ctx;
    const lut = new CurveLUT(curve);
    const e = roadEdges(spec);
    const off = (e.right - e.left) / 2;
    const surface = lut.offsetPolyline(off, 0, lut.length, 3);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(46, 157, 87, 0.6)';
    ctx.lineWidth = e.left + e.right + 5;
    this.polyline(surface);
    ctx.stroke();
    ctx.strokeStyle = C.road;
    ctx.lineWidth = e.left + e.right;
    this.polyline(surface);
    ctx.stroke();
    // Разметка будущей дороги — как у настоящей: полосы, осевая, кромки.
    const m = medianHalf(spec);
    const line = (o: number, color: string, width: number, dash: number[]) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash);
      this.polyline(lut.offsetPolyline(o, 0, lut.length, 4));
      ctx.stroke();
    };
    if (isOneWay(spec)) {
      const lanes = spec.lanesF + spec.lanesB;
      for (let i = 1; i < lanes; i++) line((i - lanes / 2) * LANE_W, C.dash, 1, [5, 6]);
    } else {
      const wide = spec.lanesF + spec.lanesB > 2;
      if (m) line(0, '#9aa1aa', 4, []);
      else line(0, wide ? C.divider : C.dash, wide ? 1.4 : 1, wide ? [] : [5, 6]);
      for (let i = 1; i < spec.lanesF; i++) line(m + i * LANE_W, C.dash, 1, [5, 6]);
      for (let i = 1; i < spec.lanesB; i++) line(-m - i * LANE_W, C.dash, 1, [5, 6]);
    }
    if (isTrunk(spec.cls) || isOneWay(spec)) {
      line(e.right - 1.8, C.dash, 1, []);
      line(-e.left + 1.8, C.dash, 1, []);
    }
    ctx.setLineDash([]);
    // Куда едут по односторонней — стрелки вдоль дороги.
    if (isOneWay(spec)) {
      const forward = spec.lanesF > 0;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      for (let s = 20; s < lut.length - 10; s += 45) {
        const p = lut.pointAt(s);
        let t = lut.tangentAt(s);
        if (!forward) t = scale(t, -1);
        const n = { x: -t.y, y: t.x };
        ctx.beginPath();
        ctx.moveTo(p.x + t.x * 4, p.y + t.y * 4);
        ctx.lineTo(p.x - t.x * 3 + n.x * 3, p.y - t.y * 3 + n.y * 3);
        ctx.lineTo(p.x - t.x * 3 - n.x * 3, p.y - t.y * 3 - n.y * 3);
        ctx.fill();
      }
    }
  }

  /**
   * Выбранный перекрёсток: разрешённые проезды — синие линии со стрелками, запрещённые — красный пунктир.
   * При настройке полос выбранная полоса въезда и её связи — зелёные, остальные проезды бледнее.
   */
  private drawJunctionPaths(game: Game, nodeId: number, edit: ToolOverlay['laneEdit']): void {
    const ctx = this.ctx;
    const net = game.roads.net;
    const g = game.roads.graph;
    const n = net.nodes.get(nodeId);
    if (!n) return;
    const z = this.camera.zoom;
    const all = (g.inLinks.get(nodeId) ?? []).flatMap((l) => l.lanes.flatMap((lane) => g.movesFrom.get(lane.id) ?? [])).filter((m) => m.node === nodeId);
    const radius = Math.max(12, ...all.map((m) => dist(n.pos, m.points[0])));
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
    this.drawStopsRoute(game, line.stops, line.color, true);
    // Машины и поезда линии — поверх маршрута, иначе их не видно под цветной полосой.
    // Под каждой — кружок цвета линии постоянного экранного размера: видно и издалека.
    const z = this.camera.zoom;
    const own: Vehicle[] = [];
    const trains = new Set<number>();
    const marks: LineMark[] = [];
    for (const vid of line.vehicles) {
      const fv = game.fleet.get(vid);
      if (!fv) continue;
      const cargo = fv.cargo && fv.amount > 0 ? fv.cargo : fv.passengers.some((p) => p.count > 0) ? 'passengers' : null;
      const sim = game.fleetSim(fv);
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
  private drawStopsRoute(game: Game, stops: number[], color: string, loop: boolean): void {
    const ctx = this.ctx;
    const z = this.camera.zoom;
    const legs = loop ? stops.length : stops.length - 1;
    for (let i = 0; i < legs; i++) {
      const fromId = stops[i];
      const toId = stops[(i + 1) % stops.length];
      const pts = game.routePolyline(fromId, toId);
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

/**
 * Нарезает линию на штрихи (5 из каждых 11 единиц), растягивая шаг так, чтобы на обоих концах
 * осталось по половине пробела: соседние участки на стыке продолжают пунктир ровно.
 */
function cutDashes(pts: Vec[], dash = 5, period = 11): Vec[][] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const L = cum[cum.length - 1];
  if (L < dash) return [];
  const k = Math.max(1, Math.round(L / period));
  const p = L / k;
  const d = (p * dash) / period;
  // Точка на расстоянии u вдоль ломаной.
  let j = 1;
  const at = (u: number): Vec => {
    while (j < cum.length - 1 && cum[j] < u) j++;
    const seg = cum[j] - cum[j - 1] || 1;
    const f = Math.max(0, Math.min(1, (u - cum[j - 1]) / seg));
    return { x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * f, y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * f };
  };
  const out: Vec[][] = [];
  for (let i = 0; i < k; i++) {
    const u0 = i * p + (p - d) / 2;
    const u1 = u0 + d;
    const piece = [at(u0)];
    for (let q = j; q < cum.length - 1 && cum[q] < u1; q++) if (cum[q] > u0) piece.push(pts[q]);
    piece.push(at(u1));
    out.push(piece);
  }
  return out;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
