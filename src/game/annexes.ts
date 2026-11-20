/**
 * Секции строятся на отдельных участках возле предприятия.
 * Производственные секции поднимают предел роста, склады увеличивают запас готовой продукции.
 */
import { ANNEX, ECONOMY } from '../config';
import { add, closestOnSegment, dist, dot, scale, sub, type Vec } from '../core/vec';
import type { Annex, Industry } from '../world/entities';
import { annexPlots, industryServiceRoads, sitePoint } from '../world/industrySites';
import { addsGrowth, INDUSTRY_MODULES, moduleSection, type IndustryModule } from '../world/industryModules';
import { INDUSTRY_ROAD_WIDTH, sectionPlot } from '../world/industryCompound';
import { footprintSide, type Footprint } from '../world/spatial';
import { inOutbuildingZone, outbuildingFootprint, outbuildingZone } from './outbuildings';

/** Предел, до которого предприятие растёт само: ANNEX.base и по 1 за пристройку, не выше его предела. */
export function growthCap(ind: Industry): number {
  return Math.min(ind.cap ?? ECONOMY.maxLevel, ANNEX.base + (ind.annexes?.filter(addsGrowth).length ?? 0));
}

export function moduleEffect(ind: Industry, kind: IndustryModule): string {
  const module = INDUSTRY_MODULES[kind];
  if (module.storage) return `+${module.storage} ед. запаса продукции`;
  const max = ind.cap ?? ECONOMY.maxLevel;
  const gain = Math.min(1, max - growthCap(ind));
  const rate = `+${Math.round(module.rate * 100)}% к выпуску`;
  return gain > 0 && kind !== 'service' && kind !== 'receiving' && kind !== 'receivingSecond' ? `${rate}, +${gain} к пределу роста` : rate;
}

const ROAD_COST_PER_METER = 70;

export function annexCost(a: Annex): number {
  if (a.roadOnly) return industryRoadCost(a.fp);
  return a.module ? INDUSTRY_MODULES[a.module].cost : ANNEX.cost;
}

export function industryRoadCost(fp: Footprint): number {
  return Math.round((fp.w - INDUSTRY_ROAD_WIDTH) * ROAD_COST_PER_METER);
}

/** Докуда от центра предприятия можно ставить пристройки. */
export function annexZone(ind: Industry): number {
  return outbuildingZone(ind.fp, ind.fp.compound ? 280 : 125);
}

/** Пристройка с центром в p — участок в долю ANNEX.scale от предприятия, по его оси. */
export function annexFootprint(ind: Industry, p: Vec, kind?: IndustryModule, rotation = 0): Footprint {
  const module = kind && INDUSTRY_MODULES[kind];
  return {
    ...outbuildingFootprint(ind.fp, p, module ? module.w : ind.fp.w * ANNEX.scale, module ? module.h : ind.fp.h * ANNEX.scale),
    angle: ind.fp.angle + rotation,
    parts: kind ? [sectionPlot({ kind: moduleSection(kind), bounds: [-0.5, -0.5, 0.5, 0.5] })] : annexPlots(ind.info.kind),
  };
}

/** Пристройка целиком в зоне предприятия. */
export function inAnnexZone(ind: Industry, fp: Footprint): boolean {
  return inOutbuildingZone(ind.fp, ind.fp.compound ? 280 : 125, fp);
}

export function industryRoadPaths(ind: Industry): readonly (readonly Vec[])[] {
  const roads = industryServiceRoads(ind.info.kind, ind.fp);
  const paths: (readonly Vec[])[] = [roads.main, ...roads.branches].map((path) => path.map((p) => sitePoint(ind.fp, p)));
  for (const annex of ind.annexes ?? []) if (annex.connector) paths.push(annex.connector);
  return paths;
}

export function snapIndustryRoad(ind: Industry, p: Vec, radius: number): Vec | undefined {
  let best: Vec | undefined;
  for (const path of industryRoadPaths(ind)) for (let i = 1; i < path.length; i++) {
    const hit = closestOnSegment(p, path[i - 1], path[i]);
    if (hit.d <= radius) {
      best = hit.point;
      radius = hit.d;
    }
  }
  return best;
}

export function industryRoadFootprint(start: Vec, end: Vec): Footprint {
  const d = sub(end, start);
  return { center: scale(add(start, end), 0.5), w: dist(start, end) + INDUSTRY_ROAD_WIDTH, h: INDUSTRY_ROAD_WIDTH, angle: Math.atan2(d.y, d.x) };
}

/** Соединение с существующей полосой. Последний отрезок идёт перпендикулярно стороне секции. */
export function annexConnections(ind: Industry, fp: Footprint): readonly (readonly Vec[])[] {
  const paths = industryRoadPaths(ind);
  const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const v = { x: -u.y, y: u.x };
  const candidates: { path: Vec[]; length: number }[] = [];
  for (const route of paths) for (let i = 1; i < route.length; i++) {
    const join = closestOnSegment(fp.center, route[i - 1], route[i]).point;
    const toRoad = sub(join, fp.center);
    for (const axis of [u, v]) {
      const local = dot(toRoad, axis);
      const n = scale(axis, Math.sign(local) || 1);
      const extent = footprintSide(fp, n);
      if (Math.abs(local) < extent + 5) continue;
      const gate = add(fp.center, scale(n, extent + 0.25));
      const elbow = add(fp.center, scale(n, Math.abs(local)));
      const path = dist(join, elbow) < 0.75 ? [join, gate] : [join, elbow, gate];
      const length = dist(join, elbow) + dist(elbow, gate);
      if (length <= 125) candidates.push({ path, length });
    }
  }
  return candidates.sort((a, b) => a.length - b.length).map((item) => item.path);
}
