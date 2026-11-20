import { money } from '../core/moneyText';
import { growthCap, moduleEffect, moduleLogisticsEffect } from '../game/annexes';
import type { Industry } from '../world/entities';
import { CARGO } from '../world/cargo';
import { INDUSTRY_MODULES, industryLoadingRate, industryModules, industryOutputCapacity, industryUnloadingRate, moduleCargo, moduleLimit, moduleName, type IndustryModule } from '../world/industryModules';

/** Значок пристройки: здание с плюсом. */
function annexSvg(size = 20): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <path d="M2 11l7-5 7 5v10H2z" fill="#d9c19a" stroke="#7d5a39" stroke-width="1.3" stroke-linejoin="round"/>
    <rect x="6.5" y="14" width="5" height="7" fill="#7d5a39"/>
    <circle cx="18" cy="7" r="5.2" fill="#2e9d57"/>
    <path d="M18 4.4v5.2M15.4 7h5.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
}

function sectionIcon(ind: Industry, kind: IndustryModule | 'road' | undefined): string {
  if (!kind) return annexSvg(24);
  const cargo = kind !== 'road' ? moduleCargo(ind, kind) : undefined;
  const drawings = {
    field: '<rect x="3" y="4" width="18" height="16" rx="2" fill="#e9c96f"/><path d="M7 7v10m5-10v10m5-10v10" stroke="#947037"/>',
    paddock: '<rect x="2" y="9" width="20" height="12" rx="2" fill="#9db77a" stroke="none"/><path d="M3 8v11m9-11v11m9-11v11M3 11h18M3 16h18" stroke="#70553e"/>',
    pit: '<path d="M2 7h20l-3 6-4 5H9l-4-5Z" fill="#c49d80"/><path d="M5 10h14m-12 4h10" stroke="#8d695a"/>',
    well: '<path d="M3 20h18M6 20l5-14 5 14M4 10l16-5 1 4-3 1" fill="#c58d62"/><path d="M18 10v8"/>',
    workshop: '<path d="M3 20V9l5 3V7l5 4V7l4 4h4v9Z" fill="#c88370"/><path d="M7 16h2m2 0h2m2 0h2" stroke="#fff1e4"/>',
    warehouse: '<path d="M3 10l9-6 9 6v10H3Z" fill="#91a9b4"/><path d="M7 20v-7h10v7M7 16h10"/>',
    service: '<path d="M17 3a5 5 0 0 0-6 6L4 16a2.8 2.8 0 0 0 4 4l7-7a5 5 0 0 0 6-6l-4 4-3-3Z" fill="#bac8cb"/>',
    receiving: `<path d="M3 13h8v7H3zm10 0h8v7h-8zM8 4h8v7H8z" fill="${cargo ? CARGO[cargo].color : '#c4a066'}"/><path d="M6 16h2m8 0h2m-7-9h2" stroke="#fff1e4"/>`,
    road: '<path d="M3 16h9q4 0 4-4V4" stroke-width="8" stroke="#82858b"/><path d="M3 16h9q4 0 4-4V4" stroke="#fff5d9" stroke-dasharray="2 3"/>',
  };
  return `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#4d5355" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">${drawings[kind === 'receivingSecond' ? 'receiving' : kind]}</svg>`;
}

function sectionLabel(ind: Industry, kind: IndustryModule | 'road' | undefined, name: string, detail = ''): string {
  return `<span class="annex-choice-label">${sectionIcon(ind, kind)}<span>${name}${detail ? `<small>${detail}</small>` : ''}</span></span>`;
}

/** Выбор конкретной секции включает её размещение на карте. */
export function annexHtml(ind: Industry, placing?: IndustryModule, roadTool = false): string {
  const options = industryModules(ind).map((kind) => {
    const spec = INDUSTRY_MODULES[kind];
    const count = (ind.annexes ?? []).filter((a) => !a.automatic && a.module === kind).length;
    const limit = moduleLimit(kind);
    return `<button class="small annex-choice ${placing === kind ? 'active' : ''}" data-action="ind-annex" data-id="${ind.id}" data-module="${kind}" ${count >= limit ? 'disabled' : ''}>
      ${sectionLabel(ind, kind, moduleName(ind, kind), moduleEffect(ind, kind))}<b>${count >= limit ? `${limit} из ${limit}` : money(spec.cost)}</b></button>`;
  }).join('');
  const built = (ind.annexes ?? []).filter((section) => !section.roadOnly).map((section) =>
    `<button class="small annex-choice" data-action="ind-show-section" data-id="${section.id}">${sectionLabel(ind, section.module, section.module ? moduleName(ind, section.module) : 'Вспомогательная секция', section.module && !section.automatic ? moduleLogisticsEffect(section.module) : '')}<small>На карте</small></button>`,
  ).join('');
  const loading = industryLoadingRate(ind);
  const speed = (rate: number) => `+${Math.round((rate - 1) * 100)}%`;
  const unloading = ind.info.accepts.map((cargo) => {
    const rate = industryUnloadingRate(ind, cargo);
    return rate > 1 ? `<span>Скорость разгрузки · ${CARGO[cargo].name}</span><b>${speed(rate)}</b>` : '';
  }).join('');
  return `<div class="annex-row">${annexSvg(19)}<b>План предприятия</b></div>
    ${built ? `<div class="annex-row"><b>Дополнительные постройки</b></div><div class="annex-choices">${built}</div>` : ''}
    <div class="kv"><span>Предел роста</span><b>×${growthCap(ind)}</b><span>Запас продукции</span><b>${ind.output} / ${industryOutputCapacity(ind)}</b>
      ${loading > 1 ? `<span>Скорость погрузки продукции</span><b>${speed(loading)}</b>` : ''}${unloading}</div>
    <div class="annex-choices">
      <button class="small annex-choice ${roadTool ? 'active' : ''}" data-action="ind-road" data-id="${ind.id}">${sectionLabel(ind, 'road', 'Технологический проезд', 'От существующей дорожной сети')}</button>
      ${options}
      ${placing ? '<button class="small" data-action="ind-rotate-section">Повернуть на 90°</button>' : ''}
    </div>`;
}
