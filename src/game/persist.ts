import type { Camera } from '../render/camera';
import { testPageName } from '../testpages/route';
import { Game, SAVE_VERSION, SaveData } from './game';

/**
 * Слот сохранения: `?slot=имя` позволяет держать несколько независимых партий. У тестовой страницы
 * (/test/bus) свой слот «test-bus»: что бы там ни сохраняли, обычную партию это не трогает.
 */
const slot = typeof location !== 'undefined' ? (new URLSearchParams(location.search).get('slot') ?? testSlot(location.pathname)) : null;
function testSlot(pathname: string): string | null {
  const page = testPageName(pathname);
  return page ? `test-${page}` : null;
}
const KEY = slot ? `razvyazka-save:${slot}` : 'razvyazka-save';

/** Сохраняет игру в localStorage. Возвращает false, если места не хватило. */
export function saveGame(game: Game, camera?: Camera): boolean {
  try {
    const data = game.toSave();
    if (camera) data.view = { x: camera.x, y: camera.y, zoom: camera.zoom };
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    if (data.version === SAVE_VERSION) return data;
    // Сохранение другой версии не грузим, но и не затираем: откладываем в отдельный ключ.
    const backup = `${KEY}:v${data.version}`;
    if (!localStorage.getItem(backup)) localStorage.setItem(backup, raw);
    return null;
  } catch {
    return null;
  }
}

export function hasSave(): boolean {
  return loadSave() !== null;
}

export function clearSave(): void {
  localStorage.removeItem(KEY);
}

// ---------- Сохранения со своими именами ----------
//
// Текущая партия автоматически пишется в localStorage (выше). Сохранения со своими именами — в IndexedDB:
// там места много больше. Карточки (имя, дата, сводка) и сами данные — в разных хранилищах,
// чтобы список открывался сразу, даже если партии большие.

export interface SaveEntry {
  id: string;
  name: string;
  /** Когда сохранили (Date.now()). */
  savedAt: number;
  /** «Мар 1963 · $1 200 000 · 6 городов». */
  summary: string;
  version: number;
}

const DB_NAME = slot ? `razvyazka:${slot}` : 'razvyazka';
const META = 'meta';
const DATA = 'data';
/** Какому сохранению со своим именем принадлежит текущая партия: «Сохранить» перезапишет его. */
const LINK_KEY = `${KEY}:linked`;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Сохранения со своими именами — сначала свежие. */
export async function listSaves(): Promise<SaveEntry[]> {
  const db = await openDb();
  const all = await result(db.transaction(META).objectStore(META).getAll() as IDBRequest<SaveEntry[]>);
  db.close();
  return all.sort((a, b) => b.savedAt - a.savedAt);
}

/** Пишет партию под именем name (id — перезаписать это сохранение). */
export async function writeSave(game: Game, name: string, camera?: Camera, id?: string): Promise<SaveEntry> {
  const data = game.toSave();
  if (camera) data.view = { x: camera.x, y: camera.y, zoom: camera.zoom };
  const money = `$${Math.round(game.money).toLocaleString('ru-RU')}`;
  const entry: SaveEntry = {
    id: id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: name.trim() || 'Без имени',
    savedAt: Date.now(),
    summary: `${game.dateLabel} · ${money} · ${game.towns.length} городов`,
    version: SAVE_VERSION,
  };
  const db = await openDb();
  const tx = db.transaction([META, DATA], 'readwrite');
  tx.objectStore(META).put(entry);
  tx.objectStore(DATA).put(data, entry.id);
  await done(tx);
  db.close();
  return entry;
}

export async function readSave(id: string): Promise<SaveData | null> {
  const db = await openDb();
  const data = await result(db.transaction(DATA).objectStore(DATA).get(id) as IDBRequest<SaveData | undefined>);
  db.close();
  return data && data.version === SAVE_VERSION ? data : null;
}

export async function deleteSave(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([META, DATA], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(DATA).delete(id);
  await done(tx);
  db.close();
  if (linkedSave() === id) linkSave(null);
}

/** Сохранение, которому принадлежит текущая партия. */
export function linkedSave(): string | null {
  return localStorage.getItem(LINK_KEY);
}

export function linkSave(id: string | null): void {
  if (id) localStorage.setItem(LINK_KEY, id);
  else localStorage.removeItem(LINK_KEY);
}
