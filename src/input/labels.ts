/** Подписи у курсора при стройке: цена и что не так. */

/** Причина отказа, когда стройка дороже денег на счету. */
export const NO_MONEY = 'Не хватает денег';

/** Деньги в подсказке: «$12 345». */
export function money(n: number): string {
  return `$${Math.round(n).toLocaleString('ru-RU')}`;
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
