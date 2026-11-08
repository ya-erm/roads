import { Rng } from '../core/rng';
import type { VehicleSpec } from '../sim/vehicle';
import type { Town, TownBuilding } from '../world/entities';

/**
 * Спецтранспорт городов: скорая, полиция, пожарная. Время от времени выезжают из одного дома города в другой (как
 * машины жителей), часть — с мигалкой: тогда им уступают и пропускают на перекрёстках (lanes/traffic.ts, Vehicle.siren).
 * Вызовы ДТП и пожаров — пока нет: спецмашина едет по городу «по делам».
 */
export type ServiceKind = 'ambulance' | 'police' | 'fire';

export interface ServiceInfo {
  name: string;
  /** Значок в карточке машины. */
  icon: string;
  /** Доля среди выездов. */
  weight: number;
  /** Цвет службы (полоса на кузове): им на карте подсвечен маршрут выбранной спецмашины. */
  color: string;
  spec: VehicleSpec;
}

/** Кузова — по виду (vehicleArt): белая скорая с красной полосой, белая полиция с синей, красная пожарная с лестницей. */
export const SERVICES: Record<ServiceKind, ServiceInfo> = {
  ambulance: {
    name: 'Скорая помощь',
    icon: '🚑',
    weight: 0.45,
    color: '#e5484d',
    spec: { kind: 'car', body: 'ambulance', length: 8, width: 4.2, maxSpeed: 58, accel: 9, color: '#f4f5f2' },
  },
  police: {
    name: 'Полиция',
    icon: '🚓',
    weight: 0.4,
    color: '#2346b8',
    spec: { kind: 'car', body: 'police', length: 7, width: 4, maxSpeed: 62, accel: 11, color: '#f2f4f7' },
  },
  fire: {
    name: 'Пожарная охрана',
    icon: '🚒',
    weight: 0.15,
    color: '#b3261e',
    spec: { kind: 'truck', body: 'fire', length: 11, width: 4.6, maxSpeed: 48, accel: 6, color: '#c8312b' },
  },
};

export const SERVICE_KINDS = Object.keys(SERVICES) as ServiceKind[];

export const SERVICE_TRAFFIC = {
  /** Выездов в секунду на 1000 жителей (город на 5000 — примерно раз в полминуты). */
  callsPerThousand: 0.006,
  /** Доля выездов с мигалкой. */
  sirenShare: 0.6,
  /** Спецмашин в потоке одновременно — не больше, на всю карту. */
  maxCars: 16,
};

/** Выезд спецмашины: какая, с мигалкой ли, откуда и куда (дома города). */
export interface ServiceCall {
  kind: ServiceKind;
  siren: boolean;
  from: TownBuilding;
  to: TownBuilding;
}

/** Зерно генератора для n-го выезда города: от seed партии, без общего генератора — его ход не меняется. */
export function callSeed(seed: number, townId: number, n: number): number {
  return (Math.imul(seed >>> 0, 0x9e3779b1) ^ Math.imul(townId + 1, 0x85ebca6b) ^ Math.imul(n, 0xc2b2ae35)) >>> 0;
}

/**
 * n-й выезд спецмашины города — по seed партии (callSeed): одна и та же партия даёт те же выезды, и после загрузки
 * сохранения тоже (счётчик выездов — в городе). Ехать неоткуда или некуда (мало домов) — null.
 */
export function serviceCall(seed: number, town: Town, n: number): ServiceCall | null {
  const rng = new Rng(callSeed(seed, town.id, n));
  let r = rng.next();
  let kind: ServiceKind = SERVICE_KINDS[0];
  for (const k of SERVICE_KINDS) {
    r -= SERVICES[k].weight;
    kind = k;
    if (r < 0) break;
  }
  const siren = rng.chance(SERVICE_TRAFFIC.sirenShare);
  const all = town.buildings.filter((b) => b.kind !== 'landmark');
  const homes = all.filter((b) => b.kind === 'res');
  if (all.length < 2) return null;
  const from = rng.pick(all);
  const to = rng.pick(homes.length > 1 ? homes : all);
  if (from.anchor === to.anchor) return null;
  return { kind, siren, from, to };
}

/**
 * Сколько выездов города за dt — накопитель и счётчик выездов в самом городе (сохраняются вместе с ним; в старых
 * сохранениях их нет — с нуля). Номера выездов — по порядку, для serviceCall.
 */
export function serviceTick(town: Town, dt: number): number[] {
  town.serviceAcc = (town.serviceAcc ?? 0) + (town.population / 1000) * SERVICE_TRAFFIC.callsPerThousand * dt;
  const calls: number[] = [];
  while (town.serviceAcc >= 1) {
    town.serviceAcc -= 1;
    town.serviceCalls = (town.serviceCalls ?? 0) + 1;
    calls.push(town.serviceCalls);
  }
  return calls;
}
