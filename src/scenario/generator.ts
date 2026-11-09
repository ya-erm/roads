/**
 * Генератор сценария: архетип по seed (до генерации карты) и проверка по готовой карте, стартовые условия
 * и задания этапов. Задания следующего этапа создаются только при переходе к нему — по тому, что игрок
 * построил, что выросло и что просело. Требования — от оценки выполнимого: производства, вместимости
 * разумного парка и денег, а не от богатства игрока.
 */
import { CONSTRUCTION, ECONOMY, MONTH_LENGTH, MONTH_SCALE, TERM_SCALE } from '../config';
import { Rng } from '../core/rng';
import { dist } from '../core/vec';
import type { Game } from '../game/game';
import { MODELS, newestLike } from '../game/transport';
import { CARGO, CargoType, type IndustryType, TOWN_CARGO } from '../world/cargo';
import { buildCost, freeDeposits, harmClass, isRaw } from '../world/enterprise';
import { TOWN_NEED } from '../world/entities';
import { townNeed } from '../world/townSupply';
import type { Industry, Town } from '../world/entities';
import type { WorldSettings } from '../world/settings';
import {
  bigTowns,
  cargoPotential,
  connected,
  distToNetwork,
  hasMarket,
  km,
  levelCap,
  network,
  paxPerMonth,
  producible,
  RAMP,
  rawOutput,
  rawSupplies,
  receivers,
  refOf,
  region,
  RegionInfo,
  roadMonths,
  routeCost,
  buildAllowance,
  buildEffort,
  buildReach,
  live,
  Supply,
  supplyEffort,
  townPairs,
} from './analysis';
import { ARCHETYPE_LIST, ARCHETYPES, BASE_TOWNS, PHASES } from './content';
import type { Scenario } from './manager';
import { mixSeed } from './manager';
import { connectGoal } from './feasibility';
import { makerKey, moneyText, receiverKey, titleOf } from './objectives';
import type { ArchetypeId, Objective, ObjectiveParams, ObjectiveRole, Ref } from './types';

const ARCHETYPE_SALT = 0x9e3779b9;

const round10 = (n: number) => Math.max(10, Math.round(n / 10) * 10);
const roundMoney = (n: number, step = 5000) => Math.round(n / step) * step;

/** Сколько ед. в месяц возит одна машина на расстояние d по прямой (с погрузкой, перекрёстками и обратным рейсом). */
export function perVehicleMonth(d: number, capacity: number, both = false): number {
  const trip = (2 * d * 1.3) / 26 + 20;
  return ((both ? 2 : 1) * capacity * MONTH_LENGTH) / trip;
}

/** Разумный парк на первую линию: столько машин позволяет себе осторожная стратегия на старте. */
const START_FLEET = { easy: 6, normal: 5, hard: 4 } as const;

/** Быстрый срок: стройка дороги, станций и покупка машин, месяцев (1 мин). */
const FAST_SETUP = 0.5 * TERM_SCALE;
/** Быстрый срок: запас к прикидке. */
const FAST_SLACK = 1.2;

/**
 * Быстрый срок — необязательный, раньше обычного: успели — надбавка к награде и очки за быстроту. Только там,
 * где время честно прикидывается по дороге: доставка получателю от ближайшего производителя и пассажиры между
 * двумя городами. Прикидка: стройка и первый рейс, затем объём / (что возит парк в полтора раза больше
 * стартового новейшими машинами — но не больше, чем производитель даёт или города ездят), и запас 20%.
 * Возвращает месяцев от начала задания; не выходит хотя бы на 2 мин раньше обычного срока — null.
 */
export function fastMonths(game: Game, p: ObjectiveParams, months: number, difficulty: keyof typeof START_FLEET): number | null {
  const fleet = Math.ceil(START_FLEET[difficulty] * 1.5);
  let d: number;
  let rate: number;
  let model: ReturnType<typeof newestLike>;
  if (p.kind === 'deliver' && p.to) {
    const to = p.to.type === 'industry' ? game.industries.find((i) => i.id === p.to!.id) : game.towns.find((t) => t.id === p.to!.id);
    if (!to) return null;
    const at = 'info' in to ? to.fp.center : to.center;
    const src = game.industries
      .filter((i) => i.info.produces === p.cargo && (!i.info.accepts.length || i.producedLast > 0))
      .sort((a, b) => dist(a.fp.center, at) - dist(b.fp.center, at))[0];
    if (!src) return null;
    d = dist(src.fp.center, at);
    model = newestLike('truck', game.modelOpen);
    const made = src.info.accepts.length ? src.producedLast : rawOutput(src, 1);
    rate = Math.min(fleet * perVehicleMonth(d, MODELS[model].capacity), made);
  } else if (p.kind === 'passengers' && p.towns) {
    const [a, b] = p.towns.map((id) => game.towns.find((t) => t.id === id));
    if (!a || !b) return null;
    d = dist(a.center, b.center);
    model = newestLike('bus', game.modelOpen);
    rate = Math.min(fleet * perVehicleMonth(d, MODELS[model].capacity, true), paxPerMonth(a, b));
  } else return null;
  if (rate <= 0) return null;
  const firstTrip = ((d * 1.3) / 26 + 10) / MONTH_LENGTH;
  // «Со строительством» — и стройка дороги между ними.
  const setup = game.buildMode ? FAST_SETUP + roadMonths(game, d) : FAST_SETUP;
  const fast = Math.ceil((setup + firstTrip + p.amount / rate) * FAST_SLACK);
  return fast <= months - TERM_SCALE ? Math.max(TERM_SCALE, fast) : null;
}

// ---------- До генерации карты ----------

/**
 * Архетип по seed (или выбранный игроком) и профиль карты под него: число и скученность городов,
 * плотность предприятий. Настройки с решённым архетипом сохраняются вместе с партией.
 */
export function prepareSettings(settings: WorldSettings): WorldSettings {
  const sc = settings.scenario;
  if (!sc || (sc.archetype && sc.profile)) return settings;
  const rng = new Rng(mixSeed(settings.seed, ARCHETYPE_SALT));
  const id = sc.pick ?? pickWeighted(rng, ARCHETYPE_LIST.map((a) => ({ v: a.id, w: a.weight })));
  const a = ARCHETYPES[id];
  const towns = Math.max(4, Math.min(20, Math.round(BASE_TOWNS[settings.size] * a.towns)));
  return { ...settings, towns, industries: a.industries, scenario: { ...sc, archetype: id, profile: a.profile } };
}

export function pickWeighted<T>(rng: Rng, items: { v: T; w: number }[]): T {
  const total = items.reduce((s, x) => s + x.w, 0);
  let r = rng.range(0, total);
  for (const x of items) {
    r -= x.w;
    if (r <= 0) return x.v;
  }
  return items[items.length - 1].v;
}

/** Подходит ли готовая карта под архетип: из этого правда получится такая игра. */
export function fits(id: ArchetypeId, r: RegionInfo): boolean {
  switch (id) {
    case 'industrial':
      return r.compactChains >= 3;
    case 'agglomeration':
      return r.bigTowns >= 2 && r.closeBigPairs >= 1;
    case 'scattered':
      return r.towns >= 7 && r.spacing >= 2000;
    case 'logistics':
      return r.hubIndustries >= 8;
    case 'mixed':
      return true;
  }
}

// ---------- Старт ----------

interface FreightPlan {
  supply: Supply;
  amount: number;
  fleet: number;
  cost: number;
  /** Чистыми в месяц, когда линия разогналась. */
  net: number;
}

interface PaxPlan {
  a: Town;
  b: Town;
  d: number;
  amount: number;
  fleet: number;
  cost: number;
  net: number;
}

/**
 * Поставки сырья на завод, у которого есть сбыт: одна из трёх самых коротких (по seed),
 * объём — по разумному парку и добыче, деньги — дорога, станции и машины.
 */
function freightPlan(sc: Scenario, months: number): FreightPlan | null {
  const game = sc.game;
  const diff = sc.difficulty;
  const all = rawSupplies(game).filter((s) => s.d >= 450 && s.d <= 4500 && hasMarket(game, s.to) && producible(game, s.to.info.produces));
  // «Со строительством» первая линия — без долгой стройки дороги (если такие на карте есть).
  const short = game.buildMode ? all.filter((s) => s.d <= buildReach(CONSTRUCTION.firstBuild)) : all;
  const options = short.length ? short : all;
  // Заводы на один вид сырья — первыми: там поставки сразу превращаются в продукцию.
  const single = options.filter((s) => s.to.info.accepts.length === 1);
  const pool = (single.length >= 2 ? single : options).slice(0, 3);
  if (!pool.length) return null;
  const supply = sc.rng.pick(pool);
  const work = Math.max(1, months - RAMP - roadMonths(game, supply.d));
  const fleet = START_FLEET[sc.state.settings.difficulty];
  const perMonth = perVehicleMonth(supply.d, MODELS.truck.capacity);
  const can = Math.min(fleet * perMonth * work, rawOutput(supply.from, work));
  const amount = round10(can * diff.demand);
  const income = fleet * perMonth * CARGO[supply.cargo].rate * 2 * (supply.d / 100);
  return { supply, amount, fleet, cost: routeCost(supply.d, fleet, 'truck'), net: income - fleet * MODELS.truck.running };
}

/** Пассажирское сообщение между близкими городами: пары с самым большим потоком на километр. */
function paxPlan(sc: Scenario, months: number, skip?: Set<number>): PaxPlan | null {
  const game = sc.game;
  const diff = sc.difficulty;
  const all = townPairs(game).filter((p) => p.d >= 900 && p.d <= 6000 && !(skip?.has(p.a.id) && skip?.has(p.b.id)));
  // «Со строительством» — пары, между которыми дорога строится недолго (если такие на карте есть).
  const short = game.buildMode ? all.filter((p) => p.d <= buildReach(CONSTRUCTION.firstBuild)) : all;
  const pairs = (short.length ? short : all)
    .map((p) => ({ ...p, value: paxPerMonth(p.a, p.b) / (p.d + 1500) }))
    .sort((x, y) => y.value - x.value)
    .slice(0, 3);
  if (!pairs.length) return null;
  const p = sc.rng.pick(pairs);
  const work = Math.max(1, months - RAMP - roadMonths(game, p.d));
  const fleet = Math.max(2, START_FLEET[sc.state.settings.difficulty] - 2);
  const perMonth = perVehicleMonth(p.d, MODELS.bus.capacity, true);
  const can = Math.min(fleet * perMonth, paxPerMonth(p.a, p.b)) * work;
  const income = Math.min(fleet * perMonth, paxPerMonth(p.a, p.b)) * CARGO.passengers.rate * 2 * (p.d / 100);
  return { a: p.a, b: p.b, d: p.d, amount: round10(can * diff.demand), fleet, cost: routeCost(p.d, fleet, 'bus'), net: income - fleet * MODELS.bus.running };
}

/** Брифинг: регион, капитал, кредит, предел кредита и главное о карте. */
function describeRegion(sc: Scenario, r: RegionInfo): string[] {
  const game = sc.game;
  const deposits = game.enterprises.deposits.filter((d) => d.used === undefined).length;
  const plural = (n: number, one: string, few: string, many: string) =>
    n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
  const inds = live(game).length;
  const facts = [
    `${r.towns} городов, ${r.population.toLocaleString('ru-RU')} жителей; крупных — ${r.bigTowns}`,
    game.enterprises.on
      ? `${inds} ${plural(inds, 'предприятие', 'предприятия', 'предприятий')} и ${deposits} ${plural(deposits, 'месторождение', 'месторождения', 'месторождений')} ⛏️ — остальное строите сами; цепочек с близким сырьём — ${r.compactChains}`
      : `${game.industries.length} предприятий, цепочек с близким сырьём — ${r.compactChains}`,
    `Между соседними городами в среднем ${km(r.spacing)}`,
  ];
  const big = bigTowns(game)[0];
  if (big) facts.push(`Крупнейший город — ${big.name} (${big.population.toLocaleString('ru-RU')} жит.)`);
  return facts;
}

/**
 * Новый сценарий: архетип по карте (не подошла — другой, который подходит), стартовый капитал от стоимости
 * первой цели, стартовый кредит, задания этапа A и стартовый контракт.
 */
export function startScenario(sc: Scenario): void {
  const game = sc.game;
  const s = sc.state;
  const r = region(game);
  const planned = s.settings.archetype ?? 'mixed';
  if (!fits(planned, r)) {
    const ok = ARCHETYPE_LIST.filter((a) => a.id !== planned && a.id !== 'mixed' && fits(a.id, r));
    s.archetype = ok.length ? pickWeighted(sc.rng, ok.map((a) => ({ v: a.id, w: a.weight }))) : 'mixed';
  } else s.archetype = planned;
  const arch = ARCHETYPES[s.archetype];
  const diff = sc.difficulty;
  s.start = {
    population: r.population,
    levels: game.industries.reduce((sum, i) => sum + (i.level ?? 1), 0),
  };
  const months = Math.round(PHASES[0].months * diff.time);
  const freight = freightPlan(sc, months);
  const pax = paxPlan(sc, months);
  // «Со строительством» к сроку этапа A — запас на стройку дорог обеих линий (объёмы — по прежнему сроку).
  const build = buildAllowance(game, [freight?.supply.d, pax?.d].filter((d): d is number => d !== undefined));
  const paxMain = (arch.pax >= 0.5 && !!pax) || !freight;
  const main = paxMain ? pax : freight;
  // Капитал: на главную цель с запасом по сложности; на вторую цель — уже впритык или в кредит.
  const mainCost = main?.cost ?? 150_000;
  const capital = Math.max(200_000, Math.min(900_000, roundMoney(mainCost * diff.capital * arch.capital, 10_000)));
  const loan = roundMoney(capital * (arch.loan + (s.settings.difficulty === 'hard' ? 0.15 : 0)), 50_000);
  game.money = capital;
  game.loan = loan;
  s.brief = {
    region: arch.name,
    text: arch.pitch,
    capital,
    loan,
    loanMax: diff.loanMax,
    months: Math.round(PHASES.reduce((sum, p) => sum + p.months, 0) * diff.time) + build,
    build: build || undefined,
    facts: describeRegion(sc, r),
  };
  // Кредит уже в капитале: часть стартовых денег заёмная, проценты — с первого месяца.
  if (loan > 0)
    s.brief.facts.unshift(`Из капитала ${moneyText(loan)} — заёмные: ${Math.round(ECONOMY.loanRate * 100)}% в месяц, гасить можно в «Финансах»`);
  phaseA(sc, { months: months + build, fast: build ? months : undefined }, paxMain, freight, pax);
  // Стартовый контракт: груз городу, которому он нужен, если его можно получить на карте.
  startContract(sc);
  sc.log('phase', `Этап A: ${PHASES[0].name}`);
}

/** Срок целей этапа A и быстрый срок (есть, когда к сроку добавлен запас на стройку). */
interface Term {
  months: number;
  fast?: number;
}

function phaseA(sc: Scenario, term: Term, paxMain: boolean, freight: FreightPlan | null, pax: PaxPlan | null): void {
  const { months, fast } = term;
  const diff = sc.difficulty;
  const critical = diff.critical;
  const paxGoal = () =>
    pax &&
    sc.tryObjective(
      { kind: 'passengers', amount: pax.amount, towns: [pax.a.id, pax.b.id] },
      {
        role: 'main',
        phase: 0,
        months,
        fast,
        critical,
        why: `${pax.a.name} и ${pax.b.name} в ${km(pax.d)} друг от друга, жителям нужно ездить между ними. Хватит ${pax.fleet} автобусов, дорога и две станции — около ${moneyText(pax.cost)}.`,
        reward: { money: roundMoney(pax.cost * 0.5), reputation: 0 },
        related: [refOf(pax.a), refOf(pax.b)],
      },
    );
  const freightGoal = () =>
    freight &&
    sc.tryObjective(
      { kind: 'deliver', cargo: freight.supply.cargo, amount: freight.amount, to: refOf(freight.supply.to) },
      {
        role: 'main',
        phase: 0,
        months,
        fast,
        critical,
        why: `${freight.supply.to.name} ждёт «${CARGO[freight.supply.cargo].name}». Ближайший поставщик — ${freight.supply.from.name}, ${km(freight.supply.d)}. Хватит ${freight.fleet} грузовиков — около ${moneyText(freight.cost)} вместе с дорогой.`,
        reward: { money: roundMoney(freight.cost * 0.5), reputation: 0 },
        related: [refOf(freight.supply.from), refOf(freight.supply.to)],
      },
    );
  // Главная цель — по архетипу; невыполнима — другая, в крайнем случае — пассажиры по региону.
  const main = paxMain ? (paxGoal() ?? freightGoal()) : (freightGoal() ?? paxGoal());
  if (!main) {
    sc.addObjective(
      { kind: 'passengers', amount: round10(120 * diff.demand), towns: null },
      { role: 'main', phase: 0, months, fast, critical, why: 'Первые пассажирские линии компании.', reward: { money: 60_000, reputation: 0 } },
    );
  }
  paxMain = main?.params.kind === 'passengers';
  // Вторая цель — другой вид перевозок, поменьше.
  if (paxMain && freight) {
    const sp = freight.supply;
    sc.tryObjective(
      { kind: 'deliver', cargo: sp.cargo, amount: round10(freight.amount * 0.5), to: refOf(sp.to) },
      {
        role: 'goal',
        phase: 0,
        months,
        fast,
        why: `${sp.from.name} → ${sp.to.name}, ${km(sp.d)}: первая грузовая линия.`,
        reward: { money: roundMoney(freight.cost * 0.3) },
        related: [refOf(sp.from), refOf(sp.to)],
      },
    );
  } else if (!paxMain && pax) {
    sc.tryObjective(
      { kind: 'passengers', amount: round10(pax.amount * 0.5), towns: [pax.a.id, pax.b.id] },
      {
        role: 'goal',
        phase: 0,
        months,
        fast,
        why: `Соединить ${pax.a.name} и ${pax.b.name} (${km(pax.d)}) автобусами.`,
        reward: { money: roundMoney(pax.cost * 0.3) },
        related: [refOf(pax.a), refOf(pax.b)],
      },
    );
  }
  // «Строит игрок»: построить первое предприятие — завод для добычи без сбыта или добычу для завода без сырья.
  if (sc.game.enterprises.on) {
    const target = buildTarget(sc.game);
    if (target)
      sc.tryObjective(
        { kind: 'build', count: 1, what: target.kind.kind, cargo: target.kind.produces, known: liveIds(sc.game) },
        { role: 'goal', phase: 0, months, fast, why: target.why, reward: { money: roundMoney(buildCost(target.kind) * 0.6), reputation: 2 }, related: target.related },
      );
  }
  // Прибыль: половина того, что даст главная линия, когда разгонится.
  const net = Math.max(freight?.net ?? 0, pax?.net ?? 0);
  const amount = Math.max(3000, roundMoney(net * 0.6 * (diff.demand / 0.65), 1000));
  sc.addObjective(
    { kind: 'profit', amount, months: 1 * TERM_SCALE },
    {
      role: 'goal',
      phase: 0,
      months,
      fast,
      why: 'Компания должна зарабатывать на перевозках больше, чем тратит на транспорт, ремонт дорог и проценты.',
      reward: { money: roundMoney(amount * 2), reputation: 3 },
    },
  );
}

/** Стартовый контракт: продукт городу, которому он нужен, — если всю цепочку можно собрать на карте. */
function startContract(sc: Scenario): void {
  const game = sc.game;
  const options: { town: Town; cargo: CargoType; d: number; plant: Industry }[] = [];
  for (const town of game.towns) {
    for (const cargo of town.demands) {
      if (!producible(game, cargo)) continue;
      const plant = game.industries
        .filter((i) => i.info.produces === cargo)
        .sort((a, b) => dist(a.fp.center, town.center) - dist(b.fp.center, town.center))[0];
      if (plant && plant.info.accepts.length === 1) options.push({ town, cargo, d: dist(plant.fp.center, town.center), plant });
    }
  }
  const best = options.sort((a, b) => a.d - b.d).slice(0, 3);
  if (!best.length) return;
  const o = sc.rng.pick(best);
  const months = Math.round(6 * TERM_SCALE * sc.difficulty.time);
  // «Со строительством» — запас на стройку обеих дорог цепочки: сырьё → завод и завод → город; прежний срок — быстрый.
  const raw = rawSupplies(game).find((s) => s.to === o.plant);
  const build = buildAllowance(game, raw ? [raw.d, o.d] : [o.d]);
  // Не меньше базовой нормы города за прежние три месяца (6 мин) — без роста с населением: объём контракта прежний.
  const amount = round10(Math.max(TOWN_NEED * 3 * TERM_SCALE, Math.min(cargoPotential(game, o.cargo, o.town.center, months) * 0.25, 160) * sc.difficulty.demand));
  sc.tryObjective(
    { kind: 'deliver', cargo: o.cargo, amount, to: refOf(o.town) },
    {
      role: 'contract',
      phase: null,
      months: months + build,
      fast: build ? months : undefined,
      offer: true,
      why: `Торговая сеть города ${o.town.name} ищет перевозчика: нужны «${CARGO[o.cargo].name}». Их делает ${o.plant.name} (${km(o.d)}) — из сырья, которое ещё нужно туда привезти.`,
      reward: { money: roundMoney(amount * CARGO[o.cargo].rate * 30 * sc.rewardFactor), reputation: 4 },
      fail: { reputation: -6 },
      related: [refOf(o.town), refOf(o.plant)],
    },
  );
}

// ---------- Следующие этапы ----------

/** Задания этапа B или C — по тому, что сейчас в регионе и что построил игрок. */
export function generatePhase(sc: Scenario, phase: number): void {
  if (phase === 1) phaseB(sc);
  else if (phase === 2) phaseC(sc);
}

/** Последние 4 мин итогов сценария — нынешний темп перевозок. */
const RECENT_MONTHS = 2 * TERM_SCALE;

/** Лучший месяц перевозок за последние 4 мин (объём груза и пассажиров). */
function bestMonth(sc: Scenario): number {
  const recent = sc.state.stats.months.slice(-RECENT_MONTHS);
  return Math.max(0, ...recent.map((m) => m.units));
}

/**
 * Этап B «Экспансия». Главная цель — по стратегии игрока: если он уже снабжает завод — вырастить его
 * (нужно и возить сырьё, и вывозить продукцию); если нет — новая производственная цепочка;
 * если он делал ставку на пассажиров — пассажиропоток. Цели: снабжение города и другой вид перевозок.
 */
function phaseB(sc: Scenario): void {
  const game = sc.game;
  const s = sc.state;
  const diff = sc.difficulty;
  const info = network(game);
  const months = Math.round(PHASES[1].months * diff.time);
  const work = months - RAMP;
  type Option = { kind: 'industry' | 'chain' | 'pax' | 'build'; params: ObjectiveParams; why: string; related: ReturnType<typeof refOf>[]; value: number };
  const options: Option[] = [];
  // «Строит игрок»: новая цепочка со своим заводом — постройте и выпустите.
  const built = game.enterprises.on ? buildChain(sc, months) : null;
  if (built) options.push({ kind: 'build', ...built });
  // Завод, которому игрок уже возит сырьё, но чего-то не хватает: второго вида сырья или вывоза продукции.
  // Завод, у которого всё налажено, растёт сам (шаг уровня за каждый хороший месяц) — такая цель была бы даром.
  const gets = (i: Industry, c: CargoType) => (s.stats.to[`industry:${i.id}:${c}`] ?? 0) > 0;
  const shipped = (i: Industry) => (s.stats.from?.[makerKey(i.id, i.info.produces)] ?? 0) > 0;
  const lacks = (i: Industry) => (!i.info.accepts.every((c) => gets(i, c)) ? 'input' : !shipped(i) ? 'output' : null);
  const plant = game.industries
    .filter((i) => i.info.accepts.length && i.info.accepts.some((c) => gets(i, c)) && lacks(i) && levelCap(i) - (i.level ?? 1) >= 0.75)
    .sort((a, b) => (b.level ?? 1) - (a.level ?? 1))[0];
  if (plant) {
    const level = Math.min(levelCap(plant), Math.round(((plant.level ?? 1) + (s.settings.difficulty === 'easy' ? 0.75 : 1)) * 4) / 4);
    const missing = plant.info.accepts.filter((c) => !gets(plant, c)).map((c) => `«${CARGO[c].name}»`);
    options.push({
      kind: 'industry',
      params: { kind: 'industry', industry: plant.id, level },
      why:
        lacks(plant) === 'input'
          ? `${plant.name} получает не всё сырьё: не хватает ${missing.join(' и ')}. Без него завод стоит — а чтобы вырос, продукцию нужно ещё и вывозить.`
          : `${plant.name} получает сырьё, но продукцию никто не вывозит — склад полон, завод не растёт. Наладьте вывоз «${CARGO[plant.info.produces].name}».`,
      related: [refOf(plant)],
      value: level * 40_000,
    });
  }
  const chain = newChain(sc, months, info);
  if (chain) options.push({ kind: 'chain', ...chain });
  // Пассажиропоток: нынешний темп с ростом и новый город рядом с сетью.
  const recent = s.stats.months.slice(-RECENT_MONTHS);
  const paxRate = recent.reduce((sum, m) => sum + (m.pax ?? 0), 0) / Math.max(1, recent.length);
  const pairs = townPairs(game).filter((p) => !(info.towns.has(p.a.id) && info.towns.has(p.b.id)) && p.d <= 6000);
  const extra = pairs.length ? paxPerMonth(pairs[0].a, pairs[0].b) * 0.5 : 0;
  // Не меньше 50 пассажиров за каждые 40 с (75 в месяц).
  const paxAmount = round10(Math.max(50 * MONTH_SCALE, paxRate * 1.3 + extra) * work * diff.demand);
  options.push({
    kind: 'pax',
    params: { kind: 'passengers', amount: paxAmount, towns: null },
    why: 'Пассажирские линии — то, что сейчас нужнее всего региону. Новые города в сети и частые рейсы.',
    related: [],
    value: paxAmount * 50,
  });
  // Стратегия игрока: возил в основном пассажиров — главная цель тоже пассажирская.
  const paxFirst = info.pax > info.freight * 1.5;
  // «Строит игрок» — сначала своя новая цепочка: этап B подталкивает строить.
  const order: Option['kind'][] = paxFirst ? ['pax', 'build', 'industry', 'chain'] : ['build', 'industry', 'chain', 'pax'];
  let mainKind: Option['kind'] | null = null;
  for (const kind of order) {
    const opt = options.find((o) => o.kind === kind);
    if (!opt) continue;
    const o = sc.tryObjective(opt.params, {
      role: 'main',
      phase: 1,
      months,
      critical: diff.critical,
      why: opt.why,
      reward: { money: roundMoney(opt.value), reputation: 0 },
      related: opt.related,
    });
    if (o) {
      mainKind = kind;
      break;
    }
  }
  if (!mainKind) {
    sc.addObjective(
      { kind: 'profit', amount: 15_000 * MONTH_SCALE, months: 1 * TERM_SCALE },
      { role: 'main', phase: 1, months, critical: diff.critical, why: 'Компания должна стабильно зарабатывать.', reward: { money: 80_000, reputation: 0 } },
    );
  }
  // Цель: снабжать город сети (а нет такого — ближайший к ней), где закрыть часть потребностей проще всего.
  const served = game.towns.filter((t) => info.towns.has(t.id));
  const near = [...game.towns].sort((a, b) => distToNetwork(info, a.center) - distToNetwork(info, b.center)).slice(0, 3);
  supplyObjective(sc, served.length ? served : near, { phase: 1, months, inRow: 1 * TERM_SCALE, money: 60_000, growth: true });
  // Вторая цель — другой вид перевозок.
  const second = mainKind === 'pax' ? (built ?? chain) : null;
  if (second) {
    sc.tryObjective(second.params, { role: 'goal', phase: 1, months, why: second.why, reward: { money: roundMoney(second.value * 0.6) }, related: second.related });
  } else {
    const p = paxPlan(sc, months, info.towns);
    if (p)
      sc.tryObjective(
        { kind: 'passengers', amount: round10(p.amount * 1.2), towns: [p.a.id, p.b.id] },
        {
          role: 'goal',
          phase: 1,
          months,
          why: `Пригородное сообщение: ${p.a.name} — ${p.b.name}, ${km(p.d)}.`,
          reward: { money: roundMoney(p.cost * 0.5), effects: [{ kind: 'growth', target: p.a.id, factor: 1.3, months: 6 * TERM_SCALE }] },
          related: [refOf(p.a), refOf(p.b)],
        },
      );
  }
}

/** Новая производственная цепочка: продукт завода, ещё не обслуживаемого, ближе к сети игрока — получателям. */
function newChain(sc: Scenario, months: number, info: ReturnType<typeof network>): { params: ObjectiveParams; why: string; related: ReturnType<typeof refOf>[]; value: number } | null {
  const game = sc.game;
  const diff = sc.difficulty;
  const plants = game.industries
    .filter((i) => i.info.accepts.length && !info.industries.has(i.id) && hasMarket(game, i) && producible(game, i.info.produces))
    .map((i) => ({ i, d: distToNetwork(info, i.fp.center) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3);
  if (!plants.length) return null;
  const { i: plant } = sc.rng.pick(plants);
  const product = plant.info.produces;
  const potential = cargoPotential(game, product, plant.fp.center, months);
  // Цепочка из двух звеньев: сырьё на завод и продукцию от него — объём меньше, чем у одной линии.
  const amount = round10(Math.max(40, Math.min(potential * 0.35, ECONOMY.processRate * (months - RAMP - TERM_SCALE) * 0.35)) * diff.demand);
  const to = receivers(game, product).sort((a, b) => dist('info' in a ? a.fp.center : a.center, plant.fp.center) - dist('info' in b ? b.fp.center : b.center, plant.fp.center))[0];
  const inputs = plant.info.accepts.map((c) => CARGO[c].name.toLowerCase()).join(' и ');
  return {
    params: { kind: 'deliver', cargo: product, amount, to: null },
    why: `Новая цепочка: ${inputs} → ${plant.name} → «${CARGO[product].name}»${to ? ` (ближайший получатель — ${to.name})` : ''}. Нужно и привезти сырьё, и вывезти продукцию.`,
    related: [refOf(plant), ...(to ? [refOf(to)] : [])],
    value: amount * CARGO[product].rate * 25,
  };
}

const CONNECT_WHY = {
  town: 'Города без транспорта: подойдёт любая работающая станция в городе — пассажирский маршрут или поставки.',
  industry: 'Предприятия, до которых ещё не дотянулась сеть: грузовая станция у предприятия и маршрут с транспортом.',
};

/**
 * Цель «подключить к сети N новых городов (предприятий)»: в сети — те, что в ней сейчас. Вне сети осталось
 * мало — просим меньше задуманного (с запасом в одного), не осталось — цели нет.
 */
function connectObjective(
  sc: Scenario,
  what: 'town' | 'industry',
  planned: number,
  o: { role?: ObjectiveRole; phase: number | null; months: number | null; money: number },
): Objective | null {
  const role = o.role ?? 'goal';
  const now = connected(sc.game);
  const known = what === 'town' ? [...now.towns] : [...now.industries];
  const amount = connectGoal(sc.game, what, known, planned);
  if (amount < 1) {
    sc.game.journal.add('skip', { role, title: titleOf({ kind: 'connect', what, amount: planned, known }, sc.game), reason: 'вне сети почти не осталось' });
    return null;
  }
  return sc.tryObjective({ kind: 'connect', what, amount, known }, { role, phase: o.phase, months: o.months, why: CONNECT_WHY[what], reward: { money: o.money } });
}

/**
 * После победы — дополнительные задания без сроков: довести начатое до конца. Снабжать город целиком (все
 * потребности), подключить ещё города и предприятия, поставить рекорд перевозок. Платят деньгами, на оценку
 * и медаль не влияют. Чего на карте уже не осталось — того и не просим.
 */
export function extraObjectives(sc: Scenario): void {
  const game = sc.game;
  const info = network(game);
  const opts = { role: 'extra' as const, phase: null, months: null };
  const served = game.towns.filter((t) => info.towns.has(t.id)).sort((a, b) => b.population - a.population);
  supplyObjective(sc, served.slice(0, 3), { ...opts, inRow: 2 * TERM_SCALE, money: 150_000, needs: 'all' });
  connectObjective(sc, 'town', 2, { ...opts, money: 120_000 });
  if (game.enterprises.on) buildObjective(sc, 3, { ...opts, money: 120_000 });
  else connectObjective(sc, 'industry', 4, { ...opts, money: 120_000 });
  const best = Math.max(0, ...sc.state.stats.months.map((m) => m.units));
  if (best > 0) {
    const amount = round10(best * 1.3);
    sc.tryObjective(
      { kind: 'throughput', amount, costRatio: 0.75, months: 1 * TERM_SCALE },
      {
        ...opts,
        why: `Рекорд компании: лучший месяц — ${Math.round(best)} ед. Перевезите на треть больше, и чтобы расходы не съедали выручку.`,
        reward: { money: 150_000 },
      },
    );
  }
}

/**
 * Этап C «Освоение региона». К этому времени сеть растёт сама: обслуживаемые предприятия поднимают уровень,
 * авто-парк докупает машины, недавние линии разгоняются, — так что общий объём перевозок растёт и без игрока.
 * Поэтому главная цель — новое: маршруты, построенные на этом этапе, должны возить заметную долю лучшего
 * месяца компании. Цели — подключить к сети новые города и предприятия и снабжать крупнейший город сети.
 */
function phaseC(sc: Scenario): void {
  const game = sc.game;
  const diff = sc.difficulty;
  const info = network(game);
  const months = Math.round(PHASES[2].months * diff.time);
  const best = Math.max(50 * MONTH_SCALE, bestMonth(sc));
  const hard = sc.state.settings.difficulty;
  const share = hard === 'easy' ? 0.3 : hard === 'normal' ? 0.4 : 0.5;
  const amount = round10(best * share);
  sc.addObjective(
    { kind: 'newRoutes', amount, since: sc.moment, months: 1 * TERM_SCALE },
    {
      role: 'main',
      phase: 2,
      months,
      critical: diff.critical,
      why: `Нынешняя сеть растёт и без вас — этот этап про новое. Маршруты, построенные на этапе C, должны перевозить ${amount} ед. в месяц (лучший месяц компании — ${Math.round(
        best,
      )}). На карте ещё много городов и предприятий без транспорта.`,
      reward: { money: 250_000, reputation: 0 },
    },
  );
  // Подключить то, до чего сеть ещё не дотянулась: в сети считаются те, что в ней сейчас.
  connectObjective(sc, 'town', hard === 'easy' ? 1 : hard === 'normal' ? 2 : 3, { phase: 2, months, money: 100_000 });
  // «Строит игрок»: предприятий на карте мало — подключать нечего; вместо этого — построить новые.
  if (game.enterprises.on) buildObjective(sc, hard === 'easy' ? 1 : hard === 'normal' ? 2 : 3, { phase: 2, months, money: 100_000 });
  else connectObjective(sc, 'industry', hard === 'easy' ? 2 : hard === 'normal' ? 3 : 4, { phase: 2, months, money: 100_000 });
  // Снабжать один из крупных городов сети — тот, где проще закрыть нужную часть потребностей.
  const served = game.towns.filter((t) => info.towns.has(t.id)).sort((a, b) => b.population - a.population);
  supplyObjective(sc, served.length ? served.slice(0, 3) : bigTowns(game).slice(0, 2), { phase: 2, months, inRow: 2 * TERM_SCALE, money: 100_000 });
}

/** Какую часть потребностей города просить закрыть: доля по сложности, не меньше одной. */
const SUPPLY_SHARE: Record<string, number> = { easy: 0.5, normal: 0.6, hard: 0.75 };

export function supplyNeedsFor(total: number, difficulty: string): number {
  return Math.max(1, Math.min(total, Math.ceil(total * (SUPPLY_SHARE[difficulty] ?? 0.6))));
}

/**
 * Цель «снабжать город»: закрыть не все потребности, а часть (3 из 5 на обычной сложности) — все сразу за этап
 * не успеть, если для товаров и топлива нужны длинные цепочки через всю карту. Город — из кандидатов тот, где
 * самые лёгкие потребности требуют меньше всего перевозок (supplyEffort); при равном труде — крупнее.
 * needs = null — все потребности (дополнительное задание после победы).
 */
function supplyObjective(
  sc: Scenario,
  candidates: Town[],
  o: { role?: ObjectiveRole; phase: number | null; months: number | null; inRow: number; money: number; growth?: boolean; needs?: 'all' },
): Objective | null {
  const game = sc.game;
  const has = (ref: Ref, cargo: CargoType) => (sc.state.stats.to[receiverKey(ref, cargo)] ?? 0) > 0;
  const options = candidates
    .filter((t) => t.demands.length)
    .map((t) => {
      const needs = o.needs === 'all' ? t.demands.length : supplyNeedsFor(t.demands.length, sc.state.settings.difficulty);
      const ranked = t.demands.map((c) => ({ c, e: supplyEffort(game, c, t, has) })).sort((a, b) => a.e - b.e);
      const easiest = ranked.slice(0, needs);
      return { t, needs, easiest, effort: easiest.reduce((s, x) => s + x.e, 0) };
    })
    .filter((x) => Number.isFinite(x.effort))
    .sort((a, b) => a.effort - b.effort || b.t.population - a.t.population);
  const pick = options[0];
  if (!pick) return null;
  const { t, needs, easiest } = pick;
  const all = needs >= t.demands.length;
  const list = (cs: CargoType[]) => cs.map((c) => CARGO[c].name.toLowerCase()).join(', ');
  // Норма — по нынешнему населению; город растёт, и она растёт вместе с ним.
  const per = `по ${townNeed(t.population)} ед. в месяц (с ростом города — больше)`;
  const why = all
    ? `${t.name} ждёт всё, что ему нужно: ${list(t.demands)} — ${per}.`
    : `${t.name} нужны ${list(t.demands)}. Закройте любые ${needs} — ${per}; проще всего: ${list(easiest.map((x) => x.c))}.`;
  return sc.tryObjective(
    { kind: 'supply', town: t.id, months: o.inRow, needs },
    {
      role: o.role ?? 'goal',
      phase: o.phase,
      months: o.months,
      why: `${why}${o.growth ? ' Снабжённый город растёт быстрее.' : ''}`,
      reward: { money: o.money, effects: o.growth ? [{ kind: 'growth', target: t.id, factor: 1.5, months: 8 * TERM_SCALE }] : undefined },
      related: [refOf(t)],
    },
  );
}

// ---------- «Строит игрок»: задания построить ----------

/** Работающие и строящиеся предприятия сейчас — задание «построить» их не засчитывает. */
const liveIds = (game: Game): number[] => live(game).map((i) => i.id);

/**
 * Что построить первым (этап A): завод для добычи, которой некуда сбыть сырьё (на одно сырьё, невредный — раньше),
 * а нет такой — добычу на месторождении для завода, которому сырья никто не добывает.
 */
export function buildTarget(game: Game): { kind: IndustryType; why: string; related: Ref[] } | null {
  const all = live(game);
  const kinds = game.enterprises.kinds();
  for (const raw of all.filter((i) => isRaw(i.info))) {
    const c = raw.info.produces;
    if (all.some((i) => i.info.accepts.includes(c))) continue;
    const plant = kinds
      .filter((k) => k.accepts.includes(c) && k.accepts.every((x) => producible(game, x)) && receivers(game, k.produces).length)
      .sort((a, b) => a.accepts.length - b.accepts.length || harmClass(a.kind) - harmClass(b.kind))[0];
    if (plant)
      return {
        kind: plant,
        why: `${raw.name} добывает «${CARGO[c].name}», а перерабатывать негде. Постройте ${plant.name.toLowerCase()} — у города, чтобы хватило рабочих${
          harmClass(plant.kind) ? ', но не вплотную к домам: он вредный' : ''
        }.`,
        related: [refOf(raw)],
      };
  }
  for (const plant of all.filter((i) => !isRaw(i.info))) {
    for (const c of plant.info.accepts) {
      if (all.some((i) => i.info.produces === c)) continue;
      const raw = kinds.find((k) => isRaw(k) && k.produces === c && freeDeposits(game.enterprises.deposits, k.kind).length);
      if (raw)
        return {
          kind: raw,
          why: `${plant.name} ждёт «${CARGO[c].name}», а его никто не добывает. Месторождения отмечены значком ⛏️ — постройте добычу на ближайшем.`,
          related: [refOf(plant)],
        };
    }
  }
  return null;
}

/**
 * Этап B: новая цепочка со своим заводом — вид, которого на карте нет, чью продукцию ждут и чьё сырьё можно
 * получить (по seed — из трёх самых простых). Цель — построить и выпустить.
 */
function buildChain(sc: Scenario, months: number): { params: ObjectiveParams; why: string; related: Ref[]; value: number } | null {
  const game = sc.game;
  const have = new Set(live(game).map((i) => i.info.kind));
  const options = game.enterprises
    .kinds()
    .filter((k) => !isRaw(k) && !have.has(k.kind) && receivers(game, k.produces).length && k.accepts.every((c) => producible(game, c)))
    .map((k) => ({ k, effort: k.accepts.reduce((s, c) => s + (live(game).some((i) => i.info.produces === c) ? 1 : buildEffort(game, c)), 0) + harmClass(k.kind) * 0.2 }))
    .sort((a, b) => a.effort - b.effort)
    .slice(0, 3);
  if (!options.length) return null;
  const { k } = sc.rng.pick(options);
  const work = months - RAMP - TERM_SCALE - (game.buildMode ? 2 * TERM_SCALE : 0);
  const amount = round10(Math.max(30, ECONOMY.processRate * 0.5 * Math.max(1, work) * 0.35 * sc.difficulty.demand));
  const to = receivers(game, k.produces)[0];
  const inputs = k.accepts.map((c) => CARGO[c].name.toLowerCase()).join(' и ');
  return {
    params: { kind: 'build', count: 1, what: k.kind, cargo: k.produces, produce: amount, known: liveIds(game) },
    why: `Новая цепочка: постройте ${k.name.toLowerCase()} (${inputs} → «${CARGO[k.produces].name}») и наладьте её — сырьё на завод, продукцию${
      to ? ` — например, ${to.name}` : ' получателям'
    }. Ставьте у города: рабочие придут сами.`,
    related: to ? [refOf(to)] : [],
    value: amount * CARGO[k.produces].rate * 25 + buildCost(k) * 0.5,
  };
}

/** Построить count новых предприятий (этап C, после победы): любых — добычу на месторождениях или заводы. */
function buildObjective(sc: Scenario, count: number, o: { role?: ObjectiveRole; phase: number | null; months: number | null; money: number }): Objective | null {
  return sc.tryObjective(
    { kind: 'build', count, known: liveIds(sc.game) },
    {
      role: o.role ?? 'goal',
      phase: o.phase,
      months: o.months,
      why: 'Региону нужны новые производства: добыча на свободных месторождениях ⛏️ и заводы у городов — где хватит рабочих и дым не помешает жителям.',
      reward: { money: o.money },
    },
  );
}

/** Груз, которого не хватает городу, и который можно получить на карте — для событий «новая потребность». */
export function missingDemand(game: Game, town: Town): CargoType | null {
  return TOWN_CARGO.find((c) => !town.demands.includes(c) && producible(game, c)) ?? null;
}

/** Заводы, которым это сырьё. */
export const plantsFor = (game: Game, cargo: CargoType) => game.industries.filter((i) => i.info.accepts.includes(cargo));

