/**
 * Строительные базы и бригады (режим «Со строительством», шаг 2 — docs/CONSTRUCTION.md): проект строится, только
 * пока на нём работает бригада (самосвал, грейдер, каток). Бригада приписана к базе; свободная едет с базы к стройке
 * только по готовым дорогам — колонной из трёх машин (отсыпка, покрытие, разметка; Convoy) в общем потоке (стоят в
 * пробках, выезжают по одной) — до узла проекта, куда есть подъезд (Site.node), а от него до края работ — по своей
 * полосе вдоль самой стройки (crewLane.ts; машины видно на оси проекта, carsAt). К участку на земле машины сходят на
 * стройку по одной, как доедут (boarding, board), и каждая берётся за свой этап, доехав до своего места (placed); у
 * моста и тоннеля доехавшие ждут остальных и сходят разом. По полю бригады не ездят: к проекту, до которого не доехать по дорогам ни от одной базы, бригада
 * не едет — проект ждёт подъезда (Construction.site — null). Проект закончили, отменили или поставили на паузу —
 * бригада едет вдоль стройки назад к дороге и дальше к другому проекту, которому не хватает рук, или домой на базу.
 * Направление полос для техники — не преграда (Host.step, crewRoads.ts): где по правилам не доехать (конец проекта у
 * одностороннего съезда «от проекта»), колонна проезжает короткий отрезок дороги против движения по её оси — как
 * вдоль стройки (walk; SiteTrip.to — узел, куда доедет), будто там стоит регулировщик.
 *
 * Где без перескока не обойтись: машину колонны потеряли (дорогу под ней снесли), до дома нет пути, старое
 * сохранение с поездкой по полю — бригада сразу оказывается на базе и выезжает оттуда заново.
 *
 * Приоритетный проект (Project.priority): свободная бригада едет сначала к нему; не хватает рук, а свободных нет —
 * к нему переходит бригада, работающая на обычном проекте (reinforce).
 *
 * Игрок может сам отправить бригаду на проект (send, карточка бригады «🎯 На стройку…»): она едет туда обычным путём,
 * а назначение закреплено (Brigade.pinned) — reinforce и trim её не трогают, пока проект не кончится, не встанет на
 * паузу или игрок не снимет закрепление (unpin, «↺ Авто»). Предел бригад на проект (cap) соблюдается и тут.
 *
 * Радиус обслуживания базы (CONSTRUCTION.serviceRadius, serves): автоматика (assign, reinforce) шлёт бригаду только на
 * проект, чей край работ её фронта или подъезд к нему (Site.pos, Site.gate) — в радиусе её базы; подходят бригады
 * нескольких баз — едет бригада ближайшей (closer). Вручную (send) — без ограничения. Бригада, что уже работает вне
 * радиуса (старое сохранение, назначил игрок и снял закрепление), доделывает свой фронт, но, когда он кончится, к
 * другому фронту вне радиуса не едет (relocate) — свободна.
 *
 * Темп этапа — сумма вкладов бригад, чья машина этого этапа на месте (placed): 1 / (1 + d / reach), d — от базы бригады до края работ (возит грунт
 * и асфальт); бригад на проекте — не больше brigade.perProject, на узком (полотно в одну полосу: съезд, заезд) — не
 * больше brigade.perNarrow (cap, constructionWork.crewCap; лишние отпускаются — trim). Содержание бригад — каждый
 * месяц (Game.monthEnd).
 *
 * Детерминизм: бригады перебираются по номеру, решения — по номерам и расстояниям, без случайности.
 */
import { CONSTRUCTION } from '../config';
import { dist, type Vec } from '../core/vec';
import type { BuildBase } from '../world/entities';
import { CREW_CARS, type CrewLane, crewSpacing, laneArcs, laneCarPose, laneCars, laneEntry, polyAt } from './crewLane';

export type BrigadeState = 'idle' | 'going' | 'working' | 'back';

export interface Brigade {
  id: number;
  /** База приписки. */
  base: number;
  state: BrigadeState;
  /** Проект, куда едет или где работает. */
  project?: number;
  /** Узел дороги, откуда бригада съехала на стройку (или где стоит); нет — на базе. */
  at?: number;
  /** Где бригада сейчас, если не на базе: у края работ, на стройке или у дороги. */
  pos?: Vec;
  /** Едет вдоль стройки — к какому времени доедет (секунды игры). */
  eta?: number;
  /** Едет вдоль стройки: по каким точкам и когда выехала — где она сейчас, считается по времени (walkAt). */
  trip?: SiteTrip;
  /** Колонна в потоке (машины в симуляции) — не сохраняется: после загрузки бригада выезжает заново. */
  convoy?: Convoy;
  /**
   * Фронт бригады на проекте — участок (полотно), который она строит или к которому едет, и с какого конца он
   * заполняется (Construction.frontFor, claim). У проекта может быть несколько фронтов — навстречу друг другу; каждый
   * участок строит один фронт. Нет — выберет, когда поедет.
   */
  front?: { corridor: number; fromB: boolean };
  /**
   * Полоса бригады на стройке (crewLane.ts): по ней машины от мест, где колонна собралась у подъезда, едут на свои
   * места в колонне этапов и работают — один непрерывный путь, без перескока. Нет — бригада не на стройке.
   */
  lane?: CrewLane;
  /**
   * Где машины колонны стоят вне потока (нос и курс, по номеру машины) — их отсюда и выпускают в поток (Host.driveFrom),
   * а не от узла. Ведёт игра (Game.updateCrewSpots); не сохраняется.
   */
  spots?: { pos: Vec; dir: Vec }[];
  /**
   * Проект (project) назначил игрок («🎯 На стройку…», Crews.send): автоматика (assign, reinforce, trim) бригаду с него
   * не снимает, пока проект не кончится, не встанет на паузу или игрок не нажмёт «↺ Авто» (Crews.unpin).
   */
  pinned?: true;
}

/**
 * Машины бригады — колонной, по порядку: техника отсыпки (грейдер и самосвал, головная), покрытия (укладчик и каток) и
 * разметки — те же машины, что работают на стройке (crewLane.CREW_UNITS; вид и скорость каждой — у игры, Game.drive).
 * Вдоль стройки машины едут друг за другом: от носа до носа — их длина и зазор (convoyOffset).
 */
export const CONVOY_CARS = CREW_CARS;

/** На сколько метров нос машины car колонны позади носа головной. */
export function convoyOffset(car: number): number {
  let s = 0;
  for (let k = 0; k < car; k++) s += crewSpacing(k);
  return s;
}

/**
 * Машина колонны: ещё не выехала (ждёт места на выезде), в потоке (id в симуляции) или доехала (стоит, где встала;
 * home — уже на базе, её не видно).
 */
export type ConvoyCar = { wait: true } | { sim: number } | { at: Vec; dir: Vec; home?: true };

/**
 * Колонна бригады в пути по дорогам: от узла from к узлу to. Машины выезжают по одной (следующая — когда на выезде
 * освободилось место), доехавшие ждут остальных там, где встали; бригада доехала, когда доехала последняя.
 */
export interface Convoy {
  from: number;
  to: number;
  cars: ConvoyCar[];
}

/** Поездка бригады вдоль стройки: по точкам path (ось проекта), выехала в t0, доедет в Brigade.eta. */
export interface SiteTrip {
  path: Vec[];
  t0: number;
  /** Назад к дороге (с края работ к узлу подъезда), а не к краю работ. */
  back?: true;
  /**
   * Не вдоль стройки, а по готовой дороге против движения (там, где по правилам не доехать, — Host.step): узел дороги,
   * куда доедет; оттуда — дальше по правилам или уже к стройке.
   */
  to?: number;
}

export interface CrewSave {
  bases: BuildBase[];
  brigades: Omit<Brigade, 'convoy'>[];
  nextBrigade: number;
  /** Первая (бесплатная) база уже была: снесли все — следующая снова платная. Нет в старых сохранениях. */
  firstUsed?: true;
}

/** Куда ехать к проекту: узел дороги, куда есть подъезд, и край работ (от узла до него — вдоль стройки, Host.path). */
export interface Site {
  node: number;
  pos: Vec;
  /** Где узел подъезда (node) на карте — для радиуса обслуживания базы (Crews.span); нет — считается по pos. */
  gate?: Vec;
}

/** Что бригадам нужно знать об игре. */
export interface CrewHost {
  readonly time: number;
  /** Проекты, которым нужны бригады: не на паузе и с недостроенным, по порядку закладки. */
  crewProjects(): number[];
  /** Приоритетный проект: бригады — сначала к нему, при нехватке — переходят к нему с обычных. */
  priority?(project: number): boolean;
  /** Сколько бригад встанет на проект (по ширине его полотен, constructionWork.crewCap); нет — brigade.perProject. */
  cap?(project: number): number;
  /**
   * Куда ехать к проекту (null — проекта нет или к нему нет подъезда по дорогам). С бригадой — к её фронту (свой
   * участок или ближайший, куда она доедет); без — к главному.
   */
  site(project: number, brigade?: Brigade): Site | null;
  /** Путь вдоль стройки от узла Site.node до края работ (фронта бригады): точки по оси проекта (null — проекта нет). */
  path(project: number, brigade?: Brigade): Vec[] | null;
  /** Бригада берётся за фронт проекта (Brigade.front) — тот, к которому поедет (site с ней). */
  claim?(project: number, brigade: Brigade): void;
  /** От узла from до узла to можно добраться по готовым дорогам (без учёта направления полос — см. step). */
  reach(from: number, to: number): boolean;
  /**
   * Следующий шаг пути от узла from к узлу to: по дорогам в потоке до узла drive или против движения вдоль дороги по
   * точкам walk до узла node (как будто там регулировщик); null — не добраться. Нет — всегда по дорогам до самой цели.
   */
  step?(from: number, to: number): { drive: number } | { walk: Vec[]; node: number } | null;
  /**
   * Выпустить машину колонны бригады (car — её номер в колонне, 0 — головная) от узла from к узлу to: id машины;
   * 'busy' — путь есть, но на выезде нет места (попробовать в следующий такт); null — пути по дорогам нет.
   */
  drive(brigade: Brigade, from: number, to: number, car: number): number | 'busy' | null;
  /**
   * Выпустить машину колонны car в поток прямо с места spot (нос и курс; она стоит на готовой дороге) к узлу to: id;
   * 'busy' — место занято; null — отсюда не выехать (не на дороге) — тогда от узла (drive).
   */
  driveFrom?(brigade: Brigade, car: number, spot: { pos: Vec; dir: Vec }, to: number): number | 'busy' | null;
  /**
   * Полоса бригады на проекте (crewLane.ts): от мест машин cars (нос и курс, по номеру; null — прямо позади начала
   * участка) к началу заполнения и по участку. null — не построить.
   */
  lane?(project: number, cars: readonly { pos: Vec; dir: Vec }[] | null, brigade: Brigade): CrewLane | null;
  /**
   * Места машин бригады на её полосе (м от начала полосы, по номеру машины) — у краёв этапов участка, что строится;
   * null — полоса не идёт по этому участку (участок сменился — бригаде туда своим ходом, relocate).
   */
  slots?(brigade: Brigade): number[] | null;
  /**
   * Машины бригады, доехав до узла подъезда, могут сходить на стройку по одной, не дожидаясь остальных (Crews.board):
   * участок у подъезда — на земле, и места этапов — впереди начала заполнения (там, где их ждут, хватает места всей
   * колонне). Нет или false — колонна собирается у подъезда целиком, как раньше.
   */
  stagger?(project: number, brigade: Brigade): boolean;
  /** Машина бригады больше не нужна (бригаду продали, база снесена). */
  park(sim: number): void;
  /** Узел есть в графе движения (туда можно доехать по дороге). */
  onRoad(node: number): boolean;
}

/** Длина ломаной. */
function pathLength(path: readonly Vec[]): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += dist(path[i - 1], path[i]);
  return s;
}

/** Точка ломаной в s метрах от начала и направление участка там. */
function pointOnPath(path: readonly Vec[], s: number): { pos: Vec; dir: Vec } {
  let left = Math.max(0, s);
  let dir = { x: 1, y: 0 };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const d = dist(a, b);
    if (d < 1e-9) continue;
    dir = { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
    if (left <= d) return { pos: { x: a.x + dir.x * left, y: a.y + dir.y * left }, dir };
    left -= d;
  }
  return { pos: { ...(path[path.length - 1] ?? { x: 0, y: 0 }) }, dir };
}

/** Начало ломаной — первые s метров. */
function pathHead(path: readonly Vec[], s: number): Vec[] {
  const out: Vec[] = [];
  let left = s;
  for (let i = 0; i < path.length; i++) {
    if (i === 0) {
      out.push({ ...path[0] });
      continue;
    }
    const d = dist(path[i - 1], path[i]);
    if (left <= d) {
      out.push(pointOnPath([path[i - 1], path[i]], left).pos);
      return out;
    }
    out.push({ ...path[i] });
    left -= d;
  }
  return out;
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

  /** Убрать бригаду (свободную — первой): машины в пути исчезают. */
  dismiss(base: number): Brigade | null {
    const list = this.of(base);
    const crew = list.find((b) => b.state === 'idle') ?? list[list.length - 1];
    if (!crew) return null;
    this.parkAll(crew);
    this.brigades.delete(crew.id);
    return crew;
  }

  /** Колонна больше не нужна: машины в потоке — с дороги долой. */
  private parkAll(b: Brigade): void {
    for (const car of b.convoy?.cars ?? []) if ('sim' in car) this.host.park(car.sim);
    delete b.convoy;
  }

  /** Бригада больше не на стройке и машины не стоят нигде вне потока: полоса и места забыты. */
  private offSite(b: Brigade): void {
    delete b.lane;
    delete b.spots;
  }

  /** Полоса бригады на проекте: от мест машин (spots; нет — прямо позади начала участка). */
  private makeLane(b: Brigade, project: number): void {
    const lane = this.host.lane?.(project, b.spots?.length === CONVOY_CARS ? b.spots : null, b) ?? null;
    if (lane) b.lane = lane;
    else delete b.lane;
  }

  /** В путь колонной по дорогам от узла from к узлу to: машины выезжают по одной (rollOut в такте). */
  private setOff(b: Brigade, from: number, to: number): true {
    b.convoy = { from, to, cars: Array.from({ length: CONVOY_CARS }, () => ({ wait: true as const })) };
    return true;
  }

  /**
   * Следующая машина колонны — на дорогу, если на выезде есть место (иначе — в следующий такт): по одной за такт, по
   * порядку. false — пути по дорогам больше нет (колонна убрана).
   */
  private rollOut(b: Brigade): boolean {
    const cv = b.convoy;
    if (!cv) return true;
    const k = cv.cars.findIndex((c) => 'wait' in c);
    if (k < 0) return true;
    // Машина стоит на готовой дороге (кончили участок, собрались у подъезда) — выезжает прямо оттуда, а не от узла.
    const spot = b.spots?.[k];
    let sim = spot && this.host.driveFrom ? this.host.driveFrom(b, k, spot, cv.to) : null;
    if (sim === null) sim = this.host.drive(b, cv.from, cv.to, k);
    if (sim === 'busy') return true;
    if (sim === null) {
      this.parkAll(b);
      return false;
    }
    cv.cars[k] = { sim };
    if (cv.cars.every((c) => !('wait' in c))) delete b.spots;
    return true;
  }

  /** Головная машина колонны в потоке (id в симуляции) — её показывает «где бригада»; колонны нет — undefined. */
  lead(b: Brigade): number | undefined {
    for (const car of b.convoy?.cars ?? []) if ('sim' in car) return car.sim;
    return undefined;
  }

  /**
   * Машины бригады, которых нет в потоке, — где их рисовать. На стройке (полоса, lane) — по своей полосе: от мест, где
   * колонна собралась у подъезда, к своим местам в колонне этапов (Host.slots) и дальше вместе с ними (s — где на
   * полосе). Вдоль стройки к дороге или против движения (trip) — колонной по оси (головная — walkAt, следующие — на
   * convoyOffset позади, у начала — по продолжению пути назад). Ждут выезда в поток — там, где стоят (spots); доехавшие
   * по дороге — где встали, пока не собрались остальные. car — номер машины в колонне.
   */
  carsAt(b: Brigade): { car: number; pos: Vec; dir: Vec; s?: number }[] {
    const out: { car: number; pos: Vec; dir: Vec; s?: number }[] = [];
    const slots = b.lane && b.state !== 'back' ? this.host.slots?.(b) : null;
    if (b.lane && slots) {
      // На полосе — первые n машин (сошли по одной, board); остальные ещё в потоке или ждут у подъезда своей очереди.
      const n = laneCars(b.lane);
      laneArcs(b.lane, slots, this.host.time)
        .slice(0, n)
        .forEach((s, i) => out.push({ car: i, ...laneCarPose(b.lane!, i, s), s }));
      b.convoy?.cars.forEach((c, i) => {
        if (i >= n && 'at' in c && !c.home) out.push({ car: i, pos: c.at, dir: c.dir });
      });
      return out;
    }
    if (b.eta !== undefined && b.trip) {
      const { path, t0 } = b.trip;
      const len = pathLength(path);
      const k = b.eta > t0 ? Math.max(0, Math.min(1, (this.host.time - t0) / (b.eta - t0))) : 1;
      for (let i = 0; i < CONVOY_CARS; i++) out.push({ car: i, ...polyAt(path, len * k - convoyOffset(i)) });
      return out;
    }
    b.convoy?.cars.forEach((c, i) => {
      if ('at' in c && !c.home) out.push({ car: i, pos: c.at, dir: c.dir });
      else if ('wait' in c && b.spots?.[i]) out.push({ car: i, pos: b.spots[i].pos, dir: b.spots[i].dir });
    });
    // Стоят на местах, а в путь ещё не собрались (проект кончился — выедут в поток с мест в этом такте).
    if (!b.convoy && b.spots) b.spots.forEach((m, i) => out.push({ car: i, pos: m.pos, dir: m.dir }));
    return out;
  }

  /** Бригада на своей полосе: запомнить, где сейчас её машины (spots — отсюда они выедут в поток). */
  keepSpots(b: Brigade): void {
    const cars = this.carsAt(b);
    if (cars.length === CONVOY_CARS && cars.every((m) => m.s !== undefined)) b.spots = cars.map((m) => ({ pos: { ...m.pos }, dir: { ...m.dir } }));
  }

  /**
   * Чьи машины бригады b на месте работ — по этапам (отсыпка, покрытие, разметка): машина этапа сошла на полосу и
   * доехала до своего места в колонне этапов (Host.slots). Темп этапа — только от бригад, чья машина этого этапа на
   * месте (Construction.advance): первая машина начинает отсыпку, не дожидаясь остальных. Бригада не на работе — ничья;
   * без полосы (старое сохранение, проверки без игры) или участок не на её полосе — все на месте, как раньше.
   */
  placed(b: Brigade): [boolean, boolean, boolean] {
    if (b.state !== 'working') return [false, false, false];
    const slots = b.lane ? this.host.slots?.(b) : null;
    if (!b.lane || !slots) return [true, true, true];
    const n = laneCars(b.lane);
    const s = laneArcs(b.lane, slots, this.host.time);
    return [0, 1, 2].map((k) => k < n && s[k] >= slots[k] - 0.5) as [boolean, boolean, boolean];
  }

  /** Сколько бригад едут к проекту или работают на нём. */
  assigned(project: number): Brigade[] {
    return [...this.brigades.values()].filter((b) => b.project === project && (b.state === 'going' || b.state === 'working'));
  }

  /** Сколько бригад встанет на проект: на узком (полотно в одну полосу) — меньше (Host.cap). */
  cap(project: number): number {
    return this.host.cap?.(project) ?? CONSTRUCTION.brigade.perProject;
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

  /**
   * Как далеко стройка от базы base для радиуса обслуживания: по прямой от центра базы до края работ (Site.pos) или до
   * подъезда (Site.gate) — что ближе. Базы нет — бесконечно.
   */
  span(base: number, s: Site): number {
    const b = this.bases.get(base);
    if (!b) return Infinity;
    const d = dist(b.fp.center, s.pos);
    return s.gate ? Math.min(d, dist(b.fp.center, s.gate)) : d;
  }

  /** Стройка (её фронт s) — в радиусе обслуживания базы base (CONSTRUCTION.serviceRadius): автоматика шлёт туда бригады. */
  serves(base: number, s: Site): boolean {
    return this.span(base, s) <= CONSTRUCTION.serviceRadius + 1e-6;
  }

  /** Бригада свободна для автоматики: на базе или едет домой не машиной (assign её возьмёт). */
  private free(b: Brigade): boolean {
    return b.state === 'idle' || (b.state === 'back' && !b.convoy);
  }

  /** Куда бригаде b ехать на проект id, если автоматика может её туда послать: место есть, доедет, в радиусе базы. */
  private fit(b: Brigade, id: number): Site | null {
    if (this.assigned(id).length >= this.cap(id)) return null;
    const s = this.host.site(id, b);
    // К проекту без подъезда (или куда ей не доехать по дорогам) бригада не едет; вне радиуса её базы — тоже.
    return s && this.canReach(b, s.node) && this.serves(b.base, s) ? s : null;
  }

  /**
   * На проект id может поехать свободная бригада другой, более близкой базы (span меньше; при равенстве — база с
   * меньшим номером): тогда b его уступает — едет бригада ближайшей базы. Бригады одной базы друг другу не мешают.
   */
  private closer(b: Brigade, id: number, s: Site): boolean {
    const mine = this.span(b.base, s);
    for (const o of this.brigades.values()) {
      if (o === b || o.base === b.base || !this.free(o)) continue;
      const t = this.fit(o, id);
      if (!t) continue;
      const d = this.span(o.base, t);
      if (d < mine - 1e-6 || (Math.abs(d - mine) <= 1e-6 && o.base < b.base)) return true;
    }
    return false;
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
    return this.rateOf(this.working(project), front);
  }

  /** Темп фронта: сумма вкладов его бригад list у края работ front (сильнейшая — во всю силу, следующие — долями). */
  rateOf(list: readonly Brigade[], front: Vec): number {
    // Сильнейшая бригада — во всю силу, следующие — долями CONSTRUCTION.crewShare.
    const powers = list.map((b) => this.power(b, front)).sort((a, b) => b - a);
    const share = CONSTRUCTION.crewShare;
    return powers.reduce((k, p, i) => k + p * (share[i] ?? share[share.length - 1]), 0);
  }

  /** Где бригада сейчас (для выбора ближайшего проекта): едет вдоль стройки — где успела доехать, иначе где стоит. */
  private where(b: Brigade): Vec {
    return this.walkAt(b)?.pos ?? b.pos ?? this.bases.get(b.base)?.fp.center ?? { x: 0, y: 0 };
  }

  /**
   * Узел, откуда бригада выедет по дороге: на базе — ворота; вне базы — узел дороги, с которого съехала на стройку
   * (или где стоит). Такого нет или он уже не дорога — null: бригада сперва окажется на базе.
   */
  private from(b: Brigade): number | null {
    if (b.pos || b.at !== undefined) return b.at !== undefined && this.host.onRoad(b.at) ? b.at : null;
    const base = this.bases.get(b.base);
    return base ? base.nodeId : null;
  }

  /** Узел, откуда бригада поедет: где стоит, а не у дороги — ворота базы (туда её перенесёт launch). */
  private startNode(b: Brigade): number | null {
    return this.from(b) ?? this.bases.get(b.base)?.nodeId ?? null;
  }

  /** Узел, откуда бригада поедет к проекту (startNode); едет колонной — оттуда, куда едет. */
  startOf(b: Brigade): number | null {
    return b.convoy?.to ?? this.startNode(b);
  }

  /** Бригада доедет до узла node по готовым дорогам оттуда, где стоит. */
  private canReach(b: Brigade, node: number): boolean {
    const from = this.startNode(b);
    return from !== null && (from === node || this.host.reach(from, node));
  }

  /** Бригада едет вдоль стройки — где она сейчас и куда смотрит (по времени от выезда до eta); не едет — null. */
  walkAt(b: Brigade): { pos: Vec; dir: Vec } | null {
    if (b.eta === undefined || !b.trip) return null;
    const { path, t0 } = b.trip;
    const k = b.eta > t0 ? Math.max(0, Math.min(1, (this.host.time - t0) / (b.eta - t0))) : 1;
    return pointOnPath(path, pathLength(path) * k);
  }

  /**
   * В путь вдоль стройки по точкам path: к краю работ или (back) назад к дороге. Путь короче метра — уже на месте
   * (false).
   */
  private walk(b: Brigade, path: Vec[] | null, back = false, to?: number): boolean {
    const len = path ? pathLength(path) : 0;
    if (!path || len < 1) return false;
    b.trip = { path: path.map((p) => ({ ...p })), t0: this.host.time, ...(back ? { back: true as const } : {}), ...(to !== undefined ? { to } : {}) };
    b.eta = this.host.time + len / CONSTRUCTION.onSite;
    b.pos = { ...path[0] };
    // Машины уже не там, где стояли (кроме поездки к краю работ по своей полосе — там места ведёт она сама).
    if (!b.lane) delete b.spots;
    return true;
  }

  /** Такт: решения бригад и поездки вдоль строек. */
  tick(): void {
    if (!this.brigades.size) return;
    const projects = this.host.crewProjects();
    const live = new Set(projects);
    for (const b of this.brigades.values()) {
      // Проект кончился, отменён, на паузе или к нему больше нет подъезда — бригада свободна.
      if ((b.state === 'going' || b.state === 'working') && (b.project === undefined || !live.has(b.project) || !this.host.site(b.project, b))) this.release(b);
      // Свободна или едет домой не машиной — может сразу взяться за другой проект.
      if (b.state === 'idle' || (b.state === 'back' && !b.convoy)) this.assign(b, projects);
      if (b.state === 'going' && !b.convoy && b.eta === undefined) this.launch(b);
      if (b.state === 'back' && !b.convoy && b.eta === undefined) this.launchHome(b);
      // Колонна выезжает по одной машине; пути больше нет — к стройке бригада свободна, домой — сразу на базе.
      if (b.convoy && !this.rollOut(b)) {
        if (b.state === 'going') this.release(b);
        else this.home(b);
      }
      // Вдоль стройки доехали.
      if (b.eta !== undefined && this.host.time >= b.eta) this.walked(b);
    }
    this.trim(projects);
    this.reinforce(projects);
  }

  /**
   * На проекте бригад больше, чем на нём встанет (cap: проект узкий, а бригады назначили раньше — старое сохранение,
   * правка конфига), — лишние отпускаются: едут вдоль стройки назад к дороге и оттуда к другому проекту или домой
   * (release), без перескока. Сперва — те, что ещё едут, потом с большим номером; колонну в потоке не трогаем (машины
   * исчезли бы посреди дороги) — отпустится, когда доедет.
   */
  private trim(projects: number[]): void {
    for (const id of projects) {
      const list = this.assigned(id);
      const extra = list.length - this.cap(id);
      if (extra <= 0) continue;
      // Назначенных игроком (pinned) не отпускаем: их ставят только туда, где есть место.
      const free = list.filter((b) => !b.convoy && !b.pinned).sort((x, y) => (x.state === y.state ? y.id - x.id : x.state === 'going' ? -1 : 1));
      for (const b of free.slice(0, extra)) this.release(b);
    }
  }

  /**
   * Приоритетным проектам не хватает рук, а свободных бригад нет — к ним переходят бригады, работающие на обычных
   * проектах (в пути не трогаем: машина в потоке исчезла бы посреди дороги) и доезжающие до них по дорогам. Сперва —
   * с проекта, где бригад больше всех, потом ближайшая к приоритетному, потом с меньшим номером. Приоритетные — по
   * порядку закладки.
   */
  private reinforce(projects: number[]): void {
    const prio = this.host.priority;
    if (!prio) return;
    for (const id of projects) {
      if (!prio(id)) continue;
      if (!this.host.site(id)) continue;
      const per = this.cap(id);
      while (this.assigned(id).length < per) {
        let best: { b: Brigade; n: number; d: number } | null = null;
        for (const b of this.brigades.values()) {
          // Часть колонны ещё в пути (сходят на стройку по одной) — её машины в потоке не трогаем.
          if (b.state !== 'working' || b.convoy || b.project === undefined || b.pinned || prio(b.project)) continue;
          // К какому фронту приоритетного она поедет (доедет ли туда по дорогам, в радиусе ли он её базы).
          const s = this.host.site(id, b);
          if (!s || !this.canReach(b, s.node) || !this.serves(b.base, s)) continue;
          const n = this.assigned(b.project).length;
          const d = dist(this.where(b), s.pos);
          if (!best || n > best.n || (n === best.n && d < best.d - 1e-6)) best = { b, n, d };
        }
        if (!best) break;
        const b = best.b;
        // Сперва вдоль своей стройки назад к дороге, оттуда — к приоритетному (launch в такте).
        const back = this.pathBack(b);
        b.project = id;
        delete b.front;
        b.state = 'going';
        if (!back || !this.walk(b, back.path, true)) this.launch(b);
      }
    }
  }

  /** Путь работающей бригады назад к дороге — вдоль стройки от края работ к узлу подъезда (он же — новый b.at). */
  private pathBack(b: Brigade): { path: Vec[]; node: number } | null {
    if (b.state !== 'working' || b.project === undefined) return null;
    const s = this.host.site(b.project, b);
    const path = s && this.host.path(b.project, b);
    if (!s || !path) return null;
    b.at = s.node;
    // Часть колонны ещё ехала к стройке (сходят по одной) — назад едет вся колонна вдоль стройки.
    this.parkAll(b);
    this.offSite(b);
    return { path: [...path].reverse(), node: s.node };
  }

  /**
   * Бригада без дела: к проекту, которому не хватает рук, иначе — домой. Работала у края, а проект ещё есть (пауза,
   * подъезд пропал) — сперва вдоль стройки назад к дороге; ехала вдоль стройки — назад по пройденному. Проект достроен
   * — машины стоят на уже открытой дороге: выезжают в поток прямо с мест (spots), а не от узла.
   */
  private release(b: Brigade): void {
    this.parkAll(b);
    const back = this.walkBack(b) ?? this.pathBack(b)?.path ?? null;
    delete b.lane;
    delete b.project;
    delete b.front;
    // Проект кончился, на паузе или к нему не подъехать — назначение игрока тоже кончилось.
    delete b.pinned;
    if (!b.pos && b.at === undefined) {
      b.state = 'idle';
      return;
    }
    b.state = 'back';
    if (back) this.walk(b, back, true);
  }

  /** Едет вдоль стройки — остановиться, где успела доехать; ответ — путь назад к дороге (пройденное, наоборот). */
  private walkBack(b: Brigade): Vec[] | null {
    const trip = b.trip;
    const at = this.walkAt(b);
    const eta = b.eta;
    delete b.eta;
    delete b.trip;
    if (!trip || !at || eta === undefined) return null;
    this.offSite(b);
    b.pos = at.pos;
    // Пройдено — по времени, той же долей пути, что и walkAt. Ехала к дороге — к ней же и дальше (остаток пути).
    const k = eta > trip.t0 ? Math.max(0, Math.min(1, (this.host.time - trip.t0) / (eta - trip.t0))) : 1;
    const total = pathLength(trip.path);
    if (trip.back) return pathHead([...trip.path].reverse(), total * (1 - k)).reverse();
    return pathHead(trip.path, total * k).reverse();
  }

  /**
   * Свободной бригаде — проект в радиусе её базы (fit), если на него не едет бригада более близкой базы (closer):
   * сначала приоритетный, потом где меньше всего бригад, ближайший, раньше заложенный.
   */
  private assign(b: Brigade, projects: number[]): void {
    let best: { id: number; top: boolean; n: number; d: number } | null = null;
    for (const id of projects) {
      const s = this.fit(b, id);
      if (!s) continue;
      const n = this.assigned(id).length;
      const top = !!this.host.priority?.(id);
      const d = dist(this.where(b), s.pos);
      const better = !best || (top && !best.top) || (top === best.top && (n < best.n || (n === best.n && d < best.d - 1e-6)));
      // Уступить бригаде ближней базы — проверяем, только если проект и так лучший (дешевле, а выбор тот же).
      if (better && !this.closer(b, id, s)) best = { id, top, n, d };
    }
    if (!best) return;
    this.parkAll(b);
    // Ехала вдоль стройки назад к дороге — доедет до неё, оттуда и выедет (launch после поездки).
    const back = this.walkBack(b);
    b.project = best.id;
    delete b.front;
    b.state = 'going';
    if (back) this.walk(b, back, true);
  }

  /** Бригада на базе (перенос: без дороги ей оттуда не выехать). */
  private home(b: Brigade): void {
    this.parkAll(b);
    this.offSite(b);
    delete b.pos;
    delete b.at;
    delete b.eta;
    delete b.trip;
    if (b.state === 'back') b.state = 'idle';
  }

  /**
   * В путь к проекту: по дорогам до узла подъезда (Site.node), оттуда — вдоль стройки к краю работ. Уже у этого узла —
   * сразу вдоль стройки. Стоит не у дороги — сперва на базу. Путь есть, а на выезде нет места — пробуем в следующий
   * такт; пути по дорогам нет — бригада свободна (к проекту ей не доехать).
   */
  private launch(b: Brigade): void {
    const s = b.project !== undefined ? this.host.site(b.project, b) : null;
    if (!s) return this.release(b);
    // Едет к этому фронту — он её (другие бригады выберут свой или присоединятся).
    this.host.claim?.(b.project!, b);
    let from = this.from(b);
    if (from === null) {
      this.home(b);
      from = this.from(b);
    }
    if (from === null) return;
    if (from === s.node) return this.onSite(b, s);
    if (!this.go(b, from, s.node)) return this.release(b);
  }

  /**
   * Шаг пути от узла from к узлу to (Host.step): колонной по дорогам в потоке — или, где по правилам не доехать, по
   * дороге против движения вдоль её оси (как вдоль стройки, walk; trip.to — куда доедет), оттуда — следующий шаг.
   * false — не добраться.
   */
  private go(b: Brigade, from: number, to: number): boolean {
    const step = this.host.step ? this.host.step(from, to) : this.host.reach(from, to) ? { drive: to } : null;
    if (!step) return false;
    if ('drive' in step) return this.setOff(b, from, step.drive);
    b.at = from;
    // Отрезок короче метра — уже там: следующий шаг — в следующий такт.
    if (!this.walk(b, step.walk, false, step.node)) {
      b.at = step.node;
      b.pos = { ...(step.walk[step.walk.length - 1] ?? b.pos ?? { x: 0, y: 0 }) };
    }
    return true;
  }

  /**
   * Бригада у узла подъезда: вдоль стройки к краю работ, а край рядом — сразу за работу. Машины едут по полосе
   * бригады (makeLane) от мест, где колонна собралась, прямо на свои места в колонне этапов.
   */
  private onSite(b: Brigade, s: Site): void {
    b.at = s.node;
    if (b.project !== undefined) {
      this.host.claim?.(b.project, b);
      this.makeLane(b, b.project);
    }
    // По своей полосе машины едут к своим местам сами (carsAt) и берутся за свой этап, как доехали (placed) — бригада
    // сразу на работе; без полосы — колонной вдоль стройки к краю работ, там и за работу.
    if (!b.lane && b.project !== undefined && this.walk(b, this.host.path(b.project, b))) return;
    this.work(b, s);
  }

  /**
   * Машины колонны едут к стройке и сходят на неё по одной (Host.stagger): машина, доехавшая до узла подъезда node,
   * не ждёт остальных. Та, что уже сошла, на полосе бригады — дальше сама; что ещё в пути — доедут и сойдут следом.
   */
  boarding(b: Brigade, node: number): boolean {
    if (b.project === undefined || !b.convoy || b.convoy.to !== node) return false;
    if (b.state === 'working') return !!b.lane && laneCars(b.lane) < CONVOY_CARS;
    if (b.state !== 'going' || b.lane || !this.host.lane || !this.host.stagger?.(b.project, b)) return false;
    return this.host.site(b.project, b)?.node === node;
  }

  /**
   * Доехавшие до подъезда машины (стоят там, 'at') — на полосу бригады по порядку колонны, пока впереди никого не
   * ждут: первая строит полосу от места, где сошла с дороги (Host.lane), — бригада на работе, а её машина едет к своему
   * месту и начинает свой этап; следующие сходят на ту же полосу (laneEntry) со своих мест. На полосе все — колонна
   * больше не в пути. false — полосу не построить: колонна собирается у подъезда целиком, как раньше.
   */
  private board(b: Brigade): boolean {
    const cv = b.convoy;
    if (!cv || b.project === undefined) return false;
    let n = b.lane ? laneCars(b.lane) : 0;
    while (n < CONVOY_CARS) {
      const car = cv.cars[n];
      if (!car || !('at' in car)) break;
      if (!b.lane) {
        const s = this.host.site(b.project, b);
        if (!s) return false;
        b.at = s.node;
        this.host.claim?.(b.project, b);
        const lane = this.host.lane?.(b.project, [{ pos: car.at, dir: car.dir }], b) ?? null;
        if (!lane) return false;
        b.lane = lane;
        b.state = 'working';
        b.pos = { ...s.pos };
      } else {
        const lane = b.lane;
        const e = laneEntry(lane, car.at);
        const t0 = lane.t0 ?? this.host.time;
        lane.from = [...(lane.from ?? []), e.s];
        lane.t = [...(lane.t ?? lane.from.slice(0, -1).map(() => t0)), this.host.time];
        if (Math.abs(e.side) > 0.05 || lane.side) lane.side = [...(lane.side ?? lane.from.slice(0, -1).map(() => 0)), Math.abs(e.side) > 0.05 ? e.side : 0];
      }
      n++;
    }
    if (n >= CONVOY_CARS) delete b.convoy;
    return true;
  }

  /** За работу у края: стоит там, съехала с дороги у узла подъезда. */
  private work(b: Brigade, s: Site): void {
    b.state = 'working';
    b.pos = { ...s.pos };
    b.at = s.node;
    if (!b.lane && b.project !== undefined) this.makeLane(b, b.project);
  }

  /**
   * Полоса бригады больше не идёт по участку, что строится (тот кончился, а следующий начинается не от его конца):
   * машины стоят на только что открытой дороге у узла node — оттуда своим ходом к новому участку (launch: колонной в
   * потоке прямо с мест, spots, или сразу по стройке, если подъезд — этот же узел). Без перескока.
   */
  relocate(b: Brigade, node: number): void {
    delete b.lane;
    delete b.eta;
    delete b.trip;
    b.at = node;
    if (b.state === 'working') b.state = 'going';
    // Свой фронт доделан, а следующий — вне радиуса базы (работала там со старого сохранения или после «↺ Авто»):
    // автоматика туда не шлёт — бригада свободна (поедет к проекту в радиусе или домой). Назначенная игроком — едет.
    if (b.state !== 'going' || b.pinned || b.project === undefined) return;
    const s = this.host.site(b.project, b);
    if (s && !this.serves(b.base, s)) this.release(b);
  }

  /** Вдоль стройки доехали: к краю работ — за работу, назад к дороге — дальше по дорогам (launch / launchHome). */
  private walked(b: Brigade): void {
    const trip = b.trip;
    const end = trip?.path[trip.path.length - 1];
    // Доехали до дороги (против движения или назад вдоль стройки) — машины стоят колонной в конце пути: отсюда и
    // поедут дальше (spots; дальше в потоке — прямо с мест, по стройке — по своей полосе от них).
    if (trip && (trip.back || trip.to !== undefined) && !b.lane) {
      const len = pathLength(trip.path);
      b.spots = Array.from({ length: CONVOY_CARS }, (_, i) => polyAt(trip.path, len - convoyOffset(i)));
    }
    delete b.eta;
    delete b.trip;
    if (end) b.pos = { ...end };
    // Доехала против движения до узла дороги — оттуда дальше (launch / launchHome в такте).
    if (trip?.to !== undefined) {
      b.at = trip.to;
      return;
    }
    if (b.state !== 'going' || trip?.back) return;
    const s = b.project !== undefined ? this.host.site(b.project, b) : null;
    if (!s) return this.release(b);
    this.work(b, s);
  }

  /** Домой на базу: по дорогам до ворот; не у дороги или пути до ворот нет — сразу на базе. */
  private launchHome(b: Brigade): void {
    const base = this.bases.get(b.base);
    if (!base) return;
    const from = this.from(b);
    if (from === null || from === base.nodeId || !this.go(b, from, base.nodeId)) this.home(b);
  }

  /**
   * База снесена: её бригады — на ближайшую из оставшихся (по расстоянию между базами, потом по номеру). Работающие
   * и едущие к стройке продолжают как были — у них лишь другая база; свободные выезжают от ворот снесённой базы к новой
   * (ворота не у дороги — сразу на новой), ехавшие машиной доедут до старых ворот и поедут дальше (arrive). Других баз
   * нет — бригады распускаются: возвращается их список (машины в пути убраны).
   */
  removeBase(id: number, gateOnRoad: boolean): Brigade[] {
    const old = this.bases.get(id);
    if (!old) return [];
    this.bases.delete(id);
    const list = this.of(id);
    const to = this.nearestBase(old.fp.center)?.base;
    if (!to) {
      for (const b of list) {
        this.parkAll(b);
        this.brigades.delete(b.id);
      }
      return list;
    }
    for (const b of list) {
      b.base = to.id;
      if (b.state === 'idle' && gateOnRoad) {
        b.state = 'back';
        b.pos = { ...old.fp.center };
        b.at = old.nodeId;
      }
    }
    return [];
  }

  /**
   * База id переехала (игрок перенёс её или отодвинула расширенная улица); from — где стояла и её прежние ворота.
   * Работающие и едущие к стройке продолжают как были — домой вернутся уже к новым воротам (ехавшие машиной к
   * старым доедут до них и поедут дальше, как при сносе базы). Свободные на базе едут к новым воротам колонной по
   * дорогам, а не перескоком, — если ворота сменились, старые у дороги и от них до новых можно доехать; иначе (или
   * ворота те же) остаются на базе.
   */
  moveBase(id: number, from: { pos: Vec; node: number }): void {
    const base = this.bases.get(id);
    if (!base || from.node === base.nodeId || !this.host.onRoad(from.node) || !this.host.reach(from.node, base.nodeId)) return;
    for (const b of this.of(id)) {
      if (b.state !== 'idle' || b.pos || b.at !== undefined) continue;
      b.state = 'back';
      b.pos = { ...from.pos };
      b.at = from.node;
    }
  }

  /** Машина sim — из колонны бригады b (в потоке). */
  owns(b: Brigade, sim: number): boolean {
    return !!b.convoy?.cars.some((c) => 'sim' in c && c.sim === sim);
  }

  /**
   * Машина колонны доехала (Game.onArrive): at — узел и точка, куда (dir — куда смотрит), sim — какая машина. Пока
   * доехали не все, она ждёт остальных там, где встала (carsAt); доехала последняя — бригада на месте (sim не задан —
   * сразу вся колонна). К стройке — дальше вдоль неё к краю работ (узел подъезда за время пути сменился — по дорогам
   * дальше, launch); домой — на базе (ехала к воротам снесённой базы — дальше к новой, launchHome в такте).
   */
  arrive(b: Brigade, at?: { node: number; pos: Vec; dir?: Vec }, sim?: number): void {
    const cv = b.convoy;
    const base = this.bases.get(b.base);
    if (cv && sim !== undefined && at) {
      const i = cv.cars.findIndex((c) => 'sim' in c && c.sim === sim);
      // Домой: доехавшая до ворот машина уже на базе — её не видно (не стоит у ворот на других).
      const home = b.state === 'back' && !!base && at.node === base.nodeId;
      // К стройке по одной (boarding): доехавшая машина сходит на полосу бригады, как только впереди по колонне все
      // уже там, и едет к своему месту — остальных не ждёт.
      const one = !home && i >= 0 && this.boarding(b, at.node);
      if (i >= 0) cv.cars[i] = { at: { ...at.pos }, dir: { ...(at.dir ?? { x: 1, y: 0 }) }, ...(home ? { home: true as const } : {}) };
      if (one && this.board(b)) return;
      if (cv.cars.some((c) => !('at' in c))) return;
      // Собрались: дальше машины едут оттуда, где встали (по стройке — по полосе бригады, по дорогам — с мест).
      if (!home && cv.cars.length === CONVOY_CARS) b.spots = cv.cars.map((c) => ('at' in c ? { pos: { ...c.at }, dir: { ...c.dir } } : { pos: { ...at.pos }, dir: { x: 1, y: 0 } }));
    }
    this.parkAll(b);
    if (at) {
      b.at = at.node;
      b.pos = { ...at.pos };
    }
    if (b.state === 'going') {
      const s = b.project !== undefined ? this.host.site(b.project, b) : null;
      if (!s) return this.release(b);
      if (at && at.node !== s.node) return;
      return this.onSite(b, s);
    }
    if (b.state === 'back') {
      if (at && base && at.node !== base.nodeId) return;
      this.home(b);
    }
  }

  /**
   * Машину колонны потеряли (дорогу под ней снесли): без дороги ей не проехать — бригада (вся колонна) сразу на базе;
   * ехала к стройке — выедет оттуда заново.
   */
  lost(b: Brigade): void {
    this.home(b);
  }

  /** Работающим бригадам — новое место (край работ сдвинулся); node — узел дороги, у которого он. */
  follow(project: number, front: Vec, node: number | null): void {
    for (const b of this.working(project)) this.followOne(b, front, node);
  }

  /** Работающей бригаде — новое место у края работ её фронта; node — узел дороги, откуда к нему подъезд. */
  followOne(b: Brigade, front: Vec, node: number | null): void {
    b.pos = { ...front };
    if (node !== null) b.at = node;
  }

  // ---------- Назначение игроком («🎯 На стройку…» в карточке бригады) ----------

  /**
   * Может ли бригада b поехать на проект project: null — да; иначе причина. Проект должен строиться (не на паузе), на
   * нём должно быть место (cap — бригады, что едут и работают, считая назначенных игроком), к нему — подъезд (Site), и
   * доехать до узла подъезда по дорогам оттуда, где бригада сейчас (колонна в пути — от узла, куда она едет).
   */
  canGo(b: Brigade, project: number): string | null {
    if (!this.host.crewProjects().includes(project)) return 'Проект сейчас не строится: на паузе или уже готов';
    if (b.project === project && (b.state === 'going' || b.state === 'working')) return null;
    const cap = this.cap(project);
    // Места нет — игрок ставит эту бригаду вместо назначенной автоматикой (дальней от стройки, displaced); если все
    // там назначены игроком — отказ.
    if (this.assigned(project).length >= cap && !this.displaced(b, project)) return `На проекте уже ${cap} из ${cap} бригад, и все назначены вручную (📌) — снимите одну («↺ Авто»)`;
    const s = this.host.site(project, b);
    if (!s) return 'К проекту нет подъезда по готовым дорогам';
    const from = b.convoy?.to ?? this.startNode(b);
    if (from === null || (from !== s.node && !this.host.reach(from, s.node))) return 'Бригаде отсюда не доехать до проекта по дорогам';
    return null;
  }

  /**
   * Игрок отправил бригаду b на проект project: null — едет (назначение закреплено, pinned), иначе причина отказа
   * (canGo). Едет обычным путём, без перескока: работала — сперва вдоль своей стройки назад к дороге; ехала вдоль
   * стройки к краю работ — останавливается и едет назад к дороге; колонна в потоке доезжает до своей цели (машины не
   * исчезают посреди дороги), а оттуда — к новому проекту (arrive → launch); не выехала — выезжает сразу туда.
   */
  send(b: Brigade, project: number): string | null {
    const problem = this.canGo(b, project);
    if (problem) return problem;
    b.pinned = true;
    if (b.project === project && (b.state === 'going' || b.state === 'working')) return null;
    // Мест нет — уступает назначенная автоматикой, что дальше всех от стройки: едет к другому проекту или домой.
    if (this.assigned(project).length >= this.cap(project)) {
      const out = this.displaced(b, project);
      if (out) this.release(out);
    }
    if (b.convoy && b.convoy.cars.every((c) => 'wait' in c)) this.parkAll(b);
    let back: Vec[] | null = null;
    if (b.state === 'working') back = this.pathBack(b)?.path ?? null;
    else if (b.trip && !b.trip.back && b.trip.to === undefined) back = this.walkBack(b);
    b.project = project;
    delete b.front;
    b.state = 'going';
    if (back) this.walk(b, back, true);
    return null;
  }

  /**
   * Кого заменит бригада b, если игрок отправит её на проект project, где мест нет: из назначенных автоматикой (не
   * pinned) — дальше всех от стройки (от её подъезда; колонна в потоке — откуда выехала), при равенстве — с большим
   * номером. null — заменять некого (все там назначены игроком) или место и так есть.
   */
  displaced(b: Brigade, project: number): Brigade | null {
    const others = this.assigned(project).filter((x) => x !== b && !x.pinned);
    if (!others.length) return null;
    const at = this.host.site(project)?.pos ?? this.where(others[0]);
    let best: { x: Brigade; d: number } | null = null;
    for (const x of others) {
      const d = dist(this.where(x), at);
      if (!best || d > best.d + 1e-6 || (Math.abs(d - best.d) <= 1e-6 && x.id > best.x.id)) best = { x, d };
    }
    return best!.x;
  }

  /** «↺ Авто»: назначение игрока снято — дальше бригадой снова распоряжается автоматика (сама она никуда не едет). */
  unpin(b: Brigade): void {
    delete b.pinned;
  }

  /** Содержание всех бригад за месяц. */
  upkeep(): number {
    return Math.round(this.brigades.size * CONSTRUCTION.brigade.upkeep);
  }

  toSave(): CrewSave | undefined {
    if (!this.bases.size && !this.brigades.size && !this.firstUsed) return undefined;
    return {
      bases: [...this.bases.values()].map((b) => ({ ...b, fp: { ...b.fp, center: { ...b.fp.center } } })),
      // Колонна в пути и места машин не сохраняются: после загрузки бригада выезжает заново оттуда, где была.
      brigades: [...this.brigades.values()].map(({ convoy: _c, spots: _s, ...b }) => ({
        ...b,
        ...(b.pos ? { pos: { ...b.pos } } : {}),
        ...(b.lane ? { lane: copyLane(b.lane) } : {}),
        ...(b.front ? { front: { ...b.front } } : {}),
        ...(b.trip
          ? {
              trip: {
                path: b.trip.path.map((p) => ({ ...p })),
                t0: b.trip.t0,
                ...(b.trip.back ? { back: true as const } : {}),
                ...(b.trip.to !== undefined ? { to: b.trip.to } : {}),
              },
            }
          : {}),
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
    for (const b of save?.brigades ?? []) this.brigades.set(b.id, legacyBrigade({ ...b }));
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

/** Копия полосы бригады (для сохранения и загрузки). */
function copyLane(l: CrewLane): CrewLane {
  return {
    path: l.path.map((p) => ({ x: p.x, y: p.y })),
    legs: l.legs.map((g) => ({ ...g })),
    ...(l.from ? { from: [...l.from] } : {}),
    ...(l.t0 !== undefined ? { t0: l.t0 } : {}),
    ...(l.t ? { t: [...l.t] } : {}),
    ...(l.side ? { side: [...l.side] } : {}),
    ...(l.shifts?.length ? { shifts: l.shifts.map((sh) => ({ at: sh.at, to: sh.to })) } : {}),
  };
}

/**
 * Бригада из старого сохранения: ехала своим ходом по полю (eta без пути вдоль стройки) или стояла в поле, не у
 * дороги, — по полю бригады больше не ездят: она на базе (ехала домой — уже дома) и выезжает оттуда заново.
 */
function legacyBrigade(b: Brigade): Brigade {
  const trip = b.trip as (SiteTrip & { from?: Vec }) | undefined;
  if (b.eta !== undefined && !(trip && Array.isArray(trip.path))) {
    delete b.eta;
    delete b.trip;
    delete b.pos;
    delete b.at;
  }
  if (b.pos && b.at === undefined) delete b.pos;
  if (b.state === 'back' && !b.pos && b.at === undefined) b.state = 'idle';
  // Полоса — только у бригады на стройке и целая (старое сохранение без неё — построится заново, work).
  if (b.lane && (!Array.isArray(b.lane.path) || !Array.isArray(b.lane.legs) || (b.state !== 'going' && b.state !== 'working'))) delete b.lane;
  if (b.lane) b.lane = copyLane(b.lane);
  // Часть колонны ещё ехала к стройке (поток не сохраняется) — эти машины уже у подъезда: сходят на полосу каждая
  // следом за предыдущей, на её длину с зазором позади, и едут к своим местам вместе с ней.
  const lane = b.lane;
  if (lane?.from && lane.from.length < CONVOY_CARS && b.state === 'working') {
    const t0 = lane.t0 ?? 0;
    const t = lane.t ?? lane.from.map(() => t0);
    for (let k = lane.from.length; k < CONVOY_CARS; k++) {
      lane.from.push((lane.from[k - 1] ?? 0) - crewSpacing(k - 1));
      t.push(t[k - 1] ?? t0);
      lane.side?.push(0);
    }
    lane.t = t;
  }
  delete b.spots;
  // Фронт — только у бригады при проекте (старые сохранения без него — выберет сама, Construction.claim).
  if (b.front && (typeof b.front.corridor !== 'number' || (b.state !== 'going' && b.state !== 'working'))) delete b.front;
  if (b.front) b.front = { corridor: b.front.corridor, fromB: !!b.front.fromB };
  // Назначение игрока — только у бригады при проекте (едет к нему или работает).
  if (b.pinned && (b.project === undefined || (b.state !== 'going' && b.state !== 'working'))) delete b.pinned;
  return b;
}
