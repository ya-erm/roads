/**
 * Выбранный инструмент нижней панели и его режимы — в браузере (localStorage): после перезагрузки страницы
 * выбрано то же, что было. Запоминаются только настройки инструментов (режим, тип дороги, форма, «Проект» вкл/выкл,
 * кисть…), но не то, что игрок делал ими: незаконченный проект, черновик маршрута, выделение, скопированный кусок,
 * высота (мост или тоннель) и повороты — с чистого листа. Без localStorage (тесты, приватный режим, переполненное
 * хранилище) ничего не запоминается — ошибок не бывает.
 */
import { RAIL_STATION } from '../config';
import type { DrawMode } from '../game/build';
import type { TemplateKind } from '../game/interchange';
import type { RingOptions, RingSize } from '../game/roads';
import { MAX_LANES, ROAD_CLASS_IDS, ROAD_PRESETS, type RoadSpec, SPEED_LIMITS } from '../world/roadTypes';
import type { TerraformMode } from '../world/terrain';
import type { BrushSize, Controller, JunctionMode, RailMode, RoadMode, StationMode, Tool } from './controller';

export const TOOL_PREFS_KEY = 'roads.tool';

export type BulldozeMode = Controller['bulldozeMode'];

/** Что запоминаем: инструмент и настройки каждого инструмента. */
export interface ToolPrefs {
  tool: Tool;
  roadMode: RoadMode;
  /** Тип дороги ('' — свои полосы) и сама дорога: полосы и знак скорости. */
  presetId: string;
  spec: RoadSpec;
  drawMode: DrawMode;
  /** «Проект» включён у дороги и у ж/д (сам проект не запоминается). */
  project: { road: boolean; rail: boolean };
  railMode: RailMode;
  railTracks: 1 | 2;
  signalOneWay: boolean;
  junctionMode: JunctionMode;
  templateKind: TemplateKind;
  ring: RingOptions;
  stationMode: StationMode;
  stationTracks: number;
  stationLength: number;
  bulldozeMode: BulldozeMode;
  terrainMode: TerraformMode;
  brushSize: BrushSize;
}

/** Все значения типа: Record<T, 1> не даст пропустить новое значение (или вписать лишнее). */
const ids = <T extends string>(all: Record<T, 1>): readonly T[] => Object.keys(all) as T[];

const TOOL_IDS = ids<Tool>({ select: 1, road: 1, rail: 1, lights: 1, roundabout: 1, station: 1, line: 1, bulldoze: 1, terrain: 1 });
const ROAD_MODES = ids<RoadMode>({ build: 1, lane: 1, upgrade: 1, move: 1 });
const DRAW_MODES = ids<DrawMode>({ straight: 1, arc: 1, curve: 1 });
const RAIL_MODES = ids<RailMode>({ track: 1, parallel: 1, station: 1, signal: 1, move: 1 });
const JUNCTION_MODES = ids<JunctionMode>({ ring: 1, template: 1, copy: 1 });
const TEMPLATE_KINDS = ids<TemplateKind>({ diamond: 1, tee: 1, clover: 1 });
const RING_SIZE_IDS = ids<RingSize>({ small: 1, medium: 1, large: 1 });
const STATION_MODES = ids<StationMode>({ cargo: 1, pax: 1, stop: 1, rail: 1 });
const BULLDOZE_MODES = ids<BulldozeMode>({ point: 1, area: 1, lane: 1 });
const TERRAIN_MODES = ids<TerraformMode>({ raise: 1, lower: 1, flatten: 1 });
const BRUSH_SIZE_IDS = ids<BrushSize>({ small: 1, medium: 1, large: 1 });

const oneOf = <T>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const flag = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const int = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Дорога из хранилища: класс, полосы (попутных — хотя бы одна) и знак скорости; что-то не так — null. */
function parseSpec(v: unknown): RoadSpec | null {
  const s = record(v);
  if (!ROAD_CLASS_IDS.includes(s.cls as RoadSpec['cls']) || !int(s.lanesF, 1, MAX_LANES) || !int(s.lanesB, 0, MAX_LANES)) return null;
  const spec: RoadSpec = { cls: s.cls as RoadSpec['cls'], lanesF: s.lanesF, lanesB: s.lanesB };
  return SPEED_LIMITS.includes(s.limit as number) ? { ...spec, limit: s.limit as number } : spec;
}

/**
 * Настройки из строки хранилища. Каждое поле проверяется отдельно: неизвестное или испорченное значение
 * (старая версия игры, правка руками) — берётся из fallback (так инструмент по умолчанию — «Выбор»).
 */
export function parseToolPrefs(raw: string | null, fallback: ToolPrefs): ToolPrefs {
  let data: Record<string, unknown> = {};
  try {
    data = record(raw ? JSON.parse(raw) : null);
  } catch {
    // Не JSON — всё по умолчанию.
  }
  const f = fallback;
  const preset = ROAD_PRESETS.find((p) => p.id === data.presetId);
  const spec = parseSpec(data.spec);
  // Тип дороги и её полосы: свои полосы ('') — только с дорогой; тип без дороги — дорога этого типа.
  const road =
    spec && (preset || data.presetId === '')
      ? { presetId: preset?.id ?? '', spec }
      : preset
        ? { presetId: preset.id, spec: { ...preset.spec } }
        : { presetId: f.presetId, spec: { ...f.spec } };
  const project = record(data.project);
  const ring = record(data.ring);
  const R = RAIL_STATION;
  const length = data.stationLength;
  return {
    tool: oneOf(TOOL_IDS, data.tool, f.tool),
    roadMode: oneOf(ROAD_MODES, data.roadMode, f.roadMode),
    ...road,
    drawMode: oneOf(DRAW_MODES, data.drawMode, f.drawMode),
    project: { road: flag(project.road, f.project.road), rail: flag(project.rail, f.project.rail) },
    railMode: oneOf(RAIL_MODES, data.railMode, f.railMode),
    railTracks: data.railTracks === 1 || data.railTracks === 2 ? data.railTracks : f.railTracks,
    signalOneWay: flag(data.signalOneWay, f.signalOneWay),
    junctionMode: oneOf(JUNCTION_MODES, data.junctionMode, f.junctionMode),
    templateKind: oneOf(TEMPLATE_KINDS, data.templateKind, f.templateKind),
    ring: { lanes: int(ring.lanes, 1, 3) ? ring.lanes : f.ring.lanes, size: oneOf(RING_SIZE_IDS, ring.size, f.ring.size) },
    stationMode: oneOf(STATION_MODES, data.stationMode, f.stationMode),
    stationTracks: int(data.stationTracks, R.minTracks, R.maxTracks) ? data.stationTracks : f.stationTracks,
    stationLength: int(length, R.minLength, R.maxLength) && length % R.lengthStep === 0 ? length : f.stationLength,
    bulldozeMode: oneOf(BULLDOZE_MODES, data.bulldozeMode, f.bulldozeMode),
    terrainMode: oneOf(TERRAIN_MODES, data.terrainMode, f.terrainMode),
    brushSize: oneOf(BRUSH_SIZE_IDS, data.brushSize, f.brushSize),
  };
}

export const serializeToolPrefs = (prefs: ToolPrefs): string => JSON.stringify(prefs);

type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): PrefsStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Настройки из хранилища; нет их или хранилища — fallback. */
export function loadToolPrefs(fallback: ToolPrefs, storage: PrefsStorage | null = browserStorage()): ToolPrefs {
  try {
    return parseToolPrefs(storage?.getItem(TOOL_PREFS_KEY) ?? null, fallback);
  } catch {
    return fallback;
  }
}

/** Запись в хранилище, только когда настройки изменились (onChange зовут и на стройку, выбор, паузу…). */
export function toolPrefsWriter(storage: PrefsStorage | null = browserStorage()): (prefs: ToolPrefs) => void {
  let last: string | null = null;
  return (prefs) => {
    const raw = serializeToolPrefs(prefs);
    if (raw === last) return;
    last = raw;
    try {
      storage?.setItem(TOOL_PREFS_KEY, raw);
    } catch {
      // Хранилище переполнено или недоступно — просто не запоминаем.
    }
  };
}

/** Что сейчас выбрано в Controller. «Маршрут → добавить станции» к своей линии — разовое дело: запоминаем «Выбор». */
export function toolPrefsOf(c: Controller): ToolPrefs {
  return {
    tool: c.tool === 'line' && c.addStopTo !== null ? 'select' : c.tool,
    roadMode: c.roadMode,
    presetId: c.presetId,
    spec: { ...c.spec },
    drawMode: c.drawMode,
    project: { ...c.projectTools.on },
    railMode: c.railMode,
    railTracks: c.railTracks,
    signalOneWay: c.signalOneWay,
    junctionMode: c.junctionMode,
    templateKind: c.templateKind,
    ring: { ...c.ring },
    stationMode: c.stationMode,
    stationTracks: c.stationTracks,
    stationLength: c.stationLength,
    bulldozeMode: c.bulldozeMode,
    terrainMode: c.terrainMode,
    brushSize: c.brushSize,
  };
}

/** Выставляет настройки в Controller (при загрузке, пока ничего не начато) и выбирает инструмент. */
export function applyToolPrefs(c: Controller, p: ToolPrefs): void {
  c.roadMode = p.roadMode;
  c.presetId = p.presetId;
  c.spec = { ...p.spec };
  c.drawMode = p.drawMode;
  c.projectTools.on.road = p.project.road;
  c.projectTools.on.rail = p.project.rail;
  c.railMode = p.railMode;
  c.railTracks = p.railTracks;
  c.signalOneWay = p.signalOneWay;
  c.junctionMode = p.junctionMode;
  c.templateKind = p.templateKind;
  c.ring = { ...p.ring };
  c.stationMode = p.stationMode;
  c.stationTracks = p.stationTracks;
  c.stationLength = p.stationLength;
  c.bulldozeMode = p.bulldozeMode;
  c.terrainMode = p.terrainMode;
  c.brushSize = p.brushSize;
  c.setTool(p.tool);
}

/**
 * Инструмент и режимы — как в прошлый раз, и дальше запоминать каждую смену. Звать после Hud: он задаёт
 * controller.onChange, а запись встаёт следом за ним.
 */
export function rememberTools(c: Controller, storage: PrefsStorage | null = browserStorage()): void {
  applyToolPrefs(c, loadToolPrefs(toolPrefsOf(c), storage));
  const write = toolPrefsWriter(storage);
  const sync = c.onChange;
  c.onChange = () => {
    sync();
    write(toolPrefsOf(c));
  };
}
