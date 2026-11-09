/**
 * Предприятия строит игрок (режим «Строит игрок», docs/INDUSTRIES.md): месторождения, постройка и снос, стройка
 * со временем («Со строительством»), восстановление заброшенных, рабочие (сами и автобусом), вред и рабочие места
 * для роста городов, места в черте города и постройка самим городом. Правила и числа — world/enterprise.ts и
 * ENTERPRISE в config.ts; здесь — состояние партии и связь с Game. В режиме «Готовые» (старые партии) ничего
 * не меняет: обеспеченность и множитель роста — 1.
 */
import { CONSTRUCTION, COST, ENTERPRISE, MONTH_LENGTH } from '../config';
import { dist, type Vec } from '../core/vec';
import { industryShare } from '../world/biomes';
import { INDUSTRY_TYPES, type IndustryKind, type IndustryType } from '../world/cargo';
import { townPlantKind, townSpot } from '../world/deposits';
import {
  allocateWorkers,
  buildableKinds,
  buildCost,
  buildTime,
  depositAt,
  depositFootprint,
  depositRichness,
  growthFactor,
  harmClass,
  harmTo,
  isActive,
  isRaw,
  jobsShare,
  laborPool,
  type Staffing,
  staffShare,
  townFor,
  townHarm,
  townIndustries,
  townSlots,
  type Workforce,
} from '../world/enterprise';
import type { Deposit, Industry, Station, Town } from '../world/entities';
import { playerIndustries } from '../world/settings';
import { type Footprint, footprintCorners, footprintRadius } from '../world/spatial';
import type { Game } from './game';

/** Где и как встанет предприятие — для предпросмотра и постройки. */
export interface IndustryPlan {
  ok: boolean;
  reason?: string;
  kind: IndustryKind;
  /** Цена (с домами под снос). «Со строительством» платится по ходу стройки. */
  cost: number;
  fp: Footprint | null;
  /** Добыча — на этом месторождении. */
  deposit?: Deposit;
  /** В черте какого города (городское); null — за городом. */
  town: Town | null;
  /** Места в черте этого города: занято и всего. */
  slots?: { used: number; total: number };
  /** Рабочие: сколько нужно, какая доля придёт сама и откуда, сколько везти автобусом. */
  staff: Staffing | null;
  /** Каким городам и сколько роста срежет. */
  harm: { town: Town; cut: number }[];
  /** Дома под площадкой — снесём за доплату (их цена уже в cost). */
  demolish: number[];
  /** Строится со временем (режим «Со строительством»), а не сразу. */
  timed: boolean;
}

/** Почему стройка предприятия стоит: нет базы рядом или денег. */
export type BuildStall = 'base' | 'money';

/** Добыча ставится на месторождение, если курсор не дальше стольких единиц от его центра. */
const DEPOSIT_SNAP = 240;
/** Обеспеченность и потоки рабочих пересчитываются раз в столько секунд (и сразу после постройки или сноса). */
const REFRESH = 1;

export class Enterprises {
  /** Месторождения мира (в старых партиях нет). */
  deposits: Deposit[] = [];
  private force: Workforce | null = null;
  private clock = 0;
  /** Потоки рабочих: станция города → станция у предприятия → сколько рабочих в секунду. */
  private flows = new Map<number, Map<number, number>>();
  /** Дробные рабочие, что ещё не появились на станции: «откуда:куда». */
  private readonly acc = new Map<string, number>();
  /** Почему стоит стройка (для плашки и карточки); нет — идёт. */
  readonly stalls = new Map<number, BuildStall>();

  constructor(private readonly game: Game) {}

  /** Режим «Строит игрок». */
  get on(): boolean {
    return playerIndustries(this.game.settings);
  }

  load(deposits: Deposit[] | undefined): void {
    this.deposits = deposits ?? [];
    this.changed();
  }

  /** Что-то построили, снесли или город вырос: обеспеченность и потоки — заново. */
  changed(): void {
    this.force = null;
    this.clock = 0;
  }

  /** Виды предприятий биома этой партии, которые можно построить (добычу — если есть её месторождения). */
  kinds(): IndustryType[] {
    return buildableKinds((k) => industryShare(this.game.settings, k) > 0, this.deposits);
  }

  /** Рабочие всех предприятий и занятость городов (по нынешнему состоянию, кэш до changed или REFRESH). */
  workforce(): Workforce {
    if (!this.force) this.force = allocateWorkers(this.game.towns, this.game.industries);
    return this.force;
  }

  staffing(ind: Industry): Staffing | undefined {
    return this.on ? this.workforce().staff.get(ind.id) : undefined;
  }

  /** Обеспеченность рабочими 0…1: множитель добычи и переработки. «Готовые» — всегда 1. */
  staff(ind: Industry): number {
    if (!this.on) return 1;
    return staffShare(ind, this.workforce().staff.get(ind.id));
  }

  /** Сколько рабочих в месяц ещё не хватает (их можно привезти автобусом сверх уже привезённых). */
  busNeed(ind: Industry): number {
    const s = this.staffing(ind);
    return s ? s.bus : 0;
  }

  /** Множитель роста города: вред от предприятий рядом и рабочие места. «Готовые» — 1. */
  growth(t: Town): number {
    if (!this.on) return 1;
    return growthFactor(townHarm(t, this.game.industries).total, jobsShare(t, this.workforce().employed));
  }

  /** Сводка по городу для карточки: места, вред, рабочие. */
  townInfo(t: Town): { slots: number; inside: Industry[]; harm: { ind: Industry; cut: number }[]; harmTotal: number; pool: number; employed: number; growth: number } {
    const g = this.game;
    const harm = townHarm(t, g.industries);
    const employed = this.workforce().employed.get(t.id) ?? 0;
    return {
      slots: townSlots(t),
      inside: townIndustries(t, g.towns, g.industries),
      harm: harm.from.flatMap((h) => {
        const ind = g.industries.find((i) => i.id === h.id);
        return ind ? [{ ind, cut: h.cut }] : [];
      }),
      harmTotal: harm.total,
      pool: laborPool(t),
      employed,
      growth: this.growth(t),
    };
  }

  // ---------- Постройка ----------

  /**
   * Где встанет предприятие вида kind у точки p (поворот angle — у заводов; добыча — по месторождению): что мешает,
   * цена, рабочие и вред городам. Добыча — только на свободном месторождении своего вида и не в черте города;
   * завод в черте — только на свободное место (townSlots); мешают вода, крутой склон, дороги, пути, предприятия
   * и станции, дома — под снос за доплату.
   */
  plan(kind: IndustryKind, p: Vec, angle = 0): IndustryPlan {
    const g = this.game;
    const info = INDUSTRY_TYPES[kind];
    const base: IndustryPlan = { ok: false, kind, cost: buildCost(info), fp: null, town: null, staff: null, harm: [], demolish: [], timed: g.buildMode };
    const fail = (reason: string, extra: Partial<IndustryPlan> = {}): IndustryPlan => ({ ...base, ...extra, ok: false, reason });
    if (!this.on) return fail('В этой партии предприятия уже стоят на карте');
    if (industryShare(g.settings, kind) <= 0) return fail('В этом биоме таких нет');
    let fp: Footprint;
    let deposit: Deposit | undefined;
    if (isRaw(info)) {
      const own = this.deposits.filter((d) => d.kind === kind).sort((a, b) => dist(a.center, p) - dist(b.center, p));
      deposit = own.find((d) => d.used === undefined) && dist(own.find((d) => d.used === undefined)!.center, p) <= DEPOSIT_SNAP ? own.find((d) => d.used === undefined) : undefined;
      if (!deposit) {
        const busy = own[0] && dist(own[0].center, p) <= DEPOSIT_SNAP && own[0].used !== undefined;
        return fail(busy ? 'Месторождение уже занято' : `⛏️ Добыча — только на месторождении: наведите на значок ${info.short.toLowerCase()}`, { fp: { center: p, w: info.w, h: info.h, angle } });
      }
      fp = depositFootprint(deposit, info);
    } else fp = { center: p, w: info.w, h: info.h, angle };
    const town = townFor(g.towns, fp);
    const staff = this.expectStaff(info, fp);
    const harm = g.towns.flatMap((t) => {
      const cut = harmTo(t, kind, fp);
      return cut > 0 ? [{ town: t, cut }] : [];
    });
    const extra: Partial<IndustryPlan> = { fp, deposit, town, staff, harm };
    if (!g.inBounds(fp.center, footprintRadius(fp) + 20)) return fail('За краем карты', extra);
    if (footprintCorners(fp).some((q) => g.isWater(q, 2)) || g.isWater(fp.center, 4)) return fail('Мешает вода', extra);
    if (town && isRaw(info)) return fail(`В черте города ${town.name} добывать нельзя`, extra);
    if (town) {
      const total = townSlots(town);
      const used = townIndustries(town, g.towns, g.industries).length;
      extra.slots = { used, total };
      if (!total) return fail(`🏙 ${town.name} мал: место под завод — с ${ENTERPRISE.slots.firstPop} жителей`, extra);
      if (used >= total) return fail(`🏙 В ${town.name} нет места: ${used} из ${total}`, extra);
    }
    if (!isRaw(info) && this.deposits.some((d) => d.used === undefined && dist(d.center, fp.center) < footprintRadius(fp) / 2 + ENTERPRISE.deposits.radius))
      return fail('⛏️ Здесь месторождение — на нём только добыча', extra);
    if (g.terrain.hasRelief && !deposit && g.terrain.slopeAt(fp.center) > ENTERPRISE.slope) return fail('Слишком круто: нужен ровный участок', extra);
    const under = g.structuresUnder(fp, 2);
    if (under.blocker) return fail(under.blocker, extra);
    const road = g.roadUnder(fp, 2);
    if (road) return fail(road, extra);
    const cost = base.cost + g.demolishTotal(under.houses);
    extra.demolish = under.houses;
    extra.cost = cost;
    // «Со строительством» платится по ходу стройки — на старте хватит и того, что есть; сразу — нужна вся сумма.
    if (!g.buildMode && cost > g.budget) return fail('Не хватает денег', extra);
    return { ...base, ...extra, ok: true };
  }

  /** Сколько рабочих будет у предприятия вида info на участке fp: последним в очереди, после нынешних. */
  private expectStaff(info: IndustryType, fp: Footprint): Staffing {
    const g = this.game;
    const probe = { type: 'industry', id: Number.MAX_SAFE_INTEGER, info, fp, name: '', stock: {}, output: 0, producedMonth: 0, producedLast: 0, prodAcc: 0 } as Industry;
    return allocateWorkers(g.towns, [...g.industries, probe]).staff.get(probe.id)!;
  }

  /** Ставит предприятие вида kind у точки p. null — поставили, иначе причина. */
  build(kind: IndustryKind, p: Vec, angle = 0): string | null {
    const plan = this.plan(kind, p, angle);
    if (!plan.ok || !plan.fp) return plan.reason ?? 'Нельзя';
    const g = this.game;
    // Дома под площадкой сносим; постройка в отмену (Ctrl+Z) не входит — прежние снимки вернули бы их под неё.
    if (plan.demolish.length) g.demolish(plan.demolish);
    g.forgetUndo();
    const info = INDUSTRY_TYPES[kind];
    const ind = this.add(info, plan.fp, { builtBy: 'player', richness: plan.deposit ? depositRichness(plan.deposit) : undefined });
    if (plan.deposit) plan.deposit.used = ind.id;
    const houses = plan.cost - buildCost(info);
    if (houses > 0) g.spend(houses);
    this.startWork(ind, buildCost(info), buildTime(info));
    g.journal.add('industry+', { id: ind.id, kind, pos: [Math.round(plan.fp.center.x), Math.round(plan.fp.center.y)], $: plan.cost, town: plan.town?.id, timed: plan.timed || undefined });
    return null;
  }

  /** Новое предприятие на участке fp — в списке, индексе и охвате станций рядом. */
  private add(info: IndustryType, fp: Footprint, extra: Partial<Industry>): Industry {
    const g = this.game;
    const nearest = [...g.towns].sort((a, b) => dist(a.center, fp.center) - dist(b.center, fp.center))[0];
    const ind: Industry = {
      type: 'industry',
      id: g.nextId(),
      info,
      name: nearest ? `${info.name} (${nearest.name})` : info.name,
      fp,
      stock: {},
      output: 0,
      producedMonth: 0,
      producedLast: 0,
      prodAcc: 0,
      made: 0,
      ...extra,
    };
    if (ind.richness === undefined) delete ind.richness;
    g.industries.push(ind);
    g.index.add(ind);
    g.refreshCatchmentsNear(fp.center);
    this.changed();
    return ind;
  }

  /** Стройка за cost: сразу — всё и готово; «Со строительством» — площадка, деньги по ходу (tick). */
  private startWork(ind: Industry, cost: number, time: number): void {
    const g = this.game;
    if (g.buildMode) {
      ind.build = { done: 0, cost, paid: 0, time };
    } else {
      g.spend(cost);
      ind.paid = (ind.paid ?? 0) + cost;
    }
    this.changed();
  }

  /** Восстановить заброшенное: за долю цены (ENTERPRISE.ruinShare), «Со строительством» — вдвое быстрее. */
  restorePlan(ind: Industry): { ok: boolean; reason?: string; cost: number } {
    const g = this.game;
    const cost = buildCost(ind.info, true);
    if (!ind.ruin) return { ok: false, reason: 'Предприятие работает', cost };
    if (!g.buildMode && cost > g.budget) return { ok: false, reason: 'Не хватает денег', cost };
    return { ok: true, cost };
  }

  restore(ind: Industry): string | null {
    const plan = this.restorePlan(ind);
    if (!plan.ok) return plan.reason ?? 'Нельзя';
    delete ind.ruin;
    ind.builtBy = 'player';
    ind.made = 0;
    this.startWork(ind, plan.cost, buildTime(ind.info, true));
    this.game.journal.add('industry~', { id: ind.id, $: plan.cost });
    if (!ind.build) this.game.notify(`🏭 ${ind.name}: восстановлено`, '#2e9d57');
    return null;
  }

  /** Снос: стройку — с возвратом всего заплаченного, готовое — с долей ENTERPRISE.refund. Со станцией у него — нельзя. */
  removePlan(ind: Industry): { ok: boolean; reason?: string; refund: number } {
    const g = this.game;
    const refund = ind.build ? Math.round(ind.build.paid) : Math.round((ind.paid ?? 0) * ENTERPRISE.refund);
    if (!this.on) return { ok: false, reason: 'Предприятия на карте не сносятся', refund: 0 };
    const docked = [...g.stations.values()].find((s) => s.industryId === ind.id);
    if (docked) return { ok: false, reason: `Сначала снесите станцию «${docked.name}»`, refund };
    return { ok: true, refund };
  }

  remove(ind: Industry): string | null {
    const plan = this.removePlan(ind);
    if (!plan.ok) return plan.reason ?? 'Нельзя';
    const g = this.game;
    for (const a of ind.annexes ?? []) g.index.remove(a);
    g.index.remove(ind);
    g.industries = g.industries.filter((i) => i !== ind);
    for (const d of this.deposits) if (d.used === ind.id) delete d.used;
    // refund() возвращает долю COST.refundRatio — отдаём ровно plan.refund.
    if (plan.refund > 0) g.refund(plan.refund / COST.refundRatio);
    this.stalls.delete(ind.id);
    g.refreshCatchmentsNear(ind.fp.center);
    this.changed();
    g.journal.add('industry-', { id: ind.id, kind: ind.info.kind, $: plan.refund });
    return null;
  }

  // ---------- Ход времени ----------

  /** Стройка площадок, убыль привезённых рабочих, пересчёт обеспеченности и потоков рабочих. */
  tick(dt: number): void {
    if (!this.on) return;
    const g = this.game;
    for (const ind of g.industries) {
      if (ind.crew) {
        ind.crew *= Math.exp(-dt / MONTH_LENGTH);
        if (ind.crew < 0.01) delete ind.crew;
      }
      if (ind.build) this.work(ind, dt);
    }
    this.clock -= dt;
    if (this.clock <= 0) {
      this.clock = REFRESH;
      this.force = null;
      this.flows = this.workerFlows();
    }
  }

  /** Шаг стройки площадки: нужна база в радиусе обслуживания и деньги на этот кусок работы. */
  private work(ind: Industry, dt: number): void {
    const g = this.game;
    const b = ind.build!;
    const near = [...g.construction.crews.bases.values()].some((base) => dist(base.fp.center, ind.fp.center) <= CONSTRUCTION.serviceRadius);
    if (!near) {
      this.stalls.set(ind.id, 'base');
      return;
    }
    const step = Math.min(1 - b.done, dt / b.time);
    const pay = b.cost * step;
    if (pay > g.budget) {
      this.stalls.set(ind.id, 'money');
      return;
    }
    this.stalls.delete(ind.id);
    g.spend(pay);
    b.paid += pay;
    b.done += step;
    if (b.done >= 1 - 1e-9) {
      ind.paid = (ind.paid ?? 0) + Math.round(b.paid);
      delete ind.build;
      this.changed();
      g.notify(`🏭 ${ind.name}: построено`, '#2e9d57');
      g.journal.add('industry!', { id: ind.id });
    }
  }

  /** Итоги месяца: пустующие места в черте городов — город строит сам (ENTERPRISE.slots.idleMonths). */
  monthEnd(): void {
    if (!this.on) return;
    const g = this.game;
    for (const t of g.towns) {
      const free = townSlots(t) - townIndustries(t, g.towns, g.industries).length;
      if (free <= 0) {
        delete t.slotIdle;
        continue;
      }
      t.slotIdle = (t.slotIdle ?? 0) + 1;
      if (t.slotIdle >= ENTERPRISE.slots.idleMonths && this.townBuilds(t)) delete t.slotIdle;
    }
    this.changed();
  }

  /**
   * Какой завод город построил бы сам на пустующем месте (pick — жребий среди равных): невредный, его продукция
   * нужна городу, и такого в черте города ещё нет — второй того же рецепта город не строит. Нечего — null.
   */
  townPlant(t: Town, pick: (n: number) => number = () => 0): IndustryType | null {
    const g = this.game;
    return townPlantKind(
      t,
      g.towns,
      this.kinds(),
      pick,
      g.industries.map((i) => i.info.kind),
      townIndustries(t, g.towns, g.industries).map((i) => i.info.kind),
    );
  }

  /** Город сам строит завод на пустующем месте (townPlant), без сноса. */
  townBuilds(t: Town): Industry | null {
    const g = this.game;
    const info = this.townPlant(t, (n) => g.rng.int(0, n));
    if (!info) return null;
    const fp = townSpot({ roads: g.roads.net, terrain: g.terrain, index: g.index }, t, info, g.rng.range(0, Math.PI * 2), {
      inside: true,
      deposits: this.deposits,
      towns: g.towns,
    });
    if (!fp || g.roadUnder(fp, 2) || g.structuresUnder(fp, 2).blocker || g.structuresUnder(fp, 2).houses.length) return null;
    const ind = this.add(info, fp, { builtBy: 'town', paid: 0 });
    g.notify(`🏭 В городе ${t.name} открылся ${info.name.toLowerCase()}`, '#2e9d57');
    g.journal.add('industry+', { id: ind.id, kind: info.kind, town: t.id, by: 'town' });
    return ind;
  }

  // ---------- Рабочие автобусом ----------

  /**
   * Станция у предприятия, куда возят рабочих: работает с пассажирами, жителей в охвате нет, а предприятиям в её
   * охвате не хватает рабочих. Довезённые сюда пассажиры — рабочие (без билета).
   */
  takesWorkers(st: Station): boolean {
    if (!this.on || !st.serves.pax || st.catchPop > 0) return false;
    return st.industryIds.some((id) => {
      const ind = this.game.industries.find((i) => i.id === id);
      return !!ind && isActive(ind) && this.busNeed(ind) > 0;
    });
  }

  /** Довезли count рабочих на станцию st: делим между её предприятиями по тому, сколько кому не хватает. */
  addCrew(st: Station, count: number): void {
    const inds = st.industryIds.flatMap((id) => {
      const ind = this.game.industries.find((i) => i.id === id);
      return ind && isActive(ind) && this.busNeed(ind) > 0 ? [ind] : [];
    });
    const total = inds.reduce((s, i) => s + this.busNeed(i), 0);
    for (const ind of inds) ind.crew = (ind.crew ?? 0) + (count * this.busNeed(ind)) / Math.max(1e-6, total);
  }

  /**
   * Сколько рабочих в секунду появляется на станциях городов до станций у предприятий: каждому предприятию — сколько
   * не хватает (busNeed в месяц), поровну между его станциями, а на станцию — от городских станций её пассажирских
   * маршрутов по числу жителей в их охвате.
   */
  private workerFlows(): Map<number, Map<number, number>> {
    const g = this.game;
    const out = new Map<number, Map<number, number>>();
    const docks = new Map<number, number>();
    for (const ind of g.industries) {
      const need = isActive(ind) ? this.busNeed(ind) : 0;
      if (need <= 0.5) continue;
      const sts = [...g.stations.values()].filter((st) => st.serves.pax && st.catchPop <= 0 && st.industryIds.includes(ind.id));
      for (const st of sts) docks.set(st.id, (docks.get(st.id) ?? 0) + need / sts.length / MONTH_LENGTH);
    }
    if (!docks.size) return out;
    const sources = [...g.stations.values()].filter((st) => st.catchPop > 0).map((st) => ({ st, routes: g.paxRoutes(st) }));
    for (const [dock, rate] of docks) {
      const from = sources.filter((s) => s.routes.has(dock));
      const pop = from.reduce((s, x) => s + x.st.catchPop, 0);
      for (const { st } of from) {
        const m = out.get(st.id) ?? new Map<number, number>();
        m.set(dock, (m.get(dock) ?? 0) + (rate * st.catchPop) / pop);
        out.set(st.id, m);
      }
    }
    return out;
  }

  /** Рабочие, что за dt появились на станции st (куда → сколько целых). */
  spawnWorkers(st: Station, dt: number): [number, number][] {
    const flows = this.flows.get(st.id);
    if (!flows) return [];
    const out: [number, number][] = [];
    for (const [dock, rate] of flows) {
      const key = `${st.id}:${dock}`;
      let a = (this.acc.get(key) ?? 0) + rate * dt;
      const whole = Math.floor(a);
      a -= whole;
      this.acc.set(key, a);
      if (whole > 0) out.push([dock, whole]);
    }
    return out;
  }

  /** Добыча и переработка — по обеспеченности рабочими и (у добычи) по богатству месторождения. */
  rateFactor(ind: Industry): number {
    return this.staff(ind) * (ind.richness ?? 1);
  }

  /** Класс вредности предприятия (для подписи ☁). */
  harmOf(ind: Pick<Industry, 'info'>): number {
    return harmClass(ind.info.kind);
  }

  /** Месторождение по id. */
  deposit(id: number): Deposit | undefined {
    return this.deposits.find((d) => d.id === id);
  }

  /** Свободное месторождение под точкой p (клик по пятну или значку, slack — запас от края). */
  depositAt(p: Vec, slack = 0): Deposit | null {
    return depositAt(this.deposits, p, slack);
  }

  /** Добыча, которая встанет на месторождение d: вид, участок, богатство — для партнёров и подсказок карточки. */
  depositProbe(d: Deposit): Industry {
    const info = INDUSTRY_TYPES[d.kind];
    return { type: 'industry', id: -1, info, fp: depositFootprint(d, info), name: info.name, stock: {}, output: 0, producedMonth: 0, producedLast: 0, prodAcc: 0, richness: depositRichness(d) };
  }

  /** Сколько добудет в месяц предприятие на месторождении d при полных рабочих (уровень 1): по его размеру. */
  depositYield(d: Deposit): number {
    return Math.round(INDUSTRY_TYPES[d.kind].rate * depositRichness(d));
  }

  /** Месторождение под предприятием (добыча). */
  depositOf(ind: Industry): Deposit | undefined {
    return this.deposits.find((d) => d.used === ind.id);
  }
}
