import type { Selection } from '../render/renderer';

/** Карточка маршрута открыта из панели города: крестик вернёт к этому городу. */
export interface LineBack {
  line: number;
  town: number;
}

/**
 * Куда вернёт крестик карточки маршрута, открытой кликом в списке маршрутов: из панели города — к ней,
 * из общего списка, станции или предприятия — никуда (карточка просто закроется, как раньше).
 */
export function lineBackFrom(sel: Selection | null, line: number): LineBack | null {
  return sel?.type === 'town' ? { line, town: sel.id } : null;
}

/**
 * Что выбрать, когда карточку маршрута закрыли крестиком: город, из которого её открыли, — если открыта
 * всё та же карточка и город ещё есть; иначе ничего (выбор снимается).
 */
export function lineCloseTarget(back: LineBack | null, openLine: number | null, towns: readonly { id: number }[]): Selection | null {
  if (!back || openLine === null || back.line !== openLine) return null;
  return towns.some((t) => t.id === back.town) ? { type: 'town', id: back.town } : null;
}
