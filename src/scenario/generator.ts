/**
 * Генератор сценария: архетип по seed (до генерации карты) и проверка по готовой карте, стартовые условия
 * и задания этапов. Задания следующего этапа создаются только при переходе к нему — по тому, что игрок
 * построил, что выросло и что просело. Требования — от оценки выполнимого: производства, вместимости
 * разумного парка и денег, а не от богатства игрока.
 */
import { ECONOMY, MONTH_LENGTH } from '../config';
import { Rng } from '../core/rng';
import { dist } from '../core/vec';
import type { Game } from '../game/game';
import { MODELS } from '../game/transport';
import { CARGO, CargoType, TOWN_CARGO } from '../world/cargo';
import { TOWN_NEED } from '../world/entities';
import type { Industry, Town } from '../world/entities';
import type { WorldSettings } from '../world/settings';
import {
  bigTowns,
  cargoPotential,
  distToNetwork,
  hasMarket,
  km,
  levelCap,
  network,
  operating,
  paxPerMonth,
  producible,
  RAMP,
  rawOutput,
  rawSupplies,
  receivers,
  refOf,
  region,
  RegionInfo,
  routeCost,
  Supply,
  townPairs,
} from './analysis';
import { ARCHETYPE_LIST, ARCHETYPES, BASE_TOWNS, PHASES } from './content';
import type { Scenario } from './manager';
import { mixSeed } from './manager';
import { moneyText } from './objectives';
import type { ArchetypeId, ObjectiveParams } from './types';

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
  const options = rawSupplies(game).filter((s) => s.d >= 450 && s.d <= 4500 && hasMarket(game, s.to) && producible(game, s.to.info.produces));
  // Заводы на один вид сырья — первыми: там поставки сразу превращаются в продукцию.
  const single = options.filter((s) => s.to.info.accepts.length === 1);
  const pool = (single.length >= 2 ? single : options).slice(0, 3);
  if (!pool.length) return null;
  const supply = sc.rng.pick(pool);
  const work = Math.max(1, months - RAMP);
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
  const pairs = townPairs(game)
    .filter((p) => p.d >= 900 && p.d <= 6000 && !(skip?.has(p.a.id) && skip?.has(p.b.id)))
    .map((p) => ({ ...p, value: paxPerMonth(p.a, p.b) / (p.d + 1500) }))
    .sort((x, y) => y.value - x.value)
    .slice(0, 3);
  if (!pairs.length) return null;
  const p = sc.rng.pick(pairs);
  const work = Math.max(1, months - RAMP);
  const fleet = Math.max(2, START_FLEET[sc.state.settings.difficulty] - 2);
  const perMonth = perVehicleMonth(p.d, MODELS.bus.capacity, true);
  const can = Math.min(fleet * perMonth, paxPerMonth(p.a, p.b)) * work;
  const income = Math.min(fleet * perMonth, paxPerMonth(p.a, p.b)) * CARGO.passengers.rate * 2 * (p.d / 100);
  return { a: p.a, b: p.b, d: p.d, amount: round10(can * diff.demand), fleet, cost: routeCost(p.d, fleet, 'bus'), net: income - fleet * MODELS.bus.running };
}

/** Брифинг: регион, капитал, кредит, предел кредита и главное о карте. */
function describeRegion(sc: Scenario, r: RegionInfo): string[] {
  const game = sc.game;
  const facts = [
    `${r.towns} городов, ${r.population.toLocaleString('ru-RU')} жителей; крупных — ${r.bigTowns}`,
    `${game.industries.length} предприятий, цепочек с близким сырьём — ${r.compactChains}`,
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
    months: Math.round(PHASES.reduce((sum, p) => sum + p.months, 0) * diff.time),
    facts: describeRegion(sc, r),
  };
  // Кредит уже в капитале: часть стартовых денег заёмная, проценты — с первого месяца.
  if (loan > 0)
    s.brief.facts.unshift(`Из капитала ${moneyText(loan)} — заёмные: ${Math.round(ECONOMY.loanRate * 100)}% в месяц, гасить можно в «Финансах»`);
  phaseA(sc, months, paxMain, freight, pax);
  // Стартовый контракт: груз городу, которому он нужен, если его можно получить на карте.
  startContract(sc);
  sc.log('phase', `Этап A: ${PHASES[0].name}`);
}

function phaseA(sc: Scenario, months: number, paxMain: boolean, freight: FreightPlan | null, pax: PaxPlan | null): void {
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
      { role: 'main', phase: 0, months, critical, why: 'Первые пассажирские линии компании.', reward: { money: 60_000, reputation: 0 } },
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
        why: `Соединить ${pax.a.name} и ${pax.b.name} (${km(pax.d)}) автобусами.`,
        reward: { money: roundMoney(pax.cost * 0.3) },
        related: [refOf(pax.a), refOf(pax.b)],
      },
    );
  }
  // Прибыль: половина того, что даст главная линия, когда разгонится.
  const net = Math.max(freight?.net ?? 0, pax?.net ?? 0);
  const amount = Math.max(3000, roundMoney(net * 0.6 * (diff.demand / 0.65), 1000));
  sc.addObjective(
    { kind: 'profit', amount, months: sc.state.settings.difficulty === 'hard' ? 2 : 1 },
    {
      role: 'goal',
      phase: 0,
      months,
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
  const months = Math.round(16 * sc.difficulty.time);
  const amount = round10(Math.max(TOWN_NEED * 3, Math.min(cargoPotential(game, o.cargo, o.town.center, months) * 0.25, 160) * sc.difficulty.demand));
  sc.tryObjective(
    { kind: 'deliver', cargo: o.cargo, amount, to: refOf(o.town) },
    {
      role: 'contract',
      phase: null,
      months,
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

/** Лучший месяц перевозок за последние полгода (объём груза и пассажиров). */
function bestMonth(sc: Scenario): number {
  const recent = sc.state.stats.months.slice(-6);
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
  type Option = { kind: 'industry' | 'chain' | 'pax'; params: ObjectiveParams; why: string; related: ReturnType<typeof refOf>[]; value: number };
  const options: Option[] = [];
  // Завод, которому игрок уже возит сырьё, — вырастить.
  const plant = game.industries
    .filter((i) => i.info.accepts.length && i.info.accepts.some((c) => (s.stats.to[`industry:${i.id}:${c}`] ?? 0) > 0) && levelCap(i) - (i.level ?? 1) >= 0.75)
    .sort((a, b) => (b.level ?? 1) - (a.level ?? 1))[0];
  if (plant) {
    const level = Math.min(levelCap(plant), Math.round(((plant.level ?? 1) + (s.settings.difficulty === 'easy' ? 0.75 : 1)) * 4) / 4);
    options.push({
      kind: 'industry',
      params: { kind: 'industry', industry: plant.id, level },
      why: `${plant.name} уже получает сырьё. Чтобы он вырос, продукцию нужно исправно вывозить, а сырья — возить больше.`,
      related: [refOf(plant)],
      value: level * 40_000,
    });
  }
  const chain = newChain(sc, months, info);
  if (chain) options.push({ kind: 'chain', ...chain });
  // Пассажиропоток: нынешний темп с ростом и новый город рядом с сетью.
  const paxRate = s.stats.months.slice(-3).reduce((sum, m) => sum + (m.pax ?? 0), 0) / 3;
  const pairs = townPairs(game).filter((p) => !(info.towns.has(p.a.id) && info.towns.has(p.b.id)) && p.d <= 6000);
  const extra = pairs.length ? paxPerMonth(pairs[0].a, pairs[0].b) * 0.5 : 0;
  const paxAmount = round10(Math.max(150, paxRate * 1.3 + extra) * work * diff.demand);
  options.push({
    kind: 'pax',
    params: { kind: 'passengers', amount: paxAmount, towns: null },
    why: 'Пассажирские линии — то, что сейчас нужнее всего региону. Новые города в сети и частые рейсы.',
    related: [],
    value: paxAmount * 50,
  });
  // Стратегия игрока: возил в основном пассажиров — главная цель тоже пассажирская.
  const paxFirst = info.pax > info.freight * 1.5;
  const order: Option['kind'][] = paxFirst ? ['pax', 'industry', 'chain'] : ['industry', 'chain', 'pax'];
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
      { kind: 'profit', amount: 15_000, months: 2 },
      { role: 'main', phase: 1, months, critical: diff.critical, why: 'Компания должна стабильно зарабатывать.', reward: { money: 80_000, reputation: 0 } },
    );
  }
  // Цель: снабжать город, рядом с которым уже работает сеть и всё нужное можно получить.
  const town = game.towns
    .filter((t) => t.demands.every((c) => producible(game, c)))
    .map((t) => ({ t, d: distToNetwork(info, t.center), served: info.towns.has(t.id) }))
    .sort((a, b) => Number(b.served) - Number(a.served) || a.d - b.d || b.t.population - a.t.population)[0]?.t;
  if (town) {
    sc.tryObjective(
      { kind: 'supply', town: town.id, months: 2 },
      {
        role: 'goal',
        phase: 1,
        months,
        why: `${town.name} растёт, когда все его потребности закрыты: ${town.demands.map((c) => CARGO[c].name.toLowerCase()).join(', ')} — по ${TOWN_NEED} ед. в месяц.`,
        reward: { money: 60_000, effects: [{ kind: 'growth', target: town.id, factor: 1.5, months: 8 }] },
        related: [refOf(town)],
      },
    );
  }
  // Вторая цель — другой вид перевозок.
  if (mainKind === 'pax' && chain) {
    sc.tryObjective(chain.params, { role: 'goal', phase: 1, months, why: chain.why, reward: { money: roundMoney(chain.value * 0.6) }, related: chain.related });
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
          reward: { money: roundMoney(p.cost * 0.5), effects: [{ kind: 'growth', target: p.a.id, factor: 1.3, months: 6 }] },
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
  const amount = round10(Math.max(40, Math.min(potential * 0.35, 120 * (months - RAMP - 1) * 0.35)) * diff.demand);
  const to = receivers(game, product).sort((a, b) => dist('info' in a ? a.fp.center : a.center, plant.fp.center) - dist('info' in b ? b.fp.center : b.center, plant.fp.center))[0];
  const inputs = plant.info.accepts.map((c) => CARGO[c].name.toLowerCase()).join(' и ');
  return {
    params: { kind: 'deliver', cargo: product, amount, to: null },
    why: `Новая цепочка: ${inputs} → ${plant.name} → «${CARGO[product].name}»${to ? ` (ближайший получатель — ${to.name})` : ''}. Нужно и привезти сырьё, и вывезти продукцию.`,
    related: [refOf(plant), ...(to ? [refOf(to)] : [])],
    value: amount * CARGO[product].rate * 25,
  };
}

/**
 * Этап C «Эффективность»: перевозить заметно больше, чем в лучший месяц этапа B, без пропорционального
 * роста расходов; держать скорость доставки; снабжать крупнейший обслуживаемый город; вырастить город.
 */
function phaseC(sc: Scenario): void {
  const game = sc.game;
  const diff = sc.difficulty;
  const info = network(game);
  const months = Math.round(PHASES[2].months * diff.time);
  const best = Math.max(150, bestMonth(sc));
  const hard = sc.state.settings.difficulty;
  const k = hard === 'easy' ? 1.4 : hard === 'normal' ? 1.6 : 1.8;
  const ratio = hard === 'easy' ? 0.8 : hard === 'normal' ? 0.72 : 0.65;
  const last = game.history[game.history.length - 1];
  const nowRatio = last ? operating(last) : null;
  sc.addObjective(
    { kind: 'throughput', amount: round10(best * k), costRatio: ratio, months: 3 },
    {
      role: 'main',
      phase: 2,
      months,
      critical: diff.critical,
      why: `Лучший месяц компании — ${Math.round(best)} ед. Нужно возить в ${k} раза больше, а расходы держать не выше ${Math.round(ratio * 100)}% выручки${
        nowRatio && nowRatio.income > 0 ? ` (сейчас ${Math.round((nowRatio.costs / nowRatio.income) * 100)}%)` : ''
      }: вместительный транспорт, полные рейсы, короткие пути.`,
      reward: { money: 250_000, reputation: 0 },
    },
  );
  sc.tryObjective(
    { kind: 'quality', speed: hard === 'easy' ? 1.1 : hard === 'normal' ? 1.15 : 1.2, volume: round10(best * 0.6), months: 2 },
    {
      role: 'goal',
      phase: 2,
      months,
      why: 'Быстрая доставка оплачивается дороже: магистрали, поезда, развязки без пробок и меньше простоя на станциях.',
      reward: { money: 120_000 },
    },
  );
  const served = game.towns.filter((t) => info.towns.has(t.id) && t.demands.every((c) => producible(game, c))).sort((a, b) => b.population - a.population);
  const supplyTown = served[0] ?? bigTowns(game)[0];
  if (supplyTown) {
    sc.tryObjective(
      { kind: 'supply', town: supplyTown.id, months: 3 },
      {
        role: 'goal',
        phase: 2,
        months,
        why: `${supplyTown.name} — крупнейший город вашей сети. Ему нужно стабильное снабжение несколько месяцев подряд.`,
        reward: { money: 100_000 },
        related: [refOf(supplyTown)],
      },
    );
  }
  const growTown = served.find((t) => t !== supplyTown) ?? supplyTown;
  if (growTown) {
    const amount = Math.round((growTown.population * (hard === 'easy' ? 1.15 : hard === 'normal' ? 1.2 : 1.25)) / 100) * 100;
    sc.tryObjective(
      { kind: 'population', town: growTown.id, amount },
      {
        role: 'goal',
        phase: 2,
        months,
        why: `Город растёт от снабжения и удобного транспорта. Сейчас в нём ${growTown.population.toLocaleString('ru-RU')} жителей.`,
        reward: { money: 80_000 },
        related: [refOf(growTown)],
      },
    );
  }
}

/** Груз, которого не хватает городу, и который можно получить на карте — для событий «новая потребность». */
export function missingDemand(game: Game, town: Town): CargoType | null {
  return TOWN_CARGO.find((c) => !town.demands.includes(c) && producible(game, c)) ?? null;
}

/** Заводы, которым это сырьё. */
export const plantsFor = (game: Game, cargo: CargoType) => game.industries.filter((i) => i.info.accepts.includes(cargo));

