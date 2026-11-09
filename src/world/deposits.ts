/**
 * Мир режима «Строит игрок» (docs/INDUSTRIES.md): вместо готовой добычи — месторождения, на старте — несколько
 * предприятий: заводы в части городских мест (их продукция нужна городу) с добычей на ближних месторождениях,
 * добыча «на вырост» и пара заброшенных. Всё — по генератору мира (seed).
 */
import { ENTERPRISE } from '../config';
import { dist, type Vec } from '../core/vec';
import { biomeOf, industryShare } from './biomes';
import { type CargoType, INDUSTRY_LIST, type IndustryType } from './cargo';
import { buildableKinds, depositFootprint, depositRichness, harmClass, isRaw, obtainable, townEdge, townFor, townGap, townSlots } from './enterprise';
import type { Deposit, Industry, Town } from './entities';
import type { WorldProfile, WorldSettings } from './settings';
import { industryCount, MINING_KINDS, shoreFits, terrainFits } from './sites';
import { type Footprint, footprintRadius, footprintsOverlap } from './spatial';
import { clearOfRoads, type WorldContext } from './worldgen';

/** Попыток найти место месторождению (у мира с биомом — ещё, с меньшим зазором). */
const ATTEMPTS = 140;
const RELAXED = 220;
/** Зазор между месторождениями и от черты города до месторождения. */
const GAP = 480;
const RELAXED_GAP = 340;
const TOWN_GAP = 160;

/** Вид есть в биоме этого мира. */
const inBiome = (settings: WorldSettings) => (kind: IndustryType['kind']) => industryShare(settings, kind) > 0;

/** Размер месторождения по жребию: малое, среднее, богатое (ENTERPRISE.deposits.sizes). */
function rollSize(r: number): 0 | 1 | 2 {
  const sizes = ENTERPRISE.deposits.sizes;
  let acc = 0;
  for (let i = 0; i < sizes.length; i++) {
    acc += sizes[i].odds;
    if (r < acc) return i as 0 | 1 | 2;
  }
  return 2;
}

/**
 * Месторождения сырья: на каждый вид добычи биома — в ENTERPRISE.deposits.share раз больше, чем ставилось готовых
 * предприятий, по тем же правилам места (берег, склоны, зазор до городов и друг до друга). profile.hub — тянутся
 * к крупнейшему городу, profile.raw — больше или меньше.
 */
export function placeDeposits(ctx: WorldContext, towns: Town[], density: number, settings: WorldSettings, profile?: WorldProfile): Deposit[] {
  const { rng, terrain, index } = ctx;
  const out: Deposit[] = [];
  const nearWater = new Set(biomeOf(settings).nearWater);
  const hub = profile && profile.hub > 0 ? [...towns].sort((a, b) => b.population - a.population)[0] : undefined;
  const hubSpread = profile ? Math.max(terrain.width, terrain.height) * (1 - profile.hub) + 2400 * profile.hub : 0;
  for (const info of INDUSTRY_LIST) {
    if (!isRaw(info)) continue;
    const count = industryCount(settings, info.kind, info.count * density * ENTERPRISE.deposits.share * (profile?.raw ?? 1));
    for (let n = 0; n < count; n++) {
      for (let attempt = 0; attempt < RELAXED; attempt++) {
        const relaxed = attempt >= ATTEMPTS;
        let center = { x: rng.range(300, terrain.width - 300), y: rng.range(300, terrain.height - 300) };
        if (hub && attempt < 100) {
          const a = rng.range(0, Math.PI * 2);
          const r = rng.range(townEdge(hub) + 300, townEdge(hub) + 300 + hubSpread * (1 + attempt / 60));
          center = { x: hub.center.x + Math.cos(a) * r, y: hub.center.y + Math.sin(a) * r };
          if (center.x < 300 || center.y < 300 || center.x > terrain.width - 300 || center.y > terrain.height - 300) continue;
        }
        const fp: Footprint = { center, w: info.w, h: info.h, angle: rng.range(-0.6, 0.6) };
        if (terrain.isWater(center, footprintRadius(fp) + 30)) continue;
        if (!shoreFits(terrain, fp, attempt, nearWater, info.kind)) continue;
        if (!relaxed && !terrainFits(terrain, center, attempt, MINING_KINDS.has(info.kind))) continue;
        if (towns.some((t) => townGap(t, fp) < TOWN_GAP)) continue;
        if (out.some((d) => dist(d.center, center) < (relaxed ? RELAXED_GAP : GAP))) continue;
        if (index.overlaps(fp, 20) || !clearOfRoads(ctx, fp, 8)) continue;
        const d: Deposit = { id: ctx.nextId(), kind: info.kind, center, angle: fp.angle, size: rollSize(rng.next()) };
        out.push(d);
        // Лесной участок — это лес: деревья вокруг, как раньше у лесозаготовки.
        if (info.kind === 'forest') terrain.addForest(center, 220, rng);
        break;
      }
    }
  }
  return out;
}

/** Предприятие вида info на участке fp; ближайший город — в названии. */
function makeIndustry(ctx: WorldContext, towns: Town[], info: IndustryType, fp: Footprint, extra: Partial<Industry> = {}): Industry {
  const nearest = towns.reduce<Town | null>((b, t) => (!b || dist(t.center, fp.center) < dist(b.center, fp.center) ? t : b), null);
  const ind: Industry = {
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
    ...extra,
  };
  ctx.index.add(ind);
  return ind;
}

/** Добыча на месторождении d (его богатство — множитель добычи). */
function onDeposit(ctx: WorldContext, towns: Town[], d: Deposit, extra: Partial<Industry> = {}): Industry {
  const info = INDUSTRY_LIST.find((t) => t.kind === d.kind)!;
  const ind = makeIndustry(ctx, towns, info, depositFootprint(d, info), { richness: depositRichness(d), ...extra });
  d.used = ind.id;
  return ind;
}

/**
 * Свободное место под предприятие вида info у города: в черте (inside — задевает застройку) или за ней на
 * от from до to от черты. Без сноса: ни домов, ни дорог, ни воды, ни месторождений. Первое подходящее по кругу
 * от случайного угла; нет — null.
 */
export function townSpot(
  ctx: Pick<WorldContext, 'roads' | 'terrain' | 'index'>,
  town: Town,
  info: Pick<IndustryType, 'w' | 'h'>,
  start: number,
  opts: { inside: boolean; from?: number; to?: number; deposits?: readonly Deposit[]; towns?: readonly Town[] },
): Footprint | null {
  const { terrain, index } = ctx;
  const edge = townEdge(town);
  const half = Math.hypot(info.w, info.h) / 2;
  // В черте — по кольцу у края застройки; за ней — шагами наружу.
  const rings = opts.inside ? [edge - half * 0.4, edge - half * 0.9, edge - half * 1.5, edge] : range(edge + half / 2 + (opts.from ?? 0), edge + half / 2 + (opts.to ?? 600), 60);
  for (const r of rings) {
    if (r <= 40) continue;
    for (let k = 0; k < 32; k++) {
      const a = start + (k / 32) * Math.PI * 2;
      const center = { x: town.center.x + Math.cos(a) * r, y: town.center.y + Math.sin(a) * r };
      // Длинной стороной — вдоль края города.
      const fp: Footprint = { center, w: info.w, h: info.h, angle: a + Math.PI / 2 };
      if (!terrain.inBounds(center, half + 40) || terrain.isWater(center, half + 10)) continue;
      const own = opts.towns ? townFor(opts.towns, fp) : townGap(town, fp) < 0 ? town : null;
      if (opts.inside ? own !== town : own !== null) continue;
      if (index.overlaps(fp, 6) || !clearOfRoads(ctx, fp, 6)) continue;
      if (ctx.roads.nodesNear(center, half + 12).length) continue;
      if (opts.deposits?.some((d) => dist(d.center, center) < half + ENTERPRISE.deposits.radius)) continue;
      return fp;
    }
  }
  return null;
}

function range(a: number, b: number, step: number): number[] {
  const out: number[] = [];
  for (let x = a; x <= b; x += step) out.push(x);
  return out;
}

/**
 * Завод для города: невредный (класс 0) вид биома, чья продукция нужна городу (а нет таких — любому городу),
 * сырьё для него можно получить на карте. На одно сырьё — первыми. Нет — null.
 */
export function townPlantKind(
  town: Town,
  towns: readonly Town[],
  kinds: readonly IndustryType[],
  pick: (n: number) => number,
  have: readonly IndustryType['kind'][] = [],
): IndustryType | null {
  const clean = kinds.filter((k) => !isRaw(k) && harmClass(k.kind) === 0 && k.accepts.every((c) => obtainable(c, kinds)));
  const wanted = towns.flatMap((t) => t.demands);
  // Сначала — виды, которых на карте ещё нет, на одно сырьё.
  const pool = (list: IndustryType[]) => {
    const fresh = list.filter((k) => !have.includes(k.kind));
    const base = fresh.length ? fresh : list;
    const single = base.filter((k) => k.accepts.length === 1);
    return single.length ? single : base;
  };
  for (const list of [clean.filter((k) => town.demands.includes(k.produces)), clean.filter((k) => wanted.includes(k.produces))]) {
    const p = pool(list);
    if (p.length) return p[pick(p.length)];
  }
  return null;
}

/**
 * Месторождения и стартовые предприятия мира «Строит игрок». Города уже с потребностями (их сужаем до того, что
 * можно сделать из месторождений и видов биома); density — множитель числа (по плотности и площади карты).
 */
export function placePlayerWorld(
  ctx: WorldContext,
  towns: Town[],
  density: number,
  settings: WorldSettings,
  profile?: WorldProfile,
): { industries: Industry[]; deposits: Deposit[] } {
  const { rng } = ctx;
  const S = ENTERPRISE.start;
  const deposits = placeDeposits(ctx, towns, density, settings, profile);
  const kinds = buildableKinds(inBiome(settings), deposits);
  // Города не просят то, чего не сделать: на карте нет месторождений сырья или вида завода в биоме.
  for (const t of towns) t.demands = t.demands.filter((c) => obtainable(c, kinds));
  const industries: Industry[] = [];
  const pick = (n: number) => rng.int(0, n);
  const k = Math.max(0.5, density);
  // Заводы в части городских мест: крупные города — чаще.
  const withSlots = [...towns].filter((t) => townSlots(t) > 0).sort((a, b) => b.population - a.population);
  const plants = Math.min(withSlots.length, Math.max(1, Math.round(withSlots.length * S.townPlants * k * (profile?.plants ?? 1))));
  // Крупные — первыми, но через одного: занятые места и пустые — вперемешку.
  const order = withSlots.filter(() => rng.chance(0.6));
  for (const t of withSlots) if (!order.includes(t)) order.push(t);
  for (const town of order) {
    if (industries.length >= plants) break;
    const info = townPlantKind(town, towns, kinds, pick, industries.map((i) => i.info.kind));
    if (!info) continue;
    const fp = townSpot(ctx, town, info, rng.range(0, Math.PI * 2), { inside: true, deposits, towns });
    if (fp) industries.push(makeIndustry(ctx, towns, info, fp));
  }
  // Сырьё стартовым заводам — с ближайших свободных месторождений: первая цепочка работает сразу.
  const supplied = industries.slice(0, 2);
  for (const plant of supplied) {
    for (const c of plant.info.accepts) {
      const d = nearestDeposit(deposits, c, plant.fp.center, 6000);
      if (d) industries.push(onDeposit(ctx, towns, d));
    }
  }
  // Добыча «на вырост»: сырьё, которое пока никто не перерабатывает, у месторождения поближе к городу.
  const lone = Math.max(1, Math.round(S.loneRaw * k));
  for (let n = 0; n < lone; n++) {
    const used = new Set(industries.flatMap((i) => [i.info.produces, ...i.info.accepts]));
    const free = deposits.filter((d) => d.used === undefined && !used.has(rawCargo(d)) && kinds.some((x) => x.accepts.includes(rawCargo(d))));
    const near = free.map((d) => ({ d, gap: Math.min(...towns.map((t) => dist(t.center, d.center) - townEdge(t))) })).sort((a, b) => a.gap - b.gap);
    const d = near.slice(0, 4)[pick(Math.max(1, Math.min(4, near.length)))]?.d;
    if (d) industries.push(onDeposit(ctx, towns, d));
  }
  // Заброшенные: старая шахта на месторождении и старый завод за городом — восстановить дешевле, чем строить.
  const ruins = Math.max(1, Math.round(S.ruins * k));
  for (let n = 0; n < ruins; n++) {
    if (n % 2 === 0) {
      const free = deposits.filter((d) => d.used === undefined);
      const d = free[pick(Math.max(1, free.length))];
      if (d) industries.push(onDeposit(ctx, towns, d, { ruin: true }));
      continue;
    }
    const plantKinds = kinds.filter((x) => !isRaw(x) && x.accepts.every((c) => obtainable(c, kinds)));
    const town = towns[pick(Math.max(1, towns.length))];
    const info = plantKinds[pick(Math.max(1, plantKinds.length))];
    if (!town || !info) continue;
    const fp = townSpot(ctx, town, info, rng.range(0, Math.PI * 2), { inside: false, from: 200 * harmClass(info.kind) + 150, to: 900, deposits, towns });
    if (fp && !industries.some((i) => footprintsOverlap(i.fp, fp, 30))) industries.push(makeIndustry(ctx, towns, info, fp, { ruin: true }));
  }
  return { industries, deposits };
}

/** Какое сырьё на месторождении. */
export const rawCargo = (d: Deposit): CargoType => INDUSTRY_LIST.find((t) => t.kind === d.kind)!.produces;

/** Ближайшее свободное месторождение сырья cargo не дальше max от точки. */
export function nearestDeposit(deposits: readonly Deposit[], cargo: CargoType, p: Vec, max = Infinity): Deposit | null {
  let best: Deposit | null = null;
  for (const d of deposits) {
    if (d.used !== undefined || rawCargo(d) !== cargo) continue;
    if (dist(d.center, p) <= max && (!best || dist(d.center, p) < dist(best.center, p))) best = d;
  }
  return best;
}
