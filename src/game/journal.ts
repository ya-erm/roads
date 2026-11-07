/**
 * Журнал партии — для разбора и отладки: действия игрока (стройка, станции, линии, покупки), рейсы транспорта
 * (что выгрузил, что погрузил, сколько заплатили), месячные сводки производства, городов и финансов, задания
 * и события сценария. Хранится вместе с сохранением, скачивается из меню файлом JSON Lines.
 *
 * Числа округляются до сотых (координаты и деньги — до целых): так журнал не раздувается от длинных дробей.
 */

import { MONTH_LENGTH } from '../config';
import type { Game } from './game';

/** Запись журнала: m — время в месяцах от начала партии (12.25 — четверть тринадцатого месяца), k — что случилось. */
export interface JournalEntry {
  m: number;
  k: string;
  [key: string]: unknown;
}

/** Сколько записей держать. Сверх предела первыми уходят старые рейсы: задания, события и сводки ценнее. */
export const JOURNAL_LIMIT = 15_000;
/** Записи о рейсах — их больше всего. */
const TRIPS = new Set(['stop', 'go']);

/** Число до сотых; −0 — как 0. */
export const r2 = (n: number) => Math.round(n * 100) / 100 || 0;

/** Глубокая копия с округлением чисел до сотых и без пустых полей. */
export function tidy(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? r2(value) : null;
  if (Array.isArray(value)) return value.map(tidy);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      out[k] = tidy(v);
    }
    return out;
  }
  return value;
}

export class Journal {
  readonly entries: JournalEntry[];

  constructor(
    private readonly clock: () => number,
    saved?: JournalEntry[],
  ) {
    this.entries = saved ? [...saved] : [];
  }

  add(k: string, data: Record<string, unknown> = {}): void {
    this.entries.push({ m: r2(this.clock()), k, ...(tidy(data) as Record<string, unknown>) });
    if (this.entries.length > JOURNAL_LIMIT) this.trim();
  }

  /** Убирает десятую часть предела: сначала старые рейсы, если их не хватило — самые старые записи. */
  private trim(): void {
    let drop = this.entries.length - Math.floor(JOURNAL_LIMIT * 0.9);
    const kept = this.entries.filter((e) => {
      if (drop > 0 && TRIPS.has(e.k)) {
        drop--;
        return false;
      }
      return true;
    });
    if (drop > 0) kept.splice(0, drop);
    this.entries.length = 0;
    this.entries.push(...kept);
  }

  /** Последние n записей — для сохранения, когда в браузере мало места. */
  tail(n: number): JournalEntry[] {
    return this.entries.slice(-n);
  }
}

/**
 * Файл журнала (JSON Lines): шапка со словарём ключей, справочник мира (города, предприятия, станции, линии,
 * транспорт — чтобы id в записях можно было расшифровать), состояние сценария на момент выгрузки, затем записи.
 */
export function journalFile(game: Game): string {
  const s = game.settings;
  const pos = (p: { x: number; y: number }) => [Math.round(p.x), Math.round(p.y)];
  const head = {
    k: 'header',
    app: 'razvyazka',
    exported: new Date().toISOString(),
    date: game.dateLabel,
    month: game.monthIndex,
    /** Год начала партии: month в записях — от него. */
    startYear: game.startYear,
    monthSeconds: MONTH_LENGTH,
    seed: s.seed,
    settings: s,
    money: game.money,
    loan: game.loan,
    entries: game.journal.entries.length,
    legend: JOURNAL_LEGEND,
  };
  const world = {
    k: 'world',
    towns: game.towns.map((t) => [t.id, t.name, ...pos(t.center), t.population, t.demands]),
    industries: game.industries.map((i) => [i.id, i.info.kind, i.name, ...pos(i.fp.center), i.level ?? 1, i.cap ?? undefined]),
    stations: [...game.stations.values()].map((st) => [st.id, st.name, st.kind, ...pos(st.fp.center), st.townIds, st.industryIds]),
    lines: [...game.lines.values()].map((l) => [l.id, l.name, l.stops, l.vehicles]),
    fleet: [...game.fleet.values()].map((v) => [v.id, v.model, v.lineId, v.state, v.cargo, v.amount]),
    legend: {
      towns: '[id, название, x, y, жители, потребности]',
      industries: '[id, вид, название, x, y, уровень, предел роста]',
      stations: '[id, название, вид, x, y, города в охвате, предприятия в охвате]',
      lines: '[id, название, станции по порядку, транспорт]',
      fleet: '[id, модель, линия, состояние, груз, сколько]',
    },
  };
  const sc = game.scenario?.state;
  const scenario = sc && {
    k: 'state',
    archetype: sc.archetype,
    status: sc.status,
    reason: sc.lostReason,
    phase: 'ABC'[sc.phase],
    reputation: sc.reputation,
    objectives: sc.objectives.map((o) => ({
      id: o.id,
      role: o.role,
      phase: o.phase,
      status: o.status,
      title: o.title,
      params: o.params,
      progress: o.progress,
      target: o.target,
      created: o.created,
      deadline: o.deadline,
      fast: o.fast,
      quick: o.quick,
      closed: o.closedAt,
    })),
    effects: sc.effects,
    queue: sc.queue,
    stats: { delivered: sc.stats.delivered, to: sc.stats.to, from: sc.stats.from, pax: sc.stats.pax, between: sc.stats.between },
    score: sc.score,
  };
  return [head, world, scenario, ...game.journal.entries]
    .filter(Boolean)
    .map((x) => JSON.stringify(tidy(x)))
    .join('\n');
}

/** Что значат ключи записей — пишется в шапку файла, чтобы журнал можно было читать без кода. */
export const JOURNAL_LEGEND: Record<string, string> = {
  m: 'время: месяцев от начала партии (дробная часть — доля месяца; месяц — MONTH_LENGTH секунд, в шапке — monthSeconds)',
  game: 'новая партия: seed, карта, сценарий',
  load: 'партия открыта из сохранения',
  pace: 'старая партия пересчитана под нынешнюю длину месяца: from → to секунд; записи до неё — в месяцах по from секунд',
  speed: 'скорость игры v (0 — пауза)',
  build:
    'стройка или снос (what — что), $ — потрачено, roads/rails/stations — изменение числа полотен, путей и станций, len — длины дорог, kinds — длина новых полотен по виду: «класс полос_туда+полос_обратно [ограничение] [мост|тоннель]»',
  serves: 'станция st теперь работает с пассажирами (pax) и/или грузом (cargo), pop — жителей в охвате',
  undo: 'отмена стройки, back — вернули денег; projects — проекты стройки, которые уже шли: отменены как «✕ Отмена» (готовое осталось)',
  project:
    'режим «Со строительством»: дорога заложена проектом id (what — что), len — длина, $ — сколько стоит вся (платится по готовым метрам), sec — секунд стройки на ×1',
  'project-done': 'проект id достроен: $ — потрачено, sec — секунд от закладки',
  'project-stall': 'проект id встал: не хватает денег (money — на счёте)',
  'project-pause': 'проект id на паузе (on) или снова строится',
  'project-reserve': 'резерв проекта id: $ — отложено теперь (0 — снят), left — сколько оставалось достроить',
  'project-priority': 'проект id стал приоритетным (on) или снова обычный',
  'project-name': 'проект id переименован: name — название теперь; auto — снова автоматическое',
  'project-cancel': 'проект id отменён: недостроенное снесено, back — вернули за него денег, built — метров готовых участков осталось',
  base: 'строительная база id поставлена в pos, $ — цена (первая — бесплатно)',
  'base-': 'строительная база id (name) снесена: back — вернули денег, crews — бригад на ней было, to — база, куда они перешли (нет — распущены)',
  'base>':
    'строительная база id (name) перенесена из from в pos: $ — снос домов на новом месте (razed — сколько); shove — её отодвинула расширенная улица',
  brigade: 'бригада на базе base нанята ($ — цена) или распущена (sold), n — бригад на базе теперь',
  'brigade-send': 'игрок отправил бригаду b (база base) на проект id (what — что) и закрепил её там; from — проект, с которого она ушла',
  'brigade-auto': 'игрок снял закрепление бригады b (база base) на проекте id: дальше её распределяет автоматика',
  station: 'станция поставлена: id, kind, serves, pos, towns, inds, pop — жителей в охвате; auto — выбран автовокзал, но станция у предприятия и стала грузовой',
  'station-': 'станция снесена',
  line: 'маршрут создан: id, stops — id станций по порядку',
  route: 'маршрут изменён',
  'line-': 'маршрут удалён',
  models: 'открыта ступень транспорта tier (в сценарии — новым этапом): open — модели, что появились в продаже',
  rule: 'условие на остановке i маршрута line',
  buy: 'куплен транспорт v модели model на линию line за $; auto — купил авто-парк, а не игрок; from — номер остановки маршрута (с 0), с которой начал работу (нет — с первой)',
  sell: 'продан транспорт v, $ — выручка; auto — продал авто-парк, а не игрок',
  replace:
    'транспорт v заменён на месте моделью новее: from → model, $ — доплата (цена новой минус выручка за старую), lost — не поместилось; wait — заказана, ждёт места на дороге',
  auto: 'авто-парк линии: on, min, max',
  stop: 'транспорт v линии l на станции st (i — номер остановки): trip — секунд в пути от прошлой станции, len — длина пути по дорогам (ед. карты, 0.6 м), kmh — средняя скорость, jam — секунд простоял в пути (пробки, светофоры); drop — доставлено получателю to, store — оставлено на складе, keep — осталось в кузове, pay — выручка, x — надбавка за скорость, take — погружено сразу, off/on — пассажиры вышли/сели, wait — ждёт на станции для линии',
  go: 'транспорт v уехал со станции st: load — везёт, cap — вместимость, cargo — груз, left — ждёт на станции для линии, wait — секунд простоял',
  lost: 'транспорт потерял дорогу и вернулся на станцию',
  loan: 'кредит: take/repay — сумма, loan — долг после',
  note: 'уведомление игроку',
  month: 'итоги месяца date: деньги, кредит, статьи (ledger), lines [id, выручка, расходы, перевезено, загрузка рейсов, машин], inds [id, уровень, произведено, на складе сырья, ждёт на станциях, серия месяцев], towns [id, жители, доля закрытых потребностей, привезено], obj [id, прогресс, цель, осталось месяцев], rep — репутация',
  scenario: 'сценарий начался: регион (archetype; planned — если карта не подошла под задуманный), сложность, капитал, кредит',
  obj: 'задание сценария появилось: id, role (main/goal/contract; extra — дополнительное после победы), phase, status (offered/active), params, target, base — отметка счётчика на старте, deadline (номер месяца, к началу которого надо успеть), fast — быстрый срок (месяц с долей), est — оценка выполнимого за срок, check — почему проверка не прошла, src — событие-источник',
  skip: 'задание не выдано: проверка выполнимости не прошла (reason, est)',
  advance: 'игрок перешёл к следующему этапу досрочно, dropped — цели этапа, засчитанные невыполненными',
  accept: 'контракт принят, deadline, fast — быстрый срок',
  decline: 'контракт отклонён (expired — предложение истекло)',
  done: 'задание выполнено; quick — успели к быстрому сроку, надбавка к награде',
  fail: 'задание провалено: progress из target',
  event: 'экономическое событие: type, cause, effects, related, contract, parent (из какого события)',
  phase: 'новый этап сценария: phase, net — сеть игрока на переходе, best — лучший месяц перевозок',
  end: 'конец сценария: status, reason, score',
};
