import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { anchorOf, road, STREET, withoutCitizens } from '../game/testkit';
import type { WorldSettings } from '../world/settings';
import { buildCompactHtml, buildTabHtml } from './constructionUi';
import { leftPanelHtml, leftTabs, type PanelView } from './scenarioUi';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

const view = (collapsed = false): PanelView => ({ collapsed, open: new Set(), confirmAdvance: false, tab: 'build' });

/** Песочница «Со строительством»: n рядов — в каждом готовый подъезд, база у него и проект улицы от его тупика. */
function rows(n: number): Game {
  const game = withoutCitizens(new Game(WORLD));
  let made = 0;
  for (let y = 400; y < game.terrain.height - 400 && made < n; y += 240) {
    for (let x = 300; x < game.terrain.width - 900 && made < n; x += 160) {
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x: x - 150, y } }), anchorOf(game, { free: { x: x + 600, y } }), STREET);
      if (!plan.ok || plan.demolish.length) continue;
      if (!road(game, { free: { x: x - 150, y } }, { free: { x, y } })) continue;
      if (game.buildBase({ x: x - 75, y: y - 40 })) continue;
      const end = [...game.roads.net.nodes.values()].find((p) => Math.hypot(p.pos.x - x, p.pos.y - y) < 1)!;
      const p = game.roadBuilder.road(anchorOf(game, end.id), anchorOf(game, { free: { x: x + 600, y } }), STREET, { project: true });
      expect(p.ok && game.roadBuilder.apply(p)).toBe(true);
      made++;
      break;
    }
  }
  expect(made).toBe(n);
  return game;
}

describe('Вкладка «Стройка» левой панели', () => {
  it('песочница без стройки — левой панели нет', () => {
    const game = new Game({ ...WORLD, construction: 'instant' });
    expect(leftTabs(game)).toEqual([]);
    expect(leftPanelHtml(game, view())).toBe('');
    expect(buildTabHtml(game)).toBe('');
  });

  it('песочница «Со строительством» — одна вкладка «Стройка» заголовком; пусто — подсказки и «＋ База · бесплатно»', () => {
    const game = withoutCitizens(new Game(WORLD));
    expect(leftTabs(game)).toEqual(['build']);
    const html = leftPanelHtml(game, { ...view(), tab: 'scenario' });
    expect(html).not.toContain('lp-tabs');
    expect(html).toContain('<h3>Стройка</h3>');
    expect(html).toContain('data-action="sc-toggle"');
    expect(html.match(/class="build-hint"/g)?.length).toBe(2);
    expect(html).toContain('build-add  first');
    expect(html).toContain('＋ База · бесплатно');
    expect(html).not.toContain('title=');
  });

  it('все базы и все проекты — без «ещё N»; открытые карточки и нажатая «＋ База» видны', () => {
    const game = rows(5);
    const bases = [...game.construction.crews.bases.keys()];
    const projects = game.construction.list();
    expect(bases.length).toBe(5);
    expect(projects.length).toBe(5);
    const html = buildTabHtml(game, { placing: true, project: projects[4].project.id, base: bases[3] });
    expect(html.match(/data-action="base-show"/g)?.length).toBe(5);
    expect(html.match(/class="build-plate/g)?.length).toBe(5);
    for (const p of projects) {
      expect(html).toContain(`data-action="build-pause" data-id="${p.project.id}"`);
      expect(html).toContain(`data-action="build-cancel" data-id="${p.project.id}"`);
    }
    expect(html).toContain(`class="build-base selected" data-action="base-show" data-id="${bases[3]}"`);
    expect(html).toContain('build-plate  selected');
    expect(html).toContain('build-add active');
    expect(html).not.toMatch(/ещё \d+</);
    expect(html).not.toContain('build-more');
    expect(html).not.toContain('build-hint');
    expect(html).not.toContain('бесплатно');
    // Вкладка-заголовок и свёрнутая — одной строкой: базы, бригады в деле, проекты, «＋ База».
    const folded = leftPanelHtml(game, view(true));
    expect(folded).toContain(buildCompactHtml(game));
    expect(folded).not.toContain('build-plate');
    expect(buildCompactHtml(game)).toContain('data-tip="Баз: 5"');
    expect(buildCompactHtml(game)).toMatch(/data-tip="Проектов: 5, готово \d+% \(по длине\)"/);
    expect(buildCompactHtml(game)).toContain('data-action="base-place"');
  });
});
