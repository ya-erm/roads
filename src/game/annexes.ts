/**
 * Пристройки предприятий. Без них предприятие растёт само (продукцию исправно вывозят — уровень +growthStep за 2 мин)
 * до ANNEX.base; дальше растёт, только если есть куда: каждая пристройка поднимает предел роста на 1 (до
 * ECONOMY.maxLevel или предела события сценария). «Готово к расширению» — упёрлось в предел, а продукцию вывозят.
 * Геометрия — общая со складами станций (outbuildings); проверки площадки и постройка — в Game.
 */
import { ANNEX, ECONOMY } from '../config';
import type { Vec } from '../core/vec';
import type { Industry } from '../world/entities';
import type { Footprint } from '../world/spatial';
import { inOutbuildingZone, outbuildingFootprint, outbuildingZone } from './outbuildings';

/** Предел, до которого предприятие растёт само: ANNEX.base и по 1 за пристройку, не выше его предела. */
export function growthCap(ind: Industry): number {
  return Math.min(ind.cap ?? ECONOMY.maxLevel, ANNEX.base + (ind.annexes?.length ?? 0));
}

/** Готово к расширению: упёрлось в предел роста, продукцию вывозят (growthMonths и больше подряд), а расти ещё есть куда. */
export function annexReady(ind: Industry): boolean {
  const grow = growthCap(ind);
  return grow < (ind.cap ?? ECONOMY.maxLevel) && (ind.level ?? 1) >= grow - 1e-9 && (ind.streak ?? 0) >= ECONOMY.growthMonths;
}

/** Докуда от центра предприятия можно ставить пристройки. */
export function annexZone(ind: Industry): number {
  return outbuildingZone(ind.fp, ANNEX.zone);
}

/** Пристройка с центром в p — участок в долю ANNEX.scale от предприятия, по его оси. */
export function annexFootprint(ind: Industry, p: Vec): Footprint {
  return outbuildingFootprint(ind.fp, p, ind.fp.w * ANNEX.scale, ind.fp.h * ANNEX.scale);
}

/** Пристройка целиком в зоне предприятия. */
export function inAnnexZone(ind: Industry, fp: Footprint): boolean {
  return inOutbuildingZone(ind.fp, ANNEX.zone, fp);
}
