import { add, dot, rightNormal, sub, Vec } from '../core/vec';
import { ROAD_MARGIN } from '../world/roadTypes';
import { bridgeLook, deckAlong } from './deck';
import { edgesAt, laneBand, pointOff } from './geometry';
import type { GLane, GLink, LaneGraph } from './graph';
import { Corridor, LaneNet, layerOf } from './model';

/**
 * Как скорость показывается на дорогах: карта скоростей — линиями вдоль полос, знаки на поворотах — у кромки.
 * Обычно связь — одна линия посередине её полос; где полосы связи идут по разным траекториям (отгон, развилка,
 * вливание), — каждая полоса своей линией по своей середине. Мосты и эстакады (со съездами на них) рисуются
 * поверх земли своим слоем — их линии и знаки рисуются в том же слое и подняты вместе с полотном.
 */

/** Толщина линии одной полосы на карте скоростей (мир). */
export const SPEEDMAP_LANE = 2.5;

/** Слой высоты полотна — как у отрисовки дорог (layerOf): −1 тоннель, 0 земля, 1 мост, 2 эстакада. */
export function corridorLayer(net: LaneNet, c: Corridor): number {
  const la = net.node(c.a).level;
  const lb = net.node(c.b).level;
  return layerOf(Math.min(la, lb), Math.max(la, lb));
}

/** Рисуется ли скорость полотна слоя layer в проходе pass: на земле — и тоннели (они под ней, прозрачные), выше — только свой слой. */
export const inPass = (layer: number, pass: number) => (pass <= 0 ? layer <= 0 : layer === pass);

/** На сколько поднята на экране точка оси s: у моста и пандуса к нему — вместе с полотном (как рисует LaneRenderer), иначе ноль. */
export function deckLift(net: LaneNet, c: Corridor, s: number): Vec {
  const raised = Math.max(net.node(c.a).level, net.node(c.b).level) > 0;
  return raised ? bridgeLook(deckAlong(net, c, s)).lift : { x: 0, y: 0 };
}

/** Точка линии карты скоростей на s: со смещением от оси и поднятая вместе с мостом; null — полосы там нет. */
export function strokePoint(net: LaneNet, c: Corridor, stroke: SpeedStroke, s: number): Vec | null {
  const off = stroke.offsetAt(s);
  return off === null ? null : add(pointOff(c, s, off), deckLift(net, c, s));
}

/**
 * Линия вдоль полотна на [s0, s1] со смещением off от оси, шагом не больше step, у моста — поднятая вместе с ним
 * (карта пробок и прочие подсветки по полотну, которые рисуются в слое своего полотна).
 */
export function deckLine(net: LaneNet, c: Corridor, s0: number, s1: number, off: number, step = 6): Vec[] {
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const s = s0 + ((s1 - s0) * i) / n;
    pts.push(add(pointOff(c, s, off), deckLift(net, c, s)));
  }
  return pts;
}

/** Линия карты скоростей: одна на связь или на каждую полосу. */
export interface SpeedStroke {
  /** Полосы под линией; скорость — по первой. */
  lanes: GLane[];
  width: number;
  /** Смещение линии от оси полотна на s (вправо по a→b); null — полосы там нет. */
  offsetAt: (s: number) => number | null;
}

/** Куда полоса продолжается без манёвра (dir 1) или откуда пришла (dir −1): связь, null — никуда (перекрёсток, тупик). */
function contLink(graph: LaneGraph, lane: GLane, dir: 1 | -1): number | null {
  const m = (dir > 0 ? graph.movesFrom : graph.movesInto).get(lane.id)?.find((x) => x.cont);
  return m ? (dir > 0 ? m.outLink : m.inLink) : null;
}

/**
 * Рисовать ли полосы связи по отдельности: какая-то полоса на отгоне (появляется или уходит — её середина
 * смещается) или полосы расходятся в разные полотна в конце связи либо сходятся из разных в начале.
 */
export function perLane(graph: LaneGraph, link: GLink): boolean {
  const c = graph.net.corridors.get(link.corridor);
  if (!c) return false;
  const tapers = link.lanes.some((l) => {
    const slot = c.lanes[l.laneIdx];
    return !!slot && (slot.from > link.s0 + 0.5 || slot.to < link.s1 - 0.5);
  });
  if (tapers) return true;
  if (link.lanes.length < 2) return false;
  return ([1, -1] as const).some((dir) => new Set(link.lanes.map((l) => contLink(graph, l, dir))).size > 1);
}

/** Линии связи на карте скоростей. */
export function speedStrokes(graph: LaneGraph, link: GLink): SpeedStroke[] {
  const c = graph.net.corridors.get(link.corridor);
  if (!c || !link.lanes.length) return [];
  if (!perLane(graph, link)) {
    const off = link.lanes.reduce((a, l) => a + l.offset, 0) / link.lanes.length;
    return [{ lanes: link.lanes, width: link.lanes.length * SPEEDMAP_LANE, offsetAt: () => off }];
  }
  return link.lanes.map((lane) => {
    const slot = c.lanes[lane.laneIdx];
    return {
      lanes: [lane],
      width: SPEEDMAP_LANE,
      offsetAt: (s: number) => {
        const b = slot && laneBand(c, slot, s);
        return b ? (b[0] + b[1]) / 2 : null;
      },
    };
  });
}

/** Знак отстоит от кромки своей полосы на столько (плюс радиус) и от чужого асфальта — не меньше чем на столько. */
const SIGN_SHOULDER = 3;
const SIGN_GAP = 1;
/** Шаг, с которым знак отодвигается дальше по полосе, если на его месте чужая дорога, и насколько дальше — не больше. */
const SIGN_STEP = 4;
const SIGN_SLIDE = 120;

/** Дальше этого от оси полотна асфальта точно нет (самое широкое полотно — с запасом). */
const ROAD_REACH = 60;

/** Лежит ли круг (p, r) на асфальте какого-нибудь полотна, кроме own. */
export function onOtherRoad(net: LaneNet, p: Vec, r: number, own: number): boolean {
  const reach = r + ROAD_REACH;
  for (const o of net.corridorsNear(p, reach)) {
    if (o.id === own) continue;
    // Кривая — внутри рамки своих опорных точек: далеко от рамки — дальше не считаем.
    const { p0, p1, p2, p3 } = o.curve;
    if (p.x < Math.min(p0.x, p1.x, p2.x, p3.x) - reach || p.x > Math.max(p0.x, p1.x, p2.x, p3.x) + reach) continue;
    if (p.y < Math.min(p0.y, p1.y, p2.y, p3.y) - reach || p.y > Math.max(p0.y, p1.y, p2.y, p3.y) + reach) continue;
    const q = o.lut.closest(p);
    const t = o.lut.tangentAt(q.s);
    const d = sub(p, q.point);
    // За концом полотна (ближайшая точка — его конец) — только если круг заходит за обрез.
    if (Math.abs(dot(d, t)) > r + SIGN_GAP) continue;
    const e = edgesAt(o, q.s);
    if (!e) continue;
    const lat = dot(d, rightNormal(t));
    if (lat > e[0] - ROAD_MARGIN - r - SIGN_GAP && lat < e[1] + ROAD_MARGIN + r + SIGN_GAP) return true;
  }
  return false;
}

/**
 * Где поставить знак радиуса r у полосы lane на u (по ходу): у её кромки со стороны side (1 — справа по ходу,
 * −1 — слева), на отгоне — у настоящей кромки. Если там чужая дорога (у развилки знак слева от съезда попал бы
 * на основную дорогу), — дальше по полосе, где места уже хватает, но не дальше until (и SIGN_SLIDE); места нет — null.
 * У моста и пандуса знак поднят на экране вместе с полотном.
 */
export function signSpot(graph: LaneGraph, lane: GLane, u: number, side: 1 | -1, r: number, until = u): Vec | null {
  const link = graph.links.get(lane.link);
  const c = link && graph.net.corridors.get(link.corridor);
  const slot = c?.lanes[lane.laneIdx];
  if (!link || !c || !slot) return null;
  // Сторона в смещениях полотна: вправо по ходу — это +offset у полосы по a→b и −offset у встречной.
  const k = side * link.flow;
  const last = Math.min(lane.length, Math.max(u, Math.min(until, u + SIGN_SLIDE)));
  for (let x = Math.max(0, u); x <= last + 1e-6; x += SIGN_STEP) {
    const s = graph.axisS(lane, x);
    const b = laneBand(c, slot, s);
    if (!b) continue;
    const p = pointOff(c, s, (k > 0 ? b[1] : b[0]) + k * (SIGN_SHOULDER + r));
    if (!onOtherRoad(graph.net, p, r, c.id)) return add(p, deckLift(graph.net, c, s));
  }
  return null;
}
