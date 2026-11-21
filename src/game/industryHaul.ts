import { clamp } from '../core/math';
import type { Vec } from '../core/vec';
import { boxesOverlap, type Box } from '../lanes/curb';
import type { CargoType } from '../world/cargo';
import type { Station } from '../world/entities';
import { roadMetric, roadPose, type Circuit, type WorkVehiclePose } from '../world/industryRoad';

export type HaulDirection = 'in' | 'out';
type CargoAmounts = Partial<Record<CargoType, number>>;
type Road = readonly Vec[];

export interface IndustryHaulPath {
  road: Road;
  parking?: {
    arrive: Circuit;
    reverse: Circuit;
    depart: Circuit;
    arrivalApron: number;
    departureApron: number;
  };
}

interface Load {
  cargo: CargoType;
  direction: HaulDirection;
  amount: number;
  paths: readonly IndustryHaulPath[];
}

interface Trip extends Load {
  id: number;
  at: number;
  travel: number;
  path?: readonly Vec[];
  route?: Circuit;
  parking?: IndustryHaulPath['parking'];
  timeline?: number[];
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
  pose?: WorkVehiclePose;
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
const STEP = 0.05;
const LANE_OFFSET = 2.25;
const tripDuration = (trip: Trip): number => 2 * (trip.travel + DWELL);
const tripEnd = (trip: Trip): number => trip.at + (trip.timeline ? (trip.timeline.length - 1) * STEP : tripDuration(trip));

/** Время движения, без пауз перед пересекающим проезд транспортом. */
function tripClock(trip: Trip, time: number): number {
  const elapsed = Math.max(0, time - trip.at);
  const timeline = trip.timeline;
  if (!timeline) return elapsed;
  const step = elapsed / STEP;
  const i = Math.floor(step);
  if (i >= timeline.length - 1) return timeline[timeline.length - 1];
  return timeline[i] + (timeline[i + 1] - timeline[i]) * (step - i);
}

function lanePose(route: Circuit, progress: number, forward: boolean, offset = LANE_OFFSET, turn = 0): WorkVehiclePose {
  const [x, y, heading] = roadPose(route, progress, forward);
  const yaw = heading + turn;
  return [x - Math.sin(yaw) * offset, y + Math.cos(yaw) * offset, yaw, forward];
}

/** У корпуса машина стоит внутри разметки. На проезд она сдаёт назад, затем едет кабиной вперёд. */
function parkingPose(parking: NonNullable<IndustryHaulPath['parking']>, leaving: boolean, progress: number, turn: number): WorkVehiclePose {
  const ramp = 7;
  if (!leaving) {
    const metric = roadMetric(parking.arrive);
    const offset = clamp((metric.length * (1 - progress) - parking.arrivalApron) / ramp, 0, 1);
    return lanePose(parking.arrive, progress, true, offset * LANE_OFFSET);
  }
  const reverse = roadMetric(parking.reverse).length;
  const depart = roadMetric(parking.depart).length;
  // Задний ход медленнее. В точке смены направления кабина уже смотрит к воротам.
  const back = reverse * 1.6;
  const distance = progress * (back + depart);
  if (distance < back) return lanePose(parking.reverse, distance / back, false, 0);
  const forward = distance - back;
  const offset = clamp((forward - parking.departureApron) / ramp, 0, 1);
  return lanePose(parking.depart, forward / depart, true, offset * LANE_OFFSET, turn);
}

function tripProgress(trip: Trip, elapsed: number) {
  const loading = clamp(elapsed / DWELL, 0, 1);
  const unloading = clamp((elapsed - DWELL - trip.travel) / DWELL, 0, 1);
  const carrying = clamp((elapsed - DWELL) / trip.travel, 0, 1);
  const returning = clamp((elapsed - 2 * DWELL - trip.travel) / trip.travel, 0, 1);
  const phase = loading < 1 ? 'loading' : carrying < 1 ? 'carrying' : unloading < 1 ? 'unloading' : 'returning';
  const turn = clamp((unloading - 0.62) / 0.38, 0, 1);
  const progress = carrying - returning;
  let pose: WorkVehiclePose | undefined;
  if (trip.route) {
    const outbound = trip.direction === 'out';
    const returningTrip = phase === 'returning';
    const unloadingTurn = phase === 'unloading' ? Math.PI * turn : 0;
    pose = trip.parking
      ? parkingPose(trip.parking, outbound !== returningTrip, returningTrip ? returning : carrying, unloadingTurn)
      : lanePose(trip.route, outbound ? progress : 1 - progress, outbound !== returningTrip, LANE_OFFSET, unloadingTurn);
  }
  return { phase, progress, loading, unloading, pose } as const;
}

/** Габарит крупнейшей машины с небольшим запасом по бокам. */
export function industryHaulBox([x, y, angle]: WorkVehiclePose): Box {
  return { c: { x, y }, d: { x: Math.cos(angle), y: Math.sin(angle) }, hl: 3.9, hw: 2.0 };
}

function conflicting(at: Box, others: Box[]): boolean {
  return others.some((o) => Math.abs(o.c.x - at.c.x) < 9 && Math.abs(o.c.y - at.c.y) < 9 && boxesOverlap(at, o));
}

/** Уже выехавшие имеют приоритет. Новый рейс ждёт перед пересечением или позже трогается с площадки. */
function planTrip(trip: Trip, active: Trip[]): number[] | undefined | null {
  const others = active.filter((o) => o.route && tripEnd(o) > trip.at);
  if (!trip.route || !others.length) return undefined;
  const guardedBox = (pose: WorkVehiclePose): Box => {
    const box = industryHaulBox(pose);
    return { ...box, hl: box.hl + 0.3, hw: box.hw + 0.15 };
  };
  const poseAt = (elapsed: number) => guardedBox(tripProgress(trip, elapsed).pose!);
  let previous = poseAt(0);
  const duration = tripDuration(trip);
  const clearAt = Math.max(...others.map(tripEnd));
  const timeline = [0];
  let elapsed = 0;
  for (let i = 0; trip.at + i * STEP <= clearAt; i++) {
    const time = trip.at + i * STEP;
    const traffic = others.filter((o) => time < tripEnd(o)).map((o) => guardedBox(tripProgress(o, tripClock(o, time)).pose!));
    if (!i) {
      if (conflicting(previous, traffic)) return null;
      continue;
    }
    const next = Math.min(duration, elapsed + STEP);
    const box = poseAt(next);
    if (!conflicting(box, traffic)) {
      previous = box;
      elapsed = next;
    } else if (conflicting(previous, traffic)) return null;
    timeline.push(elapsed);
    if (elapsed >= duration) return timeline;
  }
  while (elapsed < duration) {
    elapsed = Math.min(duration, elapsed + STEP);
    timeline.push(elapsed);
  }
  return timeline;
}

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
    const trip = yard.trips.find((p) => p.cargo === cargo && p.direction === direction && tripClock(p, time) < DWELL / 2);
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
      const { phase, progress, loading, unloading, pose } = tripProgress(trip, tripClock(trip, time));
      const stock = trip.direction === 'in' ? incoming : outgoing;
      const waiting = 1 - (trip.direction === 'in' ? loading : unloading);
      stock[trip.cargo] = (stock[trip.cargo] ?? 0) + trip.amount * waiting;
      return {
        id: trip.id,
        path: trip.path,
        cargo: trip.cargo,
        direction: trip.direction,
        phase,
        progress,
        fill: loading * (1 - unloading) * Math.sqrt(trip.amount / CAPACITY),
        pose,
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
      const load = yard.waiting[0];
      const amount = Math.min(load.amount, CAPACITY);
      const id = yard.nextId;
      let trip: Trip | undefined;
      for (let i = 0; i < Math.max(1, load.paths.length); i++) {
        const destination = load.paths[(id + i) % load.paths.length];
        const path = destination?.road;
        const parking = destination?.parking;
        const route = path && path.length > 1 ? path.map(({ x, y }) => [x, y] as const) : undefined;
        const length = parking ? Math.max(roadMetric(parking.arrive).length, roadMetric(parking.reverse).length * 1.6 + roadMetric(parking.depart).length)
          : route ? roadMetric(route).length : 0;
        const travel = route ? Math.max(2.4, length / 12) : st.industryAccess ? 8 : 2.4;
        const candidate: Trip = { ...load, id, amount, at, path, route, parking, travel };
        const timeline = planTrip(candidate, yard.trips);
        if (timeline === null) continue;
        trip = { ...candidate, timeline };
        break;
      }
      if (!trip) {
        yard.nextAt = at + 0.5;
        continue;
      }
      yard.waiting.shift();
      if (amount < load.amount) yard.waiting.push({ ...load, amount: load.amount - amount });
      yard.nextId++;
      yard.trips.push(trip);
      yard.nextAt = at + HEADWAY;
    }
    yard.trips = yard.trips.filter((trip) => tripEnd(trip) > time);
    if (!yard.waiting.length) yard.nextAt = Math.max(yard.nextAt, time);
  }
}
