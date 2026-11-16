import { describe, expect, it } from 'vitest';
import { incomeChart, monthTip } from './incomeChart';

describe('График доход / расход по месяцам', () => {
  const months = [
    { label: 'Сен 2004', income: 12_500, expense: 4_000 },
    { label: 'Окт 2004', income: 0, expense: 1_200 },
  ];

  it('каждая колонка месяца несёт data-tip с месяцем, доходом, расходом и прибылью', () => {
    const html = incomeChart(months);
    const tips = [...html.matchAll(/data-tip="([^"]*)"/g)].map((m) => m[1]);
    expect(tips).toHaveLength(2);
    expect(tips[0]).toContain('Сен 2004');
    expect(tips[0]).toContain('доход $12');
    expect(tips[0]).toContain('расход $4');
    expect(tips[0]).toContain('прибыль +$8');
    expect(html).not.toContain('<title>');
  });

  it('в нулевой месяц подсказка показывает настоящие нули и убыток', () => {
    const tip = monthTip(months[1]);
    expect(tip).toContain('доход $0');
    expect(tip).toContain('расход $1');
    expect(tip).toContain('прибыль −$1');
  });

  it('колонка ловит наведение по всей высоте', () => {
    const html = incomeChart(months, 70);
    expect(html).toContain('height="70" fill="transparent" pointer-events="all"');
  });

  it('без месяцев — пояснение вместо графика', () => {
    expect(incomeChart([])).toContain('появится');
  });
});
