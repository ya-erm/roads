import type { Fragment } from '../lanes/fragment';

/** Свой шаблон развязки: скопированный кусок дорог под именем игрока. */
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

/** Сохраняет кусок как шаблон; null — не хватило места. */
export function saveTemplate(name: string, fragment: Fragment): UserTemplate | null {
  const t: UserTemplate = { id: `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, name, createdAt: Date.now(), fragment };
  return write([...listTemplates(), t]) ? t : null;
}

export function deleteTemplate(id: string): void {
  write(listTemplates().filter((t) => t.id !== id));
}
