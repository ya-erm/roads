/**
 * Задания без сроков («Идеи») — в песочнице и после конца сценария (проигранного или пройденного, когда
 * дополнительных заданий не осталось). Изредка предлагают одно дело по тому, что сейчас происходит в игре:
 * завод ждёт сырьё, на станции копится продукция, городу не хватает груза, рядом с сетью город без автобусов.
 * Без давления: срока нет, предложение ждёт сколько угодно, отказаться, отложить и бросить можно без штрафа,
 * награда — небольшие деньги («Награды и субсидии»). Правила и числа — в docs/SCENARIOS.md, раздел «Задания без
 * сроков». Прогресс — теми же счётчиками и функциями, что у заданий сценария (objectives.ts).
 */
import { MONTH_LENGTH } from '../config';
import { dist, type Vec } from '../core/vec';
import type { Game } from '../game/game';
import { MODELS } from '../game/transport';
import { CARGO, type CargoType } from '../world/cargo';
import { buildCost, isActive, isRaw } from '../world/enterprise';
import type { Industry } from '../world/entities';
import { townNeed } from '../world/townSupply';
import { connected, km, live, network, paxPerMonth, rawOutput, receivers, refOf } from './analysis';
import { assess } from './feasibility';
import { buildTarget, perVehicleMonth } from './generator';
import { baseOf, closedNeeds, countDelivery, countPassengers, isMonthly, liveProgress, monthOk, moneyText, targetOf, titleOf } from './objectives';
import type { ObjectiveParams, Ref, ScenarioStats } from './types';

/**
 * Правила, в минутах игры на 1× (месяц игры — минута). Подробно и почему так — docs/SCENARIOS.md.
 */
export const IDEAS = {
  /** Первая идея — через столько после того, как идеи включились: новая песочница, загрузка, конец сценария. */
  first: 4,
  /** Следующая — не раньше, чем через столько после прошлой. */
  gap: 5,
  /** «Позже»: та же идея вернётся через столько (если ещё к месту), до тех пор новых нет. */
  later: 10,
  /** «Не надо» и брошенное: тот же предмет (город, завод) не предлагать столько. */
  skip: 30,
  /** Взятых одновременно — не больше. Предложение на решение — одно. */
  active: 2,
  /** Выполненное видно в панели столько, потом уходит (в счёт «выполнено»). */
  shown: 1,
  /** Награда: объём × тариф груза × perUnit, до тысяч, в пределах min…max. */
  money: { perUnit: 12, min: 5_000, max: 30_000 },
  /** Снабжение города: за каждую потребность из нужных. */
  supplyMoney: 8_000,
  /** «Построить»: доля цены предприятия. */
  buildShare: 0.25,
  /** Объём — сколько два грузовика (автобуса) увезут за столько минут, в пределах amount. */
  haul: { vehicles: 2, months: 4 },
  amount: { min: 30, max: 200 },
  /** Дальше этого от производителя (ед. карты, ≈3 км) груз не предлагаем — далёкая цепочка уже не «когда удобно». */
  reach: 5000,
  /** Город без транспорта — от стольких жителей; партнёр в сети — не дальше reach. */
  linkPopulation: 500,
  /** На станции у предприятия ждёт столько его продукции — «склад копится». */
  pile: 30,
  /** Выполнимость проверяем на столько минут вперёд (feasibility.assess): «когда-нибудь успеете». */
  horizon: 24,
} as const;

/** Вид идеи — по тому, что в игре происходит. Предлагаются по кругу, чтобы не повторяться. */
export type IdeaKind = 'input' | 'export' | 'town' | 'link' | 'supply' | 'build';
export const IDEA_KINDS: readonly IdeaKind[] = ['input', 'export', 'town', 'link', 'supply', 'build'];

export interface Idea {
  id: string;
  kind: IdeaKind;
  /** Предмет — против повторов и двух одинаковых идей: `town:3:food`, `link:5`. */
  key: string;
  params: ObjectiveParams;
  title: string;
  /** Почему предложено — по состоянию мира. */
  why: string;
  /** offered — ждёт решения; active — взято; done — выполнено (видно минуту); declined — отказ, брошено, неактуально. */
  status: 'offered' | 'active' | 'done' | 'declined';
  /** Месяцы игры с долей. */
  created: number;
  started?: number;
  closedAt?: number;
  /** «Позже»: предложение спрятано до этого момента. */
  later?: number;
  base: number;
  progress: number;
  target: number;
  streak: number;
  reward: { money: number };
  related: Ref[];
}

export interface IdeasState {
  version: 1;
  nextId: number;
  /** Не раньше этого момента — следующее предложение; нет — идеи ещё не включались (или их выключили). */
  next?: number;
  /** Какой вид идеи пробовать первым — по кругу IDEA_KINDS. */
  turn: number;
  list: Idea[];
  /** Отказались или бросили: предмет → до какого момента не предлагать. */
  skip: Record<string, number>;
  /** Выполнено всего. */
  done: number;
  /** Свои счётчики перевозок: в песочнице сценария нет, а после его конца — с этой минуты. */
  stats: ScenarioStats;
}

/** Кандидат в идеи: что, почему, кто связан, награда. */
interface Candidate {
  kind: IdeaKind;
  key: string;
  params: ObjectiveParams;
  why: string;
  related: Ref[];
  money: number;
  /** Чем меньше, тем лучше (ближе). */
  d: number;
}

const emptyStats = (): ScenarioStats => ({ delivered: {}, to: {}, pax: 0, between: {}, units: 0, speedSum: 0, months: [] });

export function newIdeasState(): IdeasState {
  return { version: 1, nextId: 1, turn: 0, list: [], skip: {}, done: 0, stats: emptyStats() };
}

const round10 = (n: number) => Math.round(n / 10) * 10;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Объём: что увезут два грузовика (или автобуса — both) за 4 мин на расстояние d, но не больше выпуска за то же время. */
export function ideaAmount(d: number, perMonth: number, capacity = MODELS.truck.capacity, both = false): number {
  const H = IDEAS.haul;
  const can = Math.min(perVehicleMonth(d, capacity, both) * H.vehicles * H.months, perMonth * H.months * 0.8);
  return clamp(round10(can), IDEAS.amount.min, IDEAS.amount.max);
}

/** Награда за перевозку: объём × тариф × 12, до тысяч, $5 000…$30 000. */
export function ideaMoney(amount: number, cargo: CargoType): number {
  const M = IDEAS.money;
  return clamp(Math.round((amount * CARGO[cargo].rate * M.perUnit) / 1000) * 1000, M.min, M.max);
}

/** Сколько предприятие выпускает в месяц: добыча — по уровню, завод — сколько выпустил в прошлом месяце. */
const madePerMonth = (ind: Industry) => Math.max(ind.producedLast, isRaw(ind.info) ? rawOutput(ind, 1) : 0);

/** Ближайший работающий производитель груза (кроме себя) не дальше reach от точки. */
function nearestMaker(game: Game, cargo: CargoType, at: Vec, except?: number): { ind: Industry; d: number } | null {
  let best: { ind: Industry; d: number } | null = null;
  for (const ind of live(game)) {
    if (ind.id === except || ind.info.produces !== cargo || !isActive(ind)) continue;
    // Завод, который сам стоит без сырья, — это уже цепочка, а не «когда удобно».
    if (!isRaw(ind.info) && ind.producedLast <= 0) continue;
    const d = dist(ind.fp.center, at);
    if (d <= IDEAS.reach && (!best || d < best.d)) best = { ind, d };
  }
  return best;
}

export class Ideas {
  state: IdeasState;
  /** Настройка «Задания без сроков» (Меню → Настройки; Hud ставит её сюда). Выключено — ничего не предлагаем. */
  private on = true;
  /** Секунды до следующей проверки прогресса. */
  private clock = 0;

  constructor(
    readonly game: Game,
    save?: IdeasState,
  ) {
    this.state = save ? { ...newIdeasState(), ...structuredClone(save) } : newIdeasState();
  }

  toSave(): IdeasState | undefined {
    // Пустое состояние (идеи ещё ни разу не включались) не пишем — старые и сценарные сохранения те же.
    const s = this.state;
    return s.next === undefined && !s.list.length && !s.done ? undefined : structuredClone(s);
  }

  /** Сейчас — в месяцах игры с долей. */
  private get now(): number {
    return this.game.time / MONTH_LENGTH;
  }

  get enabled(): boolean {
    return this.on;
  }

  /**
   * Включить или выключить (настройка). Выключили — предложение и взятые снимаются без последствий, отсчёт до
   * первой идеи начнётся заново, когда включат.
   */
  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (on) return;
    for (const i of this.open) this.close(i);
    this.state.next = undefined;
  }

  /**
   * Идеи работают: настройка включена и нет идущего сценария — песочница, сценарий проигран или пройден, а
   * дополнительных заданий после победы уже нет (у них своя вкладка).
   */
  get available(): boolean {
    if (!this.on) return false;
    const sc = this.game.scenario;
    return !sc || (!sc.running && !sc.current.length);
  }

  /** Ждёт решения и не отложено. */
  get offer(): Idea | undefined {
    return this.state.list.find((i) => i.status === 'offered' && i.later === undefined);
  }

  get active(): Idea[] {
    return this.state.list.filter((i) => i.status === 'active');
  }

  /** Предложение (и отложенное) и взятые. */
  private get open(): Idea[] {
    return this.state.list.filter((i) => i.status === 'offered' || i.status === 'active');
  }

  /** Для панели: предложение, взятые и только что выполненные. */
  get shown(): Idea[] {
    return this.state.list.filter((i) => (i.status === 'offered' && i.later === undefined) || i.status === 'active' || i.status === 'done');
  }

  idea(id: string): Idea | undefined {
    return this.state.list.find((i) => i.id === id);
  }

  /** Вкладку «Идеи» показывать: есть что — предложение, взятое или только что выполненное. Пусто — не мешаем. */
  get visible(): boolean {
    return this.available && this.shown.length > 0;
  }

  // ---------- Сообщения игры ----------

  onDelivered(cargo: CargoType, amount: number, receiver: Ref | null, speed: number, maker?: number): void {
    if (this.available) countDelivery(this.state.stats, cargo, amount, receiver, speed, maker);
  }

  onPassengers(from: number | undefined, to: number | undefined, count: number, speed: number): void {
    if (this.available) countPassengers(this.state.stats, from, to, count, speed);
  }

  /** Раз в секунду игры — прогресс взятых: накопительное выполнено — сразу награда. */
  tick(dt: number): void {
    this.clock -= dt;
    if (this.clock > 0) return;
    this.clock = 1;
    if (!this.available) return;
    for (const i of this.active) {
      i.progress = liveProgress(i, this.state, this.game);
      if (!isMonthly(i.params) && i.progress >= i.target) this.complete(i);
    }
  }

  /** Итоги месяца: месячные идеи (снабжение), уборка, напоминание об отложенном и, если пора, новая идея. */
  monthEnd(): void {
    const s = this.state;
    // В итогах месяца счётчик игры ещё на закончившемся месяце — «сейчас» уже следующий (как Scenario.today).
    const now = this.game.monthIndex + 1;
    if (!this.available) return;
    for (const i of this.active) {
      if (!isMonthly(i.params)) continue;
      i.streak = monthOk(i.params, this.game, { month: now - 1, units: 0, speed: 1, income: 0, costs: 0 }) ? i.streak + 1 : 0;
      i.progress = i.streak;
      if (i.streak >= i.target) this.complete(i);
    }
    // Неактуальное (города или завода нет, груз больше не нужен) — снимаем молча, без последствий.
    for (const i of this.open) if (!assess(this.game, i.params, IDEAS.horizon).ok) this.close(i);
    s.list = s.list.filter((i) => i.status === 'offered' || i.status === 'active' || (i.status === 'done' && now - (i.closedAt ?? now) < IDEAS.shown));
    for (const [k, until] of Object.entries(s.skip)) if (until <= now) delete s.skip[k];
    s.next ??= now + IDEAS.first;
    // Отложенное — вернулось.
    const later = s.list.find((i) => i.status === 'offered' && i.later !== undefined);
    if (later && now >= later.later!) {
      delete later.later;
      this.game.notify(`☕ Вернулось отложенное: ${later.title}`, '#8a6d3b');
    }
    if (now < s.next || s.list.some((i) => i.status === 'offered') || this.active.length >= IDEAS.active) return;
    if (!this.propose(now)) s.next = now + 1;
  }

  // ---------- Решения игрока ----------

  /** Взять: прогресс — с этой минуты. Взятых уже два — нельзя. */
  take(id: string): boolean {
    const i = this.idea(id);
    if (!i || i.status !== 'offered' || this.active.length >= IDEAS.active) return false;
    i.status = 'active';
    i.started = this.now;
    delete i.later;
    i.base = baseOf(this.state, i.params, this.game);
    i.streak = 0;
    i.progress = liveProgress(i, this.state, this.game);
    this.game.journal.add('idea', { id: i.id, act: 'take' });
    return true;
  }

  /** «Позже»: предложение прячется на 10 мин и вернётся, новых до тех пор нет. */
  later(id: string): boolean {
    const i = this.idea(id);
    if (!i || i.status !== 'offered') return false;
    i.later = this.now + IDEAS.later;
    this.game.journal.add('idea', { id: i.id, act: 'later' });
    return true;
  }

  /** «Не надо» (предложение) или «бросить» (взятое): без последствий, этот предмет — не раньше чем через 30 мин. */
  drop(id: string): boolean {
    const i = this.idea(id);
    if (!i || (i.status !== 'offered' && i.status !== 'active')) return false;
    const was = i.status;
    this.close(i);
    this.state.skip[i.key] = this.now + IDEAS.skip;
    if (was === 'offered') this.state.next = Math.max(this.state.next ?? 0, this.now + IDEAS.gap);
    this.game.journal.add('idea', { id: i.id, act: was === 'offered' ? 'no' : 'drop' });
    return true;
  }

  // ---------- Внутреннее ----------

  private close(i: Idea): void {
    i.status = 'declined';
    i.closedAt = this.now;
    this.state.list = this.state.list.filter((x) => x !== i);
  }

  private complete(i: Idea): void {
    i.status = 'done';
    i.closedAt = this.now;
    i.progress = Math.max(i.progress, i.target);
    this.state.done++;
    this.game.grant(i.reward.money);
    this.game.journal.add('idea', { id: i.id, act: 'done', $: i.reward.money });
    this.game.notify(`☕ Готово: ${i.title} · +${moneyText(i.reward.money)}`, '#2e9d57');
  }

  /** Новая идея: виды по кругу, с того, чья очередь; в виде — ближайший подходящий предмет. Нечего — false. */
  private propose(now: number): boolean {
    const s = this.state;
    const taken = new Set(this.open.map((i) => i.key));
    for (let k = 0; k < IDEA_KINDS.length; k++) {
      const kind = IDEA_KINDS[(s.turn + k) % IDEA_KINDS.length];
      const pick = ideaCandidates(this.game, kind).find((c) => !taken.has(c.key) && !(s.skip[c.key] > now) && assess(this.game, c.params, IDEAS.horizon).ok);
      if (!pick) continue;
      const i: Idea = {
        id: `i${s.nextId++}`,
        kind,
        key: pick.key,
        params: pick.params,
        title: titleOf(pick.params, this.game),
        why: pick.why,
        status: 'offered',
        created: now,
        base: 0,
        progress: 0,
        target: targetOf(pick.params),
        streak: 0,
        reward: { money: pick.money },
        related: pick.related,
      };
      s.list.push(i);
      s.turn = (s.turn + k + 1) % IDEA_KINDS.length;
      s.next = now + IDEAS.gap;
      this.game.journal.add('idea', { id: i.id, act: 'offer', kind, title: i.title, params: i.params, $: pick.money });
      this.game.notify(`☕ Идея: ${i.title} — без срока`, '#8a6d3b');
      return true;
    }
    return false;
  }
}

/**
 * Кандидаты в идеи вида kind — по тому, что сейчас в игре, ближние первыми. Только то, что связано с сетью
 * игрока (или, для «построить», с его предприятиями), — чтобы идея была к месту, а не «где-то на карте».
 */
export function ideaCandidates(game: Game, kind: IdeaKind): Candidate[] {
  const net = network(game);
  const out: Candidate[] = [];
  switch (kind) {
    case 'input': {
      // Завод у станции сети стоит без одного из видов сырья, а производитель — рядом.
      for (const plant of live(game)) {
        if (!plant.info.accepts.length || !net.industries.has(plant.id) || !isActive(plant)) continue;
        for (const c of plant.info.accepts) {
          if ((plant.stock[c] ?? 0) >= 1) continue;
          const from = nearestMaker(game, c, plant.fp.center, plant.id);
          if (!from) continue;
          const amount = ideaAmount(from.d, madePerMonth(from.ind));
          out.push({
            kind,
            key: `input:${plant.id}:${c}`,
            params: { kind: 'deliver', cargo: c, amount, to: refOf(plant) },
            why: `${plant.name} ждёт «${CARGO[c].name}»: на складе пусто. Ближе всех — ${from.ind.name}, ${km(from.d)}.`,
            related: [refOf(from.ind), refOf(plant)],
            money: ideaMoney(amount, c),
            d: from.d,
          });
        }
      }
      break;
    }
    case 'export': {
      // Продукция копится на станции у предприятия: вывезти тем, кто её примет.
      for (const ind of live(game)) {
        if (!net.industries.has(ind.id) || !isActive(ind)) continue;
        const c = ind.info.produces;
        let waiting = 0;
        for (const st of game.stations.values()) if (st.industryIds.includes(ind.id)) waiting += st.cargo[c] ?? 0;
        if (waiting < IDEAS.pile) continue;
        const to = receivers(game, c)
          .map((r) => ({ r, d: dist('info' in r ? r.fp.center : r.center, ind.fp.center) }))
          .sort((a, b) => a.d - b.d)[0];
        if (!to || to.d > IDEAS.reach) continue;
        const amount = ideaAmount(to.d, madePerMonth(ind));
        out.push({
          kind,
          key: `export:${ind.id}`,
          params: { kind: 'deliver', cargo: c, amount, to: null, from: ind.id },
          why: `У станции ${ind.name} копится «${CARGO[c].name}» (${Math.round(waiting)} ед.). Ближайший, кому это нужно, — ${to.r.name}, ${km(to.d)}.`,
          related: [refOf(ind), refOf(to.r)],
          money: ideaMoney(amount, c),
          d: to.d,
        });
      }
      break;
    }
    case 'town': {
      // Город в сети недополучает нужный груз, а производитель рядом.
      const towns = connected(game).towns;
      for (const t of game.towns) {
        if (!towns.has(t.id)) continue;
        const need = townNeed(t.population);
        for (const c of t.demands) {
          if ((t.lastSupplied[c] ?? 0) >= need) continue;
          const from = nearestMaker(game, c, t.center);
          if (!from) continue;
          const amount = Math.min(ideaAmount(from.d, madePerMonth(from.ind)), Math.max(IDEAS.amount.min, round10(need * IDEAS.haul.months)));
          out.push({
            kind,
            key: `town:${t.id}:${c}`,
            params: { kind: 'deliver', cargo: c, amount, to: refOf(t) },
            why: `${t.name} нужны «${CARGO[c].name}» — по ${need} ед. в месяц, а привозят меньше. Делает ${from.ind.name}, ${km(from.d)}.`,
            related: [refOf(t), refOf(from.ind)],
            money: ideaMoney(amount, c),
            d: from.d,
          });
        }
      }
      break;
    }
    case 'link': {
      // Город без автобусов рядом с городом, где они уже ходят.
      const served = game.towns.filter((t) => net.towns.has(t.id));
      if (!served.length) break;
      for (const t of game.towns) {
        if (net.towns.has(t.id) || t.population < IDEAS.linkPopulation) continue;
        const near = served.map((b) => ({ b, d: dist(b.center, t.center) })).sort((a, b) => a.d - b.d)[0];
        if (!near || near.d > IDEAS.reach) continue;
        const amount = ideaAmount(near.d, paxPerMonth(t, near.b) * 0.5, MODELS.bus.capacity, true);
        out.push({
          kind,
          key: `link:${t.id}`,
          params: { kind: 'passengers', amount, towns: [near.b.id, t.id] },
          why: `В городе ${t.name} (${t.population.toLocaleString('ru-RU')} жит.) нет автобусов, а до города ${near.b.name}, где они ходят, — ${km(near.d)}.`,
          related: [refOf(near.b), refOf(t)],
          money: ideaMoney(amount, 'passengers'),
          d: near.d,
        });
      }
      break;
    }
    case 'supply': {
      // Город в сети, где часть потребностей уже закрыта, — закрыть ещё одну за месяц.
      const towns = connected(game).towns;
      for (const t of game.towns) {
        if (!towns.has(t.id) || t.demands.length < 2) continue;
        const closed = closedNeeds(t).length;
        if (closed < 1 || closed >= t.demands.length) continue;
        const needs = closed + 1;
        out.push({
          kind,
          key: `supply:${t.id}`,
          params: { kind: 'supply', town: t.id, months: 1, needs },
          why: `${t.name} уже получает ${closed} из ${t.demands.length} нужных грузов. Ещё одна — и город растёт быстрее.`,
          related: [refOf(t)],
          money: Math.min(IDEAS.money.max, IDEAS.supplyMoney * needs),
          // Крупные города — первыми.
          d: -t.population,
        });
      }
      break;
    }
    case 'build': {
      // «Строит игрок»: добыче некуда сбыть сырьё (или заводу некому его добыть) — построить недостающее.
      if (!game.enterprises.on) break;
      const target = buildTarget(game);
      if (!target) break;
      out.push({
        kind,
        key: `build:${target.kind.kind}`,
        params: { kind: 'build', count: 1, what: target.kind.kind, cargo: target.kind.produces, known: live(game).map((i) => i.id) },
        why: target.why,
        related: target.related,
        money: Math.round((buildCost(target.kind) * IDEAS.buildShare) / 1000) * 1000,
        d: 0,
      });
      break;
    }
  }
  return out.sort((a, b) => a.d - b.d);
}
