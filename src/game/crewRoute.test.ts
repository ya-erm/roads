import { describe, expect, it } from 'vitest';
import { dist, type Vec } from '../core/vec';
import { baseCardHtml } from '../ui/baseCard';
import { crewCardHtml } from '../ui/crewCard';
import type { WorldSettings } from '../world/settings';
import { projectName } from './construction';
import type { Game } from './game';
import { anchorOf, freshGame, road, runSeconds, STREET, withoutCitizens } from './testkit';

/**
 * Куда едет бригада: маршрут на карте (Game.brigadeRoute) — от головной машины до края работ; название стройки в
 * карточках — ссылкой к ней; одинаковые названия строек различает место (Game.projectTitle).
 */
describe('Маршрут бригады и названия строек', () => {
  const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 50_000_000, water: 'dry', construction: 'build' };
  const nodeAt = (game: Game, p: Vec) => [...game.roads.net.nodes.values()].find((n) => dist(n.pos, p) < 1)!.id;
  const length = (pts: readonly Vec[]) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);

  /** Место в поле, далеко от городов: ровная полоса в len метров вдоль x (как в crewPin.test.ts). */
  function field(game: Game, len: number): Vec {
    for (let y = 400; y < game.terrain.height - 400; y += 120) {
      for (let x = 300; x < game.terrain.width - len - 300; x += 160) {
        if (game.towns.some((t) => dist({ x: x + len / 2, y }, t.center) < t.radius + len)) continue;
        const plan = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + len, y } }), STREET);
        if (plan.ok && !plan.demolish.length) return { x, y };
      }
    }
    throw new Error('нет места');
  }

  /** Улица с базой посередине и два одинаковых проекта («Улица 1+1») от её концов — на восток и на запад. */
  function scene() {
    const game = withoutCitizens(freshGame(WORLD));
    const at = field(game, 1500);
    expect(road(game, { free: { x: at.x + 600, y: at.y } }, { free: { x: at.x + 900, y: at.y } })).toBe(true);
    expect(game.buildBase({ x: at.x + 750, y: at.y - 40 })).toBeNull();
    const ids: number[] = [];
    for (const [from, to] of [
      [at.x + 900, at.x + 1500],
      [at.x + 600, at.x],
    ]) {
      ids.push(game.construction.peekId());
      const plan = game.roadBuilder.road(anchorOf(game, nodeAt(game, { x: from, y: at.y })), anchorOf(game, { free: { x: to, y: at.y } }), STREET, { project: true });
      expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
    }
    const b = [...game.construction.crews.brigades.values()][0];
    return { game, ids, b };
  }

  it('одинаковые названия различает место, своё название — без места; маршрут ведёт от бригады к краю работ', () => {
    const { game, ids, b } = scene();
    const [p1, p2] = ids.map((id) => game.construction.projects.get(id)!);
    expect(projectName(p1)).toBe(projectName(p2));
    const t1 = game.projectTitle(p1.id);
    const t2 = game.projectTitle(p2.id);
    expect(t1).not.toBe(t2);
    expect(t1.startsWith(`${projectName(p1)} · `)).toBe(true);
    expect(game.projectPlace(p1.id)).not.toBe('');

    // Свободна, на базе — пути нет; выехала — путь от головной машины до края работ её фронта.
    expect(game.brigadeRoute(b.id)).toBeNull();
    let seen = 0;
    let gone = 0;
    for (let t = 0; t < 120 && b.state !== 'working'; t += 0.5) {
      runSeconds(game, 0.5);
      if (b.state !== 'going') continue;
      const route = game.brigadeRoute(b.id);
      expect(route).not.toBeNull();
      const site = game.construction.approach(b.project!, b)!;
      expect(route!.home).toBe(false);
      expect(route!.project).toBe(b.project);
      expect(dist(route!.goal, site.pos)).toBeLessThan(1);
      expect(dist(route!.pts[route!.pts.length - 1], site.pos)).toBeLessThan(2);
      // Начало — у головной машины (в потоке — у неё самой, ждёт выезда — у базы).
      expect(dist(route!.pts[0], game.brigadeWhere(b.id)!.pos)).toBeLessThan(30);
      // Через узел подъезда.
      const gate = game.roads.net.node(site.node).pos;
      expect(Math.min(...route!.pts.map((p) => dist(p, gate)))).toBeLessThan(5);
      // Путь короче по мере езды (не считая выезда).
      const len = length(route!.pts);
      if (seen && b.convoy?.cars.some((c) => 'sim' in c)) expect(len).toBeLessThan(gone + 25);
      gone = len;
      seen++;
    }
    expect(seen).toBeGreaterThan(3);
    expect(b.state).toBe('working');
    expect(game.brigadeRoute(b.id)).toBeNull();

    // Своё название у одного — оба уже различимы, место не нужно.
    game.renameProject(p1.id, 'Объездная');
    expect(game.projectTitle(p1.id)).toBe('Объездная');
    expect(game.projectTitle(p2.id)).toBe(projectName(p2));
  });

  it('название стройки в карточках бригады и базы — ссылкой к ней, у закреплённой — тоже', () => {
    const { game, ids, b } = scene();
    for (let t = 0; t < 30 && b.state !== 'going'; t += 0.5) runSeconds(game, 0.5);
    expect(b.state).toBe('going');
    const title = game.projectTitle(b.project!);
    const link = `data-action="build-show" data-id="${b.project}"`;
    const crew = crewCardHtml(game, b.id, { following: false, picking: false });
    // «едет … строить «Улица 1+1 · …»» — название ссылкой; осталось ехать — 📏.
    expect(crew).toContain(`${link} data-tip="К стройке «${title}» на карте и её карточка">«${title}»</span>`);
    expect(crew).toContain('cc-route');
    // В списке строек — значок каждой стройки ведёт к ней (сама строка — отправить бригаду).
    for (const id of ids) expect(crew).toContain(`class="bc-near-ic cc-go" data-action="build-show" data-id="${id}"`);
    const base = baseCardHtml(game, b.base);
    expect(base).toContain(`${link} data-tip="К стройке «${title}»`);

    // Закреплена на другой — «📌 «…»» тоже ссылкой.
    const other = ids.find((id) => id !== b.project)!;
    expect(game.sendBrigade(b.id, other)).toBeNull();
    const pinned = crewCardHtml(game, b.id, { following: false, picking: false });
    expect(pinned).toContain(`📌 <span class="pc-site-link" data-action="build-show" data-id="${other}"`);
  });
});
