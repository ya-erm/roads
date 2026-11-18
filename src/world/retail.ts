import { MONTH_LENGTH, TOWN_SCALE } from '../config';
import { hash } from '../core/math';
import { dist } from '../core/vec';
import type { CargoType } from './cargo';
import type { HouseForm, Town, TownBuilding } from './entities';
import { formOf } from './townForms';
import { townNeed } from './townSupply';

/**
 * Получатели грузов в городе (docs/RETAIL.md, этапы 1–3): город потребляет товары не «станцией в охвате», а через
 * конкретные дома — магазины, сельские магазины, рынок, конторы, склады-стройдворы, АЗС. У каждого — склад: он пустеет
 * со временем (расход — доля нормы города), принимает за раз, сколько влезает. Принятое идёт в Town.supplied — рост,
 * задания и закрытие месяца (townSupply.closeSupply) считают его как раньше. Рынок принимает и сырую рыбу с рыбаков —
 * в счёт продуктов, не больше трети нормы за месяц. Оптовая база — не потребитель, а склад-пересадка (Receiver.depot):
 * фура сдаёт на базу всё, что просит город, развозка забирает оттуда к магазинам.
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
   * Было 1,15 — при ровной развозке (одна линия «все магазины», 4 Грузовика, норма 20) выходило 18 / 22 / 15 за месяц:
   * магазины полны к началу месяца, и приём упирается в расход. С 1,35 норма закрывается и тогда, когда грузовик к
   * одному магазину опоздал, а снабжая получателей с ¾ веса нормы (рынок и магазин из трёх: 0,75 × 1,35 ≥ 1) — тоже
   * (docs/RETAIL.md, этап 4).
   */
  consume: 1.35,
  /** У рампы: столько секунд и ещё perUnit за каждую единицу. */
  unloadBase: 6,
  unloadPer: 0.4,
  /** Рампа занята — следующий грузовик ждёт на прошлой остановке до стольких секунд, потом пропускает получателя. */
  rampWait: 20,
  /**
   * Грузовик заезжает к получателю, только если на складе есть место хотя бы на эту долю (или на весь остаток кузова):
   * заезд во двор и выезд — ~45 с, почти месяц; за крохами — мимо, к следующему (game.dockIdle, docs/RETAIL.md, этап 4).
   */
  worthVisit: 0.3,
  /** В кузове меньше этой доли вместимости — к магазинам не заезжает, сперва догрузиться (крохи не стоят заезда). */
  crumbs: 0.2,
  /**
   * Грузовик длиннее — во двор не заедет: к магазинам — Грузовик (12 м) и Грузовик II (15 м), к складам — и Фура (21 м).
   */
  maxLength: { shop: 15, yard: 21 } as const,
  /** Получатель «снабжён» (точка ● под названием города), если склад полон хотя бы на эту долю. */
  stocked: 0.25,
  /** АЗС: 1 + ⌊жителей / perFuel⌋, не больше maxFuel — в городах, которым нужно топливо. */
  perFuel: 6000,
  maxFuel: 3,
  /** Оптовая база — одна, в городе от depotPop жителей; её склад (станции у базы) — depotStock единиц всех грузов. */
  depotPop: 2500,
  depotStock: 150,
  /** Рыба на рынке — в счёт продуктов, не больше этой доли нормы за месяц. */
  fishShare: 1 / 3,
  /**
   * Рост к магазинам: улицы не дальше pull от получателя с грузом на складе застраиваются раньше (в очереди роста —
   * ближе к центру на pullBonus); у получателя, пустого dryMonths месяцев подряд, дома ближе block не прибавляются.
   */
  pull: 500,
  pullBonus: 80,
  block: 330,
  dryMonths: 2,
} as const;

/** Сколько АЗС нужно городу: 1 + ⌊жителей / 6000⌋, не больше трёх; топливо городу не нужно — ни одной. */
export function fuelCount(town: Pick<Town, 'population' | 'demands'>): number {
  if (!town.demands.includes('fuel')) return 0;
  return Math.min(RETAIL.maxFuel, 1 + Math.floor(town.population / RETAIL.perFuel));
}

/** Оптовых баз у города: одна от RETAIL.depotPop жителей. */
export const depotCount = (town: Pick<Town, 'population'>): number => (town.population >= RETAIL.depotPop ? 1 : 0);

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
  /**
   * Оптовая база: принимает всё, что просит город, но не в счёт снабжения — на склад своей станции (RETAIL.depotStock),
   * откуда груз забирает развозка; в доле нормы не участвует (w = 0). Нет — обычный получатель.
   */
  depot?: true;
  /** Сколько месяцев подряд склад был пуст в конце месяца (markDry); нет — не пуст. */
  dry?: number;
  /** Рыбы принято на рынке за этот месяц (не больше трети нормы продуктов). */
  fish?: number;
  /** Хоть раз принимал груз от игрока: город снабжают — пустые магазины тормозят рост рядом (game.retailGrowth). */
  fed?: true;
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
 * Топливо — АЗС; в городе, где АЗС ещё нет (партии этапов 1–2 до роста), — по-старому (legacyCargo).
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
  // Топливо: АЗС (zoneRetail) — все, что есть.
  { cargo: ['fuel'], pick: (_b, f) => (f === 'fuel' ? 1 : 0), count: () => RETAIL.maxFuel },
];

/** Вес получателя в доле нормы: рынок — 2, большой магазин — 1,5, прочие — 1. */
export function receiverWeight(b: Pick<TownBuilding, 'form' | 'kind' | 'floors' | 'fp'>): number {
  const f = formOf(b);
  if (f === 'market') return RETAIL.weight.market;
  if (f === 'shop' && b.floors >= 4) return RETAIL.weight.big;
  return RETAIL.weight.other;
}

/** Может ли дом вообще быть получателем (магазин, сельский магазин, рынок, контора, склад, АЗС, оптовая база). */
export function receiverForm(b: Pick<TownBuilding, 'form' | 'kind' | 'floors' | 'fp'>): boolean {
  if (b.kind !== 'com') return false;
  const f = formOf(b);
  return f === 'shop' || f === 'store' || f === 'market' || f === 'office' || f === 'warehouse' || f === 'fuel' || f === 'depot';
}

/** Что можно отдать под АЗС и оптовую базу: обычные магазины, конторы, склады (не рынок, не гаражи — там машины жителей). */
const SITE_FORMS: ReadonlySet<HouseForm> = new Set(['shop', 'store', 'office', 'warehouse']);

/** Где город ставит АЗС и оптовую базу (zoneRetail): что знает о месте только игра — улица перед домом, трасса рядом. */
export interface RetailSites {
  /** Пригодность дома под АЗС или базу: больше — лучше; null — не подходит (база — на узком участке). */
  score(b: TownBuilding, kind: 'fuel' | 'depot'): number | null;
  /** Дома, которые не трогать: получатели, к которым ездят маршруты. */
  keep: ReadonlySet<number>;
  /** Только эти дома можно отдать (новые при росте); нет — любые (начало новой партии). */
  fresh?: ReadonlySet<number>;
}

/**
 * АЗС и оптовая база города (только партии с получателями): сколько нужно (fuelCount, depotCount) — из обычных
 * магазинов, контор и складов, лучших по месту (sites.score: у выездов, у больших улиц и трассы), АЗС — вдали друг от
 * друга. Каждого вида домов остаётся столько, сколько нужно получателям этого вида (продуктовых — по населению,
 * контор, стройдворов); уже стоящие — в счёт, обратно не превращаются. Детерминировано (место и хеш дома).
 * Возвращает число новых.
 */
export function zoneRetail(town: Town, sites: RetailSites): number {
  const pop = town.population;
  const count = (forms: HouseForm[]) => town.buildings.filter((b) => b.kind === 'com' && forms.includes(formOf(b))).length;
  // Сколько домов каждого вида оставить получателям.
  const reserve = (f: HouseForm): [HouseForm[], number] => {
    if (f === 'shop' || f === 'store') return [['shop', 'store'], shops(pop) + 1];
    if (f === 'office') return [['office'], pop >= RETAIL.bigTown ? 2 : 1];
    return [['warehouse'], town.demands.includes('construction') || town.demands.includes('glass') ? 1 + Math.floor(pop / RETAIL.perYard) : 0];
  };
  let made = 0;
  const pick = (kind: 'fuel' | 'depot', want: number) => {
    let have = count([kind]);
    while (have < want) {
      const placed = town.buildings.filter((b) => b.kind === 'com' && formOf(b) === kind);
      let best: TownBuilding | null = null;
      let bestScore = -Infinity;
      for (const b of town.buildings) {
        if (b.kind !== 'com' || !SITE_FORMS.has(formOf(b)) || sites.keep.has(b.id) || (sites.fresh && !sites.fresh.has(b.id))) continue;
        const [forms, need] = reserve(formOf(b));
        if (count(forms) - 1 < need) continue;
        const q = sites.score(b, kind);
        if (q === null) continue;
        // АЗС — вдали друг от друга: ближе полрадиуса к другой — хуже.
        const near = placed.some((o) => dist(o.fp.center, b.fp.center) < Math.max(150, town.radius * 0.5));
        const s = q - (near ? 5 : 0) + hash(b.id, 43) * 0.01;
        if (s > bestScore) {
          bestScore = s;
          best = b;
        }
      }
      if (!best) return;
      best.form = kind;
      have++;
      made++;
    }
  };
  pick('depot', depotCount(town));
  pick('fuel', fuelCount(town));
  return made;
}

/**
 * Подбор получателей города: по каждой группе (продукты, товары, мебель…) из потребностей города — сколько нужно по
 * населению, из подходящих домов, вдали друг от друга (ближайший к центру — первым, дальше — самый далёкий от уже
 * выбранных). Те, что стоят в линии (keep), и прежние получатели остаются; reach — к дому можно подъехать (такие —
 * первыми). Запас прежних получателей сохраняется, новые — наполовину полны. time — время партии. fish — на карте
 * есть рыбаки: рынок принимает и рыбу. Оптовая база (дом 'depot', zoneRetail) — получатель всех потребностей города.
 */
export function pickReceivers(
  town: Town,
  time: number,
  keep: ReadonlySet<number> = new Set(),
  reach: (b: TownBuilding) => boolean = () => true,
  opts: { fish?: boolean } = {},
): Receiver[] {
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
    // К кому не подъехать — не получатель, пока есть досягаемые (и не стоит в линии): иначе его доля нормы не закрылась
    // бы никогда (закрыть норму — значит снабдить почти всех: расход — с запасом всего ×RETAIL.consume).
    const near = chosen.filter((b) => keep.has(b.id) || reach(b));
    if (near.length && near.length < chosen.length) chosen.splice(0, chosen.length, ...near);
    for (const b of chosen) {
      const r = out.get(b.id);
      if (r) {
        for (const c of cargo) if (!r.cargo.includes(c)) r.cargo.push(c);
        continue;
      }
      out.set(b.id, { b: b.id, cargo: [...cargo], w: receiverWeight(b), stock: {}, at: time });
    }
  }
  // Рынок — и рыбу с рыбаков (в счёт продуктов, ≤ ⅓ нормы).
  if (opts.fish) {
    for (const r of out.values()) {
      const b = byId.get(r.b);
      if (b && formOf(b) === 'market' && r.cargo.includes('food') && !r.cargo.includes('fish')) r.cargo.push('fish');
    }
  }
  // Оптовая база — всё, что просит город (одна: первая по id; склад у неё — на станции у базы).
  if (town.demands.length) {
    const depot = town.buildings.filter((b) => b.kind === 'com' && formOf(b) === 'depot').sort((a, b) => a.id - b.id)[0];
    if (depot && !out.has(depot.id)) out.set(depot.id, { b: depot.id, cargo: [...town.demands], w: 0, stock: {}, at: time, depot: true });
  }
  // Склад: прежний запас (досчитанный до сейчас) — у прежних, у новых — наполовину.
  const list = [...out.values()].filter((r) => byId.has(r.b)).sort((a, b) => a.b - b.b);
  const draft: Town = { ...town, receivers: list };
  for (const r of list) {
    const was = prev.get(r.b);
    if (was?.dry) r.dry = was.dry;
    if (was?.fish) r.fish = was.fish;
    if (was?.fed) r.fed = true;
    r.at = time;
    if (r.depot) continue;
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

/** Расход получателя r по грузу c за месяц: его доля нормы города — townNeed · w / Σw; рыба на рынке — треть нормы. */
export function receiverNeed(town: Pick<Town, 'receivers' | 'population'>, r: Receiver, c: CargoType): number {
  if (r.depot) return 0;
  if (c === 'fish') return r.cargo.includes('fish') ? townNeed(town.population) * RETAIL.fishShare : 0;
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

/**
 * Сколько получатель примет груза c сейчас: целые единицы свободного места на складе; рыбы — ещё и не больше трети
 * нормы продуктов за месяц. Оптовая база — 0: её склад — на станции (game.ts).
 */
export function roomFor(town: Pick<Town, 'receivers' | 'population'>, r: Receiver, c: CargoType, time: number): number {
  if (!r.cargo.includes(c) || r.depot) return 0;
  const room = Math.max(0, Math.floor(stockCap(town, r, c) - stockAt(town, r, c, time) + 1e-9));
  if (c !== 'fish') return room;
  return Math.max(0, Math.min(room, Math.floor(townNeed(town.population) * RETAIL.fishShare + 1e-9) - (r.fish ?? 0)));
}

/**
 * Получатель принимает до amount единиц груза c: сколько влезло (целые), запас — на складе; в Town.supplied — тоже
 * (рыба на рынке — в счёт продуктов).
 */
export function acceptAt(town: Town, r: Receiver, c: CargoType, amount: number, time: number): number {
  settleStock(town, r, time);
  const take = Math.min(Math.floor(amount), roomFor(town, r, c, time));
  if (take <= 0) return 0;
  r.stock[c] = (r.stock[c] ?? 0) + take;
  r.fed = true;
  const as: CargoType = c === 'fish' ? 'food' : c;
  if (c === 'fish') r.fish = (r.fish ?? 0) + take;
  town.supplied[as] = (town.supplied[as] ?? 0) + take;
  return take;
}

/**
 * Конец месяца у получателей города: сколько месяцев подряд склад пуст (Receiver.dry — у пустого 2 месяца дома рядом
 * не прибавляются), счёт рыбы за месяц — с нуля. Оптовая база — без счёта.
 */
export function markDry(town: Town, time: number): void {
  for (const r of town.receivers ?? []) {
    delete r.fish;
    if (r.depot) continue;
    const empty = r.cargo.every((c) => c === 'fish' || stockAt(town, r, c, time) < 1);
    if (empty) r.dry = (r.dry ?? 0) + 1;
    else delete r.dry;
  }
}

/** Получатель с грузом на складе (хотя бы единица чего-то, кроме рыбы): улицы рядом застраиваются раньше. */
export function receiverStocked(town: Pick<Town, 'receivers' | 'population'>, r: Receiver, time: number): boolean {
  return !r.depot && r.cargo.some((c) => c !== 'fish' && stockAt(town, r, c, time) >= 1);
}

/** Получатель пуст RETAIL.dryMonths месяцев подряд: дома рядом не прибавляются. */
export const receiverDry = (r: Receiver): boolean => !r.depot && (r.dry ?? 0) >= RETAIL.dryMonths;

/**
 * Потребности города без получателей: такого дома в городе нет (топливо — пока нет АЗС: партии этапов 1–2 до роста;
 * стройматериалы в селе без склада). Их город принимает по-старому — любой грузовой станцией с домами города в
 * охвате, — иначе задание «привезти в город» было бы невыполнимым. Оптовая база — не в счёт: она не потребитель.
 */
export function legacyCargo(town: Pick<Town, 'demands' | 'receivers'>): CargoType[] {
  const list = (town.receivers ?? []).filter((r) => !r.depot);
  return town.demands.filter((c) => !list.some((r) => r.cargo.includes(c)));
}

/** Оптовая база города (её запись получателя); нет — undefined. */
export function depotOf(town: Pick<Town, 'receivers'>): Receiver | undefined {
  return town.receivers?.find((r) => r.depot);
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
    if (!r.cargo.includes(c) || r.depot) continue;
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
  const list = (town.receivers ?? []).filter((r) => r.cargo.includes(c) && !r.depot);
  if (!list.length) return null;
  let free = 0;
  for (const r of list) free += stockCap(town, r, c) - stockAt(town, r, c, time);
  return townNeed(town.population) * RETAIL.consume * Math.max(0, months) + free;
}

/**
 * Норму груза c можно закрыть: получатели, к которым подъехать (ok), примут за месяц не меньше нормы — их расход с
 * запасом RETAIL.consume. Получателей груза нет — принимает по-старому: можно.
 */
export function needClosable(town: Pick<Town, 'receivers' | 'population'>, c: CargoType, ok: (r: Receiver) => boolean): boolean {
  const list = (town.receivers ?? []).filter((r) => !r.depot && r.cargo.includes(c));
  if (!list.length) return true;
  const take = list.filter(ok).reduce((s, r) => s + receiverUse(town, r, c), 0);
  return take >= townNeed(town.population) - 1e-9;
}

/** Секунд у рампы на выгрузку amount единиц. */
export function unloadTime(amount: number): number {
  return RETAIL.unloadBase + RETAIL.unloadPer * Math.max(0, amount);
}

/** Верхний предел модели; конкретный двор дополнительно проверяется по траектории и габаритам сцепки. */
export function maxTruck(b: Pick<TownBuilding, 'form' | 'kind' | 'floors' | 'fp'>): number {
  const f = formOf(b);
  return ['warehouse', 'fuel', 'depot', 'shop', 'store', 'market', 'office'].includes(f) ? RETAIL.maxLength.yard : RETAIL.maxLength.shop;
}
