import { chevronSvg } from './icons';
import { cargoIcon } from './cargoIcons';
import type { Line } from '../game/transport';
import { CARGO, type CargoType } from '../world/cargo';

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

/** Сколько пассажиров и груза ждёт отправки этой линией. */
export function stopWaitingHtml(passengers: number, cargo: readonly [CargoType, number][]): string {
  const badge = (type: CargoType, count: number, text: string) =>
    `<span class="stop-waiting-chip" role="img" aria-label="${text}" data-tip="${text}" data-tip-end>${cargoIcon(type, 14, false)}<b>${count}</b></span>`;
  let html = '';
  const waiting = Math.floor(passengers);
  if (waiting > 0) html += badge('passengers', waiting, `Ожидают отправки · ${waiting} пасс.`);
  const freight = cargo.map(([type, amount]) => ({ type, count: Math.floor(amount) })).filter(({ type, count }) => type !== 'passengers' && count > 0);
  if (freight.length === 1) {
    const { type, count } = freight[0];
    html += badge(type, count, `${CARGO[type].name} · ждёт ${count}`);
  } else if (freight.length > 1) {
    const total = freight.reduce((sum, { count }) => sum + count, 0);
    html += badge('goods', total, `Груза ждёт ${total} · ${freight.map(({ type, count }) => `${CARGO[type].name} ${count}`).join(' · ')}`);
  }
  return html;
}

/** Перенос одной остановки с её правилами. Остальные остаются в прежнем порядке. */
export function reorderStop(line: Pick<Line, 'stops' | 'rules'>, from: number, to: number): Pick<Line, 'stops'> & Required<Pick<Line, 'rules'>> {
  const stops = [...line.stops];
  const rules = stops.map((_, i) => line.rules?.[i] ?? null);
  stops.splice(to, 0, stops.splice(from, 1)[0]);
  rules.splice(to, 0, rules.splice(from, 1)[0]);
  return { stops, rules };
}
