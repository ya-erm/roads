import { describe, expect, it } from 'vitest';
import { add, dist, dot, norm, sub, Vec } from '../core/vec';
import { Game } from '../game/game';
import { handleOf, nodeAt, smoothPair } from '../game/roadProject';
import { road } from '../game/testkit';
import { type RoadSpec } from '../world/roadTypes';
import { DrawSettings, ProjectTools } from './projecttools';

const STREET: RoadSpec = { cls: 'street', lanesF: 1, lanesB: 1 };
const R = 14;
const HR = 10;

function setup(): { game: Game; tools: ProjectTools; at: (x: number, y: number) => Vec; draw: DrawSettings } {
  const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
  // Пустое место: рядом ни дорог, ни путей.
  let origin: Vec | null = null;
  for (let y = 500; y < game.terrain.height - 600 && !origin; y += 150) {
    for (let x = 500; x < game.terrain.width - 900 && !origin; x += 150) {
      const c = { x: x + 300, y: y + 100 };
      if (!game.roads.net.corridorsNear(c, 500).length && !game.blocked(c, 450)) origin = { x, y };
    }
  }
  if (!origin) throw new Error('Нет места');
  const o = origin;
  return {
    game,
    tools: new ProjectTools(() => game),
    at: (x, y) => add(o, { x, y }),
    draw: { kind: 'road', spec: STREET, mode: 'arc', level: 0, auto: false, reverse: false },
  };
}

/** Клик мышью в инструменте проекта (kink — с Shift, free — с Cmd / Ctrl). */
function click(t: ProjectTools, s: DrawSettings, p: Vec, kink = false, free = false): void {
  t.down(s.kind, p, R, HR);
  t.up(s, p, R, false, kink, free);
}

function drag(t: ProjectTools, s: DrawSettings, from: Vec, to: Vec, kink = false): void {
  t.down(s.kind, from, R, HR);
  t.move(s.kind, to, R, kink);
  t.up(s, to, R, true, kink);
}

/** Узел проекта в точке. */
const nodeId = (t: ProjectTools, p: Vec) => nodeAt(t.project('road'), p, 0.5)!.id;

describe('Инструмент «Проект»: стыки участков', () => {
  it('ветка, которую довели до конца другой ветки, приходит в него гладко — перья на одной прямой', () => {
    const { tools: t, at, draw } = setup();
    click(t, draw, at(0, 0));
    click(t, draw, at(200, 0));
    t.cancel('road');
    click(t, draw, at(400, 100));
    click(t, draw, at(600, 100));
    t.cancel('road');
    // Ведём от конца первой ветки к началу второй.
    click(t, draw, at(200, 0));
    click(t, draw, at(400, 100));
    const p = t.project('road');
    expect(p.segs.length).toBe(3);
    expect(smoothPair(p, nodeId(t, at(200, 0)))).not.toBeNull();
    expect(smoothPair(p, nodeId(t, at(400, 100)))).not.toBeNull();
  });

  it('следующий участок продолжает предыдущий без излома; с Shift — излом', () => {
    const { tools: t, at, draw } = setup();
    click(t, draw, at(0, 0));
    click(t, draw, at(200, 0));
    click(t, draw, at(380, 120));
    expect(smoothPair(t.project('road'), nodeId(t, at(200, 0)))).not.toBeNull();
    click(t, draw, at(380, 320), true);
    expect(smoothPair(t.project('road'), nodeId(t, at(380, 120)))).toBeNull();
  });

  it('конец ветки, перетащенный на конец другой, сливается с ним гладко', () => {
    const { tools: t, at, draw } = setup();
    click(t, draw, at(0, 0));
    click(t, draw, at(200, 0));
    t.cancel('road');
    click(t, draw, at(260, 60));
    click(t, draw, at(460, 160));
    t.cancel('road');
    drag(t, draw, at(200, 0), at(260, 60));
    const p = t.project('road');
    const joint = nodeId(t, at(260, 60));
    expect(p.nodes.length).toBe(3);
    expect(smoothPair(p, joint)).not.toBeNull();
    // Перо принесённого участка повернулось навстречу перу соседа.
    const [x, y] = p.segs.filter((s) => s.a === joint || s.b === joint).map((s) => handleOf(p, s, s.a === joint ? 'a' : 'b'));
    expect(dot(norm(sub(x.pos, x.anchor)), norm(sub(y.pos, y.anchor)))).toBeCloseTo(-1, 6);
    expect(dist(x.anchor, at(260, 60))).toBeLessThan(1e-9);
  });

  it('перетаскивание узла посреди ветки стык не ломает', () => {
    const { tools: t, at, draw } = setup();
    click(t, draw, at(0, 0));
    click(t, draw, at(200, 0));
    click(t, draw, at(380, 120));
    t.cancel('road');
    drag(t, draw, at(200, 0), at(210, 60));
    expect(smoothPair(t.project('road'), nodeId(t, at(210, 60)))).not.toBeNull();
  });
});

describe('Инструмент «Проект»: правая кнопка по узлу', () => {
  it('пока ведём ветку — не убирает узел (ПКМ — шаг назад); когда ничего не начато — убирает, как Delete', () => {
    const { tools: t, at, draw } = setup();
    click(t, draw, at(0, 0));
    click(t, draw, at(200, 0));
    click(t, draw, at(400, 0));
    // Ведём ветку: ПКМ даже по узлу — не удаление, а шаг назад (у контроллера — cancel).
    expect(t.busy).toBe(true);
    expect(t.removeIdle('road', at(200, 0), R)).toBe(false);
    expect(t.project('road').nodes.length).toBe(3);
    expect(t.cancel('road')).toBe(true);
    expect(t.busy).toBe(false);
    // Ничего не начато: мимо узла — нечего убирать, по узлу — прочь вместе с участками (и концами, что повисли).
    expect(t.removeIdle('road', at(300, 150), R)).toBe(false);
    expect(t.removeIdle('road', at(203, 2), R)).toBe(true);
    expect(t.project('road').segs.length).toBe(0);
    expect(nodeAt(t.project('road'), at(200, 0), 1)).toBeNull();
    // Ctrl+Z возвращает узел.
    expect(t.undo('road')).toBe(true);
    expect(t.project('road').segs.length).toBe(2);
  });
});

describe('Инструмент «Проект»: прилипание к «прямо» и 90°', () => {
  /** Узел проекта у точки (null — нет). */
  const near = (t: ProjectTools, p: Vec) => nodeAt(t.project('road'), p, 0.5);

  it('от построенной дороги конец прилипает к её продолжению и перпендикуляру; с Cmd / Ctrl — ровно под курсором', () => {
    const { game, tools: t, at, draw } = setup();
    expect(road(game, { free: at(-200, 0) }, { free: at(0, 0) })).toBe(true);
    const straight = { ...draw, mode: 'straight' as const };
    // От тупика улицы почти по её продолжению — ровно «прямо».
    click(t, straight, at(0, 0));
    expect(t.view(straight, at(150, 10), R, HR).draft?.aim).toBe('прямо');
    click(t, straight, at(150, 10));
    expect(near(t, at(150, 0))).not.toBeNull();
    t.cancel('road');
    // Почти поперёк — ровно 90°.
    click(t, straight, at(0, 0));
    expect(t.view(straight, at(8, 150), R, HR).draft?.aim).toBe('90°');
    click(t, straight, at(8, 150));
    expect(near(t, at(0, 150))).not.toBeNull();
    t.cancel('road');
    // С Cmd / Ctrl — без прилипания (в другую сторону от улицы: там ещё нет участков).
    click(t, straight, at(0, 0));
    expect(t.view(straight, at(-8, -150), R, HR).draft?.aim).toBe('90°');
    expect(t.view(straight, at(-8, -150), R, HR, false, null, true).draft?.aim).toBeNull();
    click(t, straight, at(-8, -150), false, true);
    expect(near(t, at(-8, -150))).not.toBeNull();
  });

  it('следующий участок прилипает к продолжению предыдущего и к 90° от него', () => {
    const { tools: t, at, draw } = setup();
    click(t, draw, at(0, 0));
    click(t, draw, at(200, 0));
    click(t, draw, at(400, 15));
    expect(near(t, at(400, 0))).not.toBeNull();
    click(t, draw, at(412, -150));
    expect(near(t, at(400, -150))).not.toBeNull();
    // Далеко от «прямо» и 90° — конец под курсором.
    click(t, draw, at(500, -300));
    expect(near(t, at(500, -300))).not.toBeNull();
  });
});
