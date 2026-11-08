import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dist, type Vec } from '../core/vec';
import { Controller } from '../input/controller';
import { Camera } from '../render/camera';
import type { Selection } from '../render/renderer';
import { projectCardHtml } from '../ui/projectCard';
import { workTrainCardHtml } from '../ui/workTrainCard';
import type { Game } from './game';
import { railProjectScene, runSeconds } from './testkit';

/** Строительный поезд как выбор: клик по нему на карте, чип в карточке проекта, его карточка, маршрут до цели. */

type Handler = (e: unknown) => void;

/** Подписки на события — вместо окна и холста (тесты идут без браузера). */
class Events {
  private readonly map = new Map<string, Handler[]>();
  addEventListener(type: string, h: Handler): void {
    this.map.set(type, [...(this.map.get(type) ?? []), h]);
  }
}

const saved = { window: (globalThis as Record<string, unknown>).window, input: (globalThis as Record<string, unknown>).HTMLInputElement };

beforeAll(() => {
  (globalThis as Record<string, unknown>).window = new Events();
  (globalThis as Record<string, unknown>).HTMLInputElement = class {};
});

afterAll(() => {
  (globalThis as Record<string, unknown>).window = saved.window;
  (globalThis as Record<string, unknown>).HTMLInputElement = saved.input;
});

/** Контроллер без браузера и его выбор кликом по точке карты (pick — как клик «Выбором»). */
function controller(game: Game): { c: Controller; pick: (p: Vec) => Selection | null } {
  const camera = new Camera();
  camera.width = 0;
  camera.height = 0;
  const c = new Controller(new Events() as unknown as HTMLCanvasElement, camera, () => game);
  return { c, pick: (p) => (c as unknown as { pick(p: Vec): Selection | null }).pick(p) };
}

/** Игра вперёд кадрами по 0.1 с, пока не выполнится ok (не дольше max секунд). */
function until(game: Game, ok: () => boolean, max: number): void {
  for (let t = 0; t < max && !ok(); t += 0.1) runSeconds(game, 0.1);
}

describe('Строительный поезд — выбор, карточка, маршрут', { timeout: 60_000 }, () => {
  it('едет: клик по составу выбирает поезд, маршрут — от головы до края работ, чип проекта ведёт к нему и назад', () => {
    const { game, id, a } = railProjectScene();
    const trains = game.construction.trains!;
    // Поезда ещё нет — в карточке проекта чип подписью, не кнопкой.
    expect(trains.of(id)).toBeUndefined();
    expect(projectCardHtml(game, id)).not.toContain('worktrain-show');
    until(game, () => !!trains.of(id) && !!trains.simOf(trains.of(id)!)?.moving && !!trains.route(trains.of(id)!), 30);
    const w = trains.of(id)!;
    expect(trains.doing(w)).toBe('going');
    expect(w.depot).toBe(a.id);
    // Маршрут — от головы поезда вперёд по путям до места остановки у края работ; цель — край работ, не вокзал.
    const route = trains.route(w)!;
    const head = trains.where(w)!;
    expect(dist(route.pts[0], head)).toBeLessThan(1);
    expect(route.left).toBeGreaterThan(0);
    const goal = trains.goal(w)!;
    expect(goal.depot).toBe(false);
    expect(dist(route.pts[route.pts.length - 1], goal.pos)).toBeLessThan(40);
    // Клик по любому вагону — поезд, а не его проект.
    const { c, pick } = controller(game);
    const body = trains.body(w)!;
    expect(body.length).toBeGreaterThan(3);
    expect(trains.at(body[body.length - 1])).toBe(w.id);
    expect(pick(body[Math.floor(body.length / 2)])).toEqual({ type: 'workTrain', id: w.id });
    // Карточка проекта: чип «🚂 едет» — кнопка к поезду; открыли — карточка поезда, ✕ — снова карточка проекта.
    expect(projectCardHtml(game, id)).toContain(`data-action="worktrain-show" data-id="${w.id}"`);
    c.select({ type: 'project', id });
    c.showWorkTrain(w.id);
    expect(c.selection).toEqual({ type: 'workTrain', id: w.id });
    expect(c.ping?.pos).toEqual(head);
    c.closeSelection();
    expect(c.selection).toEqual({ type: 'project', id });
    // Карточка поезда: едет к стройке, откуда (вокзал — к нему), куда (проект — к его карточке), сколько ещё, скорость.
    c.showWorkTrain(w.id);
    const html = workTrainCardHtml(game, w.id, { following: false });
    expect(html).toContain('➜ едет к стройке');
    expect(html).toContain(`data-action="show-station" data-id="${a.id}"`);
    expect(html).toContain(`data-action="build-show" data-id="${id}"`);
    expect(html).toContain('📏');
    expect(html).toContain('км/ч');
    expect(html).toContain('data-action="toggle-follow"');
    expect(html).not.toContain('title=');
    // «◎ Следовать» — камера за головой поезда.
    c.toggleFollow();
    expect(c.following).toBe(true);
  });

  it('строит: техника и состав у края работ — клик выбирает поезд; маршрута нет, поезд в симуляции там не ловится', () => {
    const { game, id } = railProjectScene();
    const trains = game.construction.trains!;
    until(game, () => {
      const w = trains.of(id);
      return !!w?.train && trains.drawnBySite(w.train);
    }, 90);
    const w = trains.of(id)!;
    expect(trains.doing(w)).toBe('working');
    expect(trains.route(w)).toBeNull();
    const body = trains.body(w)!;
    const site = trains.site(id)!;
    const seg = game.net.segments.get(site.seg)!;
    // Голова — у края работ на строящемся участке.
    expect(seg.lut.closest(trains.where(w)!).d).toBeLessThan(1);
    const { pick } = controller(game);
    expect(pick(body[0])).toEqual({ type: 'workTrain', id: w.id });
    // Где поезд стоит в симуляции (не там, где его рисует стройка), — не он.
    const t = trains.simOf(w)!;
    const sim = game.rail.pointAt(t, t.head - t.length / 2)!.pos;
    if (body.every((p) => dist(p, sim) > 10)) expect(game.trainAt(sim)).toBeNull();
    expect(workTrainCardHtml(game, w.id, { following: false })).toContain('🏗 строит');
    // Поезда больше нет — короткая записка.
    expect(workTrainCardHtml(game, 999, { following: false })).toContain('Поезда больше нет');
  });
});
