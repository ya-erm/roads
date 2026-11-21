import { hash } from '../core/math';
import { SIM_DT, type PedestrianLevel } from '../config';
import { closestOnSegment, dist, lerp, type Vec } from '../core/vec';
import { XWALK } from '../lanes/crosswalk';
import type { GraphWalk, LaneGraph } from '../lanes/graph';
import { gameSidewalks, type SidewalkNet } from '../render/sidewalks';
import type { Box } from '../render/tileCache';
import { walkKey } from './crosswalks';
import { footpathNetwork, type Footpath } from './footpaths';
import type { Game } from './game';
import { leaveWalkingSpace, type WalkIntent } from './walkingSpace';

interface Corner extends Vec { key: string; links: WalkEdge[] }
interface WalkEdge {
  key: string;
  a: Corner;
  b: Corner;
  length: number;
  crossing?: GraphWalk;
}
interface Segment { a: Vec; b: Vec; cuts: { t: number; p: Vec }[] }

const pointKey = (p: Vec) => `${Math.round(p.x * 20)},${Math.round(p.y * 20)}`;
const CELL = 40;
const BASE_POPULATION_LIMIT = 480;
// Первый уровень сохраняет прежнюю плотность. Прибавка каждой следующей ступени
// должна быть заметна на нескольких улицах даже при ограничении населения всей карты.
const DENSITY = [1, 3, 6, 10, 15] as const;
const DECISION_INTERVAL = 0.18;

/** Последовательность ван дер Корпута: каждые 2^k жителей занимают все равные 2^k частей сети.
 * Сдвиг битов от зерна меняет расстановку, сохраняя это равновесие у любой ступени численности. */
function spawnFraction(index: number, scramble: number): number {
  let bits = (index ^ scramble) >>> 0;
  let result = 0;
  for (let place = 0.5; bits; place *= 0.5, bits >>>= 1) result += (bits & 1) * place;
  return result;
}

/** Линия от инструмента или вход в переход могут примыкать в середину тротуара. В этом месте создаём развилку. */
function* walkingNetworkSteps(sidewalks: SidewalkNet, paths: readonly Footpath[], crossings: Iterable<GraphWalk[]>): Generator<void, Map<string, WalkEdge>> {
  const corners = new Map<string, Corner>();
  const edges = new Map<string, WalkEdge>();
  const street: Segment[] = [];
  const nearby = new Map<string, Segment[]>();
  const corner = (p: Vec) => {
    const key = pointKey(p);
    let c = corners.get(key);
    if (!c) corners.set(key, c = { ...p, key, links: [] });
    return c;
  };
  const connect = (p: Vec, q: Vec, crossing?: GraphWalk) => {
    const a = corner(p);
    const b = corner(q);
    const length = dist(a, b);
    if (a === b || length < 0.01) return;
    const pair = a.key < b.key ? a.key + '/' + b.key : b.key + '/' + a.key;
    const key = pair + (crossing ? ':' + walkKey(crossing) + (crossing.underground ? 'u' : '') : '');
    if (edges.has(key)) return;
    const edge = { key, a, b, length, crossing };
    a.links.push(edge);
    b.links.push(edge);
    edges.set(key, edge);
  };
  // Пешеход выбирает направление на следующей развилке. Точки коллинеарного участка ему не нужны.
  const index = (a: Vec, b: Vec) => {
    const length = dist(a, b);
    if (length < 0.05) return;
    const segment: Segment = { a, b, cuts: [] };
    street.push(segment);
    const steps = Math.ceil(length / (CELL / 2));
    let last = '';
    for (let i = 0; i <= steps; i++) {
      const p = lerp(a, b, i / steps);
      const k = Math.floor(p.x / CELL) + ':' + Math.floor(p.y / CELL);
      if (k === last) continue;
      last = k;
      const cell = nearby.get(k);
      if (cell) cell.push(segment);
      else nearby.set(k, [segment]);
    }
  };
  let processed = 0;
  for (const l of sidewalks.lines) for (const path of l.paths) {
    if (++processed % 64 === 0) yield;
    if (path.length < 4) continue;
    let start = { x: path[0], y: path[1] };
    let end = { x: path[2], y: path[3] };
    for (let i = 4; i < path.length; i += 2) {
      const next = { x: path[i], y: path[i + 1] };
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      if (Math.abs(dx * (next.y - end.y) - dy * (next.x - end.x)) > 0.001 || dx * (next.x - end.x) + dy * (next.y - end.y) < 0) {
        index(start, end);
        start = end;
      }
      end = next;
    }
    index(start, end);
  }
  const join = (p: Vec, radius: number) => {
    let gap = radius;
    let best: Segment | undefined;
    let hit: ReturnType<typeof closestOnSegment> | undefined;
    const cx = Math.floor(p.x / CELL);
    const cy = Math.floor(p.y / CELL);
    for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
      for (const s of nearby.get(x + ':' + y) ?? []) {
        // В клетке много коротких отрезков дуг. Проецируем только те, которые ещё могут быть ближе.
        if (p.x + gap < Math.min(s.a.x, s.b.x) || p.x - gap > Math.max(s.a.x, s.b.x)
          || p.y + gap < Math.min(s.a.y, s.b.y) || p.y - gap > Math.max(s.a.y, s.b.y)) continue;
        const q = closestOnSegment(p, s.a, s.b);
        if (q.d > gap) continue;
        gap = q.d;
        hit = q;
        best = s;
      }
    }
    if (best && hit) {
      best.cuts.push({ t: hit.t, p: hit.point });
      connect(p, hit.point);
      return true;
    }
    return false;
  };
  const yardSpans: { a: Vec; b: Vec }[] = [];
  for (const yard of sidewalks.yards ?? []) for (const line of yard.paths) {
    if (line.length < 4) continue;
    const last = line.length - 2;
    // Дворовые дорожки заходят за край тротуара, поэтому соединяем их концы с его осью.
    join({ x: line[0], y: line[1] }, 2);
    join({ x: line[last], y: line[last + 1] }, 2);
    for (let i = 2; i < line.length; i += 2) {
      yardSpans.push({ a: { x: line[i - 2], y: line[i - 1] }, b: { x: line[i], y: line[i + 1] } });
    }
    if (++processed % 64 === 0) yield;
  }
  for (const p of paths) {
    if (++processed % 64 === 0) yield;
    join(p.a, 0.8);
    join(p.b, 0.8);
  }
  for (const p of footpathNetwork([...paths, ...yardSpans])) index(p.a, p.b);
  for (const list of crossings) for (const w of list) {
    if (++processed % 32 === 0) yield;
    const [a, b] = w.geo.ends;
    for (const [side, mouth] of w.geo.ends.entries()) {
      const approach = w.geo.approaches?.[side];
      if (approach) {
        // С тротуара и дорожек прежних сохранений — по площадке до нового входа.
        if (join(approach, 2)) connect(approach, mouth);
        join(mouth, 0.8);
      } else join(mouth, 6);
    }
    connect(a, b, w);
  }
  for (const s of street) {
    if (++processed % 256 === 0) yield;
    let prev = s.a;
    for (const { p } of s.cuts.sort((l, r) => l.t - r.t)) {
      connect(prev, p);
      prev = p;
    }
    connect(prev, s.b);
  }
  return edges;
}

/** Для редактирования и первой прогулки — собрать сеть сразу. На границе месяца используется тот же генератор. */
export function walkingNetwork(sidewalks: SidewalkNet, paths: readonly Footpath[], crossings: Iterable<GraphWalk[]>) {
  const steps = walkingNetworkSteps(sidewalks, paths, crossings);
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

interface Walker {
  seed: number;
  visits: number;
  speed: number;
  edge: WalkEdge;
  reverse: boolean;
  start: number;
  end: number;
  /** Уже выбранный следующий переход — ждём, пока машины пропустят. */
  next?: WalkEdge;
  /** Изменение темпа до следующей оценки свободного места. */
  slowed?: { since: number; pace: number };
  /** Смещение от оси в мировых координатах — плавное и на поворотах. */
  sidestep?: { since: number; from: Vec; to: Vec };
}

const noOffset = { x: 0, y: 0 };
function offsetAt(w: Walker, time: number): Vec {
  const s = w.sidestep;
  return s ? lerp(s.from, s.to, Math.min(1, Math.max(0, (time - s.since) / DECISION_INTERVAL))) : noOffset;
}

function centerAt(w: Walker, time: number): Vec {
  const t = w.slowed ? time - (time - w.slowed.since) * (1 - w.slowed.pace) : time;
  const u = Math.max(0, Math.min(1, (t - w.start) / (w.end - w.start)));
  return lerp(w.edge.a, w.edge.b, w.reverse ? 1 - u : u);
}

export class Pedestrians {
  on = false;
  level: PedestrianLevel = 1;
  readonly walkers: Walker[] = [];
  private edges?: Map<string, WalkEdge>;
  private starts: { edge: WalkEdge; weight: number; end: number }[] = [];
  private spawnWeight = 0;
  private networkLength = 0;
  private sidewalks?: SidewalkNet;
  private paths?: readonly Footpath[];
  private graph?: LaneGraph;
  private prepared?: { sidewalks: SidewalkNet; paths: readonly Footpath[]; graph: LaneGraph; edges: Map<string, WalkEdge> };
  private nextStep = 0;

  reset(): void {
    this.walkers.length = 0;
    this.edges = undefined;
    this.starts = [];
    this.spawnWeight = 0;
    this.networkLength = 0;
    this.sidewalks = this.paths = this.graph = undefined;
    this.prepared = undefined;
    this.nextStep = 0;
  }

  /** После роста городов — подготовить сеть по кадрам. Жители переходят на неё в обычный такт решения. */
  *prepareMonth(game: Game): Generator<void> {
    if (!this.on) return;
    const sidewalks = gameSidewalks(game);
    const paths = game.openFootpaths();
    const graph = game.roads.graph;
    if (sidewalks === this.sidewalks && paths === this.paths && graph === this.graph) return;
    yield;
    const edges = yield* walkingNetworkSteps(sidewalks, paths, graph.crosswalks.values());
    if (this.on) this.prepared = { sidewalks, paths, graph, edges };
  }

  /** Переключение уровня в меню действует и на паузе с уже рассчитанной сетью дорожек. */
  refreshPopulation(game: Game): void {
    this.sync(game, game.time, true);
  }

  private sync(game: Game, time: number, resize = false): void {
    const sidewalks = gameSidewalks(game);
    const paths = game.openFootpaths();
    const graph = game.roads.graph;
    const same = this.sidewalks === sidewalks && this.paths === paths && this.graph === graph;
    if (same && !resize) return;
    if (!same || !this.edges) {
      this.sidewalks = sidewalks;
      this.paths = paths;
      this.graph = graph;
      const ready = this.prepared;
      this.prepared = undefined;
      this.edges = ready?.sidewalks === sidewalks && ready.paths === paths && ready.graph === graph
        ? ready.edges : walkingNetwork(sidewalks, paths, graph.crosswalks.values());
      // На один метр аллеи или тротуара в центре города приходится больше прохожих, чем на окраине.
      // Вместимость карты по-прежнему определяется действительной длиной всей сети.
      const cells = new Map<string, typeof this.starts>();
      this.spawnWeight = this.networkLength = 0;
      for (const edge of this.edges.values()) {
        if (edge.crossing) continue;
        const mid = lerp(edge.a, edge.b, 0.5);
        let centrality = 0;
        for (const town of game.towns) {
          // Главные улицы и парки в центральной половине поселения притягивают прогулки; остальная сеть
          // получает свою долю по длине, включая пользовательские дорожки за городами.
          const radius = town.radius / 2;
          const dx = mid.x - town.center.x, dy = mid.y - town.center.y;
          if (Math.abs(dx) < radius && Math.abs(dy) < radius) {
            centrality = Math.max(centrality, 1 - Math.hypot(dx, dy) / radius);
          }
        }
        const weight = edge.length * (1 + 10 * centrality ** 2);
        const key = Math.floor(mid.x / 80) + ':' + Math.floor(mid.y / 80);
        const cell = cells.get(key);
        const entry = { edge, weight, end: 0 };
        if (cell) cell.push(entry);
        else cells.set(key, [entry]);
        this.networkLength += edge.length;
      }
      this.starts = Array.from(cells.values()).flat();
      for (const entry of this.starts) entry.end = this.spawnWeight += entry.weight;
    }
    const edges = this.edges;
    const total = this.networkLength;
    const base = Math.min(BASE_POPULATION_LIMIT, total / 85);
    const n = Math.ceil(base * DENSITY[this.level - 1]);
    this.walkers.length = Math.min(this.walkers.length, n);
    const missing: number[] = [];
    for (let i = 0; i < n; i++) {
      const w = this.walkers[i];
      const previous = w && edges.get(w.edge.key);
      if (previous) {
        if (previous.a.key !== w.edge.a.key) w.reverse = !w.reverse;
        w.edge = previous;
        w.next = w.next && edges.get(w.next.key);
      } else missing.push(i);
    }
    if (!missing.length) return;
    // Наборы вложены: прямой выбор уровня на паузе и выбор по очереди дают тех же жителей.
    const scramble = Math.floor(hash(game.seed, 0) * 2 ** 32);
    for (const i of missing) {
      const starts = this.starts;
      const seed = game.seed + i * 4099;
      const at = spawnFraction(i, scramble) * this.spawnWeight;
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (at < starts[mid].end) hi = mid;
        else lo = mid + 1;
      }
      const { edge, weight, end } = starts[lo];
      const speed = 2.4 + hash(seed, 1) * 1.1;
      const reverse = hash(seed, 2) < 0.5;
      const distance = edge.length * (1 - (end - at) / weight);
      const progress = reverse ? edge.length - distance : distance;
      const start = time - progress / speed;
      this.walkers[i] = { seed, visits: 0, speed, edge, reverse, start, end: start + edge.length / speed };
    }
  }

  step(game: Game): void {
    const time = game.time;
    if (!this.on || time < this.nextStep) return;
    this.nextStep = time + DECISION_INTERVAL;
    this.sync(game, time);
    const people: (WalkIntent & { walker: Walker })[] = [];
    for (const w of this.walkers) {
      if (w.slowed) {
        const pause = (time - w.slowed.since) * (1 - w.slowed.pace);
        w.start += pause;
        w.end += pause;
        w.slowed = undefined;
      }
      // На дуге много коротких участков. Остаток шага переносим на следующий, чтобы на повороте не замедляться.
      while (time >= w.end) {
        const at = w.reverse ? w.edge.a : w.edge.b;
        if (!w.next) {
          const choices = at.links.filter((x) => x !== w.edge);
          w.next = choices[Math.floor(hash(w.seed, ++w.visits) * choices.length)] ?? w.edge;
        }
        const next = w.next;
        const duration = next.length / (next.crossing ? XWALK.speed : w.speed);
        const surface = next.crossing && !next.crossing.underground;
        if (surface && !game.crosswalks.enter(walkKey(next.crossing!), time, time - w.end, duration, this.graph!, game.traffic)) break;
        w.edge = next;
        w.reverse = next.b === at;
        w.start = surface ? time : Math.max(w.end, time - DECISION_INTERVAL);
        w.end = w.start + duration;
        w.next = undefined;
      }
      if (w.edge.crossing?.underground) {
        w.sidestep = undefined;
        continue;
      }
      const { a, b, length } = w.edge;
      const sign = (w.reverse ? -1 : 1) / length;
      people.push({
        pos: centerAt(w, time), dir: { x: (b.x - a.x) * sign, y: (b.y - a.y) * sign },
        speed: time < w.end ? length / (w.end - w.start) : 0, crossing: !!w.edge.crossing, seed: w.seed,
        pace: 1, side: 0, offset: offsetAt(w, time), walker: w,
      });
    }
    // Оценка раз в DECISION_INTERVAL, на ближайшем такте физики.
    const horizon = DECISION_INTERVAL + SIM_DT;
    leaveWalkingSpace(people, horizon);
    for (const p of people) {
      const w = p.walker;
      if (p.pace < 1) {
        w.slowed = { since: time, pace: p.pace };
        if (w.edge.crossing) game.crosswalks.extend(walkKey(w.edge.crossing), w.end + horizon * (1 - p.pace));
      }
      if (p.side || w.sidestep) {
        const to = { x: -p.dir.y * p.side, y: p.dir.x * p.side };
        const distance = dist(p.offset, to);
        if (!p.side && distance < 0.01) w.sidestep = undefined;
        else w.sidestep = { since: time, from: p.offset, to: lerp(p.offset, to, Math.min(1, (1.6 * DECISION_INTERVAL) / (distance || 1))) };
      }
    }
  }

  /** Положение между решениями интерполируется по игровому времени, включая паузу. */
  *visible(time: number, view?: Box) {
    if (!this.on) return;
    for (const w of this.walkers) {
      if (w.edge.crossing?.underground) continue;
      const { a, b } = w.edge;
      // Большинство фигур за кадром. Отбрасываем целые отрезки до интерполяции положения с шагом в сторону.
      if (view && ((a.x < view.x0 - 3 && b.x < view.x0 - 3) || (a.x > view.x1 + 3 && b.x > view.x1 + 3)
        || (a.y < view.y0 - 3 && b.y < view.y0 - 3) || (a.y > view.y1 + 3 && b.y > view.y1 + 3))) continue;
      const pos = centerAt(w, time);
      if (w.sidestep) {
        const offset = offsetAt(w, time);
        pos.x += offset.x;
        pos.y += offset.y;
      }
      if (view && (pos.x < view.x0 - 2 || pos.x > view.x1 + 2 || pos.y < view.y0 - 2 || pos.y > view.y1 + 2)) continue;
      const heading = Math.atan2(b.y - a.y, b.x - a.x) + (w.reverse ? Math.PI : 0);
      yield { pos, seed: w.seed, heading, walking: time < w.end && (w.slowed?.pace ?? 1) > 0.1 };
    }
  }
}
