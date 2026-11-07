import type { Vec } from '../core/vec';
import { trackProfile } from '../game/build';
import type { GroundProfile } from '../game/grade';
import { corridorProfile } from '../game/roadbuild';
import type { Corridor, LaneNet } from '../lanes/model';
import type { Network, Segment } from '../world/network';
import { halfWidth } from '../world/roadTypes';
import { halfAtS } from '../world/worldgen';

/** Глубже этого насыпь или выемка видна штрихами. */
const MIN_DEPTH = 0.7;
/** Откос 1 : 2 — ширина откоса в плане на метр высоты, и не шире MAX_SLOPE. */
const SLOPE_RUN = 2;
const MAX_SLOPE = 16;

/** Штрихи откосов полотна: отрезки x0,y0,x1,y1 подряд — отдельно насыпи и выемки. */
interface Ticks {
  key: string;
  fill: Float32Array;
  cut: Float32Array;
}

function ticksOf(prof: GroundProfile & { ds: number }, at: (s: number) => { p: Vec; t: Vec; half: number }): Omit<Ticks, 'key'> {
  const fill: number[] = [];
  const cut: number[] = [];
  for (let i = 1; i < prof.z.length - 1; i++) {
    const h = prof.h[i];
    if (Number.isNaN(h)) continue;
    const d = prof.z[i] - h;
    if (Math.abs(d) < MIN_DEPTH) continue;
    const { p, t, half } = at(i * prof.ds);
    const w = Math.min(MAX_SLOPE, Math.abs(d) * SLOPE_RUN) + 1.5;
    const out = d > 0 ? fill : cut;
    for (const side of [1, -1]) {
      const nx = -t.y * side;
      const ny = t.x * side;
      out.push(p.x + nx * half, p.y + ny * half, p.x + nx * (half + w), p.y + ny * (half + w));
    }
  }
  return { fill: Float32Array.from(fill), cut: Float32Array.from(cut) };
}

const curveKey = (c: { curve: { p0: Vec; p1: Vec; p2: Vec; p3: Vec } }, extra: string) => {
  const { p0, p1, p2, p3 } = c.curve;
  return `${p0.x},${p0.y},${p1.x},${p1.y},${p2.x},${p2.y},${p3.x},${p3.y},${extra}`;
};

/**
 * Откосы насыпей и выемок у дорог и путей на земле: полотно сглаживает рельеф вдоль оси, и где оно
 * выше или ниже земли — видно штрихами поперёк откоса (как на топокартах). Считаются по профилю один раз
 * на форму полотна.
 */
export class EarthworkCache {
  private roads = new Map<number, Ticks>();
  private rails = new Map<number, Ticks>();

  reset(): void {
    this.roads.clear();
    this.rails.clear();
  }

  /** Версия рельефа: правка кистью меняет землю под полотнами — штрихи считаем заново. */
  private version = 0;

  private road(net: LaneNet, c: Corridor, ground: (p: Vec) => number): Ticks {
    const key = curveKey(c, `${net.node(c.a).level}:${net.node(c.b).level}:${c.rev}:${this.version}`);
    let t = this.roads.get(c.id);
    if (t?.key !== key) {
      const prof = corridorProfile(net, c, ground);
      const ticks = prof ? ticksOf(prof, (s) => ({ p: c.lut.pointAt(s), t: c.lut.tangentAt(s), half: halfAtS(c, s) })) : { fill: new Float32Array(), cut: new Float32Array() };
      t = { key, ...ticks };
      this.roads.set(c.id, t);
    }
    return t;
  }

  private rail(net: Network, s: Segment, ground: (p: Vec) => number): Ticks {
    const la = net.node(s.a).level;
    const lb = net.node(s.b).level;
    const key = curveKey(s, `${la}:${lb}:${this.version}`);
    let t = this.rails.get(s.id);
    if (t?.key !== key) {
      const prof = trackProfile(s.lut, la, lb, ground);
      const half = halfWidth(s.spec);
      const ticks = prof ? ticksOf(prof, (at) => ({ p: s.lut.pointAt(at), t: s.lut.tangentAt(at), half })) : { fill: new Float32Array(), cut: new Float32Array() };
      t = { key, ...ticks };
      this.rails.set(s.id, t);
    }
    return t;
  }

  /** Штрихи откосов в рамке view; only — из дорог только эти полотна (например, проекты стройки). */
  draw(
    ctx: CanvasRenderingContext2D,
    ground: ((p: Vec) => number) | null,
    roads: LaneNet,
    rails: Network,
    segs: Segment[],
    view: { x0: number; y0: number; x1: number; y1: number },
    zoom: number,
    version: number,
    only?: (c: Corridor) => boolean,
  ): void {
    if (!ground || zoom < 0.3) return;
    this.version = version;
    // Предпросмотры оставляют в кэше чужие формы — время от времени чистим.
    if (this.roads.size > roads.corridors.size + 500) this.roads.clear();
    if (this.rails.size > rails.segments.size + 500) this.rails.clear();
    const all: Ticks[] = [];
    for (const c of roads.corridorsInBox(view.x0, view.y0, view.x1, view.y1)) if (!only || only(c)) all.push(this.road(roads, c, ground));
    for (const s of segs) if (s.platform === undefined) all.push(this.rail(rails, s, ground));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.2, 1.6 / zoom);
    for (const [kind, color] of [
      ['fill', 'rgba(126, 92, 48, 0.8)'],
      ['cut', 'rgba(84, 90, 100, 0.75)'],
    ] as const) {
      ctx.beginPath();
      for (const t of all) {
        const a = t[kind];
        for (let i = 0; i < a.length; i += 4) {
          ctx.moveTo(a[i], a[i + 1]);
          ctx.lineTo(a[i + 2], a[i + 3]);
        }
      }
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    ctx.restore();
  }
}
