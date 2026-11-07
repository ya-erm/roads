/**
 * Строительные базы и бригады (режим «Со строительством», шаг 2 — docs/CONSTRUCTION.md): проект строится, только
 * пока на нём работает бригада (самосвал, грейдер, каток). Бригада приписана к базе; свободная едет с базы к стройке
 * по обычным дорогам — машиной в общем потоке (стоит в пробках), а где дороги до стройки нет (или пути по дорогам нет:
 * сеть разорвана) — своим ходом по бездорожью (CONSTRUCTION.offroad): по прямой, и самосвал видно в пути (offroadAt). Проект закончили, отменили или поставили на паузу — бригада едет к другому
 * проекту, которому не хватает рук, или домой на базу.
 *
 * Приоритетный проект (Project.priority): свободная бригада едет сначала к нему; не хватает рук, а свободных нет —
 * к нему переходит бригада, работающая на обычном проекте (reinforce).
 *
 * Темп проекта — сумма вкладов бригад на нём: 1 / (1 + d / reach), d — от базы бригады до края работ (возит грунт
 * и асфальт); бригад на проекте — не больше brigade.perProject. Содержание бригад — каждый месяц (Game.monthEnd).
 *
 * Детерминизм: бригады перебираются по номеру, решения — по номерам и расстояниям, без случайности.
 */
import { CONSTRUCTION } from '../config';
import { dist, type Vec } from '../core/vec';
import type { BuildBase } from '../world/entities';

export type BrigadeState = 'idle' | 'going' | 'working' | 'back';

export interface Brigade {
  id: number;
  /** База приписки. */
  base: number;
  state: BrigadeState;
  /** Проект, куда едет или где работает. */
  project?: number;
  /** Узел дороги, где бригада сейчас (последняя стройка); нет — на базе. */
  at?: number;
  /** Где бригада сейчас, если не на дороге: последняя стройка или база. */
  pos?: Vec;
  /** Едет по бездорожью — к какому времени доедет (секунды игры). */
  eta?: number;
  /**
   * Едет по бездорожью: откуда и куда по прямой, когда выехала (секунды игры) — где она сейчас, считается по времени
   * (offroadAt). Нет в старых сохранениях: тогда — от места, где была, к цели, выехав за путь до eta.
   */
  trip?: OffroadTrip;
  /** Машина в потоке (id в симуляции) — не сохраняется: после загрузки бригада выезжает заново. */
  sim?: number;
}

/** Поездка бригады своим ходом: по прямой from → to, выехала в t0, доедет в Brigade.eta. */
export interface OffroadTrip {
  from: Vec;
  to: Vec;
  t0: number;
}

export interface CrewSave {
  bases: BuildBase[];
  brigades: Omit<Brigade, 'sim'>[];
  nextBrigade: number;
  /** Первая (бесплатная) база уже была: снесли все — следующая снова платная. Нет в старых сохранениях. */
  firstUsed?: true;
}

/** Куда ехать к проекту: узел дороги у края работ (если он в графе движения) и точка края работ. */
export interface Site {
  node: number | null;
  pos: Vec;
}

/** Что бригадам нужно знать об игре. */
export interface CrewHost {
  readonly time: number;
  /** Проекты, которым нужны бригады: не на паузе и с недостроенным, по порядку закладки. */
  crewProjects(): number[];
  /** Приоритетный проект: бригады — сначала к нему, при нехватке — переходят к нему с обычных. */
  priority?(project: number): boolean;
  /** Куда ехать к проекту (null — проекта нет). */
  site(project: number): Site | null;
  /**
   * Выпустить машину бригады от узла from к узлу to: id машины; 'busy' — путь есть, но на выезде нет места (попробовать
   * в следующий такт); null — пути по дорогам нет (сеть разорвана, проект её и соединяет) — ехать своим ходом.
   */
  drive(brigade: Brigade, from: number, to: number): number | 'busy' | null;
  /** Машина бригады больше не нужна (бригаду продали, база снесена). */
  park(sim: number): void;
  /** Узел есть в графе движения (туда можно доехать по дороге). */
  onRoad(node: number): boolean;
}

export class Crews {
  readonly bases = new Map<number, BuildBase>();
  readonly brigades = new Map<number, Brigade>();
  nextBrigade = 1;
  /** Первая, бесплатная база уже поставлена (даже если её потом снесли). */
  firstUsed = false;

  constructor(private readonly host: CrewHost) {}

  /** Бригады базы. */
  of(base: number): Brigade[] {
    return [...this.brigades.values()].filter((b) => b.base === base);
  }

  /** Новая бригада на базе. */
  hire(base: number): Brigade | null {
    const b = this.bases.get(base);
    if (!b) return null;
    const crew: Brigade = { id: this.nextBrigade++, base, state: 'idle' };
    this.brigades.set(crew.id, crew);
    return crew;
  }

  /** Убрать бригаду (свободную — первой): машина в пути исчезает. */
  dismiss(base: number): Brigade | null {
    const list = this.of(base);
    const crew = list.find((b) => b.state === 'idle') ?? list[list.length - 1];
    if (!crew) return null;
    if (crew.sim !== undefined) this.host.park(crew.sim);
    this.brigades.delete(crew.id);
    return crew;
  }

  /** Сколько бригад едут к проекту или работают на нём. */
  assigned(project: number): Brigade[] {
    return [...this.brigades.values()].filter((b) => b.project === project && (b.state === 'going' || b.state === 'working'));
  }

  /** Работают на проекте сейчас. */
  working(project: number): Brigade[] {
    return [...this.brigades.values()].filter((b) => b.project === project && b.state === 'working');
  }

  /** Вклад бригады в темп: на reach от базы — вдвое медленнее. */
  power(crew: Brigade, front: Vec): number {
    const base = this.bases.get(crew.base);
    const d = base ? dist(base.fp.center, front) : 0;
    return 1 / (1 + d / CONSTRUCTION.reach);
  }

  /** Вклад одной бригады с ближайшей к точке базы — прикидка, пока никто не работает; баз нет — 1. */
  nearestPower(at: Vec): number {
    let best = 0;
    for (const b of this.bases.values()) best = Math.max(best, 1 / (1 + dist(b.fp.center, at) / CONSTRUCTION.reach));
    return best || 1;
  }

  /** Ближайшая к точке база и расстояние до неё. */
  nearestBase(at: Vec): { base: BuildBase; d: number } | null {
    let best: { base: BuildBase; d: number } | null = null;
    for (const b of this.bases.values()) {
      const d = dist(b.fp.center, at);
      if (!best || d < best.d - 1e-6) best = { base: b, d };
    }
    return best;
  }

  /** Темп проекта: сумма вкладов работающих на нём бригад (0 — никто не работает). */
  rate(project: number, front: Vec): number {
    // Сильнейшая бригада — во всю силу, следующие — долями CONSTRUCTION.crewShare.
    const powers = this.working(project)
      .map((b) => this.power(b, front))
      .sort((a, b) => b - a);
    const share = CONSTRUCTION.crewShare;
    return powers.reduce((k, p, i) => k + p * (share[i] ?? share[share.length - 1]), 0);
  }

  /**
   * Где бригада сейчас (для выбора ближайшего проекта и выезда): едет своим ходом — где успела доехать, иначе
   * последняя стройка или база.
   */
  private where(b: Brigade): Vec {
    return this.offroadAt(b)?.pos ?? this.stand(b);
  }

  /** Где бригада стоит (не в пути): последняя стройка (или место, где съехала с дороги) или база. */
  private stand(b: Brigade): Vec {
    return b.pos ?? this.bases.get(b.base)?.fp.center ?? { x: 0, y: 0 };
  }

  /**
   * Узел, откуда бригада выедет по дороге: на базе — ворота; вне базы — узел, у которого стоит (последняя стройка у
   * дороги), а стоит в поле — null: оттуда только своим ходом.
   */
  private from(b: Brigade): number | null {
    if (b.pos) return b.at !== undefined && this.host.onRoad(b.at) ? b.at : null;
    const base = this.bases.get(b.base);
    return base ? base.nodeId : null;
  }

  /**
   * Бригада своим ходом — где она сейчас и куда смотрит: по прямой от места выезда к цели, по времени от выезда до eta.
   * Не едет своим ходом — null. Старое сохранение (eta без trip) — от места, где стояла, к нынешней цели.
   */
  offroadAt(b: Brigade): { pos: Vec; dir: Vec } | null {
    if (b.eta === undefined) return null;
    const trip = b.trip ?? this.legacyTrip(b, b.eta);
    const d = dist(trip.from, trip.to);
    const k = b.eta > trip.t0 ? Math.max(0, Math.min(1, (this.host.time - trip.t0) / (b.eta - trip.t0))) : 1;
    const dir = d > 1e-9 ? { x: (trip.to.x - trip.from.x) / d, y: (trip.to.y - trip.from.y) / d } : { x: 1, y: 0 };
    return { pos: { x: trip.from.x + (trip.to.x - trip.from.x) * k, y: trip.from.y + (trip.to.y - trip.from.y) * k }, dir };
  }

  /** Поездка из сохранения без trip: от места, где бригада стояла, к цели — выехала за путь до eta. */
  private legacyTrip(b: Brigade, eta: number): OffroadTrip {
    const from = this.stand(b);
    const to = this.target(b) ?? from;
    return { from, to, t0: eta - dist(from, to) / CONSTRUCTION.offroad };
  }

  /** Куда бригада едет: к стройке — край работ, домой — база. */
  private target(b: Brigade): Vec | undefined {
    if (b.state === 'back') return this.bases.get(b.base)?.fp.center;
    return b.project !== undefined ? this.host.site(b.project)?.pos : undefined;
  }

  /** В путь своим ходом к точке to — от того места, где бригада сейчас. */
  private offroad(b: Brigade, to: Vec): void {
    const from = this.where(b);
    b.trip = { from: { ...from }, to: { ...to }, t0: this.host.time };
    b.eta = this.host.time + dist(from, to) / CONSTRUCTION.offroad;
  }

  /** Поездку своим ходом прервали (другой проект, снос базы): бригада стоит там, куда успела доехать, — в поле. */
  private settle(b: Brigade): void {
    const at = this.offroadAt(b);
    if (at) {
      b.pos = at.pos;
      delete b.at;
    }
    delete b.eta;
    delete b.trip;
  }

  /** Такт: решения бригад и дорога по бездорожью. */
  tick(): void {
    if (!this.brigades.size) return;
    const projects = this.host.crewProjects();
    const live = new Set(projects);
    for (const b of this.brigades.values()) {
      // Проект кончился, отменён или на паузе — бригада свободна.
      if ((b.state === 'going' || b.state === 'working') && (b.project === undefined || !live.has(b.project))) this.release(b);
      // Свободна или идёт домой своим ходом — может сразу взяться за другой проект.
      if (b.state === 'idle' || (b.state === 'back' && b.sim === undefined)) this.assign(b, projects);
      if (b.state === 'going' && b.sim === undefined && b.eta === undefined) this.launch(b);
      if (b.state === 'back' && b.sim === undefined && b.eta === undefined) this.launchHome(b);
      // По бездорожью доехали.
      if (b.eta !== undefined && this.host.time >= b.eta) {
        delete b.eta;
        delete b.trip;
        this.arrive(b);
      }
    }
    this.reinforce(projects);
  }

  /**
   * Приоритетным проектам не хватает рук, а свободных бригад нет — к ним переходят бригады, работающие на обычных
   * проектах (в пути не трогаем: машина в потоке исчезла бы посреди дороги). Сперва — с проекта, где бригад больше всех,
   * потом ближайшая к приоритетному, потом с меньшим номером. Приоритетные — по порядку закладки.
   */
  private reinforce(projects: number[]): void {
    const prio = this.host.priority;
    if (!prio) return;
    const per = CONSTRUCTION.brigade.perProject;
    for (const id of projects) {
      if (!prio(id)) continue;
      const s = this.host.site(id);
      if (!s) continue;
      while (this.assigned(id).length < per) {
        let best: { b: Brigade; n: number; d: number } | null = null;
        for (const b of this.brigades.values()) {
          if (b.state !== 'working' || b.project === undefined || prio(b.project)) continue;
          const n = this.assigned(b.project).length;
          const d = dist(this.where(b), s.pos);
          if (!best || n > best.n || (n === best.n && d < best.d - 1e-6)) best = { b, n, d };
        }
        if (!best) break;
        const b = best.b;
        b.project = id;
        b.state = 'going';
        this.launch(b);
      }
    }
  }

  /** Бригада без дела: к проекту, которому не хватает рук, иначе — домой. */
  private release(b: Brigade): void {
    if (b.sim !== undefined) {
      this.host.park(b.sim);
      delete b.sim;
    }
    // Ехала своим ходом — стоит, где успела доехать (оттуда и поедет дальше), а не на месте выезда.
    this.settle(b);
    delete b.project;
    b.state = b.pos ? 'back' : 'idle';
  }

  /** Свободной бригаде — проект: сначала приоритетный, потом где меньше всего бригад, ближайший, раньше заложенный. */
  private assign(b: Brigade, projects: number[]): void {
    let best: { id: number; top: boolean; n: number; d: number } | null = null;
    for (const id of projects) {
      const n = this.assigned(id).length;
      if (n >= CONSTRUCTION.brigade.perProject) continue;
      const s = this.host.site(id);
      if (!s) continue;
      const top = !!this.host.priority?.(id);
      const d = dist(this.where(b), s.pos);
      if (!best || (top && !best.top) || (top === best.top && (n < best.n || (n === best.n && d < best.d - 1e-6)))) best = { id, top, n, d };
    }
    if (!best) return;
    if (b.sim !== undefined) {
      this.host.park(b.sim);
      delete b.sim;
    }
    this.settle(b);
    b.project = best.id;
    b.state = 'going';
  }

  /**
   * В путь к проекту: по дороге, если до края работ можно доехать, иначе по бездорожью. Оба конца у дорог, но пути
   * между ними нет (сеть разорвана — часто проект её и соединяет) — тоже своим ходом: ждать дороги нельзя, её построит
   * только сама бригада. Путь есть, а на выезде нет места — пробуем в следующий такт.
   */
  private launch(b: Brigade): void {
    const s = b.project !== undefined ? this.host.site(b.project) : null;
    if (!s) return this.release(b);
    const from = this.from(b);
    if (from !== null && s.node !== null) {
      if (from === s.node) return this.arrive(b);
      const sim = this.host.drive(b, from, s.node);
      if (sim === 'busy') return;
      if (sim !== null) {
        b.sim = sim;
        return;
      }
    }
    this.offroad(b, s.pos);
  }

  /** Домой на базу: по дороге (если до ворот есть путь) или своим ходом. */
  private launchHome(b: Brigade): void {
    const base = this.bases.get(b.base);
    if (!base) return;
    const from = this.from(b);
    if (from !== null && from !== base.nodeId && this.host.onRoad(from) && this.host.onRoad(base.nodeId)) {
      const sim = this.host.drive(b, from, base.nodeId);
      if (sim === 'busy') return;
      if (sim !== null) {
        b.sim = sim;
        return;
      }
    }
    this.offroad(b, base.fp.center);
  }

  /**
   * База снесена: её бригады — на ближайшую из оставшихся (по расстоянию между базами, потом по номеру). Работающие
   * и едущие к стройке продолжают как были — у них лишь другая база; свободные выезжают от ворот снесённой базы к новой;
   * ехавшие домой своим ходом — от того места, куда успели доехать, к новой (settle), ехавшие машиной доедут до старых
   * ворот и поедут дальше (arrive). Других баз нет — бригады распускаются: возвращается их список (машины в пути убраны).
   */
  removeBase(id: number, gateOnRoad: boolean): Brigade[] {
    const old = this.bases.get(id);
    if (!old) return [];
    this.bases.delete(id);
    const list = this.of(id);
    const to = this.nearestBase(old.fp.center)?.base;
    if (!to) {
      for (const b of list) {
        if (b.sim !== undefined) this.host.park(b.sim);
        this.brigades.delete(b.id);
      }
      return list;
    }
    for (const b of list) {
      b.base = to.id;
      if (b.state === 'idle') {
        b.state = 'back';
        b.pos = { ...old.fp.center };
        if (gateOnRoad) b.at = old.nodeId;
        else delete b.at;
      } else if (b.state === 'back' && b.sim === undefined && b.eta !== undefined) this.settle(b);
    }
    return [];
  }

  /** Доехали (машиной или своим ходом). at — узел и точка, куда доехала машина (если машиной). */
  arrive(b: Brigade, at?: { node: number; pos: Vec }): void {
    delete b.sim;
    // Ехала домой на базу, которую снесли: доехала до её ворот — дальше к новой базе (launchHome в такте).
    const base = this.bases.get(b.base);
    if (b.state === 'back' && at && base && at.node !== base.nodeId) {
      b.at = at.node;
      b.pos = { ...at.pos };
      return;
    }
    if (b.state === 'going') {
      const s = b.project !== undefined ? this.host.site(b.project) : null;
      if (!s) return this.release(b);
      b.state = 'working';
      b.pos = s.pos;
      if (s.node !== null) b.at = s.node;
      else delete b.at;
    } else if (b.state === 'back') {
      b.state = 'idle';
      delete b.pos;
      delete b.at;
    }
  }

  /** Машина бригады потерялась (дорогу снесли) там, где машина была (at), — дальше оттуда своим ходом. */
  lost(b: Brigade, at?: Vec): void {
    delete b.sim;
    if (at) {
      b.pos = { ...at };
      delete b.at;
    }
    const to = this.target(b);
    if (to) this.offroad(b, to);
    else b.eta = this.host.time + 1;
  }

  /** Работающим бригадам — новое место (край работ сдвинулся). */
  follow(project: number, front: Vec, node: number | null): void {
    for (const b of this.working(project)) {
      b.pos = front;
      if (node !== null) b.at = node;
    }
  }

  /** Содержание всех бригад за месяц. */
  upkeep(): number {
    return Math.round(this.brigades.size * CONSTRUCTION.brigade.upkeep);
  }

  toSave(): CrewSave | undefined {
    if (!this.bases.size && !this.brigades.size && !this.firstUsed) return undefined;
    return {
      bases: [...this.bases.values()].map((b) => ({ ...b, fp: { ...b.fp, center: { ...b.fp.center } } })),
      // Машина в пути не сохраняется: после загрузки бригада выезжает заново оттуда, где была.
      brigades: [...this.brigades.values()].map(({ sim: _s, ...b }) => ({
        ...b,
        ...(b.pos ? { pos: { ...b.pos } } : {}),
        ...(b.trip ? { trip: { from: { ...b.trip.from }, to: { ...b.trip.to }, t0: b.trip.t0 } } : {}),
      })),
      nextBrigade: this.nextBrigade,
      ...(this.firstUsed ? { firstUsed: true as const } : {}),
    };
  }

  load(save: CrewSave | undefined): void {
    this.bases.clear();
    this.brigades.clear();
    this.nextBrigade = save?.nextBrigade ?? 1;
    for (const b of save?.bases ?? []) this.bases.set(b.id, { ...b });
    for (const b of save?.brigades ?? []) this.brigades.set(b.id, { ...b });
    this.firstUsed = !!save?.firstUsed;
    // Сохранение до сноса баз (без firstUsed и цен баз): базы тогда не сносились — первая поставленная (с меньшим
    // номером) была бесплатной, остальные — по цене базы.
    if (save && save.firstUsed === undefined && this.bases.size) {
      const first = Math.min(...this.bases.keys());
      for (const b of this.bases.values()) b.paid ??= b.id === first ? 0 : CONSTRUCTION.base.cost;
      this.firstUsed = true;
    }
  }
}
