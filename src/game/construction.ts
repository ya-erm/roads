/**
 * Стройка дорог в режиме «Со строительством» (WorldSettings.construction = 'build'): нарисованная дорога —
 * проект (её полотна в сети помечены Corridor.build), он строится сам, участок за участком от узла до узла.
 *
 * - Темп — CONSTRUCTION в config.ts: 1 км улицы — 30 с на ×1, класс, полосы и сооружения — дольше (constructionWork.ts).
 * - Деньги — за каждый готовый метр: за такт платится разница «заплачено за готовое» (paidFor) — целыми долларами.
 *   Не хватает (бюджет — до кредитного предела, как у любой стройки) — проект стоит, пока деньги не появятся.
 * - Готовый участок сразу открыт: у полотна снимается build, ревизия новая — граф движения и карта его берут
 *   (src/lanes/open.ts — сеть без строящегося).
 * - Участок — сначала тот, что уже начат, потом примыкающий к готовым дорогам (от него и заполняется), иначе —
 *   первый по номеру. Участок проходят трижды: земляные работы, покрытие, разметка (CONSTRUCTION.stages).
 * - Строят бригады (crews.ts): проект идёт, пока на нём работает хоть одна; темп — сумма вкладов бригад (дальше от
 *   базы — медленнее). Проекты строятся одновременно, если бригад хватает.
 * - Пауза — проект стоит; отмена (Game.cancelProject) сносит недостроенное и возвращает заплаченное за него,
 *   готовые участки остаются.
 * - Резерв (Project.reserve): деньги на счёте, отложенные на проект, — в бюджет прочих трат не входят (Game.budget),
 *   проект платит за метры сперва из них, поэтому без денег не встаёт; кредитный предел резерв не обходит.
 *   Проект кончился или отменён — запись уходит вместе с остатком резерва, он снова свободен.
 * - Приоритет (Project.priority): бригады — сначала к нему, не хватает — переходят с обычных проектов (crews.ts).
 *
 * Состояние: готовое — в полотнах сети (сохраняется вместе с ней), записи проектов — здесь (toSave / load).
 */
import type { Vec } from '../core/vec';
import type { Corridor, LaneNet } from '../lanes/model';
import { CONSTRUCTION } from '../config';
import { ROAD_CLASSES } from '../world/roadTypes';
import { buildRate, frontOf, paidFor, stageSpans } from './constructionWork';
import { type Brigade, type CrewSave, Crews, type Site } from './crews';
import { corridorProfile, fullCorridorCost } from './roadbuild';

export interface Project {
  id: number;
  /** Что строим — одной строкой для плашки: «Улица 1+1», «Магистраль 2+2 · мост». */
  label: string;
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
}

export interface ConstructionSave {
  nextId: number;
  projects: Project[];
  /** Базы и бригады (нет в партиях без них). */
  crews?: CrewSave;
}

/** Что стройка знает об игре. */
export interface ConstructionHost {
  readonly roads: { readonly net: LaneNet };
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
  drive(brigade: Brigade, from: number, to: number): number | 'busy' | null;
  park(sim: number): void;
  onRoad(node: number): boolean;
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

export class Construction {
  readonly projects = new Map<number, Project>();
  nextId = 1;
  /** Растёт при любом изменении стройки (такт, пауза): подпись кадра и плашек. */
  stamp = 0;
  private index: Index | null = null;
  /** Цена и темп полотна по ревизии: ревизия меняется с формой, полосами и классом. */
  private readonly prices = new Map<string, { full: number; rate: number }>();
  /** Из чего полотно (мост, тоннель, насыпь) по ревизии — для карточки проекта. */
  private readonly partsCache = new Map<string, ProjectParts>();
  /** Базы и бригады: проект строится, пока на нём работает бригада. */
  readonly crews: Crews;

  constructor(private readonly host: ConstructionHost) {
    const self = this;
    this.crews = new Crews({
      get time() {
        return host.time;
      },
      crewProjects: () => [...this.projects.values()].filter((p) => !p.paused && this.corridorsOf(p.id).length).map((p) => p.id),
      priority: (id) => !!this.projects.get(id)?.priority,
      site: (id) => self.site(id),
      drive: (b, from, to) => host.drive(b, from, to),
      park: (sim) => host.park(sim),
      onRoad: (node) => host.onRoad(node),
    });
  }

  /** Край работ проекта на участке c: точка и узел дороги, откуда участок заполняется. */
  private frontOn(c: Corridor): { pos: Vec; node: number } {
    const b = c.build!;
    const f = frontOf(b.done, c.length).s;
    return { pos: c.lut.pointAt(b.fromB ? c.length - f : f), node: b.fromB ? c.b : c.a };
  }

  /** Куда ехать бригаде к проекту: узел у края работ (если до него есть дорога) и сама точка. */
  site(id: number): Site | null {
    const c = this.current(id);
    if (!c) return null;
    const f = this.frontOn(c);
    return { node: this.host.onRoad(f.node) ? f.node : null, pos: f.pos };
  }

  /** Номер следующего проекта (план помечает им новые полотна, startProject заводит запись). */
  peekId(): number {
    return this.nextId;
  }

  /** Проект заложен: полотна уже помечены в сети net. */
  start(id: number, net: LaneNet, corridors: number[]): Project {
    this.nextId = Math.max(this.nextId, id + 1);
    const cs = corridors.map((c) => net.corridors.get(c)).filter((c): c is Corridor => !!c);
    const p: Project = { id, label: projectLabel(net, cs), builtLen: 0, spent: 0, created: this.host.time };
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

  private price(net: LaneNet, c: Corridor): { full: number; rate: number } {
    const key = `${c.id}:${c.rev}`;
    let hit = this.prices.get(key);
    if (!hit) {
      if (this.prices.size > 4000) this.prices.clear();
      const water = (p: Vec, m?: number) => this.host.isWater(p, m);
      hit = { full: fullCorridorCost(net, c, water, this.host.ground()), rate: buildRate(net, c, water) };
      this.prices.set(key, hit);
    }
    return hit;
  }

  /**
   * Участок, который строится сейчас: начатый, иначе примыкающий к готовым дорогам (отсчёт — от готового конца),
   * иначе первый. Выбранному с нуля ставится, с какого конца он заполняется.
   */
  current(id: number): Corridor | null {
    const list = this.corridorsOf(id);
    if (!list.length) return null;
    const started = list.find((c) => c.build!.done > 0);
    if (started) return started;
    const net = this.host.roads.net;
    const open = (node: number) => net.node(node).corridors.some((k) => !net.corridors.get(k)?.build);
    for (const c of list) {
      const a = open(c.a);
      const b = open(c.b);
      if (!a && !b) continue;
      const fromB = !a && b;
      if (!!c.build!.fromB !== fromB) c.build = fromB ? { project: id, done: 0, fromB: true } : { project: id, done: 0 };
      return c;
    }
    const c = list[0];
    if (c.build!.fromB) c.build = { project: id, done: 0 };
    return c;
  }

  /** Такт стройки: каждый проект (по порядку закладки) — вперёд на dt секунд работы. */
  tick(dt: number): void {
    // Бригады решают, куда ехать (и возвращаются на базы, когда проектов нет).
    this.crews.tick();
    if (!this.projects.size) return;
    let opened = false;
    for (const p of [...this.projects.values()]) {
      // Недостроенное снесли (бульдозер, рамка) — проекта больше нет; достроенным он не считается.
      if (!this.corridorsOf(p.id).length) {
        this.projects.delete(p.id);
        continue;
      }
      if (p.paused || !this.advance(p, dt)) continue;
      opened = true;
      if (!this.corridorsOf(p.id).length) {
        this.projects.delete(p.id);
        this.host.projectEvent?.('done', p);
      }
    }
    this.stamp++;
    if (opened) this.host.networkChanged();
  }

  /** Проект вперёд на dt секунд: метры, деньги за них, готовые участки открываются. true — открыт участок. */
  private advance(p: Project, dt: number): boolean {
    const net = this.host.roads.net;
    let left = dt;
    let opened = false;
    // Участок кончился посреди такта — остаток времени идёт на следующий (не больше нескольких за такт).
    for (let guard = 0; left > 1e-9 && guard < 8; guard++) {
      const c = this.current(p.id);
      if (!c) break;
      const b = c.build!;
      // Темп — по бригадам на месте: никого нет — стройка ждёт.
      const crew = this.crews.rate(p.id, this.frontOn(c).pos);
      if (crew <= 0) break;
      const { full } = this.price(net, c);
      const rate = this.price(net, c).rate * crew;
      const step = Math.min(Math.max(0, c.length - b.done), left * rate);
      const done = b.done + step;
      const cost = paidFor(full, done, c.length) - paidFor(full, b.done, c.length);
      // Сперва — из резерва проекта, остальное — из свободного бюджета (до кредитного предела: резерв его не обходит).
      const fromReserve = Math.min(cost, p.reserve ?? 0);
      const free = this.host.budget;
      if (cost > 0 && (cost - fromReserve > Math.max(0, free) || cost > free + this.reserved())) {
        if (p.stalled === undefined) {
          p.stalled = this.host.time;
          this.host.projectEvent?.('stalled', p);
        }
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
      left -= step / rate;
      if (done >= c.length - 1e-6) {
        delete c.build;
        net.touch(c);
        p.builtLen += c.length;
        opened = true;
      } else c.build = { ...b, done };
    }
    // Бригады на месте — у нового края работ.
    const cur = this.current(p.id);
    if (cur) {
      const f = this.frontOn(cur);
      this.crews.follow(p.id, f.pos, this.host.onRoad(f.node) ? f.node : null);
    }
    return opened;
  }

  /** Сводка проекта; нет такого — null. */
  info(id: number): ProjectInfo | null {
    const p = this.projects.get(id);
    if (!p) return null;
    const net = this.host.roads.net;
    const list = this.corridorsOf(id);
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
    const crew = this.crews.rate(id, at);
    const k = crew > 0 ? crew : this.crews.nearestPower(at);
    // Ещё одна бригада — с ближайшей базы, своей долей (CONSTRUCTION.crewShare): вторая и третья прибавляют меньше.
    const n = Math.max(1, this.crews.working(id).length);
    const share = CONSTRUCTION.crewShare;
    const plus = n < CONSTRUCTION.brigade.perProject ? k + this.crews.nearestPower(at) * (share[n] ?? share[share.length - 1]) : null;
    const stages: [number, number, number] = [p.builtLen, p.builtLen, p.builtLen];
    for (const c of list) {
      const b = c.build!;
      const { full, rate } = this.price(net, c);
      const sp = stageSpans(b.done, c.length);
      for (let i = 0; i < 3; i++) stages[i] += sp[i];
      length += c.length;
      ready += b.done;
      seconds += (c.length - b.done) / (rate * k);
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
    };
  }

  /** Из чего недостроенное: метров на земле, по мостам, в тоннелях, над водой; самая высокая насыпь и глубокая выемка. */
  parts(id: number): ProjectParts {
    const net = this.host.roads.net;
    const out: ProjectParts = { ground: 0, bridge: 0, tunnel: 0, water: 0, fill: 0, cut: 0 };
    for (const c of this.corridorsOf(id)) {
      const key = `${c.id}:${c.rev}`;
      let hit = this.partsCache.get(key);
      if (!hit) {
        if (this.partsCache.size > 2000) this.partsCache.clear();
        hit = { ground: 0, bridge: 0, tunnel: 0, water: 0, fill: 0, cut: 0 };
        const n = Math.max(2, Math.ceil(c.length / 24));
        for (let i = 0; i < n; i++) {
          const s = (c.length * (i + 0.5)) / n;
          const h = net.heightAt(c, s);
          const len = c.length / n;
          if (h < -0.25) hit.tunnel += len;
          else if (h > 0.25) {
            if (this.host.isWater(c.lut.pointAt(s), 2)) hit.water += len;
            else hit.bridge += len;
          } else hit.ground += len;
        }
        const prof = corridorProfile(net, c, this.host.ground());
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

  /** Записи без полотен (отмена стройки, Ctrl+Z) — убрать. */
  prune(): void {
    for (const id of [...this.projects.keys()]) if (!this.corridorsOf(id).length) this.projects.delete(id);
    this.stamp++;
  }

  /** Записи проектов — копией (для отмены). */
  snapshot(): Project[] {
    return [...this.projects.values()].map((p) => ({ ...p }));
  }

  /** После отмены: проекты из снимка, которых больше нет (отменённые, достроенные), — снова; лишние — прочь. */
  restore(list: Project[]): void {
    for (const p of list) if (!this.projects.has(p.id)) this.projects.set(p.id, { ...p });
    // Порядок — по номеру: тот же, что у закладки.
    const sorted = [...this.projects.values()].sort((a, b) => a.id - b.id);
    this.projects.clear();
    for (const p of sorted) this.projects.set(p.id, p);
    this.prune();
  }

  toSave(): ConstructionSave | undefined {
    const crews = this.crews.toSave();
    if (!this.projects.size && this.nextId === 1 && !crews) return undefined;
    return { nextId: this.nextId, projects: [...this.projects.values()].map((p) => ({ ...p })), ...(crews ? { crews } : {}) };
  }

  load(save: ConstructionSave | undefined): void {
    this.projects.clear();
    this.crews.load(save?.crews);
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
      this.projects.set(id, { id, label: projectLabel(net, cs), builtLen: 0, spent: 0, created: this.host.time });
      this.nextId = Math.max(this.nextId, id + 1);
    }
    this.prune();
  }
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
