import { describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { dist, type Vec } from '../core/vec';
import { type Corridor, oneWay, twoWay } from '../lanes/model';
import { projectCardHtml } from '../ui/projectCard';
import type { RoadClass } from '../world/roadTypes';
import type { WorldSettings } from '../world/settings';
import { crewCap } from './constructionWork';
import { type CrewHost, Crews, type Site } from './crews';
import { Game } from './game';
import { anchorOf, road, runSeconds, STREET, withoutCitizens } from './testkit';

/** Предел бригад на проекте по ширине: на однополосном полотне (съезд, заезд) техника встаёт не больше чем в два ряда. */
describe('Бригад на проекте — по ширине полотна', () => {
  const lanes = (n: number) => ({ lanes: n === 1 ? oneWay(1) : n === 2 ? twoWay(1, 1) : twoWay(2, 2) }) as unknown as Corridor;

  it('есть полотно в одну полосу — не больше perNarrow (2), иначе perProject (3)', () => {
    expect(CONSTRUCTION.brigade.perNarrow).toBe(2);
    expect(crewCap([lanes(2)])).toBe(CONSTRUCTION.brigade.perProject);
    expect(crewCap([lanes(4), lanes(2)])).toBe(CONSTRUCTION.brigade.perProject);
    expect(crewCap([lanes(1)])).toBe(2);
    // Проект из широкой дороги и съезда — по самому узкому.
    expect(crewCap([lanes(4), lanes(1)])).toBe(2);
    expect(crewCap([])).toBe(CONSTRUCTION.brigade.perProject);
  });

  /** Бригады без игры: проект 7 с подъездом у узла 571, края работ — в 300 м вдоль стройки; cap — сколько встанет. */
  function bench(n: number) {
    const host: CrewHost & { time: number; limit: number } = {
      time: 0,
      limit: 3,
      crewProjects: () => [7],
      cap: () => host.limit,
      site: () => ({ node: 571, pos: { x: 600, y: -300 } }) satisfies Site,
      path: () => [{ x: 600, y: 0 }, { x: 600, y: -300 }],
      reach: () => true,
      drive: () => 42,
      park: () => {},
      onRoad: (node: number) => node >= 0,
    };
    const crews = new Crews(host);
    // Ворота базы — сам узел подъезда: бригады едут сразу вдоль стройки, без колонны в потоке.
    crews.bases.set(100, { type: 'base', id: 100, fp: { center: { x: 600, y: 20 }, w: 36, h: 24, angle: 0 }, nodeId: 571, paid: 0 });
    crews.firstUsed = true;
    for (let i = 0; i < n; i++) crews.hire(100);
    const tick = () => {
      host.time = Math.round((host.time + 0.1) * 10) / 10;
      crews.tick();
    };
    return { host, crews, tick };
  }

  it('узкий проект: третья бригада не едет; стал узким, когда бригад уже три, — лишняя уезжает вдоль стройки, а не исчезает', () => {
    const t = bench(3);
    t.host.limit = 2;
    for (let i = 0; i < 100; i++) t.tick();
    expect(t.crews.assigned(7)).toHaveLength(2);
    expect([...t.crews.brigades.values()].filter((b) => b.project === undefined)).toHaveLength(1);

    const w = bench(3);
    for (let i = 0; i < 300; i++) w.tick();
    expect(w.crews.working(7)).toHaveLength(3);
    w.host.limit = 2;
    w.tick();
    expect(w.crews.assigned(7)).toHaveLength(2);
    const extra = [...w.crews.brigades.values()].find((b) => b.project === undefined)!;
    // Отпущена с наибольшим номером, едет назад вдоль стройки от края работ — не перескоком на базу.
    expect(extra.id).toBe(Math.max(...[...w.crews.brigades.keys()]));
    expect(extra.state).toBe('back');
    expect(extra.trip?.back).toBe(true);
    expect(dist(extra.pos!, { x: 600, y: -300 })).toBeLessThan(1e-6);
  });

  describe('в игре', () => {
    const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 50_000_000, water: 'dry', construction: 'build' };
    const RAMP = { cls: 'street' as RoadClass, lanes: oneWay(1) };

    /** Место в поле, далеко от городов: ровная полоса в len метров вдоль x. */
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

    /** Готовая дорога с базой на три бригады и проект от её конца профилем spec: номер проекта. */
    function scene(spec: typeof STREET | typeof RAMP): { game: Game; id: number } {
      const game = withoutCitizens(new Game(WORLD));
      const at = field(game, 900);
      expect(road(game, { free: at }, { free: { x: at.x + 300, y: at.y } })).toBe(true);
      expect(game.buildBase({ x: at.x + 150, y: at.y - 40 })).toBeNull();
      const crews = game.construction.crews;
      const base = [...crews.bases.values()][0];
      while (crews.of(base.id).length < 3) expect(crews.hire(base.id)).not.toBeNull();
      const end = [...game.roads.net.nodes.values()].find((n) => dist(n.pos, { x: at.x + 300, y: at.y }) < 1)!.id;
      const id = game.construction.peekId();
      const plan = game.roadBuilder.road(anchorOf(game, end), anchorOf(game, { free: { x: at.x + 900, y: at.y } }), spec, { project: true });
      expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
      return { game, id };
    }

    it('однополосный съезд: на проекте не больше двух бригад, в карточке — «из 2»; улица 1+1 — три, «из 3»', () => {
      const ramp = scene(RAMP);
      let most = 0;
      for (let t = 0; t < 60; t += 0.5) {
        runSeconds(ramp.game, 0.5);
        most = Math.max(most, ramp.game.construction.crews.assigned(ramp.id).length);
      }
      expect(most).toBe(2);
      expect(ramp.game.construction.crews.working(ramp.id)).toHaveLength(2);
      expect(projectCardHtml(ramp.game, ramp.id)).toContain('<span class="muted"> из 2</span>');

      const street = scene(STREET);
      runSeconds(street.game, 60);
      expect(street.game.construction.crews.assigned(street.id)).toHaveLength(3);
      expect(projectCardHtml(street.game, street.id)).toContain('<span class="muted"> из 3</span>');
    });
  });
});
