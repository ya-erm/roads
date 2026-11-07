/**
 * Снабжение города по месяцам и перенос излишков. Месяц короткий (минута), и машина с грузом не обязательно
 * доезжает до города в каждом месяце: привезённое сверх нормы засчитывается следующему месяцу — но не больше
 * одной нормы, чтобы большая поставка закрывала ближайший месяц, а не копилась впрок.
 */
import type { CargoType } from './cargo';
import { type Town, TOWN_NEED } from './entities';

/** До какого населения городу хватает базовой нормы TOWN_NEED. */
export const NEED_FLAT_POPULATION = 2000;
/** Сколько жителей сверх NEED_FLAT_POPULATION добавляют к норме ещё одну базовую: 6000 жит. — ×2, 10 000 — ×3. */
export const NEED_STEP_POPULATION = 4000;

/**
 * Норма месяца по каждой потребности города: растёт с населением — крупный город потребляет больше, и одна
 * машина в месяц его уже не закрывает. До 2000 жителей — TOWN_NEED (15), дальше — линейно, круглыми пятёрками.
 */
export function townNeed(population: number): number {
  const k = 1 + Math.max(0, population - NEED_FLAT_POPULATION) / NEED_STEP_POPULATION;
  return Math.max(TOWN_NEED, Math.round((TOWN_NEED * k) / 5) * 5);
}

/** Норма прошлого месяца — та, с которой его закрыли (история снабжения); без истории — по нынешнему населению. */
export function lastTownNeed(town: Pick<Town, 'population' | 'supplyHistory'>): number {
  return town.supplyHistory?.at(-1)?.need ?? townNeed(town.population);
}

/** Норма города за прошлый (last) или текущий месяц. */
export function monthTownNeed(town: Pick<Town, 'population' | 'supplyHistory'>, month: 'last' | 'current'): number {
  return month === 'last' ? lastTownNeed(town) : townNeed(town.population);
}

/** Сколько из привезённого за месяц (got — вместе с перенесённым) перейдёт в следующий: излишек, не больше нормы. */
export function supplyCarry(got: number, need: number): number {
  return Math.max(0, Math.min(need, got - need));
}

export interface SupplyClose {
  /** Итог месяца по каждому нужному грузу: привезли вместе с перенесённым из прошлого (0 — не привезли). */
  got: Partial<Record<CargoType, number>>;
  /** Излишки, с которых начнётся следующий месяц; грузов без излишка здесь нет. */
  carry: Partial<Record<CargoType, number>>;
}

/** Закрывает месяц снабжения: итог по нужным городу грузам и излишки на следующий месяц. */
export function closeSupply(demands: readonly CargoType[], supplied: Partial<Record<CargoType, number>>, need: number): SupplyClose {
  const got: SupplyClose['got'] = {};
  const carry: SupplyClose['carry'] = {};
  for (const c of demands) {
    got[c] = supplied[c] ?? 0;
    const left = supplyCarry(got[c]!, need);
    if (left > 0) carry[c] = left;
  }
  return { got, carry };
}
