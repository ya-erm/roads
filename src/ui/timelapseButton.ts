/**
 * Кнопка «Таймлапс партии» — на экране итогов сценария и в меню: значок, подпись и почему кнопка серая.
 * Сам проигрыватель — timelapse.ts (тяжелее: холст, рельеф, видео), здесь только чтение состояния.
 */

import type { Game } from '../game/game';
import { timelapseOf, timelapseSpan } from '../game/timelapse';

/** Таймлапс: карта, на ней растёт дорога со станциями, в углу — кнопка «играть». */
export function timelapseSvg(size = 22): string {
  return `<svg viewBox="0 0 22 22" width="${size}" height="${size}"><rect x="1.5" y="2.5" width="16" height="14" rx="2.4" fill="#e7f0df" stroke="#5f7a8f" stroke-width="1.4"/>
    <path d="M3.5 13.5C6 13 6.5 8.5 9.5 8.5S12.5 5.5 15.5 5" stroke="#4b525c" stroke-width="1.7" fill="none" stroke-linecap="round"/>
    <circle cx="9.5" cy="8.5" r="1.6" fill="#fff" stroke="#2f80ed" stroke-width="1.1"/><circle cx="15.5" cy="5" r="1.6" fill="#fff" stroke="#2f80ed" stroke-width="1.1"/>
    <circle cx="16" cy="15.5" r="5" fill="#2e9d57"/><path d="M14.6 13.2L18.6 15.5L14.6 17.8Z" fill="#fff"/></svg>`;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10;
  const dd = n % 100;
  return d === 1 && dd !== 11 ? one : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? few : many;
};

/** «3 года 4 мес.», «7 мес.». */
export function spanText(months: number): string {
  const total = Math.max(1, Math.round(months));
  const y = Math.floor(total / 12);
  const m = total % 12;
  const years = y ? `${y} ${plural(y, 'год', 'года', 'лет')}` : '';
  return [years, m ? `${m} мес.` : ''].filter(Boolean).join(' ');
}

export interface TimelapseState {
  ok: boolean;
  /** Подпись под названием. */
  note: string;
  /** Подсказка: что покажет или почему нельзя. */
  tip: string;
}

/** Можно ли смотреть таймлапс и что о нём сказать. */
export function timelapseState(game: Game): TimelapseState {
  const src = timelapseOf(game);
  const span = timelapseSpan(src);
  const fromLoad = src.recordFrom > 0.5 && !src.rough;
  if (src.frames.length < 2) {
    return fromLoad
      ? {
          ok: false,
          note: 'В этом сохранении ещё нет кадров',
          tip: 'Сохранение сделано до таймлапса: кадры сети пишутся раз в месяц с загрузки — сыграйте хотя бы месяц',
        }
      : { ok: false, note: 'Пока нечего показывать', tip: 'Кадр сети пишется в конце каждого месяца — постройте что-нибудь или сыграйте месяц' };
  }
  const len = span >= 1 ? spanText(span) : 'первый месяц';
  return {
    ok: true,
    note: `Как росла сеть · ${len}${src.rough ? ' · начало — по журналу' : fromLoad ? ' · с загрузки' : ''}`,
    tip: src.rough
      ? 'Сохранение старше таймлапса: начало партии восстановлено по журналу — станции и маршруты, без дорог'
      : 'Дороги, станции, маршруты и города — от первой дороги до сегодня. Можно скачать видео',
  };
}

/** Пункт меню «Таймлапс партии»: серый, если смотреть нечего, — с объяснением в подсказке. */
export function timelapseItemHtml(game: Game): string {
  const s = timelapseState(game);
  return `<button class="menu-item ${s.ok ? '' : 'disabled'}" data-action="timelapse" aria-disabled="${!s.ok}" data-tip="${s.tip}">${timelapseSvg(22)}<span class="menu-text"><b>Таймлапс партии</b><small>${s.note}</small></span></button>`;
}

/** Обновляет пункт меню, уже стоящий в разметке. */
export function syncTimelapseItem(el: HTMLElement, game: Game): void {
  const s = timelapseState(game);
  el.classList.toggle('disabled', !s.ok);
  el.setAttribute('aria-disabled', String(!s.ok));
  el.dataset.tip = s.tip;
  const note = el.querySelector('small');
  if (note) note.textContent = s.note;
}
