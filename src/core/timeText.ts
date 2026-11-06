/**
 * Время для игрока — минутами и секундами игрового времени (на скорости 1× это реальное время): сроки заданий
 * и контрактов, сколько осталось думать, время в пути, ожидание. Месяц партии — минута (MONTH_LENGTH), поэтому
 * сроки не пишем месяцами: «через 3:20», «на 4 мин». Месяц и год остаются только в дате и в помесячных графиках.
 */

/** «м:сс» с округлением до секунды: 200 → «3:20», 59.6 → «1:00», час и больше — тоже минутами (3725 → «62:05»). */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Длительность коротко: целые минуты — «2 мин», меньше минуты — «45 с», остальное — «м:сс» (clockText). */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  if (s < 60) return `${s} с`;
  return s % 60 === 0 ? `${s / 60} мин` : clockText(s);
}
