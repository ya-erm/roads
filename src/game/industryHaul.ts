import { clamp } from '../core/math';
import { dist, type Vec } from '../core/vec';
import type { CargoType } from '../world/cargo';
import type { Station } from '../world/entities';

export type HaulDirection = 'in' | 'out';
type CargoAmounts = Partial<Record<CargoType, number>>;

interface Load {
  cargo: CargoType;
  direction: HaulDirection;
  amount: number;
  paths: readonly (readonly Vec[])[];
}

interface Trip extends Load {
  id: number;
  at: number;
  travel: number;
  path?: readonly Vec[];
}

interface Yard {
  footprint: Station['fp'];
  trips: Trip[];
  waiting: Load[];
  nextAt: number;
  nextId: number;
}

export interface IndustryHaulTrip {
  id: number;
  path?: readonly Vec[];
  cargo: CargoType;
  direction: HaulDirection;
  phase: 'loading' | 'carrying' | 'unloading' | 'returning';
  /** Положение от источника груза до получателя, от 0 до 1. */
  progress: number;
  fill: number;
  turn: number;
}

export interface IndustryHaulView {
  trips: IndustryHaulTrip[];
  incoming: CargoAmounts;
  outgoing: CargoAmounts;
}

const DWELL = 1.7;
const CAPACITY = 16;
const TRUCKS = 4;
const HEADWAY = 3;
const tripEnd = (trip: Trip): number => trip.at + 2 * (trip.travel + DWELL);

/** Хронология фактических поставок для рисунка двора. Запасы и расчёты перевозок хранятся в игре. */
export class IndustryHaul {
  private readonly yards = new WeakMap<Station, Yard>();

  record(st: Station, cargo: CargoType, direction: HaulDirection, amount: number, time: number, paths: Load['paths'] = []): void {
    if (st.kind !== 'road' || st.industryId === null || amount <= 0) return;
    let yard = this.yards.get(st);
    if (!yard || yard.footprint !== st.fp) {
      yard = { footprint: st.fp, trips: [], waiting: [], nextAt: time, nextId: 0 };
      this.yards.set(st, yard);
    }
    this.advance(st, yard, time);
    const trip = yard.trips.find((p) => p.cargo === cargo && p.direction === direction && time - p.at < DWELL / 2);
    if (trip) {
      const extra = Math.min(amount, CAPACITY - trip.amount);
      trip.amount += extra;
      amount -= extra;
    }
    if (amount <= 0) return;
    const load = yard.waiting.find((p) => p.cargo === cargo && p.direction === direction);
    if (load) load.amount += amount;
    else yard.waiting.push({ cargo, direction, amount, paths });
    this.advance(st, yard, time);
  }

  view(st: Station, time: number): IndustryHaulView | undefined {
    const yard = this.yards.get(st);
    if (!yard || yard.footprint !== st.fp) return;
    this.advance(st, yard, time);
    if (!yard.trips.length && !yard.waiting.length) return;
    const incoming: CargoAmounts = {};
    const outgoing: CargoAmounts = {};
    for (const load of yard.waiting) {
      const stock = load.direction === 'in' ? incoming : outgoing;
      stock[load.cargo] = (stock[load.cargo] ?? 0) + load.amount;
    }
    const trips = yard.trips.map((trip): IndustryHaulTrip => {
      const elapsed = Math.max(0, time - trip.at);
      const loading = clamp(elapsed / DWELL, 0, 1);
      const unloading = clamp((elapsed - DWELL - trip.travel) / DWELL, 0, 1);
      const carrying = clamp((elapsed - DWELL) / trip.travel, 0, 1);
      const returning = clamp((elapsed - 2 * DWELL - trip.travel) / trip.travel, 0, 1);
      const stock = trip.direction === 'in' ? incoming : outgoing;
      const waiting = 1 - (trip.direction === 'in' ? loading : unloading);
      stock[trip.cargo] = (stock[trip.cargo] ?? 0) + trip.amount * waiting;
      return {
        id: trip.id,
        path: trip.path,
        cargo: trip.cargo,
        direction: trip.direction,
        phase: loading < 1 ? 'loading' : carrying < 1 ? 'carrying' : unloading < 1 ? 'unloading' : 'returning',
        progress: carrying - returning,
        fill: loading * (1 - unloading) * Math.sqrt(trip.amount / CAPACITY),
        turn: clamp((unloading - 0.62) / 0.38, 0, 1),
      };
    });
    return { trips, incoming, outgoing };
  }

  private advance(st: Station, yard: Yard, time: number): void {
    while (yard.waiting.length) {
      const freesAt = yard.trips.length >= TRUCKS ? Math.min(...yard.trips.map(tripEnd)) : yard.nextAt;
      const at = Math.max(freesAt, yard.nextAt);
      if (at > time) break;
      yard.trips = yard.trips.filter((trip) => tripEnd(trip) > at);
      const load = yard.waiting.shift()!;
      const amount = Math.min(load.amount, CAPACITY);
      if (amount < load.amount) yard.waiting.push({ ...load, amount: load.amount - amount });
      const id = yard.nextId++;
      const path = load.paths[id % load.paths.length];
      const length = path?.reduce((total, point, i) => total + (i ? dist(path[i - 1], point) : 0), 0);
      yard.trips.push({ ...load, id, amount, at, path, travel: length === undefined ? (st.industryAccess ? 8 : 2.4) : Math.max(2.4, length / 12) });
      yard.nextAt = at + HEADWAY;
    }
    yard.trips = yard.trips.filter((trip) => tripEnd(trip) > time);
    if (!yard.waiting.length) yard.nextAt = Math.max(yard.nextAt, time);
  }
}
