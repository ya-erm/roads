import { add, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import type { LaneNet, LaneNode } from '../lanes/model';
import type { Station } from '../world/entities';
import { footprintRadius } from '../world/spatial';
import { bayFront, openBayEnd } from './transport';

/** Самостоятельные подъезды доступны у станций с собственной площадкой. */
export function hasStationGates(st: Station): boolean {
  return st.kind === 'road' && !st.side && !st.curb;
}

export function additionalStationGates(st: Station, net: LaneNet): LaneNode[] {
  if (!hasStationGates(st)) return [];
  return net.nodesNear(st.fp.center, footprintRadius(st.fp) + 16).filter((node) => node.stationGate === st.id && node.corridors.length > 0);
}

export function stationRoadFront(st: Station, net: LaneNet): 1 | -1 {
  const gate = net.nodes.get(st.nodeId) ?? additionalStationGates(st, net)[0];
  return gate ? bayFront(st.fp, gate.pos) : st.industryId !== null ? -1 : 1;
}

/** Свободные точки вдоль фасада и на торцах проезда. Узлы появляются после постройки дороги. */
export function stationGatePoints(st: Station, net: LaneNet): { pos: Vec; outward: Vec; side?: -1 | 1 }[] {
  if (!hasStationGates(st)) return [];
  const fp = st.fp;
  const across = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const outward = scale(rightNormal(across), stationRoadFront(st, net));
  const edge = add(fp.center, scale(outward, fp.h / 2 + 5));
  const offset = Math.min(34, fp.w / 2 - 4);
  const gates = additionalStationGates(st, net);
  const usedFront = new Set(gates.filter((node) => !node.stationGateSide).map((node) => Math.sign(dot(sub(node.pos, fp.center), across))));
  const ends = [-1, 1] as const;
  const front = ends.filter((side) => !usedFront.has(side)).map((side) => ({ pos: add(edge, scale(across, side * offset)), outward }));
  if (st.industryId === null) return front;
  const aisle = Math.max(fp.h / 2 + 10, openBayEnd(fp.h) + 16);
  const center = add(fp.center, scale(outward, aisle));
  const side = ends.filter((end) => !gates.some((node) => node.stationGateSide === end)).map((side) => ({
    pos: add(center, scale(across, side * (fp.w / 2 + 5))), outward: scale(across, side), side,
  }));
  return [...front, ...side];
}
