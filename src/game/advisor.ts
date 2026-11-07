/**
 * Советник по партии: замечает по состоянию игры то, что обычно видно только при разборе журнала, — машины
 * не могут выехать со станции, у станции очередь на въезд, груз копится, а машин мало, авто-парку не хватает
 * денег, маршрут не работает, продукцию завода некому вывозить, заводу не хватает второго сырья, деньги на исходе.
 * Каждый совет — что случилось, где (маршрут, станция, предприятие, точка на карте) и, если можно, быстрое
 * действие (купить машину, добавить пост, взять кредит). Только чтение: действия выполняет HUD.
 */
import { CONSTRUCTION, ECONOMY, STATION, STORAGE } from '../config';
import type { Vec } from '../core/vec';
import { CARGO, type CargoType } from '../world/cargo';
import type { Industry, Station } from '../world/entities';
import type { AutoFunds } from './autoFunds';
import type { Game } from './game';
import { type Line, MODELS, vehicleCapacity } from './transport';
import { storageSlots } from './warehouses';

export type AdviceKind =
  | 'debt'
  | 'noRoute'
  | 'stuck'
  | 'queue'
  | 'waiting'
  | 'storage'
  | 'noMoney'
  | 'wrongStop'
  | 'noVehicles'
  | 'unsold'
  | 'missingInput'
  | 'empty'
  /** Стройка дороги стоит: не хватает денег на следующие метры. */
  | 'buildMoney'
  /** Проект заложен давно, а стройка так и не началась: нет свободной бригады или базы. */
  | 'buildIdle'
  /** К проекту нет подъезда: ни один его узел не связан готовой дорогой с базой — бригады к нему не едут. */
  | 'buildNoAccess'
  /** Бригада работает далеко от своей базы — вдвое медленнее и хуже. */
  | 'buildFar'
  /** «Со строительством» базы ещё нет: первую — бесплатно, где удобно игроку. */
  | 'noBase';

/** Важность: alert — что-то стоит, warn — теряете деньги или рост, tip — можно лучше. */
export type AdviceLevel = 'alert' | 'warn' | 'tip';

/** Быстрое действие из совета. */
export type AdviceFix =
  | { kind: 'buy'; line: number }
  | { kind: 'autoMax'; line: number }
  | { kind: 'sell'; line: number }
  | { kind: 'bay'; station: number }
  | { kind: 'depot'; station: number }
  /** Начать новый маршрут с этой станции. */
  | { kind: 'route'; station: number }
  | { kind: 'loan' }
  /** Поставить строительную базу: режим размещения на карте. */
  | { kind: 'base' };

export interface Advice {
  /** Устойчивый ключ: вид и предмет — чтобы совет можно было скрыть и узнать снова. */
  key: string;
  kind: AdviceKind;
  level: AdviceLevel;
  /** Коротко: что случилось. */
  title: string;
  /** Где и что сделать — одной-двумя фразами. */
  detail: string;
  /** Где показать на карте. */
  at?: Vec;
  line?: number;
  station?: number;
  industry?: number;
  /** Груз — значок в совете. */
  cargo?: CargoType | 'passengers';
  /** Число для значка: сколько машин стоит, сколько груза ждёт. */
  count?: number;
  fix?: AdviceFix;
  /** Причина одной строкой — подсказка у значка на карте (нет — по виду совета, см. stationWarnings). */
  reason?: string;
  /** Деньги: сколько на счёте и сколько нужно — полоска в карточке совета. */
  funds?: { have: number; need: number };
}

/** Машина погрузилась и не может выехать дольше стольких секунд — выезд забит. */
export const STUCK_SECONDS = 30;
/** Машина ждёт свободный пост дольше стольких секунд — постов мало. */
export const QUEUE_SECONDS = 15;

const LEVEL_ORDER: Record<AdviceLevel, number> = { alert: 0, warn: 1, tip: 2 };
const fmt = (n: number) => Math.round(n).toLocaleString('ru-RU');
const money = (n: number) => `${Math.round(n) < 0 ? '−' : ''}$${fmt(Math.abs(n))}`;
const seconds = (s: number) => (s >= 90 ? `${Math.round(s / 60)} мин` : `${Math.round(s)} с`);
const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
const cars = (n: number) => `${n} ${plural(n, 'машина', 'машины', 'машин')}`;

/** Все советы по партии — самые важные первыми. */
export function advise(game: Game): Advice[] {
  const out: Advice[] = [];
  money_(game, out);
  building(game, out);
  crews(game, out);
  routes(game, out);
  stations(game, out);
  industries(game, out);
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (b.count ?? 0) - (a.count ?? 0));
}

const cache = new WeakMap<Game, { at: number; wall: number; list: Advice[] }>();

/**
 * Советы для HUD и карты в каждом кадре: пересчёт не чаще раза в полсекунды игрового времени и не реже раза
 * в 0.4 с настоящего — на паузе игрок тоже строит и покупает.
 */
export function adviceOf(game: Game): Advice[] {
  const hit = cache.get(game);
  const wall = Date.now();
  if (hit && Math.abs(game.time - hit.at) < 0.5 && wall - hit.wall < 400) return hit.list;
  const list = advise(game);
  cache.set(game, { at: game.time, wall, list });
  return list;
}

// ---------- Деньги ----------

function money_(game: Game, out: Advice[]): void {
  const canLoan = game.loan < game.loanMax;
  if (game.money < ECONOMY.creditLimit * 0.8) {
    out.push({
      key: 'debt',
      kind: 'debt',
      level: 'alert',
      title: 'На грани банкротства',
      detail: `На счёте ${money(game.money)}, ниже ${money(ECONOMY.creditLimit)} — банкротство.${canLoan ? ' Возьмите кредит или продайте лишние машины.' : ' Продайте лишние машины или убыточные маршруты.'}`,
      fix: canLoan ? { kind: 'loan' } : undefined,
    });
  }
  // Покупка ждёт денег, и их всё ещё не хватает (на паузе игрок мог взять кредит — тогда совета уже нет).
  const starving = [...game.lines.values()]
    .filter((l) => l.auto?.on && l.auto.noMoney)
    .map((line) => ({ line, f: game.autoFunds(line) }))
    .filter((s) => !s.f.ok)
    .sort((a, b) => a.f.need - b.f.need);
  if (starving.length) {
    const { f } = starving[0];
    out.push({
      key: 'noMoney',
      kind: 'noMoney',
      level: 'warn',
      title: 'Авто-парку не хватает денег',
      detail: `${noMoneyText(starving.length === 1 ? starving[0].line.name : null, starving.length, f)}${canLoan ? ` Кредит — ещё до ${money(game.loanMax - game.loan)}.` : ''}`,
      line: starving.length === 1 ? starving[0].line.id : undefined,
      count: starving.length,
      fix: canLoan ? { kind: 'loan' } : undefined,
      funds: { have: f.have, need: f.need },
    });
  }
}

/** Стройка дорог стоит без денег (проекты на паузе — не в счёт): сколько ещё стоит достроить и сколько есть. */
function building(game: Game, out: Advice[]): void {
  const stalled = game.construction.list().filter((i) => i.project.stalled !== undefined && !i.project.paused);
  if (!stalled.length) return;
  const first = stalled[0];
  const need = stalled.reduce((s, i) => s + i.left, 0);
  const canLoan = game.loan < game.loanMax;
  const what = stalled.length === 1 ? `«${first.project.label}»` : `${stalled.length} ${plural(stalled.length, 'проект', 'проекта', 'проектов')}`;
  out.push({
    key: 'buildMoney',
    kind: 'buildMoney',
    level: 'warn',
    title: 'Стройка стоит: не хватает денег',
    detail: `${what}: достроить — ещё ${money(need)}, а на счёте ${money(game.money)} (в долг — до ${money(ECONOMY.creditLimit)}).${canLoan ? ' Возьмите кредит или поставьте лишнее на паузу.' : ' Поставьте лишнее на паузу.'}`,
    at: first.front ?? first.at,
    count: stalled.length,
    fix: canLoan ? { kind: 'loan' } : undefined,
    funds: { have: Math.max(0, game.money), need },
  });
}

/**
 * Бригады стройки: проект давно заложен, а работы не начались (нет базы, все бригады заняты, бригада ещё в пути
 * издалека) — и бригада работает дальше CONSTRUCTION.reach от своей базы (метр там вдвое дольше).
 */
function crews(game: Game, out: Advice[]): void {
  const c = game.construction;
  const crews = c.crews;
  if (game.firstBase) {
    // Пока базы нет, строить некому: заложенные проекты ждут — тогда это уже предупреждение.
    const waiting = c.list().length;
    out.push({
      key: 'noBase',
      kind: 'noBase',
      level: waiting ? 'warn' : 'tip',
      title: 'Поставьте строительную базу',
      detail: `Первая база — бесплатно и с бригадой. Ставьте у дороги ближе к будущим стройкам: оттуда бригада строит быстрее.${waiting ? ` Ждут бригаду: ${waiting} ${plural(waiting, 'проект', 'проекта', 'проектов')}.` : ''}`,
      fix: { kind: 'base' },
    });
  }
  // Нет подъезда: бригады по полю не ездят — проект ждёт дороги к себе или базы рядом (сразу, а не через idleWarn).
  const blocked = crews.bases.size ? c.list().filter((i) => !i.project.paused && !i.access) : [];
  if (blocked.length) {
    const first = blocked[0];
    const what = blocked.length === 1 ? `«${first.project.label}»` : `${blocked.length} ${plural(blocked.length, 'проект', 'проекта', 'проектов')}`;
    out.push({
      key: 'buildNoAccess',
      kind: 'buildNoAccess',
      level: 'warn',
      title: 'Нет подъезда к стройке',
      detail: `${what}: ни один конец не связан готовой дорогой с базой — бригадам не проехать, по полю они не ездят. Постройте дорогу к началу проекта или поставьте базу у дороги рядом с ним.`,
      at: first.front ?? first.at,
      count: blocked.length,
      fix: { kind: 'base' },
    });
  }
  for (const i of c.list()) {
    const p = i.project;
    if (p.paused || p.stalled !== undefined || i.done > 0 || game.time - p.created < CONSTRUCTION.idleWarn || crews.working(p.id).length) continue;
    if (crews.bases.size && !i.access) continue;
    const coming = crews.assigned(p.id).length > 0;
    const why = !crews.bases.size
      ? 'нет строительной базы — поставьте её у дороги («＋ База» на плашке стройки, первая бесплатно)'
      : !crews.brigades.size
        ? 'на базах нет бригад — наймите («＋ Бригада»)'
        : coming
          ? 'бригада ещё в пути — база далеко; поставьте базу ближе'
          : 'все бригады заняты на других проектах — наймите ещё («＋ Бригада») или поставьте лишнее на паузу';
    out.push({
      key: `buildIdle:${p.id}`,
      kind: 'buildIdle',
      level: 'warn',
      title: 'Проект давно не запущен',
      detail: `«${p.label}» заложен ${seconds(game.time - p.created)} назад, а стройка не началась: ${why}.`,
      at: i.at,
    });
  }
  for (const b of crews.brigades.values()) {
    if (b.state !== 'working' || b.project === undefined || !b.pos) continue;
    const base = crews.bases.get(b.base);
    if (!base) continue;
    const d = Math.hypot(base.fp.center.x - b.pos.x, base.fp.center.y - b.pos.y);
    if (d <= CONSTRUCTION.reach) continue;
    const slow = 1 + d / CONSTRUCTION.reach;
    out.push({
      key: `buildFar:${b.id}`,
      kind: 'buildFar',
      level: 'tip',
      title: 'Бригада далеко от базы',
      detail: `Стройка в ${(d / 1000).toFixed(1)} км от базы «${game.baseName(base.id)}»: бригада возит грунт и асфальт издалека — строит в ${slow.toFixed(1)} раза медленнее. Поставьте базу ближе к стройке.`,
      at: b.pos,
    });
  }
}

/**
 * Почему авто-парк не покупает: сколько нужно и сколько на счёте; запас на содержание — если он есть.
 * name — маршрут (один), иначе — сколько маршрутов ждут, нужно — на первую машину.
 */
export function noMoneyText(name: string | null, lines: number, f: AutoFunds): string {
  const who = name ? `«${name}» ждёт машину` : `${lines} ${plural(lines, 'маршрут ждёт', 'маршрута ждут', 'маршрутов ждут')} машины`;
  const need = f.reserve
    ? `нужно ${money(f.need)} — машина ${money(f.price)} и ${money(f.reserve)} на содержание транспорта в конце месяца (выручка его не покроет)`
    : `машина стоит ${money(f.price)}`;
  return `${who}: ${need}, а на счёте ${money(f.have)}.`;
}

// ---------- Маршруты ----------

function stationAt(game: Game, id: number): Station | undefined {
  return game.stations.get(id);
}

function routes(game: Game, out: Advice[]): void {
  for (const line of game.lines.values()) {
    const first = stationAt(game, line.stops[0]);
    if (line.problem) {
      out.push({
        key: `noRoute:${line.id}`,
        kind: 'noRoute',
        level: 'alert',
        title: 'Маршрут не работает',
        detail: `«${line.name}»: ${line.problem}`,
        line: line.id,
        station: first?.id,
        at: first?.fp.center,
      });
    }
    const n = line.vehicles.length;
    const auto = line.auto?.on ? line.auto : null;
    // Машин нет, а между станциями и дороги нет (или её ещё строят) — совет о дороге: машины пока ни к чему.
    const gap = n ? null : game.lineGap(line);
    if (gap) {
      out.push({
        key: `noRoad:${line.id}`,
        kind: 'noRoute',
        level: 'tip',
        title: 'Маршрут без дороги',
        detail: `«${line.name}»: ${gap}. Соедините станции дорогой${game.buildMode ? ' или дождитесь, когда её достроят' : ''} — ${
          auto ? 'тогда авто-парк купит машины' : 'тогда покупайте машины'
        }.`,
        line: line.id,
        station: first?.id,
        at: first?.fp.center,
      });
      continue;
    }
    if (!n && !(auto && auto.max > 0 && auto.min === 0)) {
      // Пассажиры и груз копятся на станциях маршрута и без машин — сколько уже ждёт.
      const carries = game.lineCarries(line);
      const wait = Math.floor(Math.max(0, ...line.stops.map((_, i) => game.lineWaiting(line, i, carries))));
      const what = carries === 'passengers' ? 'пассажиров' : 'ед. груза';
      out.push({
        key: `noVehicles:${line.id}`,
        kind: 'noVehicles',
        level: 'tip',
        title: 'Маршрут без машин',
        detail: `«${line.name}» построен, но по нему никто не ездит.${wait ? ` На станции уже ждут ${fmt(wait)} ${what}.` : ''}`,
        line: line.id,
        at: first?.fp.center,
        fix: { kind: 'buy', line: line.id },
      });
      continue;
    }
    line.stops.forEach((sid, i) => {
      const st = stationAt(game, sid);
      if (!st) return;
      const missing = game.stopMissing(line, i);
      if (missing) {
        out.push({
          key: `wrongStop:${line.id}:${i}`,
          kind: 'wrongStop',
          level: 'warn',
          title: missing === 'cargo' ? 'Станция не работает с грузом' : 'Станция не работает с пассажирами',
          detail: `«${st.name}» на маршруте «${line.name}»: ${missing === 'cargo' ? 'грузовики' : 'автобусы'} заезжают впустую. Включите ${missing === 'cargo' ? 'груз' : 'пассажиров'} в карточке станции.`,
          line: line.id,
          station: st.id,
          at: st.fp.center,
          cargo: missing === 'cargo' ? undefined : 'passengers',
        });
      }
      waiting(game, line, i, st, out);
    });
    // Рейсы уходят полупустыми, а машин несколько — лишние только тратят деньги (авто-парк продаст сам).
    const load = line.loadLast;
    if (load !== undefined && load !== null && load < 0.3 && n >= 2 && !auto) {
      out.push({
        key: `empty:${line.id}`,
        kind: 'empty',
        level: 'tip',
        title: 'Машины ездят полупустыми',
        detail: `«${line.name}»: рейсы загружены на ${Math.round(load * 100)}% — машин больше, чем груза. Продайте лишнюю или включите «полную загрузку» на станции погрузки.`,
        line: line.id,
        at: first?.fp.center,
        fix: { kind: 'sell', line: line.id },
      });
    }
  }
}

/** Груз (пассажиры) копится на остановке, а машин мало: авто-парка нет или он упёрся в максимум. */
function waiting(game: Game, line: Line, i: number, st: Station, out: Advice[]): void {
  const auto = line.auto?.on ? line.auto : null;
  // С авто-парком решать незачем, пока он может докупать; без денег — отдельный совет.
  if (auto && (line.vehicles.length < auto.max || auto.noMoney)) return;
  const v = game.fleet.get(line.vehicles[0]);
  if (!v) return;
  const carries = MODELS[v.model].carries;
  const wait = Math.floor(game.lineWaiting(line, i, carries));
  const cap = vehicleCapacity(v);
  if (wait < Math.max(60, cap * 3)) return;
  // Что копится больше всего — для значка.
  let cargo: CargoType | 'passengers' = 'passengers';
  if (carries === 'freight') {
    let best = 0;
    for (const c of game.loadable(line, i)) {
      const n = st.cargo[c] ?? 0;
      if (n > best) {
        best = n;
        cargo = c;
      }
    }
  }
  const what = cargo === 'passengers' ? 'пассажиров' : `ед. «${CARGO[cargo].name}»`;
  out.push({
    key: `waiting:${line.id}:${i}`,
    kind: 'waiting',
    level: 'warn',
    title: cargo === 'passengers' ? 'Пассажиры ждут' : 'Груз копится',
    detail: `«${st.name}»: ждут отправки ${fmt(wait)} ${what}, а на «${line.name}» ${cars(line.vehicles.length)}.${
      auto ? ' Авто-парк упёрся в максимум — поднимите его.' : ' Купите ещё или включите авто-парк.'
    }`,
    line: line.id,
    station: st.id,
    at: st.fp.center,
    cargo,
    count: wait,
    fix: auto ? { kind: 'autoMax', line: line.id } : { kind: 'buy', line: line.id },
  });
}

// ---------- Станции ----------

function stations(game: Game, out: Advice[]): void {
  const stuck = new Map<number, { n: number; longest: number }>();
  const queued = new Map<number, { n: number; longest: number }>();
  for (const v of game.fleet.values()) {
    if (MODELS[v.model].mode !== 'road') continue;
    const line = game.lines.get(v.lineId);
    const sid = line?.stops[v.stop];
    if (sid === undefined) continue;
    const add = (map: typeof stuck, s: number) => {
      const e = map.get(sid) ?? { n: 0, longest: 0 };
      e.n++;
      e.longest = Math.max(e.longest, s);
      map.set(sid, e);
    };
    const leave = game.departWait(v);
    if (leave >= STUCK_SECONDS) add(stuck, leave);
    const enter = game.bayWait(v);
    if (enter >= QUEUE_SECONDS) add(queued, enter);
  }
  for (const [sid, e] of stuck) {
    const st = stationAt(game, sid);
    if (!st) continue;
    out.push({
      key: `stuck:${sid}`,
      kind: 'stuck',
      level: 'alert',
      title: 'Машины не могут выехать',
      detail: `«${st.name}»: ${cars(e.n)} погрузились и до ${seconds(e.longest)} ждут выезда — дорога у станции забита. Разведите маршруты по разным станциям или расширьте выезд.`,
      station: sid,
      at: st.fp.center,
      count: e.n,
    });
  }
  // Склад станции полон, а у её предприятий есть продукция — класть некуда, завод не растёт.
  for (const st of game.stations.values()) {
    if (!st.serves.cargo || st.kind === 'stop' || !game.stationFull(st)) continue;
    const makers = game.industries.filter((i) => st.industryIds.includes(i.id) && i.producedLast > 0);
    if (!makers.length) continue;
    const more = st.kind === 'road' && storageSlots(st) < STORAGE.max;
    // Продукцию отсюда не берёт ни один маршрут — склад тут ни при чём: нужен маршрут к получателю.
    const product = makers[0].info.produces;
    const name = CARGO[product].name;
    // Маршруты отсюда — и без машин: продукция копится на станции, как только маршрут проложен.
    const here = [...game.lines.values()].filter((l) => l.stops.includes(st.id));
    const taken = here.some((l) => l.stops.some((sid, i) => sid === st.id && game.loadable(l, i).has(product)));
    const stored = `${fmt(game.stationStored(st))} из ${fmt(game.stationStorage(st))} ед.`;
    const why = taken ? 'продукцию некуда класть' : here.length ? `«${name}» отсюда никто не везёт` : 'отсюда не ходит ни один маршрут';
    out.push({
      key: `storage:${st.id}`,
      kind: 'storage',
      level: 'warn',
      title: 'Склад станции полон',
      reason: `Склад станции полон: ${why}`,
      detail: taken
        ? `«${st.name}»: ${stored} — продукции ${makers[0].name} некуда класть, завод не растёт. ${more ? 'Поставьте рядом склад или добавьте машин на вывоз.' : 'Добавьте машин на вывоз.'}`
        : `«${st.name}»: ${stored} «${name}», а ${here.length ? `маршруты отсюда её не берут — на их остановках «${name}» никто не принимает` : 'отсюда не ходит ни один маршрут'}. Проведите маршрут к получателю «${name}».`,
      station: st.id,
      industry: makers[0].id,
      at: st.fp.center,
      cargo: product,
      fix: !taken ? { kind: 'route', station: st.id } : more ? { kind: 'depot', station: st.id } : undefined,
    });
  }
  for (const [sid, e] of queued) {
    const st = stationAt(game, sid);
    if (!st || e.n < 2) continue;
    const more = st.kind === 'road' && st.bays < STATION.maxBays;
    out.push({
      key: `queue:${sid}`,
      kind: 'queue',
      level: 'warn',
      title: 'Очередь на въезд',
      detail: `«${st.name}»: ${cars(e.n)} ждут свободный пост до ${seconds(e.longest)}. ${more ? 'Добавьте пост' : 'Постов больше не поставить — нужна вторая станция рядом'}.`,
      station: sid,
      at: st.fp.center,
      count: e.n,
      fix: more ? { kind: 'bay', station: sid } : undefined,
    });
  }
}

// ---------- Предприятия ----------

/** Станции с грузом, в охвате которых предприятие. */
function docks(game: Game, ind: Industry): Station[] {
  return [...game.stations.values()].filter((st) => st.serves.cargo && st.industryIds.includes(ind.id));
}

function industries(game: Game, out: Advice[]): void {
  for (const ind of game.industries) {
    const at = docks(game, ind);
    if (!at.length) continue;
    const product = ind.info.produces;
    // Завод работает, а его продукцию с его станций не берёт ни один маршрут — он не растёт.
    // Маршрут без машин её берёт (копится на станции) — о нём свой совет «Маршрут без машин».
    if (ind.info.accepts.length && ind.producedLast > 0) {
      const taken = [...game.lines.values()].some((l) => l.stops.some((sid, i) => at.some((st) => st.id === sid) && game.loadable(l, i).has(product)));
      const accepted = game.industries.some((i) => i.info.accepts.includes(product)) || game.towns.some((t) => t.demands.includes(product));
      if (!taken && accepted) {
        out.push({
          key: `unsold:${ind.id}`,
          kind: 'unsold',
          level: 'tip',
          title: 'Продукцию некому вывозить',
          detail: `${ind.name} выпустил ${fmt(ind.producedLast)} ед. «${CARGO[product].name}» за месяц, но ни один маршрут их не забирает — завод не растёт. Проведите маршрут к получателю.`,
          industry: ind.id,
          at: ind.fp.center,
          cargo: product,
          count: ind.producedLast,
        });
      }
    }
    // Завод на два вида сырья получает один — и стоит.
    if (ind.info.accepts.length >= 2) {
      const have = ind.info.accepts.filter((c) => (ind.stock[c] ?? 0) >= 1);
      const lack = ind.info.accepts.filter((c) => (ind.stock[c] ?? 0) < 1);
      if (have.length && lack.length && ind.producedLast === 0) {
        out.push({
          key: `missingInput:${ind.id}`,
          kind: 'missingInput',
          level: 'tip',
          title: 'Заводу не хватает сырья',
          detail: `${ind.name}: на складе ${have.map((c) => `«${CARGO[c].name}»`).join(', ')}, но без ${lack.map((c) => `«${CARGO[c].name}»`).join(' и ')} он не работает.`,
          industry: ind.id,
          at: ind.fp.center,
          cargo: lack[0],
        });
      }
    }
  }
}
