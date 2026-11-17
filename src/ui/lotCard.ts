/**
 * Карточка площадки-стоянки (Town.lots, docs/PARKING.md, этап 3) в правой панели — кликом по площадке в «Выборе».
 * Подсказки — data-tip; маршрутов под карточкой нет (Hud.linesListHtml):
 * - заголовок «Стоянка», кнопка-значок 🅿️ «Показать на карте»; ниже — город;
 * - список строк «значок — подпись — значение»: 🅿️ мест, 🚗 занято сейчас (●●●○ и число), 🚧 ворота,
 *   ⤴ въезд через перекрёсток (больше LOT.big мест), чья (🏘 города, 👤 ваша — с содержанием);
 * - за месяц (этот, а в его начале — прошлый): 🔄 машин встало, из них 🏠 жильё и гости, 🛒 магазины и рынок,
 *   🏭 работа, 🚉 станции; ⏱ сколько в среднем стоят, ✋ отказов (не хватило места);
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

/** Строка карточки: значок — подпись — значение (value — готовый HTML), подсказка — data-tip. */
export interface LotRow {
  icon: string;
  label: string;
  value: string;
  tip: string;
  /** Плохо (есть отказы) — значение красным. */
  harm?: boolean;
  /** Часть строки выше (кто встал) — с отступом. */
  sub?: boolean;
}

/** Список строк «значок — подпись — значение». */
export function lotRowsHtml(rows: LotRow[]): string {
  const li = (r: LotRow) =>
    `<li class="${['lot-row', r.sub ? 'sub' : '', r.harm ? 'harm' : ''].filter(Boolean).join(' ')}" data-tip="${esc(r.tip)}"><i>${r.icon}</i><span>${esc(r.label)}</span><b>${r.value}</b></li>`;
  return `<ul class="lot-rows">${rows.map(li).join('')}</ul>`;
}

export function lotCardHtml(g: Game, id: number): string {
  const close = `<button class="icon" data-action="close-sel" data-tip="Закрыть">✕</button>`;
  const ref = g.lotById(id);
  if (!ref) return `<section class="detail project-card park-card lot-card"><header><h3>Стоянка</h3>${close}</header><p class="muted">Её больше нет.</p></section>`;
  const { lot, town } = ref;
  const n = lotStallCount(lot);
  const used = g.lots.usedCount(lot);
  const head = `<header class="pc-head station-head"><button class="icon pc-show" data-action="lot-show" data-id="${lot.id}" data-tip="Показать на карте">🅿️</button>
    <h3>Стоянка</h3>${close}</header>`;
  const now: LotRow[] = [
    { icon: '🅿️', label: 'Мест', value: String(n), tip: `${n} мест ${LOT.stall.w} × ${LOT.stall.d} ед. под прямым углом, проезд ${LOT.aisle} ед.` },
    { icon: '🚗', label: 'Занято', value: `<em class="dots">${occupancyDots(used, n)}</em> ${used} из ${n}`, tip: `Занято ${used} из ${n} мест сейчас` },
    {
      icon: '🚧',
      label: 'Ворота',
      value: `<em class="gates">${esc(lot.gates.map((x) => gateGlyph(x.mode)).join(' '))}</em>`,
      tip: `Ворота: ${lot.gates.length} (⬌ — в обе стороны, ⇥ — въезд, ↤ — выезд). Клик по краю у улицы — сменить или добавить`,
    },
  ];
  if (lotIsBig(lot) && lot.nodes?.length)
    now.push({ icon: '⤴', label: 'Въезд через перекрёсток', value: '✓', tip: `Больше ${LOT.big} мест: ворота примкнуты к улице перекрёстком — въезд и выезд через него, очереди и повороты как на перекрёстке` });
  now.push(
    lot.owner === 'player'
      ? { icon: '👤', label: 'Ваша, содержание', value: `${money(lotUpkeep(lot))}/мес`, tip: `Содержание ${money(lotUpkeep(lot))} в месяц (${Math.round(LOT.upkeep * 100)}% цены). Стоянка бесплатная` }
      : { icon: '🏘', label: 'Поставил город', value: 'бесплатно', tip: 'Поставил город: бесплатно, без содержания' },
  );
  const { s, label } = statsOf(lot.month, lot.last);
  const who = s?.who ?? [0, 0, 0, 0];
  const whoRows: LotRow[] = [
    ['🏠', 'Жильё и гости', 'Ночуют рядом и гости жилых домов'],
    ['🛒', 'Магазины и рынок', 'Магазины и рынок'],
    ['🏭', 'Работа', 'Работа: конторы, склады, школы, больницы'],
    ['🚉', 'Станции', 'Станции (пересадка на автобус и поезд)'],
  ].map(([icon, text, tip], i) => ({ icon, label: text, value: String(who[i]), tip: `${tip} — ${label}`, sub: true }));
  const month: LotRow[] = [
    { icon: '🔄', label: 'Машин встало', value: String(s?.cars ?? 0), tip: `Сколько машин встало — ${label}` },
    ...whoRows,
    { icon: '⏱', label: 'Стоят в среднем', value: s && s.left ? durationText(s.stay / s.left) : '—', tip: `Сколько в среднем стоит машина — ${label}` },
    { icon: '✋', label: 'Отказов', value: String(s?.refused ?? 0), tip: `Скольким не хватило места (поехали искать дальше) — ${label}`, harm: !!s?.refused },
  ];
  const caption = label[0].toUpperCase() + label.slice(1);
  const btn = (action: string, icon: string, tip: string) => `<button class="small icon-btn" data-action="${action}" data-id="${lot.id}" data-tip="${esc(tip)}">${icon}</button>`;
  const acts = `<div class="actions lot-acts">
    ${btn('lot-move', '✥', 'Перенести: участок за курсором, у улицы — вдоль неё (Alt — свободно, R — поворот). Esc — отмена')}
    ${btn('lot-depth', '⤡', 'Глубже или мельче: 1 → 2 → 4 ряда мест. Ширина — ручками у дальних углов на карте')}
    ${btn('lot-rot', '↺', 'Повернуть на 15° (ручка поворота на карте — так же)')}
    ${btn('lot-gate', '⇄', 'Главные ворота: ⬌ → въезд → выезд. Ещё ворота — клик по краю у улицы')}
    ${btn('lot-remove', '⛔', lot.owner === 'player' ? 'Снести: вернём половину цены' : 'Снести (поставил город)')}</div>`;
  return `<section class="detail project-card park-card lot-card">${head}
    <button class="partner" data-action="focus" data-type="town" data-id="${town.id}">${townIcon(18)}<span>${esc(town.name)}</span><small>${town.population} жит.</small></button>
    ${lotRowsHtml(now)}<h4 class="lot-caption">${caption}</h4>${lotRowsHtml(month)}${acts}</section>`;
}
