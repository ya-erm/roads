import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { Game } from '../game/game';
import { Camera } from '../render/camera';
import { Controller } from './controller';

/** Ctrl/Cmd+Z — шаг назад, Ctrl/Cmd+Y и Ctrl/Cmd+Shift+Z — повтор: и стройки, и шагов правки проекта. */

type Handler = (e: unknown) => void;

/** Подписки на события — вместо окна и холста (тесты идут без браузера). */
class Events {
  private readonly map = new Map<string, Handler[]>();
  addEventListener(type: string, h: Handler): void {
    this.map.set(type, [...(this.map.get(type) ?? []), h]);
  }
  fire(type: string, e: unknown): void {
    for (const h of this.map.get(type) ?? []) h(e);
  }
}

const win = new Events();
const saved = { window: (globalThis as Record<string, unknown>).window, input: (globalThis as Record<string, unknown>).HTMLInputElement };

beforeAll(() => {
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).HTMLInputElement = class {};
});

afterAll(() => {
  (globalThis as Record<string, unknown>).window = saved.window;
  (globalThis as Record<string, unknown>).HTMLInputElement = saved.input;
});

/** Партия и чистое поле: рядом ни дорог, ни препятствий. */
function setup(): { game: Game; at: (x: number, y: number) => Vec } {
  const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
  for (let y = 500; y < game.terrain.height - 600; y += 150) {
    for (let x = 500; x < game.terrain.width - 900; x += 150) {
      const c = { x: x + 300, y: y + 100 };
      if (!game.roads.net.corridorsNear(c, 500).length && !game.blocked(c, 450)) return { game, at: (dx, dy) => ({ x: x + dx, y: y + dy }) };
    }
  }
  throw new Error('Нет места');
}

/** Инструмент «Дорога» с мышью и клавиатурой; камера — один пиксель экрана на метр мира, начало в нуле. */
function play(game: Game) {
  const canvas = new Events();
  const camera = new Camera();
  camera.width = 0;
  camera.height = 0;
  const c = new Controller(canvas as unknown as HTMLCanvasElement, camera, () => game);
  const mouse = (p: Vec) => ({ clientX: p.x, clientY: p.y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, target: canvas, preventDefault() {} });
  const key = (code: string, extra: Record<string, unknown> = {}) =>
    win.fire('keydown', { code, key: code.replace(/^Key/, '').toLowerCase(), ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault() {}, ...extra });
  const click = (p: Vec) => {
    canvas.fire('mousedown', mouse(p));
    win.fire('mouseup', mouse(p));
  };
  c.setTool('road');
  c.setRoadMode('build');
  c.setPreset('street');
  return { c, click, key };
}

describe('Повтор (Ctrl+Y, Ctrl+Shift+Z)', () => {
  it('стройку повторяют и Ctrl+Y, и Ctrl+Shift+Z, и Cmd+Y на macOS', () => {
    const { game, at } = setup();
    const { click, key } = play(game);
    const corridors = game.roads.net.corridors.size;
    click(at(0, 0));
    click(at(300, 0));
    key('Escape', { key: 'Escape' });
    expect(game.roads.net.corridors.size).toBe(corridors + 1);
    const money = game.money;
    for (const redo of [{ code: 'KeyY', ctrlKey: true }, { code: 'KeyZ', ctrlKey: true, shiftKey: true }, { code: 'KeyY', metaKey: true }, { code: 'KeyZ', metaKey: true, shiftKey: true }]) {
      key('KeyZ', { ctrlKey: true });
      expect(game.roads.net.corridors.size).toBe(corridors);
      expect(game.money).toBeGreaterThan(money);
      const { code, ...mods } = redo;
      key(code, mods);
      expect(game.roads.net.corridors.size).toBe(corridors + 1);
      expect(game.money).toBe(money);
    }
    // Повторять больше нечего — ничего и не меняется.
    key('KeyY', { ctrlKey: true });
    expect(game.roads.net.corridors.size).toBe(corridors + 1);
    expect(game.money).toBe(money);
  });

  it('в проекте Ctrl+Y повторяет отменённые шаги правки, новый шаг их забывает', () => {
    const { game, at } = setup();
    const { c, click, key } = play(game);
    key('KeyP');
    click(at(0, 0));
    click(at(200, 0));
    click(at(400, 0));
    const segs = () => c.projectTools.project('road').segs.length;
    expect(segs()).toBe(2);
    key('KeyZ', { ctrlKey: true });
    expect(segs()).toBe(1);
    key('KeyY', { ctrlKey: true });
    expect(segs()).toBe(2);
    key('KeyZ', { ctrlKey: true });
    key('KeyZ', { ctrlKey: true });
    expect(segs()).toBe(0);
    key('KeyZ', { ctrlKey: true, shiftKey: true });
    expect(segs()).toBe(1);
    // Новый шаг — отменённый второй участок уже не вернуть.
    click(at(0, 300));
    click(at(200, 300));
    expect(segs()).toBe(2);
    expect(c.projectTools.canRedo('road')).toBe(false);
    key('KeyY', { ctrlKey: true });
    expect(segs()).toBe(2);
  });

  it('отмены подряд — шаг проекта, затем стройка — повторяются в обратном порядке', () => {
    const { game, at } = setup();
    const { c, click, key } = play(game);
    const corridors = game.roads.net.corridors.size;
    click(at(0, 0));
    click(at(300, 0));
    key('Escape', { key: 'Escape' });
    expect(game.roads.net.corridors.size).toBe(corridors + 1);
    key('KeyP');
    click(at(0, 300));
    click(at(200, 300));
    key('Escape', { key: 'Escape' });
    const segs = () => c.projectTools.project('road').segs.length;
    expect(segs()).toBe(1);
    // Ctrl+Z, пока в проекте есть шаги, — шаги; потом — стройка.
    while (c.projectTools.canUndo('road')) key('KeyZ', { ctrlKey: true });
    expect(segs()).toBe(0);
    key('KeyZ', { ctrlKey: true });
    expect(game.roads.net.corridors.size).toBe(corridors);
    // Первым возвращается то, что отменили последним, — стройка; затем шаги проекта.
    key('KeyY', { ctrlKey: true });
    expect(game.roads.net.corridors.size).toBe(corridors + 1);
    expect(segs()).toBe(0);
    while (c.projectTools.canRedo('road')) key('KeyY', { ctrlKey: true });
    expect(segs()).toBe(1);
    expect(game.roads.net.corridors.size).toBe(corridors + 1);
  });
});
