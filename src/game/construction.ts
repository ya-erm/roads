/**
 * Стройка дорог в режиме «Со строительством» (WorldSettings.construction = 'build'): нарисованная дорога —
 * проект (её полотна в сети помечены Corridor.build), он строится сам, участок за участком от узла до узла.
 *
 * - Темп — CONSTRUCTION в config.ts: 1 км улицы — 30 с на ×1, класс, полосы и сооружения — дольше (constructionWork.ts).
 * - Деньги — за каждый готовый метр: за такт платится разница «заплачено за готовое» (paidFor) — целыми долларами.
 *   Не хватает (бюджет — до кредитного предела, как у любой стройки) — проект стоит, пока деньги не появятся.
 * - Готовый участок сразу открыт: у полотна снимается build, ревизия новая — граф движения и карта его берут
 *   (src/lanes/open.ts — сеть без строящегося).
 * - Участок — сначала тот, что уже начат, потом тот, к концу которого есть подъезд: до узла можно доехать по готовым
 *   дорогам с ворот базы (accessRank); таких несколько — у ближайшего к базе конца, от него участок и заполняется.
 *   Подъезд — без учёта направления полос (Game.reach, crewRoads.ts): к концу проекта у одностороннего съезда «от
 *   проекта» технику пропустит регулировщик — бригада проедет последний отрезок против движения.
 *   Стройка так идёт от подъезда внутрь проекта; участок без подъезда ждёт, пока до него дорастёт соседний. Подъезда
 *   нет ни у одного узла проекта — бригады к нему не едут (site — null), проект ждёт: примыкает к другому строящемуся
 *   проекту с подъездом — «⏳ после соседнего» (ProjectInfo.waits), иначе «🚚 нет подъезда» на плашке, в карточке и
 *   у советника. Подъезд есть, а фронт и подъезд — вне радиуса обслуживания всех баз (CONSTRUCTION.serviceRadius,
 *   serves) — автоматика бригад не шлёт: «⛔ нет базы рядом» (ProjectInfo.noBase). Участок проходят трижды: земляные работы, покрытие, разметка (CONSTRUCTION.stages) — у каждого
 *   этапа свой ход (CorridorBuild.stages): этап идёт, пока его машина на месте; покрытие — не ближе convoyGap к
 *   отсыпке, разметка — к покрытию; участок готов, когда до конца дошла разметка (constructionWork.advanceStages).
 * - Строят бригады (crews.ts): проект идёт, пока на нём работает хоть одна; темп — сумма вкладов бригад (дальше от
 *   базы — медленнее). Проекты строятся одновременно, если бригад хватает.
 * - Пауза — проект стоит; отмена (Game.cancelProject) сносит недостроенное и возвращает заплаченное за него,
 *   готовые участки остаются.
 * - Резерв (Project.reserve): деньги на счёте, отложенные на проект, — в бюджет прочих трат не входят (Game.budget),
 *   проект платит за метры сперва из них, поэтому без денег не встаёт; кредитный предел резерв не обходит.
 *   Проект кончился или отменён — запись уходит вместе с остатком резерва, он снова свободен.
 * - Приоритет (Project.priority): бригады — сначала к нему, не хватает — переходят с обычных проектов (crews.ts).
 *
 * Ж/д путь в том же режиме — тоже проект (Project.rail): его участки — пути сети путей (Segment.build), строятся теми же
 * этапами по долям (на пути — балласт, шпалы, рельсы), с той же оплатой и открытием участков (Piece — общее у полотна и
 * пути). Строят его не бригады с дорог, а строительный поезд (workTrains.ts): выходит с ближайшего вокзала, от которого
 * по готовым путям доехать до начала работ, встаёт у края готового пути и укладывает путь перед собой. Поезда по
 * недостроенному пути не ходят (RailSim), переездов на нём нет.
 *
 * Состояние: готовое — в полотнах сети (сохраняется вместе с ней), записи проектов — здесь (toSave / load).
 */
import { dist, dot, sub, type Vec } from '../core/vec';
import { nodeCuts } from '../lanes/geometry';
import { corridorLayer } from '../lanes/speedDisplay';
import type { Corridor, LaneNet } from '../lanes/model';
import { CONSTRUCTION } from '../config';
import type { Network, Segment } from '../world/network';
import { ROAD_CLASSES } from '../world/roadTypes';
import { trackProfile } from './build';
import { advanceStages, buildRate, crewCap, frontOf, paidFor, type Piece, pickSite, railBuildRate, spansOf, stageSeconds, stageWork } from './constructionWork';
import { type CrewLane, crewRows, fillet, laneRow, polyLength, polyProject, stageSlots } from './crewLane';
import { CrewCarry } from './crewCarry';
import { type Brigade, type CrewSave, Crews, type Site } from './crews';
import type { CrewStep } from './crewRoads';
import { corridorProfile, fullCorridorCost } from './roadbuild';
import type { RailSim } from '../sim/rail';
import { type WorkTrainSave, WorkTrains } from './workTrains';

export interface Project {
  id: number;
  /** Что строим — одной строкой для плашки: «Улица 1+1», «Магистраль 2+2 · мост». */
  label: string;
  /** Своё название (игрок переименовал в карточке, Game.renameProject); нет — показывается label. */
  name?: string;
  paused?: boolean;
  /** Готовые участки: метров (для процента). */
  builtLen: number;
  /** Заплачено за готовые метры, $. */
  spent: number;
  /** Когда заложен, секунд игры. */
  created: number;
  /** Стоит без денег — с какого времени (секунд игры). */
  stalled?: number;
  /**
   * Отложено на проект, $ (целыми): эти деньги — на счёте, но в бюджет прочих трат не входят (Game.budget), проект
   * платит за метры сперва из них. Кончился или отменён проект — запись уходит, остаток снова свободен.
   */
  reserve?: number;
  /** Приоритет: свободные бригады — сначала сюда, не хватает — бригада с обычного проекта переходит сюда (crews.ts). */
  priority?: true;
  /** Рамка полотен проекта на карте [x0, y0, x1, y1] — куда вести камеру, когда достроен (нет — старое сохранение). */
  area?: [number, number, number, number];
  /** Ж/д путь: участки проекта — пути сети путей (Segment.build), а не полотна дорог. */
  rail?: true;
}

export interface ConstructionSave {
  nextId: number;
  projects: Project[];
  /** Базы и бригады (нет в партиях без них). */
  crews?: CrewSave;
  /** Строительные поезда ж/д проектов (нет в партиях без них). */
  trains?: WorkTrainSave;
}

/** Что стройка знает об игре. */
export interface ConstructionHost {
  readonly roads: { readonly net: LaneNet };
  /** Сеть путей: участки ж/д проектов (нет — ж/д проектов нет). */
  readonly net?: Network;
  /** Полная цена ж/д пути (как у готового, Builder.fullSegmentCost): за метр проект платит её долю. */
  railCost?(seg: Segment): number;
  /** Симуляция поездов: по ней едут строительные поезда (workTrains.ts). */
  readonly rail?: RailSim;
  /** Вокзалы игрока — депо строительных поездов: где и их платформы. Нет — ж/д проекты строить некому. */
  railDepots?(): { id: number; pos: Vec; platforms: number[] }[];
  /** Сколько можно потратить (до кредитного предела). */
  readonly budget: number;
  readonly time: number;
  isWater(p: Vec, margin?: number): boolean;
  ground(): ((p: Vec) => number) | null;
  spend(amount: number): void;
  /** Открыт участок: граф движения заново. */
  networkChanged(): void;
  /** Проект достроен или встал без денег — уведомление и журнал. */
  projectEvent?(kind: 'done' | 'stalled', p: Project): void;
  /** Машины бригад в потоке (Crews): выпустить от узла к узлу, убрать; есть ли узел в графе движения. */
  drive(brigade: Brigade, from: number, to: number, car: number): number | 'busy' | null;
  /** Машину бригады — в поток прямо с места, где она стоит на готовой дороге (Crews: CrewHost.driveFrom). */
  driveFrom?(brigade: Brigade, car: number, spot: { pos: Vec; dir: Vec }, to: number): number | 'busy' | null;
  park(sim: number): void;
  onRoad(node: number): boolean;
  /**
   * От узла from до узла to технике можно добраться по готовым дорогам (подъезд к проекту) — без учёта направления
   * полос: где по правилам не доехать, бригада проедет отрезок против движения (crewStep).
   */
  reach(from: number, to: number): boolean;
  /** Следующий шаг бригады от узла from к узлу to: по дорогам в потоке или против движения (crewRoads.ts). */
  crewStep?(from: number, to: number): CrewStep | null;
}

/** Сводка проекта для плашки и советника. */
export interface ProjectInfo {
  project: Project;
  /** Готово: доля длины 0…1. */
  done: number;
  /** Сколько секунд игры (на ×1) ещё строить. */
  seconds: number;
  /** Длина проекта целиком и сколько ещё стоит достроить, $. */
  length: number;
  left: number;
  /** Где сейчас идёт стройка (край готового) — нет, если стоит или ещё не начата. */
  front: Vec | null;
  /** Середина недостроенного — куда смотреть на карте. */
  at: Vec;
  /** Сколько секунд строить с ещё одной бригадой (с ближайшей базы); null — больше бригад на проект нельзя. */
  secondsPlus: number | null;
  /** Готовность по этапам (земляные работы, покрытие, разметка): доли длины 0…1. */
  stages: [number, number, number];
  /**
   * Есть подъезд: до какого-нибудь узла проекта можно доехать по готовым дорогам с базы (и оттуда вдоль стройки до края
   * работ). Нет — бригады не едут, проект ждёт дороги к себе или базы рядом.
   */
  access: boolean;
  /**
   * Подъезда нет, но проект примыкает (через другие строящиеся проекты не на паузе) к узлу с подъездом: просто ждёт,
   * пока до него дорастёт соседний, — не «нет подъезда» (Construction.waitsNeighbor).
   */
  waits: boolean;
  /**
   * Есть база рядом: с какой-нибудь базы до проекта доехать, и его фронт или подъезд — в её радиусе обслуживания
   * (CONSTRUCTION.serviceRadius, Construction.serves). Нет — автоматика бригад сюда не шлёт.
   */
  near: boolean;
  /**
   * Стоит: «⛔ нет базы рядом» — подъезд есть, а ни одной базы рядом (near) нет, и никто сюда не едет и не работает
   * (вручную отправленная бригада — уже не «стоит»). Плашка, строка вкладки, карточка, советник.
   */
  noBase: boolean;
}

/** Из чего проект: метров по видам (вода — мост над ней), насыпь и выемка — высота и глубина, м. */
export interface ProjectParts {
  ground: number;
  bridge: number;
  tunnel: number;
  water: number;
  fill: number;
  cut: number;
}

/** Полотна проекта по номерам — кэш по сети и её версии. */
interface Index {
  net: LaneNet;
  version: number;
  of: Map<number, Corridor[]>;
}

/** Пути ж/д проектов по номерам — кэш по сети путей и её версии. */
interface RailIndex {
  net: Network;
  version: number;
  of: Map<number, Segment[]>;
}

export class Construction {
  readonly projects = new Map<number, Project>();
  nextId = 1;
  /** Растёт при любом изменении стройки (такт, пауза): подпись кадра и плашек. */
  stamp = 0;
  private index: Index | null = null;
  private railIndex: RailIndex | null = null;
  /** Строительные поезда ж/д проектов (нет сети путей и симуляции поездов — нет и ж/д проектов). */
  readonly trains: WorkTrains | null;
  /** Цена и темп полотна по ревизии: ревизия меняется с формой, полосами и классом. */
  private readonly prices = new Map<string, { full: number; rate: number }>();
  /** Из чего полотно (мост, тоннель, насыпь) по ревизии — для карточки проекта. */
  private readonly partsCache = new Map<string, ProjectParts>();
  /** Базы и бригады: проект строится, пока на нём работает бригада. */
  readonly crews: Crews;
  /** Сеть дорог, по которой уже разложена техника бригад (syncNet): заменили — подвинутое везёт её с собой. */
  private seenNet: LaneNet | null = null;

  constructor(private readonly host: ConstructionHost) {
    const self = this;
    this.crews = new Crews({
      get time() {
        return host.time;
      },
      // Ж/д проекты строят не бригады, а строительные поезда (workTrains.ts).
      crewProjects: () => [...this.projects.values()].filter((p) => !p.paused && !this.isRail(p.id) && this.corridorsOf(p.id).length).map((p) => p.id),
      priority: (id) => !!this.projects.get(id)?.priority,
      cap: (id) => (this.isRail(id) ? 0 : crewCap(this.corridorsOf(id))),
      site: (id, b) => self.site(id, b),
      path: (id, b) => self.approach(id, b)?.path() ?? null,
      claim: (id, b) => self.claim(id, b),
      reach: (from, to) => host.reach(from, to),
      ...(host.crewStep ? { step: (from: number, to: number) => host.crewStep!(from, to) } : {}),
      drive: (b, from, to, car) => host.drive(b, from, to, car),
      ...(host.driveFrom
        ? {
            driveFrom: (b: Brigade, car: number, spot: { pos: Vec; dir: Vec }, to: number) => host.driveFrom!(b, car, spot, to),
          }
        : {}),
      lane: (id, cars, b) => self.crewLane(id, cars, b),
      slots: (b) => self.crewSlots(b),
      stagger: (id, b) => self.stagger(id, b),
      park: (sim) => host.park(sim),
      onRoad: (node) => host.onRoad(node),
    });
    const rails = host.net;
    // Симуляция поездов у игры появляется позже стройки — берём её, когда понадобится.
    this.trains =
      rails && host.railDepots
        ? new WorkTrains({
            get time() {
              return host.time;
            },
            net: rails,
            get rail() {
              return host.rail!;
            },
            depots: () => host.railDepots?.() ?? [],
            projects: () => [...this.projects.values()].filter((p) => !p.paused && this.isRail(p.id) && this.segmentsOf(p.id).length).map((p) => p.id),
            pieces: (id) => this.segmentsOf(id),
          })
        : null;
  }

  /** Проект id — ж/д путь (участки — пути сети путей), а не дорога. */
  isRail(id: number): boolean {
    return !!this.projects.get(id)?.rail && !!this.host.net;
  }

  /** Участки проекта, что ещё строятся (по номеру): полотна дороги или пути ж/д проекта. */
  piecesOf(id: number): Piece[] {
    return this.isRail(id) ? this.segmentsOf(id) : this.corridorsOf(id);
  }

  /** Участок проекта id по номеру — в сети своего вида (полотно дороги или путь); нет — undefined. */
  private piece(id: number, pieceId: number): Piece | undefined {
    return this.isRail(id) ? this.host.net!.segments.get(pieceId) : this.host.roads.net.corridors.get(pieceId);
  }

  /** Слой участка: 0 — на земле, больше — мост или пандус к нему, меньше — тоннель. */
  private layer(id: number, c: Piece): number {
    if (!this.isRail(id)) return corridorLayer(this.host.roads.net, c as Corridor);
    const rails = this.host.net!;
    const la = rails.node(c.a).level;
    const lb = rails.node(c.b).level;
    return la === 0 && lb === 0 ? 0 : Math.max(la, lb) > 0 ? 1 : -1;
  }

  /** Готовое на участке открыто: полотну или пути — новая ревизия (отрисовка, граф движения). */
  private touchPiece(id: number, c: Piece): void {
    if (!this.isRail(id)) {
      this.host.roads.net.touch(c as Corridor);
      return;
    }
    this.host.net!.touch(c.a);
    this.host.net!.touch(c.b);
  }

  /**
   * Узел дороги, откуда бригада съедет на участок проекта id у его узла n: сам узел, если подходит (ok); нет — null.
   * Ж/д проекты бригады не строят (строительный поезд, workTrains.ts) — null.
   */
  private gate(id: number, n: number, ok: (road: number) => boolean): number | null {
    if (this.isRail(id)) return null;
    return ok(n) ? n : null;
  }

  /**
   * Подъезд к узлу n участка проекта id (accessRank): у пути — есть ли в узле готовый путь (оттуда подойдёт
   * строительный поезд), 0; нет — null.
   */
  private pieceAccess(id: number, n: number): number | null {
    if (!this.isRail(id)) return this.accessRank(n);
    const rails = this.host.net!;
    return rails.nodes.get(n)?.segments.some((s) => !rails.segments.get(s)?.build) ? 0 : null;
  }

  /** Край работ проекта на участке c: точка и узел дороги, откуда участок заполняется. */
  private frontOn(c: Piece): { pos: Vec; node: number } {
    const b = c.build!;
    const f = frontOf(spansOf(b, c.length), c.length).s;
    return {
      pos: c.lut.pointAt(b.fromB ? c.length - f : f),
      node: b.fromB ? c.b : c.a,
    };
  }

  /**
   * Куда ехать бригаде к проекту: узел дороги с подъездом (оттуда — вдоль стройки, approach) и край работ. Подъезда нет
   * ни у одного узла проекта (или проекта нет) — null: бригады не едут. С бригадой b — к её фронту (frontFor: свой
   * участок или тот, что ей ближе и куда она доедет); без — к главному (current).
   */
  site(id: number, b?: Brigade): Site | null {
    const a = this.approach(id, b);
    return a ? { node: a.node, pos: a.pos, gate: { ...this.host.roads.net.node(a.node).pos } } : null;
  }

  /** Куда ехать к проекту id бригадам с узла from (база, её ворота): к какому-нибудь его фронту; не доехать — null. */
  siteFrom(id: number, from: number): Site | null {
    const f = this.frontFrom(id, null, from);
    const r = f && this.routeTo(id, f.c, f.fromB, this.reachFrom(from));
    return f && r ? { node: r.entry, pos: frontPoint(f.c, f.fromB), gate: { ...this.host.roads.net.node(r.entry).pos } } : null;
  }

  /**
   * Куда поехала бы на проект id свободная бригада базы base (с её ворот): к фронту, ближайшему к базе, — как выберет
   * автоматика (frontFor); не доехать по дорогам — null.
   */
  siteOfBase(id: number, base: number): Site | null {
    const b = this.crews.bases.get(base);
    if (!b) return null;
    // Пробная бригада этой базы: чужих фронтов она не занимает, свой выберет ближе к базе.
    const probe: Brigade = { id: 0, base, state: 'idle' };
    const f = this.frontFrom(id, probe, b.nodeId);
    const r = f && this.routeTo(id, f.c, f.fromB, this.reachFrom(b.nodeId));
    return f && r ? { node: r.entry, pos: r.c.lut.pointAt(r.s), gate: { ...this.host.roads.net.node(r.entry).pos } } : null;
  }

  /** Проект id — в радиусе обслуживания базы base: её бригады доедут до него, и фронт или подъезд — в радиусе (Crews.serves). */
  serves(id: number, base: number): boolean {
    const s = this.siteOfBase(id, base);
    return !!s && this.crews.serves(base, s);
  }

  /**
   * Чья это стройка: ближайшая база (Crews.span; при равенстве — с меньшим номером), в радиусе которой проект id и
   * бригады которой до него доезжают (serves). Только её бригады автоматика сюда и шлёт. Нет такой — null.
   */
  owner(id: number): number | null {
    let best: { base: number; d: number } | null = null;
    for (const b of this.crews.bases.values()) {
      if (!this.crews.of(b.id).length) continue;
      const s = this.siteOfBase(id, b.id);
      if (!s || !this.crews.serves(b.id, s)) continue;
      const d = this.crews.span(b.id, s);
      if (!best || d < best.d - 1e-6 || (Math.abs(d - best.d) <= 1e-6 && b.id < best.base)) best = { base: b.id, d };
    }
    return best?.base ?? null;
  }

  /**
   * Проект id вне радиуса базы бригады b — туда её можно отправить только вручную («🎯 На стройку…»), и строить будет
   * медленно: к фронту, куда она поедет (site с ней). Не доехать — false (тут другая причина, Crews.canGo).
   */
  outOfRadius(id: number, b: Brigade): boolean {
    const s = this.site(id, b);
    return !!s && !this.crews.serves(b.base, s);
  }

  /** Есть база, в радиусе которой проект id (serves): по стройке, сети и базам — до следующего изменения. */
  private nearCache = new Map<number, { net: LaneNet; key: string; near: boolean }>();

  /** Проект id в радиусе хоть одной базы, с которой до него доехать (serves). */
  nearBase(id: number): boolean {
    const net = this.host.roads.net;
    const bases = [...this.crews.bases.values()];
    const key = `${this.stamp}:${net.version}:${bases.map((b) => `${b.id}@${b.nodeId}:${Math.round(b.fp.center.x)},${Math.round(b.fp.center.y)}`).join(';')}`;
    const hit = this.nearCache.get(id);
    if (hit && hit.net === net && hit.key === key) return hit.near;
    const near = bases.some((b) => this.serves(id, b.id));
    if (this.nearCache.size > 200) this.nearCache.clear();
    this.nearCache.set(id, { net, key, near });
    return near;
  }

  /**
   * Фронты проекта id — участки, что строятся сейчас: начатые и те, куда уже едет бригада (Brigade.front), по номеру.
   * У каждого фронта — своя колонна этапов и свои бригады; встречаются фронты на стыке участков (каждый участок
   * строит один фронт — без двойной работы и двойной оплаты).
   */
  fronts(id: number): Corridor[] {
    // Полотна дорог (у ж/д проекта — пусто: его фронты — frontsOf).
    return this.isRail(id) ? [] : (this.frontsOf(id) as Corridor[]);
  }

  /** Фронты проекта id — участки (полотна или пути), что строятся сейчас (fronts). */
  frontsOf(id: number): Piece[] {
    const claims = this.claims(id, null);
    return this.piecesOf(id).filter((c) => c.build!.done > 0 || claims.has(c.id));
  }

  /** Участки проекта id, куда уже едут или где работают бригады (кроме but): номер участка → с какого конца. */
  private claims(id: number, but: Brigade | null): Map<number, boolean> {
    const out = new Map<number, boolean>();
    // Ж/д: участок, к которому едет или который строит строительный поезд.
    const w = this.isRail(id) ? this.trains?.of(id) : undefined;
    const wc = w?.front && this.piece(id, w.front.corridor);
    if (w?.front && wc?.build?.project === id) out.set(wc.id, wc.build.done > 0 ? !!wc.build.fromB : w.front.fromB);
    for (const o of this.crews.brigades.values()) {
      if (o === but || o.project !== id || !o.front || (o.state !== 'going' && o.state !== 'working')) continue;
      const c = this.piece(id, o.front.corridor);
      if (c?.build?.project === id && !out.has(c.id)) out.set(c.id, c.build.done > 0 ? !!c.build.fromB : o.front.fromB);
    }
    return out;
  }

  /** Узел n — у готовой дороги, и до него можно доехать с узла from. */
  private reachFrom(from: number): (n: number) => boolean {
    return (n) => this.host.onRoad(n) && (n === from || this.host.reach(from, n));
  }

  /**
   * Фронт бригады b на проекте id: свой участок (Brigade.front), пока он строится; иначе — ближайший к её базе из тех,
   * куда она доедет по дорогам оттуда, где стоит: уже идущий фронт (подъезд к началу его участка — вдоль стройки по
   * не начатым полотнам) или новый — не начатый и никем не занятый участок с подъездом к его концу (оттуда он и
   * заполняется, навстречу остальным). При равенстве — к уже идущему. Некуда — null.
   */
  frontFor(id: number, b: Brigade): { c: Piece; fromB: boolean } | null {
    const own = b.front && b.project === id ? this.piece(id, b.front.corridor) : undefined;
    if (own?.build?.project === id)
      return {
        c: own,
        fromB: own.build.done > 0 ? !!own.build.fromB : b.front!.fromB,
      };
    const from = this.crews.startOf(b);
    return from === null ? null : this.frontFrom(id, b, from);
  }

  /** Фронт для бригады b (или любой бригады с узла from): ближайший к базе (или к from) доступный — frontFor. */
  private frontFrom(id: number, b: Brigade | null, from: number): { c: Piece; fromB: boolean } | null {
    const net = this.host.roads.net;
    // Узла from уже нет в сети (ворота базы на снесённом узле) — отсюда никуда не доехать.
    const at = net.nodes.get(from);
    if (!at) return null;
    const ok = this.reachFrom(from);
    const claims = this.claims(id, b);
    const home = (b && this.crews.bases.get(b.base)?.fp.center) ?? at.pos;
    let best: {
      c: Piece;
      fromB: boolean;
      d: number;
      fresh: boolean;
    } | null = null;
    for (const c of this.piecesOf(id)) {
      const busy = c.build!.done > 0 ? !!c.build!.fromB : claims.get(c.id);
      for (const fromB of busy !== undefined ? [busy] : [false, true]) {
        const start = fromB ? c.b : c.a;
        // Узел дороги, откуда съезжать на участок: у дороги — сам его конец, у пути — подъезд к нему (gate).
        const entry = busy !== undefined ? (this.routeTo(id, c, fromB, ok)?.entry ?? null) : this.gate(id, start, ok);
        if (entry === null) continue;
        const d = dist(home, net.node(entry).pos);
        const fresh = busy === undefined;
        if (!best || d < best.d - 1e-6 || (Math.abs(d - best.d) <= 1e-6 && !fresh && best.fresh)) best = { c, fromB, d, fresh };
      }
    }
    return best && { c: best.c, fromB: best.fromB };
  }

  /**
   * Бригада b берётся за фронт на проекте id (frontFor): участок — её (Brigade.front); не начатый заполняется от того
   * конца, к которому она едет. Не за что — фронт снят.
   */
  claim(id: number, b: Brigade): void {
    const f = this.frontFor(id, b);
    if (!f) {
      delete b.front;
      return;
    }
    b.front = { corridor: f.c.id, fromB: f.fromB };
    const k = f.c.build!;
    if (k.done <= 0 && !!k.fromB !== f.fromB) f.c.build = f.fromB ? { project: id, done: 0, fromB: true } : { project: id, done: 0 };
  }

  /**
   * Следующий участок фронта, что дошёл до конца участка c (заполнялся от fromB): не начатый и никем не занятый участок
   * проекта, что продолжает c от его конца (по номеру). Нет — фронт кончился (встретил другой или проект достроен).
   */
  continuation(id: number, c: Piece, fromB: boolean, but: Brigade | null = null): { c: Piece; fromB: boolean } | null {
    const tail = fromB ? c.a : c.b;
    const claims = this.claims(id, but);
    for (const k of this.piecesOf(id)) {
      if (k === c || k.build!.done > 0 || claims.has(k.id) || (k.a !== tail && k.b !== tail)) continue;
      return { c: k, fromB: k.b === tail && k.a !== tail };
    }
    return null;
  }

  /**
   * Подъезд к узлу: с ворот какой-нибудь базы до него можно доехать по готовым дорогам — расстояние от ближайшей такой
   * базы до узла (по прямой; чем меньше, тем раньше отсюда строить), ни с какой — null.
   */
  accessRank(node: number): number | null {
    if (!this.host.onRoad(node)) return null;
    const pos = this.host.roads.net.node(node).pos;
    let best: number | null = null;
    for (const b of this.crews.bases.values()) {
      if (b.nodeId !== node && !this.host.reach(b.nodeId, node)) continue;
      const d = dist(b.fp.center, pos);
      if (best === null || d < best) best = d;
    }
    return best;
  }

  /**
   * Путь бригады к краю работ: узел дороги с подъездом (node) и оттуда вдоль стройки — по строящимся полотнам проекта
   * (кратчайший по длине; обычно край работ — на участке, что заполняется прямо от этого узла) до края работ (pos).
   * path — точки этого пути по оси проекта, от узла до края. Подъезда нет — null.
   */
  approach(id: number, by?: Brigade): { node: number; pos: Vec; path: () => Vec[] } | null {
    const r = this.route(id, by);
    if (!r) return null;
    const { c, s, end, legs, entry } = r;
    const net = this.host.roads.net;
    const pos = c.lut.pointAt(s);
    const path = () => {
      const pts: Vec[] = [{ ...net.node(entry).pos }];
      for (const leg of legs) alongCorridor(pts, leg.k, leg.k.a === leg.from ? 0 : leg.k.length, leg.k.a === leg.from ? leg.k.length : 0, 10);
      alongCorridor(pts, c, end === c.a ? 0 : c.length, s, 10);
      return pts;
    };
    return { node: entry, pos, path };
  }

  /**
   * Полоса бригады на проекте id (crewLane.ts): от мест машин колонны cars (нос; нет — прямо позади начала заполнения
   * участка, по его оси) через узел подъезда и вдоль стройки к началу заполнения, по участку и дальше по следующему,
   * если тот продолжает его от конца (nextSite). Ряд бригады на участке — в такте (trackCrews). Путь вдоль стройки
   * входит в участок не с начала заполнения (там уже строят от другого конца) — null.
   */
  crewLane(id: number, cars: readonly { pos: Vec; dir: Vec }[] | null, by?: Brigade): CrewLane | null {
    const r = this.route(id, by);
    if (!r) return null;
    const { c, legs, entry, end } = r;
    const net = this.host.roads.net;
    const f = by ? this.frontFor(id, by) : null;
    const fromB = f ? f.fromB : !!c.build!.fromB;
    const start = fromB ? c.b : c.a;
    if (cars?.length && end !== start) return null;
    // Вдоль стройки: от узла подъезда по полотнам проекта к началу заполнения, по участку и по следующему, если тот
    // продолжает его от конца (колонна перейдёт без съезда).
    const body: Vec[] = [{ ...net.node(entry).pos }];
    if (cars?.length) for (const leg of legs) alongCorridor(body, leg.k, leg.k.a === leg.from ? 0 : leg.k.length, leg.k.a === leg.from ? leg.k.length : 0, 5);
    else body[0] = c.lut.pointAt(fromB ? c.length : 0);
    alongCorridor(body, c, fromB ? c.length : 0, fromB ? 0 : c.length, 5);
    const onward = this.continuation(id, c, fromB, by ?? null);
    if (onward) alongCorridor(body, onward.c, onward.fromB ? onward.c.length : 0, onward.fromB ? 0 : onward.c.length, 5);
    let pts: Vec[];
    if (cars?.length) {
      // Машины — от хвоста к голове: по курсу головной (кто дальше по ходу, тот впереди).
      const lead = cars[0];
      const order = [...cars].sort((p, q) => dot(sub(p.pos, lead.pos), lead.dir) - dot(sub(q.pos, lead.pos), lead.dir));
      const head = order[order.length - 1];
      pts = [...order.map((m) => ({ ...m.pos })), ...turnIn(head.pos, head.dir, body)];
    } else {
      // Без колонны (старое сохранение, бригада уже на месте): позади начала — прямо по оси участка.
      const t = c.lut.tangentAt(fromB ? c.length : 0);
      const back = fromB ? t : { x: -t.x, y: -t.y };
      pts = [{ x: body[0].x + back.x * 80, y: body[0].y + back.y * 80 }, ...body];
    }
    // Машины стоят там, где встали: поворот начинается не раньше головной.
    const path = fillet(pts, undefined, cars?.length ?? 0);
    // Где на полосе начало заполнения участка: по точке чуть дальше скругления поворота у узла.
    const legAt = (k: Piece, kFromB: boolean) => {
      const u = Math.min(15, k.length / 2);
      return polyProject(path, k.lut.pointAt(kFromB ? k.length - u : u)) - u;
    };
    const out: CrewLane = {
      path,
      legs: [{ corridor: c.id, fromB, at: legAt(c, fromB) }],
    };
    // Начало следующего — ровно за концом этого по полосе: места колонны на стыке совпадают (без скачка при смене участка).
    if (onward)
      out.legs.push({
        corridor: onward.c.id,
        fromB: onward.fromB,
        at: out.legs[0].at + c.length,
      });
    if (cars?.length) {
      out.from = cars.map((m) => polyProject(path, m.pos));
      out.t0 = this.host.time;
    }
    return out;
  }

  /**
   * Места машин бригады b на её полосе (м от начала полосы, по номеру машины): у краёв этапов участка, что строится
   * (stageSlots), — если он на её полосе; иначе null.
   */
  crewSlots(b: Brigade): number[] | null {
    if (!b.lane || b.project === undefined) return null;
    const f = this.frontFor(b.project, b);
    const c = f?.c;
    if (!f || !c?.build) return null;
    const fromB = f.fromB;
    const leg = b.lane.legs.find((g) => g.corridor === c.id && g.fromB === fromB);
    if (!leg) return null;
    // Полоса дальше не идёт, а в конце — готовая дорога: колонна встаёт перед её перекрёстком (оттуда выедет в поток),
    // а не посреди площадки узла.
    const project = b.project;
    const i = b.lane.legs.indexOf(leg);
    const next = b.lane.legs[i + 1];
    const cut = next ? 0 : this.tailCut(project, c, fromB);
    const ext = next ? Math.max(0, polyLength(b.lane.path) - (leg.at + c.length)) : 0;
    // Обычная дорога — не начатые этапы ждут на ней самой; мост и тоннель — позади начала.
    const ground = (id: number) => {
      const k = this.piece(project, id);
      return !!k && this.layer(project, k) === 0;
    };
    const o = {
      end: Math.max(0, c.length - cut),
      ahead: ground(c.id),
      ext,
      extAhead: !!next && ground(next.corridor),
    };
    return stageSlots(spansOf(c.build, c.length), c.length, o).map((u) => leg.at + u);
  }

  /**
   * Полоса участка c (заполняется от fromB) кончается у готовой дороги — колонна встаёт перед её перекрёстком (оттуда
   * выедет в поток), а не посреди площадки узла: на сколько метров раньше конца (обрез полотна у перекрёстка, как у
   * готовой дороги, и пара метров запаса); 0 — не обрезано.
   */
  private tailCut(id: number, piece: Piece, fromB: boolean): number {
    // У пути перекрёстков нет: колонна доходит до конца участка.
    if (this.isRail(id)) return 0;
    const c = piece as Corridor;
    const net = this.host.roads.net;
    const tail = fromB ? c.a : c.b;
    const node = net.node(tail);
    const ends = net.ends(node);
    const cuts = nodeCuts(net, node, ends);
    let cut = 0;
    ends.forEach((e, i) => {
      if (e.corridor === c && (e.end === 'a') === (c.a === tail) && cuts[i] > 0) cut = Math.max(cut, cuts[i] + 2);
    });
    return cut;
  }

  /**
   * Машины бригады b могут сходить на стройку проекта id по одной, как доедут (Crews.board, CrewHost.stagger): её фронт
   * — участок на земле, путь к нему входит в участок с начала заполнения (полосу можно построить от места одной
   * машины), и места, где этапы ждут своего начала, — впереди начала заполнения: первой машине есть куда отъехать,
   * пока остальные подъезжают. Иначе (мост, тоннель, короткий участок у готовой дороги) — колонна собирается целиком.
   */
  stagger(id: number, b: Brigade): boolean {
    const f = this.frontFor(id, b);
    const from = this.crews.startOf(b);
    if (!f || from === null || this.layer(id, f.c) !== 0) return false;
    const r = this.routeTo(id, f.c, f.fromB, this.reachFrom(from));
    if (!r || r.end !== (f.fromB ? f.c.b : f.c.a)) return false;
    const L = f.c.length;
    const y = stageSlots(spansOf(f.c.build, L), L, { end: Math.max(0, L - this.tailCut(id, f.c, f.fromB)), ahead: true });
    return y[2] >= -1e-6;
  }

  /**
   * После такта стройки — бригады на своих полосах: места машин запоминаются (Brigade.spots: отсюда они выедут в
   * поток, когда проект кончится); полоса больше не идёт по участку, что строится (тот кончился, а следующий — не от
   * его конца), — бригаде своим ходом к нему от конца кончившегося участка (Crews.relocate).
   */
  private trackCrews(): void {
    const net = this.host.roads.net;
    /** Бригады на полосах по фронтам (участкам) — для раскладки рядов: участок, его проект и бригады. */
    const onSite = new Map<Piece, { project: number; list: Brigade[] }>();
    for (const b of this.crews.brigades.values()) {
      if (!b.lane || b.project === undefined || (b.state !== 'going' && b.state !== 'working')) continue;
      const slots = this.crewSlots(b);
      const f = slots && this.frontFor(b.project, b);
      if (f) {
        this.crews.keepSpots(b);
        const at = onSite.get(f.c) ?? { project: b.project, list: [] };
        at.list.push(b);
        onSite.set(f.c, at);
        continue;
      }
      // Проект кончился — бригаду отпустят в такте бригад (выедет в поток с мест).
      if (!this.piecesOf(b.project).length) continue;
      // Ж/д проект (бригада на нём — из прежних партий): его строит поезд, бригаду отпустят в такте бригад.
      if (this.isRail(b.project)) continue;
      let node = b.at ?? null;
      for (const g of b.lane.legs) {
        const k = net.corridors.get(g.corridor);
        if (k && !k.build) node = g.fromB ? k.a : k.b;
      }
      if (node !== null) this.crews.relocate(b, node);
    }
    for (const [c, at] of onSite) this.layRows(at.project, c, at.list);
  }

  /** Фронт (участок) проекта id по номеру участка — если он ещё строится. */
  private pieceById(id: number, pieceId: number): Piece | null {
    const c = this.piece(id, pieceId);
    return c?.build ? c : null;
  }

  /**
   * Ряды бригад на участке проекта id (crewRows: ширина полотна поровну на всех, каждая — посередине своей полосы).
   * Раскладка сменилась (бригада приехала или уехала, участок другой ширины) — бригада перестраивается в свой ряд
   * плавно, с места, где сейчас её головная машина (а только что приехавшая — с начала участка): каждая машина
   * сворачивает, проезжая это место, — стоящая ждёт в своём ряду (LaneShift). Порядок рядов — как стоят сейчас.
   */
  private layRows(project: number, piece: Piece, list: Brigade[]): void {
    const c = this.pieceById(project, piece.id);
    if (!c) return;
    const rows = crewRows(c as Corridor, list.length);
    const order = [...list].sort((p, q) => laneRow(p.lane!) - laneRow(q.lane!) || p.id - q.id);
    order.forEach((b, k) => {
      const lane = b.lane!;
      const want = rows[k] ?? 0;
      if (Math.abs(laneRow(lane) - want) < 0.05) return;
      const lead = this.crews.carsAt(b)[0]?.s ?? lane.legs[0].at;
      const at = Math.max(lead, lane.legs[0].at);
      const shifts = (lane.shifts ?? []).filter((sh) => sh.at < at - 1e-6);
      shifts.push({ at, to: want });
      lane.shifts = shifts;
    });
  }

  /**
   * Путь бригады к краю работ проекта id (approach): участок c, край работ в s метрах от его конца a, узел подъезда
   * entry, полотна проекта от него до участка (legs) и конец участка, через который путь в него входит (end).
   */
  private route(
    id: number,
    by?: Brigade,
  ): {
    c: Piece;
    s: number;
    end: number;
    entry: number;
    from: number;
    legs: { k: Piece; from: number }[];
  } | null {
    if (by) {
      // К своему фронту — входя в его участок с начала заполнения, от узла, куда бригада доедет.
      const f = this.frontFor(id, by);
      const from = this.crews.startOf(by);
      if (!f || from === null) return null;
      return this.routeTo(id, f.c, f.fromB, this.reachFrom(from));
    }
    const c = this.current(id);
    return c ? this.routeTo(id, c, !!c.build!.fromB, (n) => this.accessRank(n) !== null, true) : null;
  }

  /**
   * Путь к краю работ участка c (заполняется от fromB) от узлов с подъездом (ok — узлы дорог; у ж/д проекта узел пути
   * с подъездом — тот, у которого есть подходящий подъезд, gate): Дейкстра по не занятым другими фронтами участкам
   * проекта (по номерам — детерминированно). Входит в участок с начала заполнения; anyEnd — с любого конца, какой ближе
   * (показ, главный фронт). entry — узел дороги, откуда съезжать; from — узел участка, откуда путь вдоль стройки
   * (у дороги — тот же). Нет пути — null.
   */
  private routeTo(
    id: number,
    c: Piece,
    fromB: boolean,
    ok: (n: number) => boolean,
    anyEnd = false,
  ): {
    c: Piece;
    s: number;
    end: number;
    entry: number;
    from: number;
    legs: { k: Piece; from: number }[];
  } | null {
    const busy = this.frontsOf(id);
    const list = this.piecesOf(id).filter((k) => k === c || !busy.includes(k));
    const b = c.build!;
    const f = b.done > 0 || !!b.fromB === fromB ? frontOf(spansOf(b, c.length), c.length).s : 0;
    // Край работ — в s метрах от конца a.
    const s = fromB ? c.length - f : f;
    const far = new Map<number, number>();
    const prev = new Map<number, { k: Piece; from: number }>();
    // Ж/д проект бригады не строят (строительный поезд, workTrains.ts): узлы его путей — не узлы дорог.
    if (this.isRail(id)) return null;
    for (const k of list) for (const n of [k.a, k.b]) if (!far.has(n) && ok(n)) far.set(n, 0);
    if (!far.size) return null;
    const done = new Set<number>();
    for (;;) {
      let u: number | null = null;
      for (const [n, d] of far) if (!done.has(n) && (u === null || d < far.get(u)! - 1e-9)) u = n;
      if (u === null) break;
      done.add(u);
      const du = far.get(u)!;
      for (const k of list) {
        // Сам участок фронта — только целью, не дорогой к нему.
        if ((k.a !== u && k.b !== u) || k === c) continue;
        const v = k.a === u ? k.b : k.a;
        const dv = du + k.length;
        if (dv < (far.get(v) ?? Infinity) - 1e-9) {
          far.set(v, dv);
          prev.set(v, { k, from: u });
        }
      }
    }
    const start = fromB ? c.b : c.a;
    let end = start;
    if (anyEnd) {
      const viaA = (far.get(c.a) ?? Infinity) + s;
      const viaB = (far.get(c.b) ?? Infinity) + (c.length - s);
      if (!Number.isFinite(Math.min(viaA, viaB))) return null;
      end = viaA <= viaB ? c.a : c.b;
    } else if (!far.has(start)) return null;
    const legs: { k: Piece; from: number }[] = [];
    let node = end;
    for (let step = prev.get(node); step; step = prev.get(node)) {
      legs.unshift(step);
      node = step.from;
    }
    return { c, s, end, entry: node, from: node, legs };
  }

  /** Номер следующего проекта (план помечает им новые полотна, startProject заводит запись). */
  peekId(): number {
    return this.nextId;
  }

  /** Проект заложен: полотна уже помечены в сети net. */
  start(id: number, net: LaneNet, corridors: number[]): Project {
    this.nextId = Math.max(this.nextId, id + 1);
    const cs = corridors.map((c) => net.corridors.get(c)).filter((c): c is Corridor => !!c);
    const p: Project = {
      id,
      label: projectLabel(net, cs),
      builtLen: 0,
      spent: 0,
      created: this.host.time,
    };
    // Где он на карте — рамка полотен: достроили — клик по уведомлению «Стройка закончена» ведёт камеру сюда.
    const area = areaOf(cs);
    if (area) p.area = area;
    this.projects.set(id, p);
    this.stamp++;
    return p;
  }

  /**
   * Ж/д проект id заложен или продолжен: пути segs сети путей уже помечены (Segment.build). Новый — запись проекта
   * («Ж/д путь»), уже есть (путь продолжили от его конца) — рамка шире.
   */
  startRail(id: number, segs: number[]): Project | null {
    const rails = this.host.net;
    if (!rails) return null;
    const list = segs.map((s) => rails.segments.get(s)).filter((s): s is Segment => !!s);
    const was = this.projects.get(id);
    if (was?.rail) {
      const all = this.segmentsOf(id);
      const area = areaOf(all.length ? all : list);
      if (area) was.area = area;
      was.label = railLabel(rails, all.length ? all : list);
      this.stamp++;
      return was;
    }
    this.nextId = Math.max(this.nextId, id + 1);
    const p: Project = { id, label: railLabel(rails, list), builtLen: 0, spent: 0, created: this.host.time, rail: true };
    const area = areaOf(list);
    if (area) p.area = area;
    this.projects.set(id, p);
    this.stamp++;
    return p;
  }

  /** Полотна проекта, что ещё строятся (по номеру). */
  corridorsOf(id: number): Corridor[] {
    const net = this.host.roads.net;
    let ix = this.index;
    if (!ix || ix.net !== net || ix.version !== net.version) {
      const of = new Map<number, Corridor[]>();
      for (const c of net.corridors.values()) {
        if (!c.build) continue;
        let list = of.get(c.build.project);
        if (!list) of.set(c.build.project, (list = []));
        list.push(c);
      }
      for (const list of of.values()) list.sort((a, b) => a.id - b.id);
      ix = this.index = { net, version: net.version, of };
    }
    return ix.of.get(id) ?? [];
  }

  /** Пути ж/д проекта, что ещё строятся (по номеру); у дорожного проекта — пусто. */
  segmentsOf(id: number): Segment[] {
    const rails = this.host.net;
    if (!rails) return [];
    let ix = this.railIndex;
    if (!ix || ix.net !== rails || ix.version !== rails.version) {
      const of = new Map<number, Segment[]>();
      for (const s of rails.segments.values()) {
        if (!s.build) continue;
        let list = of.get(s.build.project);
        if (!list) of.set(s.build.project, (list = []));
        list.push(s);
      }
      for (const list of of.values()) list.sort((a, b) => a.id - b.id);
      ix = this.railIndex = { net: rails, version: rails.version, of };
    }
    return ix.of.get(id) ?? [];
  }

  /** Цена и темп участка проекта id: полотна дороги (price) или пути. */
  private priceOf(id: number, c: Piece): { full: number; rate: number } {
    if (!this.isRail(id)) return this.price(this.host.roads.net, c as Corridor);
    const rails = this.host.net!;
    const s = c as Segment;
    const key = `r${s.id}:${s.rev}`;
    let hit = this.prices.get(key);
    if (!hit) {
      if (this.prices.size > 4000) this.prices.clear();
      hit = { full: Math.round(this.host.railCost?.(s) ?? 0), rate: railBuildRate(rails, s, (p, m) => this.host.isWater(p, m)) };
      this.prices.set(key, hit);
    }
    return hit;
  }

  private price(net: LaneNet, c: Corridor): { full: number; rate: number } {
    const key = `${c.id}:${c.rev}`;
    let hit = this.prices.get(key);
    if (!hit) {
      if (this.prices.size > 4000) this.prices.clear();
      const water = (p: Vec, m?: number) => this.host.isWater(p, m);
      hit = {
        full: fullCorridorCost(net, c, water, this.host.ground()),
        rate: buildRate(net, c, water),
      };
      this.prices.set(key, hit);
    }
    return hit;
  }

  /**
   * Участок, который строится сейчас: начатый, иначе примыкающий к готовым дорогам (отсчёт — от готового конца),
   * иначе первый. Выбранному с нуля ставится, с какого конца он заполняется.
   */
  current(id: number): Piece | null {
    const net = this.host.roads.net;
    const rails = this.isRail(id) ? this.host.net! : null;
    // Главный фронт: начатый участок, иначе тот, куда уже едет бригада (его конец она уже выбрала — не трогаем).
    const front = this.frontsOf(id)[0];
    if (front) return front;
    // Выбор — pickSite (тот же, что предсказывает следующий участок для колонны техники, nextSite).
    // Из не начатых — от подъезда ближе к базе (accessRank); подъезда нет нигде — как прежде, только для показа.
    const open = rails
      ? (node: number) => rails.node(node).segments.some((k) => !rails.segments.get(k)?.build)
      : (node: number) => net.node(node).corridors.some((k) => !net.corridors.get(k)?.build);
    const pick = pickSite(this.piecesOf(id), open, (node) => this.pieceAccess(id, node));
    if (!pick) return null;
    const { c, fromB } = pick;
    if (c.build!.done <= 0 && !!c.build!.fromB !== fromB) c.build = fromB ? { project: id, done: 0, fromB: true } : { project: id, done: 0 };
    return c;
  }

  /** Такт стройки: каждый проект (по порядку закладки) — вперёд на dt секунд работы. */
  tick(dt: number): void {
    // Сеть дорог заменили мимо Game.networkChanged — техника на подвинутых полотнах переезжает с ними.
    this.syncNet();
    // Бригады решают, куда ехать (и возвращаются на базы, когда проектов нет).
    this.crews.tick();
    // Строительные поезда ж/д проектов: выезжают, перекатываются за краем работ, едут домой.
    this.trains?.tick();
    if (!this.projects.size) return;
    for (const p of [...this.projects.values()]) {
      // Недостроенное снесли (бульдозер, рамка) — проекта больше нет; достроенным он не считается.
      if (!this.piecesOf(p.id).length) {
        this.projects.delete(p.id);
        continue;
      }
      if (p.paused || !this.advance(p, dt)) continue;
      if (!this.piecesOf(p.id).length) {
        this.projects.delete(p.id);
        this.host.projectEvent?.('done', p);
      }
    }
    this.trackCrews();
    this.stamp++;
  }

  /** Проект вперёд на dt секунд: метры, деньги за них, готовые участки открываются. true — открыт участок. */
  private advance(p: Project, dt: number): boolean {
    const net = this.host.roads.net;
    const rail = this.isRail(p.id);
    let opened = false;
    /** Узел, у которого кончился последний готовый участок (там бригады, если проект достроен). */
    let last: number | null = null;
    // Бригада на месте без своего фронта (старое сохранение) — за тот, что ей ближе (обычно — единственный начатый).
    for (const b of this.crews.working(p.id)) if (!b.front || !this.pieceById(p.id, b.front.corridor)) this.claim(p.id, b);
    // Каждый фронт — сам по себе: свой участок, свои бригады, свой темп; деньги — общие, кончились — встают все.
    let stalled = false;
    // Ни одного фронта ещё нет — главный (current): темпа без бригад у него нет, но так проект и начинается.
    const fronts = this.frontsOf(p.id);
    const main = fronts.length ? null : this.current(p.id);
    if (main) fronts.push(main);
    for (const front of fronts) {
      if (stalled) break;
      let c: Piece | null = front;
      let left = dt;
      // Участок кончился посреди такта — остаток времени идёт на следующий участок фронта (не больше нескольких за такт).
      for (let guard = 0; c && left > 1e-9 && guard < 8; guard++) {
        const b = c.build!;
        const L = c.length;
        const crews = this.crews.working(p.id).filter((o) => o.front?.corridor === c!.id);
        // Темп этапа — по бригадам этого фронта, чья машина этого этапа на месте (Crews.placed): первая доехавшая
        // машина ведёт отсыпку, пока остальные в пути; никого нет — фронт ждёт.
        const pos = this.frontOn(c).pos;
        const placed = crews.map((o) => this.crews.placed(o));
        const { full, rate } = this.priceOf(p.id, c);
        // Ж/д: все три этапа ведёт строительный поезд, вставший у края готового пути (workTrains.ts).
        const work = rail ? (this.trains?.power(p.id, c.id, pos) ?? 0) : 0;
        const speed = [0, 1, 2].map((k) => rate * (rail ? work : this.crews.rateOf(crews.filter((_, i) => placed[i][k]), pos)));
        if (speed.every((v) => v <= 0)) break;
        // Каждый этап — своим ходом (покрытие — не ближе convoyGap к отсыпке, разметка — к покрытию); готово и деньги —
        // по долям этапов (stageWork): за метр — та же цена, за участок — та же сумма.
        const moved = advanceStages(spansOf(b, L), L, speed, left);
        const complete = moved.spans[2] >= L - 1e-6;
        const done = complete ? L : Math.max(b.done, stageWork(moved.spans, L));
        const cost = paidFor(full, done, L) - paidFor(full, b.done, L);
        // Сперва — из резерва проекта, остальное — из свободного бюджета (до кредитного предела: резерв его не обходит).
        const fromReserve = Math.min(cost, p.reserve ?? 0);
        const free = this.host.budget;
        if (cost > 0 && (cost - fromReserve > Math.max(0, free) || cost > free + this.reserved())) {
          if (p.stalled === undefined) {
            p.stalled = this.host.time;
            this.host.projectEvent?.('stalled', p);
          }
          stalled = true;
          break;
        }
        delete p.stalled;
        if (cost > 0) {
          if (fromReserve > 0) {
            const rest = (p.reserve ?? 0) - fromReserve;
            if (rest > 0) p.reserve = rest;
            else delete p.reserve;
          }
          this.host.spend(cost);
          p.spent += cost;
        }
        left -= moved.used;
        if (complete) {
          // Следующий участок фронта — до открытия этого (пока он ещё «свой», continuation его не считает чужим).
          const next = this.continuation(p.id, c, !!b.fromB);
          delete c.build;
          this.touchPiece(p.id, c);
          p.builtLen += c.length;
          opened = true;
          last = b.fromB ? c.a : c.b;
          // Граф движения — сразу: подъезд к следующему участку — по только что открытому (accessRank).
          this.host.networkChanged();
          // Фронт идёт дальше по продолжению; продолжения нет (встретил другой фронт) — его бригады свободны для других
          // фронтов и проектов (едут туда своим ходом — trackCrews, relocate).
          if (next) {
            next.c.build = next.fromB ? { project: p.id, done: 0, fromB: true } : { project: p.id, done: 0 };
            for (const o of crews) o.front = { corridor: next.c.id, fromB: next.fromB };
          } else for (const o of crews) delete o.front;
          // Ж/д: поезд перекатывается на готовый участок и строит следующий (или ищет другой участок).
          if (rail) this.trains?.completed(p.id, c as Segment, next);
          c = next?.c ?? null;
        } else c.build = { ...b, done, stages: moved.spans };
      }
    }
    // Бригады на месте — у нового края работ своего фронта (съехали с дороги у узла подъезда); проект достроен — у конца
    // последнего участка: оттуда они и поедут дальше по уже готовой дороге.
    // Ж/д: бригад нет — строительный поезд сам едет дальше или домой (WorkTrains.tick).
    if (rail) return opened;
    if (!this.piecesOf(p.id).length) {
      if (last !== null) this.crews.follow(p.id, net.node(last).pos, last);
      return opened;
    }
    for (const o of this.crews.working(p.id)) {
      const s = this.site(p.id, o);
      if (s) this.crews.followOne(o, s.pos, s.node);
    }
    return opened;
  }

  /** Сводка проекта; нет такого — null. */
  info(id: number): ProjectInfo | null {
    const p = this.projects.get(id);
    if (!p) return null;
    const list = this.piecesOf(id);
    let length = p.builtLen;
    let ready = p.builtLen;
    let seconds = 0;
    let left = 0;
    let mid: Vec = { x: 0, y: 0 };
    let weight = 0;
    const cur = list.find((c) => c.build!.done > 0) ?? null;
    const front = cur ? this.frontOn(cur).pos : null;
    // Сколько осталось — при нынешних бригадах на месте; никого нет — как с одной бригадой с ближайшей базы.
    const at = front ?? list[0]?.lut.pointAt(0) ?? { x: 0, y: 0 };
    // Ж/д: строит один строительный поезд — с его вокзала (не вышел — с ближайшего); «ещё бригады» у него нет.
    const rail = this.isRail(id) ? this.trains : null;
    const train = rail?.of(id);
    const crew = rail ? (train ? rail.powerFrom(train.depot, at) : 0) : this.crews.rate(id, at);
    const k = crew > 0 ? crew : rail ? rail.nearestPower(at) : this.crews.nearestPower(at);
    // Ещё одна бригада — с ближайшей базы, своей долей (CONSTRUCTION.crewShare): вторая и третья прибавляют меньше.
    const n = Math.max(1, this.crews.working(id).length);
    const share = CONSTRUCTION.crewShare;
    const plus = !rail && n < this.crews.cap(id) ? k + this.crews.nearestPower(at) * (share[n] ?? share[share.length - 1]) : null;
    const stages: [number, number, number] = [p.builtLen, p.builtLen, p.builtLen];
    // Ж/д: подъезд — есть вокзал, откуда поезду доехать по путям (WorkTrains.problem); баз и их радиуса у него нет.
    const access = rail ? rail.problem(id) === null : this.site(id) !== null;
    const near = rail ? access : access && this.nearBase(id);
    for (const c of list) {
      const b = c.build!;
      const { full, rate } = this.priceOf(id, c);
      const sp = spansOf(b, c.length);
      for (let i = 0; i < 3; i++) stages[i] += sp[i];
      length += c.length;
      ready += b.done;
      // Участок готов, когда разметка дошла до конца: каждый этап — не раньше, чем через convoyGap после предыдущего.
      seconds += stageSeconds(sp, c.length, rate * k);
      left += full - paidFor(full, b.done, c.length);
      const m = c.lut.pointAt(c.length / 2);
      mid = { x: mid.x + m.x * c.length, y: mid.y + m.y * c.length };
      weight += c.length;
    }
    return {
      project: p,
      done: length > 0 ? ready / length : 1,
      seconds,
      length,
      left: Math.round(left),
      front,
      at: weight > 0 ? { x: mid.x / weight, y: mid.y / weight } : (front ?? { x: 0, y: 0 }),
      secondsPlus: plus !== null ? (seconds * k) / plus : null,
      stages: stages.map((s) => (length > 0 ? Math.min(1, s / length) : 1)) as [number, number, number],
      access,
      waits: !access && this.waitsNeighbor(id),
      near,
      noBase: !rail && access && !near && !p.paused && !this.crews.assigned(id).length,
    };
  }

  /**
   * Подъезда к проекту id нет, но по строящимся полотнам других проектов (не на паузе) от его узлов можно дойти до
   * узла с подъездом (accessRank): соседний проект дорастёт — подъезд появится.
   */
  waitsNeighbor(id: number): boolean {
    const own = this.piecesOf(id);
    if (!own.length) return false;
    // Соседи — проекты того же вида: узлы дорог и путей — разные сети.
    const rail = this.isRail(id);
    const at = new Map<number, Piece[]>();
    for (const p of this.projects.values()) {
      if (p.id === id || p.paused || this.isRail(p.id) !== rail) continue;
      for (const c of this.piecesOf(p.id)) for (const n of [c.a, c.b]) at.set(n, [...(at.get(n) ?? []), c]);
    }
    const seen = new Set<number>();
    const queue: number[] = [];
    for (const c of own) {
      for (const n of [c.a, c.b]) {
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    while (queue.length) {
      const n = queue.shift()!;
      for (const c of at.get(n) ?? []) {
        const m = c.a === n ? c.b : c.a;
        if (seen.has(m)) continue;
        if (this.pieceAccess(id, m) !== null) return true;
        seen.add(m);
        queue.push(m);
      }
    }
    return false;
  }

  /** Из чего недостроенное: метров на земле, по мостам, в тоннелях, над водой; самая высокая насыпь и глубокая выемка. */
  parts(id: number): ProjectParts {
    const net = this.host.roads.net;
    const rails = this.isRail(id) ? this.host.net! : null;
    const out: ProjectParts = {
      ground: 0,
      bridge: 0,
      tunnel: 0,
      water: 0,
      fill: 0,
      cut: 0,
    };
    for (const c of this.piecesOf(id)) {
      const key = `${rails ? 'r' : ''}${c.id}:${c.rev}`;
      let hit = this.partsCache.get(key);
      if (!hit) {
        if (this.partsCache.size > 2000) this.partsCache.clear();
        hit = { ground: 0, bridge: 0, tunnel: 0, water: 0, fill: 0, cut: 0 };
        const n = Math.max(2, Math.ceil(c.length / 24));
        for (let i = 0; i < n; i++) {
          const s = (c.length * (i + 0.5)) / n;
          const h = rails ? rails.levelAt(c as Segment, s) : net.heightAt(c as Corridor, s);
          const len = c.length / n;
          if (h < -0.25) hit.tunnel += len;
          else if (h > 0.25) {
            if (this.host.isWater(c.lut.pointAt(s), 2)) hit.water += len;
            else hit.bridge += len;
          } else hit.ground += len;
        }
        const prof = rails
          ? trackProfile(c.lut, rails.node(c.a).level, rails.node(c.b).level, this.host.ground())
          : corridorProfile(net, c as Corridor, this.host.ground());
        if (prof) {
          hit.fill = prof.fill;
          hit.cut = prof.cut;
        }
        this.partsCache.set(key, hit);
      }
      out.ground += hit.ground;
      out.bridge += hit.bridge;
      out.tunnel += hit.tunnel;
      out.water += hit.water;
      out.fill = Math.max(out.fill, hit.fill);
      out.cut = Math.max(out.cut, hit.cut);
    }
    return out;
  }

  /** Сколько всего отложено на проекты, $. */
  reserved(): number {
    let sum = 0;
    for (const p of this.projects.values()) sum += p.reserve ?? 0;
    return sum;
  }

  /** Резерв проекта: amount (целыми долларами, 0 — снять). Сколько можно отложить, решает игра (Game.reserveProject). */
  setReserve(id: number, amount: number): void {
    const p = this.projects.get(id);
    if (!p) return;
    const a = Math.max(0, Math.floor(amount));
    if (a > 0) p.reserve = a;
    else delete p.reserve;
    this.stamp++;
  }

  /** Приоритет проекта: бригады — сначала к нему (crews.ts). */
  setPriority(id: number, on: boolean): void {
    const p = this.projects.get(id);
    if (!p || !!p.priority === on) return;
    if (on) p.priority = true;
    else delete p.priority;
    this.stamp++;
  }

  /** Все проекты по порядку закладки — со сводками. */
  list(): ProjectInfo[] {
    return [...this.projects.keys()].map((id) => this.info(id)!).filter(Boolean);
  }

  setPaused(id: number, paused: boolean): void {
    const p = this.projects.get(id);
    if (!p || !!p.paused === paused) return;
    if (paused) p.paused = true;
    else delete p.paused;
    this.stamp++;
  }

  /**
   * Сеть дорог заменили (правка дорог, Ctrl+Z): полотна, что изогнули или перенесли («Двигать», проект перемещения),
   * увозят с собой технику бригад, что стоит и едет по ним вне потока (crewCarry.ts) — ни одна машина не остаётся там,
   * где полотно было. Сеть та же (правка на месте, такт стройки) — ничего. Зовут Game.networkChanged, restore и такт.
   */
  syncNet(): void {
    const net = this.host.roads.net;
    const was = this.seenNet;
    this.seenNet = net;
    if (!was || was === net || !this.crews.brigades.size) return;
    const carry = new CrewCarry(was, net);
    if (carry.empty) return;
    for (const b of this.crews.brigades.values()) {
      // Ж/д стройка: полоса — вдоль пути, не по дорогам; дорога рядом подвинулась — путь на месте.
      if (b.project !== undefined && this.isRail(b.project)) continue;
      carry.brigade(b, this.host.time, b.lane ? this.crewSlots(b) : null);
    }
    this.stamp++;
  }

  /** Записи без полотен (отмена стройки, Ctrl+Z) — убрать. */
  prune(): void {
    for (const id of [...this.projects.keys()]) if (!this.piecesOf(id).length) this.projects.delete(id);
    this.stamp++;
  }

  /** Записи проектов — копией (для отмены). */
  snapshot(): Project[] {
    return [...this.projects.values()].map((p) => ({ ...p }));
  }

  /** После отмены: проекты из снимка, которых больше нет (отменённые, достроенные), — снова; лишние — прочь. */
  restore(list: Project[]): void {
    // Сеть дорог — уже из снимка: подвинутое правкой полотно вернулось — техника на нём тоже.
    this.syncNet();
    for (const p of list) if (!this.projects.has(p.id)) this.projects.set(p.id, { ...p });
    // Порядок — по номеру: тот же, что у закладки.
    const sorted = [...this.projects.values()].sort((a, b) => a.id - b.id);
    this.projects.clear();
    for (const p of sorted) this.projects.set(p.id, p);
    this.prune();
  }

  toSave(): ConstructionSave | undefined {
    const crews = this.crews.toSave();
    const trains = this.trains?.toSave();
    if (!this.projects.size && this.nextId === 1 && !crews && !trains) return undefined;
    return {
      nextId: this.nextId,
      projects: [...this.projects.values()].map((p) => ({ ...p })),
      ...(crews ? { crews } : {}),
      ...(trains ? { trains } : {}),
    };
  }

  load(save: ConstructionSave | undefined): void {
    this.projects.clear();
    this.crews.load(save?.crews);
    this.trains?.load(save?.trains);
    // Техника сохранена уже по этой сети — переносить нечего.
    this.seenNet = this.host.roads.net;
    this.nextId = save?.nextId ?? 1;
    for (const p of save?.projects ?? []) this.projects.set(p.id, { ...p });
    // Строящиеся полотна без записи проекта (сохранение правили руками) — тоже проекты: иначе встали бы навсегда.
    const net = this.host.roads.net;
    const orphans = new Map<number, Corridor[]>();
    for (const c of net.corridors.values()) {
      if (!c.build || this.projects.has(c.build.project)) continue;
      orphans.set(c.build.project, [...(orphans.get(c.build.project) ?? []), c]);
    }
    for (const [id, cs] of [...orphans].sort((a, b) => a[0] - b[0])) {
      this.projects.set(id, {
        id,
        label: projectLabel(net, cs),
        builtLen: 0,
        spent: 0,
        created: this.host.time,
      });
      this.nextId = Math.max(this.nextId, id + 1);
    }
    // Так же — строящиеся пути без записи ж/д проекта (номер занят дорогой — путь достроен: не стоять же ему вечно).
    const rails = this.host.net;
    const railOrphans = new Map<number, Segment[]>();
    for (const s of rails?.segments.values() ?? []) {
      if (!s.build) continue;
      const p = this.projects.get(s.build.project);
      if (p?.rail) continue;
      if (p) {
        delete s.build;
        rails!.touch(s.a);
        continue;
      }
      railOrphans.set(s.build.project, [...(railOrphans.get(s.build.project) ?? []), s]);
    }
    for (const [id, ss] of [...railOrphans].sort((a, b) => a[0] - b[0])) {
      this.projects.set(id, { id, label: railLabel(rails!, ss), builtLen: 0, spent: 0, created: this.host.time, rail: true });
      this.nextId = Math.max(this.nextId, id + 1);
    }
    this.prune();
  }
}

/** Край работ на участке c, что заполняется от конца fromB (не начатый — у начала заполнения). */
function frontPoint(c: Piece, fromB: boolean): Vec {
  const b = c.build;
  const f = b && b.done > 0 ? frontOf(spansOf(b, c.length), c.length).s : 0;
  return c.lut.pointAt(fromB ? c.length - f : f);
}

/** Точки оси участка k от s0 до s1 (без первой) с шагом не больше step метров — в конец pts. */
function alongCorridor(pts: Vec[], k: Piece, s0: number, s1: number, step: number): void {
  const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / step));
  for (let i = 1; i <= n; i++) pts.push(k.lut.pointAt(s0 + ((s1 - s0) * i) / n));
}


/** Рамка участков на карте [x0, y0, x1, y1] (нет участков — undefined). */
function areaOf(cs: readonly Piece[]): [number, number, number, number] | undefined {
  const pts = cs.flatMap((c) => c.lut.points);
  if (!pts.length) return undefined;
  const xs = pts.map((q) => q.x);
  const ys = pts.map((q) => q.y);
  return [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))];
}

/** Подпись ж/д проекта по его путям: «Ж/д путь», мост и тоннель — если есть. */
export function railLabel(net: Network, segs: readonly Segment[]): string {
  const parts = ['Ж/д путь'];
  const level = (s: Segment) => [net.node(s.a).level, net.node(s.b).level];
  if (segs.some((s) => level(s).some((l) => l > 0))) parts.push('мост');
  if (segs.some((s) => level(s).some((l) => l < 0))) parts.push('тоннель');
  return parts.join(' · ');
}

/**
 * Съезд колонны с дороги на стройку: головная стоит в своей полосе у узла (p, курс d), дальше путь body — от центра
 * узла по оси проекта. Поворот — там, где линия полосы пересекает ось проекта (как машина и повернула бы, не заезжая к
 * центру узла и не виляя); прямо (ось — почти продолжение полосы) — плавно с полосы на ось на 25 м пути. Ответ — точки
 * пути после p (скругляет их fillet).
 */
function turnIn(p: Vec, d: Vec, body: readonly Vec[]): Vec[] {
  const c = body[0];
  // Ось проекта у узла: от центра узла к точке метрах в 12 дальше.
  const far = body.find((q) => dist(q, c) >= 12) ?? body[body.length - 1];
  const len = dist(far, c);
  if (len < 1) return [...body];
  const o = { x: (far.x - c.x) / len, y: (far.y - c.y) / len };
  const den = d.x * o.y - d.y * o.x;
  if (Math.abs(den) > 0.25) {
    // p + a·d = c + b·o.
    const w = sub(c, p);
    const a = (w.x * o.y - w.y * o.x) / den;
    const b = (w.x * d.y - w.y * d.x) / den;
    if (a > 0.5 && a < 40 && b > -15 && b < 15) {
      const x = { x: p.x + d.x * a, y: p.y + d.y * a };
      // Дальше — по оси: точки за точкой поворота, не ближе 10 м к ней (место на скругление).
      return [x, ...body.filter((q) => dot(sub(q, c), o) > b + 10)];
    }
  }
  // Почти прямо: с полосы на ось — плавно, без поворота у центра узла.
  return body.filter((q) => dot(sub(q, p), d) > 25 || dist(q, p) > 25);
}

/** Название проекта для показа: своё, если игрок его дал, иначе автоматическое (projectLabel). */
export function projectName(p: Pick<Project, 'label' | 'name'>): string {
  return p.name ?? p.label;
}

/** Подпись проекта по его полотнам: класс и полосы самого длинного, мост и тоннель — если есть. */
export function projectLabel(net: LaneNet, cs: Corridor[]): string {
  if (!cs.length) return 'Дорога';
  const main = [...cs].sort((a, b) => b.length - a.length)[0];
  const fwd = main.lanes.filter((l) => l.flow > 0).length;
  const back = main.lanes.filter((l) => l.flow < 0).length;
  const parts = [`${ROAD_CLASSES[main.cls].name} ${back ? `${fwd}+${back}` : `${fwd}→`}`];
  const level = (c: Corridor) => [net.node(c.a).level, net.node(c.b).level];
  if (cs.some((c) => level(c).some((l) => l > 0))) parts.push('мост');
  if (cs.some((c) => level(c).some((l) => l < 0))) parts.push('тоннель');
  return parts.join(' · ');
}
