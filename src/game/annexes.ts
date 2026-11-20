/**
 * Секции строятся на отдельных участках возле предприятия.
 * Производственные секции поднимают предел роста, склады увеличивают запас готовой продукции.
 */
import { ANNEX, ECONOMY } from '../config';
import { add, closestOnSegment, dist, dot, scale, sub, type Vec } from '../core/vec';
import type { Industry } from '../world/entities';
import { annexPlots, industryServiceRoads, sitePoint } from '../world/industrySites';
import { INDUSTRY_MODULES, type IndustryModule } from '../world/industryModules';
import { sectionPlot } from '../world/industryCompound';
import { footprintSide, type Footprint } from '../world/spatial';
import { inOutbuildingZone, outbuildingFootprint, outbuildingZone } from './outbuildings';

/** Предел, до которого предприятие растёт само: ANNEX.base и по 1 за пристройку, не выше его предела. */
export function growthCap(ind: Industry): number {
  return Math.min(ind.cap ?? ECONOMY.maxLevel, ANNEX.base + (ind.annexes?.filter((a) => !a.automatic && a.module !== 'warehouse').length ?? 0));
}

export function moduleEffect(ind: Industry, kind: IndustryModule): string {
  const module = INDUSTRY_MODULES[kind];
  if (module.storage) return `+${module.storage} ед. запаса продукции`;
  const max = ind.cap ?? ECONOMY.maxLevel;
  const gain = Math.min(1, max - growthCap(ind));
  const rate = `+${Math.round(module.rate * 100)}% к выпуску`;
  return gain > 0 ? `${rate}, +${gain} к пределу роста` : rate;
}

/** Докуда от центра предприятия можно ставить пристройки. */
export function annexZone(ind: Industry): number {
  return outbuildingZone(ind.fp, ind.fp.groundParts ? 170 : 125);
}

/** Пристройка с центром в p — участок в долю ANNEX.scale от предприятия, по его оси. */
export function annexFootprint(ind: Industry, p: Vec, kind?: IndustryModule): Footprint {
  const module = kind && INDUSTRY_MODULES[kind];
  return {
    ...outbuildingFootprint(ind.fp, p, module ? module.w : ind.fp.w * ANNEX.scale, module ? module.h : ind.fp.h * ANNEX.scale),
    parts: kind ? [sectionPlot({ kind, bounds: [-0.5, -0.5, 0.5, 0.5] })] : annexPlots(ind.info.kind),
  };
}

/** Пристройка целиком в зоне предприятия. */
export function inAnnexZone(ind: Industry, fp: Footprint): boolean {
  return inOutbuildingZone(ind.fp, ind.fp.groundParts ? 170 : 125, fp);
}

/** Соединение с существующей полосой. Последний отрезок идёт перпендикулярно стороне секции. */
export function annexConnections(ind: Industry, fp: Footprint): readonly (readonly Vec[])[] {
  const roads = industryServiceRoads(ind.info.kind, ind.fp);
  const paths = [roads.main, ...roads.branches].map((path) => path.map((p) => sitePoint(ind.fp, p)));
  for (const annex of ind.annexes ?? []) if (annex.connector) paths.push([...annex.connector]);
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
