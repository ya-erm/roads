/**
 * Склады станции — отдельные здания рядом с автостанцией: игрок ставит их мышью в небольшой зоне вокруг неё, каждый
 * добавляет места под груз (STORAGE.per). Здесь — геометрия: зона, контур здания, сколько складов уже есть.
 * Проверки площадки, цена и постройка — в Game (warehousePlan, buildWarehouse, removeWarehouse).
 */
import { STORAGE } from '../config';
import { dist, type Vec } from '../core/vec';
import type { Station } from '../world/entities';
import { footprintCorners, footprintRadius, type Footprint } from '../world/spatial';

/** Докуда от центра станции можно ставить её склады: её «радиус» и ещё STORAGE.zone. */
export function warehouseZone(st: Station): number {
  return footprintRadius(st.fp) + STORAGE.zone;
}

/** Сколько у станции складов: пристройки старых сохранений и здания — вместе не больше STORAGE.max. */
export function storageSlots(st: Station): number {
  return (st.depots ?? 0) + (st.warehouses?.length ?? 0);
}

/** Здание склада с центром в p — по оси станции, «в ряд» с ней. */
export function warehouseFootprint(st: Station, p: Vec): Footprint {
  return { center: { x: p.x, y: p.y }, w: STORAGE.house.w, h: STORAGE.house.h, angle: st.fp.angle };
}

/** Здание целиком в зоне станции. */
export function inWarehouseZone(st: Station, fp: Footprint): boolean {
  const r = warehouseZone(st);
  return footprintCorners(fp).every((c) => dist(c, st.fp.center) <= r);
}
