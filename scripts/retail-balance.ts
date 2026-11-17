/**
 * Замер баланса снабжения (docs/RETAIL.md, этап 4), по настоящим городам 5 seed (большая карта, новая партия):
 * сколько Грузовиков (16 ед.) и линий нужно, чтобы закрыть продуктовую норму. Круг: подвоз от завода (d = 2000 ед.,
 * как perVehicleMonth: 2·d·1,3/26 + 20 с на две остановки), по городу — 14 ед./с, путь ×1,3. Заезд во двор — замер в
 * игре: подход, заезд, рампа и выезд в просвет сверх обычной езды — было ~57 с, с быстрым манёвром ~45 с; станция — 10 с.
 *
 *   npx vite-node scripts/retail-balance.ts -- --visit=57         — как было: грузовик заезжает во все магазины
 *   npx vite-node scripts/retail-balance.ts -- --visit=45 --skip  — как стало: только туда, где есть место
 */
import { MONTH_LENGTH } from '../src/config';
import { dist, type Vec } from '../src/core/vec';
import { Game } from '../src/game/game';
import { RETAIL, receiverUse, stockCap } from '../src/world/retail';
import { townNeed } from '../src/world/townSupply';
import type { Town } from '../src/world/entities';
import { NEW_GAME_SETTINGS } from '../src/world/settings';

const args = process.argv.slice(2);
const num = (k: string, d: number) => Number(args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d);
const D = num('d', 2000);
const VISIT = num('visit', 57);
const SKIP = args.includes('--skip');
const CAP = 16;
const TOWN_V = 14;
const STOP = 10;
const trunk = (2 * D * 1.3) / 26 + 2 * STOP;

const perTruck = (round: number) => (CAP * MONTH_LENGTH) / round;

function tour(start: Vec, pts: Vec[]): number {
  let at = start;
  let len = 0;
  const left = [...pts];
  while (left.length) {
    let k = 0;
    for (let i = 1; i < left.length; i++) if (dist(left[i], at) < dist(left[k], at)) k = i;
    len += dist(left[k], at);
    at = left.splice(k, 1)[0];
  }
  return len + dist(at, start);
}

const sum: Record<string, number[]> = {};
for (const seed of [3, 7, 11, 23, 42]) {
  const game = new Game({ ...NEW_GAME_SETTINGS, seed, size: 'large' });
  const used = new Set<number>();
  for (const target of [2000, 4000, 10000]) {
    const town = [...game.towns]
      .filter((t) => t.demands.includes('food') && !used.has(t.id))
      .sort((a, b) => Math.abs(Math.log(a.population / target)) - Math.abs(Math.log(b.population / target)))[0] as Town;
    used.add(town.id);
    const need = townNeed(town.population);
    const recs = (town.receivers ?? []).filter((r) => !r.depot && r.cargo.includes('food'));
    const bs = recs.map((r) => town.buildings.find((b) => b.id === r.b)!);
    const reach = recs.filter((_, i) => game.docks.reachable(bs[i], 12));
    const W = recs.reduce((s, r) => s + r.w, 0);
    const wReach = reach.reduce((s, r) => s + r.w, 0);
    // Сколько нормы примут все (досягаемые) магазины за месяц: расход с запасом.
    const take = reach.reduce((s, r) => s + receiverUse(town, r, 'food'), 0);
    const closable = take >= need;
    // Въезд в город — край застройки со стороны ближайшего соседа (оттуда подвоз).
    const edge = { x: town.center.x + town.radius, y: town.center.y };
    // Старая модель: до станции в центре и обратно — один пост, весь кузов.
    const oldRound = trunk + (2 * dist(edge, town.center) * 1.3) / TOWN_V;
    const oldTrucks = Math.ceil(need / perTruck(oldRound));
    // Новая: объезд всех досягаемых магазинов (сейчас) или только тех, где есть место (--skip).
    const pts = reach.map((r) => town.buildings.find((b) => b.id === r.b)!.fp.center);
    const full = tour(edge, pts);
    const caps = reach.map((r) => stockCap(town, r, 'food'));
    const use = reach.map((r) => receiverUse(town, r, 'food'));
    const avgCap = caps.reduce((s, c, i) => s + c * use[i], 0) / Math.max(1e-9, use.reduce((a, b) => a + b, 0));
    // Склад к приезду грузовика полон в среднем наполовину: на загрузку — столько магазинов.
    const visits = SKIP ? Math.min(reach.length, Math.max(1, CAP / (avgCap / 2))) : reach.length;
    const avgHop = reach.length > 1 ? (full - 2 * dist(edge, town.center)) / reach.length : 0;
    const townPath = SKIP ? 2 * dist(edge, town.center) + Math.max(0, visits - 1) * Math.max(0, avgHop) : full;
    const newRound = trunk - STOP + (townPath * 1.3) / TOWN_V + visits * VISIT;
    const newTrucks = closable ? Math.ceil(need / perTruck(newRound)) : Infinity;
    // Линия «рынок → 2 магазина»: какую долю нормы закроет.
    const sorted = [...reach].sort((a, b) => b.w - a.w);
    const part = Math.min(1, sorted.slice(0, 3).reduce((s, r) => s + receiverUse(town, r, 'food'), 0) / need);
    const k = `${target}`;
    (sum[k] ??= []).push(newRound / oldRound);
    console.log(
      `seed ${String(seed).padStart(2)} ${town.name.padEnd(12)} ${String(town.population).padStart(6)} жит. норма ${need}: магазинов ${recs.length} (досягаемо ${reach.length}, вес ${wReach}/${W}) · старая ${oldTrucks} груз. (круг ${Math.round(oldRound)} с) · новая ${
        Number.isFinite(newTrucks) ? newTrucks : '✗'
      } груз. (круг ${Math.round(newRound)} с, ${visits.toFixed(1)} заезда, ×${(newRound / oldRound).toFixed(2)}) · «3 главных» — ${Math.round(part * 100)}% нормы`,
    );
  }
}
for (const [k, v] of Object.entries(sum)) console.log(`~${k} жит.: круг ×${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)} (${v.map((x) => x.toFixed(2)).join(', ')})`);
console.log(`consume ${RETAIL.consume}, stockMonths ${RETAIL.stockMonths}, visit ${VISIT} с, skip ${SKIP}`);
