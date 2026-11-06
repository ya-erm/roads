import { Cubic, CurveLUT } from '../core/bezier';
import { dist, dot, scale, sub, Vec } from '../core/vec';
import type { DrawMode, NetKind } from '../game/build';
import type { Game } from '../game/game';
import {
  addNode,
  addSeg,
  alignHandle,
  bendSeg,
  buildProject,
  continuation,
  copyProject,
  draftCurve,
  emptyProject,
  End,
  handleAt,
  handleOf,
  jointKind,
  segOf,
  mergeNode,
  moveHandle,
  moveNode,
  nodeAt,
  nodeOf,
  Project,
  projectCurveSigns,
  ProjectPlan,
  projectPlan,
  removeNode,
  roadProjectEdit,
  segAt,
  segCurve,
  segsAt,
  smoothJoint,
  splitSeg,
} from '../game/roadProject';
import { MoveProject } from '../game/moveProject';
import type { NetEdit } from '../game/roadbuild';
import { anchorAt } from '../lanes/edit';
import type { LaneNet } from '../lanes/model';
import { halfWidth, type RoadSpec } from '../world/roadTypes';

/** Что тянут в проекте: узел, перо или середину участка. */
export type ProjectDrag = { kind: 'node'; id: number } | { kind: 'handle'; seg: number; end: End } | { kind: 'bend'; seg: number };

/** Настройки стройки в момент клика: что, какой формы и на какой высоте рисуем. */
export interface DrawSettings {
  kind: NetKind;
  spec: RoadSpec;
  mode: DrawMode;
  level: number;
  /** «Авто» у дороги: мост или тоннель сам. */
  auto: boolean;
  /** Односторонняя — навстречу ходу. */
  reverse: boolean;
}

/** Куда встанет новый узел проекта: точка, высота, примкнёт ли к построенному и куда из него «прямо». */
interface SnapPoint {
  pos: Vec;
  level: number;
  attach: boolean;
  /** Направление продолжения из этой точки к toward (тупик, путь под стрелку); null — нет. */
  dir: (toward: Vec) => Vec | null;
  /** Узел проекта, если точка на нём. */
  node?: number;
}

/** Что показать на карте: участки (с причиной и тем, что строится), узлы, перья, подпись. */
export interface ProjectView {
  plan: ProjectPlan;
  segs: { curve: Cubic; half: number; ok: boolean; fill: boolean; draft?: boolean }[];
  nodes: { pos: Vec; tip: boolean; hot: boolean }[];
  handles: { anchor: Vec; pos: Vec; active: boolean; partner: boolean }[];
  /** Новый участок до курсора: сколько добавит к цене (null — не рисуем). */
  draft: { cost: number; length: number } | null;
  /** Знаки скорости перед поворотами, что её снижают: на оси, по ходу, до кромки, км/ч. */
  signs: { pos: Vec; dir: Vec; side: number; kmh: number }[];
  /** Самый медленный поворот проекта, км/ч (null — поворотов, что снижают скорость, нет). */
  slowest: number | null;
}

/** Ид объекта для ключа кэша: сеть после стройки — новый объект. */
const ids = new WeakMap<object, number>();
let nextId = 1;
const idOf = (o: object): number => {
  let id = ids.get(o);
  if (id === undefined) ids.set(o, (id = nextId++));
  return id;
};

/**
 * Режим «Проект» инструментов «Дорога» и «Ж/д»: клики рисуют проект (ничего не строится и не стоит денег),
 * узлы, перья и середины участков тянутся мышью, «Построить» прокладывает весь проект разом.
 */
export class ProjectTools {
  /** Проекты дорог и путей: у каждого инструмента свой, переживают смену инструмента. */
  projects: Record<NetKind, Project> = { road: emptyProject(), rail: emptyProject() };
  /** Режим проекта включён в инструменте. */
  on: Record<NetKind, boolean> = { road: false, rail: false };
  /** Узел, от которого следующий клик ведёт участок; null — клик начинает новую ветку. */
  tip: number | null = null;
  /** Точка изгиба для формы «Кривая». */
  control: Vec | null = null;
  /** Что тянут сейчас. */
  drag: ProjectDrag | null = null;
  /** Подпись у курсора при протяжке («излом», «примкнёт»). */
  hint: string | null = null;
  /** Проект до протяжки: тянут от него, Esc — назад к нему. */
  private before: Project | null = null;
  /** Что было под курсором при нажатии (клик без протяжки). */
  private press: { kind: 'node'; id: number } | { kind: 'seg'; seg: number; t: number } | { kind: 'handle' } | { kind: 'empty' } | null = null;
  /** Шаги правки проекта для Ctrl+Z: проект и правки построенных дорог, какими они были до шага. */
  private history: Record<NetKind, { p: Project; edits: NetEdit[] }[]> = { road: [], rail: [] };
  private cache = new Map<string, ProjectPlan>();

  /**
   * roadEdits — правки построенных дорог (перенос узла, перо, изгиб — как в «Двигать»): часть того же проекта дорог,
   * строятся вместе с его участками.
   */
  constructor(
    private readonly game: () => Game,
    private readonly roadEdits: (() => MoveProject) | null = null,
  ) {}

  project(kind: NetKind): Project {
    return this.projects[kind];
  }

  /** Правки построенных дорог в проекте (у путей их нет). */
  edits(kind: NetKind): NetEdit[] {
    return kind === 'road' && this.roadEdits ? this.roadEdits().edits : [];
  }

  /** Среди правок проекта дорог — расширение дороги («Полоса»): дома отодвигаются, а не сносятся. */
  private shoves(kind: NetKind): boolean {
    return kind === 'road' && !!this.roadEdits && this.roadEdits().shove;
  }

  /** Построенные дороги с правками проекта: к ним примыкают новые участки (нет правок — настоящая сеть). */
  private roadNet(): LaneNet {
    return (this.roadEdits && this.roadEdits().net()) ?? this.game().roads.net;
  }

  canUndo(kind: NetKind): boolean {
    return this.history[kind].length > 0;
  }

  /** Правка построенной дороги — в проект дорог (Ctrl+Z в проекте её уберёт). Ответ — что не так. */
  addEdit(edit: NetEdit, shove = false): string | null {
    if (!this.roadEdits) return 'Так не передвинуть';
    const was = copyProject(this.projects.road);
    const before = [...this.roadEdits().edits];
    const problem = this.roadEdits().add(edit, shove);
    if (!problem) this.remember('road', was, before);
    return problem;
  }

  /** Нажатие ушло не в проект (тянули построенную дорогу) — забыть его. */
  cancelPress(): void {
    this.press = null;
    this.before = null;
    this.drag = null;
    this.hint = null;
  }

  /** Нажали мимо проекта (ни узла, ни пера, ни участка). */
  get pressedEmpty(): boolean {
    return this.press?.kind === 'empty';
  }

  /** Где узел, от которого ведём (null — не ведём). */
  tipPos(kind: NetKind): { pos: Vec; level: number } | null {
    const n = this.tip === null ? undefined : this.projects[kind].nodes.find((x) => x.id === this.tip);
    return n ? { pos: { ...n.pos }, level: n.level } : null;
  }

  /**
   * Включили «Проект» посреди обычной стройки: её начало (pos — узел, дорога или поле, attach) становится узлом
   * проекта, от которого ведём, точка изгиба кривой — та же; дальше протяжка — уже участок проекта.
   */
  adopt(kind: NetKind, pos: Vec, level: number, attach: boolean, control: Vec | null): void {
    const p = this.projects[kind];
    const own = nodeAt(p, pos, 0.5);
    const n = own ?? addNode(p, pos, level, attach);
    this.tip = n.id;
    this.control = control ? { ...control } : null;
  }

  /** Сменили инструмент, режим или партию: что тянули и откуда вели — забываем, проект остаётся. */
  stop(kind: NetKind): void {
    if (this.drag && this.before) this.projects[kind] = this.before;
    this.drag = null;
    this.before = null;
    this.press = null;
    this.control = null;
    this.hint = null;
    this.setTip(kind, null);
  }

  /** Новая партия: проекты — с чистого листа. */
  reset(): void {
    this.projects = { road: emptyProject(), rail: emptyProject() };
    this.history = { road: [], rail: [] };
    this.cache.clear();
    this.drag = null;
    this.before = null;
    this.press = null;
    this.tip = null;
    this.control = null;
  }

  private remember(kind: NetKind, was: Project, edits: NetEdit[] = [...this.edits(kind)]): void {
    const h = this.history[kind];
    h.push({ p: was, edits });
    if (h.length > 100) h.shift();
  }

  /** Ведём из другого узла: начатая ветка из одного узла без участков — не нужна. */
  private setTip(kind: NetKind, id: number | null): void {
    const p = this.projects[kind];
    const old = this.tip;
    this.tip = id;
    if (old !== null && old !== id && p.nodes.some((n) => n.id === old) && !segsAt(p, old).length) p.nodes = p.nodes.filter((n) => n.id !== old);
  }

  // ---------- Где встанет узел ----------

  /** Точка клика: узел проекта, узел или середина построенной дороги (пути), иначе чистое поле. */
  private snapAt(kind: NetKind, p: Vec, r: number, level: number, skip?: number): SnapPoint {
    const g = this.game();
    const own = nodeAt(this.projects[kind], p, r * 0.8, skip);
    if (own) return { pos: own.pos, level: own.level, attach: own.attach, dir: () => continuation(this.projects[kind], own.id), node: own.id };
    if (kind === 'road') {
      const net = this.roadNet();
      const a = anchorAt(net, p, r, level);
      if (a.kind === 'node') {
        const n = net.node(a.node);
        const ends = net.ends(n);
        return { pos: n.pos, level: n.level, attach: true, dir: () => (ends.length === 1 ? scale(ends[0].away, -1) : null) };
      }
      if (a.kind === 'corridor') {
        const c = net.corridor(a.corridor);
        return { pos: a.pos, level: Math.round(net.heightAt(c, a.s)), attach: true, dir: () => null };
      }
      return { pos: a.pos, level, attach: false, dir: () => null };
    }
    const s = g.builder.snap(p, level, r);
    if (s.kind === 'node') return { pos: s.pos, level: s.level, attach: true, dir: () => g.builder.continuationTangent(s) };
    if (s.kind === 'split') {
      // С середины пути — только стрелкой: дуга уходит по касательной пути в сторону цели.
      const seg = g.net.segment(s.segId);
      const t = seg.lut.tangentAt(seg.lut.sAtT(s.t));
      return { pos: s.pos, level: s.level, attach: true, dir: (to) => (dot(t, sub(to, s.pos)) >= 0 ? t : scale(t, -1)) };
    }
    return { pos: s.pos, level, attach: false, dir: () => null };
  }

  /** Направление «прямо» из узла проекта к точке to: продолжение его участка или того, к чему он примкнул. */
  private dirFrom(kind: NetKind, pr: Project, id: number, to: Vec, r: number): Vec | null {
    const own = continuation(pr, id);
    if (own || segsAt(pr, id).length) return own;
    const n = nodeOf(pr, id);
    return n.attach ? this.snapAt(kind, n.pos, Math.min(r, 3), n.level, id).dir(to) : null;
  }

  /** Куда участок от точки from должен прийти в узел id, чтобы гладко продолжиться тем, что из узла выходит. */
  private arriveAt(kind: NetKind, pr: Project, id: number, from: Vec, r: number): Vec | null {
    const out = this.dirFrom(kind, pr, id, from, r);
    return out ? scale(out, -1) : null;
  }

  /**
   * Участок от узла from до узла to: дуга и кривая гладко продолжают то, что приходит в from, и приходят в to
   * так, чтобы гладко продолжиться тем, что из to выходит (участок проекта, тупик дороги, путь). kink (Shift) — излом.
   */
  private link(s: DrawSettings, pr: Project, from: number, to: number, r: number, kink: boolean): boolean {
    const a = nodeOf(pr, from).pos;
    const b = nodeOf(pr, to).pos;
    const dir = kink ? null : this.dirFrom(s.kind, pr, from, b, r);
    const arrive = kink ? null : this.arriveAt(s.kind, pr, to, a, r);
    const curve = draftCurve(a, b, s.mode, dir, this.control, arrive);
    return !!addSeg(pr, from, to, curve, s.spec, { auto: s.kind === 'road' && s.auto, reverse: s.reverse });
  }

  /** Новый участок от узла tip до точки: проект с ним (копия) и куда он пришёл. */
  private withDraft(s: DrawSettings, p: Vec, r: number, kink = false): { project: Project; node: number } | null {
    if (this.tip === null) return null;
    const pr = copyProject(this.projects[s.kind]);
    const from = nodeOf(pr, this.tip);
    const at = this.snapAt(s.kind, p, r, s.level, this.tip);
    if (dist(at.pos, from.pos) < 8) return null;
    const end = at.node !== undefined ? nodeOf(pr, at.node) : addNode(pr, at.pos, at.level, at.attach);
    if (segsAt(pr, from.id).some((x) => x.a === end.id || x.b === end.id)) return null;
    return this.link(s, pr, from.id, end.id, r, kink) ? { project: pr, node: end.id } : null;
  }

  /** Где встанет узел от клика в p: точка, примкнёт ли к построенному (для кружка у курсора). */
  pointAt(s: DrawSettings, p: Vec, r: number): { pos: Vec; attach: boolean; own: boolean } {
    const at = this.snapAt(s.kind, p, r, s.level, this.tip ?? undefined);
    return { pos: at.pos, attach: at.attach, own: at.node !== undefined };
  }

  // ---------- Мышь ----------

  /** Нажали: перо, узел или середина участка — тянуть; иначе — клик (решится при отпускании). hr — радиус пера. */
  down(kind: NetKind, p: Vec, r: number, hr: number): void {
    const pr = this.projects[kind];
    this.hint = null;
    const h = handleAt(pr, p, hr);
    const n = h ? null : nodeAt(pr, p, r * 0.8);
    const s = h || n ? null : segAt(pr, p, (x) => halfWidth(x.spec) + r * 0.3);
    this.before = copyProject(pr);
    if (h) {
      this.drag = { kind: 'handle', seg: h.seg, end: h.end };
      this.press = { kind: 'handle' };
    } else if (n) {
      this.drag = { kind: 'node', id: n.id };
      this.press = { kind: 'node', id: n.id };
    } else if (s) {
      this.drag = { kind: 'bend', seg: s.seg.id };
      this.press = { kind: 'seg', seg: s.seg.id, t: s.t };
    } else {
      this.drag = null;
      this.press = { kind: 'empty' };
    }
  }

  /** Тянут: правка — от проекта до нажатия, к точке курсора. kink — излом пера (Shift). */
  move(kind: NetKind, p: Vec, r: number, kink: boolean): void {
    const d = this.drag;
    if (!d || !this.before) return;
    const pr = copyProject(this.before);
    this.hint = null;
    if (d.kind === 'handle') {
      // Излом до протяжки — без Shift он снова гладкий.
      const was = segOf(this.before, d.seg);
      const joint = was ? jointKind(this.before, d.end === 'a' ? was.a : was.b) : null;
      moveHandle(pr, d.seg, d.end, p, kink);
      if (kink) this.hint = 'излом';
      else if (joint === 'kink') this.hint = 'гладко';
    } else if (d.kind === 'bend') bendSeg(pr, d.seg, p);
    else {
      const n = nodeOf(pr, d.id);
      const at = this.snapAt(kind, p, r, n.level, d.id);
      moveNode(pr, d.id, at.pos, at.attach);
      if (at.node !== undefined) this.hint = 'соединить';
      else if (at.attach) {
        this.hint = 'примкнёт';
        // Конец ветки у тупика дороги (пути) — перо по его продолжению: стык без излома (Shift — с изломом).
        const at1 = segsAt(pr, d.id);
        if (!kink && at1.length === 1) {
          const sg = at1[0];
          const end = sg.a === d.id ? 'a' : 'b';
          const out = at.dir(nodeOf(pr, end === 'a' ? sg.b : sg.a).pos);
          const h = handleOf(pr, sg, end);
          if (out && dot(out, sub(h.pos, h.anchor)) > 0) alignHandle(pr, sg.id, end, out);
        }
      }
    }
    this.projects[kind] = pr;
  }

  /** Отпустили: протяжка — правка готова; клик — следующий узел, ветка, узел на участке. */
  up(s: DrawSettings, p: Vec, r: number, moved: boolean, kink: boolean): void {
    const kind = s.kind;
    const was = this.before;
    const press = this.press;
    const drag = this.drag;
    this.drag = null;
    this.before = null;
    this.press = null;
    this.hint = null;
    if (!was || !press) return;
    if (drag && moved) {
      this.move(kind, p, r, kink);
      // Узел отпустили на другом узле проекта — они сливаются (замкнуть, соединить ветки).
      if (drag.kind === 'node') {
        const pr = this.projects[kind];
        const other = nodeAt(pr, nodeOf(pr, drag.id).pos, 0.5, drag.id);
        if (other) {
          const mine = segsAt(pr, drag.id).map((x) => x.id);
          mergeNode(pr, drag.id, other.id);
          // Два конца сошлись — стык гладкий: перо принесённого участка встаёт навстречу перу соседа (Shift — излом).
          if (!kink) mine.some((id) => smoothJoint(pr, other.id, id));
          if (this.tip === drag.id) this.tip = other.id;
        }
      }
      this.remember(kind, was);
      return;
    }
    // Клик: проект — как до нажатия.
    this.projects[kind] = was;
    const pr = copyProject(was);
    if (press.kind === 'handle') return;
    if (press.kind === 'node') {
      if (this.tip === press.id) this.setTip(kind, null);
      else if (this.tip === null) this.tip = press.id;
      else {
        // Ведём к существующему узлу проекта — соединяем: гладко с обеих сторон, если не Shift.
        const from = nodeOf(pr, this.tip);
        const to = nodeOf(pr, press.id);
        if (segsAt(pr, from.id).some((x) => x.a === to.id || x.b === to.id)) return;
        if (!this.link(s, pr, from.id, to.id, r, kink)) return;
        this.commit(kind, was, pr);
        this.control = null;
        this.setTip(kind, to.id);
      }
      return;
    }
    if (press.kind === 'seg') {
      // Клик по участку — новый узел на нём; если ведём — участок к нему (ответвление).
      const n = splitSeg(pr, press.seg, press.t);
      if (!n) return;
      if (this.tip !== null && this.tip !== n.id) {
        this.link(s, pr, this.tip, n.id, r, kink);
        this.commit(kind, was, pr);
        this.control = null;
        this.setTip(kind, n.id);
      } else this.commit(kind, was, pr);
      return;
    }
    // Пустое место (или построенная дорога): «Кривая» — сначала точка изгиба, потом конец.
    if (this.tip !== null && s.mode === 'curve' && !this.control) {
      this.control = { ...p };
      return;
    }
    if (this.tip === null) {
      const at = this.snapAt(kind, p, r, s.level);
      const n = addNode(pr, at.pos, at.level, at.attach);
      this.projects[kind] = pr;
      this.tip = n.id;
      return;
    }
    const res = this.withDraft(s, p, r, kink);
    if (!res) return;
    this.commit(kind, was, res.project);
    this.control = null;
    this.setTip(kind, res.node);
  }

  private commit(kind: NetKind, was: Project, next: Project): void {
    this.remember(kind, was);
    this.projects[kind] = next;
  }

  /** Esc: бросить протяжку, точку изгиба, закончить ветку. true — было что отменять. */
  cancel(kind: NetKind): boolean {
    if (this.drag) {
      if (this.before) this.projects[kind] = this.before;
      this.drag = null;
      this.before = null;
      this.press = null;
      this.hint = null;
      return true;
    }
    if (this.control) {
      this.control = null;
      return true;
    }
    if (this.tip !== null) {
      this.setTip(kind, null);
      return true;
    }
    return false;
  }

  /** Ctrl+Z в проекте: шаг правки назад. false — отменять нечего. */
  undo(kind: NetKind): boolean {
    const step = this.history[kind].pop();
    if (!step) return false;
    const was = step.p;
    this.projects[kind] = was;
    // Правки построенных дорог — какими были до шага.
    if (kind === 'road' && this.roadEdits) this.roadEdits().restore(step.edits);
    this.drag = null;
    this.before = null;
    this.control = null;
    if (this.tip !== null && !was.nodes.some((n) => n.id === this.tip)) this.tip = null;
    return true;
  }

  /** Delete у узла: убрать его с участками. true — убрали. */
  removeAt(kind: NetKind, p: Vec, r: number): boolean {
    const pr = this.projects[kind];
    const n = nodeAt(pr, p, r * 0.8);
    if (!n) return false;
    const next = copyProject(pr);
    removeNode(next, n.id);
    this.commit(kind, pr, next);
    if (this.tip !== null && !next.nodes.some((x) => x.id === this.tip)) this.tip = null;
    return true;
  }

  /** «Отменить проект»: всё нарисованное — прочь (Ctrl+Z вернёт). */
  discard(kind: NetKind): void {
    const pr = this.projects[kind];
    const edits = this.edits(kind);
    if (!pr.nodes.length && !edits.length) return;
    this.commit(kind, pr, emptyProject());
    // И правки построенных дорог — тоже (Ctrl+Z в проекте вернёт и их).
    if (kind === 'road' && this.roadEdits) this.roadEdits().clear();
    this.stop(kind);
  }

  /** Проект дорог построили (здесь или из «Двигать») — участков и шагов правки больше нет. */
  built(kind: NetKind): void {
    this.projects[kind] = emptyProject();
    this.history[kind] = [];
    this.cache.clear();
    this.stop(kind);
  }

  /**
   * «Построить»: весь проект теми же строителями — у дорог вместе с правками построенных дорог; построили —
   * проект пуст (Ctrl+Z отменит стройку целиком).
   */
  build(kind: NetKind): string | null {
    const g = this.game();
    const problem = buildProject(g, kind, this.projects[kind], this.edits(kind), this.shoves(kind));
    if (problem) return problem;
    if (kind === 'road' && this.roadEdits) this.roadEdits().clear();
    this.built(kind);
    return null;
  }

  // ---------- Что видно ----------

  /** Что под курсором: перо, узел (tip — тот, откуда ведём), участок или ничего. */
  /** Узел пера под курсором: гладкий, излом (без Shift станет гладким) или не стык двух участков. */
  handleJoint(kind: NetKind, p: Vec, hr: number): 'smooth' | 'kink' | null {
    const pr = this.projects[kind];
    const h = handleAt(pr, p, hr);
    const s = h && segOf(pr, h.seg);
    return s ? jointKind(pr, h!.end === 'a' ? s.a : s.b) : null;
  }

  targetAt(kind: NetKind, p: Vec, r: number, hr: number): 'handle' | 'node' | 'tip' | 'seg' | null {
    const pr = this.projects[kind];
    if (handleAt(pr, p, hr)) return 'handle';
    const n = nodeAt(pr, p, r * 0.8);
    if (n) return n.id === this.tip ? 'tip' : 'node';
    return segAt(pr, p, (x) => halfWidth(x.spec) + r * 0.3) ? 'seg' : null;
  }

  /**
   * План проекта (кэш по проекту, правкам построенных дорог, сетям и деньгам). extra — правка построенной дороги,
   * которую тянут сейчас (после остальных; без кэша).
   */
  plan(kind: NetKind, p: Project = this.projects[kind], extra: NetEdit | null = null): ProjectPlan {
    const g = this.game();
    const edits = this.edits(kind);
    const shove = this.shoves(kind);
    if (extra) return projectPlan(g, kind, p, [...edits, extra], shove);
    const stamp = kind === 'road' && this.roadEdits ? this.roadEdits().stamp : 0;
    const key = `${kind}|${idOf(g.roads.net)}.${g.roads.net.version}|${idOf(g.net)}.${g.net.version}|${Math.floor(g.budget)}|${stamp}|${JSON.stringify(p)}`;
    let plan = this.cache.get(key);
    if (!plan) {
      plan = projectPlan(g, kind, p, edits, shove);
      if (this.cache.size > 24) this.cache.clear();
      this.cache.set(key, plan);
    }
    return plan;
  }

  /** Проект на карте: с новым участком до курсора, если ведём ветку (и курсор не на чём тянуть). */
  view(s: DrawSettings, hover: Vec | null, r: number, hr: number, kink = false, extra: NetEdit | null = null): ProjectView {
    const kind = s.kind;
    const base = this.projects[kind];
    const draft = !this.drag && !extra && hover && !(s.mode === 'curve' && !this.control) && !handleAt(base, hover, hr) ? this.withDraft(s, hover, r, kink) : null;
    const pr = draft?.project ?? base;
    const plan = this.plan(kind, pr, extra);
    const draftSeg = draft ? pr.segs[pr.segs.length - 1].id : null;
    const badAt = plan.bad === null ? -1 : pr.segs.findIndex((x) => x.id === plan.bad);
    const segs = pr.segs.map((x, i) => {
      const fine = plan.bad !== x.id;
      // Что строится, видно как дорога (сеть плана) или путь (его план); остальное — заливкой.
      const shown = kind === 'rail' ? plan.rails.has(x.id) && fine : !!plan.road?.net && (badAt < 0 || i < badAt);
      return { curve: segCurve(pr, x), half: halfWidth(x.spec), ok: fine, fill: !shown, draft: x.id === draftSeg };
    });
    const hot = hover ? nodeAt(pr, hover, r * 0.8) : null;
    const nodes = pr.nodes.map((n) => ({ pos: n.pos, tip: n.id === this.tip, hot: n.id === hot?.id }));
    const active = this.drag?.kind === 'handle' ? this.drag : null;
    const handles = pr.segs
      .filter((x) => x.id !== draftSeg)
      .flatMap((x) =>
        (['a', 'b'] as const).map((end) => ({
          ...handleOf(pr, x, end),
          active: !!active && active.seg === x.id && active.end === end,
          partner: false,
        })),
      );
    let draftInfo: ProjectView['draft'] = null;
    if (draft) {
      const was = this.plan(kind, base);
      const seg = pr.segs[pr.segs.length - 1];
      draftInfo = { cost: plan.cost - (base.segs.length ? was.cost : 0), length: new CurveLUT(segCurve(pr, seg)).length };
    }
    // Знаки скорости на поворотах — как у построенной дороги (у путей их нет).
    const signs = kind === 'road' ? projectCurveSigns(pr) : [];
    const slowest = signs.length ? Math.min(...signs.map((x) => x.kmh)) : null;
    return { plan, segs, nodes, handles, draft: draftInfo, signs, slowest };
  }
}

/**
 * Общий проект дорог «Дороги»: новые участки (ProjectTools, «Строить») и правки построенных дорог (MoveProject —
 * «Двигать», «Полоса», протяжки построенных дорог в «Строить») — один проект: общие цена, проверки, знаки и история
 * Ctrl+Z, строится разом. План правок — с участками после них (tail).
 */
export function sharedRoadProject(game: () => Game): { tools: ProjectTools; edits: MoveProject } {
  const tools: ProjectTools = new ProjectTools(game, () => edits);
  const edits: MoveProject = new MoveProject(game, {
    tail: () => {
      const pr = tools.project('road');
      return pr.segs.length ? { edit: roadProjectEdit(pr, game().ground()), key: JSON.stringify(pr) } : null;
    },
    built: () => tools.built('road'),
  });
  return { tools, edits };
}
