/**
 * Пассажиры города по месяцам — для блока «Что нужно городу»: сколько жителей хотят ездить (по городу и в другие
 * города) и сколько из них уже довезли линии. Довезённых считаем по городу отправления: Town.paxMonth — куда
 * доехали в этом месяце (id города назначения, свой id — поездка по городу), Town.paxLast — итог прошлого месяца.
 */
import { MONTH_LENGTH, TOWN_TRAFFIC } from '../config';
import type { Town } from './entities';

/**
 * Сколько пассажиров в секунду появляется на 1000 жителей в охвате станции, откуда ходит пассажирская линия
 * (Game.paxArrivals). Весь город у остановок — столько жителей в месяц и хотят ехать.
 */
export const PAX_PER_THOUSAND = 1.2;

/** Ключ поездки в Town.paxMonth, когда станция назначения не в городе (в поле, у предприятия). */
export const PAX_NOWHERE = -1;

/** Поездки по городу и в другие города. */
export interface PaxSplit {
  city: number;
  intercity: number;
}

/**
 * Сколько жителей хотят ездить за месяц: столько пассажиров дал бы город, живи все у остановок с линиями;
 * в другие города — та же доля, что у поездок жителей на машине (TOWN_TRAFFIC.intercityShare). k — сценарный
 * множитель пассажиров города (mods.pax).
 */
export function townPaxWant(population: number, k = 1): PaxSplit {
  const total = Math.round((Math.max(0, population) / 1000) * PAX_PER_THOUSAND * MONTH_LENGTH * k);
  const intercity = Math.round(total * TOWN_TRAFFIC.intercityShare);
  return { city: total - intercity, intercity };
}

/** Довезли count пассажиров из города town в город to (свой id — по городу, PAX_NOWHERE — за город). */
export function addTownPax(town: Pick<Town, 'paxMonth'>, to: number, count: number): void {
  if (count <= 0) return;
  const month = (town.paxMonth ??= {});
  month[to] = (month[to] ?? 0) + count;
}

/** Закрывает месяц: довезённые уходят в прошлый месяц, новый начинается с нуля. */
export function closeTownPax(town: Pick<Town, 'paxMonth' | 'paxLast'>): void {
  if (town.paxMonth && Object.keys(town.paxMonth).length) town.paxLast = town.paxMonth;
  else delete town.paxLast;
  delete town.paxMonth;
}

/** Довезённые по городу и в другие города — из записи месяца (Town.paxMonth или Town.paxLast). */
export function paxSplit(townId: number, record: Readonly<Record<number, number>> | undefined): PaxSplit {
  const out: PaxSplit = { city: 0, intercity: 0 };
  for (const [to, n] of Object.entries(record ?? {})) {
    if (Number(to) === townId) out.city += n;
    else out.intercity += n;
  }
  return out;
}
