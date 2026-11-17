/**
 * Выбранный инструмент нижней панели и его режимы — в браузере (core/store, ключ 'roads.tool'): после перезагрузки
 * страницы выбрано то же, что было. Запоминаются только настройки инструментов (режим, тип дороги, форма, «Проект»
 * вкл/выкл, кисть…), но не то, что игрок делал ими: незаконченный проект, черновик маршрута, выделение, скопированный
 * кусок, высота (мост или тоннель) и повороты — с чистого листа. В первой партии (настроек ещё нет) «Дорога»
 * открывается с включённым «Проектом» — дальше он, как и всё остальное, такой, каким его оставил игрок.
 */
import { RAIL_STATION } from '../config';
import { asRecord, hasStore, readJson, readText, writeText } from '../core/store';
import type { DrawMode } from '../game/build';
import type { TemplateKind } from '../game/interchange';
import type { RingOptions, RingSize } from '../game/roads';
import { limitAllowed, MAX_LANES, ROAD_CLASS_IDS, ROAD_PRESETS, type RoadSpec, SPEED_LIMITS } from '../world/roadTypes';
import type { TerraformMode } from '../world/terrain';
import type { BrushSize, Controller, JunctionMode, RailMode, RoadMode, StationMode, Tool } from './controller';

export const TOOL_PREFS_KEY = 'roads.tool';

export type BulldozeMode = Controller['bulldozeMode'];

/** Проверка «одно из значений типа»: Record<T, 1> не даст пропустить новое значение (или вписать лишнее). */
const oneOf =
  <T extends string>(all: Record<T, 1>) =>
  (v: unknown): v is T =>
    typeof v === 'string' && Object.hasOwn(all, v);
const isFlag = (v: unknown): v is boolean => typeof v === 'boolean';
const intIn =
  (min: number, max: number, step = 1) =>
  (v: unknown): v is number =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max && (v as number) % step === 0;

const isTool = oneOf<Tool>({ select: 1, road: 1, rail: 1, lights: 1, roundabout: 1, station: 1, line: 1, bulldoze: 1, terrain: 1, industry: 1 });
const isRingSize = oneOf<RingSize>({ small: 1, medium: 1, large: 1 });
const R = RAIL_STATION;

/**
 * Настройки инструментов — поля Controller под теми же именами — и проверка значения из хранилища: незнакомое или
 * испорченное (правка руками, другая версия игры) — как по умолчанию, соседей не трогает. Новая настройка — строка здесь.
 */
const FIELDS = {
  roadMode: oneOf<RoadMode>({ build: 1, lane: 1, upgrade: 1, move: 1 }),
  drawMode: oneOf<DrawMode>({ straight: 1, arc: 1, curve: 1 }),
  railMode: oneOf<RailMode>({ track: 1, parallel: 1, station: 1, signal: 1, move: 1 }),
  railTracks: (v: unknown): v is 1 | 2 => v === 1 || v === 2,
  signalOneWay: isFlag,
  junctionMode: oneOf<JunctionMode>({ ring: 1, template: 1, copy: 1 }),
  templateKind: oneOf<TemplateKind>({ diamond: 1, tee: 1, clover: 1 }),
  ring: (v: unknown): v is RingOptions => intIn(1, 3)(asRecord(v).lanes) && isRingSize(asRecord(v).size),
  stationMode: oneOf<StationMode>({ cargo: 1, pax: 1, stop: 1, rail: 1, lot: 1 }),
  stationTracks: intIn(R.minTracks, R.maxTracks),
  stationLength: intIn(R.minLength, R.maxLength, R.lengthStep),
  bulldozeMode: oneOf<BulldozeMode>({ point: 1, area: 1, lane: 1 }),
  terrainMode: oneOf<TerraformMode>({ raise: 1, lower: 1, flatten: 1 }),
  brushSize: oneOf<BrushSize>({ small: 1, medium: 1, large: 1 }),
} satisfies { [K in keyof Controller]?: (v: unknown) => v is Controller[K] };

type Field = keyof typeof FIELDS;
const FIELD_KEYS = Object.keys(FIELDS) as Field[];

/** Что запоминаем: инструмент, тип дороги, «Проект» вкл/выкл у дороги и ж/д и настройки инструментов (FIELDS). */
export type ToolPrefs = { [K in Field]: Controller[K] } & {
  tool: Tool;
  /** Тип дороги ('' — свои полосы) и сама дорога: полосы и знак скорости. */
  presetId: string;
  spec: RoadSpec;
  /** «Проект» включён у дороги и у ж/д (сам проект не запоминается). */
  project: { road: boolean; rail: boolean };
};

/** Дорога из хранилища: класс, полосы (попутных — хотя бы одна) и знак скорости из набора, не быстрее класса; что-то не так — null. */
function parseSpec(v: unknown): RoadSpec | null {
  const s = asRecord(v);
  const cls = s.cls as RoadSpec['cls'];
  const { lanesF, lanesB, limit } = s;
  if (!ROAD_CLASS_IDS.includes(cls) || !intIn(1, MAX_LANES)(lanesF) || !intIn(0, MAX_LANES)(lanesB)) return null;
  const spec: RoadSpec = { cls, lanesF, lanesB };
  return SPEED_LIMITS.includes(limit as number) && limitAllowed(cls, limit as number) ? { ...spec, limit: limit as number } : spec;
}

/** Настройки из значения хранилища (JSON); каждое поле проверяется отдельно, неверное — из fallback. */
export function parseToolPrefs(data: unknown, fallback: ToolPrefs): ToolPrefs {
  const d = asRecord(data);
  const out = structuredClone(fallback);
  for (const k of FIELD_KEYS) if (FIELDS[k](d[k])) Object.assign(out, { [k]: d[k] });
  if (isTool(d.tool)) out.tool = d.tool;
  const project = asRecord(d.project);
  if (isFlag(project.road)) out.project.road = project.road;
  if (isFlag(project.rail)) out.project.rail = project.rail;
  // Тип дороги и её полосы: свои полосы ('') — только с дорогой; тип без дороги — дорога этого типа.
  const preset = ROAD_PRESETS.find((p) => p.id === d.presetId);
  const spec = parseSpec(d.spec);
  if (spec && (preset || d.presetId === '')) Object.assign(out, { presetId: preset?.id ?? '', spec });
  else if (preset) Object.assign(out, { presetId: preset.id, spec: { ...preset.spec } });
  return out;
}

/** Настройки из хранилища; нет их или хранилища — fallback. */
export function loadToolPrefs(fallback: ToolPrefs): ToolPrefs {
  return parseToolPrefs(readJson(TOOL_PREFS_KEY), fallback);
}

/** Запись в хранилище, только когда настройки изменились (Controller сообщает и о стройке, выборе, паузе…). */
export function toolPrefsWriter(): (prefs: ToolPrefs) => void {
  let last: string | null = null;
  return (prefs) => {
    const raw = JSON.stringify(prefs);
    if (raw === last) return;
    last = raw;
    writeText(TOOL_PREFS_KEY, raw);
  };
}

/** Что сейчас выбрано в Controller. «Маршрут → добавить станции» к своей линии — разовое дело: запоминаем «Выбор». */
export function toolPrefsOf(c: Controller): ToolPrefs {
  const fields = Object.fromEntries(FIELD_KEYS.map((k) => [k, c[k]])) as Pick<ToolPrefs, Field>;
  return structuredClone({
    ...fields,
    tool: c.tool === 'line' && c.addStopTo !== null ? 'select' : c.tool,
    presetId: c.presetId,
    spec: c.spec,
    project: c.projectTools.on,
  });
}

/** Выставляет настройки в Controller (при загрузке, пока ничего не начато) и выбирает инструмент. */
export function applyToolPrefs(c: Controller, prefs: ToolPrefs): void {
  const p = structuredClone(prefs);
  Object.assign(c, Object.fromEntries(FIELD_KEYS.map((k) => [k, p[k]])));
  c.presetId = p.presetId;
  c.spec = p.spec;
  Object.assign(c.projectTools.on, p.project);
  c.setTool(p.tool);
}

/**
 * Первая партия у игрока: настроек инструментов в хранилище ещё нет. Без хранилища — не первая: выключенный
 * «Проект» там не запомнить, и он навязывался бы при каждой загрузке.
 */
export function isFirstGame(): boolean {
  return hasStore() && readText(TOOL_PREFS_KEY) === null;
}

/**
 * Настройки по умолчанию: в первой партии «Дорога» открывается с «Проектом» — новичок сразу видит, что дорогу можно
 * сначала нарисовать, а построить потом. Дальше «Проект» — как запомнено: выключил сам — так и останется.
 */
export function defaultToolPrefs(base: ToolPrefs, firstGame: boolean): ToolPrefs {
  return firstGame ? { ...base, project: { ...base.project, road: true } } : base;
}

/** Инструмент и режимы — как в прошлый раз, и дальше запоминать каждую смену (подписка на Controller). */
export function rememberTools(c: Controller): void {
  applyToolPrefs(c, loadToolPrefs(defaultToolPrefs(toolPrefsOf(c), isFirstGame())));
  const write = toolPrefsWriter();
  // Сразу в хранилище: следующая загрузка — уже не первая партия, даже если игрок ничего не трогал.
  write(toolPrefsOf(c));
  c.listen(() => write(toolPrefsOf(c)));
}
