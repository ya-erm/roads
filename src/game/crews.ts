/**
 * Строительные базы и бригады (режим «Со строительством», шаг 2 — docs/CONSTRUCTION.md): проект строится, только
 * пока на нём работает бригада (самосвал, грейдер, каток). Бригада приписана к базе; свободная едет с базы к стройке
 * по обычным дорогам — машиной в общем потоке (стоит в пробках), а где дороги до стройки нет — своим ходом по
 * бездорожью (CONSTRUCTION.offroad). Проект закончили, отменили или поставили на паузу — бригада едет к другому
 * проекту, которому не хватает рук, или домой на базу.
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
  /** Машина в потоке (id в симуляции) — не сохраняется: после загрузки бригада выезжает заново. */
  sim?: number;
}

export interface CrewSave {
  bases: BuildBase[];
  brigades: Omit<Brigade, 'sim'>[];
  nextBrigade: number;
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
  /** Куда ехать к проекту (null — проекта нет). */
  site(project: number): Site | null;
  /** Выпустить машину бригады от узла from к узлу to: id машины или null (нет пути или места на выезде). */
  drive(brigade: Brigade, from: number, to: number): number | null;
  /** Машина бригады больше не нужна (бригаду продали, база снесена). */
  park(sim: number): void;
  /** Узел есть в графе движения (туда можно доехать по дороге). */
  onRoad(node: number): boolean;
}

export class Crews {
  readonly bases = new Map<number, BuildBase>();
  readonly brigades = new Map<number, Brigade>();
  nextBrigade = 1;

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

  /** Где бригада сейчас (для выбора ближайшего проекта и выезда): последняя стройка или база. */
  private where(b: Brigade): Vec {
    return b.pos ?? this.bases.get(b.base)?.fp.center ?? { x: 0, y: 0 };
  }

  /** Узел, откуда бригада выедет: последняя стройка (если у дороги) или ворота базы. */
  private from(b: Brigade): number | null {
    if (b.at !== undefined && this.host.onRoad(b.at)) return b.at;
    const base = this.bases.get(b.base);
    return base ? base.nodeId : null;
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
        this.arrive(b);
      }
    }
  }

  /** Бригада без дела: к проекту, которому не хватает рук, иначе — домой. */
  private release(b: Brigade): void {
    if (b.sim !== undefined) {
      this.host.park(b.sim);
      delete b.sim;
    }
    delete b.eta;
    delete b.project;
    b.state = b.pos ? 'back' : 'idle';
  }

  /** Свободной бригаде — проект: где меньше всего бригад, потом ближайший, потом раньше заложенный. */
  private assign(b: Brigade, projects: number[]): void {
    let best: { id: number; n: number; d: number } | null = null;
    for (const id of projects) {
      const n = this.assigned(id).length;
      if (n >= CONSTRUCTION.brigade.perProject) continue;
      const s = this.host.site(id);
      if (!s) continue;
      const d = dist(this.where(b), s.pos);
      if (!best || n < best.n || (n === best.n && d < best.d - 1e-6)) best = { id, n, d };
    }
    if (!best) return;
    if (b.sim !== undefined) {
      this.host.park(b.sim);
      delete b.sim;
    }
    delete b.eta;
    b.project = best.id;
    b.state = 'going';
  }

  /** В путь к проекту: по дороге, если до края работ есть дорога, иначе по бездорожью. */
  private launch(b: Brigade): void {
    const s = b.project !== undefined ? this.host.site(b.project) : null;
    if (!s) return this.release(b);
    const from = this.from(b);
    if (from !== null && s.node !== null && from === s.node) return this.arrive(b);
    if (from !== null && s.node !== null) {
      const sim = this.host.drive(b, from, s.node);
      if (sim !== null) {
        b.sim = sim;
        return;
      }
    }
    // Нет дороги (или места на выезде — тогда попробуем в следующий такт, если дорога есть).
    if (from !== null && s.node !== null && this.host.onRoad(from) && this.host.onRoad(s.node)) return;
    b.eta = this.host.time + dist(this.where(b), s.pos) / CONSTRUCTION.offroad;
  }

  /** Домой на базу: по дороге или своим ходом. */
  private launchHome(b: Brigade): void {
    const base = this.bases.get(b.base);
    if (!base) return;
    const from = this.from(b);
    if (from !== null && from !== base.nodeId && this.host.onRoad(from) && this.host.onRoad(base.nodeId)) {
      const sim = this.host.drive(b, from, base.nodeId);
      if (sim !== null) {
        b.sim = sim;
        return;
      }
      return;
    }
    b.eta = this.host.time + dist(this.where(b), base.fp.center) / CONSTRUCTION.offroad;
  }

  /** Доехали (машиной или своим ходом). */
  arrive(b: Brigade): void {
    delete b.sim;
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

  /** Машина бригады потерялась (дорогу снесли) — дальше своим ходом. */
  lost(b: Brigade): void {
    delete b.sim;
    const to = b.state === 'back' ? this.bases.get(b.base)?.fp.center : b.project !== undefined ? this.host.site(b.project)?.pos : undefined;
    b.eta = this.host.time + (to ? dist(this.where(b), to) / CONSTRUCTION.offroad : 1);
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
    if (!this.bases.size && !this.brigades.size) return undefined;
    return {
      bases: [...this.bases.values()].map((b) => ({ ...b, fp: { ...b.fp, center: { ...b.fp.center } } })),
      // Машина в пути не сохраняется: после загрузки бригада выезжает заново оттуда, где была.
      brigades: [...this.brigades.values()].map(({ sim: _s, ...b }) => ({ ...b, ...(b.pos ? { pos: { ...b.pos } } : {}) })),
      nextBrigade: this.nextBrigade,
    };
  }

  load(save: CrewSave | undefined): void {
    this.bases.clear();
    this.brigades.clear();
    this.nextBrigade = save?.nextBrigade ?? 1;
    for (const b of save?.bases ?? []) this.bases.set(b.id, { ...b });
    for (const b of save?.brigades ?? []) this.brigades.set(b.id, { ...b });
  }
}
