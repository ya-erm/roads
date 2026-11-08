/**
 * Строительные поезда (режим «Со строительством», ж/д проекты — src/game/construction.ts): ж/д путь строит не
 * бригада с дорог, а путеукладочный поезд — по самим путям, без дорог рядом.
 *
 * - Откуда: с ближайшего вокзала игрока (депо), от платформы которого по готовым путям можно доехать до начала работ.
 *   Своего парка у поездов нет: на каждый ж/д проект — один поезд, его работа — в цене метра (содержания нет).
 * - Куда: к краю готового пути у участка проекта (подход — готовый путь в узле, где участок начинается). Поезд
 *   едет в общем движении (RailSim: брони, сигналы, другие поезда), встаёт головой к стройке и строит: балласт →
 *   шпалы → рельсы, у каждого этапа — свой край (как у бригады); готов участок — поезд перекатывается на него
 *   (хоп по готовому) и строит следующий, что продолжает этот. Продолжения нет — едет по путям к другому участку
 *   проекта; некуда — домой на вокзал, там исчезает.
 * - Темп — как у бригады: 1 / (1 + d / CONSTRUCTION.reach), d — от вокзала-депо до края работ (возит балласт и шпалы).
 * - Нет ни одного вокзала, откуда доехать до начала проекта, — «🚂 нет пути» (WorkTrains.status): поезд не едет.
 * - Пауза, отмена, конец проекта — поезд едет обратно на свой вокзал.
 *
 * Детерминизм: решения — по номерам и расстояниям, проверки повторяются не чаще RETRY секунд игры.
 */
import { CONSTRUCTION } from '../config';
import { dist, type Vec } from '../core/vec';
import type { RailSim, Train } from '../sim/rail';
import type { Network, Segment } from '../world/network';
import { frontOf, spansOf } from './constructionWork';

export type WorkTrainState = 'going' | 'working' | 'back';

/** Что поезд делает — для карточки: ждёт выезда (ещё не на путях), едет к стройке, строит, едет домой на вокзал. */
export type WorkTrainDoing = 'wait' | 'going' | 'working' | 'back';

/** Строительный поезд ж/д проекта. */
export interface WorkTrain {
  id: number;
  project: number;
  /** Вокзал-депо: отсюда вышел, сюда вернётся. */
  depot: number;
  state: WorkTrainState;
  /** Поезд в симуляции путей (RailSim); нет — ещё не вышел (платформа занята, путь закрыт). */
  train?: number;
  /** Участок проекта, к которому едет или который строит, и с какого конца он заполняется. */
  front?: { corridor: number; fromB: boolean };
  /** Готовый участок, на который поезду перекатиться (кончил его и строит следующий). */
  hop?: number;
}

export interface WorkTrainSave {
  trains: WorkTrain[];
  nextId: number;
}

/** Почему ж/д проект стоит без поезда: 'route' — ни с одного вокзала не доехать до начала работ; 'depot' — вокзалов нет. */
export type WorkTrainProblem = 'route' | 'depot' | null;

/** Что строительные поезда знают об игре. */
export interface WorkTrainHost {
  readonly time: number;
  readonly net: Network;
  readonly rail: RailSim;
  /** Вокзалы игрока (по номеру): где и их платформы. */
  depots(): { id: number; pos: Vec; platforms: number[] }[];
  /** Ж/д проекты, которым нужен поезд: не на паузе и с недостроенным (по порядку закладки). */
  projects(): number[];
  /** Строящиеся пути проекта (по номеру). */
  pieces(project: number): Segment[];
}

/** Строительный поезд: состав (CONSTRUCTION.workTrain), цвет путейцев, в вагонах — балласт. */
export const WORK_TRAIN = { ...CONSTRUCTION.workTrain, color: '#e2622c', load: '#9c948a' } as const;

/** Путеукладчик на месте работ — длина с зазором (как рисует drawTrackMachines): вагоны — позади него. */
const CRANE = 16;
/** Через сколько метров брать точки состава и маршрута. */
const STEP = 4;

/**
 * Точка и курс (по ходу заполнения) на месте работ: u метров от начала участка seg (заполняется с конца b — fromB);
 * меньше нуля — назад по готовому пути back (нет — у начала участка). Так стоит техника и состав строительного поезда.
 */
export function sitePoint(seg: Segment, fromB: boolean, back: Segment | null, u: number): { p: Vec; d: Vec } {
  const L = seg.length;
  if (u >= 0 || !back) {
    const x = Math.max(0, Math.min(L, u));
    const s = fromB ? L - x : x;
    const t = seg.lut.tangentAt(s);
    return { p: seg.lut.pointAt(s), d: fromB ? { x: -t.x, y: -t.y } : t };
  }
  // По back от узла начала назад: курс — к узлу.
  const toStart = back.b === (fromB ? seg.b : seg.a);
  const r = Math.min(back.length, -u);
  const s = toStart ? back.length - r : r;
  const t = back.lut.tangentAt(s);
  return { p: back.lut.pointAt(s), d: toStart ? t : { x: -t.x, y: -t.y } };
}

/** Не чаще стольких секунд игры — повторная попытка выехать или найти путь (платформа занята, пути нет). */
const RETRY = 2;
/** Сколько ближайших вокзалов пробовать как депо. */
const DEPOTS = 8;

export class WorkTrains {
  readonly list = new Map<number, WorkTrain>();
  nextId = 1;
  /** Ж/д проекты без поезда — почему (по номеру проекта); проверено в retry. */
  private readonly problems = new Map<number, WorkTrainProblem>();
  /** Когда снова пробовать (по номеру поезда или −номеру проекта), секунд игры. */
  private readonly retry = new Map<number, number>();

  constructor(private readonly host: WorkTrainHost) {}

  /** Поезд проекта (один на проект). */
  of(project: number): WorkTrain | undefined {
    for (const w of this.list.values()) if (w.project === project && w.state !== 'back') return w;
    return undefined;
  }

  /** Строительный поезд, которому принадлежит поезд симуляции train. */
  ofTrain(train: number): WorkTrain | undefined {
    for (const w of this.list.values()) if (w.train === train) return w;
    return undefined;
  }

  /** Почему проект без поезда (null — поезд есть или едет, или ещё не проверяли). */
  problem(project: number): WorkTrainProblem {
    return this.problems.get(project) ?? null;
  }

  /**
   * Что с поездом ж/д проекта — для плашки, строки вкладки, карточки и советника: значок и коротко (text), подсказка
   * (tip), беда (bad — стройка стоит: поезду неоткуда выйти или не доехать), строит ли (working). depotName — название
   * вокзала по номеру.
   */
  status(project: number, depotName: (id: number) => string): { text: string; tip: string; bad: boolean; working: boolean } {
    const p = this.problem(project);
    if (p === 'depot')
      return {
        text: 'нет вокзала',
        tip: 'Ж/д путь строит строительный поезд, а он выходит с вокзала. Поставьте вокзал на готовом пути, от которого начинается проект, — или у начала самого пути',
        bad: true,
        working: false,
      };
    if (p === 'route')
      return {
        text: 'нет пути к стройке',
        tip: 'Строительный поезд ездит только по готовым путям, а ни с одного вокзала до начала проекта не доехать. Начните путь от готового пути, к которому есть вокзал, или поставьте вокзал у начала проекта',
        bad: true,
        working: false,
      };
    const w = this.of(project);
    if (!w) return { text: 'ждёт поезд', tip: 'Строительный поезд скоро выйдет с ближайшего вокзала', bad: false, working: false };
    const from = `с вокзала «${depotName(w.depot)}»`;
    if (w.state === 'working')
      return { text: 'строит', tip: `Строительный поезд ${from} стоит у края готового пути и укладывает путь перед собой: балласт, шпалы, рельсы`, bad: false, working: true };
    if (w.train === undefined)
      return { text: 'ждёт выезда', tip: `Строительный поезд ждёт свободную платформу вокзала «${depotName(w.depot)}»`, bad: false, working: false };
    return { text: 'едет', tip: `Строительный поезд ${from} едет по путям к стройке`, bad: false, working: false };
  }

  /** Поезд строит участок piece проекта: его вклад в темп (0 — не строит). */
  power(project: number, piece: number, front: Vec): number {
    const w = this.of(project);
    if (!w || w.state !== 'working' || w.front?.corridor !== piece) return 0;
    return this.powerFrom(w.depot, front);
  }

  /** Вклад поезда с вокзала depot у края работ at: дальше от депо — медленнее (как у бригады). */
  powerFrom(depot: number, at: Vec): number {
    const d = this.host.depots().find((x) => x.id === depot);
    return 1 / (1 + (d ? dist(d.pos, at) : 0) / CONSTRUCTION.reach);
  }

  /** Вклад поезда с ближайшего вокзала — прикидка, пока поезд не на месте; вокзалов нет — 1. */
  nearestPower(at: Vec): number {
    let best = 0;
    for (const d of this.host.depots()) best = Math.max(best, 1 / (1 + dist(d.pos, at) / CONSTRUCTION.reach));
    return best || 1;
  }

  private sim(w: WorkTrain): Train | undefined {
    return w.train !== undefined ? this.host.rail.trains.get(w.train) : undefined;
  }

  /** Убрать поезд из симуляции и сам строительный поезд. */
  private drop(w: WorkTrain): void {
    const t = this.sim(w);
    if (t) this.host.rail.remove(t);
    this.list.delete(w.id);
  }

  private wait(key: number): boolean {
    return (this.retry.get(key) ?? -Infinity) > this.host.time;
  }

  private later(key: number): void {
    this.retry.set(key, this.host.time + RETRY);
  }

  /** Такт: поезда выезжают к проектам, перекатываются за краем работ, ищут следующий участок, едут домой. */
  tick(): void {
    const live = new Set(this.host.projects());
    for (const w of [...this.list.values()].sort((a, b) => a.id - b.id)) {
      const t = this.sim(w);
      // Поезда в симуляции нет (снесли путь под ним, сохранение без него) — выйдет заново.
      if (w.train !== undefined && !t) {
        this.list.delete(w.id);
        continue;
      }
      if (w.state !== 'back' && !live.has(w.project)) this.home(w);
      // Не выехал (платформа депо занята) или стоит — путь был закрыт: снова в путь.
      else if (w.state === 'going' && (!t || !t.moving)) this.launch(w);
      else if (w.state === 'working') this.work(w);
      else if (w.state === 'back' && t && !t.moving) this.home(w);
    }
    for (const id of live) {
      if (this.of(id)) continue;
      if (this.wait(-id)) continue;
      this.later(-id);
      this.dispatch(id);
    }
    for (const id of [...this.problems.keys()]) if (!live.has(id) || this.of(id)) this.problems.delete(id);
  }

  /**
   * Новый поезд проекту id: вокзал из ближайших к его началу, откуда по готовым путям доехать до начала работ
   * (участок — ближайший к этому вокзалу). Нет вокзалов или ни с одного не доехать — проблема проекта.
   */
  private dispatch(id: number): void {
    const depots = this.host.depots();
    if (!depots.length) {
      this.problems.set(id, 'depot');
      return;
    }
    const pieces = this.host.pieces(id);
    if (!pieces.length) return;
    const ref = this.host.net.node(pieces[0].a).pos;
    const near = [...depots].sort((p, q) => dist(p.pos, ref) - dist(q.pos, ref) || p.id - q.id).slice(0, DEPOTS);
    for (const d of near) {
      const goal = this.target(id, d.platforms, d.pos);
      if (!goal) continue;
      this.problems.delete(id);
      const w: WorkTrain = { id: this.nextId++, project: id, depot: d.id, state: 'going', front: goal.front };
      this.claim(goal.front, id);
      this.list.set(w.id, w);
      this.launch(w);
      return;
    }
    this.problems.set(id, 'route');
  }

  /**
   * Куда поезду с участков from (платформы вокзала или путь, где он стоит) ехать на проекте id: участок, у начала
   * которого есть подход (готовый путь в узле, куда можно доехать), — ближайший по пути. Нет — null.
   */
  private target(id: number, from: number[], at: Vec): { front: { corridor: number; fromB: boolean }; approach: number[] } | null {
    const net = this.host.net;
    let best: { front: { corridor: number; fromB: boolean }; approach: number[]; d: number } | null = null;
    const pieces = this.host.pieces(id);
    // Сначала — ближние к поезду концы участков (по прямой): путь ищем, только если он может быть короче лучшего.
    const ends: { c: Segment; fromB: boolean; d: number }[] = [];
    for (const c of pieces) {
      const sides = (c.build?.done ?? 0) > 0 ? [!!c.build!.fromB] : [false, true];
      for (const fromB of sides) ends.push({ c, fromB, d: dist(at, net.node(fromB ? c.b : c.a).pos) });
    }
    ends.sort((p, q) => p.d - q.d || p.c.id - q.c.id || Number(p.fromB) - Number(q.fromB));
    for (const e of ends) {
      if (best && e.d >= best.d) break;
      const approach = this.approach(e.fromB ? e.c.b : e.c.a);
      if (!approach.length) continue;
      const route = this.host.rail.previewRoute(from, approach);
      // Уже стоит на подходе — ехать никуда не нужно.
      const here = approach.some((s) => from.includes(s));
      if (!route && !here) continue;
      const d = here ? 0 : polyLen(route!);
      if (!best || d < best.d - 1e-6) best = { front: { corridor: e.c.id, fromB: e.fromB }, approach, d };
    }
    return best && { front: best.front, approach: best.approach };
  }

  /** Подход к узлу n: готовые пути в нём (поезд встанет на одном из них головой к узлу), где он поместится. */
  private approach(n: number): number[] {
    const net = this.host.net;
    const node = net.nodes.get(n);
    if (!node) return [];
    const need = WORK_TRAIN.cars * WORK_TRAIN.carLength + 6;
    return node.segments.filter((sid) => {
      const s = net.segments.get(sid);
      return !!s && !s.build && net.isRailSeg(sid) && s.length >= need;
    });
  }

  /** Участок — поезду: не начатый заполняется от того конца, к которому он едет. */
  private claim(front: { corridor: number; fromB: boolean }, project: number): void {
    const c = this.host.net.segments.get(front.corridor);
    if (!c?.build || c.build.done > 0 || !!c.build.fromB === front.fromB) return;
    c.build = front.fromB ? { project, done: 0, fromB: true } : { project, done: 0 };
  }

  /** Поезд — в путь: с платформы депо (ещё не вышел) или с места, где стоит, к подходу своего участка. */
  private launch(w: WorkTrain): void {
    if (this.wait(w.id)) return;
    const rail = this.host.rail;
    const front = w.front && this.host.net.segments.get(w.front.corridor);
    if (!front?.build) {
      w.state = 'working';
      delete w.front;
      return;
    }
    let t = this.sim(w);
    if (!t) {
      const depot = this.host.depots().find((d) => d.id === w.depot);
      if (!depot) return void this.list.delete(w.id);
      t = rail.create({ ...WORK_TRAIN, kind: 'freight' });
      t.load = WORK_TRAIN.load;
      t.fill = 1;
      if (!rail.park(t, depot.platforms)) {
        rail.remove(t);
        this.later(w.id);
        return;
      }
      w.train = t.id;
    }
    const start = w.front!.fromB ? front.b : front.a;
    const approach = this.approach(start);
    if (t.platform !== null && approach.includes(t.platform)) {
      w.state = 'working';
      return;
    }
    const res = rail.depart(t, approach);
    if (res === 'ok') {
      this.stopAtEnd(t, start);
      w.state = 'going';
    } else if (res === 'noroute') {
      // Пути больше нет — домой; проект подождёт нового поезда.
      this.home(w);
    } else this.later(w.id);
  }

  /** Едущий поезд встанет у самого узла node (головой к стройке), а не посреди последнего участка. */
  private stopAtEnd(t: Train, node: number): void {
    const last = t.path[t.path.length - 1];
    const seg = this.host.net.segments.get(last.seg);
    if (!seg) return;
    const end = last.dir === 0 ? seg.b : seg.a;
    if (end === node) t.stopAt = last.start + last.len - 3;
  }

  /**
   * На месте: участок кончился — перекатиться на него (hop), фронта нет — к следующему участку проекта по путям,
   * некуда — домой.
   */
  private work(w: WorkTrain): void {
    const t = this.sim(w);
    if (!t) {
      w.state = 'going';
      return;
    }
    if (t.moving) return;
    if (w.hop !== undefined) {
      const hop = w.hop;
      const seg = this.host.net.segments.get(hop);
      if (!seg || seg.build || t.platform === hop || this.wait(w.id)) {
        if (!seg || seg.build || t.platform === hop) delete w.hop;
        return;
      }
      const res = this.host.rail.depart(t, [hop]);
      if (res === 'ok') {
        const front = w.front && this.host.net.segments.get(w.front.corridor);
        if (front) this.stopAtEnd(t, w.front!.fromB ? front.b : front.a);
        delete w.hop;
      } else if (res === 'noroute') delete w.hop;
      else this.later(w.id);
      return;
    }
    if (w.front && this.host.net.segments.get(w.front.corridor)?.build) return;
    // Фронт кончился (встретил другой или проект достроен с этого конца) — к другому участку проекта.
    delete w.front;
    if (this.wait(w.id)) return;
    const goal = t.platform !== null ? this.target(w.project, [t.platform], this.headPos(t)) : null;
    if (!goal) return this.home(w);
    w.front = goal.front;
    this.claim(goal.front, w.project);
    w.state = 'going';
    this.launch(w);
  }

  /** Где голова поезда. */
  headPos(t: Train): Vec {
    return this.host.rail.pointAt(t, t.head)?.pos ?? { x: 0, y: 0 };
  }

  /** Домой: на платформу своего вокзала (там поезд исчезает); не доехать — исчезает сразу. */
  private home(w: WorkTrain): void {
    const t = this.sim(w);
    w.state = 'back';
    delete w.front;
    delete w.hop;
    if (!t) return void this.list.delete(w.id);
    if (t.moving || this.wait(w.id)) return;
    const depot = this.host.depots().find((d) => d.id === w.depot);
    if (!depot || (t.platform !== null && depot.platforms.includes(t.platform))) return this.drop(w);
    const res = this.host.rail.depart(t, depot.platforms);
    if (res === 'noroute') this.drop(w);
    else if (res === 'blocked') this.later(w.id);
  }

  /** Поезд симуляции доехал (Game.onTrainArrive): к стройке — за работу, домой — исчезает. true — это строительный. */
  arrive(train: Train): boolean {
    const w = this.ofTrain(train.id);
    if (!w) return false;
    if (w.state === 'going') w.state = 'working';
    else if (w.state === 'back') {
      const depot = this.host.depots().find((d) => d.id === w.depot);
      if (!depot || (train.platform !== null && depot.platforms.includes(train.platform))) this.drop(w);
    }
    return true;
  }

  /** Путь под поездом разобран (Game.onTrainLost): поезда больше нет — проекту выйдет новый. true — строительный. */
  lost(train: Train): boolean {
    const w = this.ofTrain(train.id);
    if (!w) return false;
    this.drop(w);
    return true;
  }

  /**
   * Участок c проекта готов (Construction.advance): поезд перекатится на него; next — следующий участок фронта
   * (продолжает этот) или null — фронт кончился.
   */
  completed(project: number, c: Segment, next: { c: { id: number }; fromB: boolean } | null): void {
    const w = this.of(project);
    if (!w || w.front?.corridor !== c.id) return;
    w.hop = c.id;
    if (next) w.front = { corridor: next.c.id, fromB: next.fromB };
    else delete w.front;
  }

  /**
   * Края этапов на участке, который строит поезд проекта (для отрисовки): участок, этапы, с какого конца, край работ и
   * готовый путь позади начала участка (back — по нему тянется хвост состава; нет — состав только на участке). null —
   * не строит.
   */
  site(project: number): { seg: number; spans: [number, number, number]; fromB: boolean; front: number; back: number | null } | null {
    const w = this.of(project);
    if (!w || w.state !== 'working' || !w.front) return null;
    const c = this.host.net.segments.get(w.front.corridor);
    if (!c?.build) return null;
    const spans = spansOf(c.build, c.length);
    const start = c.build.fromB ? c.b : c.a;
    const t = this.sim(w);
    const stand = t?.platform != null ? this.host.net.segments.get(t.platform) : undefined;
    const back = stand && (stand.a === start || stand.b === start) ? stand.id : (this.approach(start)[0] ?? null);
    return { seg: c.id, spans, fromB: !!c.build.fromB, front: frontOf(spans, c.length).s, back };
  }

  /**
   * Поезд симуляции рисует стройка сама (у края работ, drawWorkTrain), а не отрисовка поездов: строительный поезд на
   * месте работ — его состав тянется за путеукладчиком по уже уложенному пути.
   */
  drawnBySite(train: number): boolean {
    const w = this.ofTrain(train);
    return !!w && w.state === 'working' && !!w.front && !!this.host.net.segments.get(w.front.corridor)?.build;
  }

  // ---------- Строительный поезд как выбор на карте (карточка — src/ui/workTrainCard.ts) ----------

  /** Что поезд делает сейчас: ждёт выезда (ещё не на путях), едет к стройке, строит, едет домой. */
  doing(w: WorkTrain): WorkTrainDoing {
    if (w.state === 'back') return 'back';
    if (w.state === 'working') return 'working';
    return w.train === undefined ? 'wait' : 'going';
  }

  /**
   * Состав на карте — точки от головы к хвосту через STEP м: на месте работ — техника у краёв этапов и вагоны за
   * путеукладчиком (как рисует стройка, drawTrackMachines), в пути — вагоны поезда симуляции. Не на путях — null.
   */
  body(w: WorkTrain): Vec[] | null {
    const site = w.train !== undefined && this.drawnBySite(w.train) ? this.site(w.project) : null;
    const seg = site && this.host.net.segments.get(site.seg);
    if (site && seg) {
      const back = site.back !== null ? (this.host.net.segments.get(site.back) ?? null) : null;
      const L = seg.length;
      const nose = Math.max(0, Math.min(L, site.spans[0]));
      const tail = Math.max(0, Math.min(L, site.spans[2])) - CRANE - WORK_TRAIN.cars * WORK_TRAIN.carLength;
      const out: Vec[] = [];
      for (let u = nose; u > tail; u -= STEP) out.push(sitePoint(seg, site.fromB, back, u).p);
      out.push(sitePoint(seg, site.fromB, back, tail).p);
      return out;
    }
    const t = this.sim(w);
    if (!t) return null;
    const out: Vec[] = [];
    for (let s = t.head; s > t.head - t.length; s -= STEP) {
      const p = this.host.rail.pointAt(t, s);
      if (p) out.push(p.pos);
    }
    return out.length ? out : null;
  }

  /** Где поезд — для камеры и «◎ Следовать»: голова состава (на месте работ — у края работ), не вышел — его вокзал. */
  where(w: WorkTrain): Vec | null {
    const body = this.body(w);
    if (body) return body[0];
    return this.host.depots().find((d) => d.id === w.depot)?.pos ?? null;
  }

  /**
   * Маршрут едущего поезда по путям (Train.path) — от головы до места остановки: точки через STEP м и сколько ещё
   * метров. Стоит или строит у края работ — null.
   */
  route(w: WorkTrain): { pts: Vec[]; left: number } | null {
    const t = this.sim(w);
    if (!t || !t.moving || this.drawnBySite(t.id)) return null;
    const left = t.stopAt - t.head;
    if (!(left > 1)) return null;
    const pts: Vec[] = [];
    for (const e of t.path) {
      const s0 = Math.max(e.start, t.head);
      const s1 = Math.min(e.start + e.len, t.stopAt);
      if (s1 <= s0) continue;
      const seg = this.host.net.segments.get(e.seg);
      if (!seg) continue;
      const at = (s: number) => seg.lut.pointAt(e.dir === 0 ? s - e.start : seg.length - (s - e.start));
      for (let s = s0; s < s1; s += STEP) pts.push(at(s));
      pts.push(at(s1));
    }
    return pts.length > 1 ? { pts, left } : null;
  }

  /** Сколько маршрута уже проехано (0…1) — для полоски «откуда → куда» в карточке; не едет — null. */
  progress(w: WorkTrain): number | null {
    const t = this.sim(w);
    if (!t || !t.moving || !(t.stopAt > 0)) return null;
    return Math.max(0, Math.min(1, t.head / t.stopAt));
  }

  /**
   * Куда поезд едет: к стройке — край работ на его участке (не начат — узел, откуда начнёт), домой — вокзал-депо
   * (depot). Некуда — null.
   */
  goal(w: WorkTrain): { pos: Vec; depot: boolean } | null {
    if (w.state === 'back') {
      const d = this.host.depots().find((x) => x.id === w.depot);
      return d ? { pos: d.pos, depot: true } : null;
    }
    const c = w.front && this.host.net.segments.get(w.front.corridor);
    if (!c?.build) return null;
    const x = frontOf(spansOf(c.build, c.length), c.length).s;
    return { pos: sitePoint(c, !!c.build.fromB, null, x).p, depot: false };
  }

  /** Строительный поезд под точкой p (по составу на карте — body); нет — undefined. */
  at(p: Vec, r = 5): number | undefined {
    for (const w of this.list.values()) {
      const body = this.body(w);
      if (body?.some((q) => dist(q, p) <= r)) return w.id;
    }
    return undefined;
  }

  /** Поезд симуляции строительного поезда (едет или стоит на путях); не вышел — undefined. */
  simOf(w: WorkTrain): Train | undefined {
    return this.sim(w);
  }

  toSave(): WorkTrainSave | undefined {
    if (!this.list.size && this.nextId === 1) return undefined;
    return { trains: [...this.list.values()].map((w) => ({ ...w, ...(w.front ? { front: { ...w.front } } : {}) })), nextId: this.nextId };
  }

  load(save: WorkTrainSave | undefined): void {
    this.list.clear();
    this.problems.clear();
    this.retry.clear();
    this.nextId = save?.nextId ?? 1;
    for (const w of save?.trains ?? []) {
      if (typeof w?.id !== 'number' || typeof w.project !== 'number') continue;
      this.list.set(w.id, { ...w, ...(w.front ? { front: { corridor: w.front.corridor, fromB: !!w.front.fromB } } : {}) });
    }
  }
}

function polyLen(p: readonly Vec[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += dist(p[i - 1], p[i]);
  return s;
}
