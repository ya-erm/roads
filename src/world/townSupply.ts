/**
 * Снабжение города по месяцам и перенос излишков. Месяц короткий (минута), и машина с грузом не обязательно
 * доезжает до города в каждом месяце: привезённое сверх нормы засчитывается следующему месяцу — но не больше
 * одной нормы, чтобы большая поставка закрывала ближайший месяц, а не копилась впрок.
 */
import type { CargoType } from './cargo';

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
