/**
 * Карточка площадки-стоянки (Town.lots, docs/PARKING.md, этап 3) в правой панели — кликом по площадке в «Выборе».
 * Значками, подсказки — data-tip:
 * - заголовок «🅿️ 12» — мест; кнопка-значок «Показать на карте»; ниже — город и чья (🏘 города, 👤 ваша);
 * - занятость ●●●○ (доля занятых сейчас), ⤴ — ворота через перекрёсток (больше LOT.big мест);
 * - кто паркуется за месяц: 🏠 гости жилых домов и ночуют, 🛒 магазины и рынок, 🏭 работа, 🚉 станции;
 * - ⏱ среднее время стоянки, 🔄 машин за месяц, ✋ отказов (не хватило места);
 * - кнопки: ✥ перенести, ⤡ глубже (1 → 2 → 4 ряда), ↺ повернуть на 15°, ⇄ ворота (⬌ → въезд → выезд), ⛔ снести.
 */
import { money } from '../core/moneyText';
import { durationText } from '../core/timeText';
import type { Game } from '../game/game';
import type { LotStats } from '../world/entities';
import { LOT, lotIsBig, lotStallCount, lotUpkeep } from '../world/parkingLots';
import { townIcon } from './cargoIcons';
import { gateGlyph } from '../render/lotArt';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Занятость точками: из n точек закрашено по доле занятых (●●●○). */
export function occupancyDots(used: number, total: number, n = 4): string {
  const k = total ? Math.round((used / total) * n) : 0;
  return Array.from({ length: n }, (_, i) => (i < k ? '●' : '○')).join('');
}

/** Счёт месяца — этот, а в его начале (машин ещё нет) — прошлый. */
function statsOf(month: LotStats | undefined, last: LotStats | undefined): { s: LotStats | null; label: string } {
  if (month && (month.cars || month.refused || month.left)) return { s: month, label: 'в этом месяце' };
  if (last) return { s: last, label: 'в прошлом месяце' };
  return { s: month ?? null, label: 'в этом месяце' };
}

export function lotCardHtml(g: Game, id: number): string {
  const close = `<button class="icon" data-action="close-sel" data-tip="Закрыть">✕</button>`;
  const ref = g.lotById(id);
  if (!ref) return `<section class="detail project-card park-card lot-card"><header><h3>🅿️</h3>${close}</header><p class="muted">Её больше нет.</p></section>`;
  const { lot, town } = ref;
  const n = lotStallCount(lot);
  const used = g.lots.usedCount(lot);
  const head = `<header class="pc-head station-head"><button class="icon pc-show" data-action="lot-show" data-id="${lot.id}" data-tip="Показать на карте">🅿️</button>
    <h3 data-tip="${esc(`Площадка-стоянка: ${n} мест ${LOT.stall.w} × ${LOT.stall.d} ед. под прямым углом, проезд ${LOT.aisle} ед.`)}">${n}</h3>${close}</header>`;
  const own = lot.owner === 'player' ? `👤 <b>${money(lotUpkeep(lot))}</b>/мес` : '🏘';
  const ownTip = lot.owner === 'player' ? `Ваша: содержание ${money(lotUpkeep(lot))} в месяц (${Math.round(LOT.upkeep * 100)}% цены). Стоянка бесплатная` : 'Поставил город: бесплатно, без содержания';
  const gates = lot.gates.map((x) => gateGlyph(x.mode)).join(' ');
  const big = lotIsBig(lot) && lot.nodes?.length ? `<span class="pc-chip" data-tip="Больше ${LOT.big} мест: ворота примкнуты к улице перекрёстком — въезд и выезд через него, очереди и повороты как на перекрёстке">⤴</span>` : '';
  const top = `<div class="pc-chips">
    <span class="pc-chip" data-tip="${esc(`Занято ${used} из ${n} мест сейчас`)}">🚗 <b class="dots">${occupancyDots(used, n)}</b> ${used}/${n}</span>
    <span class="pc-chip" data-tip="${esc(`Ворота: ${lot.gates.length} (⬌ — в обе стороны, ⇥ — въезд, ↤ — выезд). Клик по краю у улицы — сменить или добавить`)}">🚧 ${gates}</span>${big}
    <span class="pc-chip" data-tip="${esc(ownTip)}">${own}</span></div>`;
  const { s, label } = statsOf(lot.month, lot.last);
  const who = s?.who ?? [0, 0, 0, 0];
  const whoTips = ['Ночуют рядом и гости жилых домов', 'Магазины и рынок', 'Работа: конторы, склады, школы, больницы', 'Станции (пересадка на автобус и поезд)'];
  const whoRow = ['🏠', '🛒', '🏭', '🚉']
    .map((icon, i) => `<span class="pc-chip park-item" data-tip="${esc(`${whoTips[i]} — ${label}`)}">${icon}<b>${who[i]}</b></span>`)
    .join('');
  const stay = s && s.left ? durationText(s.stay / s.left) : '—';
  const nums = `<div class="pc-chips">
    <span class="pc-chip" data-tip="${esc(`Сколько в среднем стоит машина — ${label}`)}">⏱ <b>${stay}</b></span>
    <span class="pc-chip" data-tip="${esc(`Сколько машин встало — ${label}`)}">🔄 <b>${s?.cars ?? 0}</b></span>
    <span class="pc-chip${s?.refused ? ' harm' : ''}" data-tip="${esc(`Скольким не хватило места (поехали искать дальше) — ${label}`)}">✋ <b>${s?.refused ?? 0}</b></span></div>`;
  const btn = (action: string, icon: string, tip: string) => `<button class="small icon-btn" data-action="${action}" data-id="${lot.id}" data-tip="${esc(tip)}">${icon}</button>`;
  const acts = `<div class="actions lot-acts">
    ${btn('lot-move', '✥', 'Перенести: участок за курсором, у улицы — вдоль неё (Alt — свободно, R — поворот). Esc — отмена')}
    ${btn('lot-depth', '⤡', 'Глубже или мельче: 1 → 2 → 4 ряда мест. Ширина — ручками у дальних углов на карте')}
    ${btn('lot-rot', '↺', 'Повернуть на 15° (ручка поворота на карте — так же)')}
    ${btn('lot-gate', '⇄', 'Главные ворота: ⬌ → въезд → выезд. Ещё ворота — клик по краю у улицы')}
    ${btn('lot-remove', '⛔', lot.owner === 'player' ? 'Снести: вернём половину цены' : 'Снести (поставил город)')}</div>`;
  return `<section class="detail project-card park-card lot-card">${head}
    <button class="partner" data-action="focus" data-type="town" data-id="${town.id}">${townIcon(18)}<span>${esc(town.name)}</span><small>${town.population} жит.</small></button>
    ${top}<div class="pc-chips park-items">${whoRow}</div>${nums}${acts}</section>`;
}
