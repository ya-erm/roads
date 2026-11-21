import { closestOnSegment, dist, type Vec } from '../core/vec';
import { nearestFootpath } from '../game/footpaths';
import type { Game } from '../game/game';
import { gameSidewalks } from '../render/sidewalks';

/** Построенные развилки и входы переходов — точечные цели; на тротуар можно выйти в любом месте. */
export function footpathSnap(game: Game, p: Vec, radius: number): Vec {
  const hit = nearestFootpath(game.footpaths, p, radius);
  let point = hit?.pos ?? p;
  let best = hit?.d ?? radius;
  if (hit) {
    const end = [hit.path.a, hit.path.b].find(q => dist(q, p) < Math.min(2, radius));
    if (end) return end;
  }
  for (const n of game.roads.net.nodesNear(p, radius + 80)) {
    for (const walk of game.roads.graph.crosswalks.get(n.id) ?? []) {
      for (const q of walk.geo.ends) {
        const d = dist(p, q);
        if (d <= Math.min(2, radius)) return q;
        if (d < best) { point = q; best = d; }
      }
    }
  }
  for (const l of gameSidewalks(game).lines) {
    if (l.box.x0 > p.x + best || l.box.x1 < p.x - best || l.box.y0 > p.y + best || l.box.y1 < p.y - best) continue;
    for (const path of l.paths) for (let i = 2; i < path.length; i += 2) {
      const a = { x: path[i - 2], y: path[i - 1] };
      const b = { x: path[i], y: path[i + 1] };
      const near = closestOnSegment(p, a, b);
      if (near.d < best) { point = near.point; best = near.d; }
    }
  }
  return point;
}
