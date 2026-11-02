import type { Cubic } from '../core/bezier';
import { add, angleOf, dist, dot, len, norm, scale, sub, Vec } from '../core/vec';
import type { DrawMode } from '../game/build';
import type { Game } from '../game/game';
import type { RoadPlan } from '../game/roadbuild';
import { alignNode, Anchor, anchorAt, corridorUnder, dragLane, LaneDraft, startLane } from '../lanes/edit';
import { Corridor, Flow, LaneNet, LaneNode, LaneSlot, oneWay, twoWay } from '../lanes/model';
import { isDivided, MEDIAN, RoadClass, RoadSpec } from '../world/roadTypes';

export interface RoadProfile {
  cls: RoadClass;
  lanes: LaneSlot[];
  limit?: number;
}

/** Профиль дороги из настроек панели: класс, полосы (по ходу — справа), ограничение скорости. */
export function profileOf(spec: RoadSpec): RoadProfile {
  const f = spec.lanesF;
  const b = spec.lanesB;
  const lanes = b === 0 ? oneWay(f) : f === 0 ? oneWay(b) : twoWay(f, b, isDivided(spec) ? MEDIAN : 0);
  return { cls: spec.cls, lanes, limit: spec.limit };
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
  /** Узел, который тянут. */
  dragNode: number | null = null;
  /** Полотно, которое выгибают за середину. */
  bend: number | null = null;
  /** Насколько близко к прямой между соседями узел к ней прилипает. */
  private moveSnap = 12;
  /** Прямая прилипла к направлению — подпись у курсора. */
  hint: string | null = null;

  constructor(private readonly game: () => Game) {}

  private get net(): LaneNet {
    return this.game().roads.net;
  }

  get busy(): boolean {
    return !!(this.start || this.control || this.lane || this.dragNode !== null || this.bend !== null);
  }

  /** Сменили инструмент — всё начатое забываем. */
  clear(): void {
    this.start = null;
    this.control = null;
    this.lane = null;
    this.dragNode = null;
    this.bend = null;
    this.hint = null;
  }

  /** Esc или правая кнопка: шаг назад. true — было что отменять. */
  cancel(): boolean {
    if (this.lane || this.dragNode !== null || this.bend !== null) {
      this.lane = null;
      this.dragNode = null;
      this.bend = null;
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
    this.start = anchorAt(this.net, p, r);
    this.control = null;
    return true;
  }

  /** Где кончится дорога; с Shift — угол по 15° от направления начала и длина по 10 м. */
  endAnchor(p: Vec, r: number, shift: boolean): Anchor {
    this.hint = null;
    const s = this.start;
    if (shift && s) {
      const d = sub(p, s.pos);
      const base = this.startDirs()[0] ? angleOf(this.startDirs()[0]) : 0;
      const step = Math.PI / 12;
      const a = base + Math.round((angleOf(d) - base) / step) * step;
      const l = Math.max(10, Math.round(len(d) / 10) * 10);
      const q = add(s.pos, scale({ x: Math.cos(a), y: Math.sin(a) }, l));
      const near = anchorAt(this.net, q, r * 0.5);
      return near.kind === 'node' ? near : { kind: 'free', pos: q };
    }
    const a = anchorAt(this.net, p, r);
    // Прямая от дороги сама прилипает к её продолжению (180°) или перпендикуляру (90°).
    if (a.kind === 'free' && s) {
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
          return { kind: 'free', pos: add(s.pos, scale(best.v, l * best.cos)) };
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

  buildPlan(p: Vec, spec: RoadSpec, mode: DrawMode, r: number, shift: boolean): RoadPlan | null {
    if (!this.start || (mode === 'curve' && !this.control)) return null;
    if (!this.valid(this.start)) {
      this.start = null;
      return null;
    }
    const end = this.endAnchor(p, r, shift);
    return this.game().roadBuilder.road(this.start, end, { ...profileOf(spec), control: this.control ?? undefined, kink: mode === 'straight' });
  }

  /** Клик концом: точка изгиба кривой или постройка. Возвращает причину, если не построилось. */
  build(p: Vec, spec: RoadSpec, mode: DrawMode, r: number, shift: boolean): string | null {
    if (mode === 'curve' && !this.control) {
      this.control = { ...p };
      return null;
    }
    const plan = this.buildPlan(p, spec, mode, r, shift);
    if (!plan) return null;
    if (!plan.ok) return plan.reason ?? 'Нельзя построить';
    const end = this.endAnchor(p, r, shift);
    this.game().roadBuilder.apply(plan);
    // Следующая дорога — от конца этой.
    this.start = anchorAt(this.net, end.pos, 3);
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

  laneDown(p: Vec, r: number): void {
    this.lane = startLane(this.net, p, r);
  }

  laneMove(p: Vec, r: number): void {
    if (this.lane) this.lane = dragLane(this.net, this.lane, p, r);
  }

  lanePlan(spec: RoadSpec): RoadPlan | null {
    const d = this.lane;
    if (!d) return null;
    const cls = (d.host && this.net.corridors.get(d.host.corridor)?.cls) || spec.cls;
    return this.game().roadBuilder.lane(d, cls);
  }

  laneUp(p: Vec, r: number, spec: RoadSpec): string | null {
    if (!this.lane) return null;
    this.laneMove(p, r);
    const plan = this.lanePlan(spec);
    this.lane = null;
    if (!plan) return null;
    if (!plan.ok) return plan.reason ?? 'Нельзя построить';
    this.game().roadBuilder.apply(plan);
    return null;
  }

  // ---------- Перестроить ----------

  /** Полотно под курсором с новым профилем; тот же профиль у односторонней — разворот. */
  upgradePlan(p: Vec, spec: RoadSpec, r: number): { corridor: Corridor; plan: RoadPlan } | null {
    const c = corridorUnder(this.net, p, r);
    if (!c) return null;
    const profile = profileOf(spec);
    const sig = (lanes: LaneSlot[]) => lanes.map((l) => `${l.offset}:${l.flow}`).sort().join();
    if (sig(profile.lanes) === sig(c.lanes) && c.cls === profile.cls && profile.lanes.every((l) => l.flow === profile.lanes[0].flow)) {
      profile.lanes = profile.lanes.map((l) => ({ ...l, flow: -l.flow as Flow }));
    }
    return { corridor: c, plan: this.game().roadBuilder.rebuild(c.id, profile) };
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

  /** Узел у курсора (перекрёсток, стык, тупик). */
  nodeAt(p: Vec, r: number): LaneNode | null {
    return this.net.nodesNear(p, r).sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0] ?? null;
  }

  /** Взять узел или середину дороги. false — ничего не взяли. */
  moveDown(p: Vec, r: number): boolean {
    this.moveSnap = r;
    const n = this.nodeAt(p, r);
    if (n) {
      this.dragNode = n.id;
      return true;
    }
    const c = corridorUnder(this.net, p, r * 0.3);
    if (c) {
      this.bend = c.id;
      return true;
    }
    return false;
  }

  movePlan(p: Vec): RoadPlan | null {
    const b = this.game().roadBuilder;
    if (this.dragNode !== null) return b.moveNode(this.dragNode, alignNode(this.net, this.dragNode, p, this.moveSnap));
    if (this.bend !== null) return b.reshape(this.bend, (n, c) => bendCurve(n, c, p));
    return null;
  }

  moveUp(p: Vec, moved: boolean): string | null {
    const plan = moved ? this.movePlan(p) : null;
    this.dragNode = null;
    this.bend = null;
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
}

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
