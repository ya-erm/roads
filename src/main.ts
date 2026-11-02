import './style.css';
import { Game } from './game/game';
import { clearSave, deleteSave, linkedSave, linkSave, listSaves, loadSave, readSave, saveGame, writeSave } from './game/persist';
import { Controller } from './input/controller';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';
import { Hud } from './ui/hud';
import { DEFAULT_SETTINGS, WorldSettings } from './world/settings';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud') as HTMLElement;

const params = new URLSearchParams(location.search);
const randomSeed = () => Math.floor(Math.random() * 1e9);

// Есть сохранение — продолжаем его. Новая игра начинается только по кнопке.
const saved = loadSave();
let game = saved
  ? new Game(saved.settings, saved)
  : new Game({ ...DEFAULT_SETTINGS, seed: Number(params.get('seed')) || randomSeed() });
if (saved && params.has('seed')) {
  params.delete('seed');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
}
// Сохранённая партия продолжается сразу, новая ждёт кнопку «Начать» в окне правил.
game.speed = saved ? 1 : 0;

const camera = new Camera();
const renderer = new Renderer(canvas, camera);
const controller = new Controller(canvas, camera, () => game);
const hud = new Hud(hudRoot, controller, () => game, {
  hasProgress: () => game.time > 0 || game.lines.size > 0 || game.net.version > 1 || game.canUndo,
  save: () => persist(true),
  newGame: (settings) => newGame(settings),
  linked: () => linkedSave(),
  list: () => listSaves(),
  saveAs: (name, id) => saveNamed(name, id),
  load: (id) => loadNamed(id),
  remove: (id) => deleteSave(id),
});

function persist(manual = false): void {
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
  game = new Game(data.settings, data);
  linkSave(id);
  restart();
  if (data.view) {
    camera.x = data.view.x;
    camera.y = data.view.y;
    camera.zoom = data.view.zoom;
    camera.touched = true;
  }
  persist();
  return true;
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

/** Начальный вид — крупнейший город. */
function initialView(): void {
  renderer.resize();
  const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
  if (town) {
    camera.x = town.center.x;
    camera.y = town.center.y;
    camera.zoom = Math.min(0.9, Math.max(0.35, (Math.min(camera.width, camera.height) * 0.45) / town.radius / 2));
  } else {
    camera.fit(game.terrain.width, game.terrain.height, 30);
  }
  camera.touched = false;
}

function newGame(settings: WorldSettings): void {
  clearSave();
  linkSave(null);
  game = new Game(settings);
  game.speed = 0;
  restart();
  persist();
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
if (!saved) {
  persist();
  hud.showWelcome();
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
