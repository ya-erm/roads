import type { CargoType } from '../world/cargo';
import type { WorldProfile } from '../world/settings';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type ArchetypeId = 'industrial' | 'agglomeration' | 'scattered' | 'logistics' | 'mixed';

/** Сценарий в настройках мира: что выбрал игрок и под какой архетип уже сгенерирована карта. */
export interface ScenarioSettings {
  difficulty: Difficulty;
  /** Испытание: время не останавливается. */
  challenge: boolean;
  /** Архетип по выбору игрока; нет — по seed. */
  pick?: ArchetypeId;
  /** Архетип, под который сгенерирована карта (решается до генерации, по seed). */
  archetype?: ArchetypeId;
  profile?: WorldProfile;
}

/** Город или предприятие, к которому относится задание или событие. */
export interface Ref {
  type: 'industry' | 'town';
  id: number;
}

export type ObjectiveKind = 'deliver' | 'passengers' | 'profit' | 'supply' | 'industry' | 'population' | 'quality' | 'throughput' | 'newRoutes' | 'connect';

/** Условия выполнения по типам — всё проверяется по реальному состоянию симуляции. */
export type ObjectiveParams =
  /** Доставить груз: конкретному получателю или куда угодно (to = null); from — только продукцию этого предприятия. */
  | { kind: 'deliver'; cargo: CargoType; amount: number; to: Ref | null; from?: number }
  /** Перевезти пассажиров: между двумя городами (в любую сторону) или всего. */
  | { kind: 'passengers'; amount: number; towns: [number, number] | null }
  /** Операционная прибыль не меньше amount в месяц, months месяцев подряд. */
  | { kind: 'profit'; amount: number; months: number }
  /**
   * Потребности города закрыты months месяцев подряд: не меньше needs из всех (нет needs — все; так в старых
   * сохранениях). Закрыта — за месяц привезли не меньше нормы города (townNeed: растёт с населением).
   */
  | { kind: 'supply'; town: number; months: number; needs?: number }
  /** Довести производство предприятия до уровня. */
  | { kind: 'industry'; industry: number; level: number }
  /** Население города не меньше amount. */
  | { kind: 'population'; town: number; amount: number }
  /** Средняя надбавка за скорость доставки не ниже speed при объёме от volume в месяц, months месяцев подряд. */
  | { kind: 'quality'; speed: number; volume: number; months: number }
  /** Перевозить не меньше amount в месяц при расходах не больше costRatio от выручки, months месяцев подряд. */
  | { kind: 'throughput'; amount: number; costRatio: number; months: number }
  /**
   * Маршруты, построенные с момента since (месяцы игры с долей — начало этапа), перевозят не меньше amount в месяц,
   * months месяцев подряд: старая сеть, что растёт сама, не в счёт.
   */
  | { kind: 'newRoutes'; amount: number; since: number; months: number }
  /** Подключить к сети amount новых городов или предприятий: known — те, что были в сети, когда задание появилось. */
  | { kind: 'connect'; what: 'town' | 'industry'; amount: number; known: number[] };

/**
 * Главная цель этапа, обычная цель этапа, необязательный контракт или дополнительное задание после победы
 * (без срока, только деньги — на оценку не влияет).
 */
export type ObjectiveRole = 'main' | 'goal' | 'contract' | 'extra';
export type ObjectiveStatus = 'offered' | 'active' | 'done' | 'failed' | 'declined';

export type EffectKind = 'industry' | 'growth' | 'pax' | 'price';

/** Временный множитель экономики: производство предприятия, рост города, поток пассажиров города, цена груза. */
export interface EffectSpec {
  kind: EffectKind;
  /** id предприятия или города; для цены — груз. */
  target: number | CargoType;
  factor: number;
  months: number;
}

export interface Effect extends EffectSpec {
  id: string;
  /** До какого месяца (номер месяца игры) действует. */
  until: number;
  /** Событие или задание, которое его вызвало. */
  source: string;
}

export type EventType = 'shortage' | 'expansion' | 'decline' | 'boom' | 'grant' | 'order' | 'demand';

/** Отложенное событие цепочки: через delay месяцев, если условия ещё выполняются. */
export interface FollowUp {
  event: EventType;
  subject: Ref | null;
  delay: number;
  /** Груз для событий спроса. */
  cargo?: CargoType;
}

export interface Reward {
  money?: number;
  reputation?: number;
  effects?: EffectSpec[];
  /** Повысить предел и уровень производства предприятия (рост мощности). */
  level?: { industry: number; by: number };
  /** Снять эффекты события-источника (восстановление). */
  clear?: string;
  follow?: FollowUp[];
}

export type Consequence = Reward;

export interface Objective {
  id: string;
  params: ObjectiveParams;
  role: ObjectiveRole;
  /** Этап (0 — A, 1 — B, 2 — C); у контрактов событий — null. */
  phase: number | null;
  title: string;
  /** Почему задание появилось — для контрактов это причина события. */
  why: string;
  /** Провал заканчивает сценарий — видно игроку заранее. */
  critical: boolean;
  status: ObjectiveStatus;
  /** Номер месяца игры, когда задание появилось. */
  created: number;
  /** Когда задание начали выполнять (контракт — когда приняли). */
  started?: number;
  /** Номер месяца, к началу которого задание должно быть выполнено; null — без срока. */
  deadline: number | null;
  /**
   * Быстрый срок (необязательный): выполнено до начала этого месяца — надбавка к награде и очки за быстроту.
   * Только у заданий, где время честно прикидывается по дороге (fastMonths).
   */
  fast?: number;
  /** Выполнено быстрее быстрого срока. */
  quick?: boolean;
  /** Предложение контракта действует до начала этого месяца. */
  offerUntil?: number;
  /** Сколько месяцев на выполнение после принятия контракта. */
  months?: number;
  /** Быстрый срок контракта: месяцев после принятия. */
  fastMonths?: number;
  /** Отметка счётчика на старте: прогресс накопительных заданий — от неё. */
  base: number;
  progress: number;
  target: number;
  /** Месяцев подряд условие выполнено (для заданий «держать N месяцев»). */
  streak: number;
  reward: Reward;
  fail: Consequence;
  /** Выполнить раньше этих заданий. */
  requires?: string[];
  related: Ref[];
  /** Событие, предложившее контракт. */
  source?: string;
  /** Очки в итоговой оценке. */
  points: number;
  closedAt?: number;
  /** Провал заменён восстановительным заданием (id). */
  retry?: string;
  /** Это восстановительное задание взамен проваленного. */
  retryOf?: string;
  /**
   * Свёрнуто ли задание в панели сценария — выбор игрока, сохраняется с партией. Не задано — как принято:
   * выполненные свёрнуты, остальные развёрнуты (см. `isFolded` в ui/scenarioUi.ts).
   */
  folded?: boolean;
}

export interface EventRecord {
  id: string;
  type: EventType;
  month: number;
  importance: 'minor' | 'major';
  title: string;
  /** Почему это случилось — по состоянию мира. */
  cause: string;
  /** Что изменилось. */
  effects: string[];
  related: Ref[];
  /** До какого месяца событие считается активным (для ограничения числа активных). */
  until: number;
  /** Контракт, который предложило событие. */
  contract?: string;
  /** Событие, из которого выросло это (цепочка). */
  parent?: string;
  /** Ключ памяти против повторов: тип и предмет (`boom:town:3`, `demand:food`). */
  key?: string;
}

/** Итоги закрытого месяца по сценарию. */
export interface MonthStat {
  month: number;
  /** Перевезено (груз + пассажиры). */
  units: number;
  /** Из них пассажиров (в старых записях нет). */
  pax?: number;
  /** Средняя надбавка за скорость (по объёму); нет доставок — 1. */
  speed: number;
  /** Выручка от перевозок. */
  income: number;
  /** Содержание транспорта, ремонт дорог и проценты. */
  costs: number;
}

export interface ScenarioStats {
  /** Доставлено всего по грузам. */
  delivered: Partial<Record<CargoType, number>>;
  /** Доставлено получателю: `industry:12:grain` или `town:3:food`. */
  to: Record<string, number>;
  /** Доставлено продукции предприятия (куда угодно): `12:grain`. */
  from?: Record<string, number>;
  pax: number;
  /** Пассажиры между городами: `3-7` (меньший id первым). */
  between: Record<string, number>;
  /** Текущий месяц: объём, пассажиры и сумма «объём × надбавка». */
  units: number;
  paxUnits?: number;
  speedSum: number;
  months: MonthStat[];
}

/** Наблюдение за предприятием — для причин событий. */
export interface IndustryWatch {
  /** Месяцев подряд сырья почти нет. */
  low: number;
  /** Месяцев подряд ничего не произвело. */
  idle: number;
  /** Хоть раз работало при сценарии. */
  active: boolean;
}

export interface ScoreLine {
  id: 'objectives' | 'contracts' | 'deadlines' | 'fast' | 'finance' | 'quality' | 'region';
  name: string;
  value: number;
  max: number;
  note: string;
}

export interface ScoreResult {
  total: number;
  medal: 'gold' | 'silver' | 'bronze' | null;
  parts: ScoreLine[];
  /** Множитель за сложность и испытание. */
  multiplier: number;
  won: boolean;
}

export interface LogEntry {
  month: number;
  kind: 'phase' | 'done' | 'failed' | 'event' | 'offer' | 'declined';
  text: string;
}

/** Стартовые условия — для брифинга. */
export interface Brief {
  region: string;
  text: string;
  capital: number;
  loan: number;
  loanMax: number;
  /** Ожидаемая продолжительность, месяцев (с запасом на стройку build). */
  months: number;
  /** «Со строительством»: запас на стройку дорог, месяцев — прибавлен к сроку этапа A (прежний срок — быстрый). */
  build?: number;
  facts: string[];
}

export interface ScenarioState {
  version: 1;
  settings: ScenarioSettings;
  archetype: ArchetypeId;
  brief: Brief;
  status: 'running' | 'won' | 'lost';
  lostReason?: string;
  /** Итоговый экран уже показан. */
  seen?: boolean;
  phase: number;
  phaseStart: number;
  startMonth: number;
  /** Состояние своего генератора случайных чисел. */
  rng: number;
  nextId: number;
  objectives: Objective[];
  events: EventRecord[];
  effects: Effect[];
  /** Продолжения цепочек: когда (номер месяца), из какого события, сколько раз уже откладывали. */
  queue: (FollowUp & { at: number; parent: string; tries?: number })[];
  /** Когда было событие такого типа с этим предметом: `boom:town:3` → месяц. */
  memory: Record<string, number>;
  lastMajor: number;
  lastMinor: number;
  stats: ScenarioStats;
  watch: Record<number, IndustryWatch>;
  /** Регион на старте — для оценки развития. */
  start: { population: number; levels: number };
  reputation: number;
  /** Месяцев подряд компания за пределом кредита. */
  bankrupt: number;
  score?: ScoreResult;
  log: LogEntry[];
  /** Дополнительные задания после победы уже выданы (в старых сохранениях пройденного сценария — нет). */
  extras?: boolean;
}
