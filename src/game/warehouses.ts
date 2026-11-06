/**
 * Склады станции — отдельные здания рядом с автостанцией: игрок ставит их мышью в небольшой зоне вокруг неё, каждый
 * добавляет места под груз (STORAGE.per). Геометрия — общая с пристройками предприятий (outbuildings).
 * Проверки площадки, цена и постройка — в Game (warehousePlan, buildWarehouse, removeWarehouse).
 */
import { STORAGE } from '../config';
import type { Vec } from '../core/vec';
import type { Station } from '../world/entities';
import type { Footprint } from '../world/spatial';
import { inOutbuildingZone, outbuildingFootprint, outbuildingZone } from './outbuildings';

/** Докуда от центра станции можно ставить её склады: её «радиус» и ещё STORAGE.zone. */
export function warehouseZone(st: Station): number {
  return outbuildingZone(st.fp, STORAGE.zone);
}

/** Сколько у станции складов: пристройки старых сохранений и здания — вместе не больше STORAGE.max. */
export function storageSlots(st: Station): number {
  return (st.depots ?? 0) + (st.warehouses?.length ?? 0);
}

/** Здание склада с центром в p — по оси станции, «в ряд» с ней. */
export function warehouseFootprint(st: Station, p: Vec): Footprint {
  return outbuildingFootprint(st.fp, p, STORAGE.house.w, STORAGE.house.h);
}

/** Здание целиком в зоне станции. */
export function inWarehouseZone(st: Station, fp: Footprint): boolean {
  return inOutbuildingZone(st.fp, STORAGE.zone, fp);
}
