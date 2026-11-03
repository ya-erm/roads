/**
 * Экономические события. У каждого — причина в состоянии мира (кандидаты отбираются по нему),
 * последствия через существующую экономику (уровень и предел предприятия, потребности городов) и временные
 * эффекты, а часто — контракт и продолжение цепочки. Частота: пауза после крупных событий, не больше
 * одного мелкого в месяц, предел активных, память «то же событие — не с тем же городом или предприятием».
 */
import { ECONOMY } from '../config';
import { dist } from '../core/vec';
import type { Game } from '../game/game';
import { CARGO, CargoType, TOWN_CARGO } from '../world/cargo';
import type { Industry, Town } from '../world/entities';
import { TOWN_NEED } from '../world/entities';
import {
  cargoPotential,
  distToNetwork,
  hasMarket,
  industryById,
  km,
  levelCap,
  network,
  NetworkInfo,
  paxPerMonth,
  producible,
  RAMP,
  refOf,
  townById,
} from './analysis';
import { ARCHETYPES, EVENT_INFO, EVENT_RULES } from './content';
import { effectText } from './effects';
import { assess } from './feasibility';
import { missingDemand, pickWeighted } from './generator';
import type { Scenario } from './manager';
import type { EffectSpec, EventRecord, EventType, FollowUp, ObjectiveParams, Ref } from './types';

interface Ctx {
  sc: Scenario;
  game: Game;
  info: NetworkInfo;
  month: number;
}

interface Candidate {
  subject: Ref | null;
  weight: number;
  cargo?: CargoType;
}

interface Template {
  type: EventType;
  /** Где в мире сейчас есть причина для события. */
  candidates(ctx: Ctx): Candidate[];
  /** Случиться с этим предметом (null — уже неправдоподобно: условия ушли). parent — событие-причина цепочки. */
  fire(ctx: Ctx, c: Candidate, parent?: EventRecord): EventRecord | null;
}

const round10 = (n: number) => Math.max(10, Math.round(n / 10) * 10);
const roundMoney = (n: number) => Math.max(5000, Math.round(n / 5000) * 5000);
const subjectKey = (type: EventType, c: Candidate) => `${type}:${c.subject ? `${c.subject.type}:${c.subject.id}` : (c.cargo ?? '-')}`;

/** Ближайший город к точке. */
function nearestTown(game: Game, p: { x: number; y: number }, maxD = 7000): Town | undefined {
  return [...game.towns].filter((t) => dist(t.center, p) <= maxD).sort((a, b) => dist(a.center, p) - dist(b.center, p))[0];
}

/** Уже идёт контракт или предложение по этому предприятию или городу — второе не нужно. */
function busy(sc: Scenario, ref: Ref): boolean {
  return sc.state.objectives.some(
    (o) => (o.status === 'active' || o.status === 'offered') && o.role === 'contract' && o.related.some((r) => r.type === ref.type && r.id === ref.id),
  );
}

/** Сырьё, которого заводу не хватает сильнее всего. */
function scarcest(ind: Industry): CargoType {
  return [...ind.info.accepts].sort((a, b) => (ind.stock[a] ?? 0) - (ind.stock[b] ?? 0))[0];
}

/** Ориентир цены контракта: столько бы заплатили за перевозку на 2.5 км, с поправкой на репутацию. */
const contractMoney = (ctx: Ctx, cargo: CargoType, amount: number, k: number) =>
  roundMoney(amount * CARGO[cargo].rate * ECONOMY.tariff * 25 * k * ctx.sc.rewardFactor);

function effectLines(game: Game, specs: EffectSpec[]): string[] {
  return specs.map((e) => {
    const name = e.kind === 'price' ? `«${CARGO[e.target as CargoType].name}»` : e.kind === 'industry' ? (industryById(game, e.target as number)?.name ?? '—') : (townById(game, e.target as number)?.name ?? '—');
    return effectText(e.kind, e.factor, e.months, name);
  });
}

// ---------- Шаблоны ----------

/**
 * Дефицит сырья: завод рядом с сетью игрока несколько месяцев работает меньше чем вполсилы. Предлагает
 * контракт на поставки. Выполнили — завод расширяется (цепочка дальше); отказались или сорвали — спад.
 */
const shortage: Template = {
  type: 'shortage',
  candidates: ({ game, sc, info }) =>
    game.industries
      .filter((i) => i.info.accepts.length && (sc.state.watch[i.id]?.low ?? 0) >= 2 && hasMarket(game, i) && i.info.accepts.every((c) => producible(game, c)))
      .filter((i) => !busy(sc, refOf(i)))
      .map((i) => ({ i, d: distToNetwork(info, i.fp.center) }))
      .filter(({ i, d }) => info.industries.has(i.id) || d <= 4000)
      // Завод, который уже работал на сырье игрока, — главный кандидат; стоящий рядом с сетью — реже.
      .map(({ i }) => ({ subject: refOf(i), weight: sc.state.watch[i.id]?.active ? 4 : info.industries.has(i.id) ? 2 : 0.5 })),
  fire(ctx, c, parent) {
    const { game, sc } = ctx;
    const ind = industryById(game, c.subject!.id);
    if (!ind || !ind.info.accepts.length) return null;
    const cargo = scarcest(ind);
    const months = Math.round(7 * sc.difficulty.time);
    const potential = cargoPotential(game, cargo, ind.fp.center, months);
    if (potential < 60) return null;
    const amount = round10(Math.min(600, potential * 0.4 * sc.difficulty.demand));
    if (!assess(game, { kind: 'deliver', cargo, amount, to: refOf(ind) }, months).ok) return null;
    const rate = game.industryRate(ind);
    const worked = sc.state.watch[ind.id]?.active;
    const cause = parent
      ? `Цепочка продолжается: ${ind.name} не успевает за спросом — сырья нужно больше.`
      : worked
        ? `${ind.name} в прошлом месяце выпустил ${ind.producedLast} из возможных ${rate}: не хватает «${CARGO[cargo].name}».`
        : `${ind.name} стоит без сырья: заказчики ждут «${CARGO[ind.info.produces].name}», а «${CARGO[cargo].name}» никто не везёт.`;
    const rec = sc.addEvent(
      {
        type: 'shortage',
        importance: 'major',
        title: `${EVENT_INFO.shortage.icon} Дефицит сырья`,
        cause,
        effects: [`Завод предлагает контракт: ${amount} ед. «${CARGO[cargo].name}» за ${months} мес.`, 'Выполните — завод расширится; откажетесь — сократит выпуск'],
        related: [refOf(ind)],
        until: sc.month + 1 + EVENT_RULES.offer + months,
        parent: parent?.id,
      },
      subjectKey('shortage', c),
    );
    const o = sc.addObjective(
      { kind: 'deliver', cargo, amount, to: refOf(ind) },
      {
        role: 'contract',
        phase: null,
        months,
        offer: true,
        source: rec.id,
        why: cause,
        reward: {
          money: contractMoney(ctx, cargo, amount, 0.6),
          reputation: 4,
          follow: [{ event: 'expansion', subject: refOf(ind), delay: 0 }],
        },
        fail: { reputation: -8, follow: [{ event: 'decline', subject: refOf(ind), delay: 0 }] },
        related: [refOf(ind)],
        points: 50,
      },
    );
    rec.contract = o.id;
    return rec;
  },
};

/**
 * Рост промышленности: предприятие долго работает с полной загрузкой (продукцию исправно вывозят) или выполнен
 * контракт на его снабжение. Предел роста поднимается, производство растёт, ближайший город получает рабочие
 * места; заводу нужно больше сырья — следом крупный заказ, а город — к развитию.
 */
const expansion: Template = {
  type: 'expansion',
  candidates: ({ game }) =>
    game.industries
      .filter((i) => (i.level ?? 1) >= levelCap(i) - 0.5 && (i.streak ?? 0) >= 1 && levelCap(i) < 6 && i.producedLast > 0)
      .map((i) => ({ subject: refOf(i), weight: 1 })),
  fire(ctx, c, parent) {
    const { game, sc } = ctx;
    const ind = industryById(game, c.subject!.id);
    if (!ind || levelCap(ind) >= 6) return null;
    const cap = levelCap(ind) + 1;
    const town = nearestTown(game, ind.fp.center);
    const effects: EffectSpec[] = [{ kind: 'industry', target: ind.id, factor: 1.2, months: 6 }];
    if (town) effects.push({ kind: 'growth', target: town.id, factor: 1.4, months: 6 });
    const cause = parent
      ? `Контракт выполнен: ${ind.name} получил сырьё и расширяет производство.`
      : `${ind.name} работает на пределе: продукцию исправно вывозят, владельцы строят новый цех.`;
    const follow: FollowUp[] = [];
    if (ind.info.accepts.length) follow.push({ event: 'order', subject: refOf(ind), delay: 1, cargo: scarcest(ind) });
    else follow.push({ event: 'order', subject: refOf(ind), delay: 2 });
    if (town) follow.push({ event: 'boom', subject: refOf(town), delay: 3 });
    const rec = sc.addEvent(
      {
        type: 'expansion',
        importance: 'major',
        title: `${EVENT_INFO.expansion.icon} Рост промышленности`,
        cause,
        effects: [`${ind.name}: предел роста ×${cap}, уровень +0.5`, ...effectLines(game, effects), ind.info.accepts.length ? 'Заводу понадобится больше сырья' : 'Продукции станет больше — её нужно вывозить'],
        related: [refOf(ind), ...(town ? [refOf(town)] : [])],
        until: sc.month + 1 + 6,
        parent: parent?.id,
      },
      subjectKey('expansion', c),
    );
    sc.apply({ level: { industry: ind.id, by: 0.5 }, effects, follow }, rec.id);
    ind.cap = Math.max(ind.cap ?? 0, cap);
    return rec;
  },
};

/**
 * Промышленный спад: завод, который работал, давно стоит без сырья (или сорван контракт на его снабжение).
 * Выпуск падает, город рядом теряет рабочие места; завод предлагает контракт на восстановление поставок.
 */
const decline: Template = {
  type: 'decline',
  candidates: ({ game, sc }) =>
    game.industries
      .filter((i) => i.info.accepts.length && sc.state.watch[i.id]?.active && (sc.state.watch[i.id]?.idle ?? 0) >= 3 && (i.level ?? 1) > 1)
      .map((i) => ({ subject: refOf(i), weight: 1 })),
  fire(ctx, c, parent) {
    const { game, sc } = ctx;
    const ind = industryById(game, c.subject!.id);
    // Сокращать нечего: завод ни разу не работал и не рос.
    if (!ind || (!sc.state.watch[ind.id]?.active && (ind.level ?? 1) <= 1)) return null;
    const town = nearestTown(game, ind.fp.center);
    const effects: EffectSpec[] = [{ kind: 'industry', target: ind.id, factor: 0.6, months: 6 }];
    if (town) effects.push({ kind: 'growth', target: town.id, factor: 0.75, months: 6 });
    const cause = parent
      ? `Поставки так и не наладили — ${ind.name} сокращает выпуск.`
      : `${ind.name} уже ${sc.state.watch[ind.id]?.idle ?? 3} мес. стоит без сырья и сокращает выпуск.`;
    const rec = sc.addEvent(
      {
        type: 'decline',
        importance: 'major',
        title: `${EVENT_INFO.decline.icon} Промышленный спад`,
        cause,
        effects: [`${ind.name}: уровень −0.5`, ...effectLines(game, effects)],
        related: [refOf(ind), ...(town ? [refOf(town)] : [])],
        until: sc.month + 1 + 6,
        parent: parent?.id,
      },
      subjectKey('decline', c),
    );
    sc.apply({ effects }, rec.id);
    ind.level = Math.max(1, (ind.level ?? 1) - 0.5);
    // Восстановить поставки: тот же завод, его самое редкое сырьё — спад прекращается.
    if (ind.info.accepts.length) {
      const cargo = scarcest(ind);
      const months = Math.round(6 * sc.difficulty.time);
      const potential = cargoPotential(game, cargo, ind.fp.center, months);
      if (potential >= 50 && !busy(sc, refOf(ind))) {
        const amount = round10(Math.min(400, potential * 0.3 * sc.difficulty.demand));
        const o = sc.tryObjective(
          { kind: 'deliver', cargo, amount, to: refOf(ind) },
          {
            role: 'contract',
            phase: null,
            months,
            offer: true,
            source: rec.id,
            why: `Восстановить поставки «${CARGO[cargo].name}» — спад прекратится, уровень вернётся.`,
            reward: { money: contractMoney(ctx, cargo, amount, 0.4), reputation: 5, clear: rec.id, level: { industry: ind.id, by: 0.5 } },
            fail: { reputation: -4 },
            related: [refOf(ind)],
            points: 40,
          },
        );
        if (o) rec.contract = o.id;
      }
    }
    return rec;
  },
};

/**
 * Развитие города: все (или почти все) потребности закрыты два месяца подряд и есть пассажирский транспорт —
 * или рядом расширился завод. Город растёт быстрее, жители ездят больше, появляется новая потребность и
 * контракт на пассажирское сообщение с соседом.
 */
const boom: Template = {
  type: 'boom',
  candidates: ({ game, info }) =>
    game.towns
      .filter((t) => info.towns.has(t.id) && (t.supplyHistory ?? []).length >= 2)
      .filter((t) =>
        (t.supplyHistory ?? []).slice(-2).every((m) => {
          const ok = t.demands.filter((c) => (m.got[c] ?? 0) >= m.need).length;
          return t.demands.length > 0 && ok / t.demands.length >= 0.66;
        }),
      )
      .map((t) => ({ subject: refOf(t), weight: 1 + t.population / 5000 })),
  fire(ctx, c, parent) {
    const { game, sc, info } = ctx;
    const town = townById(game, c.subject!.id);
    if (!town || town.population <= 0) return null;
    const effects: EffectSpec[] = [
      { kind: 'growth', target: town.id, factor: 1.8, months: 8 },
      { kind: 'pax', target: town.id, factor: 1.3, months: 8 },
    ];
    const cause = parent
      ? `Рядом открылись новые рабочие места — в ${town.name} едут жить и работать.`
      : `${town.name}: удобный транспорт и полные магазины — город привлекает новых жителей.`;
    const lines = effectLines(game, effects);
    const need = town.demands.length < TOWN_CARGO.length ? missingDemand(game, town) : null;
    if (need) lines.push(`Новая потребность: «${CARGO[need].name}» (${TOWN_NEED} ед. в месяц)`);
    const partner = [...game.towns]
      .filter((t) => t !== town && dist(t.center, town.center) <= 6500)
      .sort((a, b) => Number(info.towns.has(b.id)) - Number(info.towns.has(a.id)) || dist(a.center, town.center) - dist(b.center, town.center))[0];
    const rec = sc.addEvent(
      {
        type: 'boom',
        importance: 'minor',
        title: `${EVENT_INFO.boom.icon} Развитие города`,
        cause,
        effects: lines,
        related: [refOf(town), ...(partner ? [refOf(partner)] : [])],
        until: sc.month + 1 + 8,
        parent: parent?.id,
      },
      subjectKey('boom', c),
    );
    sc.apply({ effects, follow: need ? [{ event: 'demand', subject: null, cargo: need, delay: 2 }] : [] }, rec.id);
    if (need) town.demands.push(need);
    if (partner && !busy(sc, refOf(town))) {
      const months = Math.round(8 * sc.difficulty.time);
      const amount = round10(Math.max(60, paxPerMonth(town, partner) * (months - RAMP) * 0.35 * sc.difficulty.demand));
      const o = sc.tryObjective(
        { kind: 'passengers', amount, towns: [town.id, partner.id] },
        {
          role: 'contract',
          phase: null,
          months,
          offer: true,
          source: rec.id,
          why: `Жителям растущего города ${town.name} нужно ездить в ${partner.name} (${km(dist(town.center, partner.center))}).`,
          reward: { money: roundMoney(amount * 120 * sc.rewardFactor), reputation: 4 },
          fail: { reputation: -5 },
          related: [refOf(town), refOf(partner)],
        },
      );
      if (o) rec.contract = o.id;
    }
    return rec;
  },
};

/**
 * Субсидия: крупный город без транспорта рядом с сетью игрока. Власти оплачивают пассажирское сообщение
 * с ближайшим подключённым городом — в разрозненных регионах чаще.
 */
const grant: Template = {
  type: 'grant',
  candidates: ({ game, info }) => {
    if (!info.towns.size) return [];
    return game.towns
      .filter((t) => !info.towns.has(t.id) && t.population >= 1200)
      .map((t) => ({ t, d: Math.min(...[...info.towns].map((id) => dist(townById(game, id)!.center, t.center))) }))
      .filter(({ d }) => d <= 7000)
      .map(({ t }) => ({ subject: refOf(t), weight: t.population / 2000 }));
  },
  fire(ctx, c, parent) {
    const { game, sc, info } = ctx;
    const town = townById(game, c.subject!.id);
    if (!town || info.towns.has(town.id)) return null;
    const partner = [...info.towns].map((id) => townById(game, id)!).sort((a, b) => dist(a.center, town.center) - dist(b.center, town.center))[0];
    if (!partner) return null;
    const d = dist(partner.center, town.center);
    const months = Math.round(10 * sc.difficulty.time);
    const amount = round10(Math.max(60, paxPerMonth(town, partner) * (months - RAMP) * 0.35 * sc.difficulty.demand));
    // Субсидия покрывает большую часть стройки: дорога, станции, автобусы.
    if (!assess(game, { kind: 'passengers', amount, towns: [town.id, partner.id] }, months).ok) return null;
    const money = roundMoney((d * 1.3 * 14 + 16_000 + 2 * 26_000) * 0.9);
    const cause = `${town.name} (${town.population.toLocaleString('ru-RU')} жит.) отрезан от транспортной сети. Власти региона оплатят сообщение с городом ${partner.name}.`;
    const rec = sc.addEvent(
      {
        type: 'grant',
        importance: 'major',
        title: `${EVENT_INFO.grant.icon} Субсидия на инфраструктуру`,
        cause,
        effects: [`Субсидия $${money.toLocaleString('ru-RU')} за ${amount} пассажиров за ${months} мес.`, `Расстояние ${km(d)}`],
        related: [refOf(town), refOf(partner)],
        until: sc.month + 1 + EVENT_RULES.offer + months,
        parent: parent?.id,
      },
      subjectKey('grant', c),
    );
    const o = sc.addObjective(
      { kind: 'passengers', amount, towns: [town.id, partner.id] },
      {
        role: 'contract',
        phase: null,
        months,
        offer: true,
        source: rec.id,
        why: cause,
        reward: { money, reputation: 6, follow: [{ event: 'boom', subject: refOf(town), delay: 2 }] },
        fail: { reputation: -6 },
        related: [refOf(town), refOf(partner)],
        points: 50,
      },
    );
    rec.contract = o.id;
    return rec;
  },
};

/**
 * Крупный заказ: обслуживаемое предприятие с выросшим производством получает временный контракт на большой
 * объём своей продукции — успеет ли игрок поднять пропускную способность. В цепочке после расширения завода —
 * заказ на его сырьё.
 */
const order: Template = {
  type: 'order',
  candidates: ({ game, info }) =>
    game.industries
      .filter((i) => info.industries.has(i.id) && (i.level ?? 1) >= 1.25 && i.producedLast > 0 && hasMarket(game, i))
      // Обслуживаемых предприятий много — заказов было бы слишком много: вес меньше, чем у других событий.
      .map((i) => ({ subject: refOf(i), weight: (i.level ?? 1) * 0.4 })),
  fire(ctx, c, parent) {
    const { game, sc } = ctx;
    const ind = industryById(game, c.subject!.id);
    if (!ind) return null;
    const months = Math.round(6 * sc.difficulty.time);
    // Заказ на сырьё для завода (после его расширения) или на продукцию предприятия.
    const cargo = c.cargo && ind.info.accepts.includes(c.cargo) ? c.cargo : ind.info.produces;
    const toPlant = cargo !== ind.info.produces;
    if (!toPlant && !hasMarket(game, ind)) return null;
    // Сырьё для завода — по тому, что регион может дать; продукция — на треть больше нынешнего выпуска:
    // заказ выполним, но транспорта нужно больше, чем сейчас.
    const amount = toPlant
      ? round10(Math.min(800, cargoPotential(game, cargo, ind.fp.center, months) * 0.45 * sc.difficulty.demand))
      : round10(Math.min(game.industryRate(ind), Math.max(ind.producedLast, 12) * 1.3) * (months - 2) * (sc.difficulty.demand / 0.65));
    if (amount < 40) return null;
    const params: ObjectiveParams = toPlant ? { kind: 'deliver', cargo, amount, to: refOf(ind) } : { kind: 'deliver', cargo, amount, to: null, from: ind.id };
    if (!assess(game, params, months).ok) return null;
    const cause = toPlant
      ? `${ind.name} расширился и закупает больше сырья: нужно ${amount} ед. «${CARGO[cargo].name}».`
      : `${ind.name}: на «${CARGO[cargo].name}» нашёлся крупный покупатель — ${amount} ед. за ${months} мес.`;
    const rec = sc.addEvent(
      {
        type: 'order',
        importance: 'minor',
        title: `${EVENT_INFO.order.icon} Крупный заказ`,
        cause,
        effects: [`Контракт: ${amount} ед. «${CARGO[cargo].name}» за ${months} мес.`, 'Хватит ли транспорта — решать вам'],
        related: [refOf(ind)],
        until: sc.month + 1 + EVENT_RULES.offer + months,
        parent: parent?.id,
      },
      subjectKey('order', c),
    );
    const o = sc.addObjective(
      params,
      {
        role: 'contract',
        phase: null,
        months,
        offer: true,
        source: rec.id,
        why: cause,
        reward: { money: contractMoney(ctx, cargo, amount, 0.5), reputation: 4 },
        fail: { reputation: -8 },
        related: [refOf(ind)],
      },
    );
    rec.contract = o.id;
    return rec;
  },
};

/**
 * Изменение спроса. Рост: города, которым нужен груз, заметно выросли (или у города появилась новая
 * потребность) — перевозка груза дороже, его заводы работают живее. Затоваривание: на заводе скопилось
 * сырьё — перевозка этого сырья дешевле, пока склад не разберут.
 */
const demand: Template = {
  type: 'demand',
  candidates: ({ game, sc }) => {
    const out: Candidate[] = [];
    for (const c of TOWN_CARGO) {
      if (!producible(game, c)) continue;
      const towns = game.towns.filter((t) => t.demands.includes(c));
      const supplied = towns.filter((t) => (t.lastSupplied[c] ?? 0) >= TOWN_NEED).length;
      // Спрос растёт там, где груз уже возят: снабжённые города тянут за собой цены.
      if (supplied >= 1 && sc.state.start.population > 0) {
        const pop = game.towns.reduce((s, t) => s + t.population, 0);
        if (pop >= sc.state.start.population * 1.1) out.push({ subject: null, cargo: c, weight: supplied });
      }
    }
    for (const i of game.industries) {
      for (const c of i.info.accepts) if ((i.stock[c] ?? 0) >= 250) out.push({ subject: refOf(i), cargo: c, weight: 1 });
    }
    return out;
  },
  fire(ctx, c, parent) {
    const { game, sc } = ctx;
    const cargo = c.cargo;
    if (!cargo) return null;
    const glut = c.subject !== null;
    const ind = glut ? industryById(game, c.subject!.id) : undefined;
    if (glut && (!ind || (ind.stock[cargo] ?? 0) < 200)) return null;
    const effects: EffectSpec[] = glut
      ? [{ kind: 'price', target: cargo, factor: 0.75, months: 4 }]
      : [
          { kind: 'price', target: cargo, factor: 1.3, months: 6 },
          ...game.industries.filter((i) => i.info.produces === cargo).map((i) => ({ kind: 'industry' as const, target: i.id, factor: 1.15, months: 6 })),
        ];
    const cause = glut
      ? `${ind!.name}: на складе ${Math.floor(ind!.stock[cargo] ?? 0)} ед. «${CARGO[cargo].name}» — завод не успевает перерабатывать.`
      : parent
        ? `Городам понадобились «${CARGO[cargo].name}» — спрос растёт.`
        : `Города растут, и «${CARGO[cargo].name}» нужно всё больше.`;
    const rec = sc.addEvent(
      {
        type: 'demand',
        importance: 'minor',
        title: `${EVENT_INFO.demand.icon} ${glut ? 'Затоваривание' : 'Спрос растёт'}`,
        cause,
        effects: effectLines(game, effects).slice(0, 3),
        related: ind ? [refOf(ind)] : game.towns.filter((t) => t.demands.includes(cargo)).slice(0, 3).map(refOf),
        until: sc.month + 1 + (glut ? 4 : 6),
        parent: parent?.id,
      },
      subjectKey('demand', c),
    );
    sc.apply({ effects }, rec.id);
    return rec;
  },
};

export const TEMPLATES: Record<EventType, Template> = { shortage, expansion, decline, boom, grant, order, demand };

/** События, которые всегда приходят с контрактом: при пределе открытых контрактов их не бывает. */
const CONTRACT_EVENTS = new Set<EventType>(['shortage', 'grant', 'order']);

/**
 * Событие ещё требует внимания игрока: его контракт ждёт решения или выполняется, а событие без контракта —
 * первые два месяца (эффекты при этом действуют весь свой срок).
 */
export function isActive(sc: Scenario, e: EventRecord, now: number): boolean {
  if (e.until <= now + 1) return false;
  if (!e.contract) return e.month + 2 > now;
  const o = sc.objective(e.contract);
  return !!o && (o.status === 'offered' || o.status === 'active');
}

export const activeEvents = (sc: Scenario, now = sc.month) => sc.state.events.filter((e) => isActive(sc, e, now)).length;

/** Открытые контракты: предложенные и принятые. */
const openContracts = (sc: Scenario) => sc.state.objectives.filter((o) => o.role === 'contract' && (o.status === 'offered' || o.status === 'active')).length;

/** Месячный шаг событий: сначала продолжения цепочек, потом, может быть, новое событие по причинам в мире. */
export function runEvents(sc: Scenario): void {
  const s = sc.state;
  const game = sc.game;
  const ctx: Ctx = { sc, game, info: network(game), month: sc.month };
  // Продолжение цепочки уже случилось — нового случайного события в этом месяце не будет.
  if (processQueue(ctx)) return;
  const now = sc.month;
  if (now - s.startMonth < EVENT_RULES.quiet) return;
  if (activeEvents(sc, now) >= sc.difficulty.maxActive) return;
  if (!sc.rng.chance(EVENT_RULES.chance[s.phase] * sc.difficulty.events)) return;
  const arch = ARCHETYPES[s.archetype];
  const contractsFull = openContracts(sc) >= EVENT_RULES.contracts;
  const pool: { v: { t: Template; c: Candidate }; w: number }[] = [];
  for (const t of Object.values(TEMPLATES)) {
    const info = EVENT_INFO[t.type];
    if (!info.phases.includes(s.phase)) continue;
    if (contractsFull && CONTRACT_EVENTS.has(t.type)) continue;
    if (info.importance === 'major' && now - s.lastMajor < EVENT_RULES.majorGap) continue;
    if (info.importance === 'minor' && now - s.lastMinor < EVENT_RULES.minorGap) continue;
    for (const c of t.candidates(ctx)) {
      if (remembered(sc, subjectKey(t.type, c))) continue;
      pool.push({ v: { t, c }, w: c.weight * (arch.events[t.type] ?? 1) });
    }
  }
  if (!pool.length) return;
  const { t, c } = pickWeighted(sc.rng, pool);
  t.fire(ctx, c);
}

/**
 * Вызвать событие прямо сейчас — для тестов и отладки из консоли (game.scenario). Причины в мире не проверяются,
 * правдоподобие предмета — проверяется (fire может вернуть null).
 */
export function forceEvent(sc: Scenario, type: EventType, subject: Ref | null, cargo?: CargoType): EventRecord | null {
  const ctx: Ctx = { sc, game: sc.game, info: network(sc.game), month: sc.month };
  return TEMPLATES[type].fire(ctx, { subject, weight: 1, cargo });
}

/** Где сейчас есть причина для события этого типа — для тестов и диагностики. */
export function eventCandidates(sc: Scenario, type: EventType): { subject: Ref | null; cargo?: CargoType }[] {
  const ctx: Ctx = { sc, game: sc.game, info: network(sc.game), month: sc.month };
  return TEMPLATES[type].candidates(ctx).map(({ subject, cargo }) => ({ subject, cargo }));
}

/** То же событие с тем же предметом было недавно. */
function remembered(sc: Scenario, key: string): boolean {
  const at = sc.state.memory[key];
  return at !== undefined && sc.month - at < EVENT_RULES.memory;
}

/** Сколько раз продолжение цепочки можно отложить (предел активных, уже было событие в этом месяце). */
const MAX_POSTPONE = 4;

/**
 * Продолжения цепочек, чей срок подошёл: случаются, если ещё правдоподобны (fire проверит). Они не ждут
 * случайного шанса — это следствия действий игрока, — но память против повторов, предел активных и «одно
 * новое событие в месяц» действуют и на них: лишние ждут следующего месяца. Возвращает, случилось ли событие.
 */
function processQueue(ctx: Ctx): boolean {
  const s = ctx.sc.state;
  const now = ctx.month;
  const due = s.queue.filter((q) => q.at <= now + 1);
  s.queue = s.queue.filter((q) => q.at > now + 1);
  let fired = false;
  for (const q of due) {
    const c: Candidate = { subject: q.subject, weight: 1, cargo: q.cargo };
    if (remembered(ctx.sc, subjectKey(q.event, c))) continue;
    if (fired || activeEvents(ctx.sc, now) >= ctx.sc.difficulty.maxActive) {
      if ((q.tries ?? 0) < MAX_POSTPONE) s.queue.push({ ...q, at: now + 2, tries: (q.tries ?? 0) + 1 });
      continue;
    }
    const parent = s.events.find((e) => e.id === q.parent);
    fired = !!TEMPLATES[q.event].fire(ctx, c, parent);
  }
  return fired;
}
