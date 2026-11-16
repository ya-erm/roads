import { MONTH_LENGTH, TOWN_SCALE } from '../config';
import { hash } from '../core/math';
import { dist } from '../core/vec';
import type { CargoType } from './cargo';
import type { HouseForm, Town, TownBuilding } from './entities';
import { formOf } from './townForms';
import { townNeed } from './townSupply';

/**
 * Получатели грузов в городе (docs/RETAIL.md, этапы 1–2): город потребляет товары не «станцией в охвате», а через
 * конкретные дома — магазины, сельские магазины, рынок, конторы, склады-стройдворы. У каждого — склад: он пустеет
 * со временем (расход — доля нормы города), принимает за раз, сколько влезает. Принятое идёт в Town.supplied — рост,
 * задания и закрытие месяца (townSupply.closeSupply) считают его как раньше.
 *
 * Только партии с WorldSettings.retail; старые — по прежней модели (станция в охвате принимает всё). Подбор — без
 * генератора случайных чисел партии: по месту в городе и хешу id дома. Склад считается при обращении (stockAt): запас
 * и время, на которое он посчитан, — без пересчёта каждый кадр.
 */
export const RETAIL = {
  /** Продуктовых и универмагов: 1 + ⌊жителей / perShops⌋, не больше maxShops. */
  perShops: 1500,
  maxShops: 6,
  /** Мебельных: 1 + ⌊жителей / perFurniture⌋, не больше 2. */
  perFurniture: 6000,
  /** Ювелирных и контор: второй — с bigTown жителей. */
  bigTown: 6000,
  /** Ювелирный — не дальше этой доли радиуса от центра (иначе — ближайший к центру магазин). */
  jewelryCore: 0.3,
  /** Стройдворов: 1 + ⌊жителей / perYard⌋. */
  perYard: 8000,
  /** Вес в доле нормы: рынок, большой магазин (от 4 этажей), прочие. */
  weight: { market: 2, big: 1.5, other: 1 },
  /** Склад — не меньше stockMin и не меньше stockMonths норм получателя. */
  stockMin: 8,
  stockMonths: 2,
  /** Склад нового получателя наполнен на эту долю. */
  startFill: 0.5,
  /**
   * Расход получателя — его доля нормы × consume: с запасом, чтобы снабжая все магазины город закрывал месяц не впритык
   * (приём — целыми единицами, грузовик приходит не к концу месяца), а излишек переносился (townSupply.supplyCarry).
   */
  consume: 1.15,
  /** У рампы: столько секунд и ещё perUnit за каждую единицу. */
  unloadBase: 6,
  unloadPer: 0.4,
  /** Рампа занята — следующий грузовик ждёт на прошлой остановке до стольких секунд, потом пропускает получателя. */
  rampWait: 20,
  /** Грузовик длиннее — во двор не заедет (магазины — до 12,5 м, склады — до 18 м). */
  maxLength: { shop: 12.5, yard: 18 } as const,
  /** Получатель «снабжён» (точка ● под названием города), если склад полон хотя бы на эту долю. */
  stocked: 0.25,
} as const;

/** Получатель: дом города, что он принимает, его вес в доле нормы и склад. */
export interface Receiver {
  /** Дом (TownBuilding.id). */
  b: number;
  /** Какие грузы принимает — из потребностей города. */
  cargo: CargoType[];
  /** Вес в доле нормы (RETAIL.weight). */
  w: number;
  /** Запас по грузам — на момент at. */
  stock: Partial<Record<CargoType, number>>;
  /** Время партии, на которое посчитан запас, с. */
  at: number;
}

/** Широкий участок — «большой» дом генерации (как townForms.BIG_W). */
const BIG_W = 31 * TOWN_SCALE;

/** Группа получателей одного рода: какие грузы, кто подходит и сколько нужно. */
interface Group {
  cargo: CargoType[];
  /** Подходящие дома, лучшие — первыми (по ним же, если подходят все, — разнос по городу). */
  pick: (b: TownBuilding, form: HouseForm) => number;
  count: (pop: number) => number;
}

const shops = (pop: number) => Math.min(RETAIL.maxShops, 1 + Math.floor(pop / RETAIL.perShops));
const big = (b: TownBuilding) => b.floors >= 4;

/**
 * Кто что принимает. pick — пригодность дома (0 — не подходит; больше — лучше: из лучших подбираются, пока их хватает).
 * АЗС (топливо) — этап 3: такого дома в городе пока нет — топливо город принимает по-старому (legacyCargo).
 */
const GROUPS: Group[] = [
  // Продукты: рынок — обязательно, дальше продуктовые (небольшие магазины) и сельские магазины.
  { cargo: ['food'], pick: (b, f) => (f === 'market' ? 3 : f === 'store' ? 2 : f === 'shop' && !big(b) ? 2 : f === 'shop' ? 1 : 0), count: shops },
  // Товары и ткани: универмаги (большие магазины), сельские магазины; нет ни тех ни других — обычные магазины.
  { cargo: ['goods', 'textiles'], pick: (b, f) => (f === 'shop' && big(b) ? 3 : f === 'store' ? 3 : f === 'shop' ? 1 : 0), count: shops },
  // Мебель: магазин на большом участке, нет — любой.
  { cargo: ['furniture'], pick: (b, f) => (f === 'shop' ? (b.fp.w >= BIG_W ? 2 : 1) : f === 'store' ? 0.5 : 0), count: (pop) => Math.min(2, 1 + Math.floor(pop / RETAIL.perFurniture)) },
  // Украшения: магазин у центра (отбор по месту — в pickReceivers).
  { cargo: ['jewelry'], pick: (_b, f) => (f === 'shop' ? 1 : f === 'store' ? 0.5 : 0), count: (pop) => (pop >= RETAIL.bigTown ? 2 : 1) },
  // Бумага: конторы.
  { cargo: ['paper'], pick: (_b, f) => (f === 'office' ? 1 : 0), count: (pop) => (pop >= RETAIL.bigTown ? 2 : 1) },
  // Стройматериалы и стекло: склад-стройдвор.
  { cargo: ['construction', 'glass'], pick: (_b, f) => (f === 'warehouse' ? 1 : 0), count: (pop) => 1 + Math.floor(pop / RETAIL.perYard) },
];

/** Вес получателя в доле нормы: рынок — 2, большой магазин — 1,5, прочие — 1. */
export function receiverWeight(b: Pick<TownBuilding, 'form' | 'kind' | 'floors' | 'fp'>): number {
  const f = formOf(b);
  if (f === 'market') return RETAIL.weight.market;
  if (f === 'shop' && b.floors >= 4) return RETAIL.weight.big;
  return RETAIL.weight.other;
}

/** Может ли дом вообще быть получателем (магазин, сельский магазин, рынок, контора, склад). */
export function receiverForm(b: Pick<TownBuilding, 'form' | 'kind' | 'floors' | 'fp'>): boolean {
  if (b.kind !== 'com') return false;
  const f = formOf(b);
  return f === 'shop' || f === 'store' || f === 'market' || f === 'office' || f === 'warehouse';
}

/**
 * Подбор получателей города: по каждой группе (продукты, товары, мебель…) из потребностей города — сколько нужно по
 * населению, из подходящих домов, вдали друг от друга (ближайший к центру — первым, дальше — самый далёкий от уже
 * выбранных). Те, что стоят в линии (keep), и прежние получатели остаются; reach — к дому можно подъехать (такие —
 * первыми). Запас прежних получателей сохраняется, новые — наполовину полны. time — время партии.
 */
export function pickReceivers(town: Town, time: number, keep: ReadonlySet<number> = new Set(), reach: (b: TownBuilding) => boolean = () => true): Receiver[] {
  const prev = new Map((town.receivers ?? []).map((r) => [r.b, r]));
  const out = new Map<number, Receiver>();
  const byId = new Map(town.buildings.map((b) => [b.id, b]));
  const pop = town.population;
  for (const g of GROUPS) {
    const cargo = g.cargo.filter((c) => town.demands.includes(c));
    if (!cargo.length) continue;
    const cands: { b: TownBuilding; q: number }[] = [];
    for (const b of town.buildings) {
      if (b.kind !== 'com') continue;
      let q = g.pick(b, formOf(b));
      if (q <= 0) continue;
      if (cargo.includes('jewelry')) q += dist(b.fp.center, town.center) <= town.radius * RETAIL.jewelryCore ? 2 : -dist(b.fp.center, town.center) / Math.max(1, town.radius);
      if (reach(b)) q += 10;
      cands.push({ b, q });
    }
    if (!cands.length) continue;
    const top = Math.max(...cands.map((c) => c.q));
    // Лучшие по пригодности; если их не хватает на число — и следующие по пригодности.
    cands.sort((a, b) => b.q - a.q || a.b.id - b.b.id);
    const want = g.count(pop);
    const chosen: TownBuilding[] = [];
    const take = (b: TownBuilding) => {
      if (!chosen.includes(b)) chosen.push(b);
    };
    // Стоящие в линии — всегда; рынок для продуктов — всегда (он и есть «главный» получатель).
    for (const c of cands) if (keep.has(c.b.id) && prev.get(c.b.id)?.cargo.some((x) => cargo.includes(x))) take(c.b);
    if (cargo.includes('food')) for (const c of cands) if (formOf(c.b) === 'market') take(c.b);
    // Прежние получатели этой группы — пока их не больше нужного (город не перетасовывает магазины каждый месяц).
    for (const c of cands) if (chosen.length < want && prev.get(c.b.id)?.cargo.some((x) => cargo.includes(x)) && c.q >= top - 1) take(c.b);
    let pool = cands.filter((c) => c.q >= top - 1 && !chosen.includes(c.b));
    while (chosen.length < want) {
      if (!pool.length) {
        // Лучших не хватило — следующие по пригодности.
        const rest = cands.filter((c) => !chosen.includes(c.b));
        if (!rest.length) break;
        const q = rest[0].q;
        pool = rest.filter((c) => c.q >= q - 1);
      }
      let best = 0;
      let score = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i].b.fp.center;
        // Первый — ближайший к центру, дальше — самый далёкий от выбранных (и чуть по хешу: ровные ряды не в одну сторону).
        const d = chosen.length ? Math.min(...chosen.map((x) => dist(x.fp.center, p))) : -dist(p, town.center);
        const s = d + hash(pool[i].b.id, 41) * 5 + pool[i].q * 1000;
        if (s > score) {
          score = s;
          best = i;
        }
      }
      take(pool[best].b);
      pool.splice(best, 1);
    }
    for (const b of chosen) {
      const r = out.get(b.id);
      if (r) {
        for (const c of cargo) if (!r.cargo.includes(c)) r.cargo.push(c);
        continue;
      }
      out.set(b.id, { b: b.id, cargo: [...cargo], w: receiverWeight(b), stock: {}, at: time });
    }
  }
  // Склад: прежний запас (досчитанный до сейчас) — у прежних, у новых — наполовину.
  const list = [...out.values()].filter((r) => byId.has(r.b)).sort((a, b) => a.b - b.b);
  const draft: Town = { ...town, receivers: list };
  for (const r of list) {
    const was = prev.get(r.b);
    for (const c of r.cargo) {
      const cap = stockCap(draft, r, c);
      const old = was && was.cargo.includes(c) ? stockAt(town, was, c, time) : undefined;
      r.stock[c] = Math.min(cap, old ?? cap * RETAIL.startFill);
    }
    r.at = time;
  }
  return list;
}

/** Сумма весов получателей груза c в городе. */
function weightOf(town: Pick<Town, 'receivers'>, c: CargoType): number {
  let w = 0;
  for (const r of town.receivers ?? []) if (r.cargo.includes(c)) w += r.w;
  return w;
}

/** Расход получателя r по грузу c за месяц: его доля нормы города — townNeed · w / Σw. */
export function receiverNeed(town: Pick<Town, 'receivers' | 'population'>, r: Receiver, c: CargoType): number {
  const w = weightOf(town, c);
  return w > 0 && r.cargo.includes(c) ? (townNeed(town.population) * r.w) / w : 0;
}

/** Склад получателя по грузу c: не меньше RETAIL.stockMin и двух его месячных норм. */
export function stockCap(town: Pick<Town, 'receivers' | 'population'>, r: Receiver, c: CargoType): number {
  return Math.max(RETAIL.stockMin, Math.round(RETAIL.stockMonths * receiverNeed(town, r, c)));
}

/** Расход получателя r по грузу c за месяц: доля нормы с запасом RETAIL.consume. */
export function receiverUse(town: Pick<Town, 'receivers' | 'population'>, r: Receiver, c: CargoType): number {
  return receiverNeed(town, r, c) * RETAIL.consume;
}

/** Запас получателя по грузу c к моменту time: сохранённый минус расход с тех пор. */
export function stockAt(town: Pick<Town, 'receivers' | 'population'>, r: Receiver, c: CargoType, time: number): number {
  const left = (r.stock[c] ?? 0) - (receiverUse(town, r, c) * Math.max(0, time - r.at)) / MONTH_LENGTH;
  return Math.max(0, left);
}

/** Насколько полон склад: 0…1. */
export function stockFill(town: Pick<Town, 'receivers' | 'population'>, r: Receiver, c: CargoType, time: number): number {
  return Math.min(1, stockAt(town, r, c, time) / stockCap(town, r, c));
}

/** Досчитать запас получателя до time (перед приёмом груза). */
export function settleStock(town: Pick<Town, 'receivers' | 'population'>, r: Receiver, time: number): void {
  if (time <= r.at) return;
  for (const c of r.cargo) r.stock[c] = stockAt(town, r, c, time);
  r.at = time;
}

/** Сколько получатель примет груза c сейчас: целые единицы свободного места на складе. */
export function roomFor(town: Pick<Town, 'receivers' | 'population'>, r: Receiver, c: CargoType, time: number): number {
  if (!r.cargo.includes(c)) return 0;
  return Math.max(0, Math.floor(stockCap(town, r, c) - stockAt(town, r, c, time) + 1e-9));
}

/** Получатель принимает до amount единиц груза c: сколько влезло (целые), запас — на складе; в Town.supplied — тоже. */
export function acceptAt(town: Town, r: Receiver, c: CargoType, amount: number, time: number): number {
  settleStock(town, r, time);
  const take = Math.min(Math.floor(amount), roomFor(town, r, c, time));
  if (take <= 0) return 0;
  r.stock[c] = (r.stock[c] ?? 0) + take;
  town.supplied[c] = (town.supplied[c] ?? 0) + take;
  return take;
}

/**
 * Потребности города без получателей: такого дома в городе нет (топливо — до АЗС этапа 3; стройматериалы в селе без
 * склада). Их город принимает по-старому — любой грузовой станцией с домами города в охвате, — иначе задание
 * «привезти в город» было бы невыполнимым.
 */
export function legacyCargo(town: Pick<Town, 'demands' | 'receivers'>): CargoType[] {
  const list = town.receivers ?? [];
  return town.demands.filter((c) => !list.some((r) => r.cargo.includes(c)));
}

/** Получатель-дом города: запись получателя по id дома. */
export function receiverOf(town: Pick<Town, 'receivers'>, b: number): Receiver | undefined {
  return town.receivers?.find((r) => r.b === b);
}

/** Снабжённых получателей груза c в городе из всех (точки «●●○» под названием). */
export function stockedCount(town: Pick<Town, 'receivers' | 'population'>, c: CargoType, time: number): { stocked: number; total: number } {
  let stocked = 0;
  let total = 0;
  for (const r of town.receivers ?? []) {
    if (!r.cargo.includes(c)) continue;
    total++;
    if (stockFill(town, r, c, time) >= RETAIL.stocked) stocked++;
  }
  return { stocked, total };
}

/**
 * Сколько груза c город примет через получателей за months месяцев: их расход за срок (норма по нынешнему населению)
 * и свободное место на складах сейчас; получателей этого груза нет — null (принимает по-старому, без предела).
 */
export function townRoom(town: Pick<Town, 'receivers' | 'population'>, c: CargoType, time: number, months: number): number | null {
  const list = (town.receivers ?? []).filter((r) => r.cargo.includes(c));
  if (!list.length) return null;
  let free = 0;
  for (const r of list) free += stockCap(town, r, c) - stockAt(town, r, c, time);
  return townNeed(town.population) * RETAIL.consume * Math.max(0, months) + free;
}

/** Секунд у рампы на выгрузку amount единиц. */
export function unloadTime(amount: number): number {
  return RETAIL.unloadBase + RETAIL.unloadPer * Math.max(0, amount);
}

/** Самый длинный грузовик, что заедет во двор получателя: к складу — длиннее. */
export function maxTruck(b: Pick<TownBuilding, 'form' | 'kind' | 'floors' | 'fp'>): number {
  return formOf(b) === 'warehouse' ? RETAIL.maxLength.yard : RETAIL.maxLength.shop;
}
