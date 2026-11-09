import { Cubic, CurveLUT, minRadius } from '../core/bezier';
import { Rng } from '../core/rng';
import { add, angleOf, angleDiff, dist, dot, norm, rightNormal, scale, sub, Vec } from '../core/vec';
import { buildRoad, type Anchor } from '../lanes/edit';
import { edgesAt } from '../lanes/geometry';
import { twoWay, type Corridor, type LaneNet, type LaneNode } from '../lanes/model';
import type { IndustryKind } from './cargo';
import type { Industry, Town } from './entities';
import { halfWidth, isDirt, ROAD_MARGIN, type RoadSpec } from './roadTypes';
import { pointInFootprint } from './spatial';
import type { WorldContext } from './worldgen';

/**
 * Стартовые просёлки: мир на старте уже с грунтовыми дорогами — от части предприятий к ближнему городу (ферма
 * не стоит в чистом поле) и от городов у края карты за край (город не стоит особняком). Это обычные полотна сети
 * класса «Грунтовая»: сохраняются вместе с дорогами (SaveData.roads), игрок сносит и перестраивает их, как любые.
 * Случайность — своя, от seed: ни города, ни предприятия, ни ход партии по seed от них не меняются.
 */

export const DIRT_SPEC: RoadSpec = { cls: 'dirt', lanesF: 1, lanesB: 1 };
const DIRT = { cls: DIRT_SPEC.cls, lanes: twoWay(1, 1) };
const HALF = halfWidth(DIRT_SPEC);

export const START_ROADS = {
  /** Дальше этого от города (по длине дороги) до края карты просёлок не тянем: город далеко от края. */
  edgeReach: 900,
  /** Дорога к предприятию — не длиннее. */
  industryReach: 1500,
  /**
   * Тупик просёлка у предприятия — на столько от стены: там же, где выезд грузового двора (Game.industryStationPlan
   * берёт это число), — двор, поставленный с этой стороны, встаёт напротив просёлка и подключается к нему сам.
   */
  industryExit: 64,
  /** Доля предприятий с дорогой: хозяйства и лесопилки — чаще, прочее сырьё — реже, заводы — ещё реже. */
  share: { rural: 0.7, raw: 0.45, plant: 0.35 },
  /** Уклон вдоль дороги не круче (м/м) — по горе просёлок не идёт. */
  grade: 0.12,
  /** Радиус поворота не меньше, м. */
  radius: 45,
  /** Шаг проверки по длине, м. */
  step: 8,
  /** Сколько ближних мест примыкания пробовать. */
  tries: 14,
};

/** Сельские предприятия: к ним просёлок — чаще всего. */
const RURAL = new Set<IndustryKind>(['farm', 'forest', 'ranch', 'flaxfarm', 'fishery', 'sheepfarm', 'sunflower', 'cottonfarm', 'sawmill']);

/** Откуда пойдёт просёлок: узел или место на полотне и направление, в котором дорога из него выходит. */
interface Start {
  anchor: Anchor;
  dir: Vec;
  /** Полотна, вплотную к которым дорога может идти у самого начала. */
  host: Set<number>;
}

/** Готовый вариант дороги: кривая и откуда. */
interface Route {
  start: Start;
  curve: Cubic;
  length: number;
}

const seedOf = (seed: number) => (Math.imul(seed ^ 0x5d1a7e, 0x9e3779b1) ^ 0x2c1b3c6d) >>> 0;

/** Прокладывает стартовые просёлки. Вызывается в конце генерации мира, когда города и предприятия уже стоят. */
export function layStartRoads(ctx: WorldContext, towns: Town[], industries: Industry[], seed: number): void {
  if (!towns.length) return;
  const rng = new Rng(seedOf(seed));
  // Сначала — от городов за край карты, потом — к предприятиям (они могут ответвиться и от этих дорог).
  for (const town of towns) {
    const route = edgeRoute(ctx, town);
    if (route) lay(ctx, towns, route);
  }
  const chosen = industries.filter((ind) => {
    const kind = ind.info.kind;
    const p = RURAL.has(kind) ? START_ROADS.share.rural : ind.info.accepts.length ? START_ROADS.share.plant : START_ROADS.share.raw;
    return rng.chance(p);
  });
  // Ближние к городам — первыми: дальние ответвятся от их просёлков, а не потянут свои через всё поле.
  const near = (ind: Industry) => Math.min(...towns.map((t) => dist(t.center, ind.fp.center) - (t.extent ?? t.radius)));
  for (const ind of chosen.sort((a, b) => near(a) - near(b) || a.id - b.id)) {
    const route = industryRoute(ctx, ind, towns);
    if (route) lay(ctx, towns, route);
  }
}

/** Кладёт дорогу в сеть; разрезанная ею улица города остаётся в его списке улиц (обоими кусками). */
function lay(ctx: WorldContext, towns: Town[], r: Route): Corridor[] {
  const net = ctx.roads;
  const before = new Set(net.corridors.keys());
  const made = buildRoad(net, r.start.anchor, { kind: 'free', pos: r.curve.p3 }, { ...DIRT, curve: r.curve });
  const fresh = [...net.corridors.values()].filter((c) => !before.has(c.id) && !made.includes(c));
  for (const t of towns) {
    if (t.streets.every((id) => net.corridors.has(id))) continue;
    t.streets = [...t.streets.filter((id) => net.corridors.has(id)), ...fresh.filter((c) => !isDirt(c.cls)).map((c) => c.id)];
  }
  return made;
}

/** Узлы и полотна города, откуда можно начать дорогу в сторону target: перекрёстки и места на улицах. */
function startsToward(net: LaneNet, town: Town, target: Vec, dirAt?: (p: Vec) => Vec): Start[] {
  const res: Start[] = [];
  const toward = (p: Vec) => dirAt?.(p) ?? norm(sub(target, p));
  const streets = town.streets.map((id) => net.corridors.get(id)).filter((c): c is Corridor => !!c && !c.ring);
  const nodes = new Set<number>();
  for (const c of streets) nodes.add(c.a).add(c.b);
  for (const id of nodes) {
    const n = net.node(id);
    if (n.level !== 0) continue;
    const d = toward(n.pos);
    // Тупик улицы не продолжаем: на нём разворачиваются машины жителей и автобусы, а за ним они уезжали бы
    // разворачиваться в конец просёлка — к предприятию или на край карты.
    if (net.isDeadEnd(n)) continue;
    if (n.kind !== 'junction' || n.corridors.length > 3 || !freeArm(net, n, d)) continue;
    res.push({ anchor: { kind: 'node', node: n.id, pos: n.pos }, dir: d, host: new Set(n.corridors) });
  }
  // Ответвление посреди улицы — под прямым углом к ней, в ту сторону, где цель.
  for (const c of streets) {
    if (net.node(c.a).level !== 0 || net.node(c.b).level !== 0) continue;
    const hit = c.lut.closest(target);
    const s = Math.max(30, Math.min(c.length - 30, hit.s));
    if (c.length < 60) continue;
    const p = c.lut.pointAt(s);
    let nrm = rightNormal(c.lut.tangentAt(s));
    const d = toward(p);
    if (dot(nrm, d) < 0) nrm = scale(nrm, -1);
    if (dot(nrm, d) < 0.6) continue;
    res.push({ anchor: { kind: 'corridor', corridor: c.id, s, pos: p }, dir: nrm, host: new Set([c.id]) });
  }
  return res;
}

/** У перекрёстка есть место для нового подъезда в направлении d: до каждого прежнего — не меньше 55°. */
function freeArm(net: LaneNet, n: LaneNode, d: Vec): boolean {
  const a = angleOf(d);
  return net.ends(n).every((e) => Math.abs(angleDiff(angleOf(e.away), a)) > (55 * Math.PI) / 180);
}

/**
 * Кривая от начала к концу end, где дорога приходит по направлению arrive. Ручки — по трети хорды:
 * плавный изгиб от перекрёстка или улицы к цели.
 */
function curveFor(start: Start, end: Vec, arrive: Vec): Cubic {
  const p0 = start.anchor.pos;
  const h = dist(p0, end) / 3;
  return { p0, p1: add(p0, scale(start.dir, h)), p2: sub(end, scale(arrive, h)), p3: end };
}

/**
 * Можно ли так проложить: поворот не круче, в карте — ни воды, ни зданий, ни чужих дорог рядом (у начала можно
 * вплотную к своей улице), уклон не круче. Точки за краем карты (дорога уходит за край) не проверяются.
 */
function routeOk(ctx: WorldContext, start: Start, curve: Cubic, target?: Industry): Route | null {
  const { terrain, roads, index } = ctx;
  if (minRadius(curve) < START_ROADS.radius) return null;
  const lut = new CurveLUT(curve);
  const L = lut.length;
  const step = START_ROADS.step;
  let prevH: number | null = null;
  for (let s = step; s <= L; s += step) {
    const p = lut.pointAt(s);
    if (!terrain.inBounds(p, 0)) {
      prevH = null;
      continue;
    }
    if (terrain.isWater(p, HALF + 6)) return null;
    const h = terrain.heightAt(p);
    if (prevH !== null && Math.abs(h - prevH) / step > START_ROADS.grade) return null;
    prevH = h;
    for (const it of index.near(p, HALF + 60)) if (it !== target && pointInFootprint(p, it.fp, HALF + 4)) return null;
    // Своё предприятие — дорога подходит к стене, но не заходит на двор будущей станции.
    if (target && s < L - 20 && pointInFootprint(p, target.fp, HALF + START_ROADS.industryExit - 20)) return null;
    for (const o of roads.corridorsNear(p, HALF + 40)) {
      if (start.host.has(o.id) && s < 45) continue;
      const hit = o.lut.closest(p);
      if (hit.d < HALF + halfAt(o, hit.s) + 10) return null;
    }
  }
  return { start, curve, length: L };
}

/** Первая годная дорога из вариантов, ближние — раньше. */
function firstRoute(ctx: WorldContext, cands: { start: Start; curve: Cubic }[], reach: number, target?: Industry): Route | null {
  const scored = cands
    .map((c) => ({ ...c, d: dist(c.curve.p0, c.curve.p3) }))
    .filter((c) => c.d <= reach)
    .sort((a, b) => a.d - b.d)
    .slice(0, START_ROADS.tries);
  for (const c of scored) {
    const r = routeOk(ctx, c.start, c.curve, target);
    if (r && r.length <= reach) return r;
  }
  return null;
}

/** Края карты: наружная нормаль и расстояние до края от точки. */
function edges(w: number, h: number): { out: Vec; gap: (p: Vec) => number }[] {
  return [
    { out: { x: -1, y: 0 }, gap: (p) => p.x },
    { out: { x: 1, y: 0 }, gap: (p) => w - p.x },
    { out: { x: 0, y: -1 }, gap: (p) => p.y },
    { out: { x: 0, y: 1 }, gap: (p) => h - p.y },
  ];
}

/**
 * Дорога от города за ближний край карты, если до него недалеко: от перекрёстка или улицы — прямо, пока она смотрит
 * к краю (не дальше 30° от перпендикуляра), иначе с изгибом и к краю под прямым углом. Тупик — ровно на краю: разворот
 * там не рисуется (LaneRenderer.inMap), дорога обрывается краем карты — уходит за него.
 */
export function edgeRoute(ctx: WorldContext, town: Town): Route | null {
  const { terrain, roads } = ctx;
  const extent = town.extent ?? town.radius;
  const cands: { start: Start; curve: Cubic }[] = [];
  for (const e of edges(terrain.width, terrain.height)) {
    if (e.gap(town.center) - extent > START_ROADS.edgeReach) continue;
    // Цель — на краю напротив точки: каждому началу — своя.
    for (const start of startsToward(roads, town, add(town.center, scale(e.out, e.gap(town.center))), () => e.out)) {
      const p0 = start.anchor.pos;
      const g = e.gap(p0);
      const cos = dot(start.dir, e.out);
      if (cos <= 0.2) continue;
      const straight = cos > Math.cos(Math.PI / 6);
      const end = straight ? add(p0, scale(start.dir, g / cos)) : add(p0, scale(e.out, g));
      cands.push({ start, curve: curveFor(start, end, straight ? start.dir : e.out) });
    }
  }
  return firstRoute(ctx, cands, START_ROADS.edgeReach);
}

/**
 * Дорога от ближнего города к предприятию: к середине стены, обращённой к городу, тупиком у выезда грузового
 * двора (START_ROADS.industryExit). Начало — перекрёсток или место на улице любого города (не тупик), а также
 * просёлок, проложенный раньше (к соседнему предприятию или за край).
 */
export function industryRoute(ctx: WorldContext, ind: Industry, towns: Town[]): Route | null {
  const { roads } = ctx;
  const fp = ind.fp;
  const u = { x: Math.cos(fp.angle), y: Math.sin(fp.angle) };
  const v = { x: -u.y, y: u.x };
  const sides = [
    { n: u, half: fp.w / 2 },
    { n: scale(u, -1), half: fp.w / 2 },
    { n: v, half: fp.h / 2 },
    { n: scale(v, -1), half: fp.h / 2 },
  ];
  const exitOf = (s: (typeof sides)[number]) => add(fp.center, scale(s.n, s.half + START_ROADS.industryExit));
  const cands: { start: Start; curve: Cubic }[] = [];
  const add2 = (start: Start) => {
    // Сторона — та, что смотрит на начало дороги.
    const side = sides.reduce((b, s) => (dot(s.n, norm(sub(start.anchor.pos, fp.center))) > dot(b.n, norm(sub(start.anchor.pos, fp.center))) ? s : b));
    const end = exitOf(side);
    if (dot(start.dir, norm(sub(end, start.anchor.pos))) < 0.3) return;
    cands.push({ start, curve: curveFor(start, end, scale(side.n, -1)) });
  };
  for (const t of towns) {
    if (dist(t.center, fp.center) - (t.extent ?? t.radius) > START_ROADS.industryReach) continue;
    for (const s of startsToward(roads, t, fp.center)) add2(s);
  }
  // Ответвление от уже проложенного просёлка — посередине его (не у тупиков: там выезды дворов и край карты).
  for (const c of roads.corridorsNear(fp.center, START_ROADS.industryReach)) {
    if (!isDirt(c.cls) || c.length < 200) continue;
    const hit = c.lut.closest(fp.center);
    const s = Math.max(60, Math.min(c.length - 110, hit.s));
    if (s >= c.length - 110) continue;
    const p = c.lut.pointAt(s);
    if (!ctx.terrain.inBounds(p, 60)) continue;
    let nrm = rightNormal(c.lut.tangentAt(s));
    const d = norm(sub(fp.center, p));
    if (dot(nrm, d) < 0) nrm = scale(nrm, -1);
    if (dot(nrm, d) < 0.6) continue;
    add2({ anchor: { kind: 'corridor', corridor: c.id, s, pos: p }, dir: nrm, host: new Set([c.id]) });
  }
  return firstRoute(ctx, cands, START_ROADS.industryReach, ind);
}

/** Полуширина полотна по большей стороне в точке s. */
function halfAt(c: Corridor, s: number): number {
  const e = edgesAt(c, s);
  return e ? Math.max(-e[0], e[1]) + ROAD_MARGIN : ROAD_MARGIN;
}
