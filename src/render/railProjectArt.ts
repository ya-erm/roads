/**
 * Ж/д проекты стройки на карте (режим «Со строительством», src/game/construction.ts):
 * - будущий путь — бледным чертежом: полоса отвода с балластом, шпалы и рельсы полупрозрачно, по оси — пунктир;
 * - готовое — по этапам от начала заполнения (CONSTRUCTION.stages, идут колонной, как у дороги): отсыпка балласта →
 *   шпалы → рельсы, каждый до своего края, шагами CONSTRUCTION.drawStep (плитки кэша карты обновляются по шагу,
 *   railProjectSig);
 * - мост и эстакада проекта — в своём слое (level), тоннель — бледно, как будущий.
 * Технику (те же машины бригады в цвете путейцев) рисует динамический проход кадра. Готовый путь (без Segment.build)
 * рисует обычная отрисовка путей.
 */
import { CONSTRUCTION } from '../config';
import type { Vec } from '../core/vec';
import { spansOf, type Spans } from '../game/constructionWork';
import type { Network, Segment } from '../world/network';
import { halfWidth } from '../world/roadTypes';

/** Готовое по этапам — шагами drawStep (дошедший до конца — весь участок). */
export function railDrawnSpans(s: Segment): Spans {
  const L = s.length;
  const step = CONSTRUCTION.drawStep;
  const sp = spansOf(s.build, L);
  return sp.map((x) => (x >= L - 1e-6 ? L : Math.min(L, Math.floor(x / step) * step))) as Spans;
}

/** Подпись строящегося пути для кэша плиток: форма, готовое по шагам, с какого конца. */
export function railProjectSig(s: Segment): string {
  return `${s.rev}|${railDrawnSpans(s).join(',')}|${s.build?.fromB ? 'b' : 'a'}`;
}

/** Слой пути: 0 — земля (и тоннель), 1 — мост, 2 — эстакада (по верхнему концу). */
export function railProjectLevel(net: Network, s: Segment): number {
  const top = Math.max(net.node(s.a).level, net.node(s.b).level);
  return top <= 0 ? 0 : Math.min(2, Math.round(top));
}

/** Отрезок оси [s0, s1] (метров от конца a) готового этапа, дошедшего на x от начала заполнения. */
function doneRange(s: Segment, x: number): [number, number] | null {
  if (x <= 0.5) return null;
  const L = s.length;
  return s.build?.fromB ? [Math.max(0, L - x), L] : [0, Math.min(L, x)];
}

function stroke(ctx: CanvasRenderingContext2D, pts: readonly Vec[]): void {
  if (pts.length < 2) return;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
}

/** Шпалы участка [s0, s1] оси: поперечины через 4,5 м, как у готового пути. */
function sleepers(ctx: CanvasRenderingContext2D, s: Segment, s0: number, s1: number): void {
  ctx.beginPath();
  for (let at = s0 + 2; at < s1 - 1; at += 4.5) {
    const p = s.lut.pointAt(at);
    const t = s.lut.tangentAt(at);
    ctx.moveTo(p.x - t.y * 4.3, p.y + t.x * 4.3);
    ctx.lineTo(p.x + t.y * 4.3, p.y - t.x * 4.3);
  }
  ctx.stroke();
}

/**
 * Строящиеся пути слоя level (0 — земля и тоннели, 1 — мосты, 2 — эстакады) из списка segs: чертёж и готовое по
 * этапам. zoom — масштаб камеры (шпалы — только вблизи, как у готовых путей).
 */
export function drawRailProjects(ctx: CanvasRenderingContext2D, net: Network, segs: readonly Segment[], zoom: number, level: number): void {
  const list = segs.filter((s) => s.build && railProjectLevel(net, s) === level);
  if (!list.length) return;
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  for (const s of list) {
    const w = halfWidth(s.spec) * 2;
    const L = s.length;
    const axis = s.lut.offsetPolyline(0, 0, L, 3);
    const under = Math.min(net.node(s.a).level, net.node(s.b).level) < -0.4 && Math.max(net.node(s.a).level, net.node(s.b).level) < -0.4;
    // Чертёж: полоса отвода и балласт бледно, ось — пунктиром; в тоннеле — ещё бледнее.
    ctx.globalAlpha = under ? 0.16 : 0.3;
    ctx.strokeStyle = level > 0 ? '#c3c9d0' : '#9c948a';
    ctx.lineWidth = w + 1.5;
    stroke(ctx, axis);
    ctx.globalAlpha = under ? 0.25 : 0.45;
    ctx.strokeStyle = '#4f5965';
    ctx.lineWidth = Math.max(0.8, 0.7 / zoom);
    stroke(ctx, s.lut.offsetPolyline(2.4, 0, L, 3));
    stroke(ctx, s.lut.offsetPolyline(-2.4, 0, L, 3));
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = '#2f6fd0';
    ctx.lineWidth = Math.max(0.8, 1 / zoom);
    stroke(ctx, axis);
    ctx.setLineDash([]);
    ctx.globalAlpha = under ? 0.35 : 1;
    // Готовое по этапам: балласт (у моста — настил), шпалы, рельсы — каждый до своего края.
    const [ballast, ties, rails] = railDrawnSpans(s);
    const b = doneRange(s, ballast);
    if (b) {
      const part = s.lut.offsetPolyline(0, b[0], b[1], 3);
      for (const [color, width] of level > 0
        ? ([
            ['#d3d8de', w + 6],
            ['#bfc5cc', w + 2],
          ] as const)
        : ([
            ['#9c948a', w + 1.5],
            ['#b9b1a6', w - 1],
          ] as const)) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        stroke(ctx, part);
      }
    }
    const t = doneRange(s, ties);
    if (t && zoom >= 0.3) {
      ctx.strokeStyle = '#7a5a3c';
      ctx.lineWidth = 1.5;
      sleepers(ctx, s, t[0], t[1]);
    }
    const r = doneRange(s, rails);
    if (r) {
      ctx.strokeStyle = '#4f5965';
      ctx.lineWidth = Math.max(1.1, 0.8 / zoom);
      stroke(ctx, s.lut.offsetPolyline(2.4, r[0], r[1], 3));
      stroke(ctx, s.lut.offsetPolyline(-2.4, r[0], r[1], 3));
    }
  }
  ctx.restore();
}
