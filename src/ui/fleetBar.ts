/**
 * Ряд машин авто-парка в карточке маршрута: сколько значков рисовать и сколько дописать «+N».
 * Значки идут с постоянным шагом, поэтому вместимость ряда — в значках; каждый значок-флаг (💸, ▼)
 * занимает одно место, «+N» — тоже одно.
 */
const FLEET_SLOT_PX = 20;
/** Всё в ширине панели, кроме значков: поля секции и ряда, число «сейчас», черта минимума. */
const FLEET_BAR_CHROME_PX = 100;
/** Панель ещё не на экране (ширина 0) — столько мест, сколько в самой узкой. */
const FLEET_BAR_FALLBACK = 12;

/** Сколько значков помещается в ряд на панели такой ширины. */
export function fleetBarRoom(panelWidth: number): number {
  if (!(panelWidth > 0)) return FLEET_BAR_FALLBACK;
  return Math.max(2, Math.floor((panelWidth - FLEET_BAR_CHROME_PX) / FLEET_SLOT_PX));
}

export function fleetBar(n: number, max: number, room: number, flags = 0): { shown: number; more: number } {
  const total = Math.max(n, max, 0);
  const free = Math.max(2, room - flags);
  if (total <= free) return { shown: total, more: 0 };
  const shown = free - 1;
  return { shown, more: total - shown };
}
