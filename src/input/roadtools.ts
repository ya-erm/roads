import type { Cubic } from '../core/bezier';
import { add, angleOf, dist, dot, len, norm, scale, sub, Vec } from '../core/vec';
import type { DrawMode } from '../game/build';
import type { Game } from '../game/game';
import type { LaneStepOut, NetEdit, RoadPlan } from '../game/roadbuild';
import {
  alignNode,
  Anchor,
  anchorAt,
  bulldozeSpan,
  smoothCorner,
  corridorUnder,
  dragHandle,
  dragLane,
  Handle,
  handlePoints,
  handlesOf,
  joinDeadEnd,
  LaneDraft,
  LaneTip,
  laneTipAt,
  laneTipPos,
  laneAlong,
  laneUnder,
  removeEdgeLane,
  removeLaneSpan,
  startLane,
  buildRoad,
  RoadOptions,
} from '../lanes/edit';
import { levelDeck, nodeDeck, setDecks, zAlong } from '../lanes/deck';
import { branchSeam, slidePorts, slideSeam, slideTarget, slideTrack } from '../lanes/slide';
import { CornerHandle, cornerHandleAt, cornerHandles, cornerLimitText, cornerRadiusAt, cornerTurn, setCornerRadius } from '../lanes/corners';
import { junctionCorners } from '../lanes/geometry';
import { GRADE } from '../config';
import { autoLevels, designProfile, PROFILE_STEP, steepText } from '../game/grade';
import { laneEdit, laneStepEdit, moveNodeEdit, onOldAxis, reshapeEdit } from '../game/roadbuild';
import { Corridor, Flow, LaneNet, LaneNode, LaneSlot, LAT_EPS, profileOf } from '../lanes/model';
import { isOneWay, LANE_W, LEVEL_RUN, ROAD_CLASSES, ROAD_MARGIN, type RoadClass, type RoadSpec } from '../world/roadTypes';

export { profileOf, type RoadProfile } from '../lanes/model';

/**
 * Дорога, частью которой служит полотно c: оно и куски, что продолжают его через стыки (только дорога,
 * без ответвлений) и подходят под keep, — до перекрёстков, тупиков и развилок.
 */
export function roadChain(net: LaneNet, c0: Corridor, keep: (c: Corridor) => boolean = () => true): Corridor[] {
  const seen = new Set([c0.id]);
  const res = [c0];
  for (let i = 0; i < res.length; i++) {
    const c = res[i];
    for (const end of ['a', 'b'] as const) {
      const e = net.end(c, end);
      if (e.node.kind !== 'seam') continue;
      const ends = net.ends(e.node);
      if (ends.length !== 2 || ends.some((x) => Math.abs(x.port) >= LAT_EPS)) continue;
      const o = ends.find((x) => x.corridor.id !== c.id)?.corridor;
      if (!o || seen.has(o.id) || !keep(o)) continue;
      seen.add(o.id);
      res.push(o);
    }
  }
  return res;
}

/** Односторонняя дорога целиком: куски через стыки, пока они тоже односторонние. */
function oneWayChain(net: LaneNet, c0: Corridor): Corridor[] {
  return roadChain(net, c0, (c) => c.lanes.length > 0 && c.lanes.every((l) => l.flow === c.lanes[0].flow));
}

/** Высота полотна над землёй на уровне level, м: мост выше, тоннель ниже (у моста с заданной высотой — nodeDeck). */
export function deckHeight(level: number): number {
  return levelDeck(level);
}

/**
 * Инструменты дороги на сети полос: строить (прямая, плавно, кривой), «Полоса» вдоль края,
 * перестроить, двигать узел или выгнуть дорогу, снести. Всё — через планы строителя дорог игры:
 * план показывается как построенное, по клику (или отпусканию) строится.
 */
export class RoadTools {
  /** Начало новой дороги (после постройки — её конец: следующая дорога продолжает эту). */
  start: Anchor | null = null;
  /** Точка изгиба кривой. */
  control: Vec | null = null;
  /** Полоса, которую ведут мышью. */
  lane: LaneDraft | null = null;
  /** Конец полосы, которую ведут по точкам (кликами, как путь). */
  laneTip: LaneTip | null = null;
  /**
   * Полосу тянут мышью от tip: entry — где из поля дошли до края дороги (въезд), along — докуда вдоль дороги,
   * away — куда ушли в сторону (съезд или однополосная); r — радиус прилипания.
   */
  laneDrag: { tip: LaneTip; entry: Vec | null; along: Vec | null; away: Vec | null; r: number } | null = null;
  /** Односторонняя — навстречу ходу постройки, новая полоса у края — встречная (Alt переключает). */
  reverse = false;
  /** Узел, который тянут. */
  dragNode: number | null = null;
  /** Примыкание (стык въезда или съезда посреди дороги), которое тянут вдоль дороги. */
  slide: number | null = null;
  /** Полотно, которое выгибают за середину. */
  bend: number | null = null;
  /** Перо, которое тянут. */
  handle: Handle | null = null;
  /** Угол перекрёстка, который скругляют (ручка — в сети, от которой тянут). */
  corner: CornerHandle | null = null;
  /** Полотно, у которого видны перья: последнее под курсором — они остаются, пока курсор идёт к ним. */
  editCorridor: number | null = null;
  /** Куда примкнёт тянущийся тупик. */
  joinPos: Vec | null = null;
  /** Высота, на которой строим: −1 тоннель, 0 земля, 1 мост (в «Авто» — 0, остальное решает профиль). */
  level = 0;
  /** «Авто»: где дороге на земле не хватает насыпи или выемки — мост или тоннель сам, с пандусами. */
  auto = true;
  /** На сколько метров конец дороги выше (минус — ниже) начала (−/+); null — на той же высоте над землёй, что начало. */
  rise: number | null = null;
  /** Что «Авто» сделал в последнем плане: метры моста и тоннеля и уровень конца (для подсказки и продолжения). */
  autoInfo: { bridge: number; tunnel: number; endLevel: number } | null = null;
  /** На сколько метров конец дороги в последнем плане выше начала на самом деле (концы — на земле, мосту или в тоннеле). */
  endRise: number | null = null;
  /** На чём конец дороги в последнем плане: −1 тоннель, 0 земля, 1 мост. */
  endLevel = 0;
  /** Насколько близко к прямой между соседями узел к ней прилипает. */
  private moveSnap = 12;
  /** Прямая прилипла к направлению — подпись у курсора. */
  hint: string | null = null;

  constructor(private readonly game: () => Game) {}

  /** Сеть, от которой тянут в проекте перемещения (настоящая — с нарисованными правками); null — настоящая. */
  base: LaneNet | null = null;
  /** Проект полос: правки, что уже нарисованы, — план следующей идёт после них (тянут её от base). */
  lanePrefix: NetEdit[] = [];
  /** Проект полос: готовая правка — сюда (в проект), а не строится. Ответ — что не так. */
  laneSink: ((edit: NetEdit) => string | null) | null = null;

  private get net(): LaneNet {
    return this.base ?? this.game().roads.net;
  }

  get busy(): boolean {
    return !!(this.start || this.control || this.lane || this.laneDrag || this.laneTip || this.dragging);
  }

  /** Тянут узел, примыкание, перо, угол перекрёстка или середину дороги. */
  get dragging(): boolean {
    return this.dragNode !== null || this.slide !== null || this.bend !== null || this.handle !== null || this.corner !== null;
  }

  /** Сменили инструмент — всё начатое забываем. */
  clear(): void {
    this.start = null;
    this.control = null;
    this.lane = null;
    this.laneDrag = null;
    this.laneTip = null;
    this.dragNode = null;
    this.slide = null;
    this.bend = null;
    this.handle = null;
    this.corner = null;
    this.editCorridor = null;
    this.hint = null;
  }

  /** Esc или правая кнопка: шаг назад. true — было что отменять. */
  cancel(): boolean {
    if (this.lane || this.laneDrag || this.dragging) {
      this.lane = null;
      this.laneDrag = null;
      this.dragNode = null;
      this.slide = null;
      this.bend = null;
      this.handle = null;
      this.corner = null;
      return true;
    }
    if (this.laneTip) {
      this.laneTip = null;
      return true;
    }
    if (this.control) {
      this.control = null;
      return true;
    }
    if (this.start) {
      this.start = null;
      return true;
    }
    return false;
  }

  // ---------- Строить ----------

  /** Начать дорогу, если ещё не начата. true — только что начали (ждём второй клик или отпускание). */
  begin(p: Vec, r: number): boolean {
    if (this.start) return false;
    this.start = anchorAt(this.net, p, r, this.level);
    this.control = null;
    return true;
  }

  /**
   * Где кончится дорога; с Shift — угол по 15° от направления начала и длина по 10 м;
   * free (зажат Alt или Cmd / Ctrl) — без прилипания к «прямо» и 90°: конец ровно под курсором.
   */
  endAnchor(p: Vec, r: number, shift: boolean, free = false): Anchor {
    this.hint = null;
    const s = this.start;
    if (shift && s) {
      const d = sub(p, s.pos);
      const base = this.startDirs()[0] ? angleOf(this.startDirs()[0]) : 0;
      const step = Math.PI / 12;
      const a = base + Math.round((angleOf(d) - base) / step) * step;
      const l = Math.max(10, Math.round(len(d) / 10) * 10);
      const q = add(s.pos, scale({ x: Math.cos(a), y: Math.sin(a) }, l));
      const near = anchorAt(this.net, q, r * 0.5, this.level);
      return near.kind === 'node' ? near : { kind: 'free', pos: q, level: this.level };
    }
    const a = anchorAt(this.net, p, r, this.level);
    // Прямая от дороги сама прилипает к её продолжению (180°) или перпендикуляру (90°); с free — нет.
    if (a.kind === 'free' && s && !free) {
      const d = sub(p, s.pos);
      const l = len(d);
      if (l > 20) {
        const dir = scale(d, 1 / l);
        let best: { v: Vec; hint: string; cos: number } | null = null;
        for (const ref of this.startDirs()) {
          for (const [v, hint] of [
            [ref, 'прямо'],
            [{ x: -ref.y, y: ref.x }, '90°'],
            [{ x: ref.y, y: -ref.x }, '90°'],
          ] as const) {
            const c = dot(dir, v);
            if (c > Math.cos(0.1) && (!best || c > best.cos)) best = { v, hint, cos: c };
          }
        }
        if (best) {
          this.hint = best.hint;
          return { kind: 'free', pos: add(s.pos, scale(best.v, l * best.cos)), level: this.level };
        }
      }
    }
    return a;
  }

  /** Направления «прямо» от начала: продолжения дорог узла или вдоль полотна. */
  private startDirs(): Vec[] {
    const s = this.start;
    if (!s) return [];
    if (s.kind === 'node' && this.net.nodes.has(s.node)) return this.net.ends(this.net.node(s.node)).map((e) => scale(e.away, -1));
    if (s.kind === 'corridor' && this.net.corridors.has(s.corridor)) {
      const t = this.net.corridor(s.corridor).lut.tangentAt(s.s);
      return [t, scale(t, -1)];
    }
    return [];
  }

  /** Уровень начала: свободное начало можно поднять или опустить, пока дорога не построена (у узла — его уровень). */
  get startLevel(): number | null {
    const s = this.start;
    if (!s) return null;
    if (s.kind === 'free') return s.level ?? 0;
    if (s.kind === 'node') return this.net.nodes.get(s.node)?.level ?? 0;
    return 0;
  }

  /** Концы дороги: свободные концы — на уровне level (если задан), у узлов — их уровень. */
  private ends(p: Vec, r: number, shift: boolean, free: boolean, level?: number): [Anchor, Anchor] {
    const start = level !== undefined && this.start!.kind === 'free' ? { ...this.start!, level } : this.start!;
    const end = this.endAnchor(p, r, shift, free);
    return [start, level !== undefined && end.kind === 'free' ? { ...end, level } : end];
  }

  buildPlan(p: Vec, spec: RoadSpec, mode: DrawMode, r: number, shift: boolean, free = false, level?: number): RoadPlan | null {
    if (!this.start || (mode === 'curve' && !this.control)) return null;
    if (!this.valid(this.start)) {
      this.start = null;
      return null;
    }
    const [start, end] = this.ends(p, r, shift, free, level);
    const profile = profileOf(spec);
    // Односторонняя навстречу ходу постройки (Alt): полосы — от конца к началу.
    if (this.reverse && isOneWay(spec)) profile.lanes = profile.lanes.map((l) => ({ ...l, flow: -l.flow as Flow }));
    const opts: RoadOptions = { ...profile, control: this.control ?? undefined, kink: mode === 'straight', arc: mode === 'arc' };
    const ground = this.game().roadBuilder.road(start, end, opts);
    this.autoInfo = null;
    this.endRise = null;
    const plan = !this.auto || level !== undefined ? ground : (this.autoPlan(ground, start, end, opts) ?? ground);
    return this.withSlope(plan, start);
  }

  /**
   * Уклон новой дороги от начала к концу — в профиль плана (подсказка показывает его, а не самый крутой бугор
   * по пути); высота концов — по земле и уровню узла (мост, тоннель). endRise — на сколько конец выше начала.
   */
  private withSlope(plan: RoadPlan, start: Anchor): RoadPlan {
    const groundAt = this.game().ground();
    const net = plan.net;
    if (!groundAt || !net) return plan;
    const path = this.pathOf(net, start.pos);
    if (!path) return plan;
    const nodeAt = (p: Vec) => net.nodesNear(p, 2).sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
    // Отметка конца: земля и высота полотна в узле (у моста «Авто» — своя, по профилю).
    const zAt = (p: Vec) => {
      const n = nodeAt(p);
      return groundAt(p) + (n ? nodeDeck(n) : 0);
    };
    const rise = zAt(path.at(path.length)) - zAt(path.at(0));
    if (!Number.isFinite(rise)) return plan;
    this.endRise = rise;
    this.endLevel = nodeAt(path.at(path.length))?.level ?? 0;
    const slope = rise / path.length;
    const was = plan.profile ?? { grade: 0, cut: 0, fill: 0 };
    return { ...plan, profile: { ...was, grade: Math.max(was.grade, Math.abs(slope)), slope } };
  }

  /** Уровень узла или дороги, к которой примыкает якорь; у свободного — его уровень. */
  private anchorLevel(net: LaneNet, a: Anchor): number {
    if (a.kind === 'node') return net.nodes.get(a.node)?.level ?? 0;
    if (a.kind === 'corridor') {
      const c = net.corridors.get(a.corridor);
      return c ? Math.round(net.heightAt(c, a.s)) : 0;
    }
    return a.level ?? 0;
  }

  /** На сколько метров над землёй полотно у якоря: у узла — его высота, на мосту — высота моста в этом месте. */
  private anchorDeck(net: LaneNet, a: Anchor): number {
    if (a.kind === 'node') {
      const n = net.nodes.get(a.node);
      return n ? nodeDeck(n) : 0;
    }
    if (a.kind === 'corridor') {
      const c = net.corridors.get(a.corridor);
      if (!c || Math.round(net.heightAt(c, a.s)) <= 0) return levelDeck(this.anchorLevel(net, a));
      const [A, B] = [net.node(c.a), net.node(c.b)];
      return nodeDeck(A) + (nodeDeck(B) - nodeDeck(A)) * (a.s / c.length);
    }
    return levelDeck(a.level ?? 0);
  }

  /** Высота начала над землёй, м: подпись у начала и отметка, от которой −/+ считает конец. */
  get startDeck(): number {
    return this.start && this.valid(this.start) ? this.anchorDeck(this.net, this.start) : 0;
  }

  /**
   * «Авто»: та же дорога, но по высоте — от начала до конца (на rise метров выше начала или на той же высоте
   * над землёй). Где полотну по профилю нужна насыпь или выемка глубже допустимой — мост или тоннель с
   * пандусами; дорога строится кусками от одной смены уровня до другой. null — «Авто» не нужен (рельефа нет
   * или дорога и так ложится на землю).
   */
  private autoPlan(ground: RoadPlan, start: Anchor, end: Anchor, opts: RoadOptions): RoadPlan | null {
    const g = this.game();
    const groundAt = g.ground();
    if (!groundAt || !ground.net) return null;
    const startLevel = this.anchorLevel(this.net, start);
    const endFixed = end.kind === 'free' ? undefined : this.anchorLevel(this.net, end);
    const plainFail = !ground.ok && /^(Насыпь|Выемка)/.test(ground.reason ?? '');
    if (this.rise === null && !plainFail && startLevel === 0 && (endFixed ?? 0) === 0) return null;
    const path = this.pathOf(ground.net, start.pos);
    if (!path) return null;
    const n = Math.max(2, Math.ceil(path.length / PROFILE_STEP) + 1);
    const ds = path.length / (n - 1);
    const h = new Float64Array(n);
    for (let i = 0; i < n; i++) h[i] = groundAt(path.at(ds * i));
    const h0 = Number.isNaN(h[0]) ? 0 : h[0];
    const h1 = Number.isNaN(h[n - 1]) ? h0 : h[n - 1];
    const z0 = h0 + this.anchorDeck(this.net, start);
    const z1 = this.rise !== null ? z0 + this.rise : h1 + (endFixed !== undefined ? this.anchorDeck(this.net, end) : z0 - h0);
    const prof = designProfile(h, ds, GRADE.road, { start: z0, end: z1 }, GRADE.smooth);
    // До цели не дотянуть и мостом: от начала до конца круче, чем можно дороге, — та же ошибка, что у моста.
    if (prof.steep) return { ...ground, ok: false, reason: steepText((z1 - z0) / path.length, GRADE.road) };
    const pts = autoLevels(prof.z, h, ds, GRADE.roadDepth, LEVEL_RUN + 10, { start: start.kind === 'free' ? undefined : startLevel, end: endFixed });
    if (pts.every((q) => q.level === 0)) return null;
    // Та же дорога, что нарисовал игрок (прямо, дугой, кривой): смены уровня — стыки на ней, форма в плане не меняется.
    const a: Anchor = start.kind === 'free' ? { ...start, level: pts[0].level } : start;
    const b: Anchor = end.kind === 'free' ? { ...end, level: pts[pts.length - 1].level } : end;
    const levels = pts.slice(1, -1).map((q) => ({ at: q.s / path.length, level: q.level }));
    // Новые узлы моста и тоннеля — на отметке профиля: −/+ поднимает и опускает мост, а не только удлиняет его, а
    // проверка уклона моста видит задуманный уклон (до проверки — в самой правке).
    const zAt = zAlong(Array.from({ length: n }, (_, i) => path.at(ds * i)), prof.z);
    const plan = g.roadBuilder.plan((net) => {
      if (!buildRoad(net, a, b, { ...opts, levels }).length) return false;
      setDecks(net, (x) => !this.net.nodes.has(x.id), zAt, groundAt);
      return true;
    });
    let bridge = 0;
    let tunnel = 0;
    for (let k = 1; k < pts.length; k++) {
      if (pts[k].level !== pts[k - 1].level) continue;
      if (pts[k].level > 0) bridge += pts[k].s - pts[k - 1].s;
      if (pts[k].level < 0) tunnel += pts[k].s - pts[k - 1].s;
    }
    this.autoInfo = { bridge, tunnel, endLevel: pts[pts.length - 1].level };
    return plan;
  }

  /** Ось новой дороги в плане: её полотна по порядку от точки from — точка на расстоянии s и длина. */
  private pathOf(net: LaneNet, from: Vec): { length: number; at: (s: number) => Vec } | null {
    const fresh = [...net.corridors.values()].filter((c) => !this.net.corridors.has(c.id) && !onOldAxis(this.net, c));
    const pts: Vec[] = [from];
    let cur = from;
    const used = new Set<number>();
    for (;;) {
      const c = fresh.find((x) => !used.has(x.id) && (dist(x.curve.p0, cur) < 2 || dist(x.curve.p3, cur) < 2));
      if (!c) break;
      used.add(c.id);
      const forward = dist(c.curve.p0, cur) < 2;
      const k = Math.max(2, Math.ceil(c.length / 4));
      for (let i = 1; i <= k; i++) pts.push(c.lut.pointAt(((forward ? i : k - i) / k) * c.length));
      cur = pts[pts.length - 1];
    }
    if (pts.length < 3) return null;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const length = cum[cum.length - 1];
    const at = (s: number): Vec => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
    };
    return { length, at };
  }

  /** Клик концом: точка изгиба кривой или постройка. Возвращает причину, если не построилось. */
  build(p: Vec, spec: RoadSpec, mode: DrawMode, r: number, shift: boolean, free = false, level?: number): string | null {
    if (mode === 'curve' && !this.control) {
      this.control = { ...p };
      return null;
    }
    const plan = this.buildPlan(p, spec, mode, r, shift, free, level);
    if (!plan) return null;
    if (!plan.ok) return plan.reason ?? 'Нельзя построить';
    const end = this.ends(p, r, shift, free, level)[1];
    const endLevel = this.autoInfo?.endLevel ?? (end.kind === 'free' ? end.level : undefined);
    this.game().roadBuilder.apply(plan);
    // Следующая дорога — от конца этой; высота конца — снова «как у начала».
    this.start = anchorAt(this.net, end.pos, 3, endLevel);
    this.rise = null;
    this.control = null;
    return null;
  }

  /** Якорь ещё в сети (после отмены или сноса мог исчезнуть). */
  private valid(a: Anchor): boolean {
    if (a.kind === 'node') return this.net.nodes.has(a.node);
    if (a.kind === 'corridor') return this.net.corridors.has(a.corridor);
    return true;
  }

  // ---------- Полоса ----------

  /** Нажали: по точкам уже ведём — ждём отпускания; иначе — начало протяжки (у конца пристроенной полосы — и её конец). */
  laneDown(p: Vec, r: number): void {
    if (this.laneTip && !this.validTip(this.laneTip)) this.laneTip = null;
    this.lane = null;
    this.laneDrag = null;
    if (this.laneTip) return;
    const tip = laneTipAt(this.net, p, r);
    const d = startLane(this.net, p, r);
    if (d.grab && tip.kind !== 'port') this.lane = d;
    this.laneDrag = { tip, entry: null, along: null, away: null, r };
  }

  /**
   * Тянут: у края дороги — полоса вдоль (и дальше через стыки), ушли в сторону — съезд оттуда, где ушли;
   * вернулись к линии полосы — она тянется дальше. Из поля — до края дороги (въезд), потом вдоль неё.
   */
  laneMove(p: Vec, r: number): void {
    if (this.lane) this.lane = dragLane(this.net, this.lane, p, r);
    const d = this.laneDrag;
    if (!d) return;
    if (d.tip.kind === 'edge') {
      if (laneAlong(this.net, d.tip, p)) {
        d.along = p;
        d.away = null;
      } else d.away = p;
    } else if (d.tip.kind === 'point' && laneTipAt(this.net, p, r).kind === 'edge') {
      if (d.entry) d.along = p;
      else d.entry = p;
    } else if (!d.entry) d.away = p;
  }

  /** Класс полосы — как у дороги, от которой её ведут (у края, у конца, в узле); в чистом поле — улица. */
  private tipClass(tip: LaneTip): RoadClass {
    const net = this.net;
    if (tip.kind === 'edge') return net.corridors.get(tip.corridor)?.cls ?? 'street';
    const node = tip.kind === 'port' ? tip.node : tip.anchor.kind === 'node' ? tip.anchor.node : null;
    if (node !== null) {
      const cs = (net.nodes.get(node)?.corridors ?? []).map((id) => net.corridor(id));
      return (cs.find((c) => c.lanes.length > 1) ?? cs[0])?.cls ?? 'street';
    }
    if (tip.kind === 'point' && tip.anchor.kind === 'corridor') return net.corridors.get(tip.anchor.corridor)?.cls ?? 'street';
    return 'street';
  }

  /** План правки полосы — после правок проекта (lanePrefix), если он есть. */
  private lanePlanOf(edit: NetEdit): RoadPlan {
    const prefix = this.lanePrefix;
    return this.game().roadBuilder.plan(
      (n) => {
        for (const e of prefix) if (e(n) === false) return false;
        return edit(n);
      },
      { shove: true },
    );
  }

  /** Что построится по протяжке: план, подпись и сама правка (для проекта полос). */
  lanePlan(spec: RoadSpec): { plan: RoadPlan; what: string; edit: NetEdit; step?: LaneStepOut['step'] } | null {
    const d = this.laneDrag;
    if (!d) return null;
    const tipCls = this.tipClass(d.tip);
    // Конец пристроенной полосы ведут назад — короче (вперёд полоса тянется как от края, через стыки тоже).
    const g = this.lane;
    if (g?.grab && g.host && !this.extends(g)) {
      const edit = laneEdit(g, tipCls);
      const plan = this.lanePlanOf(edit);
      return { plan, what: plan.cost < 0 ? 'Полоса короче' : 'Полоса', edit };
    }
    const start = laneTipPos(this.net, d.tip);
    const pts =
      d.tip.kind === 'edge'
        ? [d.along && start && dist(d.along, start) > 8 ? d.along : null, d.away]
        : d.entry
          ? [d.entry, d.along]
          : [d.away];
    const qs = pts.filter((q): q is Vec => !!q);
    if (!qs.length) return null;
    const res = this.laneSteps(d.tip, qs, tipCls, d.r, spec);
    return { plan: res.plan, what: res.step?.what ?? '', edit: res.edit, step: res.step };
  }

  /** Ведут новую полосу от края дороги: её направление — по ходу движения с этой стороны, Alt разворачивает. */
  get laneFlips(): boolean {
    const tip = this.laneDrag?.tip ?? this.laneTip;
    return tip?.kind === 'edge' && tip.flow === undefined;
  }

  /** «Полоса по точкам» от tip через qs: правка, её план (после правок проекта) и новый конец. */
  private laneSteps(tip: LaneTip, qs: Vec[], cls: RoadClass, r: number, spec: RoadSpec): { plan: RoadPlan; step: LaneStepOut['step']; edit: NetEdit } {
    const out: LaneStepOut = { step: null };
    const edit = laneStepEdit(tip, qs, cls, r, spec.limit, this.reverse, out);
    const plan = this.lanePlanOf(edit);
    return { plan, step: this.laneFits(plan) ? out.step : null, edit };
  }

  /**
   * Правку полосы можно взять: план в порядке, а в проекте — любая, что вообще ложится на сеть (не проходит
   * проверку — красным, её чинят следующими правками: тянут узлы и перья; построить проект — только исправленный).
   */
  private laneFits(plan: RoadPlan): boolean {
    return plan.ok || (!!this.laneSink && !!plan.net);
  }

  /** Готовая правка полосы: в проекте — в проект (laneSink), иначе строится. Ответ — что не так. */
  private commitLane(plan: RoadPlan, edit: NetEdit): string | null {
    if (this.laneSink) return this.laneSink(edit);
    this.applyLanePlan(plan);
    return null;
  }

  /** Конец пристроенной полосы тянут дальше её конца, а не внутрь. */
  private extends(g: LaneDraft): boolean {
    const c = g.host && g.grab ? this.net.corridors.get(g.host.corridor) : undefined;
    const l = c && g.grab ? c.lanes[g.grab.lane] : undefined;
    if (!c || !l || !g.host || !g.grab) return false;
    return g.grab.end === 'to' ? g.host.s1 > Math.min(l.to, c.length) + 1 : g.host.s1 < l.from - 1;
  }

  /**
   * Отпустили: протянули — строится черновик (как раньше); просто клик — точка полосы по точкам:
   * первая — начало, следующие — куски до них (вдоль, съезд, въезд, однополосная).
   */
  laneUp(p: Vec, r: number, spec: RoadSpec, moved = true): string | null {
    if (this.laneTip) {
      const res = this.laneStepPlan(p, spec, r);
      if (!res) return null;
      if (!res.step) return res.plan.reason ?? 'Нельзя построить';
      const problem = this.commitLane(res.plan, res.edit);
      if (problem) return problem;
      this.laneTip = res.step.tip;
      return null;
    }
    if (!this.laneDrag) return null;
    if (!moved) {
      this.lane = null;
      this.laneDrag = null;
      this.laneTip = laneTipAt(this.net, p, r);
      return null;
    }
    this.laneMove(p, r);
    const res = this.lanePlan(spec);
    this.lane = null;
    this.laneDrag = null;
    if (!res) return null;
    if (!this.laneFits(res.plan)) return res.plan.reason ?? 'Нельзя построить';
    return this.commitLane(res.plan, res.edit);
  }

  /** Следующий кусок полосы по точкам до p; null — по точкам не ведём. */
  laneStepPlan(p: Vec, spec: RoadSpec, r: number): { plan: RoadPlan; step: LaneStepOut['step']; edit: NetEdit } | null {
    const tip = this.laneTip;
    if (!tip) return null;
    if (!this.validTip(tip)) {
      this.laneTip = null;
      return null;
    }
    return this.laneSteps(tip, [p], this.tipClass(tip), r, spec);
  }

  /** Где сейчас конец полосы по точкам. */
  laneTipPos(): Vec | null {
    return this.laneTip && this.validTip(this.laneTip) ? laneTipPos(this.net, this.laneTip) : null;
  }

  private validTip(tip: LaneTip): boolean {
    if (tip.kind === 'edge') return this.net.corridors.has(tip.corridor);
    if (tip.kind === 'port') return this.net.nodes.has(tip.node);
    return this.valid(tip.anchor);
  }

  private applyLanePlan(plan: RoadPlan): void {
    const g = this.game();
    g.roadBuilder.apply(plan);
    // Дома, на которые налезла новая полоса или съезд, отодвигаются.
    for (const id of plan.changed) g.roadWidened(id);
  }

  // ---------- Перестроить ----------

  /** Полотно под курсором с новым профилем; тот же профиль у односторонней — разворот. */
  upgradePlan(p: Vec, spec: RoadSpec, r: number): { corridor: Corridor; plan: RoadPlan } | null {
    const c = corridorUnder(this.net, p, r);
    if (!c) return null;
    const profile = profileOf(spec);
    // Односторонняя остаётся в свою сторону (полосы задом наперёд — «перекрученная» дорога),
    // а повторный клик тем же профилем разворачивает её.
    const oneWay = (lanes: LaneSlot[]) => (lanes.length > 0 && lanes.every((l) => l.flow === lanes[0].flow) ? lanes[0].flow : null);
    const now = oneWay(c.lanes);
    if (now !== null && oneWay(profile.lanes) !== null) {
      const offsets = (lanes: LaneSlot[]) => lanes.map((l) => l.offset).sort().join();
      // Тот же профиль — разворот всей односторонней до перекрёстков (её кусков через стыки), а не одного куска.
      if (offsets(profile.lanes) === offsets(c.lanes) && c.cls === profile.cls) {
        return { corridor: c, plan: this.game().roadBuilder.reverse(oneWayChain(this.net, c).map((x) => x.id)) };
      }
      profile.lanes = profile.lanes.map((l) => ({ ...l, flow: now as Flow }));
    }
    return { corridor: c, plan: this.game().roadBuilder.rebuild(c.id, profile) };
  }

  /**
   * Знак скорости над дорогой: ограничение на всей улице до перекрёстков, без перестройки; only (зажат Cmd / Ctrl) —
   * только на участке под курсором, между соседними узлами. was — какая скорость там сейчас, parts — из скольких
   * участков вся улица.
   */
  limitPlan(p: Vec, kmh: number, r: number, only = false): { plan: RoadPlan; was: number; parts: number } | null {
    const c = corridorUnder(this.net, p, r);
    if (!c || c.ring) return null;
    const chain = roadChain(this.net, c, (o) => o.cls === c.cls && o.lanes.length === c.lanes.length);
    const was = c.limit ?? ROAD_CLASSES[c.cls].limit;
    // Скорость класса — без своего ограничения: улица снова «по умолчанию».
    const limit = kmh === ROAD_CLASSES[c.cls].limit ? undefined : kmh;
    const ids = only ? [c.id] : chain.map((x) => x.id);
    return { plan: this.game().roadBuilder.setLimit(ids, limit), was, parts: chain.length };
  }

  setLimitAt(p: Vec, kmh: number, r: number, only = false): string | null {
    const res = this.limitPlan(p, kmh, r, only);
    if (!res) return 'Отпустите знак на дороге';
    if (!res.plan.ok) return res.plan.reason ?? 'Нельзя';
    this.game().roadBuilder.apply(res.plan);
    return null;
  }

  upgrade(p: Vec, spec: RoadSpec, r: number): string | null {
    const res = this.upgradePlan(p, spec, r);
    if (!res) return 'Кликните по дороге';
    if (!res.plan.ok) return res.plan.reason ?? 'Нельзя перестроить';
    const g = this.game();
    g.roadBuilder.apply(res.plan);
    g.roadWidened(res.corridor.id);
    return null;
  }

  // ---------- Двигать ----------

  /** Узел у курсора (перекрёсток, стык, тупик), кроме узлов станций — их двигают вместе со станцией. */
  nodeAt(p: Vec, r: number): LaneNode | null {
    const stations = this.stationNodes();
    return (
      this.net
        .nodesNear(p, r)
        .filter((n) => !stations.has(n.id) && (n.roundabout ?? null) === null)
        .sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0] ?? null
    );
  }

  private stationNodes(): Set<number> {
    return new Set([...this.game().stations.values()].map((s) => s.nodeId));
  }

  /**
   * Примыкание у курсора — стык въезда или съезда посреди дороги: у его узла или у конца ответвления (если другой
   * узел не ближе). pos — где ответвление (полотно corridor) примыкает к дороге; null — рядом нет.
   */
  slideAt(p: Vec, r: number): { node: number; pos: Vec; corridor: number } | null {
    const net = this.net;
    const stations = this.stationNodes();
    // Конец ответвления берут по всей ширине полосы, а не только точно в его середине.
    const grab = Math.max(r, LANE_W * 0.6);
    let best: { node: number; pos: Vec; corridor: number; d: number } | null = null;
    for (const n of net.nodesNear(p, grab + 40)) {
      const j = stations.has(n.id) ? null : branchSeam(net, n);
      if (!j) continue;
      // У узла на оси дороги — первое ответвление, у конца ответвления — оно само.
      const spots = [{ pos: n.pos, b: j.branches[0], lim: r }, ...j.branches.map((b) => ({ pos: net.portPos(n, b.port), b, lim: grab }))];
      for (const s of spots) {
        const d = dist(p, s.pos);
        if (d < s.lim && (!best || d < best.d)) best = { node: n.id, pos: net.portPos(n, s.b.port), corridor: s.b.corridor.id, d };
      }
    }
    if (!best) return null;
    const other = this.nodeAt(p, r);
    if (other && other.id !== best.node && dist(other.pos, p) < best.d) return null;
    return { node: best.node, pos: best.pos, corridor: best.corridor };
  }

  /** Куда можно сдвинуть примыкание id — точки вдоль дороги там, где примыкает ответвление. */
  jointTrack(id: number): Vec[] {
    const n = this.net.nodes.get(id);
    const j = n ? branchSeam(this.net, n) : null;
    return j ? slideTrack(j) : [];
  }

  /** Где отметить узел n дороги c: у примыкания для ответвления — его конец у дороги, иначе сам узел. */
  nodeMark(c: Corridor, n: LaneNode): Vec {
    const e = branchSeam(this.net, n)?.branches.find((b) => b.corridor.id === c.id);
    return e ? this.net.portPos(n, e.port) : n.pos;
  }

  /** Перья полотна, у которого их сейчас видно (и продолжающих его в стыках). */
  handles(): (Handle & { partner: boolean })[] {
    return this.editCorridor !== null ? handlesOf(this.net, this.editCorridor) : [];
  }

  /** Перо в изломе из двух дорог, который без Shift снова станет гладким стыком. */
  unkinks(h: Handle): boolean {
    return smoothCorner(this.net, h, false);
  }

  /** Перо под курсором; r — радиус попадания. */
  handleAt(p: Vec, r: number): Handle | null {
    let best: Handle | null = null;
    let bestD = r;
    for (const h of this.handles()) {
      const d = dist(p, handlePoints(this.net.corridor(h.corridor), h.end).pos);
      if (d <= bestD) {
        bestD = d;
        best = { corridor: h.corridor, end: h.end };
      }
    }
    return best;
  }

  /** Перья для подсказки на карте; net — сеть плана, если перо тянут. */
  handleMarks(active: Handle | null, net: LaneNet = this.net): { anchor: Vec; pos: Vec; active: boolean; partner: boolean }[] {
    return this.handles()
      .filter((h) => net.corridors.has(h.corridor))
      .map((h) => ({
        ...handlePoints(net.corridor(h.corridor), h.end),
        active: !!active && active.corridor === h.corridor && active.end === h.end,
        partner: h.partner,
      }));
  }

  /** Ручка угла перекрёстка под курсором (середина бордюра угла); r — радиус попадания. */
  cornerAt(p: Vec, r: number): CornerHandle | null {
    const h = cornerHandleAt(this.net, p, r);
    return h && cornerApart(h, r) ? h : null;
  }

  /**
   * Ручки углов перекрёстка, у которого курсор (на площадке или рядом): от вершины острого угла к середине бордюра —
   * за неё тянут. active — угол, который тянут или под курсором; net — сеть плана, если угол тянут.
   */
  cornerMarks(p: Vec, active: CornerHandle | null, net: LaneNet = this.net, r = 0): { anchor: Vec; pos: Vec; active: boolean; partner: boolean }[] {
    let best: { hs: CornerHandle[]; d: number } | null = null;
    // Угол тянут — его перекрёсток, как бы далеко ни ушёл курсор.
    const near = active ? [net.nodes.get(active.node)].filter((n): n is LaneNode => !!n) : net.nodesNear(p, 160);
    for (const n of near) {
      if (n.kind !== 'junction') continue;
      const hs = cornerHandles(net, n).filter((h) => active || cornerApart(h, r));
      if (!hs.length) continue;
      const d = dist(n.pos, p);
      const reach = Math.max(...hs.map((h) => dist(h.pos, n.pos))) + 25;
      if ((active || d <= reach) && (!best || d < best.d)) best = { hs, d };
    }
    return (best?.hs ?? []).map((h) => ({ anchor: h.corner.apex, pos: h.pos, active: !!active && active.node === h.node && active.corner.key === h.corner.key, partner: false }));
  }

  /** Ручки углов перекрёстка id (не сливаются с узлом на экране — r, как у cornerAt): «Перекрёсток» — у выбранного. */
  nodeCornerMarks(id: number, r: number): { anchor: Vec; pos: Vec; active: boolean; partner: boolean }[] {
    const n = this.net.nodes.get(id);
    if (!n || n.kind !== 'junction') return [];
    return cornerHandles(this.net, n)
      .filter((h) => cornerApart(h, r))
      .map((h) => ({ anchor: h.corner.apex, pos: h.pos, active: false, partner: false }));
  }

  /**
   * Знак скорости правого поворота вдоль угла, который тянут, — по сети плана net: середина дуги поворота, направление,
   * отступ знака до бордюра и км/ч; радиус дуги бордюра. null — угол не тянут или поворота там нет.
   */
  cornerSign(net: LaneNet): { pos: Vec; dir: Vec; side: number; kmh: number; radius: number } | null {
    const h = this.corner;
    const n = h && net.nodes.get(h.node);
    const k = n && junctionCorners(net, n).find((x) => x.key === h.corner.key);
    const turn = n && k ? cornerTurn(net, n, k) : null;
    if (!n || !turn) return null;
    const radius = n.corners?.[h.corner.key] ?? cornerHandles(net, n).find((x) => x.corner.key === h.corner.key)?.auto ?? 0;
    return { pos: turn.mid.pos, dir: turn.mid.dir, side: LANE_W / 2 + 2 * ROAD_MARGIN, kmh: Math.round(turn.kmh), radius };
  }

  /**
   * Взять перо, угол перекрёстка (скруглить), примыкание (ходит вдоль дороги), узел или середину дороги. false —
   * ничего не взяли. hr — радиус попадания в перо и угол; free (Alt или Cmd / Ctrl) — узел примыкания тянут как
   * любой узел, свободно.
   */
  moveDown(p: Vec, r: number, hr = r, free = false): boolean {
    this.moveSnap = r;
    this.handle = this.handleAt(p, hr);
    if (this.handle) return true;
    this.corner = this.cornerAt(p, hr);
    if (this.corner) return true;
    const joint = free ? null : this.slideAt(p, r);
    if (joint) {
      this.slide = joint.node;
      return true;
    }
    const n = this.nodeAt(p, r);
    if (n) {
      this.dragNode = n.id;
      return true;
    }
    const c = corridorUnder(this.net, p, r * 0.3);
    if (c && !c.ring) {
      this.bend = c.id;
      this.editCorridor = c.id;
      return true;
    }
    return false;
  }

  /** Куда примкнёт тупик, если его отпустить в p: узел или дорога рядом (не своя). null — никуда. */
  private joinTarget(id: number, p: Vec): Anchor | null {
    const net = this.net;
    const n = net.node(id);
    if (!net.isDeadEnd(n) || n.corridors.length !== 1) return null;
    const own = net.corridor(n.corridors[0]);
    const a = anchorAt(net, p, this.moveSnap);
    if (a.kind === 'free') return null;
    if (a.kind === 'corridor' && a.corridor === own.id) return null;
    if (a.kind === 'node' && (a.node === own.a || a.node === own.b || this.stationNodes().has(a.node))) return null;
    return a;
  }

  /** План переноса; kink — излом пера в стыке (Shift). В hint — «примкнёт» или «ровно». */
  /**
   * Правка сети, которую сделает протяжка до p: перо, узел (тупик — примкнёт), изгиб середины; null — ничего
   * не тянут. Одна и та же правка — и для обычного переноса, и для проекта перемещения. free (зажат Cmd / Ctrl
   * или Alt) — узел ровно под курсором: не встаёт на прямую между соседями и не примыкает к дороге.
   */
  moveEdit(p: Vec, kink = false, free = false): NetEdit | null {
    this.hint = null;
    this.joinPos = null;
    if (this.handle) {
      const h = this.handle;
      if (kink) this.hint = 'излом';
      else if (this.unkinks(h)) this.hint = 'гладко';
      return (n) => dragHandle(n, h, p, kink);
    }
    if (this.corner) {
      // Угол: середина дуги бордюра — у курсора; ближе, чем угол скруглён сам, — снова само.
      const h = this.corner;
      const r = cornerRadiusAt(h, p);
      // На пределе — почему дальше нельзя: радиус, стоп-линия далеко, рядом соседний перекрёсток или узел дороги.
      const full = r > 0 && r >= Math.floor(h.max);
      this.hint = r > 0 ? `радиус ${r} м${full ? ` — предел: ${cornerLimitText(h.limit)}` : ''}` : 'само';
      return (n) => setCornerRadius(n, h.node, h.corner.key, r);
    }
    if (this.slide !== null) {
      // Примыкание — вдоль дороги: где окажется конец ответвления и насколько позже или раньше по ходу въезда.
      const id = this.slide;
      const node = this.net.nodes.get(id);
      const j = node ? branchSeam(this.net, node) : null;
      if (j) {
        this.joinPos = slidePorts(j, p)[0] ?? null;
        const u = slideTarget(j, p);
        const b = j.branches[0];
        const fwd = b.corridor.lanes.length ? this.net.laneAtSeam(b, b.corridor.lanes[0]).forward : true;
        if (Math.abs(u) >= 1) this.hint = `${(fwd ? u : -u) > 0 ? 'позже' : 'раньше'} на ${Math.round(Math.abs(u))} м`;
      }
      return (n) => slideSeam(n, id, p);
    }
    if (this.dragNode !== null) {
      const id = this.dragNode;
      if (free) return moveNodeEdit(id, p);
      const join = this.joinTarget(id, p);
      this.joinPos = join?.pos ?? null;
      if (join) {
        this.hint = 'примкнёт';
        return (n) => joinDeadEnd(n, id, join);
      }
      const to = alignNode(this.net, id, p, this.moveSnap);
      if (to !== p) this.hint = 'ровно';
      return moveNodeEdit(id, to);
    }
    if (this.bend !== null) return reshapeEdit(this.bend, (n, c) => bendCurve(n, c, p));
    return null;
  }

  /** План переноса; before — правки проекта перемещения, уже нарисованные (протяжка — после них); free — без прилипания. */
  movePlan(p: Vec, kink = false, before: NetEdit[] = [], free = false): RoadPlan | null {
    const edit = this.moveEdit(p, kink, free);
    if (!edit) return null;
    return this.game().roadBuilder.plan((n) => {
      for (const e of before) if (e(n) === false) return false;
      return edit(n);
    });
  }

  /** Отпустили: ничего больше не тянут. */
  moveEnd(): void {
    this.dragNode = null;
    this.slide = null;
    this.bend = null;
    this.handle = null;
    this.corner = null;
    this.hint = null;
  }

  moveUp(p: Vec, moved: boolean, kink = false, free = false): string | null {
    const plan = moved ? this.movePlan(p, kink, [], free) : null;
    this.moveEnd();
    if (!plan) return null;
    if (!plan.ok) return plan.reason ?? 'Нельзя передвинуть';
    this.game().roadBuilder.apply(plan);
    return null;
  }

  // ---------- Снос ----------

  bulldozePlan(p: Vec, r: number): { corridor: Corridor; plan: RoadPlan } | null {
    const c = corridorUnder(this.net, p, r);
    return c ? { corridor: c, plan: this.game().roadBuilder.bulldoze([c.id]) } : null;
  }

  bulldoze(p: Vec, r: number): boolean {
    const res = this.bulldozePlan(p, r);
    if (!res?.plan.net) return false;
    // Снести можно всегда; оборванные полосы у стыков — не повод отказать.
    this.game().roadBuilder.apply({ ...res.plan, ok: true });
    return true;
  }

  /**
   * Снос полосы под курсором: крайняя полоса уходит (с продолжениями через стыки, съезд — целиком).
   * Оставшиеся дороги не проверяются (дома у них не сносим), но полосы должны сходиться в стыках.
   */
  laneBulldozePlan(p: Vec): { corridor: number; lane: number; plan: RoadPlan } | null {
    const hit = laneUnder(this.net, p);
    if (!hit) return null;
    const id = hit.corridor.id;
    const plan = this.game().roadBuilder.plan((n) => removeEdgeLane(n, n.corridor(id), hit.lane) > 0, { only: () => false });
    return { corridor: id, lane: hit.lane, plan };
  }

  /** Снос куска: полотна (lane — null) или полосы lane полотна corridor между s0 и s1. */
  spanPlan(corridor: number, lane: number | null, s0: number, s1: number): RoadPlan {
    const b = this.game().roadBuilder;
    if (lane === null) return b.plan((n) => bulldozeSpan(n, n.corridor(corridor), s0, s1), { raze: true });
    return b.plan((n) => removeLaneSpan(n, n.corridor(corridor), lane, s0, s1), { only: () => false });
  }

  /** Сносит полосу под курсором; null — снесли, иначе причина. */
  bulldozeLane(p: Vec): string | null {
    const res = this.laneBulldozePlan(p);
    if (!res) return 'Наведите на полосу';
    if (!res.plan.ok) return res.plan.reason ?? 'Нельзя снести';
    this.game().roadBuilder.apply(res.plan);
    return null;
  }
}

/**
 * Ручка угла видна и берётся, только если на экране она не сливается с узлом (r — радиус попадания, м): издалека
 * у курсора узел, угол скругляют, приблизив перекрёсток.
 */
const cornerApart = (h: CornerHandle, r: number) => dist(h.pos, h.corner.a.node.pos) >= r * 1.5;

/**
 * Полотно, выгнутое через точку target (дуга второго порядка, концы на месте). У стыка направление
 * конца сохраняется — меняется только длина «пера», чтобы полосы продолжали соседнее полотно.
 */
export function bendCurve(net: LaneNet, c: Corridor, target: Vec): Cubic {
  const { p0, p3 } = c.curve;
  const mid = scale(add(p0, p3), 0.5);
  const q = sub(scale(target, 2), mid);
  let p1 = add(p0, scale(sub(q, p0), 2 / 3));
  let p2 = add(p3, scale(sub(q, p3), 2 / 3));
  const keep = (end: 'a' | 'b', p: Vec, from: Vec): Vec => {
    const n = net.node(end === 'a' ? c.a : c.b);
    if (n.kind !== 'seam') return p;
    // Направление «от узла» вдоль прежней кривой.
    const t = norm(sub(end === 'a' ? c.curve.p1 : c.curve.p2, from));
    return add(from, scale(t, Math.max(8, dot(sub(p, from), t))));
  };
  p1 = keep('a', p1, p0);
  p2 = keep('b', p2, p3);
  return { p0, p1, p2, p3 };
}
