import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import type { Vec } from '../core/vec';
import { Game } from '../game/game';
import { anchorOf, road, STREET, withoutCitizens } from '../game/testkit';
import { Camera } from '../render/camera';
import { basePrices, basePriceHtml, buildTabHtml } from '../ui/constructionUi';
import type { WorldSettings } from '../world/settings';
import { Controller } from './controller';

/**
 * Строительная база — в инструменте «Станция» («База стройки», тот же режим, что «＋ База» на вкладке «Стройка»): цена
 * этой и следующих баз видна там, где базу ставят, — в панели инструмента, на кнопке и в подписи у курсора.
 */

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

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };
const COST = CONSTRUCTION.base.cost;
const price = `$${COST.toLocaleString('ru-RU')}`;

/** «Со строительством»: две готовые улицы в чистом поле — у каждой место под базу (spots), без домов под площадкой. */
function scene(): { game: Game; spots: Vec[] } {
  const game = withoutCitizens(new Game(WORLD));
  const spots: Vec[] = [];
  for (let y = 400; y < game.terrain.height - 400 && spots.length < 2; y += 240) {
    for (let x = 300; x < game.terrain.width - 900 && spots.length < 2; x += 160) {
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x: x - 150, y } }), anchorOf(game, { free: { x: x + 150, y } }), STREET);
      if (!plan.ok || plan.demolish.length) continue;
      const spot = { x, y: y - 40 };
      if (!road(game, { free: { x: x - 150, y } }, { free: { x: x + 150, y } })) continue;
      const base = game.basePlan(spot);
      if (!base.ok || base.demolish.length) continue;
      spots.push(spot);
      break;
    }
  }
  expect(spots.length).toBe(2);
  return { game, spots };
}

/** Контроллер с мышью и клавиатурой; камера — один пиксель экрана на метр мира, начало в нуле. */
function play(game: Game) {
  const canvas = new Events();
  const camera = new Camera();
  camera.width = 0;
  camera.height = 0;
  const c = new Controller(canvas as unknown as HTMLCanvasElement, camera, () => game);
  const mouse = (p: Vec) => ({ clientX: p.x, clientY: p.y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, target: canvas, preventDefault() {} });
  const click = (p: Vec) => {
    canvas.fire('mousedown', mouse(p));
    win.fire('mouseup', mouse(p));
  };
  const hover = (p: Vec) => {
    c.hover = p;
    return c.overlay().label?.text ?? '';
  };
  const esc = () => win.fire('keydown', { code: 'Escape', key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault() {} });
  return { c, click, hover, esc };
}

describe('Цена строительной базы', () => {
  it('первая — бесплатно, следующие — по цене базы; поставили первую — обе по цене', () => {
    const { game, spots } = scene();
    expect(basePrices(game)).toEqual({ now: 0, next: COST });
    const first = basePriceHtml(game);
    expect(first).toContain('base-price free');
    expect(first).toContain('<b>бесплатно</b>');
    expect(first).toContain(`base-price next`);
    expect(first).toContain(`<b>${price}</b>`);
    expect(first).not.toContain('title=');
    // Вкладка «Стройка»: подсказка и кнопка говорят и про следующие.
    const tab = buildTabHtml(game);
    expect(tab).toContain(`Первая — бесплатно, следующие — по ${price}`);
    expect(tab).toContain('＋ База · бесплатно');
    expect(game.buildBase(spots[0])).toBeNull();
    expect(basePrices(game)).toEqual({ now: COST, next: COST });
    const then = basePriceHtml(game);
    expect(then).not.toContain('бесплатно');
    expect(then.match(/class="base-price/g)?.length).toBe(1);
    expect(buildTabHtml(game)).toContain(`＋ База · ${price}`);
  });

  it('без стройки цены баз нет: «＋ База» не включает режим', () => {
    const game = new Game({ ...WORLD, construction: 'instant' });
    const { c } = play(game);
    c.startBase();
    expect(c.placingBase).toBe(false);
    expect(c.tool).toBe('select');
  });
});

describe('База стройки в инструменте «Станция»', () => {
  it('«＋ База» открывает «Станцию → База стройки»: подпись с ценой, клик ставит базу и возвращает «Выбор»', () => {
    const { game, spots } = scene();
    const { c, click, hover } = play(game);
    c.startBase();
    expect(c.tool).toBe('station');
    expect(c.placingBase).toBe(true);
    expect(c.action).toBe('base');
    // У курсора: эта бесплатно и сколько стоят следующие.
    expect(hover(spots[0])).toMatch(new RegExp(`^База стройки · бесплатно · следующие — \\$${COST.toLocaleString('ru-RU').replace(/\s/g, '\\s')} · `));
    const money = game.money;
    const undo = game.canUndo;
    click(spots[0]);
    expect(game.construction.crews.bases.size).toBe(1);
    expect(game.money).toBe(money);
    // База в отмену не входит (как раньше): клик «Станцией» не делает снимок.
    expect(game.canUndo).toBe(undo);
    expect(c.tool).toBe('select');
    expect(c.placingBase).toBe(false);
    // Вторая — из «Станции», платная: подпись — одна цена, без «следующие».
    c.setStationMode('cargo');
    expect(c.action).toBe('station');
    c.startBase();
    const label = hover(spots[1]);
    expect(label).toContain(`База стройки · ${price}`);
    expect(label).not.toContain('следующие');
    click(spots[1]);
    expect(game.construction.crews.bases.size).toBe(2);
    expect(game.money).toBe(money - COST);
  });

  it('другой вид станции или Esc — режим базы кончается', () => {
    const { game } = scene();
    const { c, esc } = play(game);
    c.startBase();
    c.setStationMode('pax');
    expect(c.placingBase).toBe(false);
    expect(c.tool).toBe('station');
    expect(c.action).toBe('station');
    c.startBase();
    esc();
    expect(c.placingBase).toBe(false);
    expect(c.tool).toBe('select');
    // Повторное «＋ База» (кнопка нажата) — выйти.
    c.startBase();
    c.startBase(false);
    expect(c.placingBase).toBe(false);
    expect(c.tool).toBe('select');
  });
});
