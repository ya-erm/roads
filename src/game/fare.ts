import { ECONOMY } from '../config';
import { dist, type Vec } from '../core/vec';
import { CARGO } from '../world/cargo';

/**
 * Путь пассажира по линии: сумма перегонов (по прямой от остановки до остановки) от остановки посадки до той,
 * где он выходит (index — её номер в линии). Линия ходит по кругу, поэтому посадка — ближайшая перед index
 * остановка from, если идти назад по линии. Остановки нет на линии (её успели убрать) — null.
 */
export function ridePath(stops: readonly number[], pos: (id: number) => Vec | undefined, from: number, index: number): number | null {
  const n = stops.length;
  let path = 0;
  for (let k = 1; k < n; k++) {
    const a = (index - k + n) % n;
    const b = (a + 1) % n;
    const pa = pos(stops[a]);
    const pb = pos(stops[b]);
    if (!pa || !pb) return null;
    path += dist(pa, pb);
    if (stops[a] === from) return path;
  }
  return null;
}

/**
 * За какое расстояние платит пассажир: по прямой от станции посадки до станции высадки и ещё доля
 * ECONOMY.paxDetour объезда — сколько линия везла его по остановкам сверх прямой. На линии из двух остановок
 * и на прямой линии объезда нет — платят как раньше; на кольце по городу, где до соседней по прямой остановки
 * едут через полгорода, объезд оплачивается частью.
 */
export function paxDistance(straight: number, path: number | null): number {
  if (path === null || path <= straight) return straight;
  return straight + ECONOMY.paxDetour * (path - straight);
}

/**
 * Сколько платят count пассажиров (до множителя цены сценария): билет за посадку ECONOMY.paxBoarding и тариф
 * за расстояние (paxDistance) с надбавкой k за скорость. Билет — заметная часть платы в городе, где ездят
 * на пару остановок, и малая — на междугородней линии.
 */
export function paxFare(count: number, straight: number, path: number | null, k: number): number {
  const distance = (CARGO.passengers.rate * ECONOMY.tariff * paxDistance(straight, path) * k) / 100;
  return count * (ECONOMY.paxBoarding + distance);
}
