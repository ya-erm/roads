import { dist, type Vec } from '../core/vec';
import { parkParts, parkWorldPaths } from '../render/parkArt';
import type { TownPark } from '../world/entities';
import { decorRadius, parkToWorld, worldToPark, type ParkObject, type ParkPath } from '../world/parkParts';
import { footpathPoints, footpathWidth, type Footpath, type FootpathShape } from './footpaths';

const generatedParkPathId = (park: TownPark, path: ParkPath) => path.worldId ?? -(2 ** 40 + park.id * 65_536 + path.id);
const pathsCache = new WeakMap<TownPark, { fp: TownPark['fp']; local: ParkPath[]; paths: Footpath[] }>();

function transformShape(shape: FootpathShape | undefined, transform: (p: Vec) => Vec): FootpathShape | undefined {
  if (shape?.kind === 'arc') return { kind: 'arc', through: transform(shape.through) };
  if (shape?.kind === 'curve') return { kind: 'curve', c1: transform(shape.c1), c2: transform(shape.c2) };
  if (shape?.kind === 'polyline') return { kind: 'polyline', via: shape.via.map(transform) };
}

export function worldParkFootpaths(park: TownPark): Footpath[] {
  const local = parkParts(park).paths;
  const old = pathsCache.get(park);
  if (old?.fp === park.fp && old.local === local) return old.paths;
  const paths: Footpath[] = parkWorldPaths(park).filter(path => path.points.length >= 2).map(path => {
    const points = path.points;
    const shape = path.shape ?? (points.length > 2 ? { kind: 'polyline', via: points.slice(1, -1) } : undefined);
    return { id: generatedParkPathId(park, path), parkId: park.id, a: points[0], b: points[points.length - 1],
      ...(shape && { shape }), width: path.width, surface: path.surface ?? 'path', ...(path.cityCost !== undefined && { cityCost: path.cityCost }) };
  });
  pathsCache.set(park, { fp: park.fp, local, paths });
  return paths;
}

export function writeParkPaths(park: TownPark, removed: ReadonlySet<number>, added: readonly Footpath[]): void {
  const paths = parkParts(park).paths.filter(path => !removed.has(generatedParkPathId(park, path)));
  const local = (p: Vec) => worldToPark(park, p);
  for (const path of added) {
    paths.push({ id: path.id, worldId: path.id, points: footpathPoints(path).map(local), width: footpathWidth(path),
      shape: transformShape(path.shape, local), surface: path.surface, cityCost: path.cityCost });
  }
  park.edits = { ...park.edits, paths };
}

export function worldParkObject(park: TownPark, object: ParkObject): ParkObject {
  return { ...object, pos: parkToWorld(park, object.pos), angle: object.angle + park.fp.angle };
}

export function nearestDecor(objects: readonly ParkObject[], p: Vec, extra = 0): ParkObject | undefined {
  let nearest: ParkObject | undefined, best = Infinity;
  for (const o of objects) {
    const d = dist(o.pos, p);
    if (d <= decorRadius(o) + extra && d < best) { nearest = o; best = d; }
  }
  return nearest;
}
