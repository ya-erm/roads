/**
 * Предупреждения в панелях. Карточка станции — все её предупреждения (stationWarnings: «нет мест», советы
 * советника): значок, что случилось, подробно и кнопка быстрого действия. Карточка маршрута — станции, где его
 * машины стоят в очереди «нет мест». Значок очереди — тот же знак «въезд запрещён», что и на карте.
 */
import type { Game } from '../game/game';
import type { StationWarning } from '../game/stationWarnings';
import type { Station } from '../world/entities';
import { adviceIcon, fixLabel } from './advisorUi';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Знак «въезд запрещён»: красный круг с белой чертой. */
export function noEntrySvg(size = 18): string {
  return `<svg class="no-entry" width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="9" fill="#e5534b"/><rect x="4.5" y="8.2" width="11" height="3.6" rx="1" fill="#fff"/></svg>`;
}

/**
 * Блок предупреждений карточки станции: по строке на предупреждение — значок (как на карте), что случилось,
 * подробно и кнопка действия. flash — открыли кликом по значку на карте: блок мигает, чтобы его было видно сразу.
 */
export function stationWarningsHtml(g: Game, station: number, list: StationWarning[], flash = false): string {
  if (!list.length) return '';
  const rows = list
    .map((w) => {
      const icon = w.advice ? adviceIcon(w.advice, 26) : noEntrySvg(24);
      const fix = w.fix ? `<button class="small primary" data-action="warn-fix" data-id="${station}" data-key="${esc(w.key)}">${esc(fixLabel(g, w.fix))}</button>` : '';
      return `<div class="warn-row ${w.level}">${icon}<div><b>${esc(w.title)}</b><small>${esc(w.detail)}</small>${fix ? `<div class="warn-actions">${fix}</div>` : ''}</div></div>`;
    })
    .join('');
  return `<div class="station-warnings ${flash ? 'flash' : ''}" data-station-warnings>${rows}</div>`;
}

/** Предупреждения карточки маршрута: его машины стоят в очереди у станций, где все посты заняты. */
export function lineJamsHtml(jams: { station: Station; waiting: number }[]): string {
  return jams
    .map(({ station, waiting }) => {
      const slots = station.kind === 'rail' ? 'платформы' : 'посты';
      return `<p class="warn jam" data-action="show-station" data-id="${station.id}" data-tip="Показать станцию">${noEntrySvg(16)}<span>${esc(station.name)}: все ${slots} заняты, ждут въезда ${waiting}</span></p>`;
    })
    .join('');
}
