/**
 * Где рисовать светофор въезда в перекрёсток: в слое высоты своего подъезда (как стоп-линию) и поднятым вместе с его
 * полотном — светофор у спуска с моста или на эстакаде не уходит под полотно. Светофор, который сверху закрывает
 * чужой мост или эстакада (перекрёсток на земле под мостом), дорисовывается поверх приглушённо — как значок.
 */
import { add, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { edgesAt } from './geometry';
import type { GLink, LaneGraph } from './graph';
import type { LaneNet } from './model';
import { corridorLayer, deckLift } from './speedDisplay';

/** На сколько от середины крайней правой полосы стоит столбик светофора (вправо по ходу). */
export const LIGHT_SIDE = LANE_W / 2 + 3;
/** Шаг дополнительных секций со стрелкой — дальше от дороги. */
export const LIGHT_STEP = 5.4;
/** Радиус корпуса светофора. */
const LIGHT_R = 2.8;

export interface LightSpot {
  /** Основная секция — на экране, с подъёмом полотна. */
  pos: Vec;
  /** Курс въезда и «наружу» (от дороги, где встают секции со стрелкой). */
  dir: Vec;
  out: Vec;
  /** Слой высоты подъезда: в его проходе светофор и рисуется (inPass). */
  layer: number;
  /** Сверху его закрывает полотно повыше (мост над перекрёстком). */
  covered: boolean;
}

/** Светофор въезда link с sections дополнительными секциями: где, в каком слое и закрыт ли сверху. null — полосы нет. */
export function lightSpot(graph: LaneGraph, link: GLink, sections = 0): LightSpot | null {
  const net = graph.net;
  const c = net.corridors.get(link.corridor);
  const lane = link.lanes[link.lanes.length - 1];
  if (!c || !lane) return null;
  const end = graph.lanePose(lane, lane.length);
  const out = rightNormal(end.dir);
  const layer = corridorLayer(net, c);
  const pos = add(add(end.pos, scale(out, LIGHT_SIDE)), deckLift(net, c, graph.axisS(lane, lane.length)));
  const last = add(pos, scale(out, LIGHT_STEP * sections));
  const covered = underDeck(net, pos, layer, LIGHT_R) || underDeck(net, last, layer, LIGHT_R);
  return { pos, dir: end.dir, out, layer, covered };
}

/**
 * Закрывает ли точку p (с кругом радиуса r) на экране полотно слоя выше layer: мост и эстакада рисуются поднятыми,
 * поэтому с полотном сравнивается точка, опущенная на его подъём. За концом полотна — не закрывает.
 */
export function underDeck(net: LaneNet, p: Vec, layer: number, r = 0): boolean {
  for (const o of net.corridorsNear(p, 60)) {
    if (corridorLayer(net, o) <= layer) continue;
    const q = sub(p, deckLift(net, o, o.lut.closest(p).s));
    const hit = o.lut.closest(q);
    const t = o.lut.tangentAt(hit.s);
    const d = sub(q, hit.point);
    if (Math.abs(dot(d, t)) > r + 0.5) continue;
    const e = edgesAt(o, hit.s);
    if (!e) continue;
    const lat = dot(d, rightNormal(t));
    if (lat > e[0] - ROAD_MARGIN - r && lat < e[1] + ROAD_MARGIN + r) return true;
  }
  return false;
}
