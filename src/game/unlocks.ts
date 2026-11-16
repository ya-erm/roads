/**
 * Открытие моделей транспорта по объёму перевозок (docs/DESIGN.md, «Модели транспорта»). Модель II и III открывается,
 * когда её семейство с начала партии перевезло MODEL_UNLOCK единиц: автобусы — пассажиров, грузовики — груза (любым
 * кузовом: фургон и автоцистерна — одна и та же модель), грузовые поезда — груза, пассажирские — пассажиров.
 * Считается то же, что «Перевезено» у маршрута (Line.carriedMonth): довезённое получателю — груз предприятию или
 * городу, пассажиры (и рабочие) до своей остановки; перегрузка на склад станции — ещё не перевезено.
 * Открытая модель остаётся открытой навсегда — и в сохранении, даже если пороги потом поменяются.
 */
import { MODEL_UNLOCK } from '../config';
import { MODELS, type ModelId } from './transport';

/** Семейство моделей со своим счётом перевезённого. */
export type UnlockFamily = 'bus' | 'truck' | 'paxRail' | 'freightRail';

export const UNLOCK_FAMILIES: readonly UnlockFamily[] = ['bus', 'truck', 'paxRail', 'freightRail'];

/** Семейство модели: вид (дорога или рельсы) и что возит. */
export function familyOf(id: ModelId): UnlockFamily {
  const m = MODELS[id];
  if (m.mode === 'rail') return m.carries === 'passengers' ? 'paxRail' : 'freightRail';
  return m.carries === 'passengers' ? 'bus' : 'truck';
}

/** Значок единицы счёта: 👤 — пассажиры, 📦 — груз. */
export const familyIcon = (f: UnlockFamily): string => (f === 'bus' || f === 'paxRail' ? '👤' : '📦');

/** Кто и что перевёз — для подсказки: «автобусы перевезут 600 пассажиров». */
export const FAMILY_TEXT: Record<UnlockFamily, { who: string; unit: string }> = {
  bus: { who: 'автобусы', unit: 'пассажиров' },
  truck: { who: 'грузовики', unit: 'ед. груза' },
  paxRail: { who: 'пассажирские поезда', unit: 'пассажиров' },
  freightRail: { who: 'грузовые поезда', unit: 'ед. груза' },
};

/** Сколько должно перевезти семейство, чтобы модель открылась; 0 — модель первого поколения, открыта с начала. */
export const unlockNeed = (id: ModelId): number => (MODEL_UNLOCK as Partial<Record<ModelId, number>>)[id] ?? 0;

const emptyCarried = (): Record<UnlockFamily, number> => ({ bus: 0, truck: 0, paxRail: 0, freightRail: 0 });

export interface UnlocksSave {
  /** Перевезено с начала партии, по семействам. */
  carried: Partial<Record<UnlockFamily, number>>;
  /** Открытые модели II и III (по порогу, по прежним правилам у старого сохранения, тестовыми страницами). */
  open: ModelId[];
}

export interface UnlockProgress {
  family: UnlockFamily;
  have: number;
  need: number;
  /** Доля пути до порога, 0…1. */
  share: number;
}

export class ModelUnlocks {
  readonly carried: Record<UnlockFamily, number> = emptyCarried();
  readonly open = new Set<ModelId>();

  constructor(saved?: UnlocksSave) {
    if (!saved) return;
    for (const f of UNLOCK_FAMILIES) this.carried[f] = Math.max(0, saved.carried[f] ?? 0);
    for (const id of saved.open) if (id in MODELS) this.open.add(id);
  }

  isOpen(id: ModelId): boolean {
    return unlockNeed(id) === 0 || this.open.has(id);
  }

  /** Модель model довезла count единиц: в счёт её семейства; возвращает модели, которые этим открылись. */
  add(model: ModelId, count: number): ModelId[] {
    if (!(count > 0)) return [];
    this.carried[familyOf(model)] += count;
    return this.reached();
  }

  /** Модели, до порога которых счёт уже дошёл, а открыты они ещё не были: открывает их и возвращает. */
  reached(): ModelId[] {
    const fresh = (Object.keys(MODELS) as ModelId[]).filter((id) => !this.isOpen(id) && this.carried[familyOf(id)] >= unlockNeed(id));
    for (const id of fresh) this.open.add(id);
    return fresh;
  }

  /** Открывает модели сразу (старое сохранение, тестовые страницы): те из них, что были закрыты. */
  unlock(ids: ModelId[]): ModelId[] {
    const fresh = ids.filter((id) => !this.isOpen(id));
    for (const id of fresh) this.open.add(id);
    return fresh;
  }

  /** Сколько семейство модели перевезло и сколько нужно до неё. */
  progress(id: ModelId): UnlockProgress {
    const family = familyOf(id);
    const need = unlockNeed(id);
    const have = Math.floor(this.carried[family]);
    return { family, have, need, share: need > 0 ? Math.min(1, have / need) : 1 };
  }

  toSave(): UnlocksSave {
    return { carried: { ...this.carried }, open: [...this.open] };
  }
}

/** Линия старого сохранения — для восстановления счёта: её семейство, доход и перевезённое. */
export interface LegacyLine {
  id: number;
  family: UnlockFamily;
  revenueTotal: number;
  revenueLast: number;
  revenueMonth: number;
  carriedLast: number;
  carriedMonth: number;
}

/**
 * Счёт перевезённого для сохранения до счёта (SaveData.unlocks нет). Всего с начала у линии не хранилось, поэтому по
 * каждой нынешней линии — большее из двух:
 *  - точно по журналу: «Перевезено» из итогов месяцев (journalMonths — [id линии, перевезено за месяц] по месяцам;
 *    журнал мог потерять самые старые месяцы) и текущий месяц;
 *  - оценка по доходу: «Всего заработано» × перевезённое на доллар за прошлый и текущий месяц (расстояние у линии
 *    одно, грузы и надбавка за скорость почти те же).
 * Удалённые линии не восстановить — их перевезённое теряется.
 */
export function legacyCarried(lines: LegacyLine[], journalMonths: [number, number][][]): Record<UnlockFamily, number> {
  const fromJournal = new Map<number, number>();
  for (const month of journalMonths) for (const [id, n] of month) fromJournal.set(id, (fromJournal.get(id) ?? 0) + Math.max(0, n || 0));
  const out = emptyCarried();
  for (const l of lines) {
    const exact = (fromJournal.get(l.id) ?? 0) + Math.max(0, l.carriedMonth);
    const units = l.carriedLast + l.carriedMonth;
    const money = l.revenueLast + l.revenueMonth;
    const estimate = units > 0 && money > 0 ? (l.revenueTotal * units) / money : 0;
    out[l.family] += Math.round(Math.max(exact, estimate));
  }
  return out;
}
