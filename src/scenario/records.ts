/**
 * Личные рекорды сценариев — в браузере (localStorage): лучший итог для каждой карты и условий.
 * Ключ — seed, сложность, испытание и архетип, под который генерируется карта (по seed или выбранный
 * игроком): при тех же условиях получаются тот же мир и тот же сценарий. Без localStorage (тесты,
 * приватный режим, переполненное хранилище) рекордов просто нет — ошибок не бывает.
 */
import type { WorldSettings } from '../world/settings';
import { prepareSettings } from './generator';
import type { ArchetypeId, Difficulty, ScoreResult } from './types';

const KEY = 'roads.scenarioRecords';
/** Сколько рекордов хранить: самые старые вытесняются. */
const LIMIT = 300;

/** Условия, для которых ведётся рекорд. */
export interface RecordSlot {
  seed: number;
  difficulty: Difficulty;
  challenge: boolean;
  archetype: ArchetypeId;
}

export interface ScenarioRecord {
  total: number;
  medal: ScoreResult['medal'];
  won: boolean;
  /** Когда поставлен (мс с 1970 г.). */
  at: number;
}

export interface SaveResult {
  /** Лучший результат после сохранения. */
  best: ScenarioRecord;
  /** Рекорд до этой партии; нет — первая партия с такими условиями. */
  previous: ScenarioRecord | null;
  /** Эта партия поставила новый рекорд. */
  isNew: boolean;
}

/** Условия рекорда по настройкам мира; песочница — null. Архетип решается так же, как при создании игры. */
export function slotOf(settings: WorldSettings): RecordSlot | null {
  if (!settings.scenario) return null;
  const sc = prepareSettings(settings).scenario!;
  return { seed: settings.seed, difficulty: sc.difficulty, challenge: !!sc.challenge, archetype: sc.archetype ?? sc.pick ?? 'mixed' };
}

const slotKey = (s: RecordSlot) => `${s.seed}:${s.difficulty}:${s.challenge ? 'c' : 'p'}:${s.archetype}`;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(): Record<string, ScenarioRecord> {
  try {
    const raw = storage()?.getItem(KEY);
    const data: unknown = raw ? JSON.parse(raw) : null;
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, ScenarioRecord>) : {};
  } catch {
    return {};
  }
}

const valid = (r: ScenarioRecord | undefined): r is ScenarioRecord => !!r && typeof r.total === 'number' && Number.isFinite(r.total);

/** Лучший результат для этих условий; нет — null. */
export function getBest(slot: RecordSlot): ScenarioRecord | null {
  const r = readAll()[slotKey(slot)];
  return valid(r) ? r : null;
}

/** Запоминает итог партии, если он лучше прежнего рекорда. Повторный вызов с тем же итогом ничего не меняет. */
export function saveBest(slot: RecordSlot, score: ScoreResult, now = Date.now()): SaveResult {
  const all = readAll();
  const key = slotKey(slot);
  const previous = valid(all[key]) ? all[key] : null;
  const isNew = !previous || score.total > previous.total;
  if (!isNew) return { best: previous, previous, isNew };
  const best: ScenarioRecord = { total: score.total, medal: score.medal, won: score.won, at: now };
  all[key] = best;
  const keys = Object.keys(all);
  if (keys.length > LIMIT) {
    const old = keys.sort((a, b) => (all[a]?.at ?? 0) - (all[b]?.at ?? 0)).slice(0, keys.length - LIMIT);
    for (const k of old) delete all[k];
  }
  try {
    storage()?.setItem(KEY, JSON.stringify(all));
  } catch {
    // Места нет — рекорд останется только на экране.
  }
  return { best, previous, isNew };
}
