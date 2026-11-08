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
 * Строительный поезд на месте работ (workTrains.ts) на участке seg: у края балласта — думпкар с щебнем, у края шпал —
 * шпалоукладчик со штабелем шпал, у края рельсов — путеукладочный кран с порталом, за ним по уложенному пути (и дальше
 * по готовому пути back) — состав cars с локомотивом сзади. Нос — у своего края, корпус — позади по ходу заполнения
 * (fromB — от конца b). working — стройка идёт: мигает маячок.
 */
export function drawTrackMachines(
  ctx: CanvasRenderingContext2D,
  seg: Segment,
  spans: readonly number[],
  fromB: boolean,
  time: number,
  working: boolean,
  back: Segment | null = null,
  cars: { n: number; len: number; color: string; load: string } | null = null,
): void {
  const L = seg.length;
  const blink = working && Math.floor(time * 3) % 2 === 0;
  const UNITS = [
    { len: 11, body: '#7d756b', top: '#a59a8c' },
    { len: 13, body: '#8a6440', top: '#6e4c2e' },
    { len: 15, body: '#e2622c', top: '#f2b81d' },
  ];
  const start = fromB ? seg.b : seg.a;
  /** Точка и курс (по ходу заполнения) в u метрах от начала участка: дальше назад — по готовому пути back. */
  const at = (u: number): { p: Vec; d: Vec } => {
    if (u >= 0 || !back) {
      const x = Math.max(0, Math.min(L, u));
      const s = fromB ? L - x : x;
      const t = seg.lut.tangentAt(s);
      return { p: seg.lut.pointAt(s), d: fromB ? { x: -t.x, y: -t.y } : t };
    }
    // По back от узла start назад: курс — к узлу.
    const toStart = back.b === start;
    const r = Math.min(back.length, -u);
    const s = toStart ? back.length - r : r;
    const t = back.lut.tangentAt(s);
    return { p: back.lut.pointAt(s), d: toStart ? t : { x: -t.x, y: -t.y } };
  };
  ctx.save();
  // Состав строительного поезда — за путеукладчиком по уложенному пути: вагоны со звеньями пути и балластом, локомотив
  // сзади (толкает). Сам поезд в общем движении при этом не рисуется (WorkTrains.drawnBySite).
  if (cars) {
    const rails = Math.max(0, Math.min(L, spans[2] ?? 0));
    for (let k = cars.n - 1; k >= 0; k--) {
      const nose = rails - UNITS[2].len - 1 - k * cars.len;
      const head = at(nose);
      const tail = at(nose - cars.len + 1.6);
      const mid = { x: (head.p.x + tail.p.x) / 2, y: (head.p.y + tail.p.y) / 2 };
      const ang = Math.atan2(head.p.y - tail.p.y, head.p.x - tail.p.x);
      const loco = k === cars.n - 1;
      ctx.save();
      ctx.translate(mid.x, mid.y);
      ctx.rotate(ang);
      const Lc = cars.len - 1.6;
      ctx.fillStyle = loco ? cars.color : '#5f646b';
      ctx.strokeStyle = '#2b2f35';
      ctx.lineWidth = 0.35;
      ctx.beginPath();
      ctx.roundRect(-Lc / 2, -3.2, Lc, 6.4, 1.2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = loco ? '#f2b81d' : k % 2 ? cars.load : '#8a6440';
      if (loco) ctx.fillRect(Lc / 2 - 3, -2.4, 2, 4.8);
      else ctx.fillRect(-Lc / 2 + 1, -2.4, Lc - 2, 4.8);
      ctx.restore();
    }
  }
  // Сзади вперёд: кран (рельсы) — ближе всех к составу, впереди — шпалы, ещё дальше — балласт.
  for (let k = 2; k >= 0; k--) {
    const x = Math.max(0, Math.min(L, spans[k] ?? 0));
    // Этап ещё не начат — его машина ждёт у начала участка.
    if (x <= 0.5 && k < 2 && (spans[k + 1] ?? 0) <= 0.5) continue;
    if (x >= L - 1e-6 && k === 2) continue;
    const { p, d } = at(x);
    const u = UNITS[k];
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(d.y, d.x));
    const W = 4.6;
    ctx.fillStyle = u.body;
    ctx.strokeStyle = '#3a2a1c';
    ctx.lineWidth = 0.35;
    ctx.beginPath();
    ctx.roundRect(-u.len, -W / 2, u.len, W, 0.8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = u.top;
    if (k === 0) {
      // Думпкар: кузов с щебнем.
      ctx.beginPath();
      ctx.roundRect(-u.len + 1, -W * 0.36, u.len - 2, W * 0.72, 0.6);
      ctx.fill();
    } else if (k === 1) {
      // Платформа со шпалами — поперечные бруски.
      for (let i = 1; i < u.len - 1; i += 1.6) ctx.fillRect(-u.len + i, -W / 2 - 0.4, 0.9, W + 0.8);
    } else {
      // Путеукладчик: портал крана впереди и звено пути, которое он кладёт.
      ctx.fillRect(-3, -W / 2 - 0.8, 1.2, W + 1.6);
      ctx.fillRect(-u.len + 2, -0.5, u.len - 3, 1);
      ctx.strokeStyle = '#4f5965';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(-2, -2.4);
      ctx.lineTo(5, -2.4);
      ctx.moveTo(-2, 2.4);
      ctx.lineTo(5, 2.4);
      ctx.stroke();
    }
    // Маячок на кабине.
    ctx.fillStyle = blink ? '#ff7a1a' : '#b8682c';
    ctx.beginPath();
    ctx.arc(-1.6, 0, 0.8, 0, Math.PI * 2);
    ctx.fill();
    if (blink) {
      ctx.fillStyle = 'rgba(255, 140, 40, 0.28)';
      ctx.beginPath();
      ctx.arc(-1.6, 0, 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
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
