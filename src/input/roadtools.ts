import type { Cubic } from '../core/bezier';
import { add, angleOf, dist, dot, len, norm, scale, sub, Vec } from '../core/vec';
import type { DrawMode } from '../game/build';
import type { Game } from '../game/game';
import type { RoadPlan } from '../game/roadbuild';
import {
  alignNode,
  Anchor,
  anchorAt,
  bulldozeSpan,
  corridorUnder,
  dragHandle,
  dragLane,
  Handle,
  handlePoints,
  handlesOf,
  joinDeadEnd,
  LaneDraft,
  laneUnder,
  removeEdgeLane,
  removeLaneSpan,
  startLane,
} from '../lanes/edit';
import { Corridor, Flow, LaneNet, LaneNode, LaneSlot, profileOf } from '../lanes/model';
import type { RoadSpec } from '../world/roadTypes';

export { profileOf, type RoadProfile } from '../lanes/model';

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
  /** Перо, которое тянут. */
  handle: Handle | null = null;
  /** Полотно, у которого видны перья: последнее под курсором — они остаются, пока курсор идёт к ним. */
  editCorridor: number | null = null;
  /** Куда примкнёт тянущийся тупик. */
  joinPos: Vec | null = null;
  /** Высота, на которой строим: −1 тоннель, 0 земля, 1 мост, 2 эстакада. */
  level = 0;
  /** Насколько близко к прямой между соседями узел к ней прилипает. */
  private moveSnap = 12;
  /** Прямая прилипла к направлению — подпись у курсора. */
  hint: string | null = null;

  constructor(private readonly game: () => Game) {}

  private get net(): LaneNet {
    return this.game().roads.net;
  }

  get busy(): boolean {
    return !!(this.start || this.control || this.lane || this.dragging);
  }

  /** Тянут узел, перо или середину дороги. */
  get dragging(): boolean {
    return this.dragNode !== null || this.bend !== null || this.handle !== null;
  }

  /** Сменили инструмент — всё начатое забываем. */
  clear(): void {
    this.start = null;
    this.control = null;
    this.lane = null;
    this.dragNode = null;
    this.bend = null;
    this.handle = null;
    this.editCorridor = null;
    this.hint = null;
  }

  /** Esc или правая кнопка: шаг назад. true — было что отменять. */
  cancel(): boolean {
    if (this.lane || this.dragging) {
      this.lane = null;
      this.dragNode = null;
      this.bend = null;
      this.handle = null;
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
   * free (Alt) — без прилипания к «прямо» и 90°.
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
    // Прямая от дороги сама прилипает к её продолжению (180°) или перпендикуляру (90°); с Alt (free) — нет.
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

  buildPlan(p: Vec, spec: RoadSpec, mode: DrawMode, r: number, shift: boolean, free = false): RoadPlan | null {
    if (!this.start || (mode === 'curve' && !this.control)) return null;
    if (!this.valid(this.start)) {
      this.start = null;
      return null;
    }
    const end = this.endAnchor(p, r, shift, free);
    return this.game().roadBuilder.road(this.start, end, {
      ...profileOf(spec),
      control: this.control ?? undefined,
      kink: mode === 'straight',
      arc: mode === 'arc',
    });
  }

  /** Клик концом: точка изгиба кривой или постройка. Возвращает причину, если не построилось. */
  build(p: Vec, spec: RoadSpec, mode: DrawMode, r: number, shift: boolean, free = false): string | null {
    if (mode === 'curve' && !this.control) {
      this.control = { ...p };
      return null;
    }
    const plan = this.buildPlan(p, spec, mode, r, shift, free);
    if (!plan) return null;
    if (!plan.ok) return plan.reason ?? 'Нельзя построить';
    const end = this.endAnchor(p, r, shift, free);
    this.game().roadBuilder.apply(plan);
    // Следующая дорога — от конца этой.
    this.start = anchorAt(this.net, end.pos, 3, end.kind === 'free' ? end.level : undefined);
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
    const g = this.game();
    g.roadBuilder.apply(plan);
    // Дома, на которые налезла новая полоса или съезд, отодвигаются.
    for (const id of plan.changed) g.roadWidened(id);
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

  /** Перья полотна, у которого их сейчас видно (и продолжающих его в стыках). */
  handles(): (Handle & { partner: boolean })[] {
    return this.editCorridor !== null ? handlesOf(this.net, this.editCorridor) : [];
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

  /** Взять перо, узел или середину дороги. false — ничего не взяли. hr — радиус попадания в перо. */
  moveDown(p: Vec, r: number, hr = r): boolean {
    this.moveSnap = r;
    this.handle = this.handleAt(p, hr);
    if (this.handle) return true;
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
  movePlan(p: Vec, kink = false): RoadPlan | null {
    const b = this.game().roadBuilder;
    this.hint = null;
    this.joinPos = null;
    if (this.handle) {
      const h = this.handle;
      if (kink) this.hint = 'излом';
      return b.plan((n) => dragHandle(n, h, p, kink));
    }
    if (this.dragNode !== null) {
      const id = this.dragNode;
      const join = this.joinTarget(id, p);
      this.joinPos = join?.pos ?? null;
      if (join) {
        this.hint = 'примкнёт';
        return b.plan((n) => joinDeadEnd(n, id, join));
      }
      const to = alignNode(this.net, id, p, this.moveSnap);
      if (to !== p) this.hint = 'ровно';
      return b.moveNode(id, to);
    }
    if (this.bend !== null) return b.reshape(this.bend, (n, c) => bendCurve(n, c, p));
    return null;
  }

  moveUp(p: Vec, moved: boolean, kink = false): string | null {
    const plan = moved ? this.movePlan(p, kink) : null;
    this.dragNode = null;
    this.bend = null;
    this.handle = null;
    this.hint = null;
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
