import type { Vec } from '../core/vec';
import { ROAD_MARGIN, RoadClass } from '../world/roadTypes';
import {
  Anchor,
  anchorAt,
  applyLane,
  buildRoad,
  bulldoze,
  corridorUnder,
  dragLane,
  edgeAt,
  flipLane,
  LaneDraft,
  laneUnder,
  removeLane,
  startLane,
  toggleSolid,
} from './edit';
import { edgesAt, laneBand, pointOff, stations } from './geometry';
import { Corridor, LaneNet, LaneNetSave, LaneSlot, oneWay, twoWay } from './model';

export type LabTool = 'view' | 'road' | 'lane' | 'select' | 'rebuild' | 'move' | 'bulldoze';

export interface Profile {
  id: string;
  name: string;
  cls: RoadClass;
  lanes: () => LaneSlot[];
}

/** Готовые профили для «Дороги» и «Перестроить» — как прежние типы дорог. */
export const PROFILES: Profile[] = [
  { id: 'street', name: 'Улица 1+1', cls: 'street', lanes: () => twoWay(1, 1) },
  { id: 'avenue', name: 'Проспект 2+2', cls: 'avenue', lanes: () => twoWay(2, 2) },
  { id: 'highway', name: 'Магистраль 2+2', cls: 'highway', lanes: () => twoWay(2, 2) },
  { id: 'motorway', name: 'Автомагистраль 2‖2', cls: 'motorway', lanes: () => twoWay(2, 2, 4) },
  { id: 'oneway', name: 'Односторонняя', cls: 'street', lanes: () => oneWay(1) },
  { id: 'oneway2', name: 'Односторонняя 2', cls: 'avenue', lanes: () => oneWay(2) },
  { id: 'ramp', name: 'Съезд', cls: 'highway', lanes: () => oneWay(1) },
];

/**
 * Редактор сети полос в лаборатории. Любое действие сначала показывается на копии сети
 * (предпросмотр), по клику копия становится сетью; Ctrl+Z возвращает прежнюю.
 */
export class LabEditor {
  tool: LabTool = 'view';
  profile = PROFILES[2];
  /** Дорога дугой: второй клик — точка изгиба. */
  curved = false;
  /** Сеть с действием, которое сейчас покажем (ещё не построено). */
  preview: LaneNet | null = null;
  /** Почему так нельзя или что сломается. */
  problem: string | null = null;
  selected: { corridor: number; lane: number } | null = null;
  hover: Vec | null = null;
  private undoStack: LaneNetSave[] = [];
  private road: { start: Anchor; control: Vec | null } | null = null;
  private lane: LaneDraft | null = null;
  private moving: number | null = null;

  constructor(
    public net: LaneNet,
    private readonly changed: (net: LaneNet) => void,
    /** Радиус привязки в мире (зависит от масштаба). */
    private readonly radius: () => number,
  ) {}

  get shown(): LaneNet {
    return this.preview ?? this.net;
  }

  setTool(t: LabTool): void {
    this.tool = t;
    this.cancel();
  }

  cancel(): void {
    this.road = null;
    this.lane = null;
    this.moving = null;
    this.preview = null;
    this.problem = null;
  }

  /** Идёт ли действие, которое Esc отменит. */
  get busy(): boolean {
    return !!(this.road || this.lane || this.moving !== null);
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.net = LaneNet.fromJSON(prev);
    this.cancel();
    this.selected = null;
    this.changed(this.net);
    return true;
  }

  clear(): void {
    this.commit((n) => {
      for (const id of [...n.corridors.keys()]) n.removeCorridor(id);
    });
    this.selected = null;
  }

  /** Правка выбранной полосы из панели. */
  laneAction(action: 'flip' | 'remove' | 'solid' | 'solidLeft' | 'bulldoze'): void {
    const sel = this.selected;
    if (!sel) return;
    this.commit((n) => {
      const c = n.corridors.get(sel.corridor);
      if (!c) return false;
      if (action === 'flip') flipLane(n, c, sel.lane);
      else if (action === 'remove') removeLane(n, c, sel.lane);
      else if (action === 'bulldoze') bulldoze(n, c.id);
      else {
        // Линия справа (по оси) — у самой полосы, слева — у соседа с меньшим смещением.
        const me = c.lanes[sel.lane];
        const left = c.lanes.findIndex((l) => Math.abs(l.offset - (me.offset - 7)) < 0.5);
        if (action === 'solid') toggleSolid(n, c, sel.lane);
        else if (left >= 0) toggleSolid(n, c, left);
        else return false;
      }
    });
    if (action === 'remove' || action === 'bulldoze') this.selected = null;
  }

  // ---------- Мышь ----------

  /** Нажатие левой кнопкой. false — инструмент не занят, лаборатория двигает камеру. */
  down(p: Vec): boolean {
    const r = this.radius();
    switch (this.tool) {
      case 'road': {
        if (!this.road) {
          this.road = { start: anchorAt(this.net, p, r), control: null };
          return true;
        }
        if (this.curved && !this.road.control) {
          this.road.control = { ...p };
          return true;
        }
        const { start, control } = this.road;
        const built = this.commit((n) => buildRoad(n, start, anchorAt(n, p, r), this.roadOptions(control)).length > 0);
        // Следующая дорога — от конца этой.
        this.road = built ? { start: anchorAt(this.net, p, r), control: null } : this.road;
        return true;
      }
      case 'lane':
        this.lane = startLane(this.net, p, r);
        return true;
      case 'select': {
        const hit = laneUnder(this.net, p);
        this.selected = hit ? { corridor: hit.corridor.id, lane: hit.lane } : null;
        return !!hit;
      }
      case 'bulldoze': {
        const c = corridorUnder(this.net, p);
        if (c) this.commit((n) => bulldoze(n, c.id));
        return !!c;
      }
      case 'rebuild': {
        const c = corridorUnder(this.net, p);
        if (c) {
          this.commit((n) => {
            const cc = n.corridor(c.id);
            cc.cls = this.profile.cls;
            n.setLanes(cc, this.profile.lanes());
          });
        }
        return !!c;
      }
      case 'move': {
        const node = this.nodeNear(p);
        this.moving = node;
        return node !== null;
      }
      default:
        return false;
    }
  }

  move(p: Vec): void {
    this.hover = p;
    const r = this.radius();
    if (this.tool === 'road' && this.road) {
      const { start, control } = this.road;
      // Дуга без точки изгиба — пока прямая к курсору.
      this.previewOf((n) => buildRoad(n, start, anchorAt(n, p, r), this.roadOptions(control)).length > 0);
    } else if (this.tool === 'lane' && this.lane) {
      this.lane = dragLane(this.net, this.lane, p, r);
      const draft = this.lane;
      this.previewOf((n) => applyLane(n, draft, this.laneClass(draft)));
    } else if (this.tool === 'move' && this.moving !== null) {
      const id = this.moving;
      this.previewOf((n) => n.moveNode(id, p));
    }
  }

  up(p: Vec): void {
    if (this.tool === 'lane' && this.lane) {
      const draft = this.dragged(p);
      this.commit((n) => applyLane(n, draft, this.laneClass(draft)));
      this.lane = null;
    } else if (this.tool === 'move' && this.moving !== null) {
      const id = this.moving;
      this.commit((n) => n.moveNode(id, p));
      this.moving = null;
    }
  }

  private dragged(p: Vec): LaneDraft {
    return dragLane(this.net, this.lane!, p, this.radius());
  }

  private roadOptions(control: Vec | null) {
    return { cls: this.profile.cls, lanes: this.profile.lanes(), control: control ?? undefined };
  }

  /** Полоса вдоль полотна — его класса, в чистом поле — выбранного профиля. */
  private laneClass(d: LaneDraft): RoadClass {
    return (d.host && this.net.corridors.get(d.host.corridor)?.cls) || this.profile.cls;
  }

  private nodeNear(p: Vec): number | null {
    let best: number | null = null;
    let bestD = this.radius();
    for (const n of this.net.nodes.values()) {
      const d = Math.hypot(n.pos.x - p.x, n.pos.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  }

  // ---------- Правки ----------

  /** Применяет правку к копии сети; удалась — копия становится сетью, прежняя — в отмену. */
  private commit(edit: (net: LaneNet) => boolean | void): boolean {
    const next = this.net.clone();
    try {
      if (edit(next) === false) return false;
    } catch {
      return false;
    }
    this.undoStack.push(this.net.toJSON());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.net = next;
    this.preview = null;
    this.problem = null;
    this.changed(next);
    return true;
  }

  /** Предпросмотр: то же действие на копии сети, и что в ней не так. */
  private previewOf(edit: (net: LaneNet) => boolean | void): void {
    const next = this.net.clone();
    let ok: boolean;
    try {
      ok = edit(next) !== false;
    } catch {
      ok = false;
    }
    this.preview = ok ? next : null;
    const problems = ok ? next.problems() : [];
    this.problem = !ok ? 'Так не построить' : problems.length ? problems[0] : null;
  }

  // ---------- Подсказки на карте ----------

  draw(ctx: CanvasRenderingContext2D, zoom: number): void {
    const p = this.hover;
    const net = this.shown;
    ctx.lineJoin = 'round';
    if (this.selected) {
      const c = net.corridors.get(this.selected.corridor);
      if (c && c.lanes[this.selected.lane]) this.fillPoly(ctx, lanePoly(c, this.selected.lane), 'rgba(47,128,237,0.45)');
    }
    if (!p) return;
    switch (this.tool) {
      case 'select': {
        const hit = laneUnder(net, p);
        if (hit) this.fillPoly(ctx, lanePoly(hit.corridor, hit.lane), 'rgba(47,128,237,0.25)');
        break;
      }
      case 'bulldoze':
      case 'rebuild': {
        const c = corridorUnder(net, p);
        if (c) this.fillPoly(ctx, corridorPoly(c), this.tool === 'bulldoze' ? 'rgba(232,72,63,0.45)' : 'rgba(39,174,96,0.4)');
        break;
      }
      case 'move': {
        for (const n of this.net.nodes.values()) this.ring(ctx, n.pos, 4 / zoom, n.id === this.nodeNear(p) ? '#2f80ed' : 'rgba(47,128,237,0.5)', zoom);
        break;
      }
      case 'road': {
        const a = this.road ? null : anchorAt(this.net, p, this.radius());
        if (a) this.ring(ctx, a.pos, (a.kind === 'free' ? 3 : 7) / zoom, '#2f80ed', zoom);
        if (this.road?.control) this.ring(ctx, this.road.control, 4 / zoom, '#f2994a', zoom);
        break;
      }
      case 'lane': {
        if (this.lane) break;
        const e = edgeAt(this.net, p);
        if (e) this.ring(ctx, e.pos, 5 / zoom, '#27ae60', zoom);
        break;
      }
    }
  }

  private fillPoly(ctx: CanvasRenderingContext2D, pts: Vec[], color: string): void {
    if (pts.length < 3) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.fill();
  }

  private ring(ctx: CanvasRenderingContext2D, p: Vec, r: number, color: string, zoom: number): void {
    ctx.strokeStyle = color;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2 / zoom;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/** Контур асфальта полотна. */
function corridorPoly(c: Corridor): Vec[] {
  const ss = stations(c, 0, c.length, 4);
  const left: Vec[] = [];
  const right: Vec[] = [];
  for (const s of ss) {
    const e = edgesAt(c, s);
    if (!e) continue;
    left.push(pointOff(c, s, e[0] - ROAD_MARGIN));
    right.push(pointOff(c, s, e[1] + ROAD_MARGIN));
  }
  return [...left, ...right.reverse()];
}

/** Контур полосы (там, где она есть, с отгонами). */
function lanePoly(c: Corridor, i: number): Vec[] {
  const l = c.lanes[i];
  const left: Vec[] = [];
  const right: Vec[] = [];
  for (const s of stations(c, 0, c.length, 4)) {
    const b = laneBand(c, l, s);
    if (!b) continue;
    left.push(pointOff(c, s, b[0]));
    right.push(pointOff(c, s, b[1]));
  }
  return [...left, ...right.reverse()];
}
