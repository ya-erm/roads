import { PEDESTRIAN_LEVELS } from '../config';
import { pedestrianLevel, PREFS, prefOn } from './prefs';

/**
 * Раздел «Настройки» в Меню: по строке на настройку из PREFS (src/ui/prefs.ts) — значок, название, пояснение и
 * переключатель. Клик по строке — `data-action="pref"` с `data-id` настройки (обрабатывает Hud).
 */

/** Значок пункта «Настройки» в меню: шестерёнка. */
export function settingsSvg(size = 22): string {
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    const p = (r: number) => `${(12 + c * r).toFixed(2)} ${(12 + s * r).toFixed(2)}`;
    return `M${p(6.5)}L${p(10)}`;
  }).join('');
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <path d="${teeth}" stroke="#4a5563" stroke-width="3.4" stroke-linecap="round"/>
    <circle cx="12" cy="12" r="6.6" fill="#4a5563"/>
    <circle cx="12" cy="12" r="2.8" fill="#f1f4f7"/>
  </svg>`;
}

/** Строки раздела: каждая настройка — переключатель в нынешнем положении. */
export function settingsHtml(): string {
  return PREFS.map((p) => {
    const on = prefOn(p.id);
    const toggle = `<button class="menu-item pref${on ? ' on' : ''}" data-action="pref" data-id="${p.id}" role="switch" aria-checked="${on}" title="${p.name}: ${on ? 'выключить' : 'включить'}">
      ${p.icon}<span class="menu-text"><b>${p.name}</b><small>${p.hint}</small></span>
      <span class="pref-switch" aria-hidden="true"><span></span></span>
    </button>`;
    if (p.id !== 'pedestrians') return toggle;
    return `<div class="pedestrian-pref">${toggle}
      <div class="pedestrian-levels" role="group" aria-label="Интенсивность пешеходов"><span>Интенсивность</span>${PEDESTRIAN_LEVELS.map(level =>
        `<button data-action="pedestrian-level" data-level="${level}" aria-label="Уровень ${level} из 5" aria-pressed="${level === pedestrianLevel()}"${on ? '' : ' disabled'}>${level}</button>`
      ).join('')}</div>
    </div>`;
  }).join('');
}
