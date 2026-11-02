import { angleDiff, angleOf, Vec } from '../core/vec';
import type { Game } from '../game/game';
import { ARROW_K as K, ARROW_NOSE as NOSE, ARROW_TAIL as TAIL, arrowAt, arrowShape, Turn } from '../lanes/arrowShape';
import type { GLane, GLink, LaneGraph } from '../lanes/graph';

export { arrowShape };
export type { Turn };
/** Порядок направлений на стрелке — слева направо. */
const ORDER: Turn[] = ['uturn', 'left', 'straight', 'right'];

/** Белая разметка — как линии полос. */
const COLOR = 'rgba(245, 243, 230, 0.85)';
/** От стоп-линии до середины стрелки: у самого перекрёстка. */
const BACK = 9;

/** Куда ведут манёвры с каждой полосы подъезда (слева направо). */
export function laneTurns(g: LaneGraph, link: GLink): Set<Turn>[] {
  const moves = link.lanes.map((lane) => (g.movesFrom.get(lane.id) ?? []).filter((m) => !m.cont));
  // Угол поворота на каждый выезд: больше нуля — направо (ось y вниз).
  const theta = new Map<number, number>();
  for (const list of moves) for (const m of list) if (!theta.has(m.outLink)) theta.set(m.outLink, angleDiff(angleOf(m.dirIn), angleOf(m.dirOut)));
  const uTurn = (id: number) => Math.abs(theta.get(id)!) > 2.6 || g.links.get(id)?.corridor === link.corridor;
  // «Прямо» — самый прямой выезд, как при раздаче полос по выездам (assignLanes).
  let straight = -1;
  let best = 0.6;
  for (const [id, t] of theta) {
    if (!uTurn(id) && Math.abs(t) < best) {
      best = Math.abs(t);
      straight = id;
    }
  }
  const kind = (id: number): Turn => (uTurn(id) ? 'uturn' : id === straight ? 'straight' : theta.get(id)! > 0 ? 'right' : 'left');
  return moves.map((list) => new Set(list.map((m) => kind(m.outLink))));
}

/**
 * Стрелки на полосах подъезда (слева направо): null — без стрелки. Стрелки нужны, если хоть с одной полосы
 * нельзя уехать на какую-то из остальных дорог перекрёстка (запрет, слишком острый угол на развилке, полоса
 * только для поворота) — тогда они на всех полосах подъезда, как на настоящих дорогах. Если со всех полос
 * можно на все дороги — стрелок нет.
 */
export function laneArrows(g: LaneGraph, link: GLink): (Turn[] | null)[] {
  const sets = laneTurns(g, link);
  // Остальные дороги перекрёстка (кроме своей — на неё разворот) и куда с каждой полосы можно уехать.
  const arms = new Set((link.toNode === null ? [] : (g.outLinks.get(link.toNode) ?? [])).map((o) => o.corridor).filter((id) => id !== link.corridor));
  const reach = link.lanes.map(
    (lane) => new Set((g.movesFrom.get(lane.id) ?? []).filter((m) => !m.cont).map((m) => g.links.get(m.outLink)?.corridor).filter((id) => id !== link.corridor)),
  );
  const marked = reach.some((r) => r.size > 0 && [...arms].some((id) => !r.has(id)));
  return sets.map((s) => (marked && s.size ? ORDER.filter((t) => s.has(t)) : null));
}

/** Полоса, которая продолжается в эту (та же полоса раньше по дороге). */
const before = (g: LaneGraph, lane: GLane): GLane | undefined => {
  const m = g.movesInto.get(lane.id)?.find((x) => x.cont);
  return m && g.lanes.get(m.inLane);
};

/**
 * Где на подъезде середина стрелки: BACK до стоп-линии, назад по продолжениям полосы.
 * Если полоса начинается ближе — сразу за её началом; null — до стоп-линии не влезает.
 */
function placeArrow(g: LaneGraph, lane: GLane): { lane: GLane; u: number } | null {
  const tail = -TAIL * K + 0.5;
  const nose = NOSE * K + 2;
  let cur = lane;
  /** От конца cur до стоп-линии. */
  let ahead = 0;
  for (let k = 0; k < 8 && ahead + cur.length < BACK; k++) {
    const prev = before(g, cur);
    if (!prev) break;
    ahead += cur.length;
    cur = prev;
  }
  let u = cur.length - (BACK - ahead);
  if (u < tail && !before(g, cur)) u = Math.min(cur.length, tail);
  return ahead + cur.length - u >= nose ? { lane: cur, u } : null;
}

/** Стрелка в мире: середина (для отсечения по экрану) и контуры. */
interface Mark {
  x: number;
  y: number;
  polys: Vec[][];
}

/** Граф пересоздаётся при каждой правке сети — по нему и кэш. */
const cache = new WeakMap<LaneGraph, Mark[]>();

function marksOf(g: LaneGraph): Mark[] {
  const cached = cache.get(g);
  if (cached) return cached;
  const marks: Mark[] = [];
  const shapes = new Map<string, Vec[][]>();
  const ground = (corridor: number) => {
    const c = g.net.corridors.get(corridor);
    return !!c && [c.a, c.b].every((id) => Math.abs(g.net.nodes.get(id)?.level ?? 0) <= 0.25);
  };
  for (const n of g.net.nodes.values()) {
    // На кольцах стрелок нет.
    if (n.kind !== 'junction' || (n.roundabout ?? null) !== null) continue;
    if (n.corridors.some((id) => g.net.corridors.get(id)?.ring)) continue;
    for (const link of g.inLinks.get(n.id) ?? []) {
      laneArrows(g, link).forEach((turns, i) => {
        if (!turns) return;
        const at = placeArrow(g, link.lanes[i]);
        // Мосты и тоннели рисуются другим слоем — там стрелку не видно или она не на месте.
        if (!at || !ground(g.links.get(at.lane.link)!.corridor)) return;
        const key = turns.join('+');
        let shape = shapes.get(key);
        if (!shape) shapes.set(key, (shape = arrowShape(turns)));
        const { pos, dir } = g.lanePose(at.lane, at.u);
        marks.push({ x: pos.x, y: pos.y, polys: arrowAt(shape, pos, dir) });
      });
    }
  }
  cache.set(g, marks);
  return marks;
}

/** Стрелки на асфальте перед перекрёстками — на полосах, с которых можно не во все стороны. */
export function drawTurnArrows(ctx: CanvasRenderingContext2D, game: Game, view: { x0: number; y0: number; x1: number; y1: number }, zoom: number): void {
  if (zoom < 0.6) return;
  const marks = marksOf(game.roads.graph);
  if (!marks.length) return;
  ctx.fillStyle = COLOR;
  ctx.beginPath();
  for (const m of marks) {
    if (m.x < view.x0 || m.x > view.x1 || m.y < view.y0 || m.y > view.y1) continue;
    for (const poly of m.polys) {
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath();
    }
  }
  ctx.fill();
}
