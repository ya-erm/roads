/**
 * Проверка выполнимости задания до того, как его выдать: груз можно получить и есть кому его принять,
 * города и предприятия существуют, объём не больше того, что регион может дать за срок, рост — не быстрее,
 * чем позволяет механика роста. Генератор и события не выдают задания, которые её не проходят.
 */
import { ECONOMY, MONTH_SCALE, TERM_SCALE } from '../config';
import { dist } from '../core/vec';
import type { Game } from '../game/game';
import { CARGO } from '../world/cargo';
import {
  cargoPotential,
  hasMarket,
  industryById,
  levelCap,
  paxPerMonth,
  posOf,
  producible,
  RAMP,
  rawOutput,
  receivers,
  resolve,
  townById,
} from './analysis';
import type { ObjectiveParams } from './types';

export interface Assessment {
  ok: boolean;
  /** Почему невыполнимо. */
  reason?: string;
  /** Оценка того, сколько можно успеть (в единицах цели), если она есть. */
  estimate?: number;
}

const yes = (estimate?: number): Assessment => ({ ok: true, estimate });
const no = (reason: string, estimate?: number): Assessment => ({ ok: false, reason, estimate });

/** Население растёт не быстрее ≈3.5% за 40 секунд при полном снабжении (дома за накопленный рост) — за месяц больше. */
const MAX_TOWN_GROWTH = 1.035 ** MONTH_SCALE - 1;

/** Сколько городов (или предприятий, которым есть куда везти и из чего делать) ещё вне сети: known — те, что в ней. */
export function connectable(game: Game, what: 'town' | 'industry', known: Iterable<number>): number {
  const inNet = new Set(known);
  return what === 'town'
    ? game.towns.filter((t) => !inNet.has(t.id)).length
    : game.industries.filter((i) => !inNet.has(i.id) && hasMarket(game, i) && i.info.accepts.every((c) => producible(game, c))).length;
}

/**
 * Сколько просить подключить: задуманное число, но с запасом в одного — вдруг до кого-то не дотянуться.
 * Осталось вне сети мало — просим меньше; 0 — задания не будет.
 */
export function connectGoal(game: Game, what: 'town' | 'industry', known: Iterable<number>, planned: number): number {
  return Math.max(0, Math.min(planned, connectable(game, what, known) - 1));
}

export function assess(game: Game, p: ObjectiveParams, months: number): Assessment {
  const work = months - RAMP;
  if (work <= 0) return no('слишком короткий срок');
  switch (p.kind) {
    case 'deliver': {
      if (!producible(game, p.cargo)) return no(`«${CARGO[p.cargo].name}» на карте не получить`);
      const to = p.to ? resolve(game, p.to) : undefined;
      if (p.to && !to) return no('получатель исчез');
      if (to && 'info' in to && !to.info.accepts.includes(p.cargo)) return no(`${to.name} не принимает «${CARGO[p.cargo].name}»`);
      if (to && !('info' in to) && !to.demands.includes(p.cargo)) return no(`${to.name} не нуждается в «${CARGO[p.cargo].name}»`);
      if (!to && !receivers(game, p.cargo).length) return no(`«${CARGO[p.cargo].name}» некому принять`);
      // Продукция конкретного предприятия — не больше, чем оно выпустит за срок.
      if (p.from !== undefined) {
        const maker = industryById(game, p.from);
        if (!maker || maker.info.produces !== p.cargo) return no('предприятие не производит этот груз');
        const estimate = maker.info.accepts.length
          ? Math.min(ECONOMY.processRate * levelCap(maker) * work, ...maker.info.accepts.map((c) => cargoPotential(game, c, maker.fp.center, months)))
          : rawOutput(maker, work);
        return p.amount <= estimate * 0.9 ? yes(estimate) : no(`${maker.name} выпустит за срок ≈${Math.round(estimate)}`, estimate);
      }
      // Сколько можно привезти: к получателю или (куда угодно) от лучших производителей.
      const targets = to ? [posOf(to)] : receivers(game, p.cargo).map(posOf);
      const estimate = Math.max(0, ...targets.slice(0, 6).map((pos) => cargoPotential(game, p.cargo, pos, months)));
      return p.amount <= estimate * 0.9 ? yes(estimate) : no(`регион даст ≈${Math.round(estimate)} ед. за срок, а нужно ${p.amount}`, estimate);
    }
    case 'passengers': {
      if (p.towns) {
        const [a, b] = p.towns.map((id) => townById(game, id));
        if (!a || !b || a === b) return no('нет таких городов');
        const estimate = paxPerMonth(a, b) * work;
        if (dist(a.center, b.center) > 9000) return no('города слишком далеко', estimate);
        return p.amount <= estimate * 0.9 ? yes(estimate) : no(`между городами поедет ≈${Math.round(estimate)} за срок`, estimate);
      }
      // По региону — осторожно: ≈16 поездок в 40 с на тысячу жителей в охвате (треть потока paxPerMonth).
      const pop = game.towns.reduce((s, t) => s + t.population, 0);
      const estimate = ((pop * 0.3 * 16 * MONTH_SCALE) / 1000) * work;
      return p.amount <= estimate * 0.9 ? yes(estimate) : no(`региону столько не уехать: ≈${Math.round(estimate)}`, estimate);
    }
    case 'industry': {
      const ind = industryById(game, p.industry);
      if (!ind) return no('предприятия нет');
      if (!hasMarket(game, ind)) return no('продукцию некуда везти — расти незачем');
      if (!ind.info.accepts.every((c) => producible(game, c))) return no('сырья не получить');
      if (p.level > levelCap(ind)) return no(`предел роста ×${levelCap(ind)}`);
      // Шаг роста — каждые growthMonths месяцев исправного вывоза.
      const steps = Math.max(0, (p.level - (ind.level ?? 1)) / ECONOMY.growthStep);
      const need = steps * ECONOMY.growthMonths;
      return need <= work ? yes(work / ECONOMY.growthMonths) : no(`рост на шаг — раз в ${ECONOMY.growthMonths} мес., нужно ${need} мес.`);
    }
    case 'supply': {
      const t = townById(game, p.town);
      if (!t) return no('города нет');
      const can = t.demands.filter((c) => producible(game, c)).length;
      const need = Math.min(p.needs ?? t.demands.length, t.demands.length);
      if (!need || can < need) return no(`из нужных городу грузов можно получить ${can}, а закрыть надо ${need}`);
      // На доставку первой партии — ещё 2 мин сверх разгона.
      return p.months <= work - TERM_SCALE ? yes() : no('слишком короткий срок для снабжения подряд');
    }
    case 'population': {
      const t = townById(game, p.town);
      if (!t) return no('города нет');
      const estimate = t.population * (1 + MAX_TOWN_GROWTH) ** work;
      return p.amount <= estimate * 0.95 ? yes(estimate) : no(`за срок город вырастет самое большее до ≈${Math.round(estimate)}`, estimate);
    }
    case 'profit':
    case 'quality':
    case 'throughput':
    case 'newRoutes':
      return p.months <= work ? yes() : no('слишком короткий срок');
    case 'connect': {
      // Есть из чего выбрать: городов и предприятий, которых в сети нет, хотя бы на одно больше, чем нужно.
      const free = connectable(game, p.what, p.known);
      return free > p.amount ? yes(free) : no(`вне сети осталось ${free}, а нужно подключить ${p.amount}`, free);
    }
  }
}
