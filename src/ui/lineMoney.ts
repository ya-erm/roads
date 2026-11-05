import type { Line } from '../game/transport';
import { chevronSvg } from './icons';

/** Деньги линии, которые показывает карточка маршрута. */
export type LineMoney = Pick<Line, 'revenueLast' | 'costLast' | 'revenueMonth' | 'revenueTotal'>;

const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;

/**
 * Деньги в сводке карточки линии (ячейки сетки .kv): на виду — прибыль за прошлый месяц
 * кнопкой со стрелкой; раскрыта — под ней доход / расходы, этот месяц и всего заработано.
 */
export function lineMoneyHtml(line: LineMoney, open: boolean): string {
  const profit = line.revenueLast - line.costLast;
  const tip = `${open ? 'Свернуть' : 'Развернуть'}: доход и расходы, этот месяц, всего заработано`;
  const row = `<span>Прибыль (прошлый мес.)</span><b class="${profit >= 0 ? 'pos' : 'neg'}"><button class="speed-toggle" data-action="toggle-line-money" title="${tip}">${money(
    profit,
  )}<span class="caret ${open ? '' : 'closed'}">${chevronSvg(10)}</span></button></b>`;
  if (!open) return row;
  return `${row}
        <span class="kv-sub">Доход / расходы</span><b>${money(line.revenueLast)} / ${money(line.costLast)}</b>
        <span class="kv-sub">В этом месяце</span><b>${money(line.revenueMonth)}</b>
        <span class="kv-sub">Всего заработано</span><b>${money(line.revenueTotal)}</b>`;
}
