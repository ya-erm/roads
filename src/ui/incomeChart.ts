import { money } from '../core/moneyText';

export interface IncomeMonth {
  label: string;
  income: number;
  expense: number;
}

/** Цвета столбиков — те же у квадратиков легенды «доход / расход» и у меток строк подсказки. */
export const INCOME_COLOR = '#3fae6a';
export const EXPENSE_COLOR = '#e5534b';

/** Легенда графика: квадратики цветов столбиков. */
export const incomeLegend = () => `<span class="legend"><i style="background:${INCOME_COLOR}"></i>доход <i style="background:${EXPENSE_COLOR}"></i>расход</span>`;

const escAttr = (s: string) => s.replace(/[&<>"\n]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#10;' })[c]!);

/** Подпись месяца под столбиком графика: «Май» из «Май 1962». */
export const monthTick = (x: number, H: number, label: string) =>
  `<text x="${x}" y="${H - 2}" text-anchor="middle" font-size="8" fill="#7b8794">${label.split(' ')[0]}</text>`;

/**
 * Подсказка колонки месяца — три строки: доход, расход и прибыль (в минусе — «убыток»), настоящие суммы, в том числе
 * нули. Месяц не пишем: он подписан под колонкой.
 */
export function monthTip(m: IncomeMonth): string {
  const profit = m.income - m.expense;
  const net = profit >= 0 ? `прибыль +${money(profit)}` : `убыток ${money(-profit)}`;
  const trend = profit > 0 ? ' 📈' : profit < 0 ? ' 📉' : '';
  return [`доход ${money(m.income)}`, `расход ${money(m.expense)}`, net + trend].join('\n');
}

/** Квадратики легенды для строк дохода и расхода в подсказке (data-tip-marks). */
export const MONTH_TIP_MARKS = `${INCOME_COLOR}|${EXPENSE_COLOR}|`;

/**
 * Столбики «доход / расход» по месяцам — для компании и для линии. Наведение — на всю колонку месяца
 * (прозрачный прямоугольник во всю высоту) с data-tip. Нулевой месяц рисуется столбиком минимальной высоты,
 * чтобы он был виден; настоящие суммы — в подсказке.
 */
export function incomeChart(months: IncomeMonth[], H = 90): string {
  if (!months.length) return '<p class="muted">График появится после первого месяца.</p>';
  const max = Math.max(1, ...months.map((m) => Math.max(m.income, m.expense)));
  const W = 300;
  const bw = W / Math.max(12, months.length);
  const bars = months
    .map((m, i) => {
      const x = i * bw;
      const hi = (m.income / max) * (H - 14);
      const he = (m.expense / max) * (H - 14);
      return `<g class="fin-month" data-tip="${escAttr(monthTip(m))}" data-tip-marks="${MONTH_TIP_MARKS}">
        <rect x="${x}" y="0" width="${bw}" height="${H}" fill="transparent" pointer-events="all"/>
        <rect x="${x + 2}" y="${H - 12 - hi}" width="${bw / 2 - 2}" height="${hi}" rx="1.5" fill="${INCOME_COLOR}"/>
        <rect x="${x + bw / 2}" y="${H - 12 - he}" width="${bw / 2 - 2}" height="${he}" rx="1.5" fill="${EXPENSE_COLOR}"/>
        ${monthTick(x + bw / 2, H, m.label)}</g>`;
    })
    .join('');
  return `<svg class="fin-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${bars}</svg>`;
}
