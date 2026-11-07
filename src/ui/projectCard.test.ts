import { describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { Game } from '../game/game';
import { anchorOf, runSeconds, STREET, withoutCitizens } from '../game/testkit';
import type { WorldSettings } from '../world/settings';
import { baseRemoveText, buildBarHtml } from './constructionUi';
import { projectCardHtml } from './projectCard';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

/** Партия «Со строительством» с проектом улицы на 600 м в чистом поле; base — поставить базу у города. */
function setup(base: boolean): { game: Game; id: number } {
  const game = withoutCitizens(new Game(WORLD));
  if (base) {
    const town = [...game.towns].sort((a, b) => b.population - a.population || a.id - b.id)[0];
    let placed = false;
    for (const k of [1, 0.75, 1.3, 0.5, 1.7]) {
      for (let i = 0; i < 24 && !placed; i++) {
        const a = (i / 24) * Math.PI * 2;
        const p = { x: town.center.x + Math.cos(a) * town.radius * k, y: town.center.y + Math.sin(a) * town.radius * k };
        const plan = game.basePlan(p);
        placed = plan.ok && !plan.demolish.length && game.buildBase(p) === null;
      }
    }
    expect(placed).toBe(true);
  }
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - 900; x += 160) {
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + 600, y } }), STREET, { project: true });
      if (plan.ok && !plan.demolish.length && game.roadBuilder.apply(plan)) return { game, id: game.construction.list()[0].project.id };
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
    const bar = buildBarHtml(game, false, null, id);
    expect(bar).toContain('build-plate  selected');
    expect(bar).toContain('🔒');
    expect(bar).toContain('⬆');
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

  it('проекта больше нет — короткая записка; снос базы — что будет, одной строкой', () => {
    const { game, id } = setup(true);
    game.cancelProject(id);
    expect(projectCardHtml(game, id)).toContain('Проекта больше нет');
    const base = [...game.construction.crews.bases.keys()][0];
    expect(baseRemoveText(game, base)).toContain('первая была бесплатной');
    expect(baseRemoveText(game, base)).toContain('распустить');
    expect(buildBarHtml(game, false, null, null, base)).toContain('✕ Снести?');
  });
});
