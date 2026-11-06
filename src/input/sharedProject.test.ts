import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { add, dist, Vec } from '../core/vec';
import { Game } from '../game/game';
import { moveNodeEdit } from '../game/roadbuild';
import { nodeAt } from '../game/roadProject';
import { roadPlan, STREET } from '../game/testkit';
import { Camera } from '../render/camera';
import { Controller } from './controller';
import { type DrawSettings, sharedRoadProject } from './projecttools';

/**
 * Общий проект дорог: «Проект» — состояние инструмента «Дорога», а не режима. Начатая дорога переходит в проект,
 * правки построенных дорог (в «Строить» и в «Двигать») и новые участки — один проект, строится одним шагом Ctrl+Z.
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

const KINKED = { ...STREET, kink: true };

function dryGame(): Game {
  return new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
}

/**
 * Г-образная построенная улица A–B–C (B — её изгиб) и чистое поле под ней (y + 420) — там рисуют новые участки.
 */
function site(game: Game): { b: number; o: Vec; field: Vec } {
  for (let y = 400; y < game.terrain.height - 900; y += 120) {
    for (let x = 300; x < game.terrain.width - 700; x += 160) {
      const o = { x, y };
      const field = add(o, { x: 0, y: 420 });
      if (!roadPlan(game, { free: add(o, { x: -60, y: 260 }) }, { free: add(o, { x: 260, y: -60 }) }).ok) continue;
      if (!roadPlan(game, { free: add(field, { x: -60, y: 0 }) }, { free: add(field, { x: 360, y: 0 }) }).ok) continue;
      const first = roadPlan(game, { free: o }, { free: add(o, { x: 200, y: 0 }) }, KINKED);
      if (!first.ok || !game.roadBuilder.apply(first)) continue;
      const b = game.roads.net.nodesNear(add(o, { x: 200, y: 0 }), 1)[0].id;
      const second = roadPlan(game, b, { free: add(o, { x: 200, y: 200 }) }, KINKED);
      if (!second.ok || !game.roadBuilder.apply(second)) continue;
      return { b, o, field };
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
  const mouse = (p: Vec, extra: Record<string, unknown> = {}) => ({ clientX: p.x, clientY: p.y, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, target: canvas, preventDefault() {}, ...extra });
  const key = (code: string, extra: Record<string, unknown> = {}) =>
    win.fire('keydown', { code, key: code.replace(/^Key/, '').toLowerCase(), ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, target: null, preventDefault() {}, ...extra });
  const click = (p: Vec) => {
    canvas.fire('mousedown', mouse(p));
    win.fire('mouseup', mouse(p));
  };
  const drag = (from: Vec, to: Vec) => {
    canvas.fire('mousedown', mouse(from));
    win.fire('mousemove', mouse(add(from, { x: (to.x - from.x) / 2, y: (to.y - from.y) / 2 })));
    win.fire('mousemove', mouse(to));
    win.fire('mouseup', mouse(to));
  };
  c.setTool('road');
  c.setRoadMode('build');
  c.setPreset('street');
  return { c, click, drag, key, undo: () => key('KeyZ', { ctrlKey: true }) };
}

const shapeOf = (game: Game) => JSON.stringify([...game.roads.net.corridors.values()].map((x) => [x.id, x.curve]));

describe('Общий проект дорог', () => {
  it('начатая дорога переходит в проект: «Проект» посреди стройки — её начало уже узел проекта', () => {
    const game = dryGame();
    const { field } = site(game);
    const shape = shapeOf(game);
    const { c, click, key } = play(game);
    const A = field;
    const B = add(field, { x: 300, y: 0 });
    // Обычная стройка: первый клик — начало дороги.
    click(A);
    expect(c.roadTools.start).not.toBeNull();
    key('KeyP');
    expect(c.projectMode).toBe(true);
    expect(c.roadTools.start).toBeNull();
    // Следующий клик — уже участок проекта от начатой точки, дорога не строится.
    click(B);
    const pr = c.projectTools.project('road');
    expect(pr.segs.length).toBe(1);
    expect(nodeAt(pr, A, 1)).toBeTruthy();
    expect(nodeAt(pr, B, 1)).toBeTruthy();
    expect(shapeOf(game)).toBe(shape);
    // Выключили «Проект» посреди ветки: проект цел, обычная стройка — от того же места.
    key('KeyP');
    expect(c.projectMode).toBe(false);
    expect(c.projectTools.project('road').segs.length).toBe(1);
    expect(dist(c.roadTools.start!.pos, B)).toBeLessThan(1);
    key('KeyP');
    expect(c.projectTools.project('road').segs.length).toBe(1);
  });

  it('новый участок и перенос узла построенной дороги — один проект: строится одним шагом, Ctrl+Z отменяет оба', () => {
    const game = dryGame();
    const { b, o, field } = site(game);
    const shape = shapeOf(game);
    const B0 = { ...game.roads.net.node(b).pos };
    const { tools, edits } = sharedRoadProject(() => game);
    tools.on.road = true;
    // Участок в поле и правка построенной улицы.
    const draw: DrawSettings = { kind: 'road', spec: { cls: 'street', lanesF: 1, lanesB: 1 }, mode: 'arc', level: 0, auto: false, reverse: false };
    tools.down('road', field, 14, 10);
    tools.up(draw, field, 14, false, false);
    const end = add(field, { x: 300, y: 0 });
    tools.down('road', end, 14, 10);
    tools.up(draw, end, 14, false, false);
    const B = add(o, { x: 240, y: -40 });
    expect(tools.addEdit(moveNodeEdit(b, B))).toBeNull();
    expect(tools.project('road').segs.length).toBe(1);
    expect(edits.edits.length).toBe(1);
    // Цена и проверки — общие: план — и участок, и перенос; дорога пока как есть.
    const plan = tools.plan('road');
    expect(plan.ok).toBe(true);
    expect(dist(plan.road!.net!.node(b).pos, B)).toBeLessThan(1e-6);
    expect(shapeOf(game)).toBe(shape);
    // Ctrl+Z в проекте: сперва правка, потом участок (одна история).
    expect(tools.undo('road')).toBe(true);
    expect(edits.edits.length).toBe(0);
    expect(tools.project('road').segs.length).toBe(1);
    expect(tools.addEdit(moveNodeEdit(b, B))).toBeNull();
    const corridors = game.roads.net.corridors.size;
    const money = game.money;
    expect(tools.build('road')).toBeNull();
    // Построено всё: узел на новом месте, новая улица в поле, проект пуст.
    expect(dist(game.roads.net.node(b).pos, B)).toBeLessThan(1e-6);
    expect(game.roads.net.corridors.size).toBe(corridors + 1);
    expect(game.money).toBeLessThan(money);
    expect(tools.project('road').segs.length).toBe(0);
    expect(edits.edits.length).toBe(0);
    // Один шаг Ctrl+Z — и участка нет, и узел на старом месте.
    expect(game.undo()).toBe('проект дороги');
    expect(dist(game.roads.net.node(b).pos, B0)).toBeLessThan(1e-6);
    expect(shapeOf(game)).toBe(shape);
    expect(game.money).toBe(money);
  });

  it('«Проект» общий у «Строить» и «Двигать»: правка из «Двигать» — в том же проекте, «Построить» — всё одним шагом', () => {
    const game = dryGame();
    const { b, o, field } = site(game);
    const shape = shapeOf(game);
    const B0 = { ...game.roads.net.node(b).pos };
    const { c, click, drag, key, undo } = play(game);
    key('KeyP');
    // «Строить»: участок проекта в поле.
    click(field);
    click(add(field, { x: 300, y: 0 }));
    key('Escape');
    expect(c.projectTools.project('road').segs.length).toBe(1);
    // M — «Двигать»: проект не выключается и не прячется.
    key('KeyM');
    expect(c.roadMode).toBe('move');
    expect(c.projectOn).toBe(true);
    expect(c.projectSummary().segs).toBe(1);
    // Тянем узел построенной улицы — правка в тот же проект, дорога пока как есть.
    const B = add(o, { x: 240, y: -40 });
    drag(B0, B);
    expect(c.moveProject.edits.length).toBe(1);
    expect(shapeOf(game)).toBe(shape);
    const summary = c.projectSummary();
    expect(summary).toMatchObject({ segs: 1, edits: 1 });
    expect(summary.plan.ok).toBe(true);
    // L — «Полоса»: тот же проект, правки полос пойдут в него же.
    key('KeyL');
    expect(c.projectOn).toBe(true);
    expect(c.editProject).toBe(c.moveProject);
    expect(c.projectSummary()).toMatchObject({ segs: 1, edits: 1 });
    // U — «Перестроить»: проект не правится, но хранится (подсказка), P — назад к нему.
    key('KeyU');
    expect(c.projectKept).toBe(true);
    expect(c.projectSummary()).toMatchObject({ segs: 1, edits: 1 });
    key('KeyP');
    expect(c.roadMode).toBe('build');
    expect(c.projectMode).toBe(true);
    // N — снова «Строить»: и участок, и правка на месте.
    key('KeyM');
    key('KeyN');
    expect(c.projectMode).toBe(true);
    expect(c.projectSummary()).toMatchObject({ segs: 1, edits: 1 });
    // Enter — «Построить»: всё разом.
    const corridors = game.roads.net.corridors.size;
    key('Enter', { key: 'Enter' });
    expect(dist(game.roads.net.node(b).pos, B)).toBeLessThan(2);
    expect(game.roads.net.corridors.size).toBe(corridors + 1);
    expect(c.projectSummary()).toMatchObject({ segs: 0, edits: 0 });
    // Ctrl+Z — один шаг отменяет и участок, и перенос.
    undo();
    expect(dist(game.roads.net.node(b).pos, B0)).toBeLessThan(1e-6);
    expect(shapeOf(game)).toBe(shape);
  });
});
