import { clockText } from '../core/timeText';

/**
 * Время в пути для карточки маршрута — минутами и секундами игры, как сроки заданий: «1:36». Месяц — минута,
 * так что сколько это месяцев, видно и так.
 */
export function travelTimeText(seconds: number): string {
  return clockText(seconds);
}
