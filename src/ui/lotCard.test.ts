import { describe, expect, it } from 'vitest';
import { freshGame } from '../game/testkit';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { lotStallCount } from '../world/parkingLots';
import { lotCardHtml, lotRowsHtml } from './lotCard';

describe('Карточка площадки-стоянки', { timeout: 120_000 }, () => {
  it('строка — значок, подпись и значение; подсказка в data-tip, без title', () => {
    const html = lotRowsHtml([
      { icon: '🅿️', label: 'Мест', value: '24', tip: 'Подсказка <b>' },
      { icon: '✋', label: 'Отказов', value: '3', tip: 'Не хватило места', harm: true },
      { icon: '🛒', label: 'Магазины и рынок', value: '1', tip: 'Магазины', sub: true },
    ]);
    expect(html).toContain('<li class="lot-row" data-tip="Подсказка &lt;b&gt;"><i>🅿️</i><span>Мест</span><b>24</b></li>');
    expect(html).toContain('<li class="lot-row harm" data-tip="Не хватило места"><i>✋</i><span>Отказов</span><b>3</b></li>');
    expect(html).toContain('class="lot-row sub"');
    expect(html).not.toContain('title=');
  });

  it('город поставил площадку: места, занятость, ворота, чья и счёт месяца — строками с текстом', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1, size: 'medium' });
    const ref = g.lots.all()[0];
    expect(ref).toBeDefined();
    const html = lotCardHtml(g, ref.lot.id);
    const n = lotStallCount(ref.lot);
    expect(html).toContain(`<span>Мест</span><b>${n}</b>`);
    expect(html).toMatch(/<span>Занято<\/span><b><em class="dots">[●○]{4}<\/em> \d+ из \d+<\/b>/);
    for (const label of ['Ворота', 'Машин встало', 'Жильё и гости', 'Магазины и рынок', 'Работа', 'Станции', 'Стоят в среднем', 'Отказов'])
      expect(html).toContain(`<span>${label}</span>`);
    expect(html).toMatch(/<span>(Поставил город|Ваша, содержание)<\/span>/);
    expect(html).toContain('<h4 class="lot-caption">В этом месяце</h4>');
    expect(html).not.toContain('title=');
  });

  it('снесённой площадки нет — так и пишем', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1, size: 'medium' });
    expect(lotCardHtml(g, -1)).toContain('Её больше нет.');
  });
});
