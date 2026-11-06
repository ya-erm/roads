/**
 * Пристройки в карточке предприятия: до какого уровня оно растёт само, готово ли расти дальше и кнопка
 * «Пристройка» (значок, цена) — она включает размещение на карте в зоне вокруг предприятия.
 */
import { ANNEX, ECONOMY, MONTH_LENGTH } from '../config';
import { durationText } from '../core/timeText';
import { annexReady, growthCap } from '../game/annexes';
import type { Industry } from '../world/entities';

const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;

/** Значок пристройки: здание с плюсом. */
export function annexSvg(size = 20): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <path d="M2 11l7-5 7 5v10H2z" fill="#d9c19a" stroke="#7d5a39" stroke-width="1.3" stroke-linejoin="round"/>
    <rect x="6.5" y="14" width="5" height="7" fill="#7d5a39"/>
    <circle cx="18" cy="7" r="5.2" fill="#2e9d57"/>
    <path d="M18 4.4v5.2M15.4 7h5.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
}

/** Блок карточки предприятия; placing — пристройку этого предприятия уже ставят на карте. */
export function annexHtml(ind: Industry, placing: boolean): string {
  const level = ind.level ?? 1;
  const cap = ind.cap ?? ECONOMY.maxLevel;
  const grow = growthCap(ind);
  const built = ind.annexes?.length ?? 0;
  const count = built ? `<span class="annex-count" data-tip="Пристроек: ${built}">${annexSvg(16)}×${built}</span>` : '';
  if (annexReady(ind)) {
    const next = Math.min(cap, level + ECONOMY.growthStep);
    return `<div class="annex-row ready">${annexSvg(24)}<div><b>Готово расти дальше</b><small>Места больше нет: пристройка рядом — сразу ×${next}, дальше рост до ×${Math.min(cap, grow + 1)}.</small></div>
      <button class="small ${placing ? 'active' : 'primary'}" data-action="ind-annex" data-id="${ind.id}" data-tip="${placing ? 'Кликните на карте рядом с предприятием · Esc — отмена' : 'Поставить пристройку рядом с предприятием'}" data-tip-end>${annexSvg(16)} Пристройка · ${money(ANNEX.cost)}</button>${count}</div>`;
  }
  const note =
    grow >= cap
      ? `Предел — ×${cap}.`
      : level < grow
        ? `Растёт само до ×${grow}, если продукцию исправно вывозят; дальше — пристройка.`
        : `Упёрлось в предел: вывозите продукцию ${durationText(ECONOMY.growthMonths * MONTH_LENGTH)} без задержек — можно будет поставить пристройку.`;
  return `<div class="annex-row">${annexSvg(20)}<small>${note}</small>${count}</div>`;
}
