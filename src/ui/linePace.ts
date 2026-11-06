import { leftText } from '../core/timeText';
import type { Game } from '../game/game';
import type { Line } from '../game/transport';
import { linePace, paceText } from '../scenario/forecast';
import { CARGO } from '../world/cargo';
import { cargoIcon } from './cargoIcons';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Строки карточки маршрута «Темп» — сколько он перевозит в минуту по каждому грузу (или пассажиров): значок и «12/мин».
 * Это ожидаемое по циклу, не замер: машины × вместимость ÷ круг маршрута, не больше выпуска — тем же расписанием, что
 * прогноз заданий (scenario/forecast.ts). Рейсов с грузом ещё не было — и «Первая доставка: через ~2 мин». Машин нет — пусто.
 */
export function linePaceHtml(g: Game, line: Line): string {
  const paces = linePace(g, line);
  if (!paces.length) return '';
  const items = paces
    .map((p) => {
      const tip = `${CARGO[p.cargo].name}: ~${paceText(p.perMinute)} в минуту — оценка по циклу: машины × вместимость ÷ круг маршрута, не больше выпуска`;
      return `<i class="lp" data-tip="${esc(tip)}">${cargoIcon(p.cargo, 14, false)}${paceText(p.perMinute)}/мин</i>`;
    })
    .join('');
  const firsts = paces.map((p) => p.first).filter((t): t is number => t !== null);
  const fresh = !line.carriedMonth && !line.carriedLast && firsts.length > 0;
  const first = fresh
    ? `<span data-tip="Рейсов с грузом ещё не было: когда первая машина довезёт груз получателю — по расписанию, без пробок">Первая доставка</span><b>через ~${leftText(Math.min(...firsts))}</b>`
    : '';
  return `<span data-tip="Сколько маршрут перевозит в минуту — оценка по циклу, а не замер">Темп</span><b>${items}</b>${first}`;
}
