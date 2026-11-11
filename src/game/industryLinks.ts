/**
 * Откуда предприятию сейчас везут сырьё и куда увозят продукцию — по маршрутам, а не по расстоянию (как
 * Game.partners): маршрут, который может возить груз, проходит через грузовую станцию предприятия и через грузовую
 * станцию поставщика (предприятие, что делает это сырьё) или получателя (предприятие, которому нужна продукция, или
 * город, которому она нужна). Только расчёт — для карточки предприятия (ui/industryCard.ts).
 */
import type { CargoType } from '../world/cargo';
import type { Industry, Station, Town } from '../world/entities';
import type { Line } from './transport';

/** Партнёр по маршруту: предприятие или город. */
export interface FlowLink {
  ref: { type: 'industry' | 'town'; id: number };
  name: string;
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
  const to = [
    ...live.filter((i) => i.info.accepts.includes(product)).map(link),
    ...w.towns
      .filter((t) => townIds.has(t.id) && t.demands.includes(product))
      .map((t): FlowLink => ({ ref: { type: 'town', id: t.id }, name: t.name })),
  ];
  return { routed, inputs, output: { cargo: product, to } };
}
