import { MONTH_LENGTH } from '../config';

/** Время в пути в игровых месяцах: секунды симуляции / длина месяца. */
export function travelMonths(seconds: number): number {
  return Math.max(0, seconds) / MONTH_LENGTH;
}

/** Месяцы коротко: «0,4 мес.», «2,5 мес.»; от 10 месяцев — целыми, совсем мало — «< 0,1 мес.». */
export function monthsText(seconds: number): string {
  const m = travelMonths(seconds);
  if (m < 0.1) return '< 0,1 мес.';
  const v = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10;
  return `${v.toLocaleString('ru-RU')} мес.`;
}

/** Время в пути для карточки маршрута: секунды, как у интервала, а в скобках — сколько это месяцев: «124 с (1 мес.)». */
export function travelTimeText(seconds: number): string {
  const s = Math.round(Math.max(0, seconds));
  return `${s.toLocaleString('ru-RU')} с (${monthsText(seconds)})`;
}
