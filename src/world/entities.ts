import type { Vec } from '../core/vec';
import type { CargoType, IndustryType } from './cargo';
import type { Footprint } from './spatial';

export interface TownBuilding {
  type: 'building';
  id: number;
  townId: number;
  fp: Footprint;
  /** Жилой дом, офис/магазин или центральная ратуша. */
  kind: 'res' | 'com' | 'landmark';
  floors: number;
  /** Узел улицы, откуда выезжают и куда приезжают машины жителей. */
  anchor: number;
  color: string;
  roof: string;
}

export type TownStyle = 'radial' | 'organic' | 'linear';

export interface Town {
  id: number;
  name: string;
  center: Vec;
  radius: number;
  /** Верхний край улиц — над ним рисуется подпись. */
  top: number;
  style: TownStyle;
  population: number;
  buildings: TownBuilding[];
  /** Сегменты улиц, построенные при генерации. */
  streets: number[];
  /** Грузы, которые нужны городу для роста. */
  demands: CargoType[];
  supplied: Partial<Record<CargoType, number>>;
  lastSupplied: Partial<Record<CargoType, number>>;
  tripAcc: number;
  growthAcc: number;
  /** Город сам прокладывает новые улицы, когда вдоль старых тесно. По умолчанию да. */
  autoStreets?: boolean;
}

/** Сколько единиц груза в месяц нужно, чтобы потребность города считалась закрытой. */
export const TOWN_NEED = 10;

export interface Industry {
  type: 'industry';
  id: number;
  info: IndustryType;
  name: string;
  fp: Footprint;
  /** Запасы сырья для переработки по видам. */
  stock: Partial<Record<CargoType, number>>;
  /** Готовая продукция, которую ещё не забрали. */
  output: number;
  producedMonth: number;
  producedLast: number;
  prodAcc: number;
  /**
   * Уровень производства (1…4): растёт, если продукцию исправно вывозят,
   * падает, если предприятие долго никто не обслуживает. Нет — 1.
   */
  level?: number;
  /** Сколько месяцев подряд продукцию вывозили (или не обслуживали — со знаком минус). */
  streak?: number;
}

export interface PassengerGroup {
  from: number;
  to: number;
  count: number;
  /** Когда сели (игровое время) — быстрая поездка оплачивается дороже. */
  at?: number;
}

export interface StationServes {
  pax: boolean;
  cargo: boolean;
}

export interface Station {
  type: 'station';
  id: number;
  /** Автостанция у дороги или вокзал на путях. */
  kind: 'road' | 'rail';
  name: string;
  fp: Footprint;
  /** Узел подъезда; у вокзала его нет (−1). */
  nodeId: number;
  /** Пути-платформы ж/д станции. */
  platforms: number[];
  /** С чем работает станция: пассажиры, груз или и то и другое. */
  serves: StationServes;
  /** Грузовой двор предприятия: обслуживает только его, снести нельзя. */
  industryId: number | null;
  cargo: Partial<Record<CargoType, number>>;
  /**
   * Откуда изначально груз, выгруженный сюда на склад (пересадка).
   * Платят при доставке — за расстояние от этой станции.
   */
  cargoOrigin?: Partial<Record<CargoType, number>>;
  /** Ожидающие пассажиры по станции назначения. */
  passengers: Map<number, number>;
  /** Компанейские машины, стоящие на постах погрузки. */
  occupied: number[];
  bays: number;
  townIds: number[];
  industryIds: number[];
  accepts: Set<CargoType>;
  /** Жители в зоне охвата — для генерации пассажиров. */
  catchPop: number;
  paxAcc: number;
}

export type Structure = TownBuilding | Industry | Station;
