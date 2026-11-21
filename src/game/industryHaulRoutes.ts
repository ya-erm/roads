import { clamp } from '../core/math';
import { add, closestOnSegment, dist, lerp, rightNormal, scale, type Vec } from '../core/vec';
import type { CargoType } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import { INDUSTRY_ROAD_WIDTH } from '../world/industryCompound';
import { moduleCargo } from '../world/industryModules';
import type { Circuit } from '../world/industryRoad';
import { industryLoadingApron, sitePoint } from '../world/industrySites';
import { pointInFootprint } from '../world/spatial';
import { industryRoadPaths } from './annexes';
import type { HaulDirection, IndustryHaulPath } from './industryHaul';
import { openBayRear } from './transport';

export function stationHaulJunction(st: Station): { back: number; berth: number } {
  const half = st.fp.h / 2;
  const back = -half;
  const berth = Math.max(back + 1, Math.min(-half * 0.39, openBayRear(st.fp.h) - INDUSTRY_ROAD_WIDTH / 2));
  return { back, berth };
}

function stationHaulRoad(st: Station, side: 1 | -1): [number, number][] {
  const { back, berth } = stationHaulJunction(st);
  return [[0, back], [0, berth], [side * 10, berth]];
}

type Road = readonly Vec[];
type Segment = readonly [Vec, Vec];
type HaulSite = Pick<Station, 'fp' | 'industryAccess'>;
interface HaulLayout {
  station: Station['fp'];
  plant: Industry['fp'];
  annexes: Industry['annexes'];
  front: number;
  revision: string;
  roads: readonly Road[];
  segments: Segment[];
  connection?: Road;
  routes: Map<string, readonly IndustryHaulPath[]>;
}

const layouts = new WeakMap<HaulSite, HaulLayout>();

export interface HaulGround {
  revision: string;
  clear(p: Vec): boolean;
}

function layout(st: HaulSite, ind: Industry, front: 1 | -1, ground?: HaulGround): HaulLayout {
  const cached = layouts.get(st);
  const revision = ground?.revision ?? '';
  if (cached?.station === st.fp && cached.plant === ind.fp && cached.front === front && cached.annexes === ind.annexes && cached.revision === revision) return cached;
  const roads = industryRoadPaths(ind);
  const segments = roads.flatMap((road) => road.slice(1).map((b, i) => [road[i], b] as const));
  const gate = sitePoint(st.fp, [0, -front * 0.5]);
  const mainEnd = roads[0].at(-1)!;
  let connection: Road | undefined = st.industryAccess ? [mainEnd, gate] : undefined;
  if (!connection) {
    const footprint = (fp: Station['fp']) => fp.groundParts === undefined ? fp : { ...fp, parts: fp.parts?.slice(0, fp.groundParts) };
    const solid = [st.fp, footprint(ind.fp), ...(ind.annexes ?? []).filter((a) => !a.roadOnly).map((a) => footprint(a.fp))];
    const candidates = segments.map(([a, b]) => closestOnSegment(gate, a, b)).filter((hit) => hit.d <= 150).sort((a, b) => a.d - b.d);
    const clear = (p: Vec) => !solid.some((fp) => pointInFootprint(p, fp, 1.5)) && (ground?.clear(p) ?? true);
    connection = connectHaulRoad(gate, candidates.map((hit) => hit.point), ind.fp.angle, clear);
  }
  const result = { station: st.fp, plant: ind.fp, front, annexes: ind.annexes, revision, roads, segments, connection, routes: new Map<string, readonly IndustryHaulPath[]>() };
  layouts.set(st, result);
  return result;
}

export function industryHaulConnection(st: HaulSite, ind: Industry, front: 1 | -1, ground?: HaulGround): Road | undefined {
  return layout(st, ind, front, ground).connection;
}

/** Соединяет тыльные ворота с уже существующим проездом. При необходимости обходит корпус. */
function connectHaulRoad(gate: Vec, goals: Vec[], angle: number, clear: (p: Vec) => boolean): Road | undefined {
  if (!goals.length) return undefined;
  const clearSpan = (a: Vec, b: Vec) => {
    const steps = Math.max(2, Math.ceil(dist(a, b) / 4));
    for (let i = 1; i <= steps; i++) if (!clear(lerp(a, b, i / steps))) return false;
    return true;
  };
  const direct = goals.find((p) => clearSpan(gate, p));
  if (direct) return [direct, gate];
  const axis = scale({ x: Math.cos(angle), y: Math.sin(angle) }, 8);
  const normal = rightNormal(axis);
  const queue = [{ x: 0, y: 0, pos: gate, prev: -1 }];
  const seen = new Set(['0:0']);
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    const target = goals.find((p) => dist(p, node.pos) < 14 && clearSpan(node.pos, p));
    if (target) {
      const path = [target, node.pos];
      for (let prev = node.prev; prev >= 0; prev = queue[prev].prev) path.push(queue[prev].pos);
      // Убираем лишние точки на прямых и скругления у соседних клеток.
      const result = [path[0]];
      for (let j = 1; j < path.length - 1; j++) {
        if (!clearSpan(result[result.length - 1], path[j + 1]) || j === path.length - 2) result.push(path[j]);
      }
      return [...result, gate];
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = node.x + dx;
      const y = node.y + dy;
      const key = `${x}:${y}`;
      if (x * x + y * y > 23 * 23 || seen.has(key)) continue;
      const pos = add(gate, add(scale(axis, x), scale(normal, y)));
      if (!clearSpan(node.pos, pos)) continue;
      seen.add(key);
      queue.push({ x, y, pos, prev: i });
    }
  }
  return undefined;
}

/** Проезжаем только по реальным рёбрам сети, включая ответвления и проезды игрока. */
function pathOnRoads(roads: readonly Road[], segments: readonly Segment[], start: Vec, goal: Vec): Road | null {
  const key = (p: Vec) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
  const vertices = [...new Map([start, goal, ...roads.flat()].map((p) => [key(p), p])).values()];
  const edges = new Map<string, Vec[]>();
  for (const [a, b] of segments) {
    const on = vertices.map((p) => ({ p, along: closestOnSegment(p, a, b) })).filter(({ along }) => along.d < 0.02)
      .sort((x, y) => x.along.t - y.along.t);
    for (let i = 1; i < on.length; i++) {
      const x = on[i - 1].p;
      const y = on[i].p;
      edges.set(key(x), [...(edges.get(key(x)) ?? []), y]);
      edges.set(key(y), [...(edges.get(key(y)) ?? []), x]);
    }
  }
  const queue = [[start]];
  const known = new Set([key(start)]);
  for (let i = 0; i < queue.length; i++) {
    const path = queue[i];
    const tail = key(path[path.length - 1]);
    if (tail === key(goal)) return path;
    for (const p of edges.get(tail) ?? []) {
      if (known.has(key(p))) continue;
      known.add(key(p));
      queue.push([...path, p]);
    }
  }
  return null;
}

/** Подъезд из проезда к отмеченному месту и выезд задним ходом до поворота к воротам. */
function parkingPaths(ind: Industry, road: Road): IndustryHaulPath[] {
  const apron = industryLoadingApron(ind.info);
  if (!ind.fp.compound || !apron) return [];
  const toWorld = (x: number, y: number) => sitePoint(ind.fp, [x / ind.info.w, y / ind.info.h]);
  const { x, w, mouth, aisle, bayY } = apron;
  const gate = toWorld(mouth, aisle);
  const fromStation = [...road].reverse();
  const turnRoom = INDUSTRY_ROAD_WIDTH / 2;
  const circuit = (path: Road): Circuit => path.map(({ x, y }) => [x, y]);
  return apron.bays.map((bx) => {
    const bay = toWorld(bx, bayY);
    const center = toWorld(bx, aisle);
    const drift = Math.sign(bx - mouth) * 7;
    const gear = toWorld(clamp(bx + drift, x + 4.5, x + w - 4.5), aisle);
    return {
      road,
      parking: {
        arrive: circuit([...fromStation, gate, center, bay]),
        reverse: circuit([bay, center, gear]),
        depart: circuit([gear, gate, ...road]),
        arrivalApron: dist(road[0], gate) + dist(gate, center) + dist(center, bay) + turnRoom,
        departureApron: dist(gear, gate) + dist(gate, road[0]) + turnRoom,
      },
    };
  });
}

export function industryHaulPaths(st: Station, ind: Industry, front: 1 | -1, cargo: CargoType, direction: HaulDirection, ground?: HaulGround): readonly IndustryHaulPath[] {
  const site = layout(st, ind, front, ground);
  const key = `${direction}:${cargo}`;
  const saved = site.routes.get(key);
  if (saved) return saved;
  const outbound = direction === 'out';
  const tail = stationHaulRoad(st, outbound ? -1 : 1).map(([x, y]) => sitePoint(st.fp, [x / st.fp.w, y * front / st.fp.h]));
  const connector = site.connection;
  const paths: IndustryHaulPath[] = [];
  if (connector) {
    const road = connector[0];
    const core = ind.fp.compound?.branches.at(-1)?.at(-1);
    const ends = [core ? sitePoint(ind.fp, core) : site.roads[0][0]];
    for (const section of ind.annexes ?? []) {
      if (!section.module || section.automatic || !section.connector?.length) continue;
      const serves = outbound ? ['warehouse', 'workshop', 'field', 'paddock', 'pit', 'well'].includes(section.module) : moduleCargo(ind, section.module) === cargo;
      if (serves) ends.push(section.connector.at(-1)!);
    }
    for (const section of ind.fp.compound?.sections ?? []) {
      const serves = outbound ? section.kind === 'warehouse' || section.kind === 'field' || section.kind === 'paddock'
        : section.kind === 'receiving' && section.cargo === cargo;
      if (serves && section.gate) ends.push(sitePoint(ind.fp, section.gate));
    }
    for (const end of ends) {
      const route = pathOnRoads(site.roads, site.segments, end, road);
      if (!route) continue;
      const path = [...route, ...connector.slice(1), ...tail.slice(1)];
      const parking = end === ends[0] ? parkingPaths(ind, path) : [];
      if (parking.length) paths.push(...parking);
      else paths.push({ road: path });
    }
    if (!paths.length) paths.push({ road: [...connector, ...tail.slice(1)] });
  }
  if (!paths.length) paths.push({ road: tail });
  site.routes.set(key, paths);
  return paths;
}
