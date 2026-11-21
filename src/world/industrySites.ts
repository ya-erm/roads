import { hash } from '../core/math';
import { lerp, type Vec } from '../core/vec';
import type { IndustryKind, IndustryType } from './cargo';
import { farmCompound, sectionPlot, worksCompound } from './industryCompound';
import type { Footprint, Plot } from './spatial';
import type { Terrain } from './terrain';

type Bounds = readonly [x: number, y: number, w: number, h: number];
type Corner = readonly [number, number];

/** Контур проходит между вершинами. Промежуточные точки общие для рисунка и проверки занятости. */
function rounded(corners: readonly Vec[], round = 0.40): Plot {
  const points: Vec[] = [];
  for (let i = 0; i < corners.length; i++) {
    const vertex = corners[i];
    const before = lerp(vertex, corners[(i + corners.length - 1) % corners.length], round);
    const after = lerp(vertex, corners[(i + 1) % corners.length], round);
    for (let j = 0; j <= 6; j++) {
      const t = j / 6;
      points.push(lerp(lerp(before, vertex, t), lerp(vertex, after, t), t));
    }
  }
  return points;
}

function plot(corners: readonly Corner[], round?: number): Plot {
  return rounded(corners.map(([x, y]) => ({ x, y })), round);
}

const FIELD_SHAPES: readonly (readonly Corner[])[] = [
  [[0.03, 0.19], [0.96, 0.04], [0.99, 0.64], [0.80, 0.92], [0.04, 0.98]],
  [[0.03, 0.16], [0.91, 0.02], [0.99, 0.82], [0.21, 0.99], [0.02, 0.78]],
  [[0.03, 0.08], [0.97, 0.03], [0.94, 0.86], [0.15, 0.97], [0.02, 0.77]],
];
const FIELD_BOUNDS: readonly Bounds[] = [[-1.36, -0.54, 1.18, 0.82], [-0.9, 0.38, 0.85, 0.79], [-0.94, -1.21, 1.32, 0.56]];
const COMPACT_FIELDS: readonly Bounds[] = [[-0.49, -0.47, 0.42, 0.45], [-0.48, 0.01, 0.40, 0.46], [-0.045, -0.45, 0.18, 0.89]];
const FARMYARD = plot([[-0.10, -0.22], [0.02, -0.43], [0.25, -0.52], [0.47, -0.48], [0.54, -0.13], [0.48, 0.29],
  [0.45, 0.48], [0.17, 0.52], [0.03, 0.35], [-0.09, 0.20]]);

/** Отдельные поля с криволинейной межой. В старых партиях остаются в границах исходного участка. */
export function farmFields(seed: number, extended: boolean): readonly Plot[] {
  return (extended ? FIELD_BOUNDS : COMPACT_FIELDS).map(([x, y, w, h], index) => {
    const corners = FIELD_SHAPES[index].map(([u, v], n) => {
      const swing = (hash(seed, 100 + index * 17 + n) - 0.5) * 0.042;
      return { x: x + w * (u + swing), y: y + h * (v - swing) };
    });
    return rounded(corners, 0.13);
  });
}

const PIT = plot([[-0.99, -0.24], [-0.71, -0.53], [-0.45, -0.62], [-0.10, -0.47], [0.32, -0.52], [0.54, -0.33],
  [0.56, 0.35], [0.31, 0.54], [-0.04, 0.47], [-0.31, 0.63], [-0.70, 0.49], [-0.95, 0.32]], 0.27);
const WORKS = plot([[-0.52, -0.51], [0.52, -0.51], [0.52, 0.51], [-0.52, 0.51]], 0.043);
const FOREST = plot([[-0.75, -0.40], [-0.31, -0.63], [-0.12, -0.39], [0.39, -0.48], [0.56, -0.14],
  [0.41, 0.16], [0.52, 0.49], [0.16, 0.60], [-0.13, 0.43], [-0.58, 0.47], [-0.85, 0.21]]);
const FIELD_ANNEX = plot([[-0.54, -0.12], [-0.41, -0.42], [-0.04, -0.53], [0.42, -0.45], [0.56, -0.16],
  [0.46, 0.35], [0.11, 0.52], [-0.36, 0.48], [-0.53, 0.24]], 0.36);
const QUARRY_ANNEX = plot([[-0.56, -0.18], [-0.42, -0.48], [-0.10, -0.52], [0.33, -0.47], [0.54, -0.21],
  [0.53, 0.19], [0.28, 0.50], [-0.35, 0.52], [-0.51, 0.28]], 0.18);

export const isOpenPit = (kind: IndustryKind) => kind === 'ironmine' || kind === 'coppermine' || kind === 'quarry' || kind === 'sandpit' || kind === 'claypit';
export const hasFields = (kind: IndustryKind) => kind === 'farm' || kind === 'flaxfarm' || kind === 'sunflower' || kind === 'cottonfarm';
export const hasBulkYard = (kind: IndustryKind) => kind === 'steelmill' || kind === 'smelter' || kind === 'cement' || kind === 'sawmill' || kind === 'buildmat';
export const hasPowerYard = (kind: IndustryKind) => kind === 'refinery' || kind === 'gasplant' || kind === 'gasfield' || kind === 'electro';
export const hasPastures = (kind: IndustryKind) => kind === 'ranch' || kind === 'sheepfarm';

interface ServiceRoads {
  /** От места загрузки до восточных технологических ворот. */
  main: readonly Corner[];
  branches: readonly (readonly Corner[])[];
}

const FARM_ROADS: ServiceRoads = {
  main: [[-0.68, 0.30], [-0.43, 0.29], [-0.14, 0.32], [0.09, 0.34], [0.29, 0.32], [0.57, 0.29]],
  branches: [[[-0.14, 0.32], [-0.12, 0.08], [-0.09, -0.34], [0.01, -0.55], [0.08, -0.65]], [[-0.43, 0.29], [-0.43, 0.37]]],
};
const MINE_ROADS: ServiceRoads = {
  main: [[0.26, 0.28], [0.34, 0.39], [0.46, 0.47], [0.57, 0.45], [0.67, 0.45]],
  branches: [[[0.34, 0.39], [0.15, 0.47], [-0.12, 0.60], [-0.39, 0.66], [-0.65, 0.69]]],
};
const WORKS_ROADS: ServiceRoads = {
  main: [[-0.72, 0.36], [-0.61, 0.52], [-0.44, 0.61], [-0.08, 0.62], [0.31, 0.62], [0.54, 0.61], [0.67, 0.60]],
  branches: [[[0.31, 0.62], [0.35, 0.51], [0.38, 0.37]], [[-0.44, 0.61], [-0.43, 0.51]]],
};
const POWER_ROADS: ServiceRoads = {
  main: [...WORKS_ROADS.main.slice(0, -1), [0.73, 0.57], [0.94, 0.50], [1.03, 0.50]],
  branches: [...WORKS_ROADS.branches, [[0.73, 0.57], [0.76, 0.36], [0.76, 0.27]]],
};

export function industryServiceRoads(kind: IndustryKind, fp?: Footprint): ServiceRoads {
  if (fp?.compound) return fp.compound;
  if (hasFields(kind) || hasPastures(kind)) return FARM_ROADS;
  if (hasPowerYard(kind)) return POWER_ROADS;
  return isOpenPit(kind) ? MINE_ROADS : WORKS_ROADS;
}

export function sitePoint(fp: Footprint, [x, y]: Corner): Vec {
  const cos = Math.cos(fp.angle);
  const sin = Math.sin(fp.angle);
  return { x: fp.center.x + x * fp.w * cos - y * fp.h * sin, y: fp.center.y + x * fp.w * sin + y * fp.h * cos };
}

export function industryAccess(fp: Footprint, kind: IndustryKind): Vec {
  const route = industryServiceRoads(kind, fp).main;
  return sitePoint(fp, route[route.length - 1]);
}

/** Размеченные погрузочные площадки у корпуса, в координатах рисунка предприятия. */
const LOADING_APRONS: Partial<Record<IndustryKind, readonly [x: number, y: number, w: number, h: number, pitch: number]>> = {
  meatplant: [-24, 10, 76, 22, 10],
  foodplant: [-48, 12, 96, 21, 10],
  cannery: [-48, 12, 96, 21, 10],
  oilmill: [-48, 12, 96, 21, 10],
  factory: [12, 22, 46, 16, 9],
  linenmill: [-52, 12, 66, 21, 10],
  woolmill: [-52, 12, 66, 21, 10],
  cottonmill: [-52, 12, 66, 21, 10],
};

export function industryLoadingApron(info: IndustryType) {
  const layout = LOADING_APRONS[info.kind];
  if (!layout) return undefined;
  const [x, y, w, h, pitch] = layout;
  const mouth = 0.13 * info.w;
  // У проезда место для манёвра, корпуса стоят носом к цеху.
  const aisle = y + h - (h < 20 ? 1 : 2);
  const bayY = y + 4.5;
  const bays: number[] = [];
  for (let bx = x + pitch; bx <= x + w - pitch / 2; bx += pitch) {
    if (Math.abs(bx - mouth) >= 7 && (info.kind !== 'foodplant' || bx <= 10)) bays.push(bx);
  }
  return { x, y, w, h, pitch, mouth, aisle, bayY, bays };
}

/** Проезды резервируются вместе со зданием, чтобы на них нельзя было построить дом или провести полотно. */
function roadPlots(route: readonly Corner[], w: number, h: number): Plot[] {
  const plots: Plot[] = [];
  for (let i = 1; i < route.length; i++) {
    const [ax, ay] = route[i - 1];
    const [bx, by] = route[i];
    const dx = (bx - ax) * w;
    const dy = (by - ay) * h;
    const l = Math.hypot(dx, dy);
    const u = { x: dx / l * 3.7 / w, y: dy / l * 3.7 / h };
    const n = { x: -dy / l * 4.2 / w, y: dx / l * 4.2 / h };
    plots.push([
      { x: ax - u.x - n.x, y: ay - u.y - n.y }, { x: bx + u.x - n.x, y: by + u.y - n.y },
      { x: bx + u.x + n.x, y: by + u.y + n.y }, { x: ax - u.x + n.x, y: ay - u.y + n.y },
    ]);
  }
  return plots;
}

export function annexPlots(kind: IndustryKind): readonly Plot[] {
  if (hasFields(kind) || hasPastures(kind)) return [FIELD_ANNEX];
  if (isOpenPit(kind) || kind === 'coalmine' || kind === 'goldmine' || kind === 'gemmine') return [QUARRY_ANNEX];
  return [WORKS];
}

/** w и h задают масштаб цехов. Земля резервируется отдельными контурами вокруг них. */
export function industryFootprint(info: IndustryType, center: Vec, angle: number, complete = false): Footprint {
  const { kind, w, h } = info;
  const rural = hasFields(kind) || hasPastures(kind);
  const core = rural ? FARMYARD : isOpenPit(kind) ? PIT : kind === 'forest' ? FOREST : WORKS;
  const compound = rural ? farmCompound(hasPastures(kind), complete) : worksCompound(info, isOpenPit(kind), hasPowerYard(kind), complete);
  // Цвет и детали посадок остаются детерминированными по ID, геометрия дороги не зависит от номера попытки размещения.
  const parts = [core, ...compound.sections.map(sectionPlot)];
  const groundParts = parts.length;
  return { center, w, h, angle, groundParts, compound, parts: [...parts, ...[compound.main, ...compound.branches].flatMap((road) => roadPlots(road, w, h))] };
}

/** У берега проверяем землю по отдельным участкам, включая проезды. */
export function compoundOnLand(fp: Footprint, terrain: Terrain): boolean {
  return !!fp.parts && fp.parts.every((part) => {
    const left = Math.min(...part.map((p) => p.x));
    const right = Math.max(...part.map((p) => p.x));
    const top = Math.min(...part.map((p) => p.y));
    const bottom = Math.max(...part.map((p) => p.y));
    const center = sitePoint(fp, [(left + right) / 2, (top + bottom) / 2]);
    const reach = Math.hypot((right - left) * fp.w, (bottom - top) * fp.h) / 2 + 5;
    return terrain.inBounds(center, reach) && !terrain.isWater(center, reach);
  });
}
