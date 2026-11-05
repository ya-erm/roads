import { chevronSvg } from './icons';

/** Остановка маршрута в карточке линии: какая линия и какая по счёту остановка. */
export interface StopKey {
  line: number;
  i: number;
}

/** Клик по остановке: раскрывает её настройку, повторный клик по ней же — сворачивает, по другой — переключает. */
export function toggleStop(open: StopKey | null, key: StopKey): StopKey | null {
  return open?.line === key.line && open.i === key.i ? null : key;
}

/**
 * Номер остановки в кружке и название станции (nameHtml — уже экранированное). У настоящей станции это одна
 * кнопка «показать на карте»: камера к станции и пульсирующее кольцо; настройку остановки она не раскрывает.
 */
export function stopPlaceHtml(i: number, stationId: number | null, nameHtml: string): string {
  const body = `<span class="num">${i + 1}</span><span class="st-name">${nameHtml}</span>`;
  if (stationId === null) return `<span class="stop-place">${body}</span>`;
  return `<button class="stop-place" data-action="show-station" data-id="${stationId}" title="Показать на карте">${body}</button>`;
}

/** Стрелка на плашке условий: вниз — настройку можно развернуть, вверх — свернуть. */
export function stopFoldHtml(open: boolean): string {
  return `<span class="fold ${open ? 'up' : 'down'}">${chevronSvg(9)}</span>`;
}
