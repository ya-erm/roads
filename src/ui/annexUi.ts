import { money } from '../core/moneyText';
import { growthCap } from '../game/annexes';
import type { Industry } from '../world/entities';
import { INDUSTRY_MODULES, industryModules, industryOutputCapacity, moduleEffect, type IndustryModule } from '../world/industryModules';

/** Значок пристройки: здание с плюсом. */
function annexSvg(size = 20): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">
    <path d="M2 11l7-5 7 5v10H2z" fill="#d9c19a" stroke="#7d5a39" stroke-width="1.3" stroke-linejoin="round"/>
    <rect x="6.5" y="14" width="5" height="7" fill="#7d5a39"/>
    <circle cx="18" cy="7" r="5.2" fill="#2e9d57"/>
    <path d="M18 4.4v5.2M15.4 7h5.2" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`;
}

/** Выбор конкретной секции включает её размещение на карте. */
export function annexHtml(ind: Industry, placing?: IndustryModule): string {
  const options = industryModules(ind).map((kind) => {
    const spec = INDUSTRY_MODULES[kind];
    const count = (ind.annexes ?? []).filter((a) => !a.automatic && a.module === kind).length;
    return `<button class="small annex-choice ${placing === kind ? 'active' : ''}" data-action="ind-annex" data-id="${ind.id}" data-module="${kind}" ${count >= 3 ? 'disabled' : ''}>
      <span>${spec.name}<small>${moduleEffect(kind)}</small></span><b>${count >= 3 ? '3 из 3' : money(spec.cost)}</b></button>`;
  }).join('');
  return `<div class="annex-row">${annexSvg(19)}<b>Расширение комплекса</b></div>
    <div class="kv"><span>Предел роста</span><b>×${growthCap(ind)}</b><span>Запас продукции</span><b>${ind.output} / ${industryOutputCapacity(ind)}</b></div>
    <div class="annex-choices">${options}</div>`;
}
