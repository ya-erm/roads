import { SNAP_PIXELS } from '../config';
import { type Cubic, straightCubic } from '../core/bezier';
import { add, angleOf, dist, len, scale, sub, Vec } from '../core/vec';
import { DEFAULT_RING, type DrawMode, type NetKind, type RingOptions, type RingSize, type Snap } from '../game/build';
import type { AreaContents, Game, LaneEnd, StationKind } from '../game/game';
import { TEMPLATES, type TemplateKind, type TemplateOptions } from '../game/interchange';
import type { Camera } from '../render/camera';
import { HANDLE_PX, laneMarkRadius, type Selection, type ToolOverlay } from '../render/renderer';
import type { StationServes, TownBuilding } from '../world/entities';
import { MAX_LANES, RAIL_SPEC, ROAD_PRESETS, RoadSpec, sameSpec } from '../world/roadTypes';

export type Tool = 'select' | 'road' | 'rail' | 'lights' | 'roundabout' | 'station' | 'line' | 'bulldoze';

/** key — цифра инструмента, alt — дополнительная буква (B — снос, как в других стройках). */
export const TOOLS: { id: Tool; key: string; alt?: string; name: string }[] = [
  { id: 'select', key: '1', name: 'Выбор' },
  { id: 'road', key: '2', name: 'Дорога' },
  { id: 'rail', key: '3', name: 'Ж/д' },
  { id: 'lights', key: '4', name: 'Перекрёсток' },
  { id: 'roundabout', key: '5', name: 'Кольцо' },
  { id: 'station', key: '6', name: 'Станция' },
  { id: 'line', key: '7', name: 'Линия' },
  { id: 'bulldoze', key: '8', alt: 'B', name: 'Снос' },
];

/** Что делает клик: инструмент вместе с его режимом. */
export type Action = Exclude<Tool, 'rail'> | 'upgrade' | 'move' | 'signal' | 'template';
/** Дорога: строить, перестроить под выбранный тип, двигать узел или конец дороги, поставить развязку. */
export type RoadMode = 'build' | 'upgrade' | 'move' | 'template';
/** Ж/д: класть путь или ставить вокзал. */
export type RailMode = 'track' | 'station' | 'signal';

export const DRAW_MODES: { id: DrawMode; name: string }[] = [
  { id: 'straight', name: 'Прямая' },
  { id: 'arc', name: 'Дуга' },
  { id: 'curve', name: 'Кривая' },
];

const PAN_SPEED = 900;

/** Действия, которые строят или сносят, — и как назвать их в «Отменено: …». */
const UNDO_LABELS: Partial<Record<Action, string>> = {
  road: 'дорога',
  bulldoze: 'снос',
  upgrade: 'перестройка',
  move: 'перенос дороги',
  signal: 'сигнал',
  roundabout: 'кольцо',
  station: 'станция',
};

/** «3 дороги, 12 домов, 1 станция» — что снесёт рамка. */
export function areaSummary(c: AreaContents): string {
  const word = (n: number, one: string, few: string, many: string) => {
    const d = n % 10;
    const dd = n % 100;
    return d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
  };
  const parts = [
    c.segs.length && `${c.segs.length} ${word(c.segs.length, 'участок', 'участка', 'участков')} дорог`,
    c.buildings.length && `${c.buildings.length} ${word(c.buildings.length, 'дом', 'дома', 'домов')}`,
    c.stations.length && `${c.stations.length} ${word(c.stations.length, 'станция', 'станции', 'станций')}`,
  ].filter(Boolean);
  return parts.length ? `Снести: ${parts.join(', ')}` : 'Здесь нечего сносить';
}

export class Controller {
  tool: Tool = 'select';
  roadMode: RoadMode = 'build';
  railMode: RailMode = 'track';
  /** Параметры нового кольца. */
  ring: RingOptions = { ...DEFAULT_RING };
  /** С чем будет работать новая станция. */
  stationServes: StationServes = { pax: true, cargo: true };
  /** Узел, который игрок тащит в режиме «Двигать»: тупик (тянется его участок) или изгиб/перекрёсток (все дороги следом). */
  dragEnd: number | null = null;
  /** Участок, который гнём за середину в режиме «Двигать». */
  dragSeg: number | null = null;
  /** Участок, у которого видны перья (последний под курсором), и перо, которое тянем. */
  editSeg: number | null = null;
  dragHandle: { seg: number; which: 1 | 2 } | null = null;
  /** Прямая прилипла к продолжению дороги или перпендикуляру — подпись у курсора. */
  private angleHint: string | null = null;
  /** Камера следует за выбранной машиной или поездом (переключается F). */
  following = false;
  /** Линия, в маршрут которой добавляем станции кликами по карте. */
  addStopTo: number | null = null;
  /** Поворот ж/д станции в чистом поле (R). */
  stationAngle = 0;
  /** Сколько путей с платформами у новой ж/д станции. */
  stationTracks = 2;
  /** Шаблон развязки и поворот магистрали, если она строится вместе с развязкой (R). */
  templateKind: TemplateKind = 'diamond';
  templateAngle = 0;
  /** Снос: по одному объекту (можно вести мышью) или рамкой. */
  bulldozeMode: 'point' | 'area' = 'point';
  /** Угол рамки сноса, пока тянем. */
  areaStart: Vec | null = null;
  /** Рамка, которая ждёт подтверждения игрока (сносится много). */
  pendingArea: { a: Vec; b: Vec; contents: AreaContents } | null = null;
  presetId = 'street';
  spec: RoadSpec = { ...ROAD_PRESETS.find((p) => p.id === 'street')!.spec };
  drawMode: DrawMode = 'arc';
  level = 0;
  chain: Snap | null = null;
  chainTangent: Vec | null = null;
  control: Vec | null = null;
  lineDraft: number[] = [];
  selection: Selection | null = null;
  selectedLine: number | null = null;
  /** Предприятия, подсвеченные из панели цепочек. */
  highlight: number[] = [];
  ping: { pos: Vec; r: number; until: number } | null = null;
  /** Здание, которое игрок переносит (следует за курсором). */
  moving: TownBuilding | null = null;
  /** Настройка полос выбранного перекрёстка: полоса въезда, которую сейчас соединяем. */
  laneFrom: { seg: number; i: number } | null = null;
  heatmap = false;
  hover: Vec | null = null;
  onChange: () => void = () => {};
  private mouse = { x: 0, y: 0 };
  private shift = false;
  private pan: { sx: number; sy: number; cx: number; cy: number; moved: boolean } | null = null;
  private left: { sx: number; sy: number; createdChain: boolean } | null = null;
  private keys = new Set<string>();
  private flash: { text: string; until: number } | null = null;
  private lastSpeed = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly camera: Camera,
    private readonly game: () => Game,
  ) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('mouseleave', () => (this.hover = null));
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.key === 'Shift') this.shift = false;
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.shift = false;
    });
  }

  private get snapRadius(): number {
    return SNAP_PIXELS / this.camera.zoom;
  }

  // ---------- Настройки ----------

  setTool(tool: Tool): void {
    if (this.tool === 'line' && tool !== 'line') this.lineDraft = [];
    if (tool !== 'line') this.addStopTo = null;
    // Новая линия собирается с чистого листа: прежняя выбранная линия и объект не мешают.
    if (tool === 'line' && this.tool !== 'line') {
      this.selectedLine = null;
      this.selection = null;
    }
    this.tool = tool;
    this.chain = null;
    this.control = null;
    this.moving = null;
    this.dragEnd = null;
    this.dragSeg = null;
    this.dragHandle = null;
    this.editSeg = null;
    this.laneFrom = null;
    this.onChange();
  }

  /** Начать перенос здания: оно следует за курсором до клика. */
  startMove(b: TownBuilding): void {
    this.setTool('select');
    this.moving = b;
    this.onChange();
  }

  /** Что делает клик с учётом режима инструмента. */
  get action(): Action {
    if (this.tool === 'road') return this.roadMode === 'build' ? 'road' : this.roadMode;
    if (this.tool === 'rail') return this.railMode === 'station' ? 'station' : this.railMode === 'signal' ? 'signal' : 'road';
    return this.tool;
  }

  /** Что прокладываем: автодорогу или ж/д путь. */
  get netKind(): NetKind {
    return this.tool === 'rail' ? 'rail' : 'road';
  }

  /** Что ставим: автостанцию или вокзал. */
  get stationKind(): StationKind {
    return this.tool === 'rail' ? 'rail' : 'road';
  }

  setRoadMode(mode: RoadMode): void {
    if (this.tool !== 'road') this.setTool('road');
    this.roadMode = mode;
    this.chain = null;
    this.control = null;
    this.dragEnd = null;
    this.dragSeg = null;
    this.dragHandle = null;
    this.editSeg = null;
    this.onChange();
  }

  /** Переключает пассажиров или груз у новой станции; хотя бы одно остаётся включённым. */
  toggleStationServe(what: keyof StationServes): void {
    const next = { ...this.stationServes, [what]: !this.stationServes[what] };
    if (next.pax || next.cargo) this.stationServes = next;
    this.onChange();
  }

  setStationTracks(n: number): void {
    this.stationTracks = Math.max(2, Math.min(4, n));
    this.onChange();
  }

  setTemplate(kind: TemplateKind): void {
    this.templateKind = kind;
    this.onChange();
  }

  setBulldozeMode(mode: 'point' | 'area'): void {
    this.bulldozeMode = mode;
    this.areaStart = null;
    this.onChange();
  }

  /** Игрок согласился снести всё в рамке. */
  confirmArea(): void {
    const p = this.pendingArea;
    this.pendingArea = null;
    if (p) this.game().bulldozeArea(p.a, p.b);
    this.onChange();
  }

  cancelArea(): void {
    this.pendingArea = null;
    this.onChange();
  }

  /** Отпустили рамку: мало — сносим сразу, много или есть станции — спрашиваем. */
  private finishArea(a: Vec, b: Vec): void {
    const g = this.game();
    const contents = g.areaContents(a, b);
    const total = contents.segs.length + contents.buildings.length + contents.stations.length;
    if (!total) return;
    if (total > 8 || contents.stations.length) this.pendingArea = { a, b, contents };
    else g.bulldozeArea(a, b);
  }

  private templateOptions(): TemplateOptions {
    return { kind: this.templateKind, angle: this.templateAngle, trunk: this.spec };
  }

  setRingLanes(lanes: number): void {
    this.ring = { ...this.ring, lanes: Math.max(1, Math.min(3, lanes)) };
    this.onChange();
  }

  setRingSize(size: RingSize): void {
    this.ring = { ...this.ring, size };
    this.onChange();
  }

  setRailMode(mode: RailMode): void {
    if (this.tool !== 'rail') this.setTool('rail');
    this.railMode = mode;
    this.chain = null;
    this.control = null;
    this.onChange();
  }

  /** Профиль того, что сейчас строится. */
  get buildSpec(): RoadSpec {
    return this.netKind === 'rail' ? RAIL_SPEC : this.spec;
  }

  setPreset(id: string): void {
    const p = ROAD_PRESETS.find((x) => x.id === id);
    if (!p) return;
    this.presetId = id;
    // Ограничение скорости — по умолчанию для типа, пока игрок не выберет знак.
    this.spec = { ...p.spec };
    if (this.tool !== 'road') this.setTool('road');
    this.onChange();
  }

  /** Знак ограничения скорости для строящейся (или перестраиваемой) дороги. */
  setLimit(kmh: number): void {
    this.spec = { ...this.spec, limit: kmh };
    this.onChange();
  }

  setLanes(forward: number, backward: number): void {
    const f = Math.max(0, Math.min(MAX_LANES, forward));
    const b = Math.max(0, Math.min(MAX_LANES, backward));
    if (f + b === 0) return;
    this.spec = f === 0 ? { ...this.spec, lanesF: b, lanesB: 0 } : { ...this.spec, lanesF: f, lanesB: b };
    this.presetId = '';
    this.onChange();
  }

  setMode(mode: DrawMode): void {
    this.drawMode = mode;
    this.control = null;
    this.onChange();
  }

  setLevel(level: number): void {
    this.level = Math.max(-1, Math.min(2, level));
    this.onChange();
  }

  setSpeed(speed: number): void {
    if (speed > 0) this.lastSpeed = speed;
    this.game().speed = speed;
    this.onChange();
  }

  togglePause(): void {
    this.setSpeed(this.game().speed === 0 ? this.lastSpeed : 0);
  }

  toggleHeatmap(): void {
    this.heatmap = !this.heatmap;
    this.onChange();
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    this.following = false;
    this.laneFrom = null;
    this.onChange();
  }

  selectLine(id: number | null): void {
    this.selectedLine = id;
    this.onChange();
  }

  /** Переносит камеру к точке и при необходимости приближает. */
  focus(p: Vec, minZoom = 0.45): void {
    this.camera.x = p.x;
    this.camera.y = p.y;
    this.camera.zoom = Math.max(this.camera.zoom, minZoom);
    this.camera.touched = true;
  }

  /** Показывает место на карте, не меняя выбора: камера туда и пульсирующее кольцо. */
  showPlace(p: Vec, r: number): void {
    this.following = false;
    this.focus(p, 0.35);
    this.ping = { pos: p, r, until: performance.now() + 2500 };
    this.onChange();
  }

  finishLine(): void {
    const line = this.game().createLine(this.lineDraft);
    this.lineDraft = [];
    if (line) {
      this.selectedLine = line.id;
      this.tool = 'select';
    } else {
      this.showError('Нужно минимум две станции');
    }
    this.onChange();
  }

  cancelLine(): void {
    this.lineDraft = [];
    this.onChange();
  }

  /** Режим «добавить станции в маршрут линии» — клики по станциям на карте. */
  startAddStop(lineId: number): void {
    this.setTool('line');
    this.addStopTo = lineId;
    this.selectedLine = lineId;
    this.onChange();
  }

  stopAddStop(): void {
    const line = this.addStopTo;
    this.addStopTo = null;
    this.setTool('select');
    this.selectedLine = line;
    this.onChange();
  }

  reset(): void {
    this.chain = null;
    this.control = null;
    this.left = null;
    this.pan = null;
    this.lineDraft = [];
    this.selection = null;
    this.selectedLine = null;
    this.highlight = [];
    this.lastSpeed = 1;
  }

  update(dt: number): void {
    let dx = 0;
    let dy = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) dy += 1;
    if (dx || dy) {
      this.camera.x += (dx * PAN_SPEED * dt) / this.camera.zoom;
      this.camera.y += (dy * PAN_SPEED * dt) / this.camera.zoom;
      this.camera.touched = true;
      const t = this.game().terrain;
      this.camera.clamp(t.width, t.height);
      this.hover = this.camera.toWorld(this.mouse.x, this.mouse.y);
    }
    // Камера следует за выбранной машиной или поездом, пока не выключат F или не сдвинут камеру.
    if (this.following) {
      const p = this.followTarget();
      if (p) {
        this.camera.x = p.x;
        this.camera.y = p.y;
        this.camera.touched = true;
      } else {
        this.following = false;
      }
    }
    if (dx || dy) this.following = false;
  }

  /** Где сейчас выбранная машина или голова поезда. */
  private followTarget(): Vec | null {
    const g = this.game();
    const sel = this.selection;
    if (sel?.type === 'vehicle') return g.traffic.vehicles.get(sel.simId)?.pos ?? null;
    if (sel?.type === 'fleet') {
      const v = g.fleet.get(sel.id);
      if (!v) return null;
      const sim = g.fleetSim(v);
      if (sim) return sim.pos;
      const t = g.fleetTrain(v);
      if (t) return g.rail.pointAt(t, t.head - t.length / 2)?.pos ?? null;
      // На погрузке машины нет на дороге — камера ждёт у станции.
      const line = g.lines.get(v.lineId);
      return (line && g.stations.get(line.stops[v.stop])?.fp.center) ?? null;
    }
    return null;
  }

  /** Отменяет последнюю стройку (Ctrl+Z). */
  undo(): void {
    const g = this.game();
    this.chain = null;
    this.control = null;
    this.dragEnd = null;
    this.dragSeg = null;
    this.dragHandle = null;
    const label = g.undo();
    if (label) g.notify(`Отменено: ${label}`);
    else this.showError('Нечего отменять');
    this.onChange();
  }

  /** Камера к выбранной машине или поезду. */
  focusSelection(): void {
    const p = this.followTarget();
    if (p) this.focus(p, 0.8);
  }

  toggleFollow(): void {
    this.following = !this.following && this.followTarget() !== null;
    this.onChange();
  }

  // ---------- Мышь ----------

  private worldAt(e: MouseEvent): Vec {
    return this.camera.toWorld(e.clientX, e.clientY);
  }

  /** Точка конца дороги с привязкой угла и длины при зажатом Shift. */
  private endSnap(p: Vec): Snap {
    const g = this.game();
    if (this.shift && this.chain && this.drawMode === 'straight') {
      const d = sub(p, this.chain.pos);
      const base = this.chainTangent ? angleOf(this.chainTangent) : 0;
      const step = Math.PI / 12;
      const a = base + Math.round((angleOf(d) - base) / step) * step;
      const l = Math.max(10, Math.round(len(d) / 10) * 10);
      const snapped = add(this.chain.pos, scale({ x: Math.cos(a), y: Math.sin(a) }, l));
      const s = g.builder.snap(snapped, this.level, this.snapRadius * 0.5, this.netKind);
      return s.kind === 'node' ? s : { kind: 'free', pos: snapped, level: this.level };
    }
    const s = g.builder.snap(p, this.level, this.snapRadius, this.netKind);
    this.angleHint = null;
    // Прямая от существующей дороги сама прилипает к её продолжению (180°) или перпендикуляру (90°).
    if (s.kind === 'free' && this.chain && this.drawMode === 'straight') {
      const d = sub(p, this.chain.pos);
      const l = len(d);
      if (l > 20) {
        const dir = scale(d, 1 / l);
        let best: { v: Vec; hint: string; cos: number } | null = null;
        for (const ref of this.chainDirections()) {
          for (const [v, hint] of [
            [ref, 'прямо'],
            [{ x: -ref.y, y: ref.x }, '90°'],
            [{ x: ref.y, y: -ref.x }, '90°'],
          ] as const) {
            const c = dir.x * v.x + dir.y * v.y;
            if (c > Math.cos(0.1) && (!best || c > best.cos)) best = { v, hint, cos: c };
          }
        }
        if (best) {
          this.angleHint = best.hint;
          return { kind: 'free', pos: add(this.chain.pos, scale(best.v, l * best.cos)), level: this.level };
        }
      }
    }
    return s;
  }

  /** Перья видимого участка и, в его узлах, перья продолжающих его дорог. */
  private handleList(): { seg: number; which: 1 | 2; partner: boolean }[] {
    const g = this.game();
    if (this.editSeg === null || !g.net.segments.has(this.editSeg)) return [];
    const res: { seg: number; which: 1 | 2; partner: boolean }[] = [];
    for (const which of [1, 2] as const) {
      res.push({ seg: this.editSeg, which, partner: false });
      const pt = g.builder.handlePartner(this.editSeg, which);
      if (pt) res.push({ ...pt, partner: true });
    }
    return res;
  }

  /** Перо под курсором (с запасом в несколько пикселей). */
  private handleAt(p: Vec): { seg: number; which: 1 | 2 } | null {
    const net = this.game().net;
    let best: { seg: number; which: 1 | 2 } | null = null;
    let bestD = (HANDLE_PX + 4) / this.camera.zoom;
    for (const h of this.handleList()) {
      const c = net.segment(h.seg).curve;
      const d = dist(p, h.which === 1 ? c.p1 : c.p2);
      if (d <= bestD) {
        bestD = d;
        best = { seg: h.seg, which: h.which };
      }
    }
    return best;
  }

  /** Перья для подсказки на карте; curves — формы участков с учётом перетаскиваемого пера. */
  private handleMarks(curves: { seg: number; curve: Cubic }[] = []): NonNullable<ToolOverlay['handles']> {
    const net = this.game().net;
    const active = this.dragHandle ?? this.handleAt(this.hover ?? { x: NaN, y: NaN });
    return this.handleList().map((h) => {
      const c = curves.find((x) => x.seg === h.seg)?.curve ?? net.segment(h.seg).curve;
      return {
        anchor: h.which === 1 ? c.p0 : c.p3,
        pos: h.which === 1 ? c.p1 : c.p2,
        active: !!active && active.seg === h.seg && active.which === h.which,
        partner: h.partner,
      };
    });
  }

  /** Направления «прямо» от начала новой дороги: продолжения дорог в узле или вдоль разрезаемой дороги. */
  private chainDirections(): Vec[] {
    const g = this.game();
    const c = this.chain;
    if (!c) return [];
    if (c.kind === 'node' && g.net.nodes.has(c.nodeId)) {
      return g.net.node(c.nodeId).segments.filter((id) => g.net.segments.has(id)).map((id) => scale(g.net.dirFrom(c.nodeId, id), -1));
    }
    if (c.kind === 'split' && g.net.segments.has(c.segId)) {
      const seg = g.net.segment(c.segId);
      const t = seg.lut.tangentAt(seg.lut.sAtT(c.t));
      return [t, scale(t, -1)];
    }
    return this.chainTangent ? [this.chainTangent] : [];
  }

  private onDown(e: MouseEvent): void {
    this.mouse = { x: e.clientX, y: e.clientY };
    if (e.button === 1 || e.button === 2) {
      this.pan = { sx: e.clientX, sy: e.clientY, cx: this.camera.x, cy: this.camera.y, moved: false };
      return;
    }
    if (e.button !== 0) return;
    const p = this.worldAt(e);
    this.hover = p;
    const g = this.game();
    this.left = { sx: e.clientX, sy: e.clientY, createdChain: false };
    // Всё, что строит или сносит, можно отменить (Ctrl+Z): снимок до действия, итог — при отпускании кнопки.
    const label = this.moving ? 'перенос здания' : UNDO_LABELS[this.action];
    if (label) g.checkpoint(this.action === 'road' && this.netKind === 'rail' ? 'путь' : label);
    switch (this.action) {
      case 'road':
        if (!this.chain) {
          this.chain = g.builder.snap(p, this.level, this.snapRadius, this.netKind);
          this.chainTangent = g.builder.continuationTangent(this.chain);
          this.control = null;
          this.left.createdChain = true;
        }
        break;
      case 'bulldoze': {
        // Рамкой — сносим при отпускании кнопки.
        if (this.bulldozeMode === 'area') {
          this.areaStart = p;
          break;
        }
        const st = g.structureAt(p);
        if (st?.type === 'station') g.removeStation(st);
        else if (st?.type === 'building') g.demolishBuilding(st);
        else g.builder.bulldoze(p, this.snapRadius * 0.3);
        break;
      }
      case 'upgrade': {
        const check = g.builder.upgradeCheck(p, this.spec, this.snapRadius * 0.3);
        if (!g.builder.upgrade(p, this.spec, this.snapRadius * 0.3)) this.showError(check.reason);
        break;
      }
      case 'move': {
        // Берём узел или тупик и тянем; отпускаем — дороги перестраиваются до новой точки.
        // Сначала перья видимого участка, потом узел или тупик, потом середина дороги.
        const handle = this.handleAt(p);
        if (handle) {
          this.dragHandle = handle;
          break;
        }
        const node = g.builder.pickMovable(p, this.snapRadius);
        // Не узел — так середина дороги: её можно изогнуть.
        const seg = node ? null : g.builder.pickBendable(p, this.snapRadius * 0.3);
        if (node) this.dragEnd = node.id;
        else if (seg) this.dragSeg = seg.id;
        else this.showError('Возьмите за узел, конец или середину дороги');
        break;
      }
      case 'signal': {
        const plan = g.signalPlan(p, this.snapRadius);
        if (!g.toggleSignal(p, this.snapRadius)) this.showError(plan.reason ?? 'Не хватает денег');
        break;
      }
      case 'template': {
        // Развязка строится целиком или не строится вовсе (сама себе снимок для Ctrl+Z).
        const name = TEMPLATES.find((t) => t.id === this.templateKind)!.name;
        const error = g.buildTemplate(g.templatePlan(p, this.snapRadius, this.templateOptions()), `развязка «${name.toLowerCase()}»`);
        if (error) this.showError(error);
        break;
      }
      case 'lights': {
        // У выбранного перекрёстка клики по меткам полос соединяют въезды с выездами.
        if (this.laneClick(p)) break;
        // Клик по перекрёстку открывает его настройки: светофор, главная дорога, повороты.
        const n = g.builder.pickJunction(p, this.snapRadius);
        if (n) this.select({ type: 'junction', id: n.id });
        else if (this.laneFrom) this.clearLane();
        else this.showError('Кликните по перекрёстку');
        break;
      }
      case 'roundabout': {
        const check = g.builder.canRoundabout(p, this.snapRadius, this.ring);
        if (!g.builder.buildRoundabout(p, this.snapRadius, this.ring)) this.showError(check.reason);
        break;
      }
      case 'station': {
        const plan = g.stationPlan(p, this.snapRadius, this.stationKind, this.stationAngle, this.stationTracks);
        const st = g.placeStation(p, this.snapRadius, this.stationKind, this.stationServes, this.stationAngle, this.stationTracks);
        if (!st) this.showError(plan.reason);
        else this.select({ type: 'station', id: st.id });
        break;
      }
      case 'line': {
        const st = g.stationNear(p, this.camera.zoom);
        if (!st) {
          this.showError(g.industryAt(p, this.camera.zoom) ? 'У предприятия нет станции — поставьте её инструментом «Станция»' : 'Кликните по станции');
          break;
        }
        if (this.addStopTo !== null) {
          // Дополняем маршрут существующей линии.
          const problem = g.addLineStop(this.addStopTo, st.id);
          if (problem) this.showError(problem);
          this.onChange();
          break;
        }
        if (this.lineDraft.length >= 2 && st.id === this.lineDraft[0]) {
          this.finishLine();
          break;
        }
        const problem = g.lineProblem([...this.lineDraft, st.id]);
        if (problem) {
          this.showError(problem);
          break;
        }
        if (this.lineDraft[this.lineDraft.length - 1] !== st.id) this.lineDraft.push(st.id);
        this.onChange();
        break;
      }
      case 'select': {
        if (this.moving) {
          // Перенос здания: ставим на новое место.
          const plan = g.movePlan(this.moving, p);
          if (g.moveBuilding(this.moving, p)) {
            this.select({ type: 'building', id: this.moving.id });
            this.moving = null;
          } else {
            this.showError(plan.reason);
          }
          break;
        }
        this.select(this.pick(p));
        break;
      }
    }
  }

  // ---------- Полосы перекрёстка ----------

  /** Метки полос выбранного перекрёстка — только с инструментом «Перекрёсток». */
  private laneEnds(): LaneEnd[] {
    const sel = this.selection;
    if (this.tool !== 'lights' || sel?.type !== 'junction') return [];
    return this.game().laneEnds(sel.id);
  }

  /** Ближайшая к точке метка полосы. */
  private laneAt(p: Vec, ends = this.laneEnds()): LaneEnd | null {
    let best: LaneEnd | null = null;
    let bestD = laneMarkRadius(this.camera.zoom) * 1.4;
    for (const e of ends) {
      const d = dist(e.pos, p);
      if (d <= bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /** Полоса въезда, которую сейчас соединяем, — среди меток. */
  private activeLane(ends: LaneEnd[]): LaneEnd | undefined {
    const from = this.laneFrom;
    return from ? ends.find((e) => e.kind === 'in' && e.seg === from.seg && e.i === from.i) : undefined;
  }

  clearLane(): void {
    this.laneFrom = null;
    this.onChange();
  }

  /** Клик по метке: въезд — выбрать (повторно — снять выбор), выезд — соединить с выбранным въездом или разъединить. */
  private laneClick(p: Vec): boolean {
    const end = this.laneAt(p);
    const sel = this.selection;
    if (!end || sel?.type !== 'junction') return false;
    if (end.kind === 'in') {
      const same = this.laneFrom?.seg === end.seg && this.laneFrom.i === end.i;
      this.laneFrom = same ? null : { seg: end.seg, i: end.i };
    } else if (!this.laneFrom) {
      this.showError('Сначала выберите полосу въезда — белый кружок');
    } else {
      // Связи полос — тоже стройка: отменяются Ctrl+Z.
      const g = this.game();
      g.checkpoint('связь полос');
      const problem = g.toggleLaneConnection(sel.id, this.laneFrom.seg, this.laneFrom.i, end.seg, end.i);
      if (problem) this.showError(problem);
    }
    this.onChange();
    return true;
  }

  private pick(p: Vec): Selection | null {
    const g = this.game();
    const train = g.trainAt(p);
    const owner = train && g.trainOwner(train);
    if (owner) return { type: 'fleet', id: owner.id };
    const veh = g.vehicleAt(p);
    if (veh?.fleet) return { type: 'fleet', id: veh.fleet.id };
    if (veh) return { type: 'vehicle', simId: veh.sim.id };
    const st = g.structureAt(p);
    if (st?.type === 'station') return { type: 'station', id: st.id };
    if (st?.type === 'industry') return { type: 'industry', id: st.id };
    if (st?.type === 'building') return { type: 'building', id: st.id };
    const town = g.townAt(p);
    if (town) return { type: 'town', id: town.id };
    return null;
  }

  private onMove(e: MouseEvent): void {
    this.mouse = { x: e.clientX, y: e.clientY };
    this.shift = e.shiftKey;
    if (this.pan) {
      const dx = e.clientX - this.pan.sx;
      const dy = e.clientY - this.pan.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        this.pan.moved = this.camera.touched = true;
        this.following = false;
      }
      this.camera.x = this.pan.cx - dx / this.camera.zoom;
      this.camera.y = this.pan.cy - dy / this.camera.zoom;
      const t = this.game().terrain;
      this.camera.clamp(t.width, t.height);
    }
    if (e.target === this.canvas || this.pan || this.left) this.hover = this.worldAt(e);
    if (this.left && this.tool === 'bulldoze' && this.bulldozeMode === 'point' && this.hover) {
      this.game().builder.bulldoze(this.hover, this.snapRadius * 0.3);
    }
  }

  private onUp(e: MouseEvent): void {
    if ((e.button === 1 || e.button === 2) && this.pan) {
      if (!this.pan.moved && e.button === 2) {
        if (this.moving) this.moving = null;
        else if (this.control) this.control = null;
        else if (this.chain) this.chain = null;
        else if (this.lineDraft.length) this.lineDraft.pop();
        else if (this.laneFrom) this.laneFrom = null;
        else this.select(null);
        this.onChange();
      }
      this.pan = null;
      return;
    }
    if (e.button !== 0 || !this.left) return;
    const left = this.left;
    this.left = null;
    try {
      this.finishLeft(e, left);
    } finally {
      // Ничего не построили — снимок для отмены не нужен.
      this.game().commit();
    }
  }

  private finishLeft(e: MouseEvent, left: { sx: number; sy: number; createdChain: boolean }): void {
    if (this.action === 'bulldoze' && this.areaStart) {
      const a = this.areaStart;
      this.areaStart = null;
      const p = this.worldAt(e);
      // Просто клик в режиме рамки — сносим то, что под курсором.
      if (Math.hypot(e.clientX - left.sx, e.clientY - left.sy) <= 8) {
        const g = this.game();
        const st = g.structureAt(p);
        if (st?.type === 'station') g.removeStation(st);
        else if (st?.type === 'building') g.demolishBuilding(st);
        else g.builder.bulldoze(p, this.snapRadius * 0.3);
      } else this.finishArea(a, p);
      this.onChange();
      return;
    }
    if (this.action === 'move' && this.dragHandle) {
      const h = this.dragHandle;
      this.dragHandle = null;
      if (Math.hypot(e.clientX - left.sx, e.clientY - left.sy) <= 4) return;
      const g = this.game();
      // Перо продолжающей дороги встаёт на ту же прямую; с Shift — излом на стыке.
      const res = g.builder.handlePlan(h.seg, h.which, this.worldAt(e), !e.shiftKey);
      if (!res || !g.builder.applyHandle(res)) this.showError(res?.plan.reason ?? 'Нельзя изогнуть');
      this.onChange();
      return;
    }
    if (this.action === 'move' && this.dragSeg !== null) {
      const segId = this.dragSeg;
      this.dragSeg = null;
      if (Math.hypot(e.clientX - left.sx, e.clientY - left.sy) <= 8) return;
      const g = this.game();
      const plan = g.builder.bendPlan(segId, this.worldAt(e));
      if (!plan.ok || !g.builder.bendSegment(segId, this.worldAt(e))) this.showError(plan.reason ?? 'Нельзя изогнуть');
      this.onChange();
      return;
    }
    if (this.action === 'move' && this.dragEnd !== null) {
      const nodeId = this.dragEnd;
      this.dragEnd = null;
      // Просто клик по узлу — ничего не двигаем.
      if (Math.hypot(e.clientX - left.sx, e.clientY - left.sy) <= 8) return;
      const g = this.game();
      const node = g.net.nodes.get(nodeId);
      if (!node) return;
      if (node.segments.length > 1) {
        // Узел: все его дороги перестраиваются следом — или ничего.
        const to = this.nodeTarget(nodeId, this.worldAt(e));
        const plan = g.builder.moveNodePlan(nodeId, to);
        if (!plan.ok || !g.builder.moveNode(nodeId, to)) this.showError(plan.reason ?? 'Нельзя передвинуть');
        this.onChange();
        return;
      }
      const target = this.moveTarget(nodeId, this.worldAt(e));
      const req = g.builder.moveEndRequest(nodeId, target);
      const plan = req && g.builder.plan(req);
      if (!plan?.ok || !g.builder.moveEnd(nodeId, target)) this.showError(plan?.reason ?? 'Нельзя передвинуть');
      this.onChange();
      return;
    }
    if (this.action !== 'road') return;
    const moved = Math.hypot(e.clientX - left.sx, e.clientY - left.sy) > 8;
    if (left.createdChain && !moved) return;
    const p = this.worldAt(e);
    if (this.drawMode === 'curve' && !this.control) {
      this.control = p;
      return;
    }
    this.tryBuild(p);
  }

  /** Куда встанет перетаскиваемый конец: узел, дорога или свободная точка (кроме самого участка). */
  private moveTarget(nodeId: number, p: Vec): Snap {
    const g = this.game();
    const n = g.net.node(nodeId);
    return g.builder.snap(p, n.level, this.snapRadius, 'road', { nodes: [nodeId], segs: [...n.segments] });
  }

  /** Куда встанет перетаскиваемый узел: у прямой между соседями — ровно на неё. */
  private nodeTarget(nodeId: number, p: Vec): Vec {
    return this.game().builder.alignNode(nodeId, p, this.snapRadius * 0.6);
  }

  private request(end: Snap) {
    return {
      start: this.chain!,
      end,
      spec: this.buildSpec,
      mode: this.drawMode,
      tangent: this.chainTangent,
      control: this.control,
    };
  }

  private tryBuild(p: Vec): void {
    const g = this.game();
    if (!this.chain) return;
    const end = this.endSnap(p);
    const req = this.request(end);
    const plan = g.builder.plan(req);
    if (!plan.ok) {
      this.showError(plan.reason);
      return;
    }
    const res = g.builder.build(req);
    if (res) {
      const node = g.net.node(res.endNode);
      this.chain = { kind: 'node', nodeId: res.endNode, pos: node.pos, level: node.level };
      this.chainTangent = res.tangent;
      this.control = null;
    }
  }

  private showError(text?: string): void {
    if (text) this.flash = { text, until: performance.now() + 1600 };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.camera.zoomAt(e.clientX, e.clientY, factor);
    this.camera.touched = true;
    this.hover = this.worldAt(e);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    this.keys.add(e.code);
    if (e.key === 'Shift') this.shift = true;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault();
      this.undo();
      return;
    }
    // Сочетания с Cmd / Ctrl / Alt — браузеру (Cmd+N, Cmd+M…), игре только одиночные клавиши.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tool = TOOLS.find((t) => `Digit${t.key}` === e.code || (t.alt && `Key${t.alt}` === e.code));
    if (tool) {
      this.setTool(tool.id);
      return;
    }
    switch (e.code) {
      case 'Escape':
        if (this.pendingArea) this.cancelArea();
        else if (this.areaStart) this.areaStart = null;
        else if (this.dragHandle) this.dragHandle = null;
        else if (this.dragSeg !== null) this.dragSeg = null;
        else if (this.dragEnd !== null) this.dragEnd = null;
        else if (this.addStopTo !== null) this.stopAddStop();
        else if (this.moving) this.moving = null;
        else if (this.control) this.control = null;
        else if (this.chain) this.chain = null;
        else if (this.lineDraft.length) this.cancelLine();
        else if (this.laneFrom) this.clearLane();
        else if (this.tool !== 'select') this.setTool('select');
        else {
          this.select(null);
          this.selectLine(null);
        }
        break;
      case 'Enter':
        if (this.tool === 'line') this.finishLine();
        break;
      case 'Space':
        e.preventDefault();
        this.togglePause();
        break;
      case 'KeyH':
        this.toggleHeatmap();
        break;
      case 'KeyF':
        this.toggleFollow();
        break;
      case 'KeyR':
        // Поворот ж/д станции, которая ставится в чистом поле.
        if (this.action === 'station' && this.stationKind === 'rail') {
          this.stationAngle += (e.shiftKey ? -1 : 1) * (Math.PI / 12);
          this.onChange();
        }
        // Поворот магистрали, которая строится вместе с развязкой.
        if (this.action === 'template') {
          this.templateAngle += (e.shiftKey ? -1 : 1) * (Math.PI / 12);
          this.onChange();
        }
        break;
      // Режимы дороги: N — строить, U — перестроить, M — двигать (включают инструмент «Дорога»).
      case 'KeyN':
        this.setRoadMode('build');
        break;
      case 'KeyU':
        this.setRoadMode('upgrade');
        break;
      case 'KeyM':
        this.setRoadMode('move');
        break;
      case 'KeyQ': {
        const i = DRAW_MODES.findIndex((m) => m.id === this.drawMode);
        this.setMode(DRAW_MODES[(i + 1) % DRAW_MODES.length].id);
        break;
      }
      case 'BracketRight':
      case 'PageUp':
        this.setLevel(this.level + 1);
        break;
      case 'BracketLeft':
      case 'PageDown':
        this.setLevel(this.level - 1);
        break;
    }
  }

  // ---------- Оверлей ----------

  overlay(): ToolOverlay {
    const g = this.game();
    if (this.chain?.kind === 'node' && !g.net.nodes.has(this.chain.nodeId)) this.chain = null;
    if (this.chain?.kind === 'split' && !g.net.segments.has(this.chain.segId)) this.chain = null;
    this.lineDraft = this.lineDraft.filter((id) => g.stations.has(id));
    const o: ToolOverlay = {
      hover: this.hover,
      snap: null,
      chainStart: null,
      control: this.control,
      plan: null,
      highlightSeg: null,
      highlightNode: null,
      station: null,
      catchmentAt: null,
      catchmentR: 0,
      railPreview: null,
      signal: null,
      template: null,
      lineStops: this.lineDraft,
      selectedLine: this.selectedLine,
      selection: this.selection,
      highlight: this.highlight,
      ping: this.ping && performance.now() < this.ping.until ? this.ping : null,
      area: null,
      marks: [],
      label: null,
      heatmap: this.heatmap,
      laneEdit: null,
    };
    // Инструмент «Перекрёсток» у выбранного перекрёстка: метки полос для настройки связей.
    const laneEnds = this.laneEnds();
    if (laneEnds.length && this.selection?.type === 'junction') {
      if (this.laneFrom && !this.activeLane(laneEnds)) this.laneFrom = null;
      o.laneEdit = { node: this.selection.id, ends: laneEnds, from: this.laneFrom, hover: null };
    }
    if (this.selection?.type === 'station') {
      const st = g.stations.get(this.selection.id);
      if (st) {
        o.catchmentAt = st.fp.center;
        o.catchmentR = g.catchmentRadius(st);
      }
    }
    const flash = this.flash && performance.now() < this.flash.until ? this.flash.text : null;
    const p = this.hover;
    const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;
    // Рамка сноса: пока тянем — по курсору, после — ждёт подтверждения.
    const area = this.pendingArea ?? (this.areaStart && p ? { a: this.areaStart, b: p, contents: g.areaContents(this.areaStart, p) } : null);
    if (area) {
      const c = area.contents;
      o.area = { a: area.a, b: area.b, segs: c.segs, fps: [...c.buildings.map((x) => x.fp), ...c.stations.map((x) => x.fp)] };
      if (!this.pendingArea) {
        o.label = { text: `${areaSummary(c)} · +${money(c.refund)}${c.cost ? ` −${money(c.cost)}` : ''}`, ok: true };
        return o;
      }
    }
    if (!p) return o;

    switch (this.action) {
      case 'road': {
        o.chainStart = this.chain;
        o.snap = this.chain ? this.endSnap(p) : g.builder.snap(p, this.level, this.snapRadius, this.netKind);
        if (this.chain) {
          if (this.drawMode === 'curve' && !this.control) {
            o.label = { text: 'Укажите изгиб кривой', ok: true };
            o.control = p;
            break;
          }
          o.plan = g.builder.plan(this.request(o.snap));
          const lvl = o.plan.levelA !== o.plan.levelB ? ` · уровень ${o.plan.levelA}→${o.plan.levelB}` : '';
          const razed = o.plan.demolish.length ? ` · снос ${o.plan.demolish.length} зд.` : '';
          for (const id of o.plan.demolish) {
            const b = g.buildingById(id);
            if (b) o.marks.push({ fp: b.fp, ok: false });
          }
          const aligned = this.chain && this.angleHint ? ` · ${this.angleHint}` : '';
          o.label = o.plan.ok
            ? { text: `${money(o.plan.cost)} · ${Math.round(o.plan.lut?.length ?? 0)} м${aligned}${lvl}${razed}`, ok: true }
            : { text: `${o.plan.reason} · ${money(o.plan.cost)}`, ok: false };
        }
        break;
      }
      case 'upgrade': {
        const check = g.builder.upgradeCheck(p, this.spec, this.snapRadius * 0.3);
        if (check.seg) {
          // Можно — показываем будущую дорогу (ширина, полосы, направление); нельзя — красным.
          if (check.ok) {
            // Тот же тип — перестройка разворачивает одностороннюю: в предпросмотре стрелки в другую сторону.
            const spec = sameSpec(check.seg.spec, this.spec) ? { ...this.spec, lanesF: this.spec.lanesB, lanesB: this.spec.lanesF } : this.spec;
            o.upgrade = { curve: check.seg.curve, spec };
          } else o.highlightSeg = check.seg.id;
          o.label = check.ok ? { text: check.cost ? money(check.cost) : 'Развернуть', ok: true } : { text: check.reason ?? '', ok: false };
        }
        break;
      }
      case 'move': {
        if (this.dragHandle && g.net.segments.has(this.dragHandle.seg)) {
          // Тянем перо: кривая меняется, угол у этого конца — вслед за пером; перо соседа — на той же прямой.
          const res = g.builder.handlePlan(this.dragHandle.seg, this.dragHandle.which, p, !this.shift)!;
          const plan = res.plan;
          o.plans = plan.plans;
          o.handles = this.handleMarks(res.curves);
          for (const id of plan.demolish) {
            const b = g.buildingById(id);
            if (b) o.marks.push({ fp: b.fp, ok: false });
          }
          const price = plan.cost < 0 ? `+${money(-plan.cost)}` : money(plan.cost);
          const kink = this.shift ? ' · излом' : '';
          o.label = plan.ok ? { text: `Перо${kink} · ${price}`, ok: true } : { text: `${plan.reason} · ${price}`, ok: false };
          break;
        }
        if (this.handleAt(p)) {
          o.handles = this.handleMarks();
          o.label = { text: 'Тяните перо · Shift — излом на стыке', ok: true };
          break;
        }
        if (this.dragSeg !== null && g.net.segments.has(this.dragSeg)) {
          // Гнём участок: новая форма через курсор, концы на месте.
          const plan = g.builder.bendPlan(this.dragSeg, p);
          o.plans = plan.plans;
          o.highlightNode = { pos: p, ok: plan.ok, radius: 6 };
          for (const id of plan.demolish) {
            const b = g.buildingById(id);
            if (b) o.marks.push({ fp: b.fp, ok: false });
          }
          const price = plan.cost < 0 ? `+${money(-plan.cost)}` : money(plan.cost);
          o.label = plan.ok ? { text: `Изогнуть · ${price}`, ok: true } : { text: `${plan.reason} · ${price}`, ok: false };
          break;
        }
        const drag = this.dragEnd !== null ? g.net.nodes.get(this.dragEnd) : undefined;
        if (drag && drag.segments.length > 1) {
          // Тянем узел: все его дороги в новой форме; недопустимые — красным.
          const to = this.nodeTarget(drag.id, p);
          const plan = g.builder.moveNodePlan(drag.id, to);
          o.plans = plan.plans;
          o.highlightNode = { pos: to, ok: plan.ok, radius: 8 };
          for (const id of plan.demolish) {
            const b = g.buildingById(id);
            if (b) o.marks.push({ fp: b.fp, ok: false });
          }
          // Вернут больше, чем потратим (дорога стала короче) — показываем возврат.
          const price = plan.cost < 0 ? `+${money(-plan.cost)}` : money(plan.cost);
          const straight = to !== p ? ' · ровно' : '';
          const razed = plan.demolish.length ? ` · снос ${plan.demolish.length} зд.` : '';
          o.label = plan.ok ? { text: `${price}${straight}${razed}`, ok: true } : { text: `${plan.reason} · ${price}`, ok: false };
          break;
        }
        if (this.dragEnd !== null && g.net.nodes.has(this.dragEnd)) {
          // Тянем: показываем новый участок и куда он примкнёт.
          o.snap = this.moveTarget(this.dragEnd, p);
          const req = g.builder.moveEndRequest(this.dragEnd, o.snap);
          if (req) {
            o.plan = g.builder.plan(req);
            o.chainStart = req.start;
            o.highlightSeg = g.net.node(this.dragEnd).segments[0] ?? null;
            const joins = o.snap.kind === 'free' ? '' : ' · примкнёт';
            o.label = o.plan.ok
              ? { text: `${money(o.plan.cost)}${joins}`, ok: true }
              : { text: `${o.plan.reason} · ${money(o.plan.cost)}`, ok: false };
          }
          break;
        }
        const end = g.builder.pickMovable(p, this.snapRadius);
        if (end) {
          o.highlightNode = { pos: end.pos, ok: true, radius: 10 };
          o.label = { text: end.segments.length > 1 ? 'Тяните узел — дороги следом' : 'Тяните конец дороги', ok: true };
          break;
        }
        const bend = g.builder.pickBendable(p, this.snapRadius * 0.3);
        if (bend) {
          // У дороги под курсором видны перья — они остаются, пока курсор идёт к ним.
          this.editSeg = bend.id;
          o.highlightSeg = bend.id;
          o.highlightEdit = true;
          o.label = { text: 'Тяните — изогнуть дорогу', ok: true };
        }
        o.handles = this.handleMarks();
        break;
      }
      case 'bulldoze': {
        const st = g.structureAt(p);
        if (st?.type === 'station') {
          o.label = { text: `Снести станцию ${st.name}`, ok: true };
          o.station = { fp: st.fp, ok: false };
          break;
        }
        if (st?.type === 'building') {
          o.marks.push({ fp: st.fp, ok: false });
          o.label =
            st.kind === 'landmark'
              ? { text: 'Ратушу снести нельзя', ok: false }
              : { text: `Снести здание · ${money(g.demolishCost(st.id))}`, ok: true };
          break;
        }
        const seg = g.builder.pickSegment(p, this.snapRadius * 0.3);
        if (seg) {
          o.highlightSeg = seg.id;
          o.label = { text: `+${money(g.builder.segmentCost(seg) * 0.5)}`, ok: true };
        }
        break;
      }
      case 'lights': {
        const edit = o.laneEdit;
        const end = edit && this.laneAt(p, edit.ends);
        if (edit && end) {
          edit.hover = end;
          const active = this.activeLane(edit.ends);
          if (end.kind === 'in') o.label = { text: end.lane === active?.lane ? 'Снять выбор полосы' : 'Куда ведёт эта полоса', ok: true };
          else if (!active) o.label = { text: 'Сначала белый кружок — полоса въезда', ok: false };
          else if (!active.exits.includes(end.seg)) o.label = { text: 'С этой полосы сюда не проехать', ok: false };
          else {
            const linked = (g.net.movesFrom.get(active.lane) ?? []).some((m) => m.outLane === end.lane);
            o.label = { text: linked ? 'Убрать связь' : 'Соединить', ok: true };
          }
          break;
        }
        const n = g.builder.pickJunction(p, this.snapRadius);
        if (n && edit?.node === n.id) {
          o.label = { text: edit.from ? 'Оранжевый кружок — куда ехать' : 'Белый кружок — полоса въезда', ok: true };
        } else if (n) {
          o.highlightNode = { pos: n.pos, ok: true, radius: n.radius + 8 };
          o.label = { text: 'Настроить перекрёсток', ok: true };
        }
        break;
      }
      case 'template': {
        const plan = g.templatePlan(p, this.snapRadius, this.templateOptions());
        const name = TEMPLATES.find((t) => t.id === this.templateKind)!.name;
        if (plan.preview.length) o.template = { curves: plan.preview, ok: plan.ok };
        o.label = plan.ok
          ? { text: `${name}${plan.withTrunk ? ' вместе с магистралью (R — повернуть)' : ''} · ${money(plan.cost)}`, ok: true }
          : { text: plan.reason ?? '', ok: false };
        break;
      }
      case 'signal': {
        const plan = g.signalPlan(p, this.snapRadius);
        if (plan.ok && plan.pos && plan.dir) o.signal = { pos: plan.pos, dir: plan.dir, remove: !!plan.remove };
        o.label = plan.ok
          ? { text: plan.remove ? 'Снять сигнал' : `Сигнал для поездов в эту сторону · ${money(plan.cost ?? 0)}`, ok: true }
          : { text: plan.reason ?? '', ok: false };
        break;
      }
      case 'roundabout': {
        const check = g.builder.canRoundabout(p, this.snapRadius, this.ring);
        if (check.center) o.highlightNode = { pos: check.center, ok: check.ok, radius: check.r };
        o.label = check.ok ? { text: `Кольцо · ${money(check.cost)}`, ok: true } : { text: check.reason ?? '', ok: false };
        break;
      }
      case 'station': {
        const plan = g.stationPlan(p, this.snapRadius, this.stationKind, this.stationAngle, this.stationTracks);
        if (plan.fp) {
          o.station = { fp: plan.fp, ok: plan.ok };
          o.catchmentAt = plan.fp.center;
          o.catchmentR = g.catchmentRadius({ kind: this.stationKind });
        }
        // Ж/д станция: показываем обгонный путь, а в чистом поле — и главный.
        if (plan.rail) {
          const main = plan.rail.main;
          const tracks = plan.rail.tracks.flat();
          o.railPreview = main ? [...tracks, straightCubic(main.start.pos, main.end.pos)] : tracks;
        }
        // Автостанция: выезд, который построится вместе с ней, точка примыкания и дома под снос.
        const drive = plan.driveway;
        if (drive?.plan.lut) {
          o.plan = { ...drive.plan, ok: plan.ok };
          if (drive.from.kind !== 'free') o.snap = drive.from;
        }
        const razed = [...(drive?.plan.demolish ?? []), ...(plan.demolish ?? [])];
        for (const id of razed) {
          const b = g.buildingById(id);
          if (b) o.marks.push({ fp: b.fp, ok: false });
        }
        const free = plan.rail?.main ? ' · R — повернуть' : '';
        const raze = razed.length ? ` · снос ${razed.length} зд.` : '';
        const what = this.stationKind === 'rail' ? 'Ж/д станция' : 'Станция';
        o.label = plan.ok ? { text: `${what} · ${money(plan.cost)}${raze}${free}`, ok: true } : { text: plan.reason ?? '', ok: false };
        break;
      }
      case 'line': {
        const st = g.stationNear(p, this.camera.zoom);
        if (st) o.marks.push({ fp: st.fp, ok: true });
        if (this.addStopTo !== null) {
          o.selectedLine = this.addStopTo;
          o.label = st ? { text: `В маршрут: ${st.name}`, ok: true } : { text: 'Кликните по станции · Esc — готово', ok: true };
          break;
        }
        o.label = st
          ? { text: this.lineDraft.length >= 2 && st.id === this.lineDraft[0] ? 'Замкнуть линию' : `Добавить: ${st.name}`, ok: true }
          : { text: this.lineDraft.length ? 'Следующая станция · Enter — готово' : 'Выберите первую станцию', ok: true };
        break;
      }
      case 'select': {
        if (this.moving) {
          const plan = g.movePlan(this.moving, p);
          o.marks.push({ fp: this.moving.fp, ok: false });
          if (plan.fp) o.marks.push({ fp: plan.fp, ok: plan.ok });
          o.label = plan.ok
            ? { text: `Перенести сюда · ${money(plan.cost)} · Esc — отмена`, ok: true }
            : { text: plan.reason ?? '', ok: false };
          break;
        }
        const st = g.structureAt(p);
        if (st?.type === 'station') o.label = { text: st.name, ok: true };
        else if (st?.type === 'industry') o.label = { text: st.name, ok: true };
        else if (st?.type === 'building') {
          const t = g.townOf(st);
          if (t) o.label = { text: t.name, ok: true };
        }
        break;
      }
    }
    if (flash) o.label = { text: flash, ok: false };
    return o;
  }
}
