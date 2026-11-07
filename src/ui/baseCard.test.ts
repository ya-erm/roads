import { describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { Game } from '../game/game';
import { anchorOf, road, runSeconds, STREET, withoutCitizens } from '../game/testkit';
import type { WorldSettings } from '../world/settings';
import { baseCardHtml } from './baseCard';
import { buildTabHtml } from './constructionUi';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

/** Готовый подъезд в поле, база у него и проект улицы на 600 м от его тупика; ещё проект в поле без подъезда. */
function setup(): { game: Game; base: number; project: number; blocked: number } {
  const game = withoutCitizens(new Game(WORLD));
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - 1600; x += 160) {
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x: x - 150, y } }), anchorOf(game, { free: { x: x + 1500, y } }), STREET);
      if (!plan.ok || plan.demolish.length) continue;
      expect(road(game, { free: { x: x - 150, y } }, { free: { x, y } })).toBe(true);
      expect(game.buildBase({ x: x - 75, y: y - 40 })).toBeNull();
      const end = [...game.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - x, n.pos.y - y) < 1)!;
      const project = game.construction.peekId();
      const p = game.roadBuilder.road(anchorOf(game, end.id), anchorOf(game, { free: { x: x + 600, y } }), STREET, { project: true });
      expect(p.ok && game.roadBuilder.apply(p)).toBe(true);
      const blocked = game.construction.peekId();
      const q = game.roadBuilder.road(anchorOf(game, { free: { x: x + 1000, y } }), anchorOf(game, { free: { x: x + 1500, y } }), STREET, { project: true });
      expect(q.ok && game.roadBuilder.apply(q)).toBe(true);
      return { game, base: [...game.construction.crews.bases.keys()][0], project, blocked };
    }
  }
  throw new Error('нет места');
}

describe('Карточка строительной базы', () => {
  it('название, сводка, бригады и что делают, нанять и распустить, ближние стройки; сноса кнопкой нет', () => {
    const { game, base, project, blocked } = setup();
    expect(game.hireBrigade(base)).toBeNull();
    runSeconds(game, 30);
    const html = baseCardHtml(game, base);
    expect(html).toContain(game.baseName(base));
    expect(html).toContain('data-action="base-rename"');
    // Сводка: бригад, в деле, содержание в месяц.
    expect(html).toContain('🚚 <b>2</b>');
    expect(html).toContain('в деле');
    expect(html).toContain(`$${Math.round(2 * CONSTRUCTION.brigade.upkeep).toLocaleString('ru-RU')}`);
    // Бригады: что делают, клик — к ней на карте.
    expect(html.match(/data-action="crew-show"/g)?.length).toBe(2);
    expect(html).toContain(`строит «${game.construction.info(project)!.project.label}»`);
    expect(html).toContain('data-action="base-hire"');
    expect(html).toContain('data-action="base-fire"');
    // Ближние стройки: ближняя — первой, у той, к которой нет подъезда, — «⛔».
    const near = html.indexOf(`data-action="build-show" data-id="${project}"`);
    const far = html.indexOf(`data-action="build-show" data-id="${blocked}"`);
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    expect(html).toContain('⛔ нет подъезда');
    // Снос — только инструментом «Снос».
    expect(html).not.toContain('base-remove');
    expect(html).toContain('инструментом «Снос»');
    expect(html).not.toContain(' title=');
    // Переименование — поле ввода.
    expect(baseCardHtml(game, base, true)).toContain(`data-base-name="${base}"`);
    // Базы больше нет — записка.
    expect(baseCardHtml(game, -1)).toContain('Базы больше нет');
  });

  it('строка базы на плашке — коротко: название, число бригад и сколько в деле; клик — карточка', () => {
    const { game, base } = setup();
    expect(game.hireBrigade(base)).toBeNull();
    runSeconds(game, 30);
    const bar = buildTabHtml(game, { placing: false, project: null, base });
    expect(bar).toContain(`class="build-base selected" data-action="base-show" data-id="${base}"`);
    expect(bar).toContain(game.baseName(base));
    expect(bar).toContain('🚚 <b>2</b>');
    expect(bar).toMatch(/в деле [12]/);
    // Самосвалов, «−», «＋ 🚚» и «✕» на плашке больше нет — они в карточке (а снос — «Сносом»).
    for (const gone of ['crew-show', 'base-fire', 'base-hire', 'base-remove', 'base-rename']) expect(bar).not.toContain(gone);
  });
});
