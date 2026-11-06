import { ANNEX, COST, ECONOMY, RAIL_STATION, SNAP_PIXELS, STORAGE } from '../config';
import { warehouseZone } from '../game/warehouses';
import { annexZone, growthCap } from '../game/annexes';
import { CurveLUT, minRadius, offsetCubic, straightCubic } from '../core/bezier';
import { add, angleOf, dist, dot, len, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import type { DrawMode, NetKind, RoadRequest, Snap } from '../game/build';
import { DEFAULT_RING, type RingOptions, type RingSize } from '../game/roads';
import type { AreaContents, Game, LaneEnd, PastePlan, StationKind } from '../game/game';
import { snapRails } from '../game/railFragment';
import { type Beside, besideGhost, besideRun, besideTrack } from '../game/railEdit';
import type { NetEdit, RoadPlan } from '../game/roadbuild';
import { TEMPLATES, type TemplateKind, type TemplateOptions } from '../game/interchange';
import { deleteTemplate, getTemplate, saveTemplate } from '../game/templates';
import { anchorAt, corridorUnder, edgeAt, handlePoints, laneEndAt, lanePortsNear, type LaneTip, laneTipAt, laneTipPos, laneUnder, newLaneFlow } from '../lanes/edit';
import type { LaneNet } from '../lanes/model';
import { pointOff } from '../lanes/geometry';
import { taperLen } from '../lanes/model';
import { type Fragment, fragmentCurves, frameOf, snapPaste } from '../lanes/fragment';
import type { Camera } from '../render/camera';
import { curveSpeed } from '../lanes/speedProfile';
import { speedsUnder, speedText } from '../lanes/speedHover';
import { laneSpeed } from '../lanes/graph';
import { GRADE } from '../config';
import { profileText, type ProfileSummary } from '../game/grade';
import type { TerraformMode } from '../world/terrain';
import { altitudeText } from '../render/relief';
import { HANDLE_PX, laneMarkRadius, type Selection, type ToolOverlay } from '../render/renderer';
import { type StationServes, stationTitle, type TownBuilding } from '../world/entities';
import type { RoadNode } from '../world/network';
import { DEFAULT_PRESET_ID, defaultPreset, isOneWay, KMH_PER_UNIT, LANE_W, LEVELS, MAX_LANES, RAIL_SPEC, ROAD_PRESETS, RoadSpec, TRACK_GAP } from '../world/roadTypes';
import { dirArrow, failText, laneFlowText, money, NO_MONEY, riseLabel, signedMetres, structureHeightText } from './labels';
import { nodeDeck } from '../lanes/deck';
import type { MoveProject } from '../game/moveProject';
import { onOldAxis } from '../game/roadbuild';
import { mergeEdit, mergeProblem, splitEdit, splitProblem } from '../lanes/nodeEdit';
import type { CornerHandle } from '../lanes/corners';
import { corridorHalf } from '../world/worldgen';
import { corridorCurveSigns, freshSignCorridors, staleSignCorridors } from '../game/roadProject';
import { type DrawSettings, type ProjectTools, sharedRoadProject } from './projecttools';
import { RailTools } from './railtools';
import { markAt, warningMarks, type WarningMark } from '../game/stationWarnings';
import { deckHeight, RoadTools } from './roadtools';
import { phaseToggle, specOf, turnAt } from '../lanes/lights';
import { phaseTurns } from '../ui/phasesUi';

export type Tool = 'select' | 'road' | 'rail' | 'lights' | 'roundabout' | 'station' | 'line' | 'bulldoze' | 'terrain';

/**
 * Каким действием отпускать знак скорости, чтобы браузер его принял: из того, что разрешено. На macOS с зажатым
 * Cmd система оставляет перетаскиванию только «переместить», с Ctrl — «ссылку»; без клавиш — «копировать».
 */
export function dropEffectFor(allowed: string): 'copy' | 'move' | 'link' {
  const a = allowed.toLowerCase();
  if (a === 'all' || a === 'uninitialized' || a.includes('copy')) return 'copy';
  if (a.includes('move')) return 'move';
  if (a.includes('link')) return 'link';
  return 'copy';
}

/** key — цифра инструмента, alt — дополнительная буква (B — снос, как в других стройках). */
export const TOOLS: { id: Tool; key: string; alt?: string; name: string }[] = [
  { id: 'select', key: '1', name: 'Выбор' },
  { id: 'road', key: '2', name: 'Дорога' },
  { id: 'rail', key: '3', name: 'Ж/д' },
  { id: 'lights', key: '4', name: 'Перекрёсток' },
  { id: 'roundabout', key: '5', name: 'Развязки' },
  { id: 'station', key: '6', name: 'Станция' },
  { id: 'line', key: '7', name: 'Маршрут' },
  { id: 'bulldoze', key: '8', alt: 'B', name: 'Снос' },
  { id: 'terrain', key: '9', name: 'Рельеф' },
];

/** Кисть рельефа: радиус по размеру. */
export const BRUSH_SIZES = { small: 40, medium: 80, large: 150 } as const;
export type BrushSize = keyof typeof BRUSH_SIZES;
const BRUSH_NAMES: Record<TerraformMode, string> = { raise: 'Поднять', lower: 'Опустить', flatten: 'Выровнять' };
/** Пока кнопка зажата, кисть делает мазок раз в столько секунд. */
const BRUSH_PERIOD = 0.12;

/** Что делает клик: инструмент вместе с его режимом. */
export type Action = Exclude<Tool, 'rail'> | 'upgrade' | 'move' | 'signal' | 'template' | 'lane' | 'parallel' | 'copy' | 'paste' | 'trackMove';
/** Дорога: строить, вести полосу вдоль края, перестроить под выбранный тип, двигать узел или выгнуть. */
export type RoadMode = 'build' | 'lane' | 'upgrade' | 'move';
/** Развязки: кольцо на перекрёстке, шаблон развязки (готовый или свой) или копия куска дорог. */
export type JunctionMode = 'ring' | 'template' | 'copy';
/** Ж/д: класть путь, пристроить путь рядом с существующим, ставить вокзал или сигнал, двигать узел или перо пути. */
export type RailMode = 'track' | 'parallel' | 'station' | 'signal' | 'move';
/** Станции: автостанция для грузов, автовокзал для пассажиров, остановка на улице, ж/д станция. */
export type StationMode = 'cargo' | 'pax' | 'stop' | 'rail';

export const DRAW_MODES: { id: DrawMode; name: string }[] = [
  { id: 'straight', name: 'Прямая' },
  { id: 'arc', name: 'Дуга' },
  { id: 'curve', name: 'Кривая' },
];

const PAN_SPEED = 900;

/** Действия, которые строят или сносят, — и как назвать их в «Отменено: …». */
const UNDO_LABELS: Partial<Record<Action, string>> = {
  road: 'дорога',
  lane: 'полоса',
  bulldoze: 'снос',
  upgrade: 'перестройка',
  move: 'перенос дороги',
  trackMove: 'перенос пути',
  signal: 'сигнал',
  roundabout: 'кольцо',
  station: 'станция',
  terrain: 'рельеф',
};

/** «3 дороги, 12 домов, 1 станция» — что снесёт рамка. */
export function areaSummary(c: AreaContents): string {
  const word = (n: number, one: string, few: string, many: string) => {
    const d = n % 10;
    const dd = n % 100;
    return d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
  };
  const parts = [
    c.corridors.length && `${c.corridors.length} ${word(c.corridors.length, 'участок', 'участка', 'участков')} дорог`,
    c.segs.length && `${c.segs.length} ${word(c.segs.length, 'участок', 'участка', 'участков')} путей`,
    c.buildings.length && `${c.buildings.length} ${word(c.buildings.length, 'дом', 'дома', 'домов')}`,
    c.stations.length && `${c.stations.length} ${word(c.stations.length, 'станция', 'станции', 'станций')}`,
  ].filter(Boolean);
  return parts.length ? `Снести: ${parts.join(', ')}` : 'Здесь нечего сносить';
}

/** Изгиб новой дороги медленнее её скорости — сколько км/ч на нём (машины будут тормозить). */
function curveNote(plan: RoadPlan): string {
  if (!plan.net) return '';
  let worst = Infinity;
  for (const id of plan.changed) {
    const c = plan.net.corridors.get(id);
    if (!c || c.ring) continue;
    const v = curveSpeed(minRadius(c.curve));
    if (v < laneSpeed(c) * 0.95) worst = Math.min(worst, v);
  }
  return Number.isFinite(worst) ? ` · ⚠ поворот ${Math.round((worst * KMH_PER_UNIT) / 5) * 5} км/ч` : '';
}

/** Название уровня для подсказки: «земля → мост». */
function levelName(level: number): string {
  return (LEVELS.find((l) => l.level === level)?.name ?? 'земля').toLowerCase();
}

/** Профиль стройки в подсказке: уклон вдоль полотна, насыпь и выемка. */
function profileNote(p?: ProfileSummary): string {
  return p && (Math.max(p.grade, Math.abs(p.slope ?? 0)) >= 0.005 || Math.max(p.cut, p.fill) >= 0.5) ? ` · ${profileText(p)}` : '';
}

export class Controller {
  tool: Tool = 'select';
  roadMode: RoadMode = 'build';
  junctionMode: JunctionMode = 'ring';
  stationMode: StationMode = 'cargo';
  railMode: RailMode = 'track';
  /** Сколько путей класть сразу: один или два рядом. */
  railTracks: 1 | 2 = 1;
  /** Сигнал запрещает встречное движение (как в Transport Fever): навстречу поезд по этому пути не поедет. */
  signalOneWay = false;
  /** Пристроить путь: где зажали на существующем пути. */
  parallelFrom: Vec | null = null;
  /** Двухпутка продолжается: концы обоих путей у точки at (оси). */
  private pairStart: { at: Vec; snaps: [Snap, Snap] } | null = null;
  /** Путь начали рядом с другим (на междупутье): из начала он идёт вдоль соседнего, по оси axis. */
  private besideStart: { pos: Vec; axis: Vec } | null = null;
  /** Параметры нового кольца. */
  ring: RingOptions = { ...DEFAULT_RING };
  /** С чем будет работать новая станция. */
  stationServes: StationServes = { pax: true, cargo: true };
  /** Инструменты дороги на сети полос (строить, полоса, перестроить, двигать, снос). */
  readonly roadTools: RoadTools;
  /** Ж/д «Двигать»: узлы, перья и изгиб путей. */
  readonly railTools: RailTools;
  /** «Проект» в инструментах «Дорога» и «Ж/д»: рисуем, правим узлы и перья, строим разом. */
  readonly projectTools: ProjectTools;
  /**
   * Правки построенных дорог в проекте дорог — «Двигать» (перенос), «Полоса» (полосы, съезды: дома отодвигаются) и
   * протяжки построенных дорог в «Строить»: один проект с новыми участками, строится разом.
   */
  readonly moveProject: MoveProject;
  /** Прямая пути прилипла к продолжению или перпендикуляру — подпись у курсора. */
  private angleHint: string | null = null;
  /** Конец пути прилип рядом с другим путём: дуга приходит по этому направлению (параллельно ему). */
  private parallelEnd: Vec | null = null;
  /** Где конец прилип рядом с другим путём: начат рядом с тем же — новый путь идёт вдоль него по всей длине. */
  private besideEnd: Beside | null = null;
  /** Камера следует за выбранной машиной или поездом (переключается F). */
  following = false;
  /** Линия, в маршрут которой добавляем станции кликами по карте. */
  addStopTo: number | null = null;
  /** Поворот ж/д станции в чистом поле (R). */
  stationAngle = 0;
  /** Сколько путей с платформами у новой ж/д станции. */
  stationTracks = 2;
  /** Длина её платформ, м: чем длиннее, тем больше вагонов у поезда. */
  stationLength = RAIL_STATION.platform;
  /** Конечная (тупиковая) вместо проходной: пути кончаются упорами, поезда разворачиваются. */
  stationTerminal = false;
  /** Шаблон развязки и поворот магистрали, если она строится вместе с развязкой (R). */
  templateKind: TemplateKind = 'diamond';
  templateAngle = 0;
  /** Свой шаблон, выбранный вместо готового (id). */
  userTemplate: string | null = null;
  /** Скопированный кусок дорог: есть — клик его вставляет. */
  clipboard: Fragment | null = null;
  /** Угол рамки копирования, пока тянем. */
  copyStart: Vec | null = null;
  /** Поворот вставки (R, протяжка). */
  pasteAngle = 0;
  /** Вставка, которую поворачивают протяжкой: центр — где зажали. */
  private pasteDrag: { at: Vec } | null = null;
  private copyCache: { key: string; frag: Fragment | null } | null = null;
  private pasteCache: { frag: Fragment; key: string; plan: PastePlan } | null = null;
  /** Снос: по одному объекту (можно вести мышью), рамкой или пристроенную полосу. */
  bulldozeMode: 'point' | 'area' | 'lane' = 'point';
  /** Кисть рельефа: что делает и какого размера. */
  terrainMode: TerraformMode = 'raise';
  brushSize: BrushSize = 'medium';
  /** Высота, к которой выравниваем (где нажали), и время до следующего мазка. */
  private brushTarget: number | null = null;
  private brushTimer = 0;
  /** Угол рамки сноса, пока тянем. */
  areaStart: Vec | null = null;
  /** Снос куска (Shift): с какого полотна и полосы (null — всё полотно) и с какого места оси. */
  private spanStart: { corridor: number; lane: number | null; s: number } | null = null;
  /** Рамка, которая ждёт подтверждения игрока (сносится много). */
  pendingArea: { a: Vec; b: Vec; contents: AreaContents } | null = null;
  presetId = DEFAULT_PRESET_ID;
  spec: RoadSpec = { ...defaultPreset().spec };
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
  /** Станция, которую игрок переносит: силуэт прилипает к дорогам, как при постройке. */
  movingStation: number | null = null;
  /** Ставим склад-здание этой станции: клик в зоне вокруг неё — склад (Esc — отмена). */
  placingWarehouse: number | null = null;
  /** Ставим пристройку этого предприятия: клик в зоне вокруг него — пристройка (Esc — отмена). */
  placingAnnex: number | null = null;
  /** Настройка полос выбранного перекрёстка: полоса въезда, которую сейчас соединяем. */
  laneFrom: { seg: number; i: number } | null = null;
  /** Правка фазы светофора на карте: перекрёсток и номер фазы (выбрана в карточке); клик по проезду — его зелёный в ней. */
  phaseEdit: { node: number; i: number } | null = null;
  /** Отказ дать зелёный: проезд и зелёные, которые он пересёк бы, мигают красным на карте и в карточке до until. */
  phaseFlash: { node: number; i: number; turns: string[]; until: number } | null = null;
  /** Курсор на варианте главной дороги в карточке перекрёстка — карта показывает этот вариант. */
  mainHover: { node: number; mainPair: number[] | null } | null = null;
  heatmap = false;
  speedmap = false;
  /** Точка маршрута под курсором на графике скорости в карточке линии — карта показывает её. */
  chartPoint: { pos: Vec; color: string; kmh: number } | null = null;
  /** Машина компании под курсором в списке открытого маршрута — карта подсвечивает её. */
  fleetHover: number | null = null;
  /** Станцию выбрали кликом по значку предупреждения: до until её блок предупреждений в карточке подсвечен. */
  warnFocus: { station: number; until: number } | null = null;
  hover: Vec | null = null;
  /** Знак скорости (км/ч), который тянут из панели на дорогу. */
  dragLimit: number | null = null;
  onChange: () => void = () => {};
  private mouse = { x: 0, y: 0 };
  private shift = false;
  /** Зажат Alt (Option): прямая не прилипает к «прямо» и 90°. */
  private alt = false;
  /** Зажат Cmd (macOS) или Ctrl: прямая тоже не прилипает — идёт ровно за курсором. */
  private ctrl = false;
  private pan: { sx: number; sy: number; cx: number; cy: number; moved: boolean } | null = null;
  private left: { sx: number; sy: number; createdChain: boolean } | null = null;
  private keys = new Set<string>();
  private flash: { text: string; until: number } | null = null;
  /** В проекте строительства дорог тянут построенную дорогу (узел, перо, середину) — правкой проекта. */
  private builtDrag = false;
  private lastSpeed = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly camera: Camera,
    private readonly game: () => Game,
  ) {
    this.roadTools = new RoadTools(game);
    this.railTools = new RailTools(game);
    // Проект дорог — один: новые участки (projectTools) и правки построенных дорог (moveProject) строятся вместе.
    const shared = sharedRoadProject(game);
    this.projectTools = shared.tools;
    this.moveProject = shared.edits;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => this.onDown(e));
    window.addEventListener('mousemove', (e) => this.onMove(e));
    window.addEventListener('mouseup', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('mouseleave', () => (this.hover = null));
    // Знак скорости, который тянут из панели: над дорогой — предпросмотр, отпустили — ограничение на ней.
    canvas.addEventListener('dragover', (e) => {
      if (this.dragLimit === null) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = dropEffectFor(e.dataTransfer.effectAllowed);
      // Cmd / Ctrl — знак только на участок под курсором (клавиши во время перетаскивания приходят только с ним).
      this.ctrl = e.ctrlKey || e.metaKey;
      this.hover = this.worldAt(e);
      this.onChange();
    });
    canvas.addEventListener('dragleave', () => {
      if (this.dragLimit !== null) this.hover = null;
    });
    canvas.addEventListener('drop', (e) => {
      if (this.dragLimit === null) return;
      e.preventDefault();
      const g = this.game();
      const only = e.ctrlKey || e.metaKey;
      // Одна отмена (Ctrl+Z) — вся улица или один участок, как отпустили.
      g.checkpoint(only ? 'скорость участка' : 'скорость дороги');
      const problem = this.roadTools.setLimitAt(this.worldAt(e), this.dragLimit, this.snapRadius * 0.3, only);
      g.commit();
      if (problem) this.showError(problem);
      this.endLimitDrag();
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.key === 'Shift') this.shift = false;
      if (e.key === 'Alt') this.alt = false;
      if (e.key === 'Control' || e.key === 'Meta') this.ctrl = false;
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.shift = false;
      this.alt = false;
      this.ctrl = false;
    });
  }

  private get snapRadius(): number {
    return SNAP_PIXELS / this.camera.zoom;
  }

  /** Конец прямой — ровно за курсором, без прилипания к «прямо», 90° и пути рядом: зажат Alt (Option) или Cmd / Ctrl. */
  private get freeAim(): boolean {
    return this.alt || this.ctrl;
  }

  // ---------- Настройки ----------

  setTool(tool: Tool): void {
    this.placingWarehouse = null;
    this.placingAnnex = null;
    if (this.tool === 'line' && tool !== 'line') this.lineDraft = [];
    if (tool !== 'line') this.addStopTo = null;
    // Новая линия собирается с чистого листа: прежняя выбранная линия и объект не мешают.
    if (tool === 'line' && this.tool !== 'line') {
      this.selectedLine = null;
      this.selection = null;
    }
    this.projectTools.stop(this.netKind);
    this.tool = tool;
    this.chain = null;
    this.control = null;
    this.moving = null;
    this.movingStation = null;
    this.roadTools.clear();
    this.railTools.clear();
    this.laneFrom = null;
    this.phaseEdit = null;
    this.onChange();
  }

  /** Начать перенос здания: оно следует за курсором до клика. */
  startMove(b: TownBuilding): void {
    this.setTool('select');
    this.moving = b;
    this.onChange();
  }

  /** Начать перенос станции: её силуэт следует за курсором и прилипает к дорогам до клика. */
  startStationMove(id: number): void {
    this.setTool('select');
    this.movingStation = id;
    this.onChange();
  }

  /** Что делает клик с учётом режима инструмента. */
  get action(): Action {
    if (this.tool === 'road') return this.roadMode === 'build' ? 'road' : this.roadMode;
    if (this.tool === 'roundabout') {
      if (this.junctionMode === 'copy') return this.clipboard ? 'paste' : 'copy';
      if (this.junctionMode === 'template') return this.userTemplate && getTemplate(this.userTemplate) ? 'paste' : 'template';
      return 'roundabout';
    }
    if (this.tool === 'rail') {
      if (this.railMode === 'move') return 'trackMove';
      return this.railMode === 'station' ? 'station' : this.railMode === 'signal' ? 'signal' : this.railMode === 'parallel' ? 'parallel' : 'road';
    }
    return this.tool;
  }

  /** Что прокладываем: автодорогу или ж/д путь. */
  get netKind(): NetKind {
    return this.tool === 'rail' ? 'rail' : 'road';
  }

  /** Что ставим: автостанцию (грузовую или автовокзал), остановку или ж/д станцию. */
  get stationKind(): StationKind {
    if (this.tool === 'rail' || this.stationMode === 'rail') return 'rail';
    return this.stationMode === 'stop' ? 'stop' : 'road';
  }

  /** С чем будет работать новая станция: автостанция — грузы, автовокзал — пассажиры, ж/д — как выбрано. */
  get newStationServes(): StationServes {
    if (this.tool === 'station' && this.stationMode === 'cargo') return { pax: false, cargo: true };
    if (this.tool === 'station' && this.stationMode === 'pax') return { pax: true, cargo: false };
    return this.stationServes;
  }

  /** Инструмент «Станция»: автостанция для грузов, автовокзал, остановка на улице или ж/д станция. */
  setStationMode(mode: StationMode): void {
    if (this.tool !== 'station') this.setTool('station');
    this.stationMode = mode;
    this.onChange();
  }

  setRoadMode(mode: RoadMode): void {
    if (this.tool !== 'road') this.setTool('road');
    this.projectTools.stop('road');
    this.roadMode = mode;
    this.chain = null;
    this.control = null;
    this.roadTools.clear();
    this.onChange();
  }

  setJunctionMode(mode: JunctionMode): void {
    if (this.tool !== 'roundabout') this.setTool('roundabout');
    this.junctionMode = mode;
    this.copyStart = null;
    this.pasteDrag = null;
    this.onChange();
  }

  // ---------- Копия и свои шаблоны ----------

  /** Что вставит клик: скопированный кусок или свой шаблон. */
  pasteSource(): Fragment | null {
    if (this.tool !== 'roundabout') return null;
    if (this.junctionMode === 'copy') return this.clipboard;
    if (this.junctionMode === 'template' && this.userTemplate) return getTemplate(this.userTemplate)?.fragment ?? null;
    return null;
  }

  /** Забыть скопированное — следующая рамка копирует заново. */
  clearClipboard(): void {
    this.clipboard = null;
    this.pasteCache = null;
    this.onChange();
  }

  /** Шаг назад во вставке: забыть скопированное или снять свой шаблон. false — нечего отменять. */
  private cancelPaste(): boolean {
    if (this.action !== 'paste') return false;
    if (this.junctionMode === 'copy') this.clipboard = null;
    else this.userTemplate = null;
    this.pasteCache = null;
    return true;
  }

  rotatePaste(step: number): void {
    this.pasteAngle += step * (Math.PI / 12);
    this.onChange();
  }

  setUserTemplate(id: string | null): void {
    if (this.tool !== 'roundabout') this.setTool('roundabout');
    this.junctionMode = 'template';
    this.userTemplate = id;
    this.pasteAngle = 0;
    this.onChange();
  }

  /** Скопированное — своим шаблоном. false — не хватило места. */
  saveClipboard(name: string): boolean {
    if (!this.clipboard) return false;
    const t = saveTemplate(name, this.clipboard);
    this.onChange();
    return !!t;
  }

  removeUserTemplate(id: string): void {
    deleteTemplate(id);
    if (this.userTemplate === id) this.userTemplate = null;
    this.onChange();
  }

  /** Копия дорог и путей в рамке a–b (повтор при неподвижной мыши — из кэша). */
  private copyPreview(a: Vec, b: Vec): Fragment | null {
    const g = this.game();
    const key = `${a.x},${a.y},${b.x},${b.y},${g.roads.net.version},${g.net.version}`;
    if (this.copyCache?.key !== key) this.copyCache = { key, frag: g.copyArea(a, b) };
    return this.copyCache.frag;
  }

  private copy(a: Vec, b: Vec): void {
    const frag = this.copyPreview(a, b);
    if (!frag) {
      this.showError('В рамке нет дорог и путей');
      return;
    }
    this.clipboard = frag;
    this.pasteAngle = 0;
  }

  /** Центр и поворот вставки без прилипания: протяжка от места, где зажали, задаёт поворот. */
  private pasteRaw(p: Vec): { at: Vec; angle: number } {
    const d = this.pasteDrag;
    if (d && dist(p, d.at) * this.camera.zoom > 8) return { at: d.at, angle: angleOf(sub(p, d.at)) };
    return { at: d?.at ?? p, angle: this.pasteAngle };
  }

  /**
   * Где встанет вставка: на дороге того же класса, что главная дорога куска, — вдоль неё, на пути — вдоль
   * пути (сквозного пути куска); подходят оба — куда ближе (Alt — без прилипания).
   */
  private pastePose(frag: Fragment, p: Vec): { at: Vec; angle: number; snapped: boolean; on?: 'road' | 'rail' } {
    const raw = this.pasteRaw(p);
    if (this.alt) return { ...raw, snapped: false };
    const g = this.game();
    const r = Math.max(20, this.snapRadius * 1.5);
    const road = { ...snapPaste(g.roads.net, frag, raw.at, raw.angle, r), on: 'road' as const };
    const rail = frag.rail?.segs.length ? snapRails(g.net, frag, raw.at, raw.angle, r) : null;
    if (!rail?.snapped) return road;
    return road.snapped && dist(road.at, raw.at) <= dist(rail.at, raw.at) ? road : { ...rail, on: 'rail' };
  }

  private pastePlan(frag: Fragment, at: Vec, angle: number): PastePlan {
    const g = this.game();
    const key = `${at.x},${at.y},${angle},${g.roads.net.version},${g.net.version},${g.budget}`;
    if (this.pasteCache?.frag !== frag || this.pasteCache.key !== key) this.pasteCache = { frag, key, plan: g.pastePlan(frag, at, angle) };
    return this.pasteCache.plan;
  }

  /** Переключает пассажиров или груз у новой станции; хотя бы одно остаётся включённым. */
  toggleStationServe(what: keyof StationServes): void {
    const next = { ...this.stationServes, [what]: !this.stationServes[what] };
    if (next.pax || next.cargo) this.stationServes = next;
    this.onChange();
  }

  setStationTracks(n: number): void {
    this.stationTracks = Math.max(RAIL_STATION.minTracks, Math.min(RAIL_STATION.maxTracks, n));
    this.onChange();
  }

  /** Длина платформ новой ж/д станции, м — шагом RAIL_STATION.lengthStep в допустимых границах. */
  setStationLength(m: number): void {
    const R = RAIL_STATION;
    this.stationLength = Math.max(R.minLength, Math.min(R.maxLength, Math.round(m / R.lengthStep) * R.lengthStep));
    this.onChange();
  }

  /** Новая ж/д станция — проходная или конечная (тупиковая). */
  setStationTerminal(on: boolean): void {
    this.stationTerminal = on;
    this.onChange();
  }

  setTemplate(kind: TemplateKind): void {
    this.templateKind = kind;
    this.userTemplate = null;
    this.onChange();
  }

  setBulldozeMode(mode: 'point' | 'area' | 'lane'): void {
    this.bulldozeMode = mode;
    this.areaStart = null;
    this.onChange();
  }
  setTerrainMode(mode: TerraformMode): void {
    this.terrainMode = mode;
    if (this.tool !== 'terrain') this.setTool('terrain');
    this.onChange();
  }

  setBrushSize(size: BrushSize): void {
    this.brushSize = size;
    this.onChange();
  }

  /** Мазок кисти рельефа; первый (по клику) сообщает, почему нельзя. */
  private brushStroke(p: Vec, first: boolean): void {
    const g = this.game();
    const r = BRUSH_SIZES[this.brushSize];
    const target = this.brushTarget ?? undefined;
    const plan = g.terraformPlan(p, this.terrainMode, r, target);
    if (plan.ok) g.terraform(p, this.terrainMode, r, target);
    else if (first) this.showError(plan.reason);
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
    const total = contents.segs.length + contents.corridors.length + contents.buildings.length + contents.stations.length;
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
    this.projectTools.stop('rail');
    this.railMode = mode;
    this.chain = null;
    this.control = null;
    this.parallelFrom = null;
    this.railTools.clear();
    this.onChange();
  }

  /** Тип нового сигнала: обычный (блок в обе стороны) или запрещающий встречное движение. */
  setSignalOneWay(on: boolean): void {
    this.signalOneWay = on;
    this.onChange();
  }

  setRailTracks(n: number): void {
    this.railTracks = n >= 2 ? 2 : 1;
    this.chain = null;
    this.control = null;
    this.onChange();
  }

  /** Два пути сразу: ось — как обычно, пути — по обе стороны от неё на половине TRACK_GAP. */
  private pairRequests(end: Snap): RoadRequest[] | null {
    const g = this.game();
    if (!this.chain) return null;
    const center = g.builder.buildCurve(this.request(end));
    if (!center) return null;
    const node = (p: Vec, level: number): Snap => {
      const s = g.builder.snap(p, level, 4);
      return s.kind === 'node' ? s : { kind: 'free', pos: p, level };
    };
    // Продолжение двухпутки — от концов её путей; иначе — от узлов, если они ровно там.
    const cont = this.pairStart && dist(this.pairStart.at, this.chain.pos) < 0.5 ? this.pairStart.snaps : null;
    return [-1, 1].map((k, i) => {
      const curve = offsetCubic(center, (k * TRACK_GAP) / 2);
      const start = cont?.[i] ?? node(curve.p0, this.chain!.level);
      const stop = node(curve.p3, end.level);
      return { start, end: stop, spec: RAIL_SPEC, mode: 'straight' as const, curve: { ...curve, p0: start.pos, p3: stop.pos } };
    });
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

  /** Высота дороги или пути: тоннель, земля или мост — дорога тогда весь путь на этом уровне («Авто» выключен). */
  setLevel(level: number): void {
    this.level = Math.max(-1, Math.min(1, level));
    this.roadTools.level = this.level;
    this.roadTools.auto = false;
    this.roadTools.rise = null;
    this.onChange();
  }

  /** «Авто»: дорога на земле, а мост или тоннель — сам, где без них не выйдет. */
  setAutoLevel(): void {
    this.level = 0;
    this.roadTools.level = 0;
    this.roadTools.auto = true;
    this.onChange();
  }

  get autoLevel(): boolean {
    return this.netKind === 'road' && this.roadTools.auto;
  }

  // ---------- Проект ----------

  /** Режим, где можно рисовать проект: «Дорога → Строить» или «Ж/д → Путь». */
  get projectAllowed(): boolean {
    return (this.tool === 'road' && this.roadMode === 'build') || (this.tool === 'rail' && this.railMode === 'track');
  }

  /** Клики рисуют проект, а не строят. */
  get projectMode(): boolean {
    return this.projectAllowed && this.projectTools.on[this.netKind];
  }

  /** «Дорога → Двигать» с «Проектом»: протяжки копятся проектом перемещения, дорога пока не меняется. */
  get moveProjectMode(): boolean {
    return this.tool === 'road' && this.roadMode === 'move' && this.projectTools.on.road;
  }

  /** «Дорога → Полоса» с «Проектом»: полосы, съезды и въезды копятся проектом, дорога пока не меняется. */
  get laneProjectMode(): boolean {
    return this.tool === 'road' && this.roadMode === 'lane' && this.projectTools.on.road;
  }

  /**
   * Правки построенных дорог общего проекта дорог, если их сейчас и рисуют («Двигать», «Полоса»); null — другой
   * инструмент или «Проект» выключен.
   */
  get editProject(): MoveProject | null {
    return this.moveProjectMode || this.laneProjectMode ? this.moveProject : null;
  }

  /** «Проект» включён в том, что сейчас выбрано (стройка, путь, перенос дороги или полоса). */
  get projectOn(): boolean {
    return this.projectMode || this.moveProjectMode || this.laneProjectMode;
  }

  /**
   * «Дорога → Перестроить» при включённом «Проекте»: перестройка в проект не входит (строится сразу), а проект
   * дорог хранится как есть — вернётся в «Строить», «Двигать» и «Полосе».
   */
  get projectKept(): boolean {
    return this.tool === 'road' && this.roadMode === 'upgrade' && this.projectTools.on.road;
  }

  /** Какой проект правят сейчас: дорог (в любом режиме «Дороги» с «Проектом») или путей; null — «Проект» выключен. */
  private get projectKind(): NetKind | null {
    return this.projectMode ? this.netKind : this.editProject ? 'road' : null;
  }

  /** «Проект» вкл/выкл (P): нарисованное остаётся, пока его не построят или не отменят. */
  toggleProject(): void {
    // «Перестроить» проект не правит, но хранит: P — назад к нему, в «Строить» (он остаётся включённым).
    if (this.projectKept) {
      this.setRoadMode('build');
      return;
    }
    const move = this.tool === 'road' && (this.roadMode === 'move' || this.roadMode === 'lane');
    if (!this.projectAllowed && !move) {
      if (this.tool === 'rail') this.setRailMode('track');
      else this.setRoadMode('build');
    }
    const kind = this.netKind;
    const g = this.game();
    const rt = this.roadTools;
    const turningOn = !this.projectTools.on[kind];
    const drawing = this.projectAllowed;
    // Что начато: обычная прокладка (начало и точка изгиба) или ветка проекта — переходит в другой режим.
    const begun = kind === 'road' ? rt.start && { pos: rt.start.pos, level: rt.startLevel ?? 0, attach: rt.start.kind !== 'free', control: rt.control } : this.chain && { pos: this.chain.pos, level: this.chain.level, attach: this.chain.kind !== 'free', control: this.control };
    const tip = drawing && !turningOn ? this.projectTools.tipPos(kind) : null;
    const tipControl = this.projectTools.control;
    this.projectTools.stop(kind);
    this.projectTools.on[kind] = turningOn;
    this.chain = null;
    this.control = null;
    rt.clear();
    if (drawing && turningOn && begun) {
      // Начатая дорога (путь) — первым узлом проекта: протяжка к курсору — уже участок проекта.
      this.projectTools.adopt(kind, begun.pos, begun.level, begun.attach, begun.control);
    } else if (drawing && tip) {
      // Выключили «Проект» посреди ветки: проект остаётся (вернётся с «Проектом»), обычная стройка — от того же места.
      if (kind === 'road') {
        rt.start = anchorAt(g.roads.net, tip.pos, 3, tip.level);
        rt.control = tipControl;
      } else {
        this.chain = g.builder.snap(tip.pos, tip.level, 3);
        this.chainTangent = g.builder.continuationTangent(this.chain);
        this.control = tipControl;
      }
    }
    this.syncMoveBase();
    this.onChange();
  }

  /**
   * Общий проект дорог: построенные дороги — с его правками (их тянут, к ним примыкают; иначе — настоящая сеть),
   * полосы — правками в тот же проект, а не стройкой.
   */
  private syncMoveBase(): void {
    this.roadTools.base = this.projectKind === 'road' ? this.moveProject.net() : null;
    const lanes = this.laneProjectMode;
    this.roadTools.lanePrefix = lanes ? this.moveProject.edits : [];
    // Полоса расширяет дорогу: дома у неё не сносим, а отодвигаем после стройки.
    this.roadTools.laneSink = lanes ? (edit) => this.projectTools.addEdit(edit, true) : null;
  }

  /** Как рисуем сейчас: что, какой формы и на какой высоте. */
  private drawSettings(): DrawSettings {
    const road = this.netKind === 'road';
    return {
      kind: this.netKind,
      spec: this.buildSpec,
      mode: this.drawMode,
      level: road && this.roadTools.auto ? 0 : this.level,
      auto: this.autoLevel,
      reverse: road && this.roadTools.reverse && isOneWay(this.spec),
    };
  }

  /** «Построить»: весь проект разом (Ctrl+Z отменит). */
  buildProject(): void {
    const kind = this.projectKind;
    if (!kind) return;
    // Проект дорог общий: в любом режиме «Дороги» — новые участки и правки построенных дорог, одним шагом Ctrl+Z.
    const problem = this.projectTools.build(kind);
    if (problem) this.showError(problem);
    else this.game().notify(kind === 'rail' ? 'Проект пути построен' : 'Проект дорог построен');
    this.roadTools.clear();
    this.syncMoveBase();
    this.onChange();
  }

  /** «Отменить проект»: и новые участки, и правки построенных дорог — прочь (Ctrl+Z в проекте вернёт). */
  discardProject(): void {
    const kind = this.projectKind ?? (this.projectKept ? 'road' : null);
    if (!kind) return;
    this.projectTools.discard(kind);
    this.roadTools.clear();
    this.syncMoveBase();
    this.onChange();
  }

  /** Проект дорог или путей: сколько участков и правок построенных дорог и что выйдет — для панели. */
  projectSummary(kind: NetKind = this.netKind): { segs: number; edits: number; plan: ReturnType<ProjectTools['plan']> } {
    return { segs: this.projectTools.project(kind).segs.length, edits: this.projectTools.edits(kind).length, plan: this.projectTools.plan(kind) };
  }

  /** −/+: конец строящейся дороги на 2 м выше или ниже начала (включает «Авто»); у путей — уровень. */
  stepRise(d: number): void {
    if (this.netKind === 'rail') {
      this.setLevel(this.level + d);
      return;
    }
    const rt = this.roadTools;
    if (!rt.auto) this.setAutoLevel();
    rt.rise = Math.max(-40, Math.min(40, (rt.rise ?? 0) + d * GRADE.riseStep));
    this.onChange();
  }

  /**
   * Скорость игры. В испытании сценария время не останавливается: паузу ставят только меню и окна (force),
   * а пробел и кнопка паузы лишь напоминают об этом.
   */
  setSpeed(speed: number, force = false): void {
    const g = this.game();
    if (speed === 0 && !force && g.scenario?.challenge) {
      const text = 'Испытание: время не останавливается — пауза только в меню';
      if (!g.notices.some((n) => n.text === text)) g.notify(text, '#c4662f');
      return;
    }
    if (speed > 0) this.lastSpeed = speed;
    // В журнал — только перемены: пауза в меню (force) тоже видна, чтобы было понятно, сколько думали.
    if (g.speed !== speed) g.journal.add('speed', { v: speed, menu: force || undefined });
    g.speed = speed;
    this.onChange();
  }

  togglePause(): void {
    this.setSpeed(this.game().speed === 0 ? this.lastSpeed : 0);
  }

  toggleHeatmap(): void {
    this.heatmap = !this.heatmap;
    if (this.heatmap) this.speedmap = false;
    this.onChange();
  }

  /** Карта скоростей: какая скорость разрешена на каждой дороге (и где её снижает поворот). */
  toggleSpeedmap(): void {
    this.speedmap = !this.speedmap;
    if (this.speedmap) this.heatmap = false;
    this.onChange();
  }

  /** Знак скорости отпустили (на дороге или мимо) — предпросмотр убираем. */
  endLimitDrag(): void {
    this.dragLimit = null;
    this.onChange();
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    // Выбрали станцию, предприятие, машину — панель переключается на них, открытый маршрут закрывается.
    if (sel) this.selectedLine = null;
    this.following = false;
    this.laneFrom = null;
    // Выбрали другое — правка фазы закончена.
    if (sel?.type !== 'junction' || sel.id !== this.phaseEdit?.node) this.phaseEdit = null;
    this.mainHover = null;
    this.fleetHover = null;
    // Выбрали что-то другое — склад этой станции больше не ставим.
    if (sel?.type !== 'station' || sel.id !== this.placingWarehouse) this.placingWarehouse = null;
    if (sel?.type !== 'industry' || sel.id !== this.placingAnnex) this.placingAnnex = null;
    this.onChange();
  }

  /** Режим «поставить пристройку» предприятия id: зона вокруг него — на карте, клик в ней ставит пристройку. */
  startAnnex(id: number): void {
    this.setTool('select');
    this.select({ type: 'industry', id });
    this.placingAnnex = id;
    this.onChange();
  }

  /** Режим «поставить склад» станции id: зона вокруг неё — на карте, клик в ней ставит здание склада. */
  startWarehouse(id: number): void {
    this.setTool('select');
    this.select({ type: 'station', id });
    this.placingWarehouse = id;
    this.onChange();
  }

  /**
   * Esc или правая кнопка: шаг назад — отменить начатое, потом закрыть инструмент, потом снять выбор.
   * step — у черновика маршрута убрать последнюю станцию, а не весь (правая кнопка).
   */
  back(step = false): void {
    if (this.pendingArea) this.cancelArea();
    else if (this.areaStart) this.areaStart = null;
    else if (this.spanStart) this.spanStart = null;
    else if (this.moving) this.moving = null;
    else if (this.movingStation !== null) this.movingStation = null;
    else if (this.placingWarehouse !== null) this.placingWarehouse = null;
    else if (this.placingAnnex !== null) this.placingAnnex = null;
    else if (this.phaseEdit) this.phaseEdit = null;
    else if (this.copyStart) this.copyStart = null;
    else if (this.pasteDrag) this.pasteDrag = null;
    else if (this.cancelPaste()) {
      // Вставка отменена: снова рамка или готовые шаблоны.
    } else if (this.projectMode && this.projectTools.cancel(this.netKind)) {
      // Проект: бросили протяжку, точку изгиба или закончили ветку — нарисованное остаётся.
    } else if (this.roadTools.cancel()) {
      // Шаг назад в постройке дороги.
    } else if (this.railTools.cancel()) {
      // Бросили узел, перо или середину пути.
    } else if (this.addStopTo !== null) this.stopAddStop();
    else if (this.control) this.control = null;
    else if (this.chain) this.chain = null;
    else if (this.lineDraft.length) {
      if (step) this.lineDraft.pop();
      else this.cancelLine();
    } else if (this.laneFrom) this.clearLane();
    else if (this.tool !== 'select') this.setTool('select');
    else {
      this.select(null);
      this.selectLine(null);
    }
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
    this.projectTools.reset();
    this.moveProject.clear();
    this.roadTools.base = null;
  }

  update(dt: number): void {
    if (this.left && this.tool === 'terrain' && this.hover) {
      this.brushTimer += dt;
      if (this.brushTimer >= BRUSH_PERIOD) {
        this.brushTimer = 0;
        this.brushStroke(this.hover, false);
      }
    }
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
      // На дороге или на заезде к посту станции.
      const sim = g.fleetLook(v);
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
    this.roadTools.clear();
    this.railTools.clear();
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
    this.besideEnd = null;
    if (this.shift && this.chain && this.drawMode === 'straight') {
      const d = sub(p, this.chain.pos);
      const t0 = this.startTangent(p);
      const base = t0 ? angleOf(t0) : 0;
      const step = Math.PI / 12;
      const a = base + Math.round((angleOf(d) - base) / step) * step;
      const l = Math.max(10, Math.round(len(d) / 10) * 10);
      const snapped = add(this.chain.pos, scale({ x: Math.cos(a), y: Math.sin(a) }, l));
      const s = g.builder.snap(snapped, this.level, this.snapRadius * 0.5);
      return s.kind === 'node' ? s : { kind: 'free', pos: snapped, level: this.level };
    }
    const s = g.builder.snap(p, this.level, this.snapRadius);
    this.angleHint = null;
    this.parallelEnd = null;
    // Рядом с другим путём на межпутье — конец прилипает к линии рядом с ним (с Alt или Cmd / Ctrl — нет).
    if (s.kind === 'free' && this.chain && !this.freeAim && this.netKind === 'rail' && this.railTracks === 1) {
      const par = this.parallelSnap(p);
      if (par) {
        this.angleHint = 'рядом с путём';
        if (this.drawMode === 'arc') this.parallelEnd = par.dir;
        this.besideEnd = par.beside;
        return { kind: 'free', pos: par.pos, level: this.level };
      }
    }
    // Прямая от существующей дороги сама прилипает к её продолжению (180°) или перпендикуляру (90°); с Alt или Cmd / Ctrl — нет.
    if (s.kind === 'free' && this.chain && this.drawMode === 'straight' && !this.freeAim) {
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

  /**
   * Двухпутка от пары тупиков у курсора (на межпутье друг от друга, смотрят в одну сторону): ось —
   * посередине, новые пути продолжают оба. Нет такой пары — null.
   */
  private pairFromEnds(p: Vec): { at: Vec; snaps: [Snap, Snap]; tangent: Vec } | null {
    const net = this.game().net;
    const ends = net.nodesNear(p, this.snapRadius + TRACK_GAP).filter((n) => n.segments.length === 1 && n.buildingId === null);
    let best: { a: RoadNode; b: RoadNode; mid: Vec; t: Vec } | null = null;
    let bestD = this.snapRadius + TRACK_GAP / 2;
    for (const a of ends) {
      for (const b of ends) {
        if (a.id >= b.id || Math.abs(dist(a.pos, b.pos) - TRACK_GAP) > 2.5 || a.level !== b.level) continue;
        const ta = scale(net.dirFrom(a.id, a.segments[0]), -1);
        const tb = scale(net.dirFrom(b.id, b.segments[0]), -1);
        if (dot(ta, tb) < 0.97) continue;
        const mid = scale(add(a.pos, b.pos), 0.5);
        if (dist(mid, p) < bestD) {
          bestD = dist(mid, p);
          best = { a, b, mid, t: norm(add(ta, tb)) };
        }
      }
    }
    if (!best) return null;
    // Путь слева от оси (по ходу) — первый: так их кладёт pairRequests.
    const leftFirst = dot(sub(best.a.pos, best.mid), rightNormal(best.t)) < 0;
    const [l, r] = leftFirst ? [best.a, best.b] : [best.b, best.a];
    const snap = (n: RoadNode): Snap => ({ kind: 'node', nodeId: n.id, pos: n.pos, level: n.level });
    return { at: best.mid, snaps: [snap(l), snap(r)], tangent: best.t };
  }

  /**
   * Конец пути у соседнего пути на межпутье — ложится на линию рядом с ним (у тупика — ровно напротив)
   * и приходит параллельно (путь рядом).
   */
  private parallelSnap(p: Vec): { pos: Vec; dir: Vec; beside: Beside } | null {
    if (!this.chain) return null;
    const best = besideTrack(this.game().net, p, this.level, Math.max(3, this.snapRadius * 0.6));
    if (!best) return null;
    return { pos: best.pos, dir: dot(best.axis, sub(best.pos, this.chain.pos)) >= 0 ? best.axis : scale(best.axis, -1), beside: best };
  }

  /**
   * Начали и кончили рядом с одним путём, с одной стороны — второй путь идёт вдоль него на междупутье по
   * всей длине (копия соседнего пути сбоку, по кускам), а не своей кривой между концами. Иначе — null.
   */
  private besideRequests(end: Snap): RoadRequest[] | null {
    const c = this.chain;
    const b = this.besideEnd;
    if (!c || !b || end.kind !== 'free' || dist(end.pos, b.pos) > 0.5) return null;
    if (this.netKind !== 'rail' || this.railTracks !== 1 || this.drawMode === 'curve' || c.kind === 'split') return null;
    if (Math.abs(c.level - this.level) > 0.25) return null;
    // Из начала рядом с путём — в любую сторону вдоль него; из конца пути — если он уже идёт вдоль.
    const fromBeside = c.kind === 'free' && this.besideStart !== null && dist(this.besideStart.pos, c.pos) < 0.5;
    if (!fromBeside && !this.chainTangent) return null;
    const pieces = besideRun(this.game().net, c.pos, b, this.level, fromBeside ? null : this.chainTangent);
    if (!pieces) return null;
    const free = (pos: Vec): Snap => ({ kind: 'free', pos, level: this.level });
    return pieces.map((curve, i) => ({
      start: i === 0 ? c : free(curve.p0),
      end: i === pieces.length - 1 ? end : free(curve.p3),
      spec: this.buildSpec,
      mode: 'straight',
      curve,
    }));
  }

  /**
   * Начало одиночного пути: узел или путь под курсором, а сбоку от пути на междупутье — место рядом с ним
   * (у тупика — ровно напротив): второй путь пойдёт вдоль первого. С Alt — без прилипания рядом.
   */
  private startSnap(p: Vec): { snap: Snap; beside: Beside | null } {
    const g = this.game();
    const snap = g.builder.snap(p, this.level, this.snapRadius);
    if (this.alt || this.netKind !== 'rail' || this.railTracks !== 1) return { snap, beside: null };
    const beside = besideTrack(g.net, p, this.level, Math.max(3, this.snapRadius * 0.6));
    // Узел или путь прямо под курсором ближе — к ним и прилипаем.
    if (!beside || (snap.kind !== 'free' && dist(p, snap.pos) <= dist(p, beside.pos))) return { snap, beside: null };
    return { snap: { kind: 'free', pos: beside.pos, level: this.level }, beside };
  }

  /** Касательная в начале пути к точке to: у начала рядом с другим путём — вдоль него, в сторону to. */
  private startTangent(to: Vec): Vec | null {
    const b = this.railTracks === 1 ? this.besideStart : null;
    if (b && this.chain?.kind === 'free' && dist(b.pos, this.chain.pos) < 0.5) return dot(b.axis, sub(to, b.pos)) >= 0 ? b.axis : scale(b.axis, -1);
    return this.chainTangent;
  }

  /** Направления «прямо» от начала нового пути: продолжения путей в узле или вдоль разрезаемого пути. */
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
    const b = this.besideStart;
    if (b && c.kind === 'free' && dist(b.pos, c.pos) < 0.5) return [b.axis, scale(b.axis, -1)];
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
    // Правка фазы светофора: клик по проезду перекрёстка — его зелёный в этой фазе (снимок для Ctrl+Z — там же).
    if (this.phaseEdit && this.phaseClick(p)) return;
    this.syncMoveBase();
    // Проект ничего не строит: узел, перо или середину участка — тянуть, клик — решится при отпускании.
    if (this.projectMode) {
      const hr = (HANDLE_PX + 4) / this.camera.zoom;
      this.projectTools.down(this.netKind, p, this.snapRadius, hr);
      // Мимо проекта, но у построенной дороги (её узел, перо, середина) — её можно тянуть правкой того же проекта,
      // как в «Двигать» (клик без протяжки — как раньше: узел проекта, примкнувший к ней).
      this.builtDrag = this.netKind === 'road' && this.projectTools.pressedEmpty && this.projectTools.tip === null && this.roadTools.moveDown(p, this.snapRadius, hr, this.freeAim);
      return;
    }
    // Всё, что строит или сносит, можно отменить (Ctrl+Z): снимок до действия, итог — при отпускании кнопки.
    const corner = this.action === 'move' && !this.roadTools.handleAt(p, (HANDLE_PX + 4) / this.camera.zoom) && this.roadTools.cornerAt(p, (HANDLE_PX + 4) / this.camera.zoom);
    const label = this.moving ? 'перенос здания' : this.movingStation !== null ? 'перенос станции' : corner ? 'скругление угла' : UNDO_LABELS[this.action];
    if (label) g.checkpoint(this.action === 'road' && this.netKind === 'rail' ? 'путь' : label);
    switch (this.action) {
      case 'road':
        if (this.netKind === 'road') {
          // Дорога — на сети полос: первый клик начинает, следующий (или отпускание после протяжки) строит.
          if (this.roadTools.begin(p, this.snapRadius)) this.left.createdChain = true;
          break;
        }
        if (!this.chain) {
          // Двухпутка: ось — свободная точка (пути встанут по бокам); у концов двухпутки — посередине, продолжаем оба пути.
          const pair = this.railTracks === 2 ? this.pairFromEnds(p) : null;
          if (pair) this.pairStart = { at: pair.at, snaps: pair.snaps };
          if (this.railTracks === 2) this.chain = { kind: 'free', pos: pair?.at ?? p, level: pair?.snaps[0].level ?? this.level };
          else {
            // Сбоку от пути на междупутье — начало рядом с ним (у тупика — напротив): второй путь пойдёт вдоль.
            const start = this.startSnap(p);
            this.chain = start.snap;
            this.besideStart = start.beside && { pos: start.snap.pos, axis: start.beside.axis };
          }
          this.chainTangent = pair?.tangent ?? g.builder.continuationTangent(this.chain);
          this.control = null;
          this.left.createdChain = true;
        }
        break;
      case 'lane':
        // Проект полос: узел или перо нового съезда, въезда — тянуть, как в «Двигать»; иначе — новая полоса.
        if (this.laneProjectMode && !this.roadTools.laneTip && this.laneProjectGrab(p)) break;
        // Полоса: кликами по точкам (как путь) или протяжкой вдоль края дороги — строится при отпускании.
        this.roadTools.laneDown(p, this.snapRadius);
        break;
      case 'parallel':
        // Путь рядом: зажали на пути, тянем вдоль него, отпускаем — строится.
        this.parallelFrom = p;
        break;
      case 'terrain':
        // Кисть: выравнивание — к высоте там, где нажали; пока кнопка зажата, мазки идут сами.
        this.brushTarget = g.terrain.heightAt(p);
        this.brushTimer = 0;
        this.brushStroke(p, true);
        break;
      case 'bulldoze': {
        // Рамкой — сносим при отпускании кнопки.
        if (this.bulldozeMode === 'area') {
          this.areaStart = p;
          break;
        }
        // Shift — снести только кусок дороги или полосы: от этой точки до той, где отпустят.
        if (e.shiftKey) {
          this.spanStart = this.spanTarget(p);
          if (this.spanStart) break;
        }
        if (this.bulldozeMode === 'lane') {
          const problem = this.roadTools.bulldozeLane(p);
          if (problem) this.showError(problem);
          break;
        }
        this.bulldozeAt(p);
        break;
      }
      case 'upgrade': {
        const problem = this.roadTools.upgrade(p, this.spec, this.snapRadius * 0.3);
        if (problem) this.showError(problem);
        break;
      }
      case 'move': {
        // Берём перо, примыкание въезда или съезда (вдоль дороги; с Alt — узлом), узел (дороги следом) или
        // середину дороги — выгнуть; отпускаем — перестраивается.
        if (!this.roadTools.moveDown(p, this.snapRadius, (HANDLE_PX + 4) / this.camera.zoom, this.freeAim)) this.showError('Возьмите за узел или середину дороги');
        break;
      }
      case 'trackMove': {
        // Ж/д: перо, узел (пути следом) или середина пути — выгнуть; отпускаем — перестраивается.
        if (!this.railTools.moveDown(p, this.snapRadius, (HANDLE_PX + 4) / this.camera.zoom)) this.showError('Возьмите за узел или середину пути');
        break;
      }
      case 'signal': {
        const plan = g.signalPlan(p, this.snapRadius, this.signalOneWay);
        if (!g.toggleSignal(p, this.snapRadius, this.signalOneWay)) this.showError(plan.reason ?? 'Не хватает денег');
        break;
      }
      case 'template': {
        // Развязка строится целиком или не строится вовсе (сама себе снимок для Ctrl+Z).
        const name = TEMPLATES.find((t) => t.id === this.templateKind)!.name;
        const error = g.buildTemplate(g.templatePlan(p, this.snapRadius, this.templateOptions()), `развязка «${name.toLowerCase()}»`);
        if (error) this.showError(error);
        break;
      }
      case 'copy':
        // Рамка копирования: копируем при отпускании.
        this.copyStart = p;
        break;
      case 'paste':
        // Вставка при отпускании; протяжка от этой точки поворачивает кусок.
        this.pasteDrag = { at: p };
        break;
      case 'lights': {
        // У выбранного перекрёстка клики по меткам полос соединяют въезды с выездами.
        if (this.laneClick(p)) break;
        // Ручка угла выбранного перекрёстка (у бордюра, не на метках полос) — скруглить поворот, как в «Двигать».
        const corner = this.junctionCorner(p);
        if (corner) {
          g.checkpoint('скругление угла');
          this.roadTools.corner = corner;
          break;
        }
        // Клик по перекрёстку открывает его настройки: светофор, главная дорога, повороты.
        const n = this.junctionAt(p);
        if (n) this.select({ type: 'junction', id: n.id });
        else if (this.laneFrom) this.clearLane();
        else this.showError('Кликните по перекрёстку');
        break;
      }
      case 'roundabout': {
        const check = g.roundaboutPlan(p, this.snapRadius, this.ring);
        if (!g.buildRoundabout(p, this.snapRadius, this.ring)) this.showError(check.reason ?? 'Нельзя построить');
        break;
      }
      case 'station': {
        const plan = g.stationPlan(p, this.snapRadius, this.stationKind, this.stationAngle, this.stationTracks, this.stationLength, this.stationTerminal);
        const st = g.placeStation(
          p,
          this.snapRadius,
          this.stationKind,
          this.newStationServes,
          this.stationAngle,
          this.stationTracks,
          this.stationLength,
          this.stationTerminal,
        );
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
        if (this.placingWarehouse !== null) {
          // Склад-здание станции — в зоне вокруг неё; поставили — снова её карточка.
          const id = this.placingWarehouse;
          const problem = g.buildWarehouse(id, p);
          if (problem) this.showError(problem);
          else {
            this.placingWarehouse = null;
            this.select({ type: 'station', id });
          }
          break;
        }
        if (this.placingAnnex !== null) {
          // Пристройка предприятия — в зоне вокруг него; поставили — снова его карточка.
          const id = this.placingAnnex;
          const problem = g.buildAnnex(id, p);
          if (problem) this.showError(problem);
          else {
            this.placingAnnex = null;
            this.select({ type: 'industry', id });
          }
          break;
        }
        if (this.movingStation !== null) {
          // Перенос станции: на новое место, с выездом; маршруты идут через неё же.
          const id = this.movingStation;
          const problem = g.moveStation(id, p, this.snapRadius);
          if (problem) this.showError(problem);
          else {
            this.movingStation = null;
            this.select({ type: 'station', id });
          }
          break;
        }
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
        // Значок предупреждения — карточка станции (предприятия), где объяснение и что сделать; блок подсвечен.
        const mark = this.markUnder(p);
        if (mark) {
          this.select(mark.station !== undefined ? { type: 'station', id: mark.station } : mark.industry !== undefined ? { type: 'industry', id: mark.industry } : null);
          if (mark.station !== undefined) this.warnFocus = { station: mark.station, until: performance.now() + 2500 };
          break;
        }
        this.select(this.pick(p));
        break;
      }
    }
  }

  /**
   * Узлы на концах дороги, которые можно двигать (не станции и не кольца), — кружки для «Двигать». Конец въезда
   * или съезда у примыкания — там, где он подходит к дороге (его тянут вдоль неё), а не на её оси.
   */
  private nodeMarks(corridorId: number | null): { pos: Vec; color: string; r: number; node: boolean }[] {
    const net = this.roadTools.base ?? this.game().roads.net;
    const c = corridorId === null ? undefined : net.corridors.get(corridorId);
    if (!c) return [];
    return [c.a, c.b]
      .map((id) => net.node(id))
      .filter((n) => this.roadTools.nodeAt(n.pos, 0.5)?.id === n.id)
      .map((n) => ({ pos: this.roadTools.nodeMark(c, n), color: '#2f80ed', r: 6, node: true }));
  }

  /** С чего начинается снос куска: полотно под курсором (в режиме «Полосу» — полоса) и место на его оси. */
  private spanTarget(p: Vec): { corridor: number; lane: number | null; s: number } | null {
    const net = this.game().roads.net;
    if (this.bulldozeMode === 'lane') {
      const hit = laneUnder(net, p);
      return hit ? { corridor: hit.corridor.id, lane: hit.lane, s: hit.s } : null;
    }
    const c = corridorUnder(net, p, this.snapRadius * 0.3);
    return c ? { corridor: c.id, lane: null, s: c.lut.closest(p).s } : null;
  }

  /** План сноса куска от spanStart до точки p (её проекции на то же полотно). */
  private spanPlan(p: Vec): RoadPlan | null {
    const st = this.spanStart;
    const c = st && this.game().roads.net.corridors.get(st.corridor);
    if (!st || !c) return null;
    return this.roadTools.spanPlan(st.corridor, st.lane, st.s, c.lut.closest(p).s);
  }

  /** Снос того, что под курсором: станция, дом, путь или дорога. */
  private bulldozeAt(p: Vec): void {
    const g = this.game();
    const st = g.structureAt(p);
    if (st?.type === 'station') g.removeStation(st);
    else if (st?.type === 'building') g.demolishBuilding(st);
    else if (st?.type === 'warehouse') {
      const problem = g.removeWarehouse(st);
      if (problem) this.showError(problem);
    } else if (st?.type === 'annex') g.removeAnnex(st);
    else if (!g.builder.bulldoze(p, this.snapRadius * 0.3)) this.roadTools.bulldoze(p, this.snapRadius * 0.3);
  }

  /** Перекрёсток у курсора. */
  private junctionAt(p: Vec) {
    const net = this.game().roads.net;
    return (
      net
        .nodesNear(p, this.snapRadius + 20)
        .filter((n) => n.kind === 'junction')
        .sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0] ?? null
    );
  }

  // ---------- Фазы светофора на карте ----------

  /**
   * Править на карте фазу i светофора node (выбрали в карточке); null — закончить. toggle — клик по плитке: та же
   * фаза ещё раз — тоже закончить.
   */
  editPhase(node: number, i: number | null, toggle = true): void {
    const same = this.phaseEdit?.node === node && this.phaseEdit.i === i;
    if (i === null || (same && toggle)) this.phaseEdit = null;
    else {
      // В «Выборе» (или в «Перекрёстке», где открыли карточку): клики других инструментов строят.
      if (this.tool !== 'select' && this.tool !== 'lights') this.setTool('select');
      this.laneFrom = null;
      this.phaseEdit = { node, i };
    }
    this.phaseFlash = null;
    this.onChange();
  }

  /** Правка фазы, если она ещё в силе: перекрёсток выбран, светофор стоит, фаза есть (после Ctrl+Z может и не быть). */
  private livePhase(): { node: number; i: number } | null {
    const e = this.phaseEdit;
    if (!e) return null;
    const sel = this.selection;
    const L = this.game().roads.graph.nodes.get(e.node)?.lights;
    if (sel?.type !== 'junction' || sel.id !== e.node || !L || e.i >= L.phases.length) {
      this.phaseEdit = null;
      return null;
    }
    return e;
  }

  /** Проезд перекрёстка node под точкой p: поворот ближайшего пути манёвра (src/lanes/lights.ts, turnAt). */
  private phaseTurnAt(node: number, p: Vec): string | null {
    const g = this.game().roads.graph;
    const paths = (g.junctionMoves.get(node) ?? []).map((m) => ({ turn: g.turnOf(m), points: m.points }));
    return turnAt(paths, p, Math.max(LANE_W * 0.5, 9 / this.camera.zoom));
  }

  /** Точка p — на перекрёстке node: в круге, которым он обведён на карте. */
  private onPhaseNode(node: number, p: Vec): boolean {
    const g = this.game().roads.graph;
    const n = g.nodes.get(node);
    if (!n) return false;
    const moves = g.junctionMoves.get(node) ?? [];
    const r = Math.max(12, ...moves.map((m) => dist(n.pos, m.points[0])));
    return dist(n.pos, p) <= r + 10;
  }

  /** Подписи поворотов перекрёстка: «З налево на С». */
  private turnNames(node: number): Map<string, string> {
    const info = this.game().junctionInfo(node);
    return new Map(info ? phaseTurns(info).map((t) => [t.key, t.name]) : []);
  }

  /**
   * Клик в правке фазы: по проезду — дать или снять ему зелёный (пересечёт зелёный — отказ, оба мигают красным);
   * мимо проездов, но на перекрёстке — подсказка; дальше — правка закончена, клик как обычно. true — клик принят.
   */
  private phaseClick(p: Vec): boolean {
    const e = this.livePhase();
    if (!e) return false;
    const g = this.game();
    const turn = this.phaseTurnAt(e.node, p);
    if (!turn) {
      if (this.onPhaseNode(e.node, p)) {
        this.showError('Кликните по проезду через перекрёсток');
        return true;
      }
      this.phaseEdit = null;
      this.onChange();
      return false;
    }
    const L = g.roads.graph.nodes.get(e.node)?.lights;
    const states = g.phaseStates(e.node, e.i);
    if (!L || !states) return false;
    const res = phaseToggle(specOf(L.phases), e.i, turn, states);
    if (res.clash.length) {
      this.phaseFlash = { node: e.node, i: e.i, turns: [turn, ...res.clash], until: performance.now() + 1600 };
      this.showError('Нельзя: пересекается с зелёным этой фазы');
    } else {
      // Фазы — тоже стройка: отменяются Ctrl+Z.
      g.checkpoint('фаза светофора');
      g.editPhases(e.node, () => res.spec);
      g.commit();
      this.phaseFlash = null;
    }
    this.onChange();
    return true;
  }

  /** Курсор в правке фазы: проезд под ним — ярче, подпись — что сделает клик. true — подпись есть. */
  private phaseHover(o: ToolOverlay, p: Vec): boolean {
    const pe = o.phaseEdit;
    if (!pe) return false;
    const turn = this.phaseTurnAt(pe.node, p);
    if (!turn) {
      if (!this.onPhaseNode(pe.node, p)) return false;
      o.label = { text: `Фаза ${pe.i + 1}: кликните по проезду · Esc — готово`, ok: true };
      return true;
    }
    pe.hover = turn;
    const names = this.turnNames(pe.node);
    const name = names.get(turn) ?? turn;
    const st = pe.states.get(turn);
    if (st?.look === 'blocked') {
      // С чем пересечётся — два первых, остальные числом: их и так видно красным на карте.
      const list = st.with.map((t) => names.get(t) ?? t);
      const what = list.length > 2 ? `${list.slice(0, 2).join(', ')} и ещё ${list.length - 2}` : list.join(', ');
      o.label = { text: `${name}: нельзя — пересечёт ${what}`, ok: false };
    }
    else o.label = { text: `${name}: ${st && st.look !== 'free' ? 'снять зелёный' : 'дать зелёный'}`, ok: true };
    return true;
  }

  // ---------- Полосы перекрёстка ----------

  /** Метки полос выбранного перекрёстка — только с инструментом «Перекрёсток» и не в правке фазы. */
  private laneEnds(): LaneEnd[] {
    const sel = this.selection;
    if (this.tool !== 'lights' || sel?.type !== 'junction' || this.livePhase()) return [];
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

  /** Значок предупреждения на карте под точкой p (те же значки, что рисует renderer). */
  private markUnder(p: Vec): WarningMark | null {
    return markAt(warningMarks(this.game(), this.camera.zoom), p, this.camera.zoom);
  }

  /** Карточку станции открыли кликом по значку предупреждения — её блок предупреждений ещё подсвечен. */
  warnFocusOn(station: number): boolean {
    return this.warnFocus?.station === station && performance.now() < this.warnFocus.until;
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
    if (st?.type === 'warehouse') return { type: 'station', id: st.stationId };
    if (st?.type === 'annex') return { type: 'industry', id: st.industryId };
    if (st?.type === 'industry') return { type: 'industry', id: st.id };
    if (st?.type === 'building') return { type: 'building', id: st.id };
    const town = g.townAt(p);
    if (town) return { type: 'town', id: town.id };
    return null;
  }

  private onMove(e: MouseEvent): void {
    this.mouse = { x: e.clientX, y: e.clientY };
    this.shift = e.shiftKey;
    this.alt = e.altKey;
    this.ctrl = e.ctrlKey || e.metaKey;
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
    if (this.left && this.tool === 'bulldoze' && this.bulldozeMode === 'point' && this.hover && !this.spanStart) {
      // Снос, который ведут мышью: дома и станции — только по клику.
      if (!this.game().builder.bulldoze(this.hover, this.snapRadius * 0.3)) this.roadTools.bulldoze(this.hover, this.snapRadius * 0.3);
    }
    if (this.left && this.action === 'lane' && this.hover) this.roadTools.laneMove(this.hover, this.snapRadius);
    if (this.left && this.projectMode && this.hover) this.projectTools.move(this.netKind, this.hover, this.snapRadius, e.shiftKey);
  }

  private onUp(e: MouseEvent): void {
    if ((e.button === 1 || e.button === 2) && this.pan) {
      // Правая кнопка без протяжки — как Esc: не надо тянуться к клавиатуре.
      if (!this.pan.moved && e.button === 2) this.back(true);
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
    if (this.spanStart) {
      const plan = this.spanPlan(this.worldAt(e));
      this.spanStart = null;
      if (plan?.ok) this.game().roadBuilder.apply(plan);
      else if (plan) this.showError(plan.reason);
      this.onChange();
      return;
    }
    if (this.action === 'bulldoze' && this.areaStart) {
      const a = this.areaStart;
      this.areaStart = null;
      const p = this.worldAt(e);
      // Просто клик в режиме рамки — сносим то, что под курсором.
      if (Math.hypot(e.clientX - left.sx, e.clientY - left.sy) <= 8) this.bulldozeAt(p);
      else this.finishArea(a, p);
      this.onChange();
      return;
    }
    const moved = Math.hypot(e.clientX - left.sx, e.clientY - left.sy) > 8;
    if (this.projectMode) {
      // Протянули построенную дорогу — её правка в проект (дорога пока как есть).
      if (this.builtDrag) {
        this.builtDrag = false;
        const edit = moved ? this.roadTools.moveEdit(this.worldAt(e), e.shiftKey, this.freeAim) : null;
        this.roadTools.moveEnd();
        if (edit) {
          this.projectTools.cancelPress();
          const problem = this.projectTools.addEdit(edit);
          if (problem) this.showError(problem);
          this.syncMoveBase();
          this.onChange();
          return;
        }
      }
      this.projectTools.up(this.drawSettings(), this.worldAt(e), this.snapRadius, moved, e.shiftKey);
      this.onChange();
      return;
    }
    if (this.action === 'copy' && this.copyStart) {
      const a = this.copyStart;
      this.copyStart = null;
      if (moved) this.copy(a, this.worldAt(e));
      else this.showError('Обведите рамкой дороги или пути');
      this.onChange();
      return;
    }
    if (this.action === 'paste' && this.pasteDrag) {
      const frag = this.pasteSource();
      const p = this.worldAt(e);
      if (frag) {
        const pose = this.pastePose(frag, p);
        this.pasteAngle = this.pasteRaw(p).angle;
        const error = this.game().paste(frag, pose.at, pose.angle);
        if (error) this.showError(error);
      }
      this.pasteDrag = null;
      this.onChange();
      return;
    }
    if (this.action === 'move') {
      // Клик по дороге (без протяжки) — узел на ней в этой точке: дальше его можно тянуть, к нему примыкать.
      const bend = this.roadTools.bend;
      if (!moved && bend !== null) {
        this.roadTools.moveEnd();
        this.splitRoadAt(bend, this.worldAt(e));
        this.onChange();
        return;
      }
      // Проект перемещения: протяжка — ещё одна правка проекта, дорога пока как есть.
      if (this.moveProjectMode) {
        const edit = moved ? this.roadTools.moveEdit(this.worldAt(e), e.shiftKey, this.freeAim) : null;
        this.roadTools.moveEnd();
        // Общий проект дорог: правка — его шаг (Ctrl+Z в проекте уберёт), вместе с новыми участками из «Строить».
        const problem = edit && this.projectTools.addEdit(edit);
        if (problem) this.showError(problem);
        this.syncMoveBase();
        this.onChange();
        return;
      }
      const problem = this.roadTools.moveUp(this.worldAt(e), moved, e.shiftKey, this.freeAim);
      if (problem) this.showError(problem);
      this.onChange();
      return;
    }
    if (this.action === 'lights' && this.roadTools.corner) {
      // «Перекрёсток»: тянули угол — скругление, как в «Двигать» (снимок для Ctrl+Z — при нажатии).
      const problem = this.roadTools.moveUp(this.worldAt(e), moved);
      if (problem) this.showError(problem);
      this.onChange();
      return;
    }
    if (this.action === 'trackMove') {
      const problem = this.railTools.moveUp(this.worldAt(e), moved, e.shiftKey);
      if (problem) this.showError(problem);
      this.onChange();
      return;
    }
    if (this.action === 'lane') {
      // Проект полос: тянули узел или перо нового съезда — правка проекта, как в «Двигать».
      if (this.laneProjectMode && this.roadTools.dragging) {
        const edit = moved ? this.roadTools.moveEdit(this.worldAt(e), e.shiftKey, this.freeAim) : null;
        this.roadTools.moveEnd();
        const problem = edit && this.projectTools.addEdit(edit, true);
        if (problem) this.showError(problem);
        this.syncMoveBase();
        this.onChange();
        return;
      }
      const problem = this.roadTools.laneUp(this.worldAt(e), this.snapRadius, this.spec, moved);
      if (problem) this.showError(problem);
      // Проект полос: следующую тянут уже от сети с этой.
      this.syncMoveBase();
      this.onChange();
      return;
    }
    if (this.action === 'parallel' && this.parallelFrom) {
      const from = this.parallelFrom;
      this.parallelFrom = null;
      // Снимок для Ctrl+Z делает сама стройка.
      const problem = this.game().buildParallelTrack(from, this.worldAt(e), this.snapRadius);
      if (problem) this.showError(problem);
      this.onChange();
      return;
    }
    if (this.action !== 'road') return;
    if (left.createdChain && !moved) return;
    const p = this.worldAt(e);
    if (this.netKind === 'road') {
      const problem = this.roadTools.build(p, this.spec, this.drawMode, this.snapRadius, this.shift, this.freeAim);
      if (problem) this.showError(problem);
      this.onChange();
      return;
    }
    if (this.drawMode === 'curve' && !this.control) {
      this.control = p;
      return;
    }
    this.tryBuild(p);
  }

  private request(end: Snap): RoadRequest {
    const req: RoadRequest = {
      start: this.chain!,
      end,
      spec: this.buildSpec,
      mode: this.drawMode,
      // Начали рядом с другим путём — из начала вдоль него, в сторону конца.
      tangent: this.startTangent(end.pos),
      control: this.control,
    };
    // Конец прилип рядом с другим путём — дуга приходит параллельно ему.
    const t3 = this.parallelEnd;
    if (t3 && end.kind === 'free') {
      const p0 = req.start.pos;
      const p3 = end.pos;
      const g = this.game();
      let t0 = this.startTangent(p3);
      if (!t0 && req.start.kind === 'split' && g.net.segments.has(req.start.segId)) {
        const seg = g.net.segment(req.start.segId);
        t0 = seg.lut.tangentAt(seg.lut.sAtT(req.start.t));
      }
      if (!t0) t0 = norm(sub(p3, p0));
      if (dot(t0, sub(p3, p0)) < 0) t0 = scale(t0, -1);
      const h = dist(p0, p3) * 0.4;
      req.curve = { p0, p1: add(p0, scale(t0, h)), p2: sub(p3, scale(t3, h)), p3 };
    }
    return req;
  }

  private tryBuild(p: Vec): void {
    const g = this.game();
    if (!this.chain) return;
    if (this.netKind === 'rail' && this.railTracks === 2) {
      this.tryBuildPair(p);
      return;
    }
    const end = this.endSnap(p);
    const run = this.besideRequests(end);
    if (run) {
      this.buildRun(run);
      return;
    }
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

  /** Путь вдоль соседнего — кусками подряд: все или ни одного; следующий отрезок продолжает его. */
  private buildRun(reqs: RoadRequest[]): void {
    const g = this.game();
    const bad = reqs.map((r) => g.builder.plan(r)).find((pl) => !pl.ok);
    if (bad) {
      this.showError(bad.reason);
      return;
    }
    let start: Snap | null = null;
    let tangent: Vec | null = null;
    for (const req of reqs) {
      const from: Snap = start ?? req.start;
      const res = g.builder.build({ ...req, start: from, curve: req.curve && { ...req.curve, p0: from.pos } });
      if (!res) {
        // Кусок не встал — откатываем построенные (снимок сделан при нажатии).
        g.commit();
        g.undo();
        this.showError('Не удалось построить путь');
        return;
      }
      const node = g.net.node(res.endNode);
      start = { kind: 'node', nodeId: node.id, pos: node.pos, level: node.level };
      tangent = res.tangent;
    }
    this.chain = start;
    this.chainTangent = tangent;
    this.control = null;
  }

  /** Двухпутка: оба пути или ни одного; следующий отрезок продолжает оба. */
  private tryBuildPair(p: Vec): void {
    const g = this.game();
    const end: Snap = { kind: 'free', pos: this.endSnap(p).pos, level: this.level };
    const reqs = this.pairRequests(end);
    if (!reqs) {
      this.showError('Слишком крутой поворот');
      return;
    }
    const bad = reqs.map((r) => g.builder.plan(r)).find((pl) => !pl.ok);
    if (bad) {
      this.showError(bad.reason);
      return;
    }
    const built = [];
    for (const req of reqs) {
      const res = g.builder.build(req);
      if (!res) {
        // Второй путь не встал — откатываем и первый (снимок сделан при нажатии).
        g.commit();
        g.undo();
        this.showError('Не удалось построить оба пути');
        return;
      }
      built.push(res);
    }
    const snaps = built.map((res) => {
      const n = g.net.node(res.endNode);
      return { kind: 'node', nodeId: n.id, pos: n.pos, level: n.level } as Snap;
    }) as [Snap, Snap];
    const at = { x: (snaps[0].pos.x + snaps[1].pos.x) / 2, y: (snaps[0].pos.y + snaps[1].pos.y) / 2 };
    this.chain = { kind: 'free', pos: at, level: snaps[0].level };
    this.chainTangent = built[0].tangent;
    this.pairStart = { at, snaps };
    this.control = null;
  }

  /** Высота начала строящейся дороги или пути над водой, м: земля, на мосту — выше, в тоннеле — ниже. Без рельефа — нет. */
  private startHeight(pos: Vec, level: number, deck = deckHeight(level)): { pos: Vec; m: number } | null {
    const t = this.game().terrain;
    return t.hasRelief ? { pos, m: t.altitudeAt(pos) + deck } : null;
  }

  /**
   * Курсор над мостом, эстакадой или тоннелем: подпись высоты — и полотна, и земли под или над ним (а не одна
   * высота земли, та же, что у дороги под мостом или над тоннелем). Над тоннелем дорога по земле — её и видно,
   * подпись обычная. Отметка полотна — от узла к узлу; запас 4 м — мост на экране чуть поднят.
   */
  private structureHeightAt(p: Vec): string | null {
    const g = this.game();
    const t = g.terrain;
    if (!t.hasRelief) return null;
    const net = g.roads.net;
    const c = corridorUnder(net, p, 4);
    if (!c) return null;
    const s = c.lut.closest(p).s;
    const h = net.heightAt(c, s);
    if (Math.abs(h) < 0.25) return null;
    const [A, B] = [net.node(c.a), net.node(c.b)];
    const za = t.altitudeAt(A.pos) + nodeDeck(A);
    const zb = t.altitudeAt(B.pos) + nodeDeck(B);
    const kind = h < 0 ? 'tunnel' : h >= 1.5 ? 'flyover' : 'bridge';
    return structureHeightText(za + (zb - za) * (s / Math.max(1e-6, c.length)), t.altitudeAt(p), kind);
  }

  /** Предпросмотр правки дорог: сеть с ней, дома под снос, подпись (цена или что не так). */
  /**
   * Тянут в «Двигать» (и угол перекрёстка в «Перекрёстке»): дороги в новой форме; вернут больше, чем потратим, —
   * возврат. У угла — его радиус и знак скорости правого поворота вдоль него по новой дуге. project — проект перемещения.
   */
  private moveDragOverlay(o: ToolOverlay, p: Vec, project: boolean): void {
    const g = this.game();
    const rt = this.roadTools;
    const plan = project ? this.projectWith(rt.moveEdit(p, this.shift, this.freeAim)) : rt.movePlan(p, this.shift, [], this.freeAim);
    if (!plan) return;
    const price = plan.cost < 0 ? `+${money(-plan.cost)}` : money(plan.cost);
    const what = rt.handle ? 'Перо · ' : rt.corner ? 'Угол · ' : rt.bend !== null ? 'Изогнуть · ' : rt.slide !== null ? 'Примыкание · ' : '';
    const turn = rt.corner && plan.net ? rt.cornerSign(plan.net) : null;
    const kmh = turn ? ` · поворот ${turn.kmh} км/ч` : '';
    if (project) this.showMoveProject(o, plan, `${what || 'Узел · '}${rt.hint ? `${rt.hint} · ` : ''}${kmh ? `${kmh.slice(3)} · ` : ''}проект ${price}`);
    else {
      this.showRoadPlan(o, plan, `${what}${price}${rt.hint ? ` · ${rt.hint}` : ''}${kmh}`);
      // Знаки скорости — по дороге в новой форме прямо во время протяжки; прежние знаки этих дорог — прочь.
      if (plan.net) {
        o.liveSigns = corridorCurveSigns(plan.net, freshSignCorridors(g.roads.net, plan.net, plan.changed));
        o.hiddenSigns = staleSignCorridors(g.roads.net, plan.net);
      }
    }
    if (turn) o.liveSigns = [...(o.liveSigns ?? []), turn];
    if (rt.handle) o.handles = rt.handleMarks(rt.handle, plan.net ?? undefined);
    if (rt.corner) o.handles = rt.cornerMarks(p, rt.corner, plan.net ?? undefined);
    // Примыкание ходит вдоль дороги: точки — докуда его можно сдвинуть.
    if (rt.slide !== null) o.points = [...(o.points ?? []), ...rt.jointTrack(rt.slide).map((pos) => ({ pos, color: '#2f80ed', r: 2 }))];
    if (rt.joinPos) o.points = [...(o.points ?? []), { pos: rt.joinPos, color: plan.ok ? '#2f80ed' : '#e8483f', r: 9 }];
  }

  /** Курсор на ручке угла перекрёстка: ручки углов (эта — выделена) и подпись — тянуть наружу, какой радиус сейчас. */
  private cornerHover(o: ToolOverlay, corner: CornerHandle, marks: NonNullable<ToolOverlay['handles']>): void {
    o.handles = marks.map((m) => ({ ...m, active: dist(m.pos, corner.pos) < 0.01 }));
    const now = corner.radius ? `радиус ${corner.radius} м` : `сейчас ≈${Math.round(corner.auto)} м`;
    o.label = { text: `Тяните угол наружу — скруглить поворот · ${now}`, ok: true };
  }

  /** Ручка угла выбранного перекрёстка под курсором — в инструменте «Перекрёсток» (метки полос проверяют раньше: они главнее). */
  private junctionCorner(p: Vec): CornerHandle | null {
    const sel = this.selection;
    if (this.tool !== 'lights' || sel?.type !== 'junction') return null;
    const h = this.roadTools.cornerAt(p, (HANDLE_PX + 4) / this.camera.zoom);
    return h && h.node === sel.id ? h : null;
  }

  /**
   * Предпросмотр «Полосы»: как showRoadPlan, а у новой полосы от края — куда по ней поедут (стрелка, встречная ли)
   * и «Alt — развернуть» (и когда нельзя — съезд против движения); у однополосной навстречу ходу постройки — ⇄.
   */
  private showLanePlan(o: ToolOverlay, plan: RoadPlan, okText: string, tip: LaneTip | undefined): void {
    const rt = this.roadTools;
    if (!rt.laneFlips) {
      this.showRoadPlan(o, plan, `${okText}${rt.reverse ? ' · ⇄' : ''}`);
      return;
    }
    const c = tip?.kind === 'edge' && tip.flow ? plan.net?.corridors.get(tip.corridor) : undefined;
    const way = c && tip?.kind === 'edge' && tip.flow ? laneFlowText(scale(c.lut.tangentAt(Math.max(0, Math.min(c.length, tip.s))), tip.flow), rt.reverse) : 'Alt — развернуть';
    this.showRoadPlan(o, plan, `${okText} · ${way}`);
    if (!plan.ok && o.label) o.label = { ...o.label, text: `${o.label.text} · Alt — развернуть` };
  }

  private showRoadPlan(o: ToolOverlay, plan: RoadPlan, okText: string): void {
    const g = this.game();
    if (plan.net) o.roads = { net: plan.net, ok: plan.ok, changed: plan.changed };
    for (const id of plan.demolish) {
      const b = g.buildingById(id);
      if (b) o.marks.push({ fp: b.fp, ok: false });
    }
    // Новое место навеса остановки, которую отодвинет расширение улицы.
    if (plan.ok) for (const fp of plan.moved ?? []) o.marks.push({ fp, ok: true });
    const razed = plan.demolish.length ? ` · снос ${plan.demolish.length} зд.` : '';
    const info = `${okText}${profileNote(plan.profile)}${curveNote(plan)}${razed}`;
    // Не хватает денег — всё равно видно, сколько стоит и какая выйдет дорога, и сколько есть.
    if (plan.ok) o.label = { text: info, ok: true };
    else if (plan.reason === NO_MONEY) o.label = { text: `${NO_MONEY} · ${info}`, ok: false };
    else o.label = { text: plan.reason ?? 'Нельзя', ok: false };
  }

  /**
   * Проект на карте: что выходит — будущей дорогой (синей) или путём, участки — пунктиром, беда — красным;
   * узлы, перья, новый участок до курсора и подпись (что под курсором, сколько стоит, что не так).
   */
  private projectOverlay(o: ToolOverlay, p: Vec | null): void {
    const g = this.game();
    const pt = this.projectTools;
    const s = this.drawSettings();
    const hr = (HANDLE_PX + 4) / this.camera.zoom;
    const rt = this.roadTools;
    // Тянут построенную дорогу — её правка (после прочих) уже в плане проекта.
    const built = this.builtDrag && rt.dragging && p ? rt.moveEdit(p, this.shift, this.freeAim) : null;
    const v = pt.view(s, p, this.snapRadius, hr, this.shift, built);
    const plan = v.plan;
    if (plan.road?.net) {
      // Не выходят правки построенных дорог (не участок и не деньги) — красным; иначе — синим, как проект.
      const editsBad = !plan.ok && plan.bad === null && plan.reason !== NO_MONEY;
      o.roads = { net: plan.road.net, ok: !editsBad, changed: plan.road.changed, project: !editsBad };
      // Знаки полотен, что проект меняет, — старые: бледно.
      o.staleSigns = staleSignCorridors(g.roads.net, plan.road.net);
    }
    if (s.kind === 'rail') o.plans = [...plan.rails.values()].filter((x) => x.ok);
    for (const id of plan.demolish) {
      const b = g.buildingById(id);
      if (b) o.marks.push({ fp: b.fp, ok: false });
    }
    o.project = { segs: v.segs, nodes: v.nodes, signs: v.signs };
    o.handles = v.handles;
    o.startHeight = null;
    o.points = [];
    if (pt.control) o.points.push({ pos: pt.control, color: '#f2994a', r: 4 });
    if (!p) return;
    const segs = pt.project(s.kind).segs.length;
    const edits = pt.edits(s.kind).length;
    const total = segs || edits || v.draft || built ? `${money(plan.cost)}${segs || v.draft ? ` · ${Math.round(plan.length)} м` : ''}` : '';
    const problem = !plan.ok && plan.reason && (segs || edits || v.draft || built) ? plan.reason : null;
    if (built) {
      // Тянут построенную дорогу: перья — в новой форме, подпись — что тянут и цена всего проекта.
      if (rt.handle) o.handles = rt.handleMarks(rt.handle, plan.road?.net ?? undefined);
      const what = rt.handle ? 'Перо' : rt.bend !== null ? 'Изогнуть' : 'Узел';
      const text = `${what} дороги${rt.hint ? ` · ${rt.hint}` : ''} · проект ${total}`;
      o.label = problem ? { text: `${problem} · ${text}`, ok: false } : { text, ok: true };
      return;
    }
    const at = pt.drag ? null : pt.targetAt(s.kind, p, this.snapRadius, hr);
    // Мимо проекта, у построенной дороги (не ведём ветку): видны её узлы и перья — их можно тянуть правкой проекта.
    if (s.kind === 'road' && !pt.drag && at === null && pt.tip === null) {
      const net = rt.base ?? g.roads.net;
      const h = rt.handleAt(p, hr);
      const n = h ? null : rt.nodeAt(p, this.snapRadius);
      const c = h || n ? null : corridorUnder(net, p, this.snapRadius * 0.3);
      if (c) rt.editCorridor = c.id;
      if (h || n || c) {
        o.handles = [...(o.handles ?? []), ...rt.handleMarks(h)];
        o.points.push(...this.nodeMarks(rt.editCorridor));
        if (n) o.points.push({ pos: n.pos, color: '#2f80ed', r: 9, node: true });
        const text = h ? 'Тяните перо дороги — правка в проекте' : n ? 'Тяните узел дороги — правка в проекте · клик — вести отсюда' : 'Тяните — изогнуть дорогу в проекте · клик — узел проекта';
        o.label = problem ? { text: `${problem} · ${text}`, ok: false } : { text, ok: true };
        return;
      }
    }
    // Куда встанет узел от клика — кружком, как начало дороги: у узла или дороги (пути) — большим, в поле — маленьким.
    if (!pt.drag && (at === null || pt.tip !== null)) {
      const start = pt.pointAt(s, p, this.snapRadius);
      if (!start.own) o.points.push({ pos: start.pos, color: '#2f80ed', r: start.attach ? 7 : 3 });
    }
    // Поворот медленнее дороги — как у обычной стройки: «⚠ поворот 60 км/ч».
    const slow = v.slowest !== null ? ` · ⚠ поворот ${v.slowest} км/ч` : '';
    let text: string;
    if (pt.drag) {
      const what = pt.drag.kind === 'handle' ? 'Перо' : pt.drag.kind === 'bend' ? 'Изогнуть' : 'Узел';
      text = `${what}${pt.hint ? ` · ${pt.hint}` : ''} · проект ${total}${slow}`;
    } else if (v.draft) {
      text = `+${money(v.draft.cost)} · ${Math.round(v.draft.length)} м · проект ${total}${slow} · Esc — закончить`;
    } else if (pt.tip !== null && s.mode === 'curve' && !pt.control) {
      text = 'Укажите изгиб кривой';
    } else {
      text =
        at === 'handle'
          ? pt.handleJoint(s.kind, p, hr) === 'kink'
            ? 'Тяните перо — узел снова гладкий · Shift — оставить излом'
            : 'Тяните перо · Shift — излом'
          : at === 'tip'
            ? 'Клик — закончить ветку · тяните — двигать узел'
            : at === 'node'
              ? 'Тяните узел · клик — вести отсюда · Delete — убрать'
              : at === 'seg'
                ? 'Тяните — изогнуть · клик — узел на участке'
                : segs
                  ? `Клик — новая ветка · Enter — построить${slow}`
                  : 'Клик — начало проекта';
    }
    o.label = problem ? { text: `${problem} · ${text}`, ok: false } : { text, ok: true };
  }

  /**
   * Общий проект дорог с правкой, которую тянут сейчас («Двигать», «Полоса»): его правки, она и новые участки из
   * «Строить» — для предпросмотра (участки не пропадают, пока тянут). null — правки нет. alone — план правки после
   * правок проекта, если он уже посчитан: новых участков нет — он и есть весь проект.
   */
  private projectWith(edit: NetEdit | null, alone: RoadPlan | null = null): RoadPlan | null {
    if (!edit) return null;
    if (alone && !this.projectTools.project('road').segs.length) return alone;
    return this.moveProject.plan(edit);
  }

  /** Проект полос: новые полотна (съезды, въезды, однополосные), чьи узлы и перья можно тянуть, — в сети с проектом. */
  private laneProjectCorridors(): { net: LaneNet; ids: number[] } | null {
    const g = this.game();
    const net = this.laneProjectMode && this.moveProject.edits.length ? this.moveProject.net() : null;
    if (!net) return null;
    const fresh = [...net.corridors.keys()].filter((id) => !g.roads.net.corridors.has(id));
    return { net, ids: freshSignCorridors(g.roads.net, net, fresh) };
  }

  /**
   * Проект полос: нажали у пера или узла нового съезда (въезда) — берём его, как в «Двигать» (тянут от сети с
   * проектом). false — там ничего такого нет: идёт обычная «Полоса».
   */
  private laneProjectGrab(p: Vec): boolean {
    const hit = this.laneProjectHit(p);
    if (!hit) return false;
    this.roadTools.editCorridor = hit.corridor;
    return this.roadTools.moveDown(p, this.snapRadius, (HANDLE_PX + 4) / this.camera.zoom, this.freeAim);
  }

  /** Проект полос: перо или узел нового съезда у точки p — какое полотно и что под курсором. */
  private laneProjectHit(p: Vec): { corridor: number; what: 'handle' | 'node' } | null {
    const own = this.laneProjectCorridors();
    if (!own) return null;
    const hr = (HANDLE_PX + 4) / this.camera.zoom;
    for (const id of own.ids) {
      const c = own.net.corridor(id);
      if ((['a', 'b'] as const).some((end) => dist(handlePoints(c, end).pos, p) <= hr)) return { corridor: id, what: 'handle' };
    }
    for (const id of own.ids) {
      const c = own.net.corridor(id);
      if ([c.a, c.b].some((n) => dist(own.net.node(n).pos, p) <= this.snapRadius * 0.8)) return { corridor: id, what: 'node' };
    }
    return null;
  }

  /** Проект полос: перья и узлы новых съездов — видно, за что тянуть (узлы — квадратами, перья — кружками). */
  private laneProjectMarks(o: ToolOverlay, net: LaneNet | null = null): void {
    const own = this.laneProjectCorridors();
    if (!own) return;
    const shown = net ?? own.net;
    const active = this.roadTools.handle;
    const ids = own.ids.filter((id) => shown.corridors.has(id));
    o.handles = ids.flatMap((id) =>
      (['a', 'b'] as const).map((end) => ({
        ...handlePoints(shown.corridor(id), end),
        active: !!active && active.corridor === id && active.end === end,
        partner: false,
      })),
    );
    const nodes = new Set(ids.flatMap((id) => [shown.corridor(id).a, shown.corridor(id).b]));
    o.points = [...(o.points ?? []), ...[...nodes].filter((n) => shown.nodes.has(n)).map((n) => ({ pos: shown.node(n).pos, color: '#2f80ed', r: 6, node: true }))];
  }

  /**
   * Проект полос на карте: дорога с ними — будущей, подсвечена синим (не выходит — красным, как у полосы); знаки
   * поворотов новых съездов и въездов — в стиле проекта, прежние знаки дорог, что меняют форму, — бледно; дома под снос.
   */
  private showLaneProject(o: ToolOverlay, plan: RoadPlan): void {
    const g = this.game();
    const net = plan.net;
    if (!net) return;
    o.roads = { net, ok: plan.ok, changed: plan.changed, project: plan.ok };
    o.project = { segs: [], nodes: [], signs: corridorCurveSigns(net, freshSignCorridors(g.roads.net, net, plan.changed)) };
    o.staleSigns = staleSignCorridors(g.roads.net, net);
    for (const id of plan.demolish) {
      const b = g.buildingById(id);
      if (b && !o.marks.some((m) => m.fp === b.fp)) o.marks.push({ fp: b.fp, ok: false });
    }
  }

  /**
   * Проект перемещения на карте: дороги в новом положении — проектом поверх того, что построено (заливка и пунктир
   * по кромкам; не проходит проверку — красным), знаки скорости на их поворотах, дома под снос. text — подпись
   * (что тянут и цена); null — подпись задаёт то, что под курсором.
   */
  private showMoveProject(o: ToolOverlay, plan: RoadPlan, text: string | null): void {
    const g = this.game();
    const net = plan.net;
    const ids = net ? plan.changed.filter((id) => net.corridors.has(id)) : [];
    const signs = net ? corridorCurveSigns(net, ids) : [];
    // Старое положение переносимых дорог — как есть, но его знаки бледно: новые — у проекта, в его стиле.
    if (net) o.staleSigns = staleSignCorridors(g.roads.net, net);
    if (net) {
      o.project = {
        segs: ids.map((id) => {
          const c = net.corridor(id);
          return { curve: c.curve, half: corridorHalf(c), ok: plan.ok, fill: true };
        }),
        nodes: [],
        signs,
      };
    }
    for (const id of plan.demolish) {
      const b = g.buildingById(id);
      if (b) o.marks.push({ fp: b.fp, ok: false });
    }
    if (text === null) return;
    const slow = signs.length ? ` · ⚠ поворот ${Math.min(...signs.map((x) => x.kmh))} км/ч` : '';
    o.label = plan.ok ? { text: `${text}${slow}`, ok: true } : { text: `${failText(plan.reason, plan.cost, 'Нельзя')} · ${text}`, ok: false };
  }

  /**
   * «Двигать», клик по дороге id в точке p: узел-стык на ней (форма та же), одним шагом Ctrl+Z; в проекте
   * перемещения — правкой проекта. Нельзя (кольцо, пандус, у самого узла) — причина у курсора.
   */
  private splitRoadAt(id: number, p: Vec): void {
    const g = this.game();
    const net = this.roadTools.base ?? g.roads.net;
    const c = net.corridors.get(id);
    if (!c) return;
    const s = c.lut.closest(p).s;
    const why = splitProblem(net, c, s);
    if (why) return this.showError(why);
    const edit = splitEdit(id, s);
    if (this.moveProjectMode) {
      const problem = this.projectTools.addEdit(edit);
      if (problem) this.showError(problem);
      this.syncMoveBase();
      return;
    }
    // Форма та же — дорогу не перепроверяем (только чтобы полосы сходились в новом стыке).
    const plan = g.roadBuilder.plan(edit, { only: () => false });
    if (!plan.ok) return this.showError(plan.reason);
    // Снимок «перенос дороги» с нажатия пуст — отмена назовёт это своим именем.
    g.commit();
    g.checkpoint('узел на дороге');
    g.roadBuilder.apply(plan);
    g.commit();
  }

  /**
   * «Двигать», Delete у узла: стык двух дорог, чьи полосы продолжают друг друга, убирается — они сливаются в
   * одну той же формы (одним шагом Ctrl+Z; в проекте перемещения — правкой проекта). Нельзя — причина у курсора.
   * false — узла под курсором нет.
   */
  private removeRoadNode(p: Vec): boolean {
    const g = this.game();
    const net = this.roadTools.base ?? g.roads.net;
    const n = net.nodesNear(p, this.snapRadius).sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
    if (!n) return false;
    const station = [...g.stations.values()].some((st) => st.nodeId === n.id);
    const why = station ? 'У узла станция — его не убрать' : mergeProblem(net, n.id);
    if (why) {
      this.showError(why);
      return true;
    }
    const edit = mergeEdit(n.id);
    if (this.moveProjectMode) {
      const problem = this.projectTools.addEdit(edit);
      if (problem) this.showError(problem);
      this.syncMoveBase();
      return true;
    }
    // Новая кривая почти на старой оси — её не перепроверяем (дома и соседи у прежней дороги уже как есть).
    const before = g.roads.net;
    const plan = g.roadBuilder.plan(edit, { only: (c) => !onOldAxis(before, c) });
    if (!plan.ok) {
      this.showError(plan.reason);
      return true;
    }
    g.checkpoint('узел убран');
    g.roadBuilder.apply(plan);
    g.commit();
    g.notify('Узел убран: две дороги — одна');
    return true;
  }

  private showError(text?: string): void {
    if (text) this.flash = { text, until: performance.now() + 1600 };
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Shift+колесо при вставке — плавный поворот на любой угол (на тачпаде Shift превращает прокрутку в боковую).
    if (e.shiftKey && this.action === 'paste') {
      this.pasteAngle += (e.deltaY || e.deltaX) * 0.0015;
      this.onChange();
      return;
    }
    const factor = Math.exp(-e.deltaY * 0.0015);
    this.camera.zoomAt(e.clientX, e.clientY, factor);
    this.camera.touched = true;
    this.hover = this.worldAt(e);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    this.keys.add(e.code);
    if (e.key === 'Shift') this.shift = true;
    // Alt (Option) — строить без прилипания к «прямо» и 90°; браузерное меню по Alt не нужно.
    if (e.key === 'Alt') {
      this.alt = true;
      e.preventDefault();
      // У односторонней и у полосы нажатие Alt разворачивает направление.
      const oneWay = this.tool === 'road' && this.netKind === 'road' && (this.roadMode === 'lane' || (this.roadMode === 'build' && isOneWay(this.spec)));
      if (oneWay && !e.repeat) {
        this.roadTools.reverse = !this.roadTools.reverse;
        this.onChange();
      }
    }
    // Cmd (macOS) / Ctrl — тоже без прилипания (направление односторонней не трогает); сочетания с ними — как были.
    if (e.key === 'Control' || e.key === 'Meta') this.ctrl = true;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      e.preventDefault();
      // В проекте — сперва шаги его правки (участки и правки построенных дорог — одной историей), потом (проект
      // пуст) — стройка.
      const kind = this.roadTools.dragging || this.roadTools.laneDrag ? null : this.projectKind;
      if (kind && this.projectTools.undo(kind)) {
        // Конец «полосы по точкам» мог остаться в убранной правке — ведём заново.
        if (this.editProject) this.roadTools.clear();
        this.syncMoveBase();
        this.onChange();
      } else this.undo();
      return;
    }
    // Сочетания с Cmd / Ctrl / Alt — браузеру (Cmd+N, Cmd+M…), игре только одиночные клавиши.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tool = TOOLS.find((t) => `Digit${t.key}` === e.code || (t.alt && `Key${t.alt}` === e.code));
    if (tool) {
      // Снос уже выбран — повторное нажатие переключает режим по кругу: точка → рамка → полоса.
      if (tool.id === 'bulldoze' && this.tool === 'bulldoze') {
        const modes = ['point', 'area', 'lane'] as const;
        this.setBulldozeMode(modes[(modes.indexOf(this.bulldozeMode) + 1) % modes.length]);
        return;
      }
      this.setTool(tool.id);
      return;
    }
    switch (e.code) {
      case 'Escape':
        this.back();
        break;
      case 'Enter':
        if (this.tool === 'line') this.finishLine();
        if (this.projectOn) this.buildProject();
        break;
      case 'KeyP':
        if (this.tool === 'road' || this.tool === 'rail') this.toggleProject();
        break;
      case 'Delete':
      case 'Backspace':
        // Узел проекта под курсором — прочь вместе с его участками.
        if (this.projectMode && this.hover && this.projectTools.removeAt(this.netKind, this.hover, this.snapRadius)) this.onChange();
        // «Двигать»: стык двух дорог под курсором — прочь, дороги сливаются в одну.
        else if (this.action === 'move' && this.hover && !this.roadTools.dragging && this.removeRoadNode(this.hover)) this.onChange();
        break;
      case 'Space':
        e.preventDefault();
        this.togglePause();
        break;
      case 'KeyV':
        this.toggleSpeedmap();
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
        if (this.action === 'paste') this.rotatePaste(e.shiftKey ? -1 : 1);
        break;
      // Режимы дороги: N — строить, U — перестроить, M — двигать (включают инструмент «Дорога»).
      case 'KeyN':
        // В инструменте «Ж/д» N и M — его режимы «Путь» и «Двигать».
        if (this.tool === 'rail') this.setRailMode('track');
        else this.setRoadMode('build');
        break;
      case 'KeyL':
        this.setRoadMode('lane');
        break;
      case 'KeyU':
        this.setRoadMode('upgrade');
        break;
      case 'KeyM':
        if (this.tool === 'rail') this.setRailMode('move');
        else this.setRoadMode('move');
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
      // −/+ — высота конца строящейся дороги относительно начала.
      case 'Equal':
      case 'NumpadAdd':
      case 'Minus':
      case 'NumpadSubtract': {
        this.stepRise(e.code === 'Equal' || e.code === 'NumpadAdd' ? 1 : -1);
        break;
      }
    }
  }

  // ---------- Оверлей ----------

  overlay(): ToolOverlay {
    const g = this.game();
    this.syncMoveBase();
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
      speedmap: this.speedmap,
      chartPoint: this.selectedLine !== null ? this.chartPoint : null,
      fleetHover: this.selectedLine !== null ? this.fleetHover : null,
      laneEdit: null,
      mainHover: this.mainHover,
      roadTool: this.action === 'road' || this.tool === 'terrain',
    };
    // Над мостом и тоннелем высота у курсора — и полотна, и земли под или над ним.
    if (o.roadTool && this.hover) o.heightText = this.structureHeightAt(this.hover);
    // Инструмент «Перекрёсток» у выбранного перекрёстка: метки полос для настройки связей.
    const laneEnds = this.laneEnds();
    if (laneEnds.length && this.selection?.type === 'junction') {
      if (this.laneFrom && !this.activeLane(laneEnds)) this.laneFrom = null;
      o.laneEdit = { node: this.selection.id, ends: laneEnds, from: this.laneFrom, hover: null };
    }
    // Правка фазы светофора: проезды перекрёстка цветом по фазе, отказ — мигает.
    const pe = this.livePhase();
    const states = pe && g.phaseStates(pe.node, pe.i);
    if (pe && states) {
      const fl = this.phaseFlash;
      const refused = fl && fl.until > performance.now() && fl.node === pe.node && fl.i === pe.i ? fl.turns : [];
      o.phaseEdit = { node: pe.node, i: pe.i, states, hover: null, flash: refused };
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
    // Рамка сноса: пока тянем — по курсору, после — ждёт подтверждения.
    const area = this.pendingArea ?? (this.areaStart && p ? { a: this.areaStart, b: p, contents: g.areaContents(this.areaStart, p) } : null);
    if (area) {
      const c = area.contents;
      o.area = { a: area.a, b: area.b, segs: c.segs, corridors: c.corridors, fps: [...c.buildings.map((x) => x.fp), ...c.stations.map((x) => x.fp)] };
      if (!this.pendingArea) {
        o.label = { text: `${areaSummary(c)} · +${money(c.refund)}${c.cost ? ` −${money(c.cost)}` : ''}`, ok: true };
        return o;
      }
    }
    // Проект виден и без курсора над картой (курсор на панели — у кнопки «Построить»).
    if (!p) {
      if (this.projectMode) this.projectOverlay(o, null);
      else if (this.moveProjectMode && this.moveProject.hasWork) this.showMoveProject(o, this.moveProject.plan(), null);
      else if (this.laneProjectMode && this.moveProject.hasWork) this.showLaneProject(o, this.moveProject.plan());
      return o;
    }
    // Тянут знак скорости: дорога под ним (до перекрёстков, с Cmd / Ctrl — один участок) — как будет, подпись — новая скорость.
    if (this.dragLimit !== null) {
      const res = this.roadTools.limitPlan(p, this.dragLimit, this.snapRadius * 0.3, this.ctrl);
      const part = res && res.parts > 1 ? (this.ctrl ? ' · только этот участок' : ' · Cmd/Ctrl — только этот участок') : '';
      if (res) this.showRoadPlan(o, res.plan, `${res.was} → ${this.dragLimit} км/ч${part}`);
      else o.label = { text: `${this.dragLimit} км/ч — отпустите на дороге`, ok: true };
      return o;
    }
    // Правка фазы: над перекрёстком — проезд под курсором и что сделает клик (поверх подсказок инструмента).
    if (this.phaseHover(o, p)) {
      if (flash) o.label = { text: flash, ok: false };
      return o;
    }

    switch (this.action) {
      case 'road': {
        if (this.projectMode) {
          this.projectOverlay(o, p);
          break;
        }
        if (this.netKind === 'road') {
          const rt = this.roadTools;
          // Заданная −/+ высота конца — припиской к высоте у курсора, чтобы не искать её в панели.
          o.rise = rt.auto ? riseLabel(rt.rise) : null;
          // Начало — кружком у курсора (узел, дорога или поле), потом — будущая дорога целиком.
          if (!rt.start) {
            const a = anchorAt(g.roads.net, p, this.snapRadius);
            o.points = [{ pos: a.pos, color: '#2f80ed', r: a.kind === 'free' ? 3 : 7 }];
            break;
          }
          o.points = [{ pos: rt.start.pos, color: '#2f80ed', r: 6 }];
          o.startHeight = this.startHeight(rt.start.pos, rt.startLevel ?? 0, rt.startDeck);
          if (rt.control) o.points.push({ pos: rt.control, color: '#f2994a', r: 4 });
          if (this.drawMode === 'curve' && !rt.control) {
            o.label = { text: 'Укажите изгиб кривой', ok: true };
            break;
          }
          const plan = rt.buildPlan(p, this.spec, this.drawMode, this.snapRadius, this.shift, this.freeAim);
          if (plan) {
            const length = plan.net ? plan.changed.reduce((s, id) => s + (plan.net!.corridors.get(id)?.length ?? 0), 0) : 0;
            const aligned = rt.hint ? ` · ${rt.hint}` : '';
            const back = rt.reverse && isOneWay(this.spec) ? ' · ⇄ навстречу' : '';
            // «Авто»: сколько вышло моста и тоннеля, на сколько конец выше начала.
            const info = rt.autoInfo;
            const auto = info ? [info.bridge > 1 ? `мост ${Math.round(info.bridge)} м` : '', info.tunnel > 1 ? `тоннель ${Math.round(info.tunnel)} м` : ''].filter(Boolean).join(' · ') : '';
            // Где выйдет конец относительно начала и на чём он: −/+ задаёт желаемую высоту, но конец ближе 6 м к земле
            // остаётся на земле — подпись показывает, что получится на самом деле, а не заданное.
            const on = rt.endLevel > 0 ? 'на мосту' : rt.endLevel < 0 ? 'в тоннеле' : 'по земле';
            const rise =
              rt.auto && rt.rise !== null
                ? ` · конец ${plan.ok && rt.endRise !== null ? `${signedMetres(rt.endRise)} ${on}` : signedMetres(rt.rise)}`
                : '';
            const from = rt.startLevel ?? 0;
            const levels = !rt.auto && (from !== 0 || this.level !== 0) ? ` · ${levelName(from)} → ${levelName(this.level)}` : '';
            this.showRoadPlan(o, plan, `${auto ? `${auto} · ` : ''}${money(plan.cost)} · ${Math.round(length)} м${rise}${levels}${aligned}${back}`);
            if (!plan.ok && o.label && rt.auto) o.label.text += `${plan.reason === NO_MONEY ? '' : rise} · −/+ — высота конца`;
            else if (!plan.ok && o.label && /Подъём|Выемка|Насыпь/.test(plan.reason ?? '')) o.label.text += ' · «Авто» — мост или тоннель сам';
          }
          break;
        }
        o.chainStart = this.chain;
        if (this.chain) o.startHeight = this.startHeight(this.chain.pos, this.chain.level);
        // Двухпутку начинают от пары концов — кружок посередине между ними.
        const pairHere = !this.chain && this.railTracks === 2 ? this.pairFromEnds(p) : null;
        if (this.chain) o.snap = this.endSnap(p);
        else if (pairHere) o.snap = { ...pairHere.snaps[0], pos: pairHere.at };
        else {
          const start = this.startSnap(p);
          o.snap = start.snap;
          if (start.beside) {
            // Начало рядом с путём: кольцо на месте начала и кусок будущего пути вдоль соседнего.
            const ghost = besideGhost(g.net, start.beside);
            if (ghost) o.plans = [{ ok: true, cost: 0, curve: ghost, lut: new CurveLUT(ghost), levelA: this.level, levelB: this.level, spec: RAIL_SPEC, crossings: [], demolish: [] }];
            o.points = [{ pos: start.snap.pos, color: '#2f80ed', r: 7 }];
            o.label = { text: 'Рядом с путём', ok: true };
          }
        }
        if (this.chain) {
          if (this.drawMode === 'curve' && !this.control) {
            o.label = { text: 'Укажите изгиб кривой', ok: true };
            o.control = p;
            break;
          }
          // Двухпутка: два пути по бокам от оси, цена — за оба.
          if (this.netKind === 'rail' && this.railTracks === 2) {
            const reqs = this.pairRequests({ kind: 'free', pos: o.snap.pos, level: this.level });
            if (!reqs) {
              o.label = { text: 'Слишком крутой поворот', ok: false };
              break;
            }
            o.plans = reqs.map((r) => g.builder.plan(r));
            const bad = o.plans.find((pl) => !pl.ok);
            const cost = o.plans.reduce((s, pl) => s + pl.cost, 0);
            const length = Math.round(o.plans[0].lut?.length ?? 0);
            o.label = bad ? { text: `${bad.reason} · ${money(cost)} · ${length} м`, ok: false } : { text: `Два пути · ${money(cost)} · ${length} м`, ok: true };
            break;
          }
          // Вдоль соседнего пути — кусками; цена и длина — за все.
          const run = this.besideRequests(o.snap);
          if (run) {
            o.plans = run.map((r) => g.builder.plan(r));
            const bad = o.plans.find((pl) => !pl.ok);
            const cost = o.plans.reduce((s, pl) => s + pl.cost, 0);
            const length = Math.round(o.plans.reduce((s, pl) => s + (pl.lut?.length ?? 0), 0));
            const razed = new Set(o.plans.flatMap((pl) => pl.demolish));
            for (const id of razed) {
              const b = g.buildingById(id);
              if (b) o.marks.push({ fp: b.fp, ok: false });
            }
            const info = `${money(cost)} · ${length} м · рядом с путём${razed.size ? ` · снос ${razed.size} зд.` : ''}`;
            o.label = bad ? { text: `${bad.reason} · ${money(cost)}`, ok: false } : { text: info, ok: true };
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
            ? { text: `${money(o.plan.cost)} · ${Math.round(o.plan.lut?.length ?? 0)} м${aligned}${lvl}${profileNote(o.plan.profile)}${razed}`, ok: true }
            : { text: `${o.plan.reason} · ${money(o.plan.cost)}`, ok: false };
        }
        break;
      }
      case 'terrain': {
        const g2 = this.game();
        const r = BRUSH_SIZES[this.brushSize];
        const target = this.left ? (this.brushTarget ?? undefined) : g2.terrain.heightAt(p);
        const plan = g2.terraformPlan(p, this.terrainMode, r, target);
        o.brush = { pos: p, r, ok: plan.ok };
        const h = altitudeText(g2.terrain.altitudeAt(p));
        o.label = plan.ok
          ? { text: `${BRUSH_NAMES[this.terrainMode]} · ${money(plan.cost)} за мазок · ${h}`, ok: true }
          : { text: `${plan.reason} · ${h}`, ok: false };
        break;
      }
      case 'parallel': {
        // Тянем вдоль пути — новый путь рядом со стороны курсора; иначе — подсказка.
        if (this.parallelFrom) {
          const plan = g.parallelTrackPlan(this.parallelFrom, p, this.snapRadius);
          o.plans = plan.reqs.map((r) => g.builder.plan(r));
          o.label = plan.ok ? { text: `Путь рядом · ${money(plan.cost)}`, ok: true } : { text: failText(plan.reason, plan.cost, ''), ok: false };
          break;
        }
        const hit = g.net.findSegmentNear(p, Math.max(30, this.snapRadius), (s) => s.spec.cls === 'rail' && s.platform === undefined);
        if (hit) {
          o.highlightSeg = hit.seg.id;
          o.highlightEdit = true;
          o.label = { text: 'Зажмите и тяните вдоль пути — рядом ляжет второй', ok: true };
        }
        break;
      }
      case 'lane': {
        const rt = this.roadTools;
        // Проект полос: от сети с ним — и полосы под курсором, и то, что нарисовано, — будущей дорогой (синей).
        const lanesProject = this.laneProjectMode;
        const net = rt.base ?? g.roads.net;
        if (lanesProject && this.moveProject.hasWork && !rt.laneDrag && !rt.dragging) this.showLaneProject(o, this.moveProject.plan());
        // Тянут узел или перо нового съезда: дорога с этой правкой — проектом, перья — в новой форме.
        if (lanesProject && rt.dragging) {
          const plan = this.projectWith(rt.moveEdit(p, this.shift, this.freeAim));
          if (plan) {
            this.showLaneProject(o, plan);
            const price = plan.cost < 0 ? `+${money(-plan.cost)}` : money(plan.cost);
            const text = `${rt.handle ? 'Перо' : 'Узел'}${rt.hint ? ` · ${rt.hint}` : ''} · проект ${price}`;
            o.label = plan.ok ? { text, ok: true } : { text: `${failText(plan.reason, plan.cost, 'Нельзя')} · ${text}`, ok: false };
            this.laneProjectMarks(o, plan.net);
          }
          break;
        }
        // Узлы и перья новых съездов видны — за них тянут; не проходит проверку — причина у курсора.
        if (lanesProject && !rt.laneDrag && !rt.laneTip) {
          this.laneProjectMarks(o);
          const hit = this.laneProjectHit(p);
          if (hit) {
            const pending = this.moveProject.plan();
            const text = hit.what === 'handle' ? 'Тяните перо · Shift — излом' : 'Тяните узел — съезд следом · Cmd/Ctrl — без прилипания';
            o.label = pending.ok ? { text, ok: true } : { text: `${failText(pending.reason, pending.cost, 'Нельзя')} · ${text}`, ok: false };
            break;
          }
        }
        const tipAt = rt.laneTipPos();
        if (tipAt) {
          // По точкам: следующий кусок до курсора — как построенный; кружок — где сейчас конец полосы.
          const res = rt.laneStepPlan(p, this.spec, this.snapRadius);
          if (res) {
            this.showLanePlan(o, res.plan, `${res.step?.what ?? ''} · ${lanesProject ? 'проект ' : ''}${money(res.plan.cost)}`, res.step?.tip);
            if (lanesProject) this.showLaneProject(o, this.projectWith(res.edit, res.plan) ?? res.plan);
            const next = res.step && res.plan.net ? laneTipPos(res.plan.net, res.step.tip) : null;
            o.points = [{ pos: tipAt, color: '#27ae60', r: 6 }, ...(next ? [{ pos: next, color: '#27ae60', r: 4 }] : [])];
          }
          break;
        }
        if (!rt.laneDrag) {
          // У конца дороги — её полосы точками, как концы путей: с любой начинается своя однополосная.
          const ports = lanePortsNear(net, p, 30);
          const pick = laneTipAt(net, p, this.snapRadius);
          if (ports.length) {
            const on = pick.kind === 'port' ? ports.find((x) => x.node === pick.node && Math.abs(x.port - pick.port) < 0.01) : undefined;
            o.points = [...(o.points ?? []), ...ports.map((x) => ({ pos: x.pos, color: x === on ? '#27ae60' : '#2f80ed', r: x === on ? 4 : 2.2 }))];
            if (on) {
              o.label = { text: on.out ? 'Однополосная из этой полосы' : 'Однополосная в эту полосу', ok: true };
              break;
            }
          }
          // Конец пристроенной полосы под курсором — его можно тянуть: кружок на её отгоне.
          const end = laneEndAt(net, p);
          if (end) {
            const l = end.corridor.lanes[end.lane];
            const T = taperLen(end.corridor.cls) / 2;
            const s = end.end === 'from' ? Math.max(0, l.from - T) : Math.min(end.corridor.length, l.to + T);
            o.points = [...(o.points ?? []), { pos: pointOff(end.corridor, s, l.offset), color: '#27ae60', r: 7 }];
            o.lane = { corridor: end.corridor.id, lane: end.lane };
            o.label = { text: 'Тяните конец — длиннее или короче · клик — продолжить по точкам', ok: true };
            break;
          }
          // Где встанет полоса: у края дороги — зелёный кружок.
          const e = edgeAt(net, p);
          o.points = [...(o.points ?? []), ...(e ? [{ pos: e.pos, color: '#27ae60', r: 5 }] : [])];
          // Куда поедут по новой полосе у этого края (по ходу движения с этой стороны; Alt — встречная).
          const ec = e && net.corridors.get(e.corridor);
          const way = e && ec ? ` ${dirArrow(scale(ec.lut.tangentAt(e.s), newLaneFlow(ec, e.offset, e.s, rt.reverse)))}${rt.reverse ? ' встречная' : ''}` : '';
          o.label = {
            text: e ? `Кликайте по точкам или тяните: вдоль края — полоса${way}, в сторону — съезд · Alt — развернуть` : 'Клик у края дороги, на полосе или в поле',
            ok: true,
          };
          break;
        }
        // Тянут: что построится (вдоль, съезд, въезд — и через стыки), возврат — если полоса короче.
        const res = rt.lanePlan(this.spec);
        if (res) {
          this.showLanePlan(o, res.plan, `${res.what} · ${lanesProject ? 'проект ' : ''}${res.plan.cost < 0 ? `+${money(-res.plan.cost)}` : money(res.plan.cost)}`, res.step?.tip);
          if (lanesProject) this.showLaneProject(o, this.projectWith(res.edit, res.plan) ?? res.plan);
        }
        break;
      }
      case 'upgrade': {
        // Будущая дорога на месте полотна (ширина, полосы, направление); нельзя — красным.
        const res = this.roadTools.upgradePlan(p, this.spec, this.snapRadius * 0.3);
        if (res) this.showRoadPlan(o, res.plan, res.plan.cost ? money(res.plan.cost) : 'Перестроить');
        break;
      }
      case 'move': {
        const rt = this.roadTools;
        // Проект перемещения: тянут от сети с ним, дорога на карте — как есть, новое положение — проектом.
        const project = this.moveProjectMode;
        const net = rt.base ?? g.roads.net;
        if (rt.dragging) {
          this.moveDragOverlay(o, p, project);
          break;
        }
        // Нарисованное перемещение (и новые участки из «Строить») — проектом поверх дороги, какая она сейчас.
        if (project && this.moveProject.hasWork) this.showMoveProject(o, this.moveProject.plan(), null);
        // Сначала перья видимой дороги, потом углы перекрёстка, потом узел, потом середина дороги.
        const hr = (HANDLE_PX + 4) / this.camera.zoom;
        // Углы перекрёстка рядом — ручками от острой вершины к середине бордюра: за них тянут, чтобы скруглить.
        const corners = rt.cornerMarks(p, null, net, hr);
        const handle = rt.handleAt(p, hr);
        if (handle) {
          o.handles = [...rt.handleMarks(handle), ...corners];
          o.points = this.nodeMarks(rt.editCorridor);
          // Излом из двух дорог: без Shift перья снова встают на одну прямую.
          o.label = { text: rt.unkinks(handle) ? 'Тяните перо — узел снова гладкий · Shift — оставить излом' : 'Тяните перо · Shift — излом на стыке', ok: true };
          break;
        }
        const corner = rt.cornerAt(p, hr);
        if (corner) {
          this.cornerHover(o, corner, corners);
          o.handles = [...rt.handleMarks(null), ...(o.handles ?? [])];
          break;
        }
        // Примыкание въезда или съезда: его тянут вдоль дороги — точки показывают, докуда (с Alt или Cmd / Ctrl — как узел).
        const joint = this.freeAim ? null : rt.slideAt(p, this.snapRadius);
        if (joint) {
          if (!project) o.corridor = { id: joint.corridor, color: 'blue' };
          o.points = [...rt.jointTrack(joint.node).map((pos) => ({ pos, color: '#2f80ed', r: 2 })), { pos: joint.pos, color: '#2f80ed', r: 9 }];
          o.label = { text: 'Тяните примыкание вдоль дороги · Cmd/Ctrl или Alt — свободно', ok: true };
          o.handles = [...rt.handleMarks(null), ...corners];
          break;
        }
        const node = rt.nodeAt(p, this.snapRadius);
        if (node) {
          o.points = [{ pos: node.pos, color: '#2f80ed', r: 9, node: true }];
          const dead = net.isDeadEnd(node);
          // Тупик примыкает к дороге, изгиб встаёт на прямую — с Cmd / Ctrl (или Alt) узел идёт ровно за курсором.
          const free = dead || node.corridors.length === 2 ? ' · Cmd/Ctrl — без прилипания' : '';
          // Стык двух дорог можно убрать — они сольются в одну.
          const merge = node.kind === 'seam' && !dead && mergeProblem(net, node.id) === null ? ' · Delete — убрать узел' : '';
          o.label = { text: `${dead ? 'Тяните тупик — продлить, примкнуть' : 'Тяните узел — дороги следом'}${merge}${free}${corners.length ? ' · за угол — скруглить' : ''}`, ok: true };
          o.handles = [...rt.handleMarks(null), ...corners];
          break;
        }
        const c = corridorUnder(net, p, this.snapRadius * 0.3);
        if (c) {
          // У дороги под курсором видны перья — они остаются, пока курсор идёт к ним.
          rt.editCorridor = c.id;
          // В проекте дорога под курсором — в новом положении: подсветка — её проектом.
          if (project) o.project = { segs: [...(o.project?.segs ?? []), { curve: c.curve, half: corridorHalf(c), ok: true, fill: true }], nodes: o.project?.nodes ?? [], signs: o.project?.signs };
          else o.corridor = { id: c.id, color: 'blue' };
          // Клик (без протяжки) — узел в этой точке дороги: квадратик, как у узла проекта.
          const at = c.lut.closest(p);
          const split = splitProblem(net, c, at.s) === null;
          if (split) o.project = { segs: o.project?.segs ?? [], nodes: [...(o.project?.nodes ?? []), { pos: at.point, tip: false, hot: true }], signs: o.project?.signs };
          o.label = { text: `Тяните — изогнуть дорогу${split ? ' · клик — узел на дороге' : ''}`, ok: true };
        }
        o.handles = [...rt.handleMarks(null), ...corners];
        // И узлы этой дороги — кружками: видно, за что тянуть, чтобы двигать узел.
        o.points = this.nodeMarks(rt.editCorridor);
        break;
      }
      case 'trackMove': {
        const rt = this.railTools;
        const marks = () => rt.nodeMarks().map((pos) => ({ pos, color: '#2f80ed', r: 6, node: true }));
        if (rt.dragging) {
          // Тянем: пути в новой форме (нельзя — красным), узел — на новом месте; дешевле стало — возврат.
          const plan = rt.movePlan(p, this.shift);
          if (plan) {
            o.plans = plan.plans;
            for (const id of plan.demolish) {
              const b = g.buildingById(id);
              if (b) o.marks.push({ fp: b.fp, ok: false });
            }
            const price = plan.cost < 0 ? `+${money(-plan.cost)}` : money(plan.cost);
            const what = rt.handle ? 'Перо · ' : rt.bend !== null ? 'Изогнуть · ' : '';
            const razed = plan.demolish.length ? ` · снос ${plan.demolish.length} зд.` : '';
            o.label = plan.ok ? { text: `${what}${price}${rt.hint ? ` · ${rt.hint}` : ''}${razed}`, ok: true } : { text: failText(plan.reason, plan.cost, 'Нельзя'), ok: false };
            if (rt.handle) o.handles = rt.handleMarks(rt.handle, plan);
            if (plan.node) o.points = [{ pos: plan.node.pos, color: plan.ok ? '#2f80ed' : '#e8483f', r: 9, node: true }];
          }
          break;
        }
        // Сначала перья видимого пути, потом узел, потом середина пути.
        const handle = rt.handleAt(p, (HANDLE_PX + 4) / this.camera.zoom);
        if (handle) {
          o.handles = rt.handleMarks(handle);
          o.points = marks();
          o.label = { text: 'Тяните перо · Shift — только этот путь', ok: true };
          break;
        }
        const node = rt.nodeAt(p, this.snapRadius);
        if (node) {
          o.points = [{ pos: node.pos, color: '#2f80ed', r: 9, node: true }];
          o.label = { text: node.segments.length === 1 ? 'Тяните тупик' : 'Тяните узел — пути следом', ok: true };
          o.handles = rt.handleMarks(null);
          break;
        }
        // Узел станции рядом — красным: его двигают только со станцией.
        const fixed = g.net.findNodeNear(p, this.snapRadius * 0.6, (n) => n.segments.length > 0);
        if (fixed) {
          o.points = [{ pos: fixed.pos, color: '#e8483f', r: 9, node: true }];
          o.label = { text: 'Узел станции не двигается', ok: false };
          break;
        }
        const seg = rt.segAt(p, this.snapRadius * 0.3);
        if (seg) {
          // У пути под курсором видны перья — они остаются, пока курсор идёт к ним.
          rt.editSeg = seg.id;
          o.highlightSeg = seg.id;
          o.highlightEdit = true;
          o.label = { text: 'Тяните — изогнуть путь', ok: true };
        }
        o.handles = rt.handleMarks(null);
        o.points = marks();
        break;
      }
      case 'bulldoze': {
        // Снос куска: как будет после — сеть без него, края куска — красными точками, подпись — возврат или причина.
        if (this.spanStart) {
          const plan = this.spanPlan(p);
          const c = g.roads.net.corridors.get(this.spanStart.corridor);
          if (plan) this.showRoadPlan(o, plan, `Снести кусок · +${money(-plan.cost)}`);
          if (c) o.points = [this.spanStart.s, c.lut.closest(p).s].map((s) => ({ pos: c.lut.pointAt(s), color: '#e8483f', r: 5 }));
          break;
        }
        // Зажат Shift — видно, что сейчас снесётся только кусок: точка начала на дороге (полосе) и подсказка.
        if (this.shift && this.bulldozeMode !== 'area') {
          const t = this.spanTarget(p);
          const c = t && g.roads.net.corridors.get(t.corridor);
          if (c && t) {
            o.points = [{ pos: c.lut.pointAt(t.s), color: '#e8483f', r: 5 }];
            if (t.lane !== null) o.lane = { corridor: t.corridor, lane: t.lane };
            o.label = { text: `Кусок ${t.lane === null ? 'дороги' : 'полосы'}: зажмите и тяните вдоль`, ok: true };
          } else o.label = { text: 'Shift — снести кусок: наведите на дорогу', ok: true };
          break;
        }
        if (this.bulldozeMode === 'lane') {
          // Участок полосы под курсором (до ближайших стыков, как участок пути) — красным.
          const res = this.roadTools.laneBulldozePlan(p);
          if (!res) {
            o.label = { text: 'Наведите на полосу', ok: true };
            break;
          }
          o.lane = { corridor: res.corridor, lane: res.lane };
          o.label = res.plan.ok
            ? { text: `Снести участок полосы · +${money(-res.plan.cost)} · Shift — кусок`, ok: true }
            : { text: res.plan.reason ?? 'Нельзя', ok: false };
          break;
        }
        const st = g.structureAt(p);
        if (st?.type === 'warehouse') {
          const problem = g.warehouseRemoveProblem(st);
          o.marks.push({ fp: st.fp, ok: false });
          o.label = problem ? { text: problem, ok: false } : { text: `Снести склад · +${money(STORAGE.cost * COST.refundRatio)}`, ok: true };
          break;
        }
        if (st?.type === 'annex') {
          o.marks.push({ fp: st.fp, ok: false });
          o.label = { text: `Снести пристройку — производство упадёт · +${money(ANNEX.cost * COST.refundRatio)}`, ok: true };
          break;
        }
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
          break;
        }
        const road = this.roadTools.bulldozePlan(p, this.snapRadius * 0.3);
        if (road) {
          o.corridor = { id: road.corridor.id, color: 'red' };
          o.label = { text: `+${money(-road.plan.cost)}`, ok: true };
        }
        break;
      }
      case 'lights': {
        // Тянут угол выбранного перекрёстка — скругление, как в «Двигать»: новый бордюр, стоп-линии, цена, знак скорости.
        if (this.roadTools.corner) {
          this.moveDragOverlay(o, p, false);
          break;
        }
        const edit = o.laneEdit;
        // Ручки углов выбранного перекрёстка — у бордюров (метки полос — у стоп-линий; они главнее).
        const sel = this.selection;
        const corners = sel?.type === 'junction' ? this.roadTools.nodeCornerMarks(sel.id, (HANDLE_PX + 4) / this.camera.zoom) : [];
        o.handles = corners;
        const end = edit && this.laneAt(p, edit.ends);
        if (edit && end) {
          edit.hover = end;
          const active = this.activeLane(edit.ends);
          if (end.kind === 'in') o.label = { text: end.lane === active?.lane ? 'Снять выбор полосы' : 'Куда ведёт эта полоса', ok: true };
          else if (!active) o.label = { text: 'Сначала белый кружок — полоса въезда', ok: false };
          else if (!active.exits.includes(end.seg)) o.label = { text: 'С этой полосы сюда не проехать', ok: false };
          else {
            const linked = (g.roads.graph.movesFrom.get(active.lane) ?? []).some((m) => m.outLane === end.lane);
            o.label = { text: linked ? 'Убрать связь' : 'Соединить', ok: true };
          }
          break;
        }
        const corner = this.junctionCorner(p);
        if (corner) {
          this.cornerHover(o, corner, corners);
          break;
        }
        const n = this.junctionAt(p);
        if (n && edit?.node === n.id) {
          const round = corners.length ? ' · за угол у бордюра — скруглить поворот' : '';
          o.label = { text: `${edit.from ? 'Оранжевый кружок — куда ехать' : 'Белый кружок — полоса въезда'}${round}`, ok: true };
        } else if (n) {
          o.highlightNode = { pos: n.pos, ok: true, radius: 24 };
          o.label = { text: 'Настроить перекрёсток', ok: true };
        }
        break;
      }
      case 'template': {
        // Можно построить — развязка как построенная; нельзя — контуры кусков красным и причина.
        const plan = g.templatePlan(p, this.snapRadius, this.templateOptions());
        const name = TEMPLATES.find((t) => t.id === this.templateKind)!.name;
        if (plan.ok && plan.plan) {
          this.showRoadPlan(o, plan.plan, `${name}${plan.withTrunk ? ' вместе с магистралью (R — повернуть)' : ''} · ${money(plan.cost)}`);
        } else {
          if (plan.preview.length) o.template = { curves: plan.preview, ok: false };
          o.label = { text: failText(plan.reason, plan.cost, ''), ok: false };
        }
        break;
      }
      case 'copy': {
        // Рамка копирования: синим — что попадёт в копию (дороги, обрезанные по рамке, кольца целиком).
        const a = this.copyStart;
        if (!a) {
          o.label = { text: 'Обведите рамкой дороги и пути, которые нужно скопировать', ok: true };
          break;
        }
        const frag = this.copyPreview(a, p);
        o.frame = { pts: [a, { x: p.x, y: a.y }, p, { x: a.x, y: p.y }], ok: !!frag };
        if (frag) o.template = { curves: fragmentCurves(frag, { x: (a.x + p.x) / 2, y: (a.y + p.y) / 2 }, 0), ok: true };
        const what = frag && [frag.corridors.length && `${frag.corridors.length} уч. дорог`, frag.rail?.segs.length && `${frag.rail.segs.length} уч. путей`].filter(Boolean);
        o.label = frag ? { text: `Копировать ${what!.join(' и ')}`, ok: true } : { text: 'В рамке нет дорог и путей', ok: false };
        break;
      }
      case 'paste': {
        // Вставка: как построенная (дороги под рамкой заменятся); нельзя — контуры красным и причина.
        const frag = this.pasteSource();
        if (!frag) break;
        const pose = this.pastePose(frag, p);
        const plan = this.pastePlan(frag, pose.at, pose.angle);
        o.frame = { pts: frameOf(frag, pose.at, pose.angle), ok: plan.ok };
        if (plan.ok) {
          const deg = (((Math.round((pose.angle * 180) / Math.PI) % 360) + 360) % 360);
          this.showRoadPlan(o, plan, `Вставить · ${money(plan.cost)} · ${deg}°${pose.snapped ? (pose.on === 'rail' ? ' вдоль пути' : ' вдоль дороги') : ''}`);
          // Пути куска — как будущие пути (синим, с высотой).
          o.plans = plan.rails;
        } else {
          o.template = { curves: fragmentCurves(frag, pose.at, pose.angle), ok: false };
          o.label = { text: failText(plan.reason, plan.cost, 'Нельзя вставить'), ok: false };
        }
        break;
      }
      case 'signal': {
        const plan = g.signalPlan(p, this.snapRadius, this.signalOneWay);
        if (plan.ok && plan.pos && plan.dir) o.signal = { pos: plan.pos, dir: plan.dir, remove: !!plan.remove, oneWay: this.signalOneWay };
        const what = this.signalOneWay ? 'Сигнал без встречного' : 'Сигнал для поездов в эту сторону';
        o.label = plan.ok
          ? {
              text: plan.remove ? 'Снять сигнал' : plan.retype ? (this.signalOneWay ? 'Запретить встречное' : 'Разрешить встречное') : `${what} · ${money(plan.cost ?? 0)}`,
              ok: true,
            }
          : { text: failText(plan.reason, plan.cost, ''), ok: false };
        break;
      }
      case 'roundabout': {
        // Кольцо — как построенное (сеть плана), круг — его размер.
        const check = g.roundaboutPlan(p, this.snapRadius, this.ring);
        if (check.center) o.highlightNode = { pos: check.center, ok: check.ok, radius: check.r };
        if (check.ok && check.plan) this.showRoadPlan(o, check.plan, `Кольцо · ${money(check.cost)}`);
        else o.label = { text: failText(check.reason, check.cost, ''), ok: false };
        break;
      }
      case 'station': {
        const plan = g.stationPlan(p, this.snapRadius, this.stationKind, this.stationAngle, this.stationTracks, this.stationLength, this.stationTerminal);
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
        if (drive?.net) o.roads = { net: drive.net, ok: plan.ok, changed: drive.changed };
        const razed = [...(drive?.demolish ?? []), ...(plan.demolish ?? [])];
        for (const id of razed) {
          const b = g.buildingById(id);
          if (b) o.marks.push({ fp: b.fp, ok: false });
        }
        const free = plan.rail?.main ? ' · R — повернуть' : '';
        const raze = razed.length ? ` · снос ${razed.length} зд.` : '';
        // У предприятия станция сама становится грузовой — подпись показывает, какой она получится.
        const serves = plan.fp ? g.stationServesFor(plan.fp, this.stationKind, plan.industryId, this.newStationServes) : this.newStationServes;
        const what =
          this.stationKind === 'rail' ? (this.stationTerminal ? 'Конечная станция' : 'Ж/д станция') : this.stationKind === 'stop' ? 'Остановка' : stationTitle(serves);
        o.label = plan.ok ? { text: `${what} · ${money(plan.cost)}${raze}${free}`, ok: true } : { text: failText(plan.reason, plan.cost, ''), ok: false };
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
          ? { text: this.lineDraft.length >= 2 && st.id === this.lineDraft[0] ? 'Замкнуть маршрут' : `Добавить: ${st.name}`, ok: true }
          : { text: this.lineDraft.length ? 'Следующая станция · Enter — готово' : 'Выберите первую станцию', ok: true };
        break;
      }
      case 'select': {
        const home = this.placingWarehouse !== null ? g.stations.get(this.placingWarehouse) : undefined;
        if (home) {
          // Склад-здание: зона вокруг станции — кругом, здание под курсором — синим (красным, если нельзя).
          const plan = g.warehousePlan(home.id, p);
          o.catchmentAt = home.fp.center;
          o.catchmentR = warehouseZone(home);
          if (plan.fp) o.marks.push({ fp: plan.fp, ok: plan.ok });
          o.label = plan.ok
            ? { text: `Склад: +${STORAGE.per} ед. места · ${money(plan.cost)} · Esc — отмена`, ok: true }
            : { text: failText(plan.reason, plan.cost, ''), ok: false };
          break;
        }
        const ind = this.placingAnnex !== null ? g.industries.find((i) => i.id === this.placingAnnex) : undefined;
        if (ind) {
          // Пристройка: зона вокруг предприятия — кругом, пристройка под курсором — синим (красным, если нельзя).
          const plan = g.annexPlan(ind.id, p);
          o.catchmentAt = ind.fp.center;
          o.catchmentR = annexZone(ind);
          if (plan.fp) o.marks.push({ fp: plan.fp, ok: plan.ok });
          o.label = plan.ok
            ? { text: `Пристройка: производство ×${(ind.level ?? 1) + ECONOMY.growthStep}, рост до ×${growthCap(ind) + 1} · ${money(plan.cost)} · Esc — отмена`, ok: true }
            : { text: failText(plan.reason, plan.cost, ''), ok: false };
          break;
        }
        const moving = this.movingStation !== null ? g.stations.get(this.movingStation) : undefined;
        if (moving) {
          // Перенос станции: старое место — красным, новое — силуэтом (красным, если нельзя), с выездом и охватом.
          const plan = g.stationMovePlan(moving.id, p, this.snapRadius);
          o.marks.push({ fp: moving.fp, ok: false });
          if (plan.fp) {
            o.station = { fp: plan.fp, ok: plan.ok };
            o.catchmentAt = plan.fp.center;
            o.catchmentR = g.catchmentRadius(moving);
          }
          const drive = plan.driveway;
          if (drive?.net) o.roads = { net: drive.net, ok: plan.ok, changed: drive.changed };
          for (const id of [...(drive?.demolish ?? []), ...(plan.demolish ?? [])]) {
            const b = g.buildingById(id);
            if (b) o.marks.push({ fp: b.fp, ok: false });
          }
          const price = plan.cost < 0 ? `+${money(-plan.cost)}` : money(plan.cost);
          o.label = plan.ok ? { text: `Перенести сюда · ${price} · Esc — отмена`, ok: true } : { text: failText(plan.reason, plan.cost, ''), ok: false };
          break;
        }
        if (this.moving) {
          const plan = g.movePlan(this.moving, p);
          o.marks.push({ fp: this.moving.fp, ok: false });
          if (plan.fp) o.marks.push({ fp: plan.fp, ok: plan.ok });
          o.label = plan.ok
            ? { text: `Перенести сюда · ${money(plan.cost)} · Esc — отмена`, ok: true }
            : { text: failText(plan.reason, plan.cost, ''), ok: false };
          break;
        }
        // Значок предупреждения — причина одной строкой (клик — карточка с объяснением).
        const mark = this.markUnder(p);
        if (mark) {
          o.label = { text: mark.tip, ok: mark.level !== 'alert' };
          break;
        }
        const st = g.structureAt(p);
        if (st?.type === 'station') o.label = { text: st.name, ok: true };
        else if (st?.type === 'warehouse') o.label = { text: `Склад: ${g.stations.get(st.stationId)?.name ?? ''}`, ok: true };
        else if (st?.type === 'annex') o.label = { text: `Пристройка: ${g.industries.find((i) => i.id === st.industryId)?.name ?? ''}`, ok: true };
        else if (st?.type === 'industry') o.label = { text: st.name, ok: true };
        else if (st?.type === 'building') {
          const t = g.townOf(st);
          if (t) o.label = { text: t.name, ok: true };
        }
        // Карта скоростей включена: дорога под курсором — её скорость подписью у курсора, как высота.
        else if (this.speedmap) o.speedText = speedText(speedsUnder(g.roads.graph, (lane) => g.traffic.profile(lane), p));
        break;
      }
    }
    if (flash) o.label = { text: flash, ok: false };
    return o;
  }
}
