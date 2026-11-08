/** Помощники для тестов: дороги через строителя игры на сети полос, грузовой маршрут, прогон симуляции. */
import { MONTH_LENGTH } from '../config';
import { add, dist, scale, type Vec } from '../core/vec';
import { Anchor, anchorAt, RoadOptions } from '../lanes/edit';
import { Corridor, LaneNode, twoWay } from '../lanes/model';
import type { IndustryKind } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import { RAIL_SPEC, type RoadClass } from '../world/roadTypes';
import type { RoadRequest } from './build';
import { Game } from './game';
import type { RoadPlan } from './roadbuild';

export const STREET = { cls: 'street' as RoadClass, lanes: twoWay(1, 1) };
export const AVENUE = { cls: 'avenue' as RoadClass, lanes: twoWay(2, 2) };
export const HIGHWAY = { cls: 'highway' as RoadClass, lanes: twoWay(1, 1) };

/** Игра вперёд на seconds игровых секунд кадрами по 0.1 с на скорости 1; each — после каждого кадра. */
export function runSeconds(game: Game, seconds: number, each?: () => void): void {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) {
    game.update(0.1);
    each?.();
  }
}

/**
 * Игра вперёд на months игровых месяцев (как runSeconds) — и ещё кадр: время партии копится шагами по 1/30 с,
 * и ровно months · MONTH_LENGTH секунд кадрами по 0.1 с может не дотянуть до границы месяца на доли наносекунды.
 */
export function runMonths(game: Game, months: number, each?: () => void): void {
  runSeconds(game, months * MONTH_LENGTH + 0.1, each);
}

/**
 * Города без машин жителей: дома, жители и рост на месте, но поездок жители не начинают. Машины жителей
 * (до 400 на карте) — почти весь счёт симуляции: месяц игры с ними — секунды, без них — сотые доли. Только для
 * тестов, где они ни при чём: маршрут — отдельная сеть в стороне от городов (трасса между станциями
 * предприятий, пути в чистом поле), куда машины жителей не попадают. Игру из сохранения — так же, заново.
 * Спецтранспорт городов (скорая, полиция, пожарная) тоже не выезжает.
 */
export function withoutCitizens<G extends Game>(game: G): G {
  (game as unknown as { spawnCitizenTrip(): void }).spawnCitizenTrip = () => {};
  (game as unknown as { serviceTrips(): void }).serviceTrips = () => {};
  return game;
}

/** Ближайшая пара предприятий: производитель from и получатель to. */
export function nearestPair(game: Game, from: IndustryKind, to: IndustryKind): { a: Industry; b: Industry } {
  const pairs = game.industries
    .filter((i) => i.info.kind === from)
    .flatMap((a) => game.industries.filter((i) => i.info.kind === to).map((b) => ({ a, b, d: dist(a.fp.center, b.fp.center) })))
    .sort((x, y) => x.d - y.d);
  return pairs[0];
}

/**
 * Грузовой маршрут между ближайшей парой предприятий (по умолчанию ферма → пищекомбинат): денег с запасом,
 * станции вплотную к обоим, выезды соединены шоссе 1+1 (built — получилось), линия пока без транспорта.
 */
export function freightRoute(game: Game, from: IndustryKind = 'farm', to: IndustryKind = 'foodplant', profile: RoadOptions = HIGHWAY) {
  game.money = 5_000_000;
  const { a, b } = nearestPair(game, from, to);
  const sA = stationAtIndustry(game, a, b.fp.center)!;
  const sB = stationAtIndustry(game, b, a.fp.center)!;
  const built = connectStations(game, sA, sB, profile);
  return { built, line: game.createLine([sA.id, sB.id])!, from: a, to: b, sA, sB };
}

/** Узел (id), точка (привязка как у игрока: к узлу или дороге рядом) или свободная точка. */
export type End = number | Vec | { free: Vec };

export function anchorOf(game: Game, x: End): Anchor {
  const net = game.roads.net;
  if (typeof x === 'number') return { kind: 'node', node: x, pos: net.node(x).pos };
  if ('free' in x) return { kind: 'free', pos: x.free };
  return anchorAt(net, x, 14);
}

/** План дороги от a до b (kink — из тупика под углом, а не плавно). */
export function roadPlan(game: Game, a: End, b: End, profile: RoadOptions = STREET): RoadPlan {
  return game.roadBuilder.road(anchorOf(game, a), anchorOf(game, b), profile);
}

/** Строит дорогу от a до b; true — построилась. */
export function road(game: Game, a: End, b: End, profile: RoadOptions = STREET): boolean {
  const plan = roadPlan(game, a, b, profile);
  return plan.ok && game.roadBuilder.apply(plan);
}

/** Узел на другом конце выезда станции — там выезд примыкает к дороге (или кончается). */
export function stationExit(game: Game, nodeId: number): LaneNode {
  const net = game.roads.net;
  const c = net.corridor(net.node(nodeId).corridors[0]);
  return net.node(c.a === nodeId ? c.b : c.a);
}

/** Станция вплотную к предприятию — со стороны точки toward (или с соседних сторон, если там нельзя). */
export function stationAtIndustry(game: Game, ind: Industry, toward: Vec): Station | null {
  const base = Math.atan2(toward.y - ind.fp.center.y, toward.x - ind.fp.center.x);
  for (const k of [0, 1, -1, 2]) {
    const a = base + (k * Math.PI) / 2;
    const reach = Math.hypot(ind.fp.w, ind.fp.h) / 2 + 20;
    const st = game.placeStation({ x: ind.fp.center.x + Math.cos(a) * reach, y: ind.fp.center.y + Math.sin(a) * reach }, 14);
    if (st) return st;
  }
  return null;
}

/** Соединяет выезды двух станций дорогой из двух кусков (середина сдвигается, если прямо нельзя). */
export function connectStations(game: Game, sA: Station, sB: Station, profile: RoadOptions): boolean {
  const A = stationExit(game, sA.nodeId);
  const B = stationExit(game, sB.nodeId);
  const d = { x: B.pos.x - A.pos.x, y: B.pos.y - A.pos.y };
  const n = { x: -d.y / Math.hypot(d.x, d.y), y: d.x / Math.hypot(d.x, d.y) };
  for (const off of [0, 150, -150, 300, -300, 450, -450, 600, -600]) {
    const M = { x: (A.pos.x + B.pos.x) / 2 + n.x * off, y: (A.pos.y + B.pos.y) / 2 + n.y * off };
    if (!roadPlan(game, A.id, { free: M }, profile).ok) continue;
    road(game, A.id, { free: M }, profile);
    if (road(game, M, B.id, profile)) return true;
  }
  return false;
}

/** Улицы города, которые есть сейчас. */
export function townStreets(game: Game, townId: number): Corridor[] {
  const town = game.towns.find((t) => t.id === townId)!;
  const net = game.roads.net;
  const own = town.streets.map((id) => net.corridors.get(id)).filter((c): c is Corridor => !!c);
  return own.length ? own : net.corridorsNear(town.center, town.radius);
}

/** Прямой ж/д путь от from до to (instant — готов сразу и «Со строительством»). */
export function railTrack(game: Game, from: Vec, to: Vec, instant = false): RoadRequest {
  return { start: game.builder.snap(from, 0, 14), end: { kind: 'free', pos: to, level: 0 }, spec: RAIL_SPEC, mode: 'straight', ...(instant ? { instant: true as const } : {}) };
}

/** Партия «Со строительством» для ж/д стройки: мир без воды, денег с запасом. */
export const RAIL_WORLD = { seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' } as const;

/**
 * Партия «Со строительством»: готовый путь 1200 м с вокзалом a, от его конца — ж/д проект ещё на 1200 м с вокзалом b
 * на нём. Ни дорог рядом, ни строительных баз: путь строит строительный поезд с вокзала a. Пути — в чистом поле вдали
 * от городов (без машин жителей).
 */
export function railProjectScene(): { game: Game; a: Station; b: Station; id: number; from: Vec; dir: Vec } {
  const game = withoutCitizens(new Game(RAIL_WORLD));
  const len = 2400;
  for (let y = 500; y < game.terrain.height - 500; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      const from = { x, y };
      const dir = { x: 1, y: 0 };
      const mid = add(from, scale(dir, len / 2));
      const end = add(from, scale(dir, len));
      if (!game.builder.plan(railTrack(game, from, end, true)).ok) continue;
      game.checkpoint('проба');
      const ok = (() => {
        if (!game.builder.build(railTrack(game, from, mid, true))) return false;
        const a = game.stationPlan(add(add(from, scale(dir, 400)), { x: 0, y: 40 }), 14, 'rail');
        if (!a.ok) return false;
        return game.builder.plan(railTrack(game, mid, end)).ok;
      })();
      game.commit();
      if (!ok) {
        game.undo();
        continue;
      }
      const id = game.construction.peekId();
      if (!game.builder.build(railTrack(game, mid, end))) throw new Error('проект не лёг');
      const a = game.placeStation(add(add(from, scale(dir, 400)), { x: 0, y: 40 }), 14, 'rail')!;
      const b = game.placeStation(add(add(from, scale(dir, len - 400)), { x: 0, y: 40 }), 14, 'rail')!;
      if (!a || !b) throw new Error('вокзалы не встали');
      return { game, a, b, id, from, dir };
    }
  }
  throw new Error('нет места');
}

/** Чистое поле: ни домов, ни предприятий, ни дорог, ни воды на margin вокруг отрезка длиной length (с запада на восток). */
export function fieldSpot(game: Game, length: number, margin = 180): Vec {
  const { width, height } = game.terrain;
  for (let y = 300; y < height - 300; y += 83) {
    for (let x = 300; x < width - 300 - length; x += 97) {
      const mid = { x: x + length / 2, y };
      const reach = length / 2 + margin;
      if (game.index.near(mid, reach).some((s) => dist(s.fp.center, mid) < reach + 40)) continue;
      if (game.roads.net.corridorsNear(mid, reach).length || game.net.segmentsNear(mid, reach).length) continue;
      let wet = false;
      for (let s = -margin; s <= length + margin && !wet; s += 20) {
        for (const dy of [-margin, -margin / 2, 0, margin / 2, margin]) if (game.isWater({ x: x + s, y: y + dy }, 10)) wet = true;
      }
      if (!wet) return { x, y };
    }
  }
  throw new Error('Нет чистого поля');
}
