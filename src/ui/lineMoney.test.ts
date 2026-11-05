import { describe, expect, it } from 'vitest';
import { lineMoneyHtml } from './lineMoney';

const line = { revenueLast: 1500, costLast: 400, revenueMonth: 700, revenueTotal: 12000 };

describe('lineMoneyHtml', () => {
  it('свёрнуто — только прибыль кнопкой со стрелкой, остальные три скрыты', () => {
    const html = lineMoneyHtml(line, false);
    expect(html).toContain('Прибыль (прошлый мес.)');
    expect(html).toContain('data-action="toggle-line-money"');
    expect(html).toContain('class="caret closed"');
    expect(html).toContain('$1');
    expect(html).not.toContain('Доход / расходы');
    expect(html).not.toContain('В этом месяце');
    expect(html).not.toContain('Всего заработано');
  });

  it('раскрыто — стрелка повёрнута, под прибылью доход / расходы, этот месяц и всего', () => {
    const html = lineMoneyHtml(line, true);
    expect(html).toContain('class="caret "');
    const order = ['Прибыль (прошлый мес.)', 'Доход / расходы', 'В этом месяце', 'Всего заработано'].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toMatch(/Доход \/ расходы<\/span><b>\$1[\s ]?500 \/ \$400<\/b>/);
    expect(html).toMatch(/В этом месяце<\/span><b>\$700<\/b>/);
    expect(html).toMatch(/Всего заработано<\/span><b>\$12[\s ]?000<\/b>/);
  });

  it('прибыль в плюсе — зелёная, в минусе — красная', () => {
    expect(lineMoneyHtml(line, false)).toContain('<b class="pos">');
    expect(lineMoneyHtml({ ...line, costLast: 2000 }, false)).toContain('<b class="neg">');
    expect(lineMoneyHtml({ ...line, costLast: 1500 }, false)).toContain('<b class="pos">');
  });
});
