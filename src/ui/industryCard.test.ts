import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { freightRoute, nearestPair, withoutCitizens } from '../game/testkit';
import { CARGO, INDUSTRY_TYPES } from '../world/cargo';
import { DEFAULT_SETTINGS } from '../world/settings';
import { cargoTip } from './cargoIcons';
import { industryFlowHtml, recipeBoxHtml, recipeText } from './industryCard';

describe('рецепт словами', () => {
  it('завод: сырьё через «+», продукция после стрелки; добыча — только продукция', () => {
    expect(recipeText(INDUSTRY_TYPES.glassworks)).toBe('песок + уголь → стекло');
    expect(recipeText(INDUSTRY_TYPES.coalmine)).toBe('уголь');
  });

  it('значки рецепта — с названиями под ними и подсказкой data-tip, без системных title', () => {
    const html = recipeBoxHtml(INDUSTRY_TYPES.glassworks);
    for (const c of ['sand', 'coal', 'glass'] as const) {
      expect(html).toContain(`<small>${CARGO[c].name}</small>`);
      expect(html).toContain(`data-tip="${CARGO[c].name}"`);
    }
    expect(html).not.toMatch(/<title>|\stitle="/);
    expect(cargoTip('sand', 18)).toMatch(/^<svg data-tip="Песок" class="cargo-icon"/);
  });
});

describe('карточка предприятия: сырьё, склад, откуда и куда везут', () => {
  it('без маршрута — «Не подвозят» с названием сырья и «не вывозят»', () => {
    const g = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 5 }));
    const { b: plant } = nearestPair(g, 'farm', 'foodplant');
    const html = industryFlowHtml(g, plant);
    expect(html).toContain('Не подвозят: <b>зерно</b>');
    expect(html).toContain('<b>Зерно</b>');
    expect(html).toContain('📦 0');
    expect(html).toContain('не вывозят');
    expect(html).not.toMatch(/<title>|\stitle="/);
  });

  it('по маршруту — ссылки на поставщика и получателя; пусто на складе — «Ждёт»', () => {
    const g = withoutCitizens(new Game({ ...DEFAULT_SETTINGS, seed: 5 }));
    const { from: farm, to: plant } = freightRoute(g);
    const html = industryFlowHtml(g, plant);
    expect(html).toContain(`data-action="focus" data-type="industry" data-id="${farm.id}"`);
    expect(html).not.toContain('Не подвозят');
    expect(html).toContain('Ждёт: <b>зерно</b>');
    plant.stock.grain = 12.7;
    expect(industryFlowHtml(g, plant)).toContain('📦 12');
    expect(industryFlowHtml(g, plant)).not.toContain('Ждёт');
    expect(industryFlowHtml(g, farm)).toContain(`data-action="focus" data-type="industry" data-id="${plant.id}"`);
  });
});
