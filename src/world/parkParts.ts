import type { Vec } from '../core/vec';
import type { Footpath, FootpathShape } from '../game/footpaths';
import type { TownPark } from './entities';

export type DecorKind = 'playground' | 'fountain' | 'statue' | 'obelisk' | 'tree' | 'bench' | 'bin' | 'lamp' | 'kiosk' | 'flowerbed' | 'pond';

/** Координаты внутри парка локальные; у отдельно стоящих предметов — мировые. */
export interface ParkObject {
  id: number;
  kind: DecorKind;
  pos: Vec;
  angle: number;
  size?: number;
  depth?: number;
  variant?: number;
  seed?: number;
}

export interface ParkPath {
  id: number;
  /** После первой правки или постройки — постоянный ID в общей сети пеших дорожек. */
  worldId?: number;
  cityCost?: number;
  points: Vec[];
  width: number;
  shape?: FootpathShape;
  surface?: Footpath['surface'];
  /** Исходная мощёная прогулочная полоса с поперечными швами у парапета. */
  promenade?: true;
}

export interface ParkParts { objects: ParkObject[]; paths: ParkPath[] }

/** Самая широкая дорожка исходной планировки — мощёная полоса у воды. */
export const PROMENADE_WIDTH = 4.7;

export const DECOR_SIZE: Record<DecorKind, number> = {
  playground: 7, fountain: 3, statue: 1.5, obelisk: 2.4, tree: 2.5,
  bench: 1, bin: 0.42, lamp: 0.38, kiosk: 4, flowerbed: 2.2, pond: 4,
};

export function defaultParkObject(kind: DecorKind, pos: Vec, angle = 0, id = 0): ParkObject {
  return { id, kind, pos, angle, size: DECOR_SIZE[kind] };
}

/** Радиус предмета от его центра; для прямоугольных предметов включает углы. */
export function decorRadius(object: ParkObject): number {
  const size = object.size ?? DECOR_SIZE[object.kind];
  if (object.kind === 'obelisk') return size * 1.6 * Math.SQRT2;
  if (object.kind === 'playground' || object.kind === 'kiosk') return size * Math.SQRT1_2;
  return Math.max(size, object.depth ?? 0);
}

export function parkToWorld(p: TownPark, q: Vec): Vec {
  const c = Math.cos(p.fp.angle), s = Math.sin(p.fp.angle);
  return { x: p.fp.center.x + q.x * c - q.y * s, y: p.fp.center.y + q.x * s + q.y * c };
}

export function worldToPark(p: TownPark, q: Vec): Vec {
  const c = Math.cos(p.fp.angle), s = Math.sin(p.fp.angle);
  const x = q.x - p.fp.center.x, y = q.y - p.fp.center.y;
  return { x: x * c + y * s, y: -x * s + y * c };
}
