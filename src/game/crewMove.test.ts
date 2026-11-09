import { describe, expect, it } from 'vitest';
import { dist, type Vec } from '../core/vec';
import { bendCurve } from '../input/roadtools';
import type { Corridor } from '../lanes/model';
import type { WorldSettings } from '../world/settings';
import type { Brigade } from './crews';
import { Game } from './game';
import { MoveProject } from './moveProject';
import { moveNodeEdit, reshapeEdit } from './roadbuild';
import { anchorOf, openSpot, road, runSeconds, STREET, withoutCitizens } from './testkit';

/**
 * Проект подвинули («Двигать»: изогнули, перенесли узел), пока его строят: техника бригад на нём едет вместе с ним —
 * ни одна машина не остаётся там, где проект был, а стройка идёт дальше. Ctrl+Z — техника возвращается с ним.
 */
describe('Перенос строящегося участка: техника переезжает вместе с ним', () => {
  const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

  /**
   * Улица с запада на восток, база у её западного конца, проект — тупик на юг от середины; три бригады. Игра идёт, пока
   * две бригады не работают на проекте, а край отсыпки не уйдёт на 120 м от начала.
   */
  function scene() {
    const game = withoutCitizens(new Game(WORLD));
    // Чистое поле вдоль улицы и к югу от её середины — там проект.
    const at = openSpot(game, [
      [{ x: 0, y: 0 }, { x: 1000, y: 0 }, 150],
      [{ x: 500, y: 0 }, { x: 500, y: 380 }, 120],
    ]);
    expect(road(game, { free: at }, { free: { x: at.x + 1000, y: at.y } })).toBe(true);
    expect(game.buildBase({ x: at.x + 120, y: at.y - 40 })).toBeNull();
    const base = [...game.construction.crews.bases.keys()][0];
    expect(game.hireBrigade(base)).toBeNull();
    expect(game.hireBrigade(base)).toBeNull();
    const id = game.construction.peekId();
    const tip = { x: at.x + 500, y: at.y + 360 };
    const plan = game.roadBuilder.road(anchorOf(game, { x: at.x + 500, y: at.y }), anchorOf(game, { free: tip }), STREET, { project: true });
    expect(plan.reason).toBeUndefined();
    expect(game.roadBuilder.apply(plan)).toBe(true);
    // Главное полотно проекта — самое длинное (у перекрёстка может быть короткий кусок).
    const cid = [...game.construction.corridorsOf(id)].sort((a, b) => b.length - a.length)[0].id;
    let t = 0;
    for (; t < 400; t += 1) {
      runSeconds(game, 1);
      const c = game.roads.net.corridors.get(cid);
      if (c?.build?.stages && c.build.stages[0] > 120 && game.construction.crews.working(id).length >= 2 && cars(game).length >= 6) break;
    }
    expect(t).toBeLessThan(400);
    for (const m of cars(game)) expect(offRoad(game, m.pos)).toBeLessThan(12);
    return { game, at, id, cid, tip };
  }

  /** Все машины бригад вне потока (на стройке, вдоль неё, на местах). */
  function cars(game: Game): { b: Brigade; pos: Vec }[] {
    const crews = game.construction.crews;
    return [...crews.brigades.values()].flatMap((b) => crews.carsAt(b).map((m) => ({ b, pos: m.pos })));
  }

  /** Где точка p относительно края отсыпки полотна c: на сколько метров по оси позади него и как далеко от оси. */
  function behind(c: Corridor, p: Vec): { s: number; d: number } {
    const f = c.build?.stages?.[0] ?? 0;
    const hit = c.lut.closest(p);
    return { s: f - (c.build?.fromB ? c.length - hit.s : hit.s), d: hit.d };
  }

  /** Как далеко точка от ближайшего полотна сети (готового или строящегося). */
  function offRoad(game: Game, p: Vec): number {
    let best = Infinity;
    for (const c of game.roads.net.corridorsNear(p, 60)) best = Math.min(best, dist(p, c.lut.closest(p).point));
    return best;
  }

  /** Все машины — на дорогах или на проекте (не дальше 12 м от оси какого-нибудь полотна). */
  function allOnRoads(game: Game): void {
    for (const m of cars(game)) expect(offRoad(game, m.pos), `бригада ${m.b.id} в ${m.pos.x.toFixed(0)},${m.pos.y.toFixed(0)}`).toBeLessThan(12);
  }

  /** Каждая машина — на столько же метров по оси от края работ и так же далеко от оси, что и до правки. */
  function sameSpots(before: { pos: Vec }[], was: Corridor, now: { pos: Vec }[], moved: Corridor): void {
    expect(now.length).toBe(before.length);
    for (let i = 0; i < now.length; i++) {
      const a = behind(was, before[i].pos);
      const b = behind(moved, now[i].pos);
      expect(Math.abs(a.s - b.s), `машина ${i} вдоль`).toBeLessThan(2);
      expect(Math.abs(a.d - b.d), `машина ${i} поперёк`).toBeLessThan(1);
    }
  }

  it('изогнули проект посреди стройки — машины на нём переезжают на новую ось, стройка идёт дальше и кончается', () => {
    const { game, at, id, cid } = scene();
    const before = cars(game);
    // Изгиб: середина проекта уходит к востоку (концы на месте) — так игрок тянет дорогу «Двигать».
    const was = game.roads.net.corridors.get(cid)!;
    const target = { x: was.lut.pointAt(was.length / 2).x + 140, y: was.lut.pointAt(was.length / 2).y };
    const plan = game.roadBuilder.plan(reshapeEdit(cid, (n, c) => bendCurve(n, c, target)));
    expect(plan.reason).toBeUndefined();
    expect(game.roadBuilder.apply(plan)).toBe(true);
    const moved = game.roads.net.corridors.get(cid)!;
    expect(moved.build?.project).toBe(id);
    // Середина проекта и правда ушла далеко от прежней — машинам там было бы не на дороге.
    expect(dist(moved.lut.pointAt(moved.length / 2), { x: at.x + 500, y: at.y + 180 })).toBeGreaterThan(60);
    // Сразу (и на паузе, без такта) — ни одна машина не осталась на прежней оси, и каждая — там же у края работ.
    allOnRoads(game);
    sameSpots(before, was, cars(game), moved);

    // Дальше стройка идёт, машины всё время на дорогах или на проекте, проект кончается.
    let worst = 0;
    let where = '';
    for (let k = 0; k < 900 && game.construction.projects.has(id); k++) {
      runSeconds(game, 1);
      for (const m of cars(game)) {
        const d = offRoad(game, m.pos);
        if (d > worst) where = `бригада ${m.b.id} (${m.b.state}) в ${m.pos.x.toFixed(0)},${m.pos.y.toFixed(0)}`;
        worst = Math.max(worst, d);
      }
    }
    expect(worst, where).toBeLessThan(12);
    expect(game.construction.projects.has(id)).toBe(false);
    expect(game.roads.net.corridors.get(cid)?.build).toBeUndefined();
  });

  it('конец проекта перенесли проектом перемещения — техника едет с ним; Ctrl+Z — обратно; сохранение — как было', () => {
    const { game, id, cid, tip } = scene();
    const before = cars(game);
    const was = game.roads.net.corridors.get(cid)!;
    const end = game.roads.net.nodesNear(tip, 1)[0].id;
    const mp = new MoveProject(() => game);
    expect(mp.add(moveNodeEdit(end, { x: tip.x + 160, y: tip.y - 40 }))).toBeNull();
    expect(mp.build()).toBeNull();
    const moved = game.roads.net.corridors.get(cid)!;
    expect(moved.build?.project).toBe(id);
    allOnRoads(game);
    sameSpots(before, was, cars(game), moved);
    // Сохранили и открыли — машины там же (перенос не повторяется и не теряется).
    const spots = cars(game).map((m) => m.pos);
    const loaded = withoutCitizens(new Game(WORLD, JSON.parse(JSON.stringify(game.toSave()))));
    const again = cars(loaded).map((m) => m.pos);
    expect(again.length).toBe(spots.length);
    again.forEach((p, i) => expect(dist(p, spots[i])).toBeLessThan(0.5));

    // Отмена: проект — где был, техника — с ним.
    expect(game.undo()).toBe('перенос дороги');
    const back = game.roads.net.corridors.get(cid)!;
    expect(dist(back.lut.pointAt(back.length), was.lut.pointAt(was.length))).toBeLessThan(1e-6);
    allOnRoads(game);
    sameSpots(before, was, cars(game), back);
    runSeconds(game, 30);
    allOnRoads(game);
  });
});
