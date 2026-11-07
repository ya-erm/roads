import { describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { Game } from '../game/game';
import { anchorOf, road, runSeconds, STREET, withoutCitizens } from '../game/testkit';
import type { WorldSettings } from '../world/settings';
import { baseRemoveText, buildTabHtml } from './constructionUi';
import { baseCardHtml } from './baseCard';
import { projectCardHtml } from './projectCard';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

/**
 * Партия «Со строительством» с проектом улицы на 600 м в поле: base — от тупика готового подъезда, у которого первая
 * база, иначе — сам по себе, баз нет.
 */
function setup(base: boolean): { game: Game; id: number } {
  const game = withoutCitizens(new Game(WORLD));
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - 900; x += 160) {
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x: x - 150, y } }), anchorOf(game, { free: { x: x + 600, y } }), STREET);
      if (!plan.ok || plan.demolish.length) continue;
      if (base) {
        // Готовый подъезд с базой (первой, бесплатной) у него и проект от его тупика: по полю бригады не ездят.
        expect(road(game, { free: { x: x - 150, y } }, { free: { x, y } })).toBe(true);
        expect(game.buildBase({ x: x - 75, y: y - 40 })).toBeNull();
        const end = [...game.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - x, n.pos.y - y) < 1)!;
        const p = game.roadBuilder.road(anchorOf(game, end.id), anchorOf(game, { free: { x: x + 600, y } }), STREET, { project: true });
        expect(p.ok && game.roadBuilder.apply(p)).toBe(true);
      } else {
        const p = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + 600, y } }), STREET, { project: true });
        expect(p.ok && game.roadBuilder.apply(p)).toBe(true);
      }
      return { game, id: game.construction.list()[0].project.id };
    }
  }
  throw new Error('нет места');
}

describe('Карточка проекта стройки', () => {
  it('что строим, готовность по этапам, сроки, деньги, бригады и кнопки', () => {
    const { game, id } = setup(true);
    runSeconds(game, 1);
    const html = projectCardHtml(game, id);
    const p = game.construction.projects.get(id)!;
    expect(html).toContain(p.label);
    expect(html).toContain('📏');
    expect(html).toContain('Отсыпка');
    expect(html).toContain('pc-stage');
    expect(html).toContain('⏳');
    // С ещё одной бригадой — быстрее.
    expect(html).toContain('＋🚚');
    expect(html).toContain('data-action="project-reserve"');
    expect(html).toContain('data-action="project-priority"');
    expect(html).toContain('data-action="build-pause"');
    expect(html).toContain('data-action="build-cancel"');
    // Бригада едет (или уже строит) — строкой со ссылкой «показать на карте».
    expect(html).toContain('data-action="crew-show"');
    // Подсказки — свои, не системные.
    expect(html).not.toContain(' title=');
  });

  it('резерв и приоритет видны: 🔒 в деньгах, ⬆ в заголовке, «Снять резерв»; на плашке слева — значки', () => {
    const { game, id } = setup(true);
    game.reserveProject(id, true);
    game.prioritizeProject(id, true);
    const html = projectCardHtml(game, id);
    expect(html).toContain('Снять резерв');
    expect(html).toContain('резерв покрывает всё');
    expect(html).toContain('pc-prio');
    expect(html).toContain('⬆ Приоритет ✓');
    const bar = buildTabHtml(game, { placing: false, project: id, base: null });
    expect(bar).toContain('build-plate  selected');
    expect(bar).toContain('🔒');
    expect(bar).toContain('⬆');
  });

  it('название: клик или ✎ — поле; своё название — в карточке, на вкладке «Стройка» и у базы', () => {
    const { game, id } = setup(true);
    const p = game.construction.projects.get(id)!;
    const html = projectCardHtml(game, id);
    expect(html).toContain(`data-action="project-rename" data-id="${id}"`);
    expect(html).toContain('✎');
    expect(html).not.toContain('data-project-name');
    const field = projectCardHtml(game, id, true);
    expect(field).toContain(`data-project-name="${id}"`);
    expect(field).toContain(`placeholder="${p.label}"`);
    game.renameProject(id, 'Объезд <рынка>');
    expect(projectCardHtml(game, id)).toContain('Объезд &lt;рынка&gt;');
    const tab = buildTabHtml(game, { placing: false, project: null, base: null });
    expect(tab).toContain('Объезд &lt;рынка&gt;');
    expect(tab).not.toContain(`>${p.label}<`);
    const base = [...game.construction.crews.bases.keys()][0];
    expect(baseCardHtml(game, base)).toContain('Объезд &lt;рынка&gt;');
    expect(projectCardHtml(game, id, true)).not.toContain(' title=');
  });

  it('бригад нет: почему и кнопка — без базы «＋ База», все заняты — «⬆ Приоритет»', () => {
    const none = setup(false);
    expect(projectCardHtml(none.game, none.id)).toContain('Нет строительной базы');
    expect(projectCardHtml(none.game, none.id)).toContain('data-action="base-place"');
    const { game, id } = setup(true);
    // Единственная бригада занята на другом проекте.
    const crew = [...game.construction.crews.brigades.values()][0];
    crew.state = 'working';
    crew.project = id + 100;
    const html = projectCardHtml(game, id);
    expect(html).toContain('Все бригады заняты');
    expect(html).toContain('«⬆ Приоритет» заберёт одну сюда');
    expect(html).toContain(`＋ 🚚 $${CONSTRUCTION.brigade.cost.toLocaleString('ru-RU')}`);
  });

  it('проекта больше нет — короткая записка; снос базы — что будет, одной строкой (у курсора «Сноса»)', () => {
    const { game, id } = setup(true);
    game.cancelProject(id);
    expect(projectCardHtml(game, id)).toContain('Проекта больше нет');
    const base = [...game.construction.crews.bases.keys()][0];
    expect(baseRemoveText(game, base)).toContain('первая была бесплатной');
    expect(baseRemoveText(game, base)).toContain('распустить');
    // На плашке слева сноса нет — только «Сносом» по площадке.
    expect(buildTabHtml(game, { placing: false, project: null, base })).not.toContain('base-remove');
  });
});
