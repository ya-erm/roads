import { dist, Vec } from '../core/vec';
import type { ReshapePlan } from '../game/build';
import type { Game } from '../game/game';
import { bendTrack, dragTrackHandle, moveTrackNode, stationLocked, stationSeg, TrackHandle, trackHandlePoints, trackHandles } from '../game/railEdit';
import type { Network, RoadNode, Segment } from '../world/network';

/**
 * Инструмент «Ж/д → Двигать»: узел пути (стрелку, стык, тупик) тянут мышью — пути следом; перо — угол
 * пути в узле; середину участка — выгнуть. Всё через строитель путей: план показывается как будущие пути
 * (нельзя — красным, с причиной), по отпусканию строится. Узлы станций не двигаются.
 */
export class RailTools {
  /** Узел, который тянут. */
  dragNode: number | null = null;
  /** Участок, который выгибают за середину. */
  bend: number | null = null;
  /** Перо, которое тянут. */
  handle: TrackHandle | null = null;
  /** Участок, у которого видны перья: последний под курсором — они остаются, пока курсор идёт к ним. */
  editSeg: number | null = null;
  /** Подпись у курсора: «только этот путь» (Shift у пера). */
  hint: string | null = null;

  constructor(private readonly game: () => Game) {}

  private get net(): Network {
    return this.game().net;
  }

  /** Тянут узел, перо или середину пути. */
  get dragging(): boolean {
    return this.dragNode !== null || this.bend !== null || this.handle !== null;
  }

  /** Сменили инструмент — всё начатое забываем. */
  clear(): void {
    this.dragNode = null;
    this.bend = null;
    this.handle = null;
    this.editSeg = null;
    this.hint = null;
  }

  /** Esc или правая кнопка: бросить то, что тянут. true — было что отменять. */
  cancel(): boolean {
    if (!this.dragging) return false;
    this.dragNode = null;
    this.bend = null;
    this.handle = null;
    this.hint = null;
    return true;
  }

  /** Узел у курсора (стрелка, стык, тупик), кроме узлов станций и их горловин. */
  nodeAt(p: Vec, r: number): RoadNode | null {
    const net = this.net;
    return (
      net
        .nodesNear(p, r)
        .filter((n) => n.segments.length > 0 && !stationLocked(net, n.id))
        .sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0] ?? null
    );
  }

  /** Участок под курсором, который можно выгнуть (не платформа и не съезд станции). */
  segAt(p: Vec, r: number): Segment | null {
    const s = this.game().builder.pickSegment(p, r);
    return s && !stationSeg(this.net, s) ? s : null;
  }

  /** Перья участка, у которого их сейчас видно (и путей, поворачивающих вместе с ним). */
  handles(): (TrackHandle & { partner: boolean })[] {
    if (this.editSeg !== null && !this.net.segments.has(this.editSeg)) this.editSeg = null;
    return this.editSeg !== null ? trackHandles(this.net, this.editSeg) : [];
  }

  /** Перо под курсором; r — радиус попадания. */
  handleAt(p: Vec, r: number): TrackHandle | null {
    let best: TrackHandle | null = null;
    let bestD = r;
    for (const h of this.handles()) {
      const d = dist(p, trackHandlePoints(this.net.segment(h.seg), h.end).pos);
      if (d <= bestD) {
        bestD = d;
        best = { seg: h.seg, end: h.end };
      }
    }
    return best;
  }

  /** Перья для подсказки на карте; plan — правка, если перо тянут (перья — в новой форме). */
  handleMarks(active: TrackHandle | null, plan?: ReshapePlan | null): { anchor: Vec; pos: Vec; active: boolean; partner: boolean }[] {
    return this.handles().map((h) => ({
      ...trackHandlePoints({ curve: plan?.curves.get(h.seg) ?? this.net.segment(h.seg).curve }, h.end),
      active: !!active && active.seg === h.seg && active.end === h.end,
      partner: h.partner,
    }));
  }

  /** Узлы на концах участка с перьями, которые можно тянуть, — кружками: видно, за что браться. */
  nodeMarks(): Vec[] {
    const s = this.editSeg !== null ? this.net.segments.get(this.editSeg) : undefined;
    if (!s) return [];
    return [...new Set([s.a, s.b])].filter((id) => !stationLocked(this.net, id)).map((id) => this.net.node(id).pos);
  }

  /** Взять перо, узел или середину пути. false — ничего не взяли. hr — радиус попадания в перо. */
  moveDown(p: Vec, r: number, hr = r): boolean {
    this.handle = this.handleAt(p, hr);
    if (this.handle) return true;
    const n = this.nodeAt(p, r);
    if (n) {
      this.dragNode = n.id;
      return true;
    }
    const s = this.segAt(p, r * 0.3);
    if (s) {
      this.bend = s.id;
      this.editSeg = s.id;
      return true;
    }
    return false;
  }

  /** План правки; only — перо поворачивает только свой путь (Shift), а не весь узел. */
  movePlan(p: Vec, only = false): ReshapePlan | null {
    const net = this.net;
    const b = this.game().builder;
    this.hint = null;
    if (this.handle) {
      if (!net.segments.has(this.handle.seg)) return null;
      if (only) this.hint = 'только этот путь';
      const e = dragTrackHandle(net, this.handle, p, only);
      return e && b.reshape(e);
    }
    if (this.dragNode !== null) {
      if (!net.nodes.has(this.dragNode)) return null;
      return b.reshape(moveTrackNode(net, this.dragNode, p));
    }
    if (this.bend !== null) {
      const e = net.segments.has(this.bend) ? bendTrack(net, this.bend, p) : null;
      return e && b.reshape(e);
    }
    return null;
  }

  /** Отпустили: перестраиваем. null — получилось (или нечего), иначе причина. */
  moveUp(p: Vec, moved: boolean, only = false): string | null {
    const plan = moved ? this.movePlan(p, only) : null;
    this.dragNode = null;
    this.bend = null;
    this.handle = null;
    this.hint = null;
    if (!plan) return null;
    if (!plan.ok) return plan.reason ?? 'Нельзя передвинуть';
    this.game().builder.applyReshape(plan);
    return null;
  }
}
