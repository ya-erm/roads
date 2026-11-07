import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { Camera } from '../render/camera';
import { Controller } from './controller';

/** Esc, когда отменять нечего (ничего не начато и не выбрано, инструмент «Выбор»), открывает меню игры. */

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

const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });

function setup() {
  const camera = new Camera();
  camera.width = 0;
  camera.height = 0;
  const c = new Controller(new Events() as unknown as HTMLCanvasElement, camera, () => game);
  let menus = 0;
  c.onMenu = () => menus++;
  const esc = (repeat = false) =>
    win.fire('keydown', { code: 'Escape', key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat, target: null, preventDefault() {} });
  return { c, esc, menus: () => menus };
}

describe('Esc и меню', () => {
  it('ничего не выбрано и не начато — открывает меню', () => {
    const { c, esc, menus } = setup();
    expect(c.back()).toBe(false);
    esc();
    expect(menus()).toBe(1);
  });

  it('открытый инструмент сначала закрывается, меню — следующим Esc', () => {
    const { c, esc, menus } = setup();
    c.setTool('road');
    esc();
    expect(c.tool).toBe('select');
    expect(menus()).toBe(0);
    esc();
    expect(menus()).toBe(1);
  });

  it('выбранный объект сначала снимается', () => {
    const { c, esc, menus } = setup();
    const town = game.towns[0];
    c.select({ type: 'town', id: town.id });
    esc();
    expect(c.selection).toBeNull();
    expect(menus()).toBe(0);
    esc();
    expect(menus()).toBe(1);
  });

  it('открытый маршрут сначала закрывается', () => {
    const { c, esc, menus } = setup();
    c.selectLine(1);
    esc();
    expect(c.selectedLine).toBeNull();
    expect(menus()).toBe(0);
  });

  it('режим размещения базы сначала отменяется', () => {
    const { c, esc, menus } = setup();
    c.startBase();
    esc();
    expect(c.placingBase).toBe(false);
    expect(menus()).toBe(0);
  });

  it('зажатая клавиша меню не открывает', () => {
    const { esc, menus } = setup();
    esc(true);
    expect(menus()).toBe(0);
  });
});
