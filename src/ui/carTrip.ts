/**
 * Куда едет машина жителя или спецмашина — блок в её карточке (правая панель), значками:
 * - «🏠 Липки → 🏢 Сосновка»: откуда и куда (вид здания — значком: 🏠 дом, 🏢 работа или магазин, 🏛 ратуша), город —
 *   кнопкой к нему и его карточке; спецмашина — «🚑 Липки: 🏠 → 🏢» (вызов в своём городе);
 * - «📏 1,2 км · ⏳ ≈ 40 с»: сколько ещё по маршруту и примерно сколько ехать (Game.vehicleAhead).
 * Маршрут до цели и сама цель подсвечены на карте (renderer, drawVehicleTrip). Подсказки — data-tip.
 */
import { durationText } from '../core/timeText';
import type { Game } from '../game/game';
import { SERVICES } from '../game/services';
import { PARK_SEARCH } from '../game/parkSearch';
import type { TownBuilding } from '../world/entities';
import { km } from './constructionUi';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Вид здания поездки: значок и словами (для подсказки). */
const KIND: Record<TownBuilding['kind'], { icon: string; text: string }> = {
  res: { icon: '🏠', text: 'жилой дом' },
  com: { icon: '🏢', text: 'работа или магазин' },
  landmark: { icon: '🏛', text: 'ратуша' },
};

/** Откуда и куда едет машина simId и сколько ещё; не знаем ни того, ни другого — пусто. */
export function carTripHtml(game: Game, simId: number): string {
  const trip = game.tripOf(simId);
  const ahead = game.vehicleAhead(simId);
  const service = game.serviceOfSim(simId);
  const town = (b: TownBuilding) => {
    const t = game.towns.find((x) => x.id === b.townId);
    return t
      ? `<button class="ct-town" data-action="focus" data-type="town" data-id="${t.id}" data-tip="${esc(`Город «${t.name}» — показать и открыть`)}">${esc(t.name)}</button>`
      : '';
  };
  const kind = (b: TownBuilding, role: string) => `<span class="ct-kind" data-tip="${esc(`${role}: ${KIND[b.kind].text}`)}">${KIND[b.kind].icon}</span>`;
  const arrow = `<span class="ct-arrow">→</span>`;
  let row = '';
  if (trip && service) {
    // Вызов спецмашины — в своём городе: город один раз, дальше — откуда и куда.
    const same = trip.from.townId === trip.to.townId;
    // Скорая больницы (game/serviceDepots.ts): с места на её стоянке к дому вызова и обратно.
    const tip =
      trip.from.form === 'hospital'
        ? `${SERVICES[service].name}: из больницы на вызов`
        : trip.to.form === 'hospital'
          ? `${SERVICES[service].name}: с вызова на своё место у больницы`
          : `Вызов: ${SERVICES[service].name.toLowerCase()} едет из здания в здание`;
    row = `<span class="ct-kind" data-tip="${esc(tip)}">${SERVICES[service].icon}</span>${town(trip.from)}${
      same ? `${kind(trip.from, 'Откуда')}${arrow}${kind(trip.to, 'Куда')}` : `${kind(trip.from, 'Откуда')}${arrow}${kind(trip.to, 'Куда')}${town(trip.to)}`
    }`;
  } else if (trip) row = `${kind(trip.from, 'Откуда')}${town(trip.from)}${arrow}${kind(trip.to, 'Куда')}${town(trip.to)}`;
  const left = ahead
    ? `<div class="ct-chips"><span class="ct-chip" data-tip="Сколько ещё ехать по маршруту до цели">📏 <b>${km(ahead.left)}</b></span><span class="ct-chip" data-tip="Примерно сколько ещё ехать на скорости ×1 — по разрешённой скорости дорог (пробки и светофоры задержат)">⏳ ≈ <b>${durationText(ahead.eta)}</b></span></div>`
    : '';
  // Не нашла места у цели с первого раза — кружит: «ищет место ●●○» (сколько попыток из PARK_SEARCH.tries).
  const search = game.parkSearch.of(simId);
  const hunt = search ? `<div class="ct-chips">${parkSearchChip(search.tries)}</div>` : '';
  return row || left || hunt ? `<div class="car-trip">${row ? `<div class="ct-row">${row}</div>` : ''}${left}${hunt}</div>` : '';
}

/** «🅿️ ищет место ●●○»: попытки найти место у цели — сделанные закрашены, из PARK_SEARCH.tries. */
export function parkSearchChip(tries: number): string {
  const dots = Array.from({ length: PARK_SEARCH.tries }, (_, i) => (i < tries ? '●' : '○')).join('');
  return `<span class="ct-chip ct-hunt" data-tip="${esc(`Не нашла места у цели и ищет другое рядом: попытка ${Math.min(tries, PARK_SEARCH.tries)} из ${PARK_SEARCH.tries}. Не найдёт — уедет домой (отказ на слое 🅿️)`)}">🅿️ ищет место <b>${dots}</b></span>`;
}
