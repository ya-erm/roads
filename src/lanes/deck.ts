/**
 * Высота полотна над землёй в метрах — для вида мостов: чем выше мост, тем дальше его тень на земле и тем выше
 * на экране само полотно (как будто смотрим чуть сбоку). Уровни узлов (−1 тоннель, 0 земля, 1 мост) решают,
 * что с чем пересекается; метры — только сколько под мостом высоты.
 */
import { GRADE } from '../config';
import type { Vec } from '../core/vec';
import type { Corridor, LaneNet, LaneNode } from './model';

/** Высота полотна над землёй на уровне level, м, если узлу её не задали: мост выше, тоннель ниже. */
export function levelDeck(level: number): number {
  return level > 0 ? GRADE.bridgeDeck * level : level < 0 ? -GRADE.tunnelDepth : 0;
}

/**
 * Высота полотна над землёй в узле, м: у моста и тоннеля — заданная («Авто» по профилю дороги, у тоннеля —
 * со знаком минус), иначе — по уровню.
 */
export function nodeDeck(n: Pick<LaneNode, 'level' | 'deck'>): number {
  return n.level !== 0 && n.deck !== undefined ? n.deck : levelDeck(n.level);
}

/** Мост «Авто» — не ниже и не выше стольких метров над землёй, тоннель — не мельче и не глубже. */
const AUTO_DECK = { bridge: [1, 40], tunnel: [-60, -1] } as const;

/**
 * Отметка полотна по проекту в точке p: ближайшее место ломаной pts (отметки z в её вершинах) не дальше 6 м
 * от p — с отметкой между вершинами; дальше — NaN.
 */
export function zAlong(pts: Vec[], z: ArrayLike<number>): (p: Vec) => number {
  return (p) => {
    let best = NaN;
    let bd = 36;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const abx = pts[i + 1].x - a.x;
      const aby = pts[i + 1].y - a.y;
      const L2 = abx * abx + aby * aby;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2)) : 0;
      const d = (a.x + abx * t - p.x) ** 2 + (a.y + aby * t - p.y) ** 2;
      if (d < bd) [bd, best] = [d, z[i] + (z[i + 1] - z[i]) * t];
    }
    return best;
  };
}

/**
 * Узлам моста и тоннеля, которые только что проложил «Авто» (fresh), — высоту полотна над землёй по проекту:
 * z(p) — отметка полотна в точке p (NaN — не знаем), ground — земля (NaN — вода, её уровень 0). Так отметки
 * узлов — те, что задумал профиль, и уклон моста между ними — его уклон, а не уклон склона под мостом.
 */
export function setDecks(net: LaneNet, fresh: (n: LaneNode) => boolean, z: (p: Vec) => number, ground: (p: Vec) => number): void {
  for (const n of net.nodes.values()) {
    if (n.level === 0 || !fresh(n)) continue;
    const at = z(n.pos);
    if (!Number.isFinite(at)) continue;
    const g = ground(n.pos);
    const [lo, hi] = n.level > 0 ? AUTO_DECK.bridge : AUTO_DECK.tunnel;
    n.deck = Math.max(lo, Math.min(hi, Math.round((at - (Number.isFinite(g) ? g : 0)) * 10) / 10));
  }
}

/** Выше этого вид моста уже не меняется: тень не уходит от полотна дальше, чем на bridgeLook(MAX_LOOK). */
export const MAX_LOOK = 20;
/** Сдвиг тени на метр высоты (солнце слева сверху): у обычного моста в 8 м — те же 9 × 14, что были всегда. */
const SHADOW_PER_M = { x: 9 / 8, y: 14 / 8 };
/** На столько метров на метр высоты полотно поднимается на экране. */
const LIFT_PER_M = 0.25;

/** Высота для вида: не ниже земли и не выше MAX_LOOK. */
const lookHeight = (m: number) => Math.max(0, Math.min(MAX_LOOK, Number.isFinite(m) ? m : 0));

/** Высота для вида на другом конце полотна c от узла n. */
const farLook = (net: LaneNet, c: Corridor, n: LaneNode) => lookHeight(nodeDeck(net.node(c.a === n.id ? c.b : c.a)));

/**
 * Наклон высоты для вида в узле n (м на метр) по ходу из соседнего полотна в полотно c. Стык одной дороги —
 * через оба соседних узла, но не круче, чем нужно, чтобы между узлами высота не выходила за их высоты
 * (Фрич — Карлсон); в узле выше или ниже обоих соседей, у тупика и перекрёстка — ноль. С обеих сторон стыка
 * наклон один и тот же — высота проходит через стык без излома.
 */
function slopeAt(net: LaneNet, n: LaneNode, c: Corridor): number {
  if (n.corridors.length !== 2 || c.a === c.b) return 0;
  const other = net.corridors.get(n.corridors[0] === c.id ? n.corridors[1] : n.corridors[0]);
  if (!other || other.a === other.b) return 0;
  const here = lookHeight(nodeDeck(n));
  const before = (here - farLook(net, other, n)) / Math.max(1e-6, other.length);
  const after = (farLook(net, c, n) - here) / Math.max(1e-6, c.length);
  if (before * after <= 0) return 0;
  const mid = (farLook(net, c, n) - farLook(net, other, n)) / (other.length + c.length);
  return Math.sign(mid) * Math.min(Math.abs(mid), 3 * Math.abs(before), 3 * Math.abs(after));
}

/**
 * Высота моста для вида в точке s оси, м: через высоты узлов плавной кривой — на стыке полотен та же высота
 * и тот же наклон, между узлами — не выше и не ниже их высот. Так тень — та же кривая, что полотно, лишь
 * сдвинутая, без уступов и изломов на стыках. Рельеф под мостом не берём: иначе тень ломается по каждой
 * ложбинке. Не ниже нуля и не выше MAX_LOOK.
 */
export function deckAlong(net: LaneNet, c: Corridor, s: number): number {
  const A = net.node(c.a);
  const B = net.node(c.b);
  const a = lookHeight(nodeDeck(A));
  const b = lookHeight(nodeDeck(B));
  const L = Math.max(1e-6, c.length);
  // Наклоны по ходу a → b: в узле a — из соседа в c, в узле b — из c в соседа.
  const da = slopeAt(net, A, c) * L;
  const db = -slopeAt(net, B, c) * L;
  const t = Math.max(0, Math.min(1, s / L));
  const t2 = t * t;
  const t3 = t2 * t;
  const h = (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * da + (-2 * t3 + 3 * t2) * b + (t3 - t2) * db;
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), h));
}

/** Вид моста на высоте m над землёй: сдвиг его тени по земле и сдвиг самого полотна на экране (вверх). На земле — без сдвигов. */
export function bridgeLook(m: number): { shadow: Vec; lift: Vec } {
  const h = lookHeight(m);
  return {
    shadow: { x: SHADOW_PER_M.x * h, y: SHADOW_PER_M.y * h },
    lift: { x: 0, y: h > 0 ? -LIFT_PER_M * h : 0 },
  };
}
