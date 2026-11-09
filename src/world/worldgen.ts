import { circleArc, Cubic, CurveLUT, intersectCurves, straightCubic } from '../core/bezier';
import type { Rng } from '../core/rng';
import { add, angleOf, dist, dot, lerp, norm, scale, sub, Vec } from '../core/vec';
import { edgesAt } from '../lanes/geometry';
import { Corridor, LaneNet, LaneNode, LaneSlot, twoWay } from '../lanes/model';
import { biomeOf, townCargo } from './biomes';
import { BASE_TOWN_CARGO, CargoType, EXTRA_TOWN_CARGO, INDUSTRY_LIST } from './cargo';
import { placePlayerWorld } from './deposits';
import type { Deposit, Industry, Structure, Town, TownBuilding, TownStyle } from './entities';
import type { Network } from './network';
import { isRail, isTrunk, RAIL_HALF, RoadClass, ROAD_MARGIN } from './roadTypes';
import { areaFactor, DEFAULT_SETTINGS, INDUSTRY_DENSITY, playerIndustries, townSizes, WorldProfile, WorldSettings } from './settings';
import { industryCount, MINING_KINDS, shoreFits, terrainFits } from './sites';
import { Footprint, footprintRadius, FootprintIndex, pointInFootprint } from './spatial';
import { layStartRoads } from './startRoads';
import type { Terrain } from './terrain';

const TOWN_NAMES = [
  'Берёзовка',
  'Озёрск',
  'Заречье',
  'Каменка',
  'Светлогорск',
  'Сосновый Бор',
  'Ольховка',
  'Ясногорск',
  'Майское',
  'Красноборск',
  'Новоселье',
  'Липовец',
  'Белогорье',
  'Ключи',
  'Верхнедольск',
  'Рябиновка',
  'Солнечногорск',
  'Яблоневка',
  'Тихорецк',
  'Медведково',
];

const RES_COLORS: [string, string][] = [
  ['#efe3cf', '#b9654d'],
  ['#e8d6bd', '#9c5a46'],
  ['#f1e7d8', '#8a6a55'],
  ['#e2d2c0', '#a8493b'],
  ['#ece0c8', '#6f7d8c'],
  ['#e9dcc9', '#7d6a8f'],
];
const BLOCK_COLORS: [string, string][] = [
  ['#e4dccf', '#8c7d70'],
  ['#d9d2c6', '#6f6a66'],
];

/** Попыток найти место предприятию; у мира с биомом после обычных — ещё, с меньшим зазором до соседей. */
const NORMAL_ATTEMPTS = 120;
const RELAXED_ATTEMPTS = 200;
const RELAXED_GAP = 360;
/** Сверх 160 попыток мира под сценарий. */
const PROFILED_EXTRA = 80;

/** Сколько подходящих мест под город сравнить по рельефу, прежде чем выбрать самое ровное. */
const TOWN_SITE_POOL = 6;

/**
 * Перепад высот под городом радиуса r с центром c, м, и средняя высота: центр и три кольца по 12 точек.
 * Уклон в одной точке тут не годится — на макушке горы он нулевой.
 */
export function townRelief(terrain: Terrain, c: Vec, r: number): { spread: number; mean: number } {
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  let n = 0;
  for (const f of [0, 1 / 3, 2 / 3, 1]) {
    for (let k = 0; k < (f ? 12 : 1); k++) {
      const a = (k / 12) * Math.PI * 2;
      const h = terrain.heightAt({ x: c.x + Math.cos(a) * r * f, y: c.y + Math.sin(a) * r * f });
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      sum += h;
      n++;
    }
  }
  return { spread: hi - lo, mean: sum / n };
}

/**
 * Места под город по очереди попыток; propose(attempt) — точка, годная по воде и соседям, или null.
 * Без рельефа — каждое место сразу (как было). С рельефом — копим TOWN_SITE_POOL мест и отдаём их от самого
 * ровного по всей площади города (townRelief) к самому неровному: город встаёт в долину или на плато, а не на склон
 * или вершину.
 */
export function* townSites(terrain: Terrain, reach: number, attempts: number, propose: (attempt: number) => Vec | null): Generator<Vec> {
  let pool: { c: Vec; spread: number }[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const c = propose(attempt);
    if (c && !terrain.hasRelief) yield c;
    else if (c) pool.push({ c, spread: townRelief(terrain, c, reach).spread });
    if (pool.length && (pool.length >= TOWN_SITE_POOL || attempt === attempts - 1)) {
      pool.sort((a, b) => a.spread - b.spread);
      for (const s of pool) yield s.c;
      pool = [];
    }
  }
}

/** Какую долю перепада высот под городом срезает площадка: остальное — рельеф, по которому идут улицы. */
const TOWN_LEVEL = 0.7;

/**
 * Площадка под город: земля под улицами плавно тянется к средней высоте (на TOWN_LEVEL), за городом кисть
 * сходит на нет — склоны становятся пологими, но холмы остаются. Правка пишется в правки рельефа, и
 * сохранение (рельеф в нём строится заново по seed) восстанавливает её вместе с городом.
 */
function levelTown(terrain: Terrain, town: Town): void {
  if (!terrain.hasRelief) return;
  const r = town.radius * 1.3 + 100;
  const { mean } = townRelief(terrain, town.center, town.radius);
  terrain.terraform({
    x: town.center.x,
    y: town.center.y,
    r,
    mode: 'flatten',
    amount: TOWN_LEVEL * 2,
    target: Math.max(mean, terrain.waterLevel + 1),
    pad: town.radius / r,
  });
}

const COM_COLORS: [string, string][] = [
  ['#d5dde5', '#7d8a99'],
  ['#c9d3dc', '#5f6f80'],
  ['#dfe2e6', '#8f96a0'],
];

/** Профиль городской дороги: класс и полосы. */
interface Profile {
  cls: RoadClass;
  lanes: LaneSlot[];
}
const STREET: Profile = { cls: 'street', lanes: twoWay(1, 1) };
const AVENUE: Profile = { cls: 'avenue', lanes: twoWay(2, 2) };

export interface WorldContext {
  /** Дороги — сеть полос. */
  roads: LaneNet;
  terrain: Terrain;
  index: FootprintIndex<Structure>;
  rng: Rng;
  nextId: () => number;
  /** Ж/д пути: на них (кроме тоннелей) город не строит. */
  rail?: Network;
  /** Выезды автостанций: они шоссе, но город застраивается у них, как у улиц, — не магистраль. */
  driveways?: ReadonlySet<number>;
}

/** Полуширина асфальта полотна в точке s (по большей стороне). */
export function halfAtS(c: Corridor, s: number): number {
  const e = edgesAt(c, s);
  return e ? Math.max(-e[0], e[1]) + ROAD_MARGIN : ROAD_MARGIN;
}

/** Полуширина полотна по всей длине (по самому широкому месту). */
export function corridorHalf(c: Corridor): number {
  let h = 0;
  for (let i = 0; i <= 4; i++) h = Math.max(h, halfAtS(c, (c.length * i) / 4));
  return h;
}

/** Готовый мир: города, предприятия и (режим «Строит игрок») месторождения. */
export interface World {
  towns: Town[];
  industries: Industry[];
  deposits?: Deposit[];
}

/**
 * Режим «Строит игрок» (deposits.ts): месторождения вместо добычи, на старте — несколько предприятий. Радиус городов —
 * сразу по плотной застройке: от неё меряются черта города, места в ней, рабочие и вред.
 */
function playerWorld(ctx: WorldContext, towns: Town[], settings: WorldSettings, profile?: WorldProfile): World {
  for (const t of towns) measureTown(t);
  const { industries, deposits } = placePlayerWorld(ctx, towns, INDUSTRY_DENSITY[settings.industries].k * areaFactor(settings), settings, profile);
  layStartRoads(ctx, towns, industries, settings.seed);
  return { towns, industries, deposits };
}

export function generateWorld(ctx: WorldContext, settings: WorldSettings = DEFAULT_SETTINGS): World {
  const profile = settings.scenario?.profile;
  if (profile) return generateProfiled(ctx, settings, profile);
  const towns: Town[] = [];
  const names = [...TOWN_NAMES];
  // На тесной карте города ставим ближе друг к другу.
  const gap = settings.size === 'small' ? 600 : 900;
  for (const size of townSizes(settings.towns)) {
    const reach = (size + 1.5) * 110;
    const propose = () => {
      const c = {
        x: ctx.rng.range(reach + 300, ctx.terrain.width - reach - 300),
        y: ctx.rng.range(reach + 300, ctx.terrain.height - reach - 300),
      };
      if (ctx.terrain.isWater(c, 200)) return null;
      if (towns.some((t) => dist(t.center, c) < t.radius + reach + gap)) return null;
      return c;
    };
    for (const c of townSites(ctx.terrain, reach, 80, propose)) {
      const name = names.splice(ctx.rng.int(0, names.length), 1)[0];
      const style: TownStyle =
        size === 3
          ? 'radial'
          : size === 2
            ? ctx.rng.pick(['radial', 'organic', 'organic', 'organic'] as const)
            : ctx.rng.pick(['linear', 'linear', 'organic'] as const);
      const town = buildTown(ctx, towns.length + 1, c, name, size, style);
      if (town) {
        towns.push(town);
        break;
      }
      names.push(name);
    }
  }
  assignDemands(towns, ctx.rng, townCargo(settings));
  if (playerIndustries(settings)) return playerWorld(ctx, towns, settings);
  const placed = placeIndustries(ctx, towns, INDUSTRY_DENSITY[settings.industries].k * areaFactor(settings), settings);
  const industries = settings.biome ? settleChains(ctx, towns, placed) : placed;
  // Места для городов и предприятий выбраны по всем улицам; дальше радиус города — по плотной застройке.
  for (const t of towns) measureTown(t);
  layStartRoads(ctx, towns, industries, settings.seed);
  return { towns, industries };
}

/**
 * Мир под архетип сценария: размеры и скученность городов, число предприятий по видам, заводы ближе к
 * поставщикам или все предприятия вокруг крупнейшего города. Точка притяжения — случайная, но по seed.
 */
function generateProfiled(ctx: WorldContext, settings: WorldSettings, profile: WorldProfile): World {
  const { rng, terrain } = ctx;
  const towns: Town[] = [];
  const names = [...TOWN_NAMES];
  const W = terrain.width;
  const H = terrain.height;
  // Центр скопления городов — не у края карты и не в воде.
  let focus = { x: W / 2, y: H / 2 };
  for (let i = 0; i < 30; i++) {
    const c = { x: rng.range(W * 0.3, W * 0.7), y: rng.range(H * 0.3, H * 0.7) };
    if (!terrain.isWater(c, 400)) {
      focus = c;
      break;
    }
  }
  // Чем сильнее тяга, тем ближе к центру скопления ищем место; не нашлось — по всей карте.
  const spread = Math.max(W, H) * (1 - profile.cluster) + 1600 * profile.cluster;
  for (const size of townSizes(settings.towns, profile)) {
    const reach = (size + 1.5) * 110;
    const propose = (attempt: number) => {
      const free = attempt >= 80 || profile.cluster <= 0;
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, spread * (1 + attempt / 40));
      const raw = free
        ? { x: rng.range(reach + 300, W - reach - 300), y: rng.range(reach + 300, H - reach - 300) }
        : { x: focus.x + Math.cos(a) * r, y: focus.y + Math.sin(a) * r };
      const c = { x: Math.max(reach + 300, Math.min(W - reach - 300, raw.x)), y: Math.max(reach + 300, Math.min(H - reach - 300, raw.y)) };
      if (terrain.isWater(c, 200)) return null;
      if (towns.some((t) => dist(t.center, c) < t.radius + reach + profile.gap)) return null;
      return c;
    };
    for (const c of townSites(terrain, reach, 120, propose)) {
      const name = names.splice(rng.int(0, names.length), 1)[0];
      const style: TownStyle =
        size === 3 ? 'radial' : size === 2 ? rng.pick(['radial', 'organic', 'organic', 'organic'] as const) : rng.pick(['linear', 'linear', 'organic'] as const);
      const town = buildTown(ctx, towns.length + 1, c, name, size, style);
      if (town) {
        towns.push(town);
        break;
      }
      names.push(name);
    }
  }
  assignDemands(towns, rng, townCargo(settings));
  if (playerIndustries(settings)) return playerWorld(ctx, towns, settings, profile);
  const placed = placeProfiled(ctx, towns, INDUSTRY_DENSITY[settings.industries].k * areaFactor(settings), profile, settings);
  const industries = settings.biome ? settleChains(ctx, towns, placed) : placed;
  for (const t of towns) measureTown(t);
  layStartRoads(ctx, towns, industries, settings.seed);
  return { towns, industries };
}

/**
 * Предприятия по профилю: сырьевые — первыми; заводу из нескольких подходящих мест достаётся ближайшее
 * к поставщикам (affinity), а при тяге к узлу (hub) места ищутся вокруг крупнейшего города.
 */
function placeProfiled(ctx: WorldContext, towns: Town[], density: number, profile: WorldProfile, settings: WorldSettings): Industry[] {
  const { rng, terrain, index } = ctx;
  const result: Industry[] = [];
  const hub = [...towns].sort((a, b) => b.population - a.population)[0];
  const hubSpread = Math.max(terrain.width, terrain.height) * (1 - profile.hub) + 2400 * profile.hub;
  const nearWater = new Set(biomeOf(settings).nearWater);
  for (const info of INDUSTRY_LIST) {
    const plant = info.accepts.length > 0;
    const count = industryCount(settings, info.kind, info.count * density * (plant ? profile.plants : profile.raw));
    // Сколько подходящих мест сравнить: у завода с тягой к поставщикам — несколько.
    const choices = plant ? 1 + Math.round(profile.affinity * 6) : 1;
    const supplierDist = (p: Vec) =>
      info.accepts.reduce((sum, c) => {
        const d = Math.min(...result.filter((i) => i.info.produces === c).map((i) => dist(i.fp.center, p)));
        return sum + (Number.isFinite(d) ? d : 0);
      }, 0);
    for (let n = 0; n < count; n++) {
      const found: { fp: Footprint; score: number }[] = [];
      // Мир с биомом: ни одного места за обычные попытки — ещё PROFILED_EXTRA попыток с меньшим зазором и на любом склоне.
      const more = (attempt: number) => attempt < 160 || (!!settings.biome && !found.length && attempt < 160 + PROFILED_EXTRA);
      for (let attempt = 0; more(attempt) && found.length < choices; attempt++) {
        const relaxed = attempt >= 160;
        let center = { x: rng.range(300, terrain.width - 300), y: rng.range(300, terrain.height - 300) };
        if (hub && profile.hub > 0 && attempt < 110) {
          const a = rng.range(0, Math.PI * 2);
          const r = rng.range(hub.radius + 300, hub.radius + 300 + hubSpread * (1 + attempt / 60));
          center = { x: hub.center.x + Math.cos(a) * r, y: hub.center.y + Math.sin(a) * r };
          if (center.x < 300 || center.y < 300 || center.x > terrain.width - 300 || center.y > terrain.height - 300) continue;
        }
        const fp: Footprint = { center, w: info.w, h: info.h, angle: rng.range(-0.6, 0.6) };
        if (terrain.isWater(center, footprintRadius(fp) + 30)) continue;
        if (!shoreFits(terrain, fp, attempt, nearWater, info.kind)) continue;
        if (!relaxed && !terrainFits(terrain, center, attempt, MINING_KINDS.has(info.kind))) continue;
        if (towns.some((t) => dist(t.center, center) < t.radius + 280)) continue;
        if (result.some((i) => dist(i.fp.center, center) < (relaxed ? RELAXED_GAP : 520))) continue;
        if (found.some((f) => dist(f.fp.center, center) < 520)) continue;
        if (index.overlaps(fp, 20)) continue;
        found.push({ fp, score: plant ? supplierDist(center) : 0 });
      }
      const best = found.sort((a, b) => a.score - b.score)[0];
      if (!best) continue;
      const nearest = towns.reduce<Town | null>((b, t) => (!b || dist(t.center, best.fp.center) < dist(b.center, best.fp.center) ? t : b), null);
      const industry: Industry = {
        type: 'industry',
        id: ctx.nextId(),
        info,
        name: nearest ? `${info.name} (${nearest.name})` : info.name,
        fp: best.fp,
        stock: {},
        output: 0,
        producedMonth: 0,
        producedLast: 0,
        prodAcc: 0,
      };
      index.add(industry);
      result.push(industry);
      if (info.kind === 'forest') terrain.addForest(best.fp.center, 220, rng);
    }
  }
  return result;
}

/**
 * Раздаёт городам потребности так, чтобы каждый груз был нужен хотя бы одному городу. Набор — по биому:
 * просят только то, что в нём можно произвести.
 */
function assignDemands(towns: Town[], rng: Rng, cargo: { base: CargoType[]; extra: CargoType[] } = { base: BASE_TOWN_CARGO, extra: EXTRA_TOWN_CARGO }): void {
  const used = new Map<CargoType, number>(cargo.base.map((c) => [c, 0]));
  const order = [...towns].sort((a, b) => b.population - a.population);
  for (const t of order) {
    const count = t.population > 2000 ? 3 : 2;
    const pool = [...cargo.base].sort((a, b) => used.get(a)! - used.get(b)! + rng.range(-0.5, 0.5));
    t.demands = pool.slice(0, count);
    for (const c of t.demands) used.set(c, used.get(c)! + 1);
  }
  assignExtraDemands(towns, cargo.extra);
}

/** Груз можно получить на карте: его делает предприятие, всё сырьё которого тоже можно получить. */
function makeable(industries: Industry[], cargo: CargoType, seen: ReadonlySet<CargoType> = new Set()): boolean {
  if (seen.has(cargo)) return false;
  const next = new Set(seen).add(cargo);
  return industries.some((i) => i.info.produces === cargo && i.info.accepts.every((c) => makeable(industries, c, next)));
}

/**
 * Города не просят то, чего на карте не сделать: если завод цепочки не нашёл места (тесная карта, мало
 * предприятий), потребность в его продукции снимается. Только для миров с биомом — старые миры прежние.
 */
function pruneDemands(towns: Town[], industries: Industry[]): void {
  const ok = new Map<CargoType, boolean>();
  const can = (c: CargoType) => ok.get(c) ?? ok.set(c, makeable(industries, c)).get(c)!;
  for (const t of towns) t.demands = t.demands.filter(can);
}

/**
 * Цепочки мира с биомом без тупиков: города не просят того, чего не сделать, а предприятие, которому
 * не привезти сырья или некуда сбыть продукцию (завод следующего звена не встал), убирается с карты.
 * Повторяем, пока что-то меняется: убранный завод может оставить без сбыта своих поставщиков.
 */
function settleChains(ctx: WorldContext, towns: Town[], industries: Industry[]): Industry[] {
  let list = industries;
  for (;;) {
    pruneDemands(towns, list);
    const wanted = new Set<CargoType>(towns.flatMap((t) => t.demands));
    for (const i of list) for (const c of i.info.accepts) wanted.add(c);
    const keep = list.filter((i) => wanted.has(i.info.produces) && i.info.accepts.every((c) => makeable(list, c)));
    if (keep.length === list.length) return list;
    for (const i of list) if (!keep.includes(i)) ctx.index.remove(i);
    list = keep;
  }
}

/** Сколько жителей нужно городу, чтобы он просил ещё и продукцию новых цепочек (стекло, мебель). */
export const EXTRA_DEMAND_POPULATION = 4000;

/**
 * Города покрупнее просят ещё одно из EXTRA_TOWN_CARGO — поровну между грузами; каждый такой груз нужен
 * хотя бы одному городу. Без случайных чисел: основные потребности и предприятия мира по seed не меняются.
 */
export function assignExtraDemands(towns: Town[], extra: CargoType[] = EXTRA_TOWN_CARGO): void {
  if (!extra.length) return;
  const used = new Map<CargoType, number>(extra.map((c) => [c, 0]));
  const order = [...towns].sort((a, b) => b.population - a.population);
  const add = (t: Town, c: CargoType) => {
    t.demands = [...t.demands, c];
    used.set(c, used.get(c)! + 1);
  };
  for (const t of order) {
    if (t.population <= EXTRA_DEMAND_POPULATION) continue;
    add(t, [...extra].sort((a, b) => used.get(a)! - used.get(b)!)[0]);
  }
  for (const c of extra) {
    const t = used.get(c) ? null : order.find((x) => !x.demands.includes(c));
    if (t) add(t, c);
  }
}

// ---------- Улицы ----------

interface StreetBuilder {
  ctx: WorldContext;
  segs: Corridor[];
}

function nodeAt(sb: StreetBuilder, p: Vec): LaneNode | null {
  const { terrain, roads } = sb.ctx;
  if (!terrain.inBounds(p, 80) || terrain.isWater(p, 36)) return null;
  const near = roads.nodesNear(p, 20).sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
  return near ?? roads.addJunction(p);
}

/** Добавляет улицу, если она не пересекает воду и другие улицы. */
function street(sb: StreetBuilder, a: LaneNode | null, b: LaneNode | null, curve: Cubic | null, profile: Profile): Corridor | null {
  if (!a || !b || a === b) return null;
  const { roads, terrain } = sb.ctx;
  if (a.corridors.some((id) => b.corridors.includes(id))) return null;
  const c = curve ?? straightCubic(a.pos, b.pos);
  const fixed: Cubic = { p0: a.pos, p1: add(c.p1, sub(a.pos, c.p0)), p2: add(c.p2, sub(b.pos, c.p3)), p3: b.pos };
  const lut = new CurveLUT(fixed);
  for (let i = 1; i < 12; i++) if (terrain.isWater(lut.pointAt((lut.length * i) / 12), 22)) return null;
  for (const other of roads.corridorsNear(lerp(a.pos, b.pos, 0.5), lut.length / 2 + 40)) {
    if ([other.a, other.b].some((id) => id === a.id || id === b.id)) continue;
    if (intersectCurves(lut, other.lut).length) return null;
  }
  const seg = roads.addCorridor(a.id, b.id, { cls: profile.cls, lanes: profile.lanes, curve: fixed });
  sb.segs.push(seg);
  return seg;
}

/**
 * Две улицы одного профиля, продолжающие друг друга почти по прямой, сходятся не перекрёстком,
 * а стыком: разметка идёт насквозь. Их концы выравниваются точно по общему направлению.
 */
export function smoothJoins(roads: LaneNet, nodes: Iterable<number>): void {
  for (const id of nodes) {
    const n = roads.nodes.get(id);
    if (!n || n.kind !== 'junction' || n.corridors.length !== 2) continue;
    const [e1, e2] = roads.ends(n);
    if (!e1 || !e2 || e1.corridor === e2.corridor || e1.corridor.cls !== e2.corridor.cls) continue;
    if (dot(e1.away, e2.away) > -Math.cos(0.3)) continue;
    const dir = norm(sub(e2.away, e1.away));
    // Полосы с обеих сторон должны совпасть по положению и направлению.
    const sig = (away: Vec, c: Corridor, end: 'a' | 'b') => {
      const along = dot(end === 'a' ? away : scale(away, -1), dir) >= 0 ? 1 : -1;
      return c.lanes.map((l) => `${Math.round(l.offset * along * 2)}:${l.flow * along > 0}`).sort().join();
    };
    if (sig(e1.away, e1.corridor, e1.end) !== sig(e2.away, e2.corridor, e2.end)) continue;
    n.kind = 'seam';
    n.dir = dir;
    for (const e of [e1, e2]) {
      const side = dot(e.away, dir) >= 0 ? 1 : -1;
      const cv = { ...e.corridor.curve };
      if (e.end === 'a') cv.p1 = add(cv.p0, scale(dir, side * dist(cv.p0, cv.p1)));
      else cv.p2 = add(cv.p3, scale(dir, side * dist(cv.p3, cv.p2)));
      roads.setCurve(e.corridor, cv);
    }
  }
}

// ---------- Очертания города ----------

/** Очертания города: во сколько раз край в направлении a (угол в мире) дальше обычного радиуса. */
export type TownShape = (a: number) => number;

/** По скольким направлениям город меряет место вокруг: до воды, края карты или крутого склона. */
const SHAPE_DIRS = 24;
/** Таблица очертаний: столько точек на оборот, между ними — линейно. */
const SHAPE_STEPS = 96;

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Очертания города вокруг center с обычным радиусом R — детерминированно по rng (seed). Город не круг:
 * - вытянут (эллипс той же площади) вдоль направления, где больше всего места — вдоль реки, долины, берега;
 *   на ровном месте без воды — вдоль случайной оси;
 * - край неровный: несколько плавных волн по 2–5 на оборот;
 * - вдоль выездов (petals — их углы) застройка тянется лепестками;
 * - к воде, краю карты и крутому склону край поджимается, а площадь добирается в других направлениях.
 * Средний квадрат множителя — около 1: площадь (а с ней и население) как у круга радиуса R.
 * min / max — пределы множителя: у кольцевого города между кольцами должны помещаться дома.
 */
export function townShape(ctx: WorldContext, center: Vec, R: number, opts: { petals?: number[]; min?: number; max?: number } = {}): TownShape {
  const { rng, terrain } = ctx;
  const { petals = [], min = 0.6, max = 1.6 } = opts;
  // Свободное место по направлениям, в долях R (не дальше max·1.1).
  const h0 = terrain.heightAt(center);
  const steep = Math.max(12, terrain.amplitude * 0.3);
  const room: number[] = [];
  for (let k = 0; k < SHAPE_DIRS; k++) {
    const a = (k / SHAPE_DIRS) * Math.PI * 2;
    const u = { x: Math.cos(a), y: Math.sin(a) };
    let d = 60;
    for (; d < R * max * 1.1; d += 30) {
      const p = add(center, scale(u, d));
      if (!terrain.inBounds(p, 80) || terrain.isWater(p, 40)) break;
      if (terrain.hasRelief && Math.abs(terrain.heightAt(p) - h0) > steep) break;
    }
    // До последней сухой точки.
    room.push((d - 30) / R);
  }
  // Сглаживаем, но не дальше, чем есть места в самом направлении.
  const roomAt = room.map((r, k) => Math.min(r, (room[(k + SHAPE_DIRS - 1) % SHAPE_DIRS] + r + room[(k + 1) % SHAPE_DIRS]) / 3));
  // Ось вытянутости: где места больше в обе стороны; при равенстве — ближе к случайной оси.
  const pref = rng.range(0, Math.PI);
  let axis = pref;
  let best = -Infinity;
  for (let k = 0; k < SHAPE_DIRS / 2; k++) {
    const a = (k / SHAPE_DIRS) * Math.PI * 2;
    const score = roomAt[k] + roomAt[k + SHAPE_DIRS / 2] + 0.25 * Math.cos(2 * (a - pref));
    if (score > best) {
      best = score;
      axis = a;
    }
  }
  // Полуоси эллипса — aspect и 1/aspect: длина к ширине — aspect².
  const aspect = rng.range(1.06, 1.22);
  const waves = [2, 3, 4, 5].map((m) => ({ m, amp: rng.range(0.03, 0.1) * (m === 2 ? 1.3 : 1), ph: rng.range(0, Math.PI * 2) }));
  const raw = (a: number) => {
    const c = Math.cos(a - axis);
    const s = Math.sin(a - axis);
    let f = 1 / Math.sqrt((c / aspect) ** 2 + (s * aspect) ** 2);
    for (const w of waves) f *= 1 + w.amp * Math.sin(w.m * a + w.ph);
    for (const p of petals) f *= 1 + 0.25 * Math.exp(-((wrapAngle(a - p) / 0.3) ** 2));
    return f;
  };
  const roomOf = (a: number) => {
    const t = ((((a / (Math.PI * 2)) % 1) + 1) % 1) * SHAPE_DIRS;
    const k = Math.floor(t);
    return lerpNum(roomAt[k % SHAPE_DIRS], roomAt[(k + 1) % SHAPE_DIRS], t - k);
  };
  const angles = Array.from({ length: SHAPE_STEPS }, (_, i) => (i / SHAPE_STEPS) * Math.PI * 2);
  const base = angles.map(raw);
  const cap = angles.map((a) => Math.max(min, roomOf(a) * 0.95));
  // Масштаб, при котором площадь — как у круга R: поджатое у воды добирается в других направлениях.
  let k = 1;
  let table = base;
  for (let it = 0; it < 6; it++) {
    table = base.map((f, i) => Math.min(max, cap[i], Math.max(min, f * k)));
    const mean = table.reduce((s, f) => s + f * f, 0) / SHAPE_STEPS;
    k = Math.min(1.4, k / Math.sqrt(mean));
  }
  return (a: number) => {
    const t = ((((a / (Math.PI * 2)) % 1) + 1) % 1) * SHAPE_STEPS;
    const i = Math.floor(t);
    return lerpNum(table[i % SHAPE_STEPS], table[(i + 1) % SHAPE_STEPS], t - i);
  };
}

const lerpNum = (a: number, b: number, t: number) => a + (b - a) * t;

/** Кусок кривой в полярных координатах от угла a0 до a1 (P — точка кривой под углом): гладкий, как дуга. */
function polarArc(P: (a: number) => Vec, a0: number, a1: number): Cubic {
  const h = 1e-3;
  const d = (a: number) => scale(sub(P(a + h), P(a - h)), 1 / (2 * h));
  const t = (4 / 3) * Math.tan((a1 - a0) / 4);
  const s = P(a0);
  const e = P(a1);
  return { p0: s, p1: add(s, scale(d(a0), t)), p2: sub(e, scale(d(a1), t)), p3: e };
}

/** Отрезок кривой Катмулла-Рома между p1 и p2 с соседями p0 и p3 — плавная улица через узлы. */
function catmull(p0: Vec, p1: Vec, p2: Vec, p3: Vec): Cubic {
  return { p0: p1, p1: add(p1, scale(sub(p2, p0), 1 / 6)), p2: sub(p2, scale(sub(p3, p1), 1 / 6)), p3: p2 };
}

function radialStreets(sb: StreetBuilder, center: Vec, size: number): void {
  const { rng } = sb.ctx;
  const rays = size >= 3 ? 6 : 5;
  const rings = size >= 3 ? 4 : 3;
  const radius = (k: number) => 110 + k * 140;
  const a0 = rng.range(0, Math.PI * 2);
  const angle = (n: number, i: number) => a0 + (i * Math.PI * 2) / n;
  // Выезды из города — по главным лучам; вдоль них застройка вытягивается лепестками.
  const exits = Array.from({ length: rays }, () => rng.chance(0.6));
  // Площадь у центра — круглая, дальше расстояние между кольцами следует очертаниям города.
  const shape = townShape(sb.ctx, center, radius(rings - 1), {
    petals: exits.flatMap((e, i) => (e ? [angle(rays, i)] : [])),
    min: 0.7,
    max: 1.5,
  });
  const ringAt = (k: number, a: number) => 110 + k * 140 * shape(a);
  const ringPoint = (k: number) => (a: number) => add(center, scale({ x: Math.cos(a), y: Math.sin(a) }, ringAt(k, a)));
  // На каждом кольце столько лучей, чтобы дуга между ними была не длиннее ~260.
  const counts: number[] = [];
  for (let k = 0; k < rings; k++) {
    let n = k === 0 ? rays : counts[k - 1];
    while ((Math.PI * 2 * radius(k)) / n > 260) n *= 2;
    counts.push(k === rings - 1 && k > 0 ? counts[k - 1] : n);
  }
  const nodes = new Map<string, LaneNode | null>();
  const key = (k: number, n: number, i: number) => `${k}:${((i * rays * 8) / n) | 0}`;
  const nodeOn = (k: number, n: number, i: number) => {
    const id = key(k, n, i);
    if (!nodes.has(id)) nodes.set(id, nodeAt(sb, ringPoint(k)(angle(n, i))));
    return nodes.get(id) ?? null;
  };
  // Кольца. Внешнее — с прорехами, чаще там, где город уже: край не замкнут в правильное кольцо.
  for (let k = 0; k < rings; k++) {
    const n = counts[k];
    for (let i = 0; i < n; i++) {
      const narrow = Math.max(0, 1 - shape(angle(n, i + 0.5)));
      if (k === rings - 1 && rng.chance(0.1 + narrow * 1.2)) continue;
      const arc = k === 0 ? circleArc(center, radius(k), angle(n, i), angle(n, i + 1)) : polarArc(ringPoint(k), angle(n, i), angle(n, i + 1));
      street(sb, nodeOn(k, n, i), nodeOn(k, n, (i + 1) % n), arc, k === 0 ? AVENUE : STREET);
    }
  }
  // Лучи: каждый узел внешнего кольца соединяется с внутренним, если там есть узел под тем же углом.
  for (let k = 0; k < rings - 1; k++) {
    const inner = counts[k];
    const outer = counts[k + 1];
    for (let i = 0; i < outer; i++) {
      const j = (i * inner) / outer;
      if (!Number.isInteger(j)) continue;
      const isMain = (i * rays) % outer === 0 && ((i * rays) / outer) % 2 === 0;
      street(sb, nodeOn(k, inner, j), nodeOn(k + 1, outer, i), null, isMain && size >= 3 ? AVENUE : STREET);
    }
  }
  // Выезды из города по главным лучам.
  const last = rings - 1;
  for (let i = 0; i < rays; i++) {
    if (!exits[i]) continue;
    const n = counts[last];
    const from = nodeOn(last, n, (i * n) / rays);
    if (!from) continue;
    const a = angle(rays, i);
    const r = ringAt(last, a) + 200;
    const p = add(center, { x: Math.cos(a) * r, y: Math.sin(a) * r });
    street(sb, from, nodeAt(sb, p), null, size >= 3 && i % 2 === 0 ? AVENUE : STREET);
  }
}

function organicStreets(sb: StreetBuilder, center: Vec, size: number): void {
  const { rng } = sb.ctx;
  const spacing = rng.range(135, 165);
  const rot = rng.range(0, Math.PI / 2);
  const ux = { x: Math.cos(rot), y: Math.sin(rot) };
  const uy = { x: -Math.sin(rot), y: Math.cos(rot) };
  // Край сетки — по очертаниям города (угол клетки в мире — её угол в сетке плюс поворот сетки).
  const shape = townShape(sb.ctx, center, (size + 0.5) * spacing, { min: 0.55, max: 1.6 });
  // 0.96: у воды город теперь не обрезается, а добирает место в другую сторону — население как у прежних городов.
  const reach = (i: number, j: number) => (size + 0.5) * 0.96 * shape(Math.atan2(j, i) + rot);
  // Плавная деформация всей сетки: улицы изгибаются вместе, без изломов в узлах.
  const amp = spacing * rng.range(0.12, 0.2);
  const wl = spacing * rng.range(3, 4.5);
  const [f1, f2, f3, f4] = [0, 0, 0, 0].map(() => rng.range(0, Math.PI * 2));
  const warp = (x: number, y: number): Vec => ({
    x: amp * Math.sin(y / wl + f1) + amp * 0.5 * Math.sin((x + y) / (wl * 0.8) + f2),
    y: amp * Math.sin(x / wl + f3) + amp * 0.5 * Math.sin((x - y) / (wl * 0.8) + f4),
  });
  const n = Math.ceil((size + 0.5) * 1.6);
  const pos = (i: number, j: number) => {
    const lx = i * spacing;
    const ly = j * spacing;
    const w = warp(lx, ly);
    return add(center, add(scale(ux, lx + w.x), scale(uy, ly + w.y)));
  };
  const inside = (i: number, j: number) => Math.hypot(i, j) <= reach(i, j);
  const grid = new Map<string, LaneNode | null>();
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) if (inside(i, j)) grid.set(`${i}:${j}`, nodeAt(sb, pos(i, j)));
  }
  const connect = (i: number, j: number, di: number, dj: number) => {
    const a = grid.get(`${i}:${j}`);
    const b = grid.get(`${i + di}:${j + dj}`);
    if (!a || !b) return;
    const major = di ? j === 0 : i === 0;
    const curve = catmull(pos(i - di, j - dj), pos(i, j), pos(i + di, j + dj), pos(i + 2 * di, j + 2 * dj));
    street(sb, a, b, curve, major && size >= 2 ? AVENUE : STREET);
  };
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      connect(i, j, 1, 0);
      connect(i, j, 0, 1);
    }
  }
}

function linearStreets(sb: StreetBuilder, center: Vec, size: number): void {
  const { rng } = sb.ctx;
  const dir = rng.range(0, Math.PI * 2);
  const u = { x: Math.cos(dir), y: Math.sin(dir) };
  const nrm = { x: -u.y, y: u.x };
  const K = 2 + size;
  const step = rng.range(150, 180);
  const amp = rng.range(30, 70);
  const ph = rng.range(0, Math.PI * 2);
  const pts: Vec[] = [];
  for (let k = -K; k <= K; k++) pts.push(add(center, add(scale(u, k * step), scale(nrm, amp * Math.sin(k * 0.45 + ph)))));
  const mainNodes = pts.map((p) => nodeAt(sb, p));
  // Главная улица — гладкая кривая через точки.
  for (let i = 0; i < pts.length - 1; i++) {
    const curve = catmull(pts[Math.max(0, i - 1)], pts[i], pts[i + 1], pts[Math.min(pts.length - 1, i + 2)]);
    street(sb, mainNodes[i], mainNodes[i + 1], curve, size >= 2 ? AVENUE : STREET);
  }
  // Поперечные улицы и задние улицы, образующие кварталы.
  for (const side of [-1, 1]) {
    let prevEnd: LaneNode | null = null;
    for (let i = 1; i < pts.length - 1; i++) {
      const from = mainNodes[i];
      if (!from || !rng.chance(0.6)) {
        prevEnd = null;
        continue;
      }
      const tangent = norm(sub(pts[i + 1], pts[i - 1]));
      const out = { x: -tangent.y * side, y: tangent.x * side };
      const endPos = add(from.pos, scale(out, rng.range(130, 170)));
      const end = nodeAt(sb, endPos);
      const seg = street(sb, from, end, null, STREET);
      if (seg && end && prevEnd && rng.chance(0.7)) street(sb, prevEnd, end, null, STREET);
      prevEnd = seg ? end : null;
    }
  }
}

export function buildTown(ctx: WorldContext, id: number, center: Vec, name: string, size: number, style: TownStyle): Town | null {
  const { roads } = ctx;
  const sb: StreetBuilder = { ctx, segs: [] };
  if (style === 'radial') radialStreets(sb, center, size);
  else if (style === 'organic') organicStreets(sb, center, size);
  else linearStreets(sb, center, size);

  // Оставляем связную часть вокруг центра.
  const created = new Set<number>();
  for (const s of sb.segs) created.add(s.a).add(s.b);
  let start: LaneNode | null = null;
  for (const nid of created) {
    const n = roads.node(nid);
    if (!start || dist(n.pos, center) < dist(start.pos, center)) start = n;
  }
  const keep = new Set<number>();
  if (start) {
    const queue = [start.id];
    keep.add(start.id);
    while (queue.length) {
      const nid = queue.pop()!;
      for (const sid of roads.node(nid).corridors) {
        const s = roads.corridor(sid);
        const other = s.a === nid ? s.b : s.a;
        if (!keep.has(other)) {
          keep.add(other);
          queue.push(other);
        }
      }
    }
  }
  for (const s of sb.segs) if (!keep.has(s.a)) roads.removeCorridor(s.id);
  for (const nid of created) if (!keep.has(nid) && roads.nodes.has(nid) && !roads.node(nid).corridors.length) roads.removeNode(nid);
  const alive = sb.segs.filter((s) => roads.corridors.has(s.id));
  if (alive.length < 3) {
    for (const s of alive) roads.removeCorridor(s.id);
    return null;
  }
  // Улица, продолжающая другую почти по прямой, — без перекрёстка; одиночные концы — тупики.
  smoothJoins(roads, keep);
  for (const nid of keep) {
    const n = roads.nodes.get(nid);
    if (n?.kind === 'junction' && n.corridors.length === 1) {
      n.kind = 'seam';
      n.dir = scale(roads.ends(n)[0].away, -1);
    }
  }

  let radius = 0;
  let top = center.y;
  for (const s of alive) {
    for (const p of [s.curve.p0, s.curve.p3]) {
      radius = Math.max(radius, dist(p, center));
      top = Math.min(top, p.y);
    }
  }
  const town: Town = {
    id,
    name,
    center,
    radius: radius + 30,
    top: top - 30,
    style,
    population: 0,
    buildings: [],
    streets: alive.map((s) => s.id),
    demands: [],
    supplied: {},
    lastSupplied: {},
    tripAcc: 0,
    growthAcc: 0,
  };
  placeLandmark(ctx, town);
  for (const s of alive) fillStreet(ctx, town, s, style === 'linear' ? 0.75 : 0.88);
  recountPopulation(town);
  levelTown(ctx.terrain, town);
  return town;
}

/** Ратуша или собор в центре города: повёрнута вдоль ближайшей улицы и не задевает дороги. */
function placeLandmark(ctx: WorldContext, town: Town): void {
  for (const size of [44, 34]) {
    for (let r = 0; r < 240; r += 12) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const center = add(town.center, { x: Math.cos(a) * r, y: Math.sin(a) * r });
        const fp: Footprint = { center, w: size, h: size, angle: streetAngle(ctx, center) };
        if (placeable(ctx, fp, -1) && clearOfRoads(ctx, fp, 3)) {
          addLandmark(ctx, town, fp);
          return;
        }
      }
    }
  }
}

/** Направление ближайшей улицы — чтобы здание стояло ровно вдоль неё. */
export function streetAngle(ctx: Pick<WorldContext, 'roads'>, p: Vec): number {
  let best = Infinity;
  let angle = 0;
  for (const seg of ctx.roads.corridorsNear(p, 200)) {
    const hit = seg.lut.closest(p);
    if (hit.d < best) {
      best = hit.d;
      angle = angleOf(seg.lut.tangentAt(hit.s));
    }
  }
  return angle;
}

/** Точная проверка по контуру: ни одна точка здания не ближе margin к краю дороги. */
export function clearOfRoads(ctx: Pick<WorldContext, 'roads'>, fp: Footprint, margin: number): boolean {
  const c = Math.cos(fp.angle);
  const s = Math.sin(fp.angle);
  const pts: Vec[] = [];
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const lx = (i / 4 - 0.5) * fp.w;
      const ly = (j / 4 - 0.5) * fp.h;
      pts.push({ x: fp.center.x + lx * c - ly * s, y: fp.center.y + lx * s + ly * c });
    }
  }
  for (const seg of ctx.roads.corridorsNear(fp.center, footprintRadius(fp) + 60)) {
    const hw = corridorHalf(seg) + margin;
    if (pts.some((q) => seg.lut.closest(q).d < hw)) return false;
  }
  return true;
}

/** Узел, откуда выезжают и куда приезжают машины жителей дома: ближайший перекрёсток или тупик. */
export function anchorFor(roads: LaneNet, p: Vec): number {
  for (const r of [150, 400, 1200]) {
    const near = roads
      .nodesNear(p, r)
      .filter((n) => n.kind === 'junction' || roads.isDeadEnd(n))
      .sort((x, y) => dist(x.pos, p) - dist(y.pos, p))[0];
    if (near) return near.id;
  }
  return 0;
}

function addLandmark(ctx: WorldContext, town: Town, fp: Footprint): void {
  const b: TownBuilding = {
    type: 'building',
    id: ctx.nextId(),
    townId: town.id,
    fp,
    kind: 'landmark',
    floors: 4,
    anchor: anchorFor(ctx.roads, fp.center),
    color: '#efe6d2',
    roof: '#5c7fa3',
  };
  ctx.index.add(b);
  town.buildings.push(b);
}

/**
 * Застраивает улицу домами по обеим сторонам. density — доля занятых мест;
 * reach — дальше этого от центра города домов не ставим.
 */
export function fillStreet(ctx: WorldContext, town: Town, seg: Corridor, density: number, limit = Infinity, reach = Infinity): number {
  const { rng } = ctx;
  const hw = corridorHalf(seg);
  let added = 0;
  for (const side of [-1, 1]) {
    let s = 26;
    while (s < seg.length - 26 && added < limit) {
      const p0 = seg.lut.pointAt(s);
      const closeness = 1 - Math.min(1, dist(p0, town.center) / Math.max(1, town.radius));
      const big = closeness > 0.55 && rng.chance(0.55);
      const width = big ? rng.range(26, 36) : rng.range(16, 24);
      const depth = big ? rng.range(22, 28) : rng.range(15, 22);
      const at = s + width / 2;
      if (at + width / 2 > seg.length - 22) break;
      s += width + rng.range(3, 7);
      if (rng.next() > density || dist(p0, town.center) > reach) continue;
      const p = seg.lut.pointAt(at);
      const t = seg.lut.tangentAt(at);
      const normal = { x: -t.y * side, y: t.x * side };
      const center = add(p, scale(normal, hw + 5 + depth / 2));
      const fp: Footprint = { center, w: width, h: depth, angle: Math.atan2(t.y, t.x) };
      if (!placeable(ctx, fp, seg.id)) continue;
      const kind: 'res' | 'com' = closeness > 0.6 && rng.chance(0.6) ? 'com' : rng.chance(0.1) ? 'com' : 'res';
      const [color, roof] = rng.pick(kind === 'com' ? COM_COLORS : big ? BLOCK_COLORS : RES_COLORS);
      const floors = kind === 'com' ? rng.int(2, 6) : big ? rng.int(3, 6) : rng.int(1, 3);
      const b: TownBuilding = {
        type: 'building',
        id: ctx.nextId(),
        townId: town.id,
        fp,
        kind,
        floors,
        anchor: anchorFor(ctx.roads, p),
        color,
        roof,
      };
      ctx.index.add(b);
      town.buildings.push(b);
      added++;
      // Второй ряд домов в глубине квартала — чаще ближе к центру.
      if (added < limit && rng.chance(0.2 + 0.5 * closeness)) {
        const d2 = rng.range(15, 22);
        const rear: Footprint = {
          center: add(p, scale(normal, hw + 5 + depth + 5 + d2 / 2)),
          w: width * rng.range(0.75, 1),
          h: d2,
          angle: fp.angle,
        };
        if (placeable(ctx, rear, seg.id)) {
          const [rc, rr] = rng.pick(RES_COLORS);
          const back: TownBuilding = { ...b, id: ctx.nextId(), fp: rear, kind: 'res', floors: rng.int(1, 3), color: rc, roof: rr };
          ctx.index.add(back);
          town.buildings.push(back);
          added++;
        }
      }
    }
  }
  return added;
}

/** Магистраль или съезд развязки: город к ним не пристраивается. */
export const isHighway = (c: Corridor) => isTrunk(c.cls) || (c.cls !== 'street' && c.lanes.every((l) => l.flow === c.lanes[0]?.flow));
/** Сколько свободного места оставляют дома до магистрали или съезда. */
const HIGHWAY_BUFFER = 50;

/** Магистраль для города: выезды станций (driveways) — не в счёт, хоть они и шоссе. */
const townHighway = (c: Corridor, driveways?: ReadonlySet<number>) => isHighway(c) && !driveways?.has(c.id);

/** Полотно — часть развязки или магистрали: само магистральное или примыкает к ней в узле. */
export function nearHighway(roads: LaneNet, seg: Corridor, driveways?: ReadonlySet<number>): boolean {
  if (townHighway(seg, driveways)) return true;
  return [seg.a, seg.b].some((id) => roads.node(id).corridors.some((sid) => townHighway(roads.corridor(sid), driveways)));
}

/** Сколько свободного места оставляют дома до насыпи путей. */
const RAIL_BUFFER = 4;

/** Насыпь путей (кроме тоннелей) с запасом margin задевает здание. */
export function onRail(rail: Network | undefined, fp: Footprint, margin: number): boolean {
  if (!rail) return false;
  const r = footprintRadius(fp) + RAIL_HALF + margin;
  for (const seg of rail.segmentsNear(fp.center, r)) {
    if (!isRail(seg.spec)) continue;
    const hit = seg.lut.closest(fp.center);
    if (hit.d > r) continue;
    for (let s = Math.max(0, hit.s - r); s <= Math.min(seg.length, hit.s + r); s += 3) {
      if (rail.levelAt(seg, s) < -0.75) continue;
      if (pointInFootprint(seg.lut.pointAt(s), fp, RAIL_HALF + margin)) return true;
    }
  }
  return false;
}

/** Ось путей (кроме тоннелей) ближе d к точке. */
export function railNear(rail: Network | undefined, p: Vec, d: number): boolean {
  if (!rail) return false;
  for (const seg of rail.segmentsNear(p, d)) {
    if (!isRail(seg.spec)) continue;
    const hit = seg.lut.closest(p);
    if (hit.d < d && rail.levelAt(seg, hit.s) >= -0.75) return true;
  }
  return false;
}

/** Можно ли поставить здание: не в воде, не на дороге, не на путях и не на другом здании. */
export function placeable(ctx: WorldContext, fp: Footprint, ownSeg: number): boolean {
  const { roads, terrain, index } = ctx;
  if (!terrain.inBounds(fp.center, 30) || terrain.isWater(fp.center, footprintRadius(fp) + 4)) return false;
  if (index.overlaps(fp, 2)) return false;
  if (onRail(ctx.rail, fp, RAIL_BUFFER)) return false;
  const r = footprintRadius(fp);
  for (const seg of roads.corridorsNear(fp.center, r + 30 + HIGHWAY_BUFFER)) {
    if (seg.id === ownSeg) continue;
    const hit = seg.lut.closest(fp.center);
    const hw = halfAtS(seg, hit.s);
    if (hit.d < hw + r - 3) return false;
    if (townHighway(seg, ctx.driveways) && hit.d < hw + r + HIGHWAY_BUFFER) return false;
  }
  if (roads.nodesNear(fp.center, r + 12).length) return false;
  return true;
}

export function recountPopulation(town: Town): void {
  town.population = town.buildings.reduce((sum, b) => sum + (b.kind === 'res' ? b.floors * 14 : b.kind === 'com' ? b.floors * 4 : 0), 0);
}

/**
 * Край плотной застройки — расстояние от центра: идём от середины застройки наружу, пока кольцо
 * шириной 80 м застроено хотя бы впятеро реже ядра. Длинные улицы с редкими домами в поле за ним не в счёт.
 */
export function coreRadius(town: Town): number {
  const ds = town.buildings.map((b) => dist(b.fp.center, town.center)).sort((a, b) => a - b);
  if (!ds.length) return 0;
  const W = 80;
  let r = Math.max(60, ds[Math.floor(ds.length / 2)]);
  let i = 0;
  while (i < ds.length && ds[i] <= r) i++;
  const core = i / (Math.PI * r * r);
  let j = i;
  for (;;) {
    while (j < ds.length && ds[j] <= r + W) j++;
    if (j - i < core * 0.2 * Math.PI * ((r + W) ** 2 - r ** 2)) break;
    r += 20;
    while (i < ds.length && ds[i] <= r) i++;
  }
  return Math.min(ds[ds.length - 1], r + W / 2);
}

/**
 * Радиус города — по плотной застройке (круг на миникарте, подписи, охват);
 * extent — до самого дальнего дома (отрисовка, охват станций).
 */
export function measureTown(town: Town): void {
  if (!town.buildings.length) return;
  let far = 0;
  for (const b of town.buildings) far = Math.max(far, dist(b.fp.center, town.center) + footprintRadius(b.fp));
  town.radius = Math.max(100, coreRadius(town) + 30);
  town.extent = Math.max(town.radius, far + 10);
}

function placeIndustries(ctx: WorldContext, towns: Town[], density: number, settings: WorldSettings): Industry[] {
  const { rng, terrain, index } = ctx;
  const result: Industry[] = [];
  const nearWater = new Set(biomeOf(settings).nearWater);
  // У мира с биомом цепочек меньше и каждое звено на счету: не нашлось места за обычные попытки — ищем ещё,
  // ближе к соседям и на любом склоне. Старый мир — ровно как раньше (те же попытки и та же раскладка).
  const attempts = settings.biome ? RELAXED_ATTEMPTS : NORMAL_ATTEMPTS;
  for (const info of INDUSTRY_LIST) {
    // Каждого вида биома хотя бы одно, чтобы все цепочки были замкнуты; видов не из биома — ни одного.
    const count = industryCount(settings, info.kind, info.count * density);
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const relaxed = attempt >= NORMAL_ATTEMPTS;
        const center = { x: rng.range(300, terrain.width - 300), y: rng.range(300, terrain.height - 300) };
        const fp: Footprint = { center, w: info.w, h: info.h, angle: rng.range(-0.6, 0.6) };
        if (terrain.isWater(center, footprintRadius(fp) + 30)) continue;
        if (!shoreFits(terrain, fp, attempt, nearWater, info.kind)) continue;
        if (!relaxed && !terrainFits(terrain, center, attempt, MINING_KINDS.has(info.kind))) continue;
        if (towns.some((t) => dist(t.center, center) < t.radius + 280)) continue;
        if (result.some((i) => dist(i.fp.center, center) < (relaxed ? RELAXED_GAP : 520))) continue;
        if (index.overlaps(fp, 20)) continue;
        const nearest = towns.reduce<Town | null>((best, t) => (!best || dist(t.center, center) < dist(best.center, center) ? t : best), null);
        const industry: Industry = {
          type: 'industry',
          id: ctx.nextId(),
          info,
          name: nearest ? `${info.name} (${nearest.name})` : info.name,
          fp,
          stock: {},
          output: 0,
          producedMonth: 0,
          producedLast: 0,
          prodAcc: 0,
        };
        index.add(industry);
        result.push(industry);
        if (info.kind === 'forest') terrain.addForest(center, 220, rng);
        break;
      }
    }
  }
  return result;
}

export function normalTowards(seg: Corridor, s: number, p: Vec): Vec {
  const t = seg.lut.tangentAt(s);
  const n = { x: -t.y, y: t.x };
  const d = sub(p, seg.lut.pointAt(s));
  return norm(d.x * n.x + d.y * n.y >= 0 ? n : scale(n, -1));
}
