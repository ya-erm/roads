/**
 * Откуда предприятию сейчас везут сырьё и куда увозят продукцию — по маршрутам, а не по расстоянию (как
 * Game.partners): маршрут, который может возить груз, проходит через грузовую станцию предприятия и через грузовую
 * станцию поставщика (предприятие, что делает это сырьё) или получателя (предприятие, которому нужна продукция, или
 * город, которому она нужна). С получателями грузов (world/retail.ts) город — это его магазины на маршруте: станция у
 * магазина или магазины в охвате станции (FlowWorld.shops). Только расчёт — для карточки предприятия
 * (ui/industryCard.ts).
 */
import type { CargoType } from '../world/cargo';
import type { Industry, Station, Town } from '../world/entities';
import type { Line } from './transport';

/** Партнёр по маршруту: предприятие, город или магазин города (b — его дом). */
export interface FlowLink {
  ref: { type: 'industry' | 'town'; id: number };
  name: string;
  b?: number;
}

/** Магазин (получатель груза), которому сдаёт станция: город, дом, название, что принимает. */
export interface FlowShop {
  town: number;
  b: number;
  name: string;
  cargo: readonly CargoType[];
}

export interface IndustryFlow {
  /** Через грузовую станцию предприятия идёт хоть один маршрут, который может возить груз. */
  routed: boolean;
  /** По каждому виду сырья — кто его везёт сюда по маршрутам. */
  inputs: { cargo: CargoType; from: FlowLink[] }[];
  /** Продукция — кому её везут по маршрутам. */
  output: { cargo: CargoType; to: FlowLink[] };
}

export interface FlowWorld {
  lines: Iterable<Line>;
  stations: ReadonlyMap<number, Station>;
  industries: readonly Industry[];
  towns: readonly Town[];
  /** Маршрут может возить груз (Game.lineTakes(line, 'freight')). */
  freight: (line: Line) => boolean;
  /** Магазины, которым сдаёт станция (Game.stationReceivers); нет — города целиком (старая модель). */
  shops?: (st: Station) => FlowShop[];
}

/** Станция работает с грузом предприятия id: его грузовой двор или предприятие в её охвате. */
const servesIndustry = (st: Station, id: number) => st.serves.cargo && (st.industryId === id || st.industryIds.includes(id));

export function industryFlow(ind: Industry, w: FlowWorld): IndustryFlow {
  const own = new Set([...w.stations.values()].filter((st) => servesIndustry(st, ind.id)).map((st) => st.id));
  let routed = false;
  // Грузовые станции на маршрутах предприятия, кроме его собственных.
  const others = new Map<number, Station>();
  for (const line of w.lines) {
    if (!line.stops.some((id) => own.has(id)) || !w.freight(line)) continue;
    routed = true;
    for (const sid of line.stops) {
      const st = w.stations.get(sid);
      if (st && !own.has(sid) && st.serves.cargo) others.set(sid, st);
    }
  }
  const stations = [...others.values()];
  const reached = (other: Industry) => stations.some((st) => servesIndustry(st, other.id));
  // Заброшенные не делают и не берут; себя не считаем.
  const live = w.industries.filter((i) => i !== ind && !i.ruin && reached(i));
  const link = (i: Industry): FlowLink => ({ ref: { type: 'industry', id: i.id }, name: i.name });
  const inputs = ind.info.accepts.map((cargo) => ({ cargo, from: live.filter((i) => i.info.produces === cargo).map(link) }));
  const product = ind.info.produces;
  const townIds = new Set(stations.flatMap((st) => st.townIds));
  // Магазины на маршруте, что примут продукцию; у города, где их нет (потребность без получателей), — город целиком.
  const shops = new Map<number, FlowShop>();
  if (w.shops) for (const st of stations) for (const s of w.shops(st)) if (s.cargo.includes(product)) shops.set(s.b, s);
  const shopTowns = new Set([...shops.values()].map((s) => s.town));
  const to = [
    ...live.filter((i) => i.info.accepts.includes(product)).map(link),
    ...[...shops.values()].sort((a, b) => a.b - b.b).map((s): FlowLink => ({ ref: { type: 'town', id: s.town }, name: s.name, b: s.b })),
    ...w.towns
      .filter((t) => townIds.has(t.id) && t.demands.includes(product) && !shopTowns.has(t.id))
      .map((t): FlowLink => ({ ref: { type: 'town', id: t.id }, name: t.name })),
  ];
  return { routed, inputs, output: { cargo: product, to } };
}
