import './style.css';
import { Game, SAVE_VERSION, type SaveData } from './game/game';
import { journalFile } from './game/journal';
import { backupGame, clearSave, deleteSave, linkedSave, linkSave, listSaves, loadSave, readSave, saveGame, writeSave } from './game/persist';
import { saveFileText } from './game/saveFile';
import { Controller } from './input/controller';
import { rememberTools } from './input/toolPrefs';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { ARCHETYPE_LIST } from './scenario/content';
import type { ScenarioSettings } from './scenario/types';
import { testScene } from './testpages';
import { installBugReport } from './ui/bugReport';
import { Hud } from './ui/hud';
import { DEFAULT_SETTINGS, WorldSettings } from './world/settings';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud') as HTMLElement;

const params = new URLSearchParams(location.search);
const randomSeed = () => Math.floor(Math.random() * 1e9);

/**
 * Быстрый запуск сценария для проверки: `?scenario=easy|normal|hard` (и необязательно `&seed=`, `&pick=industrial`,
 * `&challenge=1`) — если сохранения нет, сразу сценарная партия. Отдельный слот — `&slot=имя`.
 */
function quickScenario(): ScenarioSettings | undefined {
  const d = params.get('scenario');
  if (d !== 'easy' && d !== 'normal' && d !== 'hard') return undefined;
  const pick = ARCHETYPE_LIST.find((a) => a.id === params.get('pick'))?.id;
  const challenge = params.get('challenge') === '1';
  return pick ? { difficulty: d, challenge, pick } : { difficulty: d, challenge };
}

// Тестовая страница (/test/bus): вместо сохранения — заранее собранная сцена, перезагрузка собирает её заново.
// Автосохранения там нет, а сохранить вручную можно только в её собственный слот (см. persist).
const scene = testScene(location.pathname);
// Есть сохранение — продолжаем его. Новая игра начинается только по кнопке.
const saved = scene ? null : loadSave();
const quick = quickScenario();
let game = scene
  ? scene.game
  : saved
    ? new Game(saved.settings, saved)
    : new Game({ ...DEFAULT_SETTINGS, seed: Number(params.get('seed')) || randomSeed(), ...(quick ? { scenario: quick } : {}) });
// Партия из сохранения: параметры новой игры в адресе уже ни при чём — убираем их, чтобы не путали.
const startParams = ['seed', 'scenario', 'pick', 'challenge'];
if (saved && startParams.some((p) => params.has(p))) {
  for (const p of startParams) params.delete(p);
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
}
// Сохранённая партия (и сцена) продолжается сразу, новая ждёт кнопку «Начать» в окне правил или в брифинге сценария.
game.speed = saved || scene ? 1 : 0;

const camera = new Camera();
const renderer = new Renderer(canvas, camera);
const controller = new Controller(canvas, camera, () => game);
// Кнопка баг-репорта — поверх всего, и окон тоже. Ставится раньше панелей: пока открыт редактор пометок,
// его клавиши (Esc, Delete, буквы инструментов) перехватываются до игровых.
installBugReport({ canvas, game: () => game, saveText: () => saveText(), journalText: () => journalFile(game) });
const hasProgress = () => game.time > 0 || game.lines.size > 0 || game.net.version > 1 || game.canUndo;
const hud = new Hud(hudRoot, controller, () => game, {
  hasProgress,
  save: () => persist(true),
  newGame: (settings, force) => newGame(settings, force),
  linked: () => linkedSave(),
  list: () => listSaves(),
  saveAs: (name, id) => saveNamed(name, id),
  load: (id) => loadNamed(id),
  remove: (id) => deleteSave(id),
  exportFile: () => exportFile(),
  exportJournal: () => exportJournal(),
  importFile: (file) => importFile(file),
});
// Инструмент и его режимы — как до перезагрузки. Тестовая сцена всегда начинает с «Выбора» и выбор в ней
// не запоминается: снимки сцены не зависят от того, что выбрано в обычной игре, и наоборот.
if (!scene) rememberTools(controller);

function persist(manual = false): void {
  if (scene && !manual) return;
  const ok = saveGame(game, camera);
  if (manual) game.notify(ok ? 'Игра сохранена' : 'Не удалось сохранить: мало места в браузере', ok ? undefined : '#e5534b');
}

/** Сохраняет партию под именем (id — перезаписать это сохранение); партия теперь принадлежит ему. */
async function saveNamed(name: string, id?: string): Promise<boolean> {
  try {
    const entry = await writeSave(game, name, camera, id);
    linkSave(entry.id);
    persist();
    game.notify(`Сохранено: «${entry.name}»`);
    return true;
  } catch {
    game.notify('Не удалось сохранить: мало места в браузере', '#e5534b');
    return false;
  }
}

/** Загружает сохранение со своим именем вместо текущей партии. */
async function loadNamed(id: string): Promise<boolean> {
  const data = await readSave(id).catch(() => null);
  if (!data) {
    game.notify('Это сохранение не открыть: оно от другой версии игры', '#e5534b');
    return false;
  }
  open(data);
  linkSave(id);
  persist();
  return true;
}

/** Партия файлом — с видом камеры: «Сохранить в файл» и баг-репорт. */
function saveText(): string {
  const data = game.toSave();
  data.view = { x: camera.x, y: camera.y, zoom: camera.zoom };
  return JSON.stringify(data);
}

/** Скачивает текущую партию файлом: «razvyazka-Мар-1963.json». */
function exportFile(): void {
  download(saveText(), 'application/json', `razvyazka-${game.dateLabel.replace(/\s+/g, '-')}.json`);
}

/** Скачивает журнал партии (JSON Lines): «razvyazka-journal-12345-Мар-1963.jsonl». */
function exportJournal(): void {
  download(journalFile(game), 'application/x-ndjson', `razvyazka-journal-${game.seed}-${game.dateLabel.replace(/\s+/g, '-')}.jsonl`);
}

function download(text: string, type: string, name: string): void {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Открывает партию из файла вместо текущей (своё имя у неё — только если сохранить её под именем). */
async function importFile(file: File): Promise<boolean> {
  let data: SaveData;
  try {
    data = JSON.parse(await saveFileText(file)) as SaveData;
  } catch {
    game.notify('Это не файл сохранения игры', '#e5534b');
    return false;
  }
  if (data.version !== SAVE_VERSION) {
    game.notify('Это сохранение не открыть: оно от другой версии игры', '#e5534b');
    return false;
  }
  open(data);
  linkSave(null);
  persist();
  game.notify('Партия открыта из файла');
  return true;
}

/** Партия из сохранения вместо текущей: игра, панели и вид камеры. */
function open(data: SaveData): void {
  game = new Game(data.settings, data);
  restart();
  if (data.view) {
    camera.x = data.view.x;
    camera.y = data.view.y;
    camera.zoom = data.view.zoom;
    camera.touched = true;
  }
}

/** Новая или загруженная партия: сбросить управление, отрисовку и панели. */
function restart(): void {
  controller.reset();
  renderer.reset();
  hud.reset();
  initialView();
  hookAutosave();
}

function hookAutosave(): void {
  game.onMonthEnd = () => persist();
}

/** Начальный вид — крупнейший город (у тестовой сцены — вся сцена). */
function initialView(): void {
  renderer.resize();
  const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
  if (scene && game === scene.game) {
    // Сверху — панель с деньгами и датой (и подписи участков над улицами), снизу — инструменты: кадр между ними.
    const { x0, y0, x1, y1 } = scene.view;
    const top = 100;
    const bottom = 130;
    camera.x = (x0 + x1) / 2;
    camera.zoom = Math.max(camera.minZoom, Math.min(1.2, (camera.width - 60) / (x1 - x0), (camera.height - top - bottom) / (y1 - y0)));
    camera.y = (y0 + y1) / 2 + (bottom - top) / 2 / camera.zoom;
  } else if (town) {
    camera.x = town.center.x;
    camera.y = town.center.y;
    camera.zoom = Math.min(0.9, Math.max(0.35, (Math.min(camera.width, camera.height) * 0.45) / town.radius / 2));
  } else {
    camera.fit(game.terrain.width, game.terrain.height, 30);
  }
  camera.touched = false;
}

/**
 * Новая партия вместо текущей — сразу, без вопросов: текущая, если в ней что-то сделано, сначала уходит
 * в сохранения (резервной копией или поверх своего сохранения). Не сохранилась — новая не начинается
 * и возвращается false; force — начать и так.
 */
async function newGame(settings: WorldSettings, force = false): Promise<boolean> {
  if (hasProgress() && !scene) {
    const kept = await backupGame(game, linkedSave(), camera).catch(() => null);
    if (!kept && !force) {
      game.notify('Не удалось сохранить текущую партию: мало места в браузере', '#e5534b');
      return false;
    }
  }
  clearSave();
  linkSave(null);
  game = new Game(settings);
  game.speed = 0;
  restart();
  persist();
  return true;
}

window.addEventListener('resize', () => {
  if (camera.touched) renderer.resize();
  else initialView();
});
initialView();
if (saved?.view) {
  camera.x = saved.view.x;
  camera.y = saved.view.y;
  camera.zoom = saved.view.zoom;
  camera.touched = true;
}
hookAutosave();
if (!saved && !scene) {
  persist();
  // Первый запуск: стартовый экран, «Начать» на нём открывает «Новую игру» (сценарий — по умолчанию).
  hud.showWelcome(true);
}
// Сохраняемся, когда вкладку прячут или закрывают.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persist();
});
window.addEventListener('pagehide', () => persist());

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  controller.update(dt);
  game.update(dt);
  renderer.draw(game, controller.overlay());
  hud.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Для отладки из консоли.
Object.assign(window, { camera, controller });
Object.defineProperty(window, 'game', { get: () => game, configurable: true });
if (scene) {
  // id линий сцены по названиям участков: game.lines.get(scene.lines.bay) и т. п.
  Object.assign(window, { scene: { lines: scene.lines } });
  console.info('window.scene =', { lines: scene.lines });
  for (const e of scene.errors) console.error(`Сцена: ${e}`);
}
