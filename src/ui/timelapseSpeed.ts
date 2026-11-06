/**
 * Скорость проигрывания таймлапса: кнопки 1×/2×/3× и сколько месяцев партии проходит за секунду.
 * Отдельно от проигрывателя (timelapse.ts — холст и разметка), чтобы проверять тестом.
 */

/** Кнопки скорости — по порядку, подпись «1×», «2×», «3×». */
export const TL_SPEEDS: readonly number[] = [1, 2, 3];
/** Месяцев партии в секунду на 1× — но вся партия на 1× не короче TL_MIN_SECONDS. */
export const TL_MONTHS_PER_SECOND = 2;
export const TL_MIN_SECONDS = 12;
/** Самый медленный ход на 1× (партия в доли месяца не тянется бесконечно), месяцев в секунду. */
const TL_MIN_RATE = 0.025;

/** Месяцев шкалы в секунду: span — длина шкалы в месяцах, speed — выбранная кнопка (1, 2, 3). */
export function playRate(span: number, speed: number): number {
  return speed * Math.min(TL_MONTHS_PER_SECOND, Math.max(TL_MIN_RATE, span / TL_MIN_SECONDS));
}
