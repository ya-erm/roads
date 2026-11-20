import { add, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import type { LaneNet, LaneNode } from '../lanes/model';
import type { Station } from '../world/entities';
import { footprintRadius } from '../world/spatial';
import { bayFront, openBayEnd } from './transport';

const GATE_OUT = 5;
const FRONT_GATE_INSET = 4;

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

/** При сужении двора его край должен оставаться у построенного подъезда. */
export function widthAtStationGates(st: Station, net: LaneNet): number {
  const across = { x: Math.cos(st.fp.angle), y: Math.sin(st.fp.angle) };
  let width = 0;
  for (const gate of additionalStationGates(st, net)) {
    const x = Math.abs(dot(sub(gate.pos, st.fp.center), across));
    width = Math.max(width, 2 * (x + (gate.stationGateSide ? -GATE_OUT : FRONT_GATE_INSET)));
  }
  return Math.min(width, st.fp.w);
}

/** Свободные точки вдоль фасада и на торцах проезда. Узлы появляются после постройки дороги. */
export function stationGatePoints(st: Station, net: LaneNet): { pos: Vec; outward: Vec; side?: -1 | 1 }[] {
  if (!hasStationGates(st)) return [];
  const fp = st.fp;
  const across = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const outward = scale(rightNormal(across), stationRoadFront(st, net));
  const edge = add(fp.center, scale(outward, fp.h / 2 + GATE_OUT));
  const offset = Math.min(34, fp.w / 2 - FRONT_GATE_INSET);
  const gates = additionalStationGates(st, net);
  const usedFront = new Set(gates.filter((node) => !node.stationGateSide).map((node) => Math.sign(dot(sub(node.pos, fp.center), across))));
  const ends = [-1, 1] as const;
  const front = ends.filter((side) => !usedFront.has(side)).map((side) => ({ pos: add(edge, scale(across, side * offset)), outward }));
  if (st.industryId === null) return front;
  const aisle = Math.max(fp.h / 2 + 10, openBayEnd(fp.h) + 16);
  const center = add(fp.center, scale(outward, aisle));
  const side = ends.filter((end) => !gates.some((node) => node.stationGateSide === end)).map((side) => ({
    pos: add(center, scale(across, side * (fp.w / 2 + GATE_OUT))), outward: scale(across, side), side,
  }));
  return [...front, ...side];
}
