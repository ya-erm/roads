import type { CargoType } from '../world/cargo';
import type { Effect, EffectKind } from './types';

/**
 * Множители экономики, которые игра применяет поверх своей модели: производство предприятия, рост города,
 * поток пассажиров со станций города и цена перевозки груза. В песочнице все равны 1.
 */
export interface EconomyMods {
  industry(id: number): number;
  growth(townId: number): number;
  pax(townId: number): number;
  price(cargo: CargoType): number;
}

export const NO_MODS: EconomyMods = { industry: () => 1, growth: () => 1, pax: () => 1, price: () => 1 };

/** Сколько бы ни сложилось эффектов, множитель остаётся в этих пределах: баланс не ломается. */
const MIN = 0.4;
const MAX = 2.2;

/** Множители по активным эффектам (список берётся каждый раз заново — эффекты истекают и снимаются). */
export function modsOf(effects: () => readonly Effect[]): EconomyMods {
  const factor = (kind: EffectKind, target: number | CargoType) => {
    let k = 1;
    for (const e of effects()) if (e.kind === kind && e.target === target) k *= e.factor;
    return Math.max(MIN, Math.min(MAX, k));
  };
  return {
    industry: (id) => factor('industry', id),
    growth: (id) => factor('growth', id),
    pax: (id) => factor('pax', id),
    price: (c) => factor('price', c),
  };
}

/** Как эффект звучит для игрока: «Производство ×1.2 на 6 мес.». */
export function effectText(kind: EffectKind, factor: number, months: number, subject: string): string {
  const pct = Math.round((factor - 1) * 100);
  const sign = pct > 0 ? `+${pct}%` : `${pct}%`;
  const what = { industry: 'производство', growth: 'рост города', pax: 'пассажиропоток', price: 'тариф на перевозку' }[kind];
  return `${subject}: ${what} ${sign} на ${months} мес.`;
}
