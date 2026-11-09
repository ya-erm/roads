/** Подписи у курсора при стройке: цена и что не так. */
import { durationText } from '../core/timeText';

/** Причина отказа, когда стройка дороже денег на счету. */
export const NO_MONEY = 'Не хватает денег';

/** Деньги в подсказке: «$12 345». */
export function money(n: number): string {
  return `$${Math.round(n).toLocaleString('ru-RU')}`;
}

/**
 * Цена стройки дороги у курсора. «Со строительством» новая дорога — проект: «🏗 $8 400 · ⏳ 25 с» — сколько
 * стоит вся (платится по готовым метрам) и сколько строить на ×1; сразу платится только cost (снос домов и т. п.).
 */
export function planPrice(plan: { cost: number; project?: { cost: number; seconds: number } }): string {
  const p = plan.project;
  if (!p) return money(plan.cost);
  return `🏗 ${money(p.cost + Math.max(0, plan.cost))} · ⏳ ${durationText(p.seconds)}`;
}

/**
 * Перестройка готовой дороги у курсора («Со строительством», src/game/rebuild.ts): «🚧 $3 200 · ⏳ 40 с · ◐» — цена
 * работ (по готовым метрам), сколько строить на ×1 и перекрытие на время работ: ◐ — по полосам (часть открыта),
 * ⛔ — целиком (дорогу переносят). Правка — не перестройка (только новые дороги) — как planPrice; не проект — null.
 */
export function rebuildPrice(plan: { cost: number; project?: { cost: number; seconds: number; rebuild?: { moved: boolean } } }): string | null {
  const p = plan.project;
  if (!p) return null;
  if (!p.rebuild) return planPrice(plan);
  return `🚧 ${money(p.cost + Math.max(0, plan.cost))} · ⏳ ${durationText(p.seconds)} · ${p.rebuild.moved ? '⛔' : '◐'}`;
}

/**
 * Сдвиг оси готовой дороги у курсора: «↔ 5 м ⚡» — не дальше порога limit (сразу, без стройки), «↔ 12 м 🚧» — дальше
 * (перенос стройкой). Меньше полуметра — не сдвиг (null).
 */
export function shiftLabel(shift: number | undefined, limit: number): string | null {
  if (shift === undefined || shift < 0.5) return null;
  return `↔ ${Math.round(shift)} м ${shift > limit ? '🚧' : '⚡'}`;
}

/**
 * «Со строительством» проект дороже свободных денег (budget — до кредитного предела, без резерва): его всё равно можно
 * заложить — платится он по готовым метрам, без денег стоит. Предупреждение к цене — «💸 свободно $20 000 — стройка
 * пойдёт по мере денег» (жёлтым, а не отказом); денег хватает или это не проект — null.
 */
export function projectMoneyWarning(plan: { cost: number; project?: { cost: number } }, budget: number): string | null {
  const p = plan.project;
  if (!p || p.cost + Math.max(0, plan.cost) <= budget) return null;
  return `💸 свободно ${money(Math.max(0, budget))} — стройка пойдёт по мере денег`;
}

/** Метры со знаком, округлённые: «+14 м», «−4 м» (минус — типографский), «±0 м». */
export function signedMetres(v: number): string {
  const r = Math.round(v) || 0;
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r)} м`;
}

/**
 * Приписка к высоте у курсора: на сколько клавишами −/+ подняли или опустили конец дороги относительно
 * начала — «+14 м», «−4 м»; высоту не задавали (null) — приписки нет.
 */
export function riseLabel(rise: number | null | undefined): string | null {
  return rise === null || rise === undefined ? null : signedMetres(rise);
}

/** Высота над уровнем воды, как в подписи «высота 25 м»: «25 м», ниже воды — «−12 м». */
function altitude(m: number): string {
  const r = Math.round(m) || 0;
  return `${r < 0 ? `−${-r}` : r} м`;
}

/** Что под курсором не на земле: мост, эстакада (мост выше моста) или тоннель. */
export type StructureKind = 'bridge' | 'flyover' | 'tunnel';

const STRUCTURE_NAME: Record<StructureKind, string> = { bridge: 'моста', flyover: 'эстакады', tunnel: 'тоннеля' };

/**
 * Высота у курсора над мостом, эстакадой или тоннелем: и полотна, и земли над или под ним — обе над уровнем воды,
 * как в «высота 25 м» (не «+N м»: так подписан подъём конца дороги клавишами −/+): «высота моста 67 м · земля 55 м»,
 * «высота тоннеля 16 м · земля 41 м» (под землёй на 25 м).
 */
export function structureHeightText(deck: number, ground: number, kind: StructureKind = 'bridge'): string {
  return `высота ${STRUCTURE_NAME[kind]} ${altitude(deck)} · земля ${altitude(ground)}`;
}

/** Подпись отказа: причина, а если не хватает денег — ещё и полная цена стройки. */
export function failText(reason: string | undefined, cost: number | undefined, fallback = 'Нельзя'): string {
  if (reason === NO_MONEY && cost !== undefined && cost > 0) return `${NO_MONEY} · ${money(cost)}`;
  return reason || fallback;
}

/** Стрелка направления на экране (ось y — вниз): одна из восьми, ближайшая к dir. */
export function dirArrow(dir: { x: number; y: number }): string {
  const k = Math.round(Math.atan2(dir.y, dir.x) / (Math.PI / 4));
  return ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'][((k % 8) + 8) % 8];
}

/** Подпись новой полосы у края: куда по ней поедут, встречная ли и как развернуть. */
export function laneFlowText(dir: { x: number; y: number }, reversed: boolean): string {
  return `${dirArrow(dir)}${reversed ? ' встречная' : ''} · Alt — развернуть`;
}
