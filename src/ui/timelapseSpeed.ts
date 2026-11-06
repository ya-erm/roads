/**
 * Скорость проигрывания таймлапса: кнопки 1×/2×/3× и сколько месяцев партии проходит за секунду.
 * Отдельно от проигрывателя (timelapse.ts — холст и разметка), чтобы проверять тестом.
 */

import { TERM_SCALE } from '../config';

/** Кнопки скорости — по порядку, подпись «1×», «2×», «3×». */
export const TL_SPEEDS: readonly number[] = [1, 2, 3];
/**
 * Месяцев партии в секунду на 1× — но вся партия на 1× не короче TL_MIN_SECONDS. 4 минуты игры в секунду
 * (2 месяца по 2 минуты): месяц стал короче, а партия проигрывается с той же скоростью, что и раньше.
 */
export const TL_MONTHS_PER_SECOND = 2 * TERM_SCALE;
export const TL_MIN_SECONDS = 12;
/** Самый медленный ход на 1× (партия в доли месяца не тянется бесконечно), месяцев в секунду: 3 с игры в секунду. */
const TL_MIN_RATE = 0.025 * TERM_SCALE;

/** Месяцев шкалы в секунду: span — длина шкалы в месяцах, speed — выбранная кнопка (1, 2, 3). */
export function playRate(span: number, speed: number): number {
  return speed * Math.min(TL_MONTHS_PER_SECOND, Math.max(TL_MIN_RATE, span / TL_MIN_SECONDS));
}
