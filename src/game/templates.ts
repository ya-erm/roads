import type { Cubic } from '../core/bezier';
import type { Vec } from '../core/vec';
import type { Fragment } from '../lanes/fragment';
import { ROAD_CLASS_IDS } from '../world/roadTypes';

/** Свой шаблон развязки: скопированный кусок дорог (и путей) под именем игрока. */
export interface UserTemplate {
  id: string;
  name: string;
  /** Когда сохранили (Date.now()). */
  createdAt: number;
  fragment: Fragment;
}

/** Шаблоны общие для всех партий (у слота `?slot=имя` — свои). */
const slot = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('slot') : null;
const KEY = slot ? `razvyazka-templates:${slot}` : 'razvyazka-templates';

let cache: UserTemplate[] | null = null;
let serial = 0;

export function listTemplates(): UserTemplate[] {
  if (cache) return cache;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    cache = raw ? (JSON.parse(raw) as UserTemplate[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function getTemplate(id: string): UserTemplate | null {
  return listTemplates().find((t) => t.id === id) ?? null;
}

function write(list: UserTemplate[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    cache = list;
    return true;
  } catch {
    return false;
  }
}

const newId = () => `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}${(serial++).toString(36)}`;

/** Сохраняет кусок как шаблон; null — не хватило места. */
export function saveTemplate(name: string, fragment: Fragment): UserTemplate | null {
  const t: UserTemplate = { id: newId(), name, createdAt: Date.now(), fragment };
  return write([...listTemplates(), t]) ? t : null;
}

export function deleteTemplate(id: string): void {
  write(listTemplates().filter((t) => t.id !== id));
}

/** Есть ли в шаблоне ж/д пути. */
export const hasRail = (frag: Fragment): boolean => !!frag.rail?.segs.length;

// ---------- Файл шаблонов ----------

/** Файл шаблонов: метка «чей он» и версия формата (растёт, когда формат меняется несовместимо). */
export const TEMPLATE_FILE_KIND = 'razvyazka-templates';
export const TEMPLATE_FILE_VERSION = 1;

/** Шаблон в файле — без id: при открытии получает новый. */
export type TemplateEntry = Pick<UserTemplate, 'name' | 'createdAt' | 'fragment'>;

export interface TemplateFile {
  kind: typeof TEMPLATE_FILE_KIND;
  version: number;
  templates: TemplateEntry[];
}

/** Текст файла с шаблонами — с одним или со всеми сразу. */
export function templatesToFile(list: TemplateEntry[]): string {
  const file: TemplateFile = {
    kind: TEMPLATE_FILE_KIND,
    version: TEMPLATE_FILE_VERSION,
    templates: list.map(({ name, createdAt, fragment }) => ({ name, createdAt, fragment })),
  };
  return JSON.stringify(file);
}

/** Имя файла по названию шаблона: без знаков, которых не бывает в именах файлов. */
export function templateFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${safe || 'Шаблон'}.json`;
}

/** Имя шаблона, когда игрок не ввёл своё. */
export const DEFAULT_TEMPLATE_NAME = 'Моя развязка';

/**
 * Скопированный кусок — файлом шаблона, не заходя в свои: имя файла и текст в том же формате,
 * что «Скачать шаблон файлом», — открывается обратно «Открыть шаблоны из файла». Пустое имя — «Моя развязка».
 */
export function fragmentToFile(name: string, fragment: Fragment, createdAt = Date.now()): { fileName: string; text: string } {
  const title = name.trim().slice(0, 40) || DEFAULT_TEMPLATE_NAME;
  return { fileName: templateFileName(title), text: templatesToFile([{ name: title, createdAt, fragment }]) };
}

/** Имя, которого ещё нет: «Ромб», «Ромб (2)», «Ромб (3)»… */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(name)) return name;
  for (let k = 2; ; k++) if (!used.has(`${name} (${k})`)) return `${name} (${k})`;
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isVec = (x: unknown): x is Vec => isObj(x) && isNum(x.x) && isNum(x.y);
const isCubic = (x: unknown): x is Cubic => isObj(x) && ['p0', 'p1', 'p2', 'p3'].every((k) => isVec(x[k]));
const allOf = <T>(x: unknown, ok: (v: unknown) => v is T): x is T[] => Array.isArray(x) && x.every(ok);
const isNums = (x: unknown): x is number[] => allOf(x, isNum);
const isStrs = (x: unknown): x is string[] => allOf(x, (v): v is string => typeof v === 'string');
const optional = (x: unknown, ok: (v: unknown) => boolean) => x === undefined || ok(x);

/** Кусок из файла можно вставить: формы, узлы и ссылки на них целы. Чужое и битое — false (без исключений). */
export function isFragment(x: unknown): x is Fragment {
  if (!isObj(x) || !isVec(x.half) || x.half.x <= 0 || x.half.y <= 0 || !Array.isArray(x.nodes) || !Array.isArray(x.corridors)) return false;
  const nodes = new Set<number>();
  for (const n of x.nodes) {
    if (!isObj(n) || !isNum(n.id) || nodes.has(n.id) || (n.kind !== 'seam' && n.kind !== 'junction') || !isVec(n.pos) || !isVec(n.dir) || !isNum(n.level)) return false;
    const settings =
      optional(n.control, (v) => v === 'lights') &&
      optional(n.mainPair, (v) => v === null || isNums(v)) &&
      optional(n.bans, isStrs) &&
      optional(n.greens, isNums) &&
      optional(n.adaptive, (v) => typeof v === 'boolean') &&
      optional(n.roundabout, (v) => v === null || isNum(v)) &&
      optional(n.lanes, isStrs) &&
      optional(n.corners, (v) => isObj(v) && Object.values(v).every((r) => isNum(r) && r >= 0));
    if (!settings) return false;
    nodes.add(n.id);
  }
  const corridors = new Set<number>();
  for (const c of x.corridors) {
    if (!isObj(c) || !isNum(c.id) || corridors.has(c.id) || !nodes.has(c.a as number) || !nodes.has(c.b as number)) return false;
    if (!isNum(c.portA) || !isNum(c.portB) || !isCubic(c.curve) || !isNum(c.length) || c.length <= 0) return false;
    if (!ROAD_CLASS_IDS.includes(c.cls as never) || !optional(c.ring, (v) => typeof v === 'boolean') || !optional(c.limit, isNum)) return false;
    const lane = (l: unknown) => isObj(l) && isNum(l.offset) && (l.flow === 1 || l.flow === -1) && isNum(l.from) && isNum(l.to) && optional(l.solid, (v) => typeof v === 'boolean');
    if (!Array.isArray(c.lanes) || !c.lanes.length || !c.lanes.every(lane)) return false;
    corridors.add(c.id);
  }
  if (x.rail !== undefined) {
    const r = x.rail;
    if (!isObj(r) || !Array.isArray(r.nodes) || !Array.isArray(r.segs)) return false;
    const ids = new Set<number>();
    for (const n of r.nodes) {
      if (!isObj(n) || !isNum(n.id) || ids.has(n.id) || !isVec(n.pos) || !isNum(n.level) || !optional(n.signals, isNums) || !optional(n.oneWay, isNums)) return false;
      ids.add(n.id);
    }
    const segs = new Set<number>();
    for (const s of r.segs) {
      if (!isObj(s) || !isNum(s.id) || segs.has(s.id) || !ids.has(s.a as number) || !ids.has(s.b as number) || s.a === s.b || !isCubic(s.curve)) return false;
      if (!isObj(s.spec) || s.spec.cls !== 'rail' || !isNum(s.spec.lanesF) || !isNum(s.spec.lanesB)) return false;
      segs.add(s.id);
    }
  }
  return x.corridors.length > 0 || hasRail(x as unknown as Fragment);
}

/** Что вышло из файла: шаблоны (битые пропущены — сколько, в skipped) или понятная причина, почему не открыть. */
export type ParsedTemplates = { templates: TemplateEntry[]; skipped: number } | { error: string };

export function parseTemplateFile(text: string): ParsedTemplates {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'Это не файл шаблонов развязок' };
  }
  if (isObj(data) && data.kind !== TEMPLATE_FILE_KIND && 'settings' in data && 'version' in data) {
    return { error: 'Это файл партии, а не шаблонов — его открывают в меню' };
  }
  if (!isObj(data) || data.kind !== TEMPLATE_FILE_KIND || !isNum(data.version) || !Array.isArray(data.templates)) {
    return { error: 'Это не файл шаблонов развязок' };
  }
  if (data.version > TEMPLATE_FILE_VERSION) return { error: 'Шаблоны из более новой версии игры — обновите игру' };
  const templates: TemplateEntry[] = [];
  for (const t of data.templates) {
    if (!isObj(t) || !isFragment(t.fragment)) continue;
    const name = typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 40) : 'Шаблон';
    templates.push({ name, createdAt: isNum(t.createdAt) ? t.createdAt : Date.now(), fragment: t.fragment });
  }
  const skipped = data.templates.length - templates.length;
  if (!templates.length) return { error: 'В файле нет шаблонов, которые можно открыть' };
  return { templates, skipped };
}

/** Добавляет шаблоны в свои: имя занято — с суффиксом «(2)», не вместо. null — не хватило места. */
export function addTemplates(list: TemplateEntry[]): UserTemplate[] | null {
  const all = [...listTemplates()];
  const added: UserTemplate[] = [];
  for (const t of list) {
    const u: UserTemplate = { id: newId(), name: uniqueName(t.name, all.map((x) => x.name)), createdAt: t.createdAt, fragment: t.fragment };
    all.push(u);
    added.push(u);
  }
  return write(all) ? added : null;
}
