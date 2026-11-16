import { TOWN_SCALE } from '../config';
import { Cubic, CurveLUT, intersectCurves, straightCubic } from '../core/bezier';
import type { Rng } from '../core/rng';
import { add, angleOf, dist, dot, lerp, norm, scale, sub, Vec } from '../core/vec';
import { edgesAt } from '../lanes/geometry';
import { Corridor, LaneNet, LaneNode, LaneSlot, twoWay } from '../lanes/model';
import { biomeOf, townCargo } from './biomes';
import { BASE_TOWN_CARGO, CargoType, EXTRA_TOWN_CARGO, INDUSTRY_LIST, type IndustryKind } from './cargo';
import { placePlayerWorld } from './deposits';
import type { Deposit, Industry, Structure, Town, TownBuilding, TownStyle } from './entities';
import type { Network } from './network';
import { isRail, isTrunk, RAIL_HALF, RoadClass, ROAD_MARGIN } from './roadTypes';
import { areaFactor, DEFAULT_SETTINGS, INDUSTRY_DENSITY, playerIndustries, townSizes, WorldProfile, WorldSettings } from './settings';
import { industryCount, MINING_KINDS, shoreFits, shoreSpot, terrainFits } from './sites';
import { Footprint, footprintCorners, footprintRadius, FootprintIndex, pointInFootprint } from './spatial';
import { layStartRoads } from './startRoads';
import { edgeOf, growTier, inDistrict, JOBS_PER_FLOOR, mergeBlocks, mergeTowers, residentsOf, SETTLE_RULE, tierOfSize, townTier, zoneTown } from './townForms';
import { onPark, placeParks, type ParkSite } from './townParks';
import { type StreetKit, streetsRadius, townStreets } from './townStreets';
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

/**
 * Какую долю перепада высот под городом срезает площадка: остальное — рельеф, по которому идут улицы. Города крупнее
 * (TOWN_SCALE) и захватывают больше склонов — срезается чуть больше прежних 0,7.
 */
const TOWN_LEVEL = 0.76;

/**
 * Площадка под город: земля под улицами плавно тянется к средней высоте (на TOWN_LEVEL), за городом кисть
 * сходит на нет — склоны становятся пологими, но холмы остаются. Правка пишется в правки рельефа, и
 * сохранение (рельеф в нём строится заново по seed) восстанавливает её вместе с городом.
 */
function levelTown(terrain: Terrain, town: Town): void {
  if (!terrain.hasRelief) return;
  const r = town.radius * 1.3 + 100 * TOWN_SCALE;
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
  plantTowns(ctx, towns);
  return { towns, industries, deposits };
}

/** Размах будущего города размера size, м — в масштабе застройки (TOWN_SCALE): от него — место на карте. */
const townReach = (size: number) => (size + 1.5) * 110 * TOWN_SCALE;

/**
 * Зазор между городами по очереди — доли обычного: сперва полный, а не встал город ни в одно место — меньше, и так
 * пока не встанет. Города крупнее прежних (TOWN_SCALE ×1,6 — площадь ×2,6), и с прежним зазором на среднюю карту
 * вставали 5–8 городов из 10; сжимается зазор только у тех, кому не хватило места.
 */
const TOWN_GAP_STEPS = [1, 0.78, 0.56, 0.39, 0.28];

/**
 * Карта занята городами: доля её (без полосы у края) ближе radius + INDUSTRY_TOWN_GAP к центрам городов — больше —
 * новых городов не ставим, чтобы предприятиям осталось место. На средней и большой карте до этого почти не доходит
 * (перед десятым городом — до 69 %), на маленькой крупные города (TOWN_SCALE) иначе не оставляли места для цепочек:
 * там 3–4 города вместо 5–8.
 */
const TOWN_COVER_MAX = 0.7;

/** Доля карты ближе radius + INDUSTRY_TOWN_GAP к центру какого-нибудь города — по сетке 100 м. */
function townCover(terrain: Terrain, towns: readonly Town[]): number {
  if (!towns.length) return 0;
  let hit = 0;
  let n = 0;
  for (let x = 300; x < terrain.width - 300; x += 100) {
    for (let y = 300; y < terrain.height - 300; y += 100) {
      n++;
      if (towns.some((t) => Math.hypot(t.center.x - x, t.center.y - y) < t.radius + INDUSTRY_TOWN_GAP)) hit++;
    }
  }
  return n ? hit / n : 0;
}

/**
 * Ставит город размера size: места — от propose(попытка, зазор) по townSites (attempts попыток на каждый зазор из
 * TOWN_GAP_STEPS · gap). Не встал ни при каком зазоре — города нет.
 */
function placeTown(ctx: WorldContext, towns: Town[], names: string[], size: number, attempts: number, gap: number, propose: (attempt: number, gap: number) => Vec | null): void {
  const { rng } = ctx;
  if (townCover(ctx.terrain, towns) >= TOWN_COVER_MAX) return;
  const reach = townReach(size);
  for (const k of TOWN_GAP_STEPS) {
    for (const c of townSites(ctx.terrain, reach, attempts, (attempt) => propose(attempt, gap * k))) {
      const name = names.splice(rng.int(0, names.length), 1)[0];
      const style: TownStyle =
        size === 3 ? 'radial' : size === 2 ? rng.pick(['radial', 'organic', 'organic', 'organic'] as const) : rng.pick(['linear', 'linear', 'organic'] as const);
      const town = buildTown(ctx, towns.length + 1, c, name, size, style);
      if (town) {
        towns.push(town);
        return;
      }
      names.push(name);
    }
  }
}

export function generateWorld(ctx: WorldContext, settings: WorldSettings = DEFAULT_SETTINGS): World {
  const profile = settings.scenario?.profile;
  if (profile) return generateProfiled(ctx, settings, profile);
  const towns: Town[] = [];
  const names = [...TOWN_NAMES];
  // На тесной карте города ставим ближе друг к другу.
  const gap = settings.size === 'small' ? 600 : 900;
  for (const size of townSizes(settings.towns)) {
    const reach = townReach(size);
    placeTown(ctx, towns, names, size, 80, gap, (_attempt, g) => {
      const c = {
        x: ctx.rng.range(reach + 300, ctx.terrain.width - reach - 300),
        y: ctx.rng.range(reach + 300, ctx.terrain.height - reach - 300),
      };
      if (ctx.terrain.isWater(c, 200)) return null;
      if (towns.some((t) => dist(t.center, c) < t.radius + reach + g)) return null;
      return c;
    });
  }
  assignDemands(towns, ctx.rng, townCargo(settings));
  if (playerIndustries(settings)) return playerWorld(ctx, towns, settings);
  const placed = placeIndustries(ctx, towns, INDUSTRY_DENSITY[settings.industries].k * areaFactor(settings), settings);
  const industries = settings.biome ? settleChains(ctx, towns, placed) : placed;
  // Места для городов и предприятий выбраны по всем улицам; дальше радиус города — по плотной застройке.
  for (const t of towns) measureTown(t);
  layStartRoads(ctx, towns, industries, settings.seed);
  plantTowns(ctx, towns);
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
  // Города крупнее (TOWN_SCALE) — и пятно скопления шире.
  const spread = Math.max(W, H) * (1 - profile.cluster) + 1600 * TOWN_SCALE * profile.cluster;
  for (const size of townSizes(settings.towns, profile)) {
    const reach = townReach(size);
    placeTown(ctx, towns, names, size, 120, profile.gap, (attempt, g) => {
      const free = attempt >= 80 || profile.cluster <= 0;
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(0, spread * (1 + attempt / 40));
      const raw = free
        ? { x: rng.range(reach + 300, W - reach - 300), y: rng.range(reach + 300, H - reach - 300) }
        : { x: focus.x + Math.cos(a) * r, y: focus.y + Math.sin(a) * r };
      const c = { x: Math.max(reach + 300, Math.min(W - reach - 300, raw.x)), y: Math.max(reach + 300, Math.min(H - reach - 300, raw.y)) };
      if (terrain.isWater(c, 200)) return null;
      if (towns.some((t) => dist(t.center, c) < t.radius + reach + g)) return null;
      return c;
    });
  }
  assignDemands(towns, rng, townCargo(settings));
  if (playerIndustries(settings)) return playerWorld(ctx, towns, settings, profile);
  const placed = placeProfiled(ctx, towns, INDUSTRY_DENSITY[settings.industries].k * areaFactor(settings), profile, settings);
  const industries = settings.biome ? settleChains(ctx, towns, placed) : placed;
  for (const t of towns) measureTown(t);
  layStartRoads(ctx, towns, industries, settings.seed);
  plantTowns(ctx, towns);
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
  const clear = townClearance(ctx, towns);
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
        } else center = shoreSpot(terrain, rng, info.kind, attempt, Math.hypot(info.w, info.h) / 2) ?? center;
        const fp: Footprint = { center, w: info.w, h: info.h, angle: rng.range(-0.6, 0.6) };
        if (terrain.isWater(center, footprintRadius(fp) + 30)) continue;
        if (!shoreFits(terrain, fp, attempt, nearWater, info.kind)) continue;
        if (!relaxed && !terrainFits(terrain, center, attempt, MINING_KINDS.has(info.kind))) continue;
        if (!clear(center, info.kind)) continue;
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
    // Город просит три груза, село — два.
    const count = townTier(t) !== 'village' ? 3 : 2;
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
export const EXTRA_DEMAND_POPULATION = 3500;

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

export function buildTown(ctx: WorldContext, id: number, center: Vec, name: string, size: number, style: TownStyle): Town | null {
  const { roads } = ctx;
  const sb: StreetBuilder = { ctx, segs: [] };
  // Очертания — по месту (вода, склоны, край карты); улицы — как у настоящего города (townStreets.ts).
  const shape = townShape(ctx, center, streetsRadius(style, size), { min: 0.6, max: 1.5 });
  const kit: StreetKit = {
    ctx,
    node: (p) => nodeAt(sb, p),
    street: (a, b, curve, main) => street(sb, a, b, curve, main ? AVENUE : STREET),
    shape,
  };
  const district = townStreets(kit, center, size, style);

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

  // Радиус до первой застройки — по 90 % концов улиц: длинный выезд в поле соседний город не отодвигает.
  const far: number[] = [];
  let top = center.y;
  for (const s of alive) {
    for (const p of [s.curve.p0, s.curve.p3]) {
      far.push(dist(p, center));
      top = Math.min(top, p.y);
    }
  }
  far.sort((a, b) => a - b);
  const radius = far[Math.min(far.length - 1, Math.floor(far.length * 0.9))];
  const town: Town = {
    id,
    name,
    center,
    radius: radius + 30 * TOWN_SCALE,
    top: top - 30 * TOWN_SCALE,
    style,
    // Ярус — по размеру генерации: от него — типы домов, панельные дома и высотки, парки (townForms.ts).
    tier: tierOfSize(size, style),
    settled: SETTLE_RULE,
    population: 0,
    buildings: [],
    streets: alive.map((s) => s.id),
    demands: [],
    supplied: {},
    lastSupplied: {},
    tripAcc: 0,
    growthAcc: 0,
    ...(district ? { district } : {}),
  };
  placeLandmark(ctx, town);
  for (const s of alive) fillStreet(ctx, town, s, style === 'linear' ? 0.75 : 0.88);
  buildBlocks(ctx, town);
  // Типы домов и жильцы — сразу: население города (для потребностей, мест под предприятия) — уже по жильцам.
  zoneTown(town);
  recountPopulation(town);
  levelTown(ctx.terrain, town);
  return town;
}

/**
 * Панельные дома: в новом районе и у проспектов в среднем кольце большого города соседние участки сливаются в
 * один дом (townForms.mergeBlocks) — жителей столько же, генератор случайных чисел не тронут (мир по seed тот же).
 */
function buildBlocks(ctx: WorldContext, town: Town): void {
  const city = townTier(town) === 'city';
  if (!town.district && !city) return;
  const onAvenue = (p: Vec) => {
    let best = Infinity;
    let cls: RoadClass | null = null;
    for (const c of ctx.roads.corridorsNear(p, 60)) {
      const d = c.lut.closest(p).d;
      if (d < best) {
        best = d;
        cls = c.cls;
      }
    }
    return cls === 'avenue';
  };
  const ops = {
    fits: (fp: Footprint) => !ctx.index.overlaps(fp, 1) && !ctx.terrain.isWater(fp.center, footprintRadius(fp)) && !onRail(ctx.rail, fp, RAIL_BUFFER) && clearAlong(ctx, fp, 2),
    remove: (b: TownBuilding) => ctx.index.remove(b),
    add: (b: TownBuilding) => ctx.index.add(b),
  };
  mergeBlocks(town, {
    ...ops,
    eligible: (b) => inDistrict(town.district, b.fp.center) || (city && edgeOf(town, b.fp.center) > 0.3 && edgeOf(town, b.fp.center) < 0.8 && onAvenue(b.fp.center)),
  });
  // Высотки: два панельных дома квартала спиной к спине — в один участок от улицы до улицы.
  mergeTowers(town, { ...ops, fronted: (b) => frontedAcross(ctx, b) });
}

/** Через улицу перед домом b (напротив его фасада, в трёх точках вдоль него) стоит хоть одно здание. */
function frontedAcross(ctx: WorldContext, b: TownBuilding): boolean {
  const c = Math.cos(b.fp.angle);
  const s = Math.sin(b.fp.angle);
  const face = b.face ?? -1;
  for (const k of [-1 / 3, 0, 1 / 3]) {
    const lx = k * b.fp.w;
    const ly = (face * b.fp.h) / 2;
    const front = { x: b.fp.center.x + lx * c - ly * s, y: b.fp.center.y + lx * s + ly * c };
    let best: { point: Vec; d: number } | null = null;
    for (const seg of ctx.roads.corridorsNear(front, 40)) {
      const hit = seg.lut.closest(front);
      if (!best || hit.d < best.d) best = { point: hit.point, d: hit.d };
    }
    if (!best || best.d < 0.5) continue;
    const away = scale(sub(best.point, front), (best.d + 12) / best.d);
    const across = add(front, away);
    if (ctx.index.near(across, 25).some((x) => x !== b && x.type === 'building' && dist(x.fp.center, across) < footprintRadius(x.fp) + 14)) return true;
  }
  return false;
}

/** Как clearOfRoads, но точки контура — через каждые 4 м: длинный дом не перекроет улицу между редкими точками. */
function clearAlong(ctx: Pick<WorldContext, 'roads'>, fp: Footprint, margin: number): boolean {
  const c = Math.cos(fp.angle);
  const s = Math.sin(fp.angle);
  const nx = Math.max(2, Math.ceil(fp.w / 4));
  const ny = Math.max(2, Math.ceil(fp.h / 4));
  const pts: Vec[] = [];
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= ny; j++) {
      const lx = (i / nx - 0.5) * fp.w;
      const ly = (j / ny - 0.5) * fp.h;
      pts.push({ x: fp.center.x + lx * c - ly * s, y: fp.center.y + lx * s + ly * c });
    }
  }
  for (const seg of ctx.roads.corridorsNear(fp.center, footprintRadius(fp) + 60)) {
    const hw = corridorHalf(seg) + margin;
    if (pts.some((q) => seg.lut.closest(q).d < hw)) return false;
  }
  return !ctx.roads.nodesNear(fp.center, footprintRadius(fp)).some((n) => pointInFootprint(n.pos, fp, margin + 4));
}

/**
 * Дом второго ряда (TownBuilding.rear) у старых сохранений: от середины его стороны к улице до края ближайшего полотна
 * дальше, чем помещаются тротуар и газон (у дома у улицы — 5 м).
 */
export function rearByGap(roads: LaneNet, b: Pick<TownBuilding, 'fp' | 'face'>): boolean {
  const c = Math.cos(b.fp.angle);
  const s = Math.sin(b.fp.angle);
  const ly = ((b.face ?? -1) * b.fp.h) / 2;
  const p = { x: b.fp.center.x - ly * s, y: b.fp.center.y + ly * c };
  let gap = Infinity;
  for (const k of roads.corridorsNear(p, 40)) {
    const hit = k.lut.closest(p);
    gap = Math.min(gap, hit.d - halfAtS(k, hit.s));
  }
  return gap > 9;
}

/**
 * С какой стороны дома улица (TownBuilding.face): по ближайшей улице к его середине, в осях footprint.
 * Для домов из старых сохранений и перенесённых.
 */
export function streetFace(roads: LaneNet, fp: Footprint): 1 | -1 {
  let best = Infinity;
  let at: Vec | null = null;
  for (const c of roads.corridorsNear(fp.center, footprintRadius(fp) + 60)) {
    const hit = c.lut.closest(fp.center);
    if (hit.d < best) {
      best = hit.d;
      at = hit.point;
    }
  }
  if (!at) return -1;
  const ly = -(at.x - fp.center.x) * Math.sin(fp.angle) + (at.y - fp.center.y) * Math.cos(fp.angle);
  return ly > 0 ? 1 : -1;
}

/** Ратуша или собор в центре города: повёрнута вдоль ближайшей улицы и не задевает дороги. */
function placeLandmark(ctx: WorldContext, town: Town): void {
  for (const size of [44 * TOWN_SCALE, 34 * TOWN_SCALE]) {
    for (let r = 0; r < 240 * TOWN_SCALE; r += 12) {
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
    // Фасадом и фонтаном — к ближайшей улице.
    face: streetFace(ctx.roads, fp),
  };
  ctx.index.add(b);
  town.buildings.push(b);
}

/**
 * Застраивает улицу домами по обеим сторонам. density — доля занятых мест;
 * reach — дальше этого от центра города домов не ставим.
 */
/**
 * Обычный участок дома: по улице и вглубь, м (большой у центра — 51–70 × 45–54). Прежние 22–30 (и 32–44 × 28–34) —
 * в масштабе застройки TOWN_SCALE.
 */
export const LOT = { w: [22 * TOWN_SCALE, 30 * TOWN_SCALE], h: [22 * TOWN_SCALE, 30 * TOWN_SCALE] } as const;
const BIG_LOT = { w: [32 * TOWN_SCALE, 44 * TOWN_SCALE], h: [28 * TOWN_SCALE, 34 * TOWN_SCALE] } as const;
/** Дом второго ряда: глубина участка и зазор до переднего, м. */
const REAR_LOT = { h: [20 * TOWN_SCALE, 26 * TOWN_SCALE], gap: 4 * TOWN_SCALE } as const;
/** От концов улицы (перекрёсток, тупик) до первого участка, м: угол квартала — участкам поперечной улицы. */
const STREET_END = { start: 26 * TOWN_SCALE, end: 22 * TOWN_SCALE } as const;

export function fillStreet(ctx: WorldContext, town: Town, seg: Corridor, density: number, limit = Infinity, reach = Infinity): number {
  const { rng } = ctx;
  const hw = corridorHalf(seg);
  let added = 0;
  for (const side of [-1, 1]) {
    let s = STREET_END.start;
    while (s < seg.length - STREET_END.start && added < limit) {
      const p0 = seg.lut.pointAt(s);
      const closeness = 1 - Math.min(1, dist(p0, town.center) / Math.max(1, town.radius));
      // Участки — в масштабе дорог (полоса 7 м, машина 7 × 4): дом с двором 35–48 м по улице, большой у центра — 51–70.
      const big = closeness > 0.55 && rng.chance(0.55);
      const width = big ? rng.range(BIG_LOT.w[0], BIG_LOT.w[1]) : rng.range(LOT.w[0], LOT.w[1]);
      const depth = big ? rng.range(BIG_LOT.h[0], BIG_LOT.h[1]) : rng.range(LOT.h[0], LOT.h[1]);
      const at = s + width / 2;
      if (at + width / 2 > seg.length - STREET_END.end) break;
      s += width + rng.range(2, 5) * TOWN_SCALE;
      if (rng.next() > density || dist(p0, town.center) > reach) continue;
      const p = seg.lut.pointAt(at);
      const t = seg.lut.tangentAt(at);
      const normal = { x: -t.y * side, y: t.x * side };
      const center = add(p, scale(normal, hw + 5 + depth / 2));
      const fp: Footprint = { center, w: width, h: depth, angle: Math.atan2(t.y, t.x) };
      // Парки и скверы (townParks.ts) рост обходит: дом на них не встаёт; к домам соседнего города — тоже.
      if (!placeable(ctx, fp, seg.id) || onPark(town, fp) || foreignNear(ctx, town, fp)) continue;
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
        // Дом стоит по нормали side от улицы: сама улица — с другой стороны, по оси y footprint это −side.
        face: side === 1 ? -1 : 1,
      };
      ctx.index.add(b);
      town.buildings.push(b);
      added++;
      // Второй ряд домов в глубине квартала — чаще ближе к центру.
      if (added < limit && rng.chance(0.15 + 0.4 * closeness)) {
        const d2 = rng.range(REAR_LOT.h[0], REAR_LOT.h[1]);
        const rear: Footprint = {
          center: add(p, scale(normal, hw + 5 + depth + REAR_LOT.gap + d2 / 2)),
          w: width * rng.range(0.85, 1),
          h: d2,
          angle: fp.angle,
        };
        if (placeable(ctx, rear, seg.id) && !onPark(town, rear) && !foreignNear(ctx, town, rear)) {
          const [rc, rr] = rng.pick(RES_COLORS);
          const back: TownBuilding = { ...b, id: ctx.nextId(), fp: rear, kind: 'res', floors: rng.int(1, 3), color: rc, roof: rr, rear: true };
          ctx.index.add(back);
          town.buildings.push(back);
          added++;
        }
      }
    }
  }
  return added;
}

/**
 * Между участками разных городов — поле не уже стольких метров: города крупнее (TOWN_SCALE) и стоят теснее, но не
 * срастаются в один ни при генерации, ни при росте.
 */
const TOWN_SEAM = 40 * TOWN_SCALE;

/** Участок fp ближе TOWN_SEAM к дому другого города. */
function foreignNear(ctx: WorldContext, town: Town, fp: Footprint): boolean {
  const r = footprintRadius(fp) + TOWN_SEAM;
  return ctx.index.near(fp.center, r + 120).some((x) => x.type === 'building' && x.townId !== town.id && dist(x.fp.center, fp.center) < r + footprintRadius(x.fp));
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

/** Жители города: жильцы домов (townForms.residentsOf) и рабочие места деловых — по 4 на этаж. */
export function recountPopulation(town: Town): void {
  town.population = town.buildings.reduce((sum, b) => sum + (b.kind === 'res' ? residentsOf(b) : b.kind === 'com' ? b.floors * JOBS_PER_FLOOR : 0), 0);
}

/**
 * Край плотной застройки — расстояние от центра: идём от середины застройки наружу, пока кольцо
 * шириной 80 м застроено хотя бы впятеро реже ядра. Длинные улицы с редкими домами в поле за ним не в счёт.
 */
export function coreRadius(town: Town): number {
  const ds = town.buildings.map((b) => dist(b.fp.center, town.center)).sort((a, b) => a - b);
  if (!ds.length) return 0;
  // Кольцо и шаг — в масштабе застройки: домов в кольце столько же, сколько при прежних участках.
  const W = 80 * TOWN_SCALE;
  let r = Math.max(60 * TOWN_SCALE, ds[Math.floor(ds.length / 2)]);
  let i = 0;
  while (i < ds.length && ds[i] <= r) i++;
  const core = i / (Math.PI * r * r);
  let j = i;
  for (;;) {
    while (j < ds.length && ds[j] <= r + W) j++;
    if (j - i < core * 0.2 * Math.PI * ((r + W) ** 2 - r ** 2)) break;
    r += 20 * TOWN_SCALE;
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
  town.radius = Math.max(100 * TOWN_SCALE, coreRadius(town) + 30 * TOWN_SCALE);
  town.extent = Math.max(town.radius, far + 10);
  // Типы застройки и жильцы новым домам (и домам старых сохранений) — по месту в городе нынешнего размера
  // (townForms.ts); население — по жильцам; дорос — ярус выше.
  zoneTown(town);
  recountPopulation(town);
  growTier(town);
}

/** Городская улица для парков: на земле, не магистраль и не съезд. */
function parkStreet(roads: LaneNet, c: Corridor): boolean {
  return !isHighway(c) && roads.node(c.a).level === 0 && roads.node(c.b).level === 0;
}

/** Место для парков по миру партии (townParks.ts): дома и строения из индекса, дороги, вода, пути. */
export function parkSite(ctx: WorldContext): ParkSite {
  const { roads, terrain, index } = ctx;
  const shore = (p: Vec, cap: number) => {
    if (!terrain.isWater(p, cap)) return cap;
    let lo = 0;
    let hi = cap;
    for (let k = 0; k < 6; k++) {
      const m = (lo + hi) / 2;
      if (terrain.isWater(p, m)) hi = m;
      else lo = m;
    }
    return (lo + hi) / 2;
  };
  return {
    fits(fp, nearWater = false) {
      if (!terrain.inBounds(fp.center, 30) || index.overlaps(fp, 3)) return false;
      if (nearWater) {
        if (terrain.isWater(fp.center, 1) || footprintCorners(fp).some((c) => terrain.isWater(c, 1))) return false;
      } else if (terrain.isWater(fp.center, footprintRadius(fp) + 2)) return false;
      if (onRail(ctx.rail, fp, RAIL_BUFFER)) return false;
      // Дороги: точки оси через 3 м не ближе полуширины полотна с запасом — по длине дорог, а не по площади участка
      // (большой парк — сотни точек контура против десятков точек оси).
      const R = footprintRadius(fp);
      for (const seg of roads.corridorsNear(fp.center, R + 40)) {
        const hw = corridorHalf(seg) + 2;
        const lut = seg.lut;
        for (let s = 0; s <= seg.length; s += 3) {
          const p = lut.pointAt(Math.min(s, seg.length));
          if (Math.abs(p.x - fp.center.x) > R + hw || Math.abs(p.y - fp.center.y) > R + hw) continue;
          if (pointInFootprint(p, fp, hw)) return false;
        }
      }
      return !roads.nodesNear(fp.center, R).some((n) => pointInFootprint(n.pos, fp, 6));
    },
    corners(center, r) {
      const out: { pos: Vec; dirs: number[]; half: number }[] = [];
      for (const n of roads.nodesNear(center, r)) {
        if (n.level !== 0 || n.corridors.length < 2) continue;
        const cs = n.corridors.map((id) => roads.corridor(id));
        if (!cs.every((c) => parkStreet(roads, c))) continue;
        out.push({ pos: n.pos, dirs: roads.ends(n).map((e) => angleOf(e.away)), half: Math.max(...cs.map(corridorHalf)) });
      }
      return out;
    },
    curbs(center, r, step) {
      const out: { p: Vec; t: Vec; half: number }[] = [];
      for (const seg of roads.corridorsNear(center, r)) {
        if (!parkStreet(roads, seg)) continue;
        for (let s = 10; s < seg.length - 10; s += step) {
          const p = seg.lut.pointAt(s);
          if (dist(p, center) > r) continue;
          out.push({ p, t: seg.lut.tangentAt(s), half: halfAtS(seg, s) });
        }
      }
      return out;
    },
    angle(p) {
      // Как streetAngle, но ближе: парк у центра — у своей улицы, а не у дальней.
      let best = Infinity;
      let angle = 0;
      for (const seg of roads.corridorsNear(p, 90)) {
        const hit = seg.lut.closest(p);
        if (hit.d < best) {
          best = hit.d;
          angle = angleOf(seg.lut.tangentAt(hit.s));
        }
      }
      return angle;
    },
    shore,
    houses: (p, r) => index.near(p, r).filter((s) => s.type === 'building' && dist(s.fp.center, p) < r).length,
  };
}

/** Парки и скверы всем городам — когда мир построен (после улиц, домов, предприятий и дорог между городами). */
function plantTowns(ctx: WorldContext, towns: Town[]): void {
  const site = parkSite(ctx);
  for (const t of towns) placeParks(t, site);
}

/** Предприятие при генерации — не ближе стольких метров к краю застройки города. */
const INDUSTRY_TOWN_GAP = 280;

/**
 * Точка далеко от городов — место под предприятие: дальше INDUSTRY_TOWN_GAP от плотной застройки (по coreRadius, как
 * у measureTown, а не по концам улиц-выездов: города крупнее — TOWN_SCALE, и круг по выездам закрывал полкарты,
 * с берегами для рыбаков) и не ближе 200 м к любому дому за ней.
 */
function townClearance(ctx: WorldContext, towns: Town[]): (p: Vec, kind: IndustryKind) => boolean {
  const edge = new Map(towns.map((t) => [t, Math.max(100 * TOWN_SCALE, coreRadius(t) + 30 * TOWN_SCALE)]));
  return (p, kind) => {
    // Рыбаки — на берегу, а берега рек — в городах: им можно ближе к городу (рыбацкая слобода у окраины).
    const gap = kind === 'fishery' ? FISHERY_TOWN_GAP : INDUSTRY_TOWN_GAP;
    const houseGap = Math.min(200, gap);
    return (
      !towns.some((t) => dist(t.center, p) < edge.get(t)! + gap) &&
      !ctx.index.near(p, houseGap + 60).some((x) => x.type === 'building' && dist(x.fp.center, p) < houseGap + footprintRadius(x.fp))
    );
  };
}
/** Рыбаки — не ближе стольких метров к краю застройки (остальные — INDUSTRY_TOWN_GAP). */
const FISHERY_TOWN_GAP = 100;

function placeIndustries(ctx: WorldContext, towns: Town[], density: number, settings: WorldSettings): Industry[] {
  const { rng, terrain, index } = ctx;
  const result: Industry[] = [];
  const nearWater = new Set(biomeOf(settings).nearWater);
  const clear = townClearance(ctx, towns);
  // Каждое звено цепочки на счету: не нашлось места за обычные попытки — ищем ещё, ближе к соседям и на любом склоне.
  // Прежде так — только у мира с биомом; города крупнее (TOWN_SCALE), и старому миру без биома тоже не хватало места.
  const attempts = RELAXED_ATTEMPTS;
  for (const info of INDUSTRY_LIST) {
    // Каждого вида биома хотя бы одно, чтобы все цепочки были замкнуты; видов не из биома — ни одного.
    const count = industryCount(settings, info.kind, info.count * density);
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const relaxed = attempt >= NORMAL_ATTEMPTS;
        const random = { x: rng.range(300, terrain.width - 300), y: rng.range(300, terrain.height - 300) };
        const center = shoreSpot(terrain, rng, info.kind, attempt, Math.hypot(info.w, info.h) / 2) ?? random;
        const fp: Footprint = { center, w: info.w, h: info.h, angle: rng.range(-0.6, 0.6) };
        if (terrain.isWater(center, footprintRadius(fp) + 30)) continue;
        if (!shoreFits(terrain, fp, attempt, nearWater, info.kind)) continue;
        if (!relaxed && !terrainFits(terrain, center, attempt, MINING_KINDS.has(info.kind))) continue;
        if (!clear(center, info.kind)) continue;
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
