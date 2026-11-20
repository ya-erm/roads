import { add, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import type { LaneNet, LaneNode } from '../lanes/model';
import type { Station } from '../world/entities';
import { footprintRadius } from '../world/spatial';
import { bayFront } from './transport';

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

/** Свободные точки перед крайними постами. Узлы появляются только после постройки дороги. */
export function stationGatePoints(st: Station, net: LaneNet): { pos: Vec; outward: Vec }[] {
  if (!hasStationGates(st)) return [];
  const fp = st.fp;
  const across = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const outward = scale(rightNormal(across), stationRoadFront(st, net));
  const edge = add(fp.center, scale(outward, fp.h / 2 + 5));
  const offset = Math.min(34, fp.w / 2 - 4);
  const used = new Set(additionalStationGates(st, net).map((node) => Math.sign(dot(sub(node.pos, fp.center), across))));
  return [-1, 1].filter((side) => !used.has(side)).map((side) => ({ pos: add(edge, scale(across, side * offset)), outward }));
}
