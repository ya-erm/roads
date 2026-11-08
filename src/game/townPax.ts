/**
 * Пассажиры города для блока «Что нужно городу» (ui/supplyUi.ts): сколько жителей хотят ездить, сколько из них
 * уже довезли автобусы и поезда в этом и прошлом месяце, сколько живёт у остановок с линиями, кто ждёт и куда
 * ходят линии. Ничего не меняет в игре — только собирает то, что уже есть (world/townPax.ts, Station.passengers).
 */
import { dist } from '../core/vec';
import type { Town } from '../world/entities';
import { PAX_NOWHERE, type PaxSplit, paxSplit, townPaxWant } from '../world/townPax';
import type { Game } from './game';
import type { Line } from './transport';

/** Направление поездок из города: другой город (или PAX_NOWHERE — станции за городом). */
export interface TownPaxDest {
  town: number;
  /** Довезли туда в этом месяце и в прошлом. */
  now: number;
  last: number;
  /** Ждут на станциях города поездки туда. */
  waiting: number;
  /** Пассажирские линии, что туда ходят; пусто — линии нет, жители ездят на машине. */
  lines: Line[];
}

export interface TownPax {
  /** Хотят ездить за месяц. */
  want: PaxSplit;
  /** Довезли в этом месяце и в прошлом. */
  now: PaxSplit;
  last: PaxSplit;
  /** Доля жителей у станций, откуда ходят пассажирские линии (0…1). */
  covered: number;
  /** Ждут на станциях города — всего. */
  waiting: number;
  /** Пассажирские линии через станции города. */
  lines: Line[];
  /** Куда ездят: сперва города, куда ходят линии или уже довезли, — по числу пассажиров; затем ближние без линии. */
  dests: TownPaxDest[];
}

/** Сколько ближних городов без линии показать — куда жители поехали бы, будь автобус. */
const NEAR_UNLINKED = 2;
/** Больше направлений не помещается в строку карточки. */
const MAX_DESTS = 4;

/** Пассажиры города town: спрос, перевезённое, охват остановок и направления. */
export function townPax(game: Game, town: Town): TownPax {
  const dests = new Map<number, TownPaxDest>();
  const dest = (id: number) => {
    let d = dests.get(id);
    if (!d) dests.set(id, (d = { town: id, now: 0, last: 0, waiting: 0, lines: [] }));
    return d;
  };
  const lines = new Set<Line>();
  let covered = 0;
  let waiting = 0;
  // Пассажиры станции — в счёт её первого города (так их считает игра: Game.paxArrivals и сценарий).
  for (const st of game.stations.values()) {
    if (!st.serves.pax || st.townIds[0] !== town.id) continue;
    const routes = game.paxRoutes(st);
    if (!routes.size) continue;
    covered += st.catchPop;
    for (const [sid, via] of routes) {
      const to = game.stations.get(sid)?.townIds[0] ?? PAX_NOWHERE;
      const n = Math.floor(st.passengers.get(sid) ?? 0);
      waiting += n;
      const d = dest(to);
      d.waiting += n;
      for (const l of via) {
        lines.add(l);
        if (!d.lines.includes(l)) d.lines.push(l);
      }
    }
  }
  for (const [to, n] of Object.entries(town.paxMonth ?? {})) dest(Number(to)).now += n;
  for (const [to, n] of Object.entries(town.paxLast ?? {})) dest(Number(to)).last += n;
  dests.delete(town.id);
  const linked = [...dests.values()].sort((a, b) => b.now + b.waiting - (a.now + a.waiting) || b.last - a.last);
  // Ближние города без линии: туда жители ездят на машине — значок подскажет, куда пустить автобус.
  const near = game.towns
    .filter((t) => t.id !== town.id && !t.labelOnly && t.population > 0 && !dests.has(t.id))
    .sort((a, b) => dist(a.center, town.center) - dist(b.center, town.center))
    .slice(0, NEAR_UNLINKED)
    .map((t) => ({ town: t.id, now: 0, last: 0, waiting: 0, lines: [] }));
  return {
    want: townPaxWant(town.population, game.mods.pax(town.id)),
    now: paxSplit(town.id, town.paxMonth),
    last: paxSplit(town.id, town.paxLast),
    covered: town.population ? Math.min(1, covered / town.population) : 0,
    waiting,
    lines: [...lines],
    dests: [...linked, ...near].slice(0, MAX_DESTS),
  };
}
