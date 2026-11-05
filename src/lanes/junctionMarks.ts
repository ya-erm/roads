import { add, angleDiff, angleOf, dist, dot, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { LANE_W } from '../world/roadTypes';
import { edgePoint } from './geometry';
import type { LaneGraph } from './graph';
import { LaneNet, LaneNode } from './model';
import { localGraph } from './preview';

/**
 * Разметка на площадке большого перекрёстка (настройка `junctionMarks`, «Меню → Настройки»): штриховка асфальта, по которому не ездят
 * (островки 1.16), и направляющие пунктиры (1.7) — только там, где без них путаются: продолжение попутных полос через
 * длинный или косой перекрёсток, между двумя и более левыми поворотами из одного подъезда и по внешней кромке
 * длинного левого, который пересекается со встречным левым. Правые повороты ведёт бордюр — без пунктира. На
 * маленьких перекрёстках (улица 1+1 на улицу 1+1) — ничего.
 */
export interface JunctionMarks {
  /** Контуры островков (замкнутые ломаные; дырки — тоже контуры: штриховать чётно-нечётно). */
  islands: Vec[][];
  /** Направление штрихов (единичное). */
  hatch: Vec;
  /** Линии по площадке — ломаными (пунктир нарезает отрисовка). */
  guides: Guide[];
}

/** Линия разметки по площадке: пунктир 1.7 (направляющая) или сплошная (потоки разведены — перестраиваться нельзя). */
export interface Guide {
  pts: Vec[];
  solid: boolean;
}

/** Перекрёсток с размахом между стоп-линиями от этого, м, — уже большой (и с одной полосой в сторону). */
export const MARKS_MIN_SPAN = 60;
/** Прямой проезд длиннее этого, м, — «длинный»: полосы продолжаются пунктиром. */
export const LONG_STRAIGHT = 25;
/** Левый поворот длиннее этого, м, — «длинный» (на компактном кресте 2+2 × 2+2 левые — 40–46 м: им кромка не нужна). */
export const LONG_LEFT = 50;
/** Острый угол между соседними подъездами меньше этого — перекрёсток косой. */
export const SKEW_ANGLE = 1.13;

/** Полос в одну сторону у полотна — больше из двух направлений. */
function lanesPerSide(lanes: { flow: number }[]): number {
  const f = lanes.filter((l) => l.flow > 0).length;
  return Math.max(f, lanes.length - f);
}

/**
 * Нужна ли перекрёстку разметка: от трёх подъездов, не кольцо, и большой — где-то две полосы в одну сторону или
 * размах между стоп-линиями (два самых дальних обреза) от MARKS_MIN_SPAN. cuts — обрезы подъездов по порядку net.ends(n).
 */
export function wantsMarks(net: LaneNet, n: LaneNode, cuts: number[]): boolean {
  if (n.kind !== 'junction' || (n.roundabout ?? null) !== null) return false;
  const ends = net.ends(n);
  if (ends.length < 3 || ends.some((e) => e.corridor.ring)) return false;
  if (ends.some((e) => lanesPerSide(e.corridor.lanes) >= 2)) return true;
  const top = [...cuts].sort((a, b) => b - a);
  return (top[0] ?? 0) + (top[1] ?? 0) >= MARKS_MIN_SPAN;
}

/** Косой перекрёсток: какие-то соседние подъезды сходятся под острым углом. */
export function isSkewed(net: LaneNet, n: LaneNode): boolean {
  const angles = net
    .ends(n)
    .map((e) => angleOf(e.away))
    .sort((a, b) => a - b);
  return angles.some((a, i) => {
    const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + Math.PI * 2;
    return next - a < SKEW_ANGLE;
  });
}

export type TurnKind = 'straight' | 'left' | 'right' | 'uturn';

/** Траектория манёвра в перекрёстке для разметки. */
export interface TurnPath {
  inLink: number;
  /** Номер полосы въезда и выезда слева направо по ходу. */
  inIndex: number;
  outLink: number;
  outIndex: number;
  kind: TurnKind;
  /** Угол поворота, рад: больше нуля — направо (ось y вниз). */
  theta: number;
  points: Vec[];
  length: number;
  dirIn: Vec;
  /** Номера (в том же списке) траекторий, с которыми пересекается. */
  crosses: number[];
}

/** Поворот круче этого, рад, — уже не поворот, а «с ветки на соседнюю ветку» (Y, развилка): линий у него нет. */
export const SHARP_TURN = 2.2;

/** Манёвры перекрёстка node графа g: куда (прямо — самый прямой выезд подъезда, как у стрелок), полосы, пересечения. */
export function turnPaths(g: LaneGraph, node: number): TurnPath[] {
  const moves = [...g.moves.values()].filter((m) => m.node === node && !m.cont);
  const theta = (m: (typeof moves)[number]) => angleDiff(angleOf(m.dirIn), angleOf(m.dirOut));
  const straight = new Map<number, number>();
  for (const m of moves) {
    const t = Math.abs(theta(m));
    const inC = g.links.get(m.inLink)?.corridor;
    if (t > 0.6 || g.links.get(m.outLink)?.corridor === inC) continue;
    const best = straight.get(m.inLink);
    const bt = best === undefined ? Infinity : Math.abs(theta(moves.find((x) => x.inLink === m.inLink && x.outLink === best)!));
    if (t < bt) straight.set(m.inLink, m.outLink);
  }
  const index = new Map(moves.map((m, i) => [m.key, i]));
  return moves.map((m) => {
    const t = theta(m);
    const uturn = Math.abs(t) > 2.6 || g.links.get(m.outLink)?.corridor === g.links.get(m.inLink)?.corridor;
    const kind: TurnKind = uturn ? 'uturn' : straight.get(m.inLink) === m.outLink ? 'straight' : t > 0 ? 'right' : 'left';
    const crosses = [...m.conflicts].filter(([, k]) => k === 'cross').map(([key]) => index.get(key)).filter((i): i is number => i !== undefined);
    return {
      inLink: m.inLink,
      inIndex: g.lanes.get(m.inLane)?.index ?? 0,
      outLink: m.outLink,
      outIndex: g.lanes.get(m.outLane)?.index ?? 0,
      kind,
      theta: t,
      points: m.points,
      length: m.length,
      dirIn: m.dirIn,
      crosses,
    };
  });
}

/** Ломаная, переразбитая на n равных по длине кусков (n + 1 точка). */
export function resample(pts: Vec[], n: number): Vec[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const L = cum[cum.length - 1];
  const out: Vec[] = [];
  let j = 1;
  for (let k = 0; k <= n; k++) {
    const u = (L * k) / n;
    while (j < pts.length - 1 && cum[j] < u) j++;
    const seg = cum[j] - cum[j - 1] || 1;
    const f = Math.max(0, Math.min(1, (u - cum[j - 1]) / seg));
    out.push({ x: pts[j - 1].x + (pts[j].x - pts[j - 1].x) * f, y: pts[j - 1].y + (pts[j].y - pts[j - 1].y) * f });
  }
  return out;
}

/** Ломаная, сдвинутая вправо по ходу на d. */
function offsetRight(pts: Vec[], d: number): Vec[] {
  return pts.map((p, i) => {
    const t = norm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]));
    return add(p, scale(rightNormal(t), d));
  });
}

/** Соседние по полосам пары траекторий одного подъезда в один выезд: въезд и выезд — соседние полосы. */
function neighbours(paths: TurnPath[]): [TurnPath, TurnPath][] {
  const res: [TurnPath, TurnPath][] = [];
  const groups = new Map<string, TurnPath[]>();
  for (const p of paths) {
    const k = `${p.inLink}>${p.outLink}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.inIndex - b.inIndex || a.outIndex - b.outIndex);
    for (let i = 0; i + 1 < list.length; i++) {
      const [a, b] = [list[i], list[i + 1]];
      // Соседние полосы в соседние или одна полоса в две (развилка).
      const step = b.inIndex - a.inIndex;
      if ((step === 1 || step === 0) && Math.abs(b.outIndex - a.outIndex) === 1) res.push([a, b]);
    }
  }
  return res;
}

/**
 * Линии по площадке: (а) границы попутных полос на прямом проезде, если он длинный или перекрёсток косой, — пунктир;
 * (б) между параллельными потоками одного подъезда — поворот налево или направо двумя полосами, развилка одной полосы
 * в две: сплошная, если её не пересекает ни один другой поток (потоки разведены), иначе пунктир; от места, где потоки
 * разошлись почти на ширину полосы, до места, где снова сходятся (`divider`); (в) внешняя кромка длинного левого
 * поворота (крайнего правого из левых своего подъезда), если он пересекается со встречным левым, — пунктир.
 * Поворот круче SHARP_TURN — с ветки на соседнюю ветку (Y, развилка) — линий не получает.
 */
export function guideLines(paths: TurnPath[], o: { skew: boolean }): Guide[] {
  const res: Guide[] = [];
  for (const [a, b] of neighbours(paths.filter((p) => p.kind === 'straight'))) {
    const pts = o.skew || Math.max(a.length, b.length) > LONG_STRAIGHT ? divider(a.points, b.points) : null;
    if (pts) res.push({ pts, solid: false });
  }
  // Параллельные потоки одного подъезда (налево, направо, развилка одной полосы в две) — линия между ними: сплошная,
  // если её не пересекает ни один другой поток (потоки разведены), иначе пунктир.
  const turns = paths.filter((p) => (p.kind === 'left' || p.kind === 'right') && Math.abs(p.theta) <= SHARP_TURN);
  for (const [a, b] of neighbours(turns)) {
    const pts = divider(a.points, b.points);
    if (!pts) continue;
    const crossed = paths.some((p) => p !== a && p !== b && polylinesCross(pts, p.points));
    res.push({ pts, solid: !crossed });
  }
  const lefts = turns.filter((p) => p.kind === 'left');
  // Крайний правый из левых своего подъезда: правее полоса въезда, при равной — правее полоса выезда (веер с одной полосы).
  const byIn = new Map<number, TurnPath>();
  for (const p of lefts) {
    const q = byIn.get(p.inLink);
    if (!q || p.inIndex > q.inIndex || (p.inIndex === q.inIndex && p.outIndex > q.outIndex)) byIn.set(p.inLink, p);
  }
  for (const p of byIn.values()) {
    if (p.length <= LONG_LEFT) continue;
    const opposing = p.crosses.some((i) => {
      const q = paths[i];
      return !!q && q.kind === 'left' && Math.abs(q.theta) <= SHARP_TURN && q.inLink !== p.inLink && dot(q.dirIn, p.dirIn) < -0.7;
    });
    if (opposing) res.push({ pts: offsetRight(resample(p.points, 24), LANE_W / 2), solid: false });
  }
  return res;
}

/**
 * Линия между двумя соседними траекториями (граница их полос): с места, где они разошлись хотя бы почти на ширину
 * полосы (из одной полосы в две — не от самой стоп-линии), до места, где снова сходятся. null — так и не разошлись.
 */
export function divider(a: Vec[], b: Vec[]): Vec[] | null {
  const ra = resample(a, 24);
  const rb = resample(b, 24);
  const apart = ra.map((p, i) => dist(p, rb[i]) >= LANE_W - 0.5);
  const i0 = apart.indexOf(true);
  const i1 = apart.lastIndexOf(true);
  if (i0 < 0 || i1 - i0 < 2) return null;
  const mid = ra.slice(i0, i1 + 1).map((p, k) => scale(add(p, rb[i0 + k]), 0.5));
  // Короче MIN_DIVIDER — «крючок» у самого выезда (развилка разошлась только к концу): не рисуем.
  let len = 0;
  for (let i = 1; i < mid.length; i++) len += dist(mid[i - 1], mid[i]);
  return len >= MIN_DIVIDER ? mid : null;
}

/** Линия между потоками короче этого, м, не нужна (развилка одной полосы в две, разошедшаяся только у выезда). */
export const MIN_DIVIDER = 15;

/** Пересекаются ли ломаные (хоть одна пара отрезков — крест-накрест). */
export function polylinesCross(a: Vec[], b: Vec[]): boolean {
  const side = (p: Vec, q: Vec, r: Vec) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  for (let i = 1; i < a.length; i++) {
    for (let j = 1; j < b.length; j++) {
      const [p, q, r, s] = [a[i - 1], a[i], b[j - 1], b[j]];
      if (side(p, q, r) * side(p, q, s) < 0 && side(r, s, p) * side(r, s, q) < 0) return true;
    }
  }
  return false;
}

export interface IslandOptions {
  /** Шаг сетки, м. */
  cell?: number;
  /** Не ближе этого к оси траектории, м (полполосы и запас). */
  clear?: number;
  /** Отступ от бордюра площадки, м. */
  curb?: number;
  /** Островки меньше этой площади, м², не штрихуем. */
  minArea?: number;
  /** …и уже этого везде, м (рваные полоски). */
  minWidth?: number;
}

/** Расстояние от точки до отрезка. */
function segDist(px: number, py: number, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - a.x - dx * t, py - a.y - dy * t);
}

/**
 * Асфальт площадки, по которому не ездят: внутри контура plate, дальше clear от всех траекторий paths и дальше curb
 * от бордюра; островки меньше minArea или уже minWidth отброшены. Считается на сетке (поле «запаса»: насколько точка
 * дальше нужного от траекторий и бордюра), контуры — изолиния нуля (marching squares) с интерполяцией.
 */
export function freeIslands(plate: Vec[], paths: Vec[][], o: IslandOptions = {}): Vec[][] {
  const clear = o.clear ?? LANE_W / 2 + 0.5;
  const curb = o.curb ?? 0.8;
  // Узкие «линзы» у скруглённых углов (~3 × 12 м) — не островки, а обрывки: порог выше их.
  const minArea = o.minArea ?? 40;
  const minWidth = o.minWidth ?? 2.5;
  if (plate.length < 3) return [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of plate) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  // Сетка не больше ~250 тыс. точек: у огромной площадки шаг крупнее.
  const h = Math.max(o.cell ?? 1, Math.sqrt(((x1 - x0) * (y1 - y0)) / 250_000));
  x0 -= 2 * h;
  y0 -= 2 * h;
  const nx = Math.ceil((x1 + 2 * h - x0) / h) + 1;
  const ny = Math.ceil((y1 + 2 * h - y0) / h) + 1;
  const N = nx * ny;
  const cap = clear + curb + minWidth + 2;
  // Внутри контура — построчно, чётно-нечётно.
  const inside = new Uint8Array(N);
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * h;
    const xs: number[] = [];
    for (let k = 0; k < plate.length; k++) {
      const a = plate[k];
      const b = plate[(k + 1) % plate.length];
      if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let i = Math.max(0, Math.ceil((xs[k] - x0) / h)); i <= Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / h)); i++) inside[j * nx + i] = 1;
    }
  }
  // Расстояния до бордюра и до траекторий — только вблизи (дальше cap — неважно насколько).
  const stamp = (field: Float32Array, a: Vec, b: Vec) => {
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - cap - x0) / h));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + cap - x0) / h));
    const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - cap - y0) / h));
    const j1 = Math.min(ny - 1, Math.ceil((Math.max(a.y, b.y) + cap - y0) / h));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = segDist(x0 + i * h, y0 + j * h, a, b);
        const k = j * nx + i;
        if (d < field[k]) field[k] = d;
      }
    }
  };
  const toCurb = new Float32Array(N).fill(cap);
  for (let k = 0; k < plate.length; k++) stamp(toCurb, plate[k], plate[(k + 1) % plate.length]);
  const toPath = new Float32Array(N).fill(cap);
  for (const pts of paths) for (let k = 1; k < pts.length; k++) stamp(toPath, pts[k - 1], pts[k]);
  // Запас: больше нуля — свободно.
  const g = new Float32Array(N);
  for (let k = 0; k < N; k++) g[k] = Math.min((inside[k] ? toCurb[k] : -toCurb[k]) - curb, toPath[k] - clear);
  // Мелкие и узкие островки — прочь.
  const comp = new Int32Array(N).fill(-1);
  const stack: number[] = [];
  for (let s = 0; s < N; s++) {
    if (g[s] <= 0 || comp[s] >= 0) continue;
    const cells: number[] = [];
    let widest = 0;
    comp[s] = s;
    stack.push(s);
    while (stack.length) {
      const k = stack.pop()!;
      cells.push(k);
      widest = Math.max(widest, g[k]);
      const i = k % nx;
      for (const q of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k - nx, k + nx]) {
        if (q < 0 || q >= N || g[q] <= 0 || comp[q] >= 0) continue;
        comp[q] = s;
        stack.push(q);
      }
    }
    if (cells.length * h * h < minArea || widest * 2 < minWidth) for (const k of cells) g[k] = -0.01;
  }
  return contours(g, nx, ny, x0, y0, h);
}

/** Изолинии нуля поля g на сетке (marching squares): замкнутые контуры положительных областей. */
function contours(g: Float32Array, nx: number, ny: number, x0: number, y0: number, h: number): Vec[][] {
  // Ребро сетки: горизонтальное (i, j)–(i + 1, j) — 2k, вертикальное (i, j)–(i, j + 1) — 2k + 1, k = j·nx + i.
  const pointOf = (id: number): Vec => {
    const k = id >> 1;
    const i = k % nx;
    const j = (k - i) / nx;
    const k2 = id & 1 ? k + nx : k + 1;
    const t = g[k] / (g[k] - g[k2]);
    return id & 1 ? { x: x0 + i * h, y: y0 + (j + t) * h } : { x: x0 + (i + t) * h, y: y0 + j * h };
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    links.set(a, [...(links.get(a) ?? []), b]);
    links.set(b, [...(links.get(b) ?? []), a]);
  };
  for (let j = 0; j + 1 < ny; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const k0 = j * nx + i;
      const k1 = k0 + 1;
      const k3 = k0 + nx;
      const k2 = k3 + 1;
      const c = (g[k0] > 0 ? 1 : 0) | (g[k1] > 0 ? 2 : 0) | (g[k2] > 0 ? 4 : 0) | (g[k3] > 0 ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const B = 2 * k0;
      const R = 2 * k1 + 1;
      const T = 2 * k3;
      const L = 2 * k0 + 1;
      const centre = g[k0] + g[k1] + g[k2] + g[k3] > 0;
      switch (c) {
        case 1:
        case 14:
          link(L, B);
          break;
        case 2:
        case 13:
          link(B, R);
          break;
        case 3:
        case 12:
          link(L, R);
          break;
        case 4:
        case 11:
          link(R, T);
          break;
        case 6:
        case 9:
          link(B, T);
          break;
        case 7:
        case 8:
          link(L, T);
          break;
        case 5:
          if (centre) {
            link(B, R);
            link(T, L);
          } else {
            link(L, B);
            link(R, T);
          }
          break;
        case 10:
          if (centre) {
            link(L, B);
            link(R, T);
          } else {
            link(B, R);
            link(T, L);
          }
          break;
      }
    }
  }
  const seen = new Set<number>();
  const loops: Vec[][] = [];
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    const loop: Vec[] = [];
    let prev = -1;
    let cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      loop.push(pointOf(cur));
      const next = (links.get(cur) ?? []).find((x) => x !== prev && !seen.has(x));
      if (next === undefined) break;
      prev = cur;
      cur = next;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

/** Площадь замкнутой ломаной (со знаком обхода). */
export function loopArea(pts: Vec[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Точка внутри многоугольника (чётно-нечётно). */
export function insidePoly(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Отрезки контура площадки, что идут по бордюру: все, кроме обрезов подъездов (cutLines — их концы), где площадка переходит в дорогу. */
export function curbSegments(plate: Vec[], cutLines: [Vec, Vec][]): [Vec, Vec][] {
  const same = (a: Vec, b: Vec) => dist(a, b) < 0.05;
  const res: [Vec, Vec][] = [];
  for (let k = 0; k < plate.length; k++) {
    const a = plate[k];
    const b = plate[(k + 1) % plate.length];
    if (cutLines.some(([p, q]) => (same(a, p) && same(b, q)) || (same(a, q) && same(b, p)))) continue;
    res.push([a, b]);
  }
  return res;
}

/** Ближе этого к бордюру пунктир не рисуем, м: там поворот ведёт бордюр. */
export const GUIDE_CURB_GAP = 1;

/**
 * Направляющая линия по асфальту: куски внутри площадки plate и не ближе GUIDE_CURB_GAP к бордюру curb; куски
 * короче 3 м — прочь.
 */
export function clipGuide(pts: Vec[], plate: Vec[], curb: [Vec, Vec][]): Vec[][] {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  const fine = resample(pts, Math.max(4, Math.ceil(L / 0.75)));
  const ok = (p: Vec) => insidePoly(p, plate) && curb.every(([a, b]) => segDist(p.x, p.y, a, b) >= GUIDE_CURB_GAP);
  const res: Vec[][] = [];
  let run: Vec[] = [];
  const flush = () => {
    let len = 0;
    for (let i = 1; i < run.length; i++) len += dist(run[i - 1], run[i]);
    if (len >= 3) res.push(run);
    run = [];
  };
  for (const p of fine) {
    if (ok(p)) run.push(p);
    else flush();
  }
  flush();
  return res;
}

/**
 * Разметка перекрёстка n по контуру его площадки plate и обрезам подъездов (cuts — по всей сети, как у отрисовки):
 * траектории — из графа движения вокруг узла. null — перекрёсток маленький или размечать нечего.
 */
export function junctionMarks(net: LaneNet, n: LaneNode, plate: Vec[], cuts: Map<number, [number, number]>): JunctionMarks | null {
  const ends = net.ends(n);
  const mine = ends.map((e) => cuts.get(e.corridor.id)?.[e.end === 'a' ? 0 : 1] ?? 0);
  if (!wantsMarks(net, n, mine)) return null;
  const g = localGraph(net, new Set([n.id]), cuts);
  const paths = turnPaths(g, n.id);
  if (!paths.length) return null;
  const islands = freeIslands(
    plate,
    paths.filter((p) => p.kind !== 'uturn').map((p) => p.points),
  );
  // Пунктир — только по асфальту площадки и не вдоль бордюра (там поворот ведёт сам бордюр).
  const cutLines = ends.map((e, i): [Vec, Vec] => [edgePoint(e, mine[i], -1).p, edgePoint(e, mine[i], 1).p]);
  const curb = curbSegments(plate, cutLines);
  const guides = guideLines(paths, { skew: isSkewed(net, n) }).flatMap((g) => clipGuide(g.pts, plate, curb).map((pts) => ({ pts, solid: g.solid })));
  if (!islands.length && !guides.length) return null;
  // Штрихи — под 45° к самой широкой дороге перекрёстка.
  const main = ends.reduce((a, b) => (b.corridor.lanes.length > a.corridor.lanes.length ? b : a));
  const ang = angleOf(main.away) + Math.PI / 4;
  return { islands, hatch: { x: Math.cos(ang), y: Math.sin(ang) }, guides };
}
