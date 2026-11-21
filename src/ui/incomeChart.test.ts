import { describe, expect, it } from 'vitest';
import { EXPENSE_COLOR, INCOME_COLOR, incomeChart, incomeLegend, monthTip } from './incomeChart';

describe('График доход / расход по месяцам', () => {
  const months = [
    { label: 'Сен 2004', income: 12_500, expense: 4_000 },
    { label: 'Окт 2004', income: 0, expense: 1_200 },
  ];
  // Разряды toLocaleString — неразрывным пробелом.
  const nb = (s: string) => s.replace(/[  ]/g, ' ');

  it('подсказка — три строки: доход, расход, прибыль, без месяца', () => {
    expect(nb(monthTip(months[0])).split('\n')).toEqual(['доход $12 500', 'расход $4 000', 'прибыль +$8 500']);
  });

  it('у расходного месяца указан убыток, у нулевого итога ноль', () => {
    expect(nb(monthTip(months[1])).split('\n')).toEqual(['доход $0', 'расход $1 200', 'убыток $1 200']);
    expect(monthTip({ label: 'Ноя 2004', income: 500, expense: 500 }).split('\n')[2]).toBe('прибыль +$0');
    const rounded = { label: 'Дек 2004', income: 500, expense: 500.2 };
    expect(monthTip(rounded).split('\n')[2]).toBe('прибыль +$0');
    expect(incomeChart([rounded])).toContain('data-month-trend="even"');
  });

  it('положительные, отрицательные и нулевые суммы задают оформление результата в подсказке', () => {
    const html = incomeChart([...months, { label: 'Ноя 2004', income: 500, expense: 500 }]);
    const tips = [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => m[1]);
    expect(tips).toHaveLength(3);
    // Перевод строки в атрибуте — ссылкой &#10;: SVG-разбор не схлопнет его в пробел.
    expect(tips[0].split('&#10;')).toHaveLength(3);
    expect(tips[0]).not.toContain('Сен');
    expect([...html.matchAll(/data-month-trend="([^"]*)"/g)].map(m => m[1])).toEqual(['gain', 'loss', 'even']);
    expect(html).not.toContain('<title>');
  });

  it('квадратики легенды — тех же цветов, что столбики', () => {
    const html = incomeChart(months);
    expect(html).toContain(`fill="${INCOME_COLOR}"`);
    expect(html).toContain(`fill="${EXPENSE_COLOR}"`);
    expect(incomeLegend()).toContain(`background:${INCOME_COLOR}`);
    expect(incomeLegend()).toContain(`background:${EXPENSE_COLOR}`);
  });

  it('колонка ловит наведение по всей высоте', () => {
    const html = incomeChart(months, 70);
    expect(html).toContain('height="70" fill="transparent" pointer-events="all"');
  });

  it('без месяцев — пояснение вместо графика', () => {
    expect(incomeChart([])).toContain('появится');
  });
});
