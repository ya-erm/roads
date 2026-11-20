import { clamp } from '../core/math';
import type { CargoType } from '../world/cargo';
import type { Station } from '../world/entities';

export type HaulDirection = 'in' | 'out';
type CargoAmounts = Partial<Record<CargoType, number>>;

interface Load {
  cargo: CargoType;
  direction: HaulDirection;
  amount: number;
}

interface Trip extends Load {
  at: number;
  travel: number;
}

interface Yard {
  trip?: Trip;
  waiting: Load[];
}

export interface IndustryHaulView {
  cargo: CargoType;
  direction: HaulDirection;
  phase: 'loading' | 'carrying' | 'unloading' | 'returning';
  /** Положение от источника груза до получателя, от 0 до 1. */
  progress: number;
  fill: number;
  incoming: CargoAmounts;
  outgoing: CargoAmounts;
}

const DWELL = 1.7;
const CAPACITY = 32;

/** Хронология фактических поставок для рисунка двора. Запасы и расчёты перевозок хранятся в игре. */
export class IndustryHaul {
  private readonly yards = new WeakMap<Station, Yard>();

  record(st: Station, cargo: CargoType, direction: HaulDirection, amount: number, time: number): void {
    if (st.kind !== 'road' || st.industryId === null || amount <= 0) return;
    let yard = this.yards.get(st);
    if (!yard) {
      yard = { waiting: [] };
      this.yards.set(st, yard);
    }
    this.advance(st, yard, time);
    const trip = yard.trip;
    if (trip && trip.cargo === cargo && trip.direction === direction && time - trip.at < DWELL / 2) {
      const extra = Math.min(amount, CAPACITY - trip.amount);
      trip.amount += extra;
      amount -= extra;
    }
    if (amount <= 0) return;
    const load = yard.waiting.find((p) => p.cargo === cargo && p.direction === direction);
    if (load) load.amount = direction === 'out' ? Math.min(CAPACITY, load.amount + amount) : load.amount + amount;
    else yard.waiting.push({ cargo, direction, amount: direction === 'out' ? Math.min(CAPACITY, amount) : amount });
    this.advance(st, yard, time);
  }

  view(st: Station, time: number): IndustryHaulView | undefined {
    const yard = this.yards.get(st);
    if (!yard) return;
    this.advance(st, yard, time);
    const trip = yard.trip;
    if (!trip) return;
    const elapsed = Math.max(0, time - trip.at);
    const loading = clamp(elapsed / DWELL, 0, 1);
    const unloading = clamp((elapsed - DWELL - trip.travel) / DWELL, 0, 1);
    const carrying = clamp((elapsed - DWELL) / trip.travel, 0, 1);
    const returning = clamp((elapsed - 2 * DWELL - trip.travel) / trip.travel, 0, 1);
    const incoming: CargoAmounts = {};
    const outgoing: CargoAmounts = {};
    for (const load of yard.waiting) if (load.direction === 'in') incoming[load.cargo] = (incoming[load.cargo] ?? 0) + load.amount;
    const stock = trip.direction === 'in' ? incoming : outgoing;
    const waiting = 1 - (trip.direction === 'in' ? loading : unloading);
    stock[trip.cargo] = (stock[trip.cargo] ?? 0) + trip.amount * waiting;
    const phase = loading < 1 ? 'loading' : carrying < 1 ? 'carrying' : unloading < 1 ? 'unloading' : 'returning';
    return {
      cargo: trip.cargo,
      direction: trip.direction,
      phase,
      progress: carrying - returning,
      fill: loading * (1 - unloading) * Math.max(0.4, Math.sqrt(trip.amount / CAPACITY)),
      incoming,
      outgoing,
    };
  }

  private advance(st: Station, yard: Yard, time: number): void {
    const end = (trip: Trip) => trip.at + 2 * (trip.travel + DWELL);
    let start = yard.trip ? end(yard.trip) : time;
    if (yard.trip && time < start) return;
    yard.trip = undefined;
    while (yard.waiting.length) {
      const load = yard.waiting.shift()!;
      const amount = Math.min(load.amount, CAPACITY);
      if (amount < load.amount) yard.waiting.push({ ...load, amount: load.amount - amount });
      const trip = { ...load, amount, at: start, travel: st.industryAccess ? 8 : 2.4 };
      start = end(trip);
      if (start > time) {
        yard.trip = trip;
        return;
      }
    }
  }
}
