/**
 * Замер расстояний и экономики между соседними городами: по seed и размерам карт — расстояние до ближайшего города
 * (между центрами и между краями застройки), длина и цена шоссе 1+1 между ними, время его стройки одной бригадой и
 * тремя, время рейса автобуса и грузовика (симуляция без машин жителей) и доход полного рейса.
 *
 *   npx vite-node scripts/distance-report.ts                — seed 1…5, средняя и большая
 *   npx vite-node scripts/distance-report.ts -- 3 small     — seed 1…3, маленькая
 */
import { CONSTRUCTION, COST, ECONOMY, ENTERPRISE, MONTH_LENGTH } from '../src/config';
import { dist, type Vec } from '../src/core/vec';
import { buildRate } from '../src/game/constructionWork';
import { paxFare } from '../src/game/fare';
import type { Game } from '../src/game/game';
import { connectNodes, connectStations, freshGame, HIGHWAY, stationAtIndustry, townStreets, withoutCitizens } from '../src/game/testkit';
import { MODELS } from '../src/game/transport';
import { CARGO, RAW_RATE as CARGO_RAW_RATE } from '../src/world/cargo';
import type { Industry, Town } from '../src/world/entities';
import { DEFAULT_SETTINGS, MAP_SIZES, NEW_GAME_SETTINGS, type MapSize } from '../src/world/settings';

const args = process.argv.slice(2).filter((a) => a !== '--');
const seeds = Number(args.find((a) => /^\d+$/.test(a)) ?? 5);
const sizes = (args.filter((a) => a in MAP_SIZES) as MapSize[]).length ? (args.filter((a) => a in MAP_SIZES) as MapSize[]) : (['medium', 'large'] as MapSize[]);

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const r0 = (x: number) => (Number.isFinite(x) ? Math.round(x) : NaN);
const r2 = (x: number) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : NaN);
const edge = (t: Town) => t.extent ?? t.radius;

/** Узел улиц города ближе всего к точке. */
function nodeToward(game: Game, town: Town, p: Vec) {
  const net = game.roads.net;
  let best: { id: number; d: number } | null = null;
  for (const c of townStreets(game, town.id)) {
    for (const id of [c.a, c.b]) {
      const d = dist(net.node(id).pos, p);
      if (!best || d < best.d) best = { id, d };
    }
  }
  return best && net.node(best.id);
}

/** Станция (kind) на улице города как можно ближе к точке p. */
function stationNear(game: Game, town: Town, p: Vec, kind: 'stop' | 'road') {
  const cands = townStreets(game, town.id)
    .filter((c) => c.length > 60)
    .map((c) => c.lut.pointAt(c.length / 2))
    .sort((a, b) => dist(a, p) - dist(b, p))
    .slice(0, 25);
  for (const q of cands) {
    const st = game.placeStation(q, 14, kind);
    if (st) return st;
  }
  return null;
}

/** Время от прибытия на A до прибытия на B (и обратно) для машины модели model на линии A ↔ B, секунд. */
function tripTime(game: Game, a: number, b: number, model: 'bus' | 'truck'): number | null {
  const line = game.createLine([a, b]);
  if (!line) return null;
  const v = game.buyVehicle(line.id, model);
  if (!v) return null;
  const legs: number[] = [];
  let left: number | null = null;
  let last = v.state;
  game.speed = 1;
  for (let t = 0; t < 2000 && legs.length < 4; t += 0.1) {
    game.update(0.1);
    // Только в пути: от отъезда со станции до прибытия на следующую (погрузка и ожидание груза — отдельно).
    if (last === 'loading' && v.state !== 'loading') left = game.time;
    if (v.state === 'loading' && last !== 'loading' && left !== null) legs.push(game.time - left);
    last = v.state;
  }
  game.sellVehicle(v.id);
  return legs.length >= 2 ? mean(legs) : null;
}

interface Row {
  seed: number;
  size: MapSize;
  towns: number;
  nnCenter: number;
  nnCenterMin: number;
  nnEdge: number;
  nnEdgeMin: number;
  road: number;
  /** Между станциями в центрах городов по прямой. */
  span: number;
  cost: number;
  build1: number;
  build3: number;
  bus: number | null;
  truck: number | null;
  /** Цепочки (мир с готовыми предприятиями): от завода до ближайшего поставщика каждого сырья, среднее, м. */
  chain: number;
  /** Медианная такая пара: между станциями у предприятий, рейс грузовика, цена дороги, ставка груза. */
  chainSpan: number;
  chainTruck: number | null;
  chainCost: number;
  chainRate: number;
  /** Месторождения: среднее до края ближайшего города и доля ближе ENTERPRISE.commute.far. */
  depositGap: number;
  walk: number;
}

/** Цепочки сырьё → завод в мире с готовыми предприятиями (по тем же настройкам): расстояния и рейс по медианной. */
function chains(seed: number, size: MapSize) {
  const base = NEW_GAME_SETTINGS.mapScale ? { mapScale: NEW_GAME_SETTINGS.mapScale } : {};
  const game = withoutCitizens(freshGame({ ...DEFAULT_SETTINGS, ...base, seed, size }));
  game.money = 50_000_000;
  const pairs: { a: Industry; b: Industry; d: number }[] = [];
  for (const b of game.industries) {
    for (const cargo of b.info.accepts) {
      const from = game.industries.filter((a) => a.info.produces === cargo).sort((x, y) => dist(x.fp.center, b.fp.center) - dist(y.fp.center, b.fp.center))[0];
      if (from) pairs.push({ a: from, b, d: dist(from.fp.center, b.fp.center) });
    }
  }
  pairs.sort((x, y) => x.d - y.d);
  const out = { chain: mean(pairs.map((p) => p.d)), chainSpan: NaN, chainTruck: null as number | null, chainCost: NaN, chainRate: NaN };
  // Медианная пара, а не выйдет — соседние с ней.
  const mid = Math.floor(pairs.length / 2);
  for (const p of [pairs[mid], pairs[mid - 1], pairs[mid + 1], pairs[mid - 2], pairs[mid + 2]].filter(Boolean)) {
    const sA = stationAtIndustry(game, p.a, p.b.fp.center);
    const sB = stationAtIndustry(game, p.b, p.a.fp.center);
    if (!sA || !sB) continue;
    const before = game.money;
    if (!connectStations(game, sA, sB, HIGHWAY)) continue;
    out.chainCost = before - game.money;
    out.chainSpan = dist(sA.fp.center, sB.fp.center);
    out.chainRate = CARGO[p.a.info.produces!].rate;
    out.chainTruck = tripTime(game, sA.id, sB.id, 'truck');
    break;
  }
  return out;
}

const rows: Row[] = [];
for (const size of sizes) {
  for (let seed = 1; seed <= seeds; seed++) {
    const t0 = Date.now();
    const freight = chains(seed, size);
    const game = withoutCitizens(freshGame({ ...NEW_GAME_SETTINGS, seed, size }));
    game.money = 50_000_000;
    const towns = game.towns;
    // Месторождения («Строит игрок»): от каждого до края ближайшего города — дойдут ли рабочие пешком (commute).
    const gaps = game.enterprises.deposits.map((d) => Math.min(...towns.map((t) => dist(d.center, t.center) - edge(t))));
    const depositGap = mean(gaps);
    const walk = gaps.filter((g) => g < ENTERPRISE.commute.far).length / Math.max(1, gaps.length);
    const nn = towns.map((t) => {
      const o = towns.filter((x) => x !== t).sort((x, y) => dist(x.center, t.center) - dist(y.center, t.center))[0];
      return { t, o, center: dist(t.center, o.center), edge: dist(t.center, o.center) - edge(t) - edge(o) };
    });
    // Пара для стройки и рейса — с медианным расстоянием до ближайшего.
    const sorted = [...nn].sort((x, y) => x.center - y.center);
    let road = NaN;
    let cost = NaN;
    let bus: number | null = null;
    let truck: number | null = null;
    let span = NaN;
    let work = NaN;
    for (const pair of [sorted[Math.floor(sorted.length / 2)], ...sorted]) {
      const A = nodeToward(game, pair.t, pair.o.center);
      const B = nodeToward(game, pair.o, pair.t.center);
      if (!A || !B) continue;
      const before = game.money;
      const had = new Set(game.roads.net.corridors.keys());
      if (!connectNodes(game, A, B, HIGHWAY)) continue;
      cost = before - game.money;
      const fresh = [...game.roads.net.corridors.values()].filter((c) => !had.has(c.id));
      road = fresh.reduce((s, c) => s + c.length, 0);
      // Стройка одной бригадой с базы в центре города A: темп полотна (класс, сооружения, чистое поле — как в игре),
      // по пути — медленнее с расстоянием от базы (1 + d / reach).
      const net = game.roads.net;
      const water = (p: Vec, m?: number) => game.isWater(p, m);
      work = 0;
      for (const c of fresh) {
        // Без чистого поля (игра до него) — всюду застройка.
        const built = (game as unknown as { builtNear?: (p: Vec) => boolean }).builtNear?.bind(game);
        const rate = buildRate(net, c, water, built);
        for (let i = 0; i < 20; i++) work += (c.length / 20 / rate) * (1 + dist(c.lut.pointAt((c.length * (i + 0.5)) / 20), pair.t.center) / CONSTRUCTION.reach);
      }
      // Станции — в центрах городов, как у междугородней линии игрока (охват — жители центра).
      const sa = stationNear(game, pair.t, pair.t.center, 'road');
      const sb = stationNear(game, pair.o, pair.o.center, 'road');
      if (sa && sb) {
        span = dist(sa.fp.center, sb.fp.center);
        bus = tripTime(game, sa.id, sb.id, 'bus');
        truck = tripTime(game, sa.id, sb.id, 'truck');
      }
      break;
    }
    const share3 = CONSTRUCTION.crewShare.reduce((s, x) => s + x, 0);
    rows.push({
      seed,
      size,
      towns: towns.length,
      nnCenter: mean(nn.map((x) => x.center)),
      nnCenterMin: Math.min(...nn.map((x) => x.center)),
      nnEdge: mean(nn.map((x) => x.edge)),
      nnEdgeMin: Math.min(...nn.map((x) => x.edge)),
      road,
      span,
      cost,
      build1: work,
      build3: work / share3,
      bus,
      truck,
      ...freight,
      depositGap,
      walk,
    });
    console.error(`${size} seed ${seed}: ${((Date.now() - t0) / 1000).toFixed(1)} с`);
  }
}

const speedK = (d: number, s: number) => Math.max(ECONOMY.speedMin, Math.min(ECONOMY.speedMax, 0.75 + (0.25 * d) / s / ECONOMY.refSpeed));
/** Производство сырья в месяц на уровне 1 (RAW_RATE) — столько надо вывезти. */
const RAW = CARGO_RAW_RATE;

/** Производные числа строки: всё — в месяцах и долларах. */
function derived(r: Row) {
  const M = MONTH_LENGTH;
  const d = r.span;
  // Полный рейс автобуса между центрами городов: 30 пассажиров в обе стороны.
  const busPay = r.bus ? paxFare(MODELS.bus.capacity, d, null, speedK(d, r.bus)) : NaN;
  const busNet = r.bus ? (busPay * M) / r.bus - MODELS.bus.running : NaN;
  const busPayback = (r.cost + 2 * COST.station + MODELS.bus.price) / busNet;
  // Грузовая цепочка: 16 ед. сырья туда, обратно порожняком; сколько грузовиков вывезут RAW в месяц; окупаемость
  // линии — дорога, две станции, грузовики — против чистого дохода.
  const t = r.chainTruck;
  const truckPay = t ? (MODELS.truck.capacity * r.chainRate * ECONOMY.tariff * r.chainSpan * speedK(r.chainSpan, t)) / 100 : NaN;
  const truckNet = t ? (truckPay * M) / (2 * t) - MODELS.truck.running : NaN;
  const trucks = t ? RAW / (MODELS.truck.capacity * (M / (2 * t))) : NaN;
  const truckLine = r.chainCost + 2 * COST.station + Math.ceil(trucks) * MODELS.truck.price;
  const truckPayback = truckLine / (truckNet * trucks);
  return {
    build1: r.build1 / M,
    build3: r.build3 / M,
    bus: (r.bus ?? NaN) / M,
    truck: (r.truck ?? NaN) / M,
    chainTruck: (t ?? NaN) / M,
    busPay,
    truckPay,
    busNet,
    truckNet,
    trucks,
    busPayback,
    truckPayback,
  };
}

const COLS: [string, (r: Row, x: ReturnType<typeof derived>) => number, (x: number) => number][] = [
  ['городов', (r) => r.towns, r2],
  ['центр ср, м', (r) => r.nnCenter, r0],
  ['центр мин', (r) => r.nnCenterMin, r0],
  ['край ср', (r) => r.nnEdge, r0],
  ['край мин', (r) => r.nnEdgeMin, r0],
  ['дорога, м', (r) => r.road, r0],
  ['станции, м', (r) => r.span, r0],
  ['цена дороги', (r) => r.cost, r0],
  ['стройка 1 бр, мес', (_r, x) => x.build1, r2],
  ['стройка 3 бр, мес', (_r, x) => x.build3, r2],
  ['автобус A→B, мес', (_r, x) => x.bus, r2],
  ['грузовик A→B, мес', (_r, x) => x.truck, r2],
  ['рейс автобуса $', (_r, x) => x.busPay, r0],
  ['автобус чистыми $/мес', (_r, x) => x.busNet, r0],
  ['окупаемость автобус, мес', (_r, x) => x.busPayback, r2],
  ['цепочка ср, м', (r) => r.chain, r0],
  ['цепочка станции, м', (r) => r.chainSpan, r0],
  ['цепочка дорога $', (r) => r.chainCost, r0],
  ['цепочка грузовик, мес', (_r, x) => x.chainTruck, r2],
  ['рейс грузовика $', (_r, x) => x.truckPay, r0],
  ['грузовик чистыми $/мес', (_r, x) => x.truckNet, r0],
  ['грузовиков на сырьё', (_r, x) => x.trucks, r2],
  ['окупаемость грузовая, мес', (_r, x) => x.truckPayback, r2],
  ['месторождение до города, м', (r) => r.depositGap, r0],
  ['доля в пешей доступности', (r) => r.walk, r2],
];

console.log(`MONTH_LENGTH ${MONTH_LENGTH} с · сырья ${RAW}/мес · карты ${sizes.map((s) => `${s} ${MAP_SIZES[s].w}×${MAP_SIZES[s].h}`).join(', ')}`);
console.log(['карта', 'seed', ...COLS.map((c) => c[0])].join('\t'));
for (const r of rows) {
  const x = derived(r);
  console.log([r.size, r.seed, ...COLS.map(([, f, fmt]) => fmt(f(r, x)))].join('\t'));
}
for (const size of sizes) {
  const rs = rows.filter((r) => r.size === size);
  const xs = rs.map(derived);
  const avg = (f: (r: Row, x: ReturnType<typeof derived>) => number) => mean(rs.map((r, i) => f(r, xs[i])).filter(Number.isFinite));
  console.log([size, 'среднее', ...COLS.map(([, f, fmt]) => fmt(avg(f)))].join('\t'));
}

