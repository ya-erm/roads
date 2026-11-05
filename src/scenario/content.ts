/**
 * Содержимое сценариев — данные без логики: архетипы регионов с профилями генерации карты, сложность,
 * баланс заданий, частота событий и тексты. Генератор и системы заданий и событий только читают их.
 */
import type { IndustryDensity, WorldProfile } from '../world/settings';
import type { ArchetypeId, Difficulty, EventType, ObjectiveRole } from './types';

export interface Archetype {
  id: ArchetypeId;
  name: string;
  /** Одной фразой — для экрана новой игры и брифинга. */
  pitch: string;
  /** Вероятность выпасть по seed. */
  weight: number;
  /** Сколько городов от обычного числа для размера карты. */
  towns: number;
  industries: IndustryDensity;
  profile: WorldProfile;
  /** Множитель стартового капитала. */
  capital: number;
  /** Стартовый кредит — доля капитала. */
  loan: number;
  /** Чего больше в целях: груз или пассажиры (0 — только груз, 1 — только пассажиры). */
  pax: number;
  /** Множители частоты событий по типам. */
  events: Partial<Record<EventType, number>>;
}

export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  industrial: {
    id: 'industrial',
    name: 'Промышленный регион',
    pitch: 'Много заводов и длинные цепочки. Важны снабжение производства и своевременные поставки.',
    weight: 1,
    towns: 0.8,
    industries: 'many',
    profile: { big: 0.2, mid: 0.3, gap: 900, cluster: 0, raw: 0.85, plants: 1.1, affinity: 0.7, hub: 0 },
    capital: 1.1,
    loan: 0,
    pax: 0.2,
    events: { shortage: 1.6, expansion: 1.3, decline: 1.2, order: 1.4, grant: 0.5 },
  },
  agglomeration: {
    id: 'agglomeration',
    name: 'Быстрорастущая агломерация',
    pitch: 'Несколько крупных городов рядом друг с другом. Пассажиропотоки, пригородное сообщение и пробки.',
    weight: 1,
    towns: 0.7,
    industries: 'few',
    profile: { big: 0.45, mid: 0.4, gap: 650, cluster: 0.75, raw: 0.8, plants: 1, affinity: 0.3, hub: 0 },
    capital: 1,
    loan: 0,
    pax: 0.75,
    events: { boom: 1.8, grant: 0.8, demand: 1.3, shortage: 0.7 },
  },
  scattered: {
    id: 'scattered',
    name: 'Разрозненные поселения',
    pitch: 'Много маленьких городов далеко друг от друга. Капитала мало — сеть должна быть экономной.',
    weight: 1,
    towns: 1.3,
    industries: 'normal',
    profile: { big: 0.05, mid: 0.25, gap: 1150, cluster: 0, raw: 1, plants: 1, affinity: 0.4, hub: 0 },
    capital: 0.8,
    loan: 0.3,
    pax: 0.5,
    events: { grant: 2.2, boom: 1.2, order: 0.8 },
  },
  logistics: {
    id: 'logistics',
    name: 'Логистический узел',
    pitch: 'Предприятия собрались вокруг одного города и зависят от разных грузов. Нужна сеть снабжения и распределения.',
    weight: 0.8,
    towns: 0.9,
    industries: 'normal',
    profile: { big: 0.15, mid: 0.4, gap: 900, cluster: 0.2, raw: 1, plants: 1.2, affinity: 0.3, hub: 0.65 },
    capital: 1,
    loan: 0,
    pax: 0.3,
    events: { order: 1.6, shortage: 1.3, demand: 1.2 },
  },
  mixed: {
    id: 'mixed',
    name: 'Смешанная экономика',
    pitch: 'И города, и несколько производственных цепочек. Придётся выбирать, что развивать первым.',
    weight: 1.2,
    towns: 1,
    industries: 'normal',
    profile: { big: 0.2, mid: 0.4, gap: 900, cluster: 0.1, raw: 1, plants: 1, affinity: 0.4, hub: 0 },
    capital: 1,
    loan: 0,
    pax: 0.45,
    events: {},
  },
};

export const ARCHETYPE_LIST = Object.values(ARCHETYPES);

export interface DifficultyInfo {
  name: string;
  /** Капитал от стоимости первой цели. */
  capital: number;
  /** Предел кредита. */
  loanMax: number;
  /** Требования заданий от оценки выполнимого. */
  demand: number;
  /** Сроки: множитель месяцев. */
  time: number;
  /** Частота событий. */
  events: number;
  maxActive: number;
  /** Главные цели этапов критические сразу (на других — только восстановительные). */
  critical: boolean;
  /** Множитель итоговой оценки. */
  score: number;
}

export const DIFFICULTY: Record<Difficulty, DifficultyInfo> = {
  easy: { name: 'Лёгкий', capital: 2.6, loanMax: 1_000_000, demand: 0.5, time: 1.3, events: 0.75, maxActive: 2, critical: false, score: 0.8 },
  normal: { name: 'Обычный', capital: 1.8, loanMax: 500_000, demand: 0.65, time: 1, events: 1, maxActive: 3, critical: false, score: 1 },
  hard: { name: 'Сложный', capital: 1.3, loanMax: 250_000, demand: 0.8, time: 0.85, events: 1.25, maxActive: 4, critical: true, score: 1.25 },
};

/** Испытание (без паузы) прибавляет к оценке. */
export const CHALLENGE_BONUS = 1.15;

/** Этапы: сроки в месяцах (месяц — MONTH_LENGTH секунд). */
export const PHASES = [
  { name: 'Основание компании', short: 'Основание', months: 5, hint: 'Денег мало: соедините самое выгодное дёшево.' },
  { name: 'Экспансия', short: 'Экспансия', months: 7, hint: 'Возможностей больше, чем времени. Выберите, что успеть.' },
  { name: 'Освоение региона', short: 'Освоение', months: 8, hint: 'Сеть работает и без вас — пора дальше: новые города и предприятия ждут транспорта.' },
];

/** Очки за задание по роли. */
export const POINTS: Record<ObjectiveRole, number> = { main: 120, goal: 60, contract: 40, extra: 0 };

/**
 * Быстрый срок: успели к нему — надбавка к награде (доля денег задания) и очки в оценке за каждое такое задание
 * (сверх обычных — доп. очки, медали считаются по прежним порогам; не больше maxPoints).
 */
export const FAST = { money: 0.25, points: 20, maxPoints: 80 };

/** Репутация: старт, изменения и влияние на награды контрактов. */
export const REPUTATION = { start: 50, done: 6, main: 10, failed: -10, declined: -3, rewardMin: 0.8, rewardMax: 1.25 };

/** Частота событий: пределы и паузы. */
export const EVENT_RULES = {
  /** Пауза между крупными событиями, месяцев. */
  majorGap: 1,
  /** Пауза между мелкими событиями. */
  minorGap: 1,
  /** Шанс нового события в месяц по этапам. Новых событий — не больше одного в месяц. */
  chance: [0.5, 0.7, 0.75],
  /** Не больше стольких открытых контрактов (предложенных и принятых) — иначе новых не предлагают. */
  contracts: 3,
  /** Через сколько месяцев то же событие может повториться с тем же городом или предприятием. */
  memory: 5,
  /** Сколько месяцев действует предложение контракта. */
  offer: 2,
  /** Первые месяцы сценария без случайных событий: игрок осваивается. */
  quiet: 2,
};

export const EVENT_INFO: Record<EventType, { name: string; importance: 'minor' | 'major'; icon: string; phases: number[] }> = {
  shortage: { name: 'Дефицит сырья', importance: 'major', icon: '📉', phases: [0, 1, 2] },
  expansion: { name: 'Рост промышленности', importance: 'major', icon: '🏭', phases: [0, 1, 2] },
  decline: { name: 'Промышленный спад', importance: 'major', icon: '⚠️', phases: [1, 2] },
  boom: { name: 'Развитие города', importance: 'minor', icon: '🏙️', phases: [0, 1, 2] },
  grant: { name: 'Субсидия на инфраструктуру', importance: 'major', icon: '🏛️', phases: [1, 2] },
  order: { name: 'Крупный заказ', importance: 'minor', icon: '📦', phases: [0, 1, 2] },
  demand: { name: 'Изменение спроса', importance: 'minor', icon: '💹', phases: [1, 2] },
};

/** Медали: от скольких очков. */
export const MEDALS = { gold: 800, silver: 620, bronze: 420 };

/** Сколько городов на карте каждого размера в сценарии — до множителя архетипа. */
export const BASE_TOWNS = { small: 7, medium: 10, large: 13 } as const;
