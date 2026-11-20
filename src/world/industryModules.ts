import type { Industry } from './entities';
import { hasFields, hasPastures, isOpenPit } from './industrySites';

/** То, что игрок может построить на территории конкретного предприятия. */
export const INDUSTRY_MODULES = {
  field: { name: 'Дополнительное поле', cost: 22_000, w: 106, h: 70, rate: 0.25, storage: 0 },
  paddock: { name: 'Пастбище', cost: 24_000, w: 84, h: 62, rate: 0.20, storage: 0 },
  pit: { name: 'Дополнительный забой', cost: 42_000, w: 82, h: 64, rate: 0.30, storage: 0 },
  well: { name: 'Дополнительная скважина', cost: 38_000, w: 46, h: 34, rate: 0.25, storage: 0 },
  workshop: { name: 'Производственный цех', cost: 36_000, w: 58, h: 40, rate: 0.20, storage: 0 },
  warehouse: { name: 'Склад продукции', cost: 18_000, w: 38, h: 29, rate: 0, storage: 200 },
} as const;

export type IndustryModule = keyof typeof INDUSTRY_MODULES;

export function mainIndustryModule(ind: Industry): IndustryModule {
  const { kind } = ind.info;
  if (hasFields(kind)) return 'field';
  if (hasPastures(kind)) return 'paddock';
  if (kind === 'oilwell' || kind === 'gasfield') return 'well';
  if (isOpenPit(kind) || kind === 'coalmine' || kind === 'goldmine' || kind === 'gemmine') return 'pit';
  return 'workshop';
}

export function industryModules(ind: Industry): readonly IndustryModule[] {
  return [mainIndustryModule(ind), 'warehouse'];
}

export function moduleEffect(kind: IndustryModule): string {
  const module = INDUSTRY_MODULES[kind];
  return module.storage ? `+${module.storage} ед. запаса продукции` : `+${Math.round(module.rate * 100)}% к выпуску, +1 к пределу роста`;
}

export function industryModuleRate(ind: Industry): number {
  return 1 + (ind.annexes ?? []).reduce((rate, annex) => rate + (!annex.automatic && annex.module ? INDUSTRY_MODULES[annex.module].rate : 0), 0);
}

export function industryOutputCapacity(ind: Industry): number {
  return 300 + (ind.annexes ?? []).reduce((cap, annex) => cap + (!annex.automatic && annex.module ? INDUSTRY_MODULES[annex.module].storage : 0), 0);
}
