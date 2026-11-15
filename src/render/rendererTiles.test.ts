import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { spansOf } from '../game/constructionWork';
import type { Game } from '../game/game';
import { Controller } from '../input/controller';
import { buildConstructionScene } from '../testpages/construction';
import { Camera } from './camera';
import { drawnSpans, progressBoxes, projectBox } from './constructionArt';
import { Renderer } from './renderer';
import { type Box, grow, meets, tileBox, tileRange, tileWorld } from './tileCache';

/**
 * Кэш карты плитками в настоящей отрисовке (Renderer) — на холстах-заглушках (тесты идут без браузера): плитки
 * перерисовываются, только когда в них что-то поменялось. Сюда — то, что сбивало кэш и грузило кадр: на паузе и без
 * движения ни одна плитка не перерисовывается, а шаг стройки сбрасывает только плитки у края работ, не всё полотно.
 */

type Handler = (e: unknown) => void;

/** Подписки на события — вместо окна и холста. */
class Events {
  private readonly map = new Map<string, Handler[]>();
  addEventListener(type: string, h: Handler): void {
    this.map.set(type, [...(this.map.get(type) ?? []), h]);
  }
  removeEventListener(): void {}
}

/** 2D-контекст, который ничего не рисует: свойства запоминает, любой метод — пустой. */
function fakeCtx(canvas: unknown): CanvasRenderingContext2D {
  const gradient = () => ({ addColorStop() {} });
  const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, transformPoint: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }), inverse: () => matrix, multiply: () => matrix };
  const special: Record<PropertyKey, unknown> = {
    getTransform: () => matrix,
    measureText: (t: string) => ({ width: t.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    createConicGradient: gradient,
    createPattern: () => ({}),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    isPointInPath: () => false,
    getLineDash: () => [],
  };
  const store: Record<PropertyKey, unknown> = { canvas, globalAlpha: 1, lineWidth: 1, fillStyle: '#000', strokeStyle: '#000', filter: 'none' };
  const noop = () => {};
  return new Proxy(store, {
    get: (t, p) => (p in special ? special[p] : p in t ? t[p] : noop),
    set: (t, p, v) => ((t[p] = v), true),
  }) as unknown as CanvasRenderingContext2D;
}

function fakeCanvas(): HTMLCanvasElement {
  const c = Object.assign(new Events(), { width: 300, height: 150, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }) });
  const ctx = fakeCtx(c);
  return Object.assign(c, { getContext: () => ctx }) as unknown as HTMLCanvasElement;
}

const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, document: g.document, Path2D: g.Path2D, Image: g.Image, HTMLInputElement: g.HTMLInputElement };

beforeAll(() => {
  g.window = Object.assign(new Events(), { devicePixelRatio: 2, innerWidth: 1200, innerHeight: 800 });
  g.document = Object.assign(new Events(), { createElement: () => fakeCanvas() });
  g.Path2D = class {
    constructor() {
      return new Proxy(this, { get: () => () => {} });
    }
  };
  // Значки не грузятся: картинка «готова», но пустая — не рисуется и не просит кадров.
  g.Image = class {
    complete = true;
    naturalWidth = 0;
    src = '';
  };
  g.HTMLInputElement = class {};
});

afterAll(() => {
  Object.assign(g, saved);
});

/** Отрисовка сцены стройки: камера над проектами, кадр — как в игре. */
function setup() {
  const scene = buildConstructionScene();
  const game: Game = scene.game;
  game.speed = 0;
  const canvas = fakeCanvas();
  const camera = new Camera();
  const renderer = new Renderer(canvas, camera);
  renderer.resize();
  const { x0, y0, x1, y1 } = scene.view;
  camera.x = (x0 + x1) / 2;
  camera.y = (y0 + y1) / 2;
  camera.zoom = 0.6;
  camera.touched = true;
  const controller = new Controller(canvas, camera, () => game);
  // Сколько раз плитки перерисовывались (renderTile) — по плитке за вызов.
  const r = renderer as unknown as { renderTile: (...a: unknown[]) => void; tiles: { sets: { world: number; tiles: Map<string, { ready: boolean; dirty: boolean }> }[] } };
  const own = r.renderTile.bind(renderer);
  const rendered: string[] = [];
  r.renderTile = (...a: unknown[]) => {
    const t = a[2] as { i: number; j: number };
    rendered.push(`${t.i}:${t.j}`);
    own(...a);
  };
  const frame = () => renderer.draw(game, controller.overlay());
  /** Кадры, пока плитки на экране и вокруг не дорисуются (Renderer.motion — не 'live'). */
  const settle = () => {
    for (let i = 0; i < 200 && (i === 0 || renderer.motion === 'live'); i++) frame();
  };
  return { scene, game, camera, renderer, frame, settle, rendered, tiles: r.tiles };
}

describe('Кэш карты плитками: без изменений плитки не перерисовываются', { timeout: 60_000 }, () => {
  it('на паузе и без движения — ни одной перерисовки плиток, все готовы и не устарели', () => {
    const { frame, settle, rendered, tiles } = setup();
    settle();
    expect(rendered.length).toBeGreaterThan(0);
    rendered.length = 0;
    for (let i = 0; i < 30; i++) frame();
    expect(rendered).toEqual([]);
    const set = tiles.sets[0];
    expect([...set.tiles.values()].every((t) => t.ready && !t.dirty)).toBe(true);
  });

  it('шаг стройки сбрасывает только плитки у края работ, а не все под полотном', () => {
    const { game, frame, settle, rendered, tiles, camera } = setup();
    const net = game.roads.net;
    // Длинное полотно: до края работ — шаг стройки, а полотно — на несколько плиток; камера — вблизи, над ним.
    const c = [...net.corridors.values()].filter((x) => x.build && !x.build.fromB).sort((a, b) => b.length - a.length)[0];
    expect(c).toBeDefined();
    const mid = c.lut.pointAt(c.length / 2);
    camera.x = mid.x;
    camera.y = mid.y;
    camera.zoom = 1.5;
    settle();
    const world = tileWorld(camera.zoom, camera.dpr);
    const cover = (b: Box) => {
      const r = tileRange(b, world);
      return (r.i1 - r.i0 + 1) * (r.j1 - r.j0 + 1);
    };
    expect(cover(projectBox(c))).toBeGreaterThan(4);
    // Стройку двигаем вручную: одним шагом drawStep у отсыпки (покрытие и разметка ещё не начаты).
    const before = drawnSpans(c);
    const [earth, pave, marks] = spansOf(c.build, c.length);
    c.build = { ...c.build!, stages: [Math.min(c.length / 2, earth + CONSTRUCTION.drawStep * 3), pave, marks] };
    const after = drawnSpans(c);
    expect(after).not.toEqual(before);
    // Рамки сброса — у края работ: меньше рамки полотна.
    const boxes = progressBoxes(c, before, after, false);
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect((b.x1 - b.x0) * (b.y1 - b.y0)).toBeLessThan(((projectBox(c).x1 - projectBox(c).x0) * (projectBox(c).y1 - projectBox(c).y0)) / 2);
    // Готовые плитки под полотном (с запасом сброса) — их перерисовал бы сброс всего полотна.
    const set = tiles.sets[0];
    const under = [...set.tiles.entries()].filter(([k, t]) => {
      const [i, j] = k.split(':').map(Number);
      return t.ready && meets(tileBox(i, j, set.world), grow(projectBox(c), 80));
    }).length;
    rendered.length = 0;
    frame();
    settle();
    expect(rendered.length).toBeGreaterThan(0);
    // Перерисованы только плитки у края работ (с запасом), а не все под полотном.
    expect(new Set(rendered).size).toBeLessThan(under / 2);
    expect([...set.tiles.values()].every((t) => !t.dirty)).toBe(true);
    // Дальше без изменений — снова ни одной перерисовки.
    rendered.length = 0;
    for (let i = 0; i < 10; i++) frame();
    expect(rendered).toEqual([]);
  });
});
