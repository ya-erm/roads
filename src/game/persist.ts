import type { Camera } from '../render/camera';
import { Game, SAVE_VERSION, SaveData } from './game';

/** Слот сохранения: `?slot=имя` позволяет держать несколько независимых партий. */
const slot = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('slot') : null;
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
