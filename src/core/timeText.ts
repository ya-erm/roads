/**
 * Время для игрока — минутами и секундами игрового времени (на скорости 1× это реальное время): сроки заданий
 * и контрактов, сколько осталось думать, время в пути, ожидание. Месяц партии — минута (MONTH_LENGTH), поэтому
 * сроки не пишем месяцами: «⏳ 5 мин» до срока задания (последнюю минуту — «59 сек»), «⌛ 3:20» до конца
 * предложения, «на 4 мин». Месяц и год остаются только в дате и в помесячных графиках.
 */

/** «м:сс» с округлением до секунды: 200 → «3:20», 59.6 → «1:00», час и больше — тоже минутами (3725 → «62:05»). */
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Сколько осталось до срока — спокойно, без бегущих секунд: целыми минутами с округлением вверх (только что
 * выданное задание на 5 минут — «5 мин», а не «4 мин»; 4:01 — тоже «5 мин»), а последнюю минуту — секундами:
 * «59 сек», «58 сек»… Для сроков заданий в панели сценария; таймер предложения контракта — clockText.
 */
export function leftText(seconds: number): string {
  const left = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  if (left < 60) return `${Math.min(59, Math.ceil(left - 1e-9))} сек`;
  return `${Math.ceil(left / 60 - 1e-9)} мин`;
}

/** Длительность коротко: целые минуты — «2 мин», меньше минуты — «45 с», остальное — «м:сс» (clockText). */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  if (s < 60) return `${s} с`;
  return s % 60 === 0 ? `${s / 60} мин` : clockText(s);
}
