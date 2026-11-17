import type { Vehicle } from '../sim/vehicle';
import type { CarHomes } from './carHomes';
import type { Game } from './game';
import type { GarageHost } from './garages';

/**
 * Замер «машин из ниоткуда» (docs/PARKING.md): сколько машин жителей появляется в потоке у узла (traffic.spawn), а
 * сколько — выезжает с места (гараж, площадка, двор, бокс, стоянка магазина: GarageHost.own), и сколько исчезает у
 * узла (доехала до цели — onArrive, потерялась — onLost), а сколько — сворачивает на место (GarageHost.gone).
 * Из появлений и исчезновений у узла отдельно — машины парка жителей (carHomes.ts): едет домой от цели, где стояла
 * (fleetIn), и встала у цели, откуда потом поедет домой (fleetOut). Только наблюдает: подменяет крючки игры
 * обёртками, решений не меняет.
 */
export interface CarFlow {
  /** Появились у узла (из них — машины парка, что едут от цели домой) и выехали с места. */
  nodeIn: number;
  fleetIn: number;
  placeIn: number;
  /** Исчезли у узла (из них — машины парка, что встали у цели), потерялись (правка сети) и свернули на место. */
  nodeOut: number;
  fleetOut: number;
  lost: number;
  placeOut: number;
}

/**
 * Доли «из ниоткуда»: appear, vanish — появлений и исчезновений у узла (потерявшиеся — тоже у узла); nowhereIn,
 * nowhereOut — то же без машин парка (машины без своего места: про них неизвестно, откуда они и куда делись).
 */
export function nowhereShare(f: CarFlow): { appear: number; vanish: number; nowhereIn: number; nowhereOut: number } {
  const out = f.nodeOut + f.lost;
  const ins = Math.max(1, f.nodeIn + f.placeIn);
  const outs = Math.max(1, out + f.placeOut);
  return { appear: f.nodeIn / ins, vanish: out / outs, nowhereIn: (f.nodeIn - f.fleetIn) / ins, nowhereOut: (out - f.fleetOut) / outs };
}

type Watched = {
  owners: Map<number, { type: string }>;
  onArrive(sim: Vehicle): void;
  onLost(sim: Vehicle): void;
  garages: { host: GarageHost };
  carHomes?: CarHomes;
  lots?: { isHomingBig(simId: number): boolean };
};

/**
 * Следить за машинами жителей партии game: вернёт счётчик и frame() — звать после каждого кадра (новые машины в
 * потоке, что не выехали с места, — появились у узла).
 */
export function watchCarFlow(game: Game): { flow: CarFlow; frame(): void } {
  const g = game as unknown as Watched;
  const flow: CarFlow = { nodeIn: 0, fleetIn: 0, placeIn: 0, nodeOut: 0, fleetOut: 0, lost: 0, placeOut: 0 };
  // Машины, что уже в потоке, когда начали следить (замер после разгона), — не новые: откуда они, не видно.
  const seen = new Set<number>(game.traffic.vehicles.keys());
  const fromPlace = new Set<number>();
  const host = g.garages.host;
  const own = host.own.bind(host);
  const gone = host.gone.bind(host);
  host.own = (sim, trip) => {
    fromPlace.add(sim.id);
    flow.placeIn++;
    own(sim, trip);
  };
  host.gone = (sim) => {
    flow.placeOut++;
    gone(sim);
  };
  const arrive = g.onArrive.bind(g);
  const lost = g.onLost.bind(g);
  const fleetStays = (sim: Vehicle) => g.carHomes?.carOfSim(sim.id)?.home === false;
  g.onArrive = (sim) => {
    // У узла ворот большой площадки машина встаёт на место (game/lotParking.ts) — это «на месте», а не у узла.
    if (g.lots?.isHomingBig(sim.id)) flow.placeOut++;
    else if (g.owners.get(sim.id)?.type === 'citizen') {
      flow.nodeOut++;
      if (fleetStays(sim)) flow.fleetOut++;
    }
    arrive(sim);
  };
  g.onLost = (sim) => {
    if (g.owners.get(sim.id)?.type === 'citizen') flow.lost++;
    lost(sim);
  };
  return {
    flow,
    frame() {
      for (const id of game.traffic.vehicles.keys()) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (g.owners.get(id)?.type !== 'citizen' || fromPlace.has(id)) continue;
        flow.nodeIn++;
        if (g.carHomes?.carOfSim(id)?.home) flow.fleetIn++;
      }
    },
  };
}
