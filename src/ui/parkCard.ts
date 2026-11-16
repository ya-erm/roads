/**
 * Карточка парка, сквера, площади у ратуши, сквера с памятником или набережной (Town.parks, world/townParks.ts) в
 * правой панели — открывается кликом по зелени в «Выборе» (Game.parkAt: здания, станции и дороги поверх — главнее).
 * Наглядно, значками:
 * - заголовок — значок и вид («Парк», «Сквер», «Площадь»…), кнопка-значок «Показать на карте»; ниже — город (клик —
 *   к городу и его карточке);
 * - площадь в м² (от гектара — в га), размер участка в подсказке;
 * - что внутри — значки с числом: фонтан, пруд, памятник, вечный огонь, детская площадка, клумбы, деревья, скамейки,
 *   фонари, брусчатка, прогулочная полоса — по той же раскладке, что на карте (render/parkArt.parkContents);
 * - чем это игроку: рост города обходит зелень (дома и улицы сюда не встают), дорога игрока может пройти насквозь
 *   (полотно поверх, без сноса), жителей и рабочих мест не даёт.
 * Подсказки — data-tip (не системные).
 */
import type { Game } from '../game/game';
import { parkContents, type ParkContents } from '../render/parkArt';
import type { ParkKind, TownPark } from '../world/entities';
import { money } from '../core/moneyText';
import { PARK_INFO } from '../world/parkPick';
import { movablePark, parkMoveCost } from '../world/townParks';
import { townIcon } from './cargoIcons';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n: number) => Math.round(n).toLocaleString('ru-RU');

/** Площадь участка: до гектара — в м² (до десятков), дальше — в га с двумя знаками. */
export function parkAreaText(p: Pick<TownPark, 'fp'>): string {
  const a = p.fp.w * p.fp.h;
  if (a >= 10000) return `${(a / 10000).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} га`;
  return `${num(a >= 1000 ? Math.round(a / 10) * 10 : a)} м²`;
}

/** Значки того, что внутри: [значок, число или '' (есть/нет), подсказка]. Пустые — не показываем. */
export function parkItems(c: ParkContents): [string, string, string][] {
  const out: [string, string, string][] = [];
  const add = (n: number | boolean, icon: string, tip: string) => {
    if (n === false || n === 0) return;
    out.push([icon, typeof n === 'number' && n > 1 ? String(n) : '', tip]);
  };
  add(c.fountains, '⛲', 'Фонтан');
  add(c.ponds, '🦆', 'Пруд с камышом');
  add(c.statues, '🗿', 'Памятник на постаменте');
  add(c.obelisk, '🔥', 'Обелиск и вечный огонь');
  add(c.playgrounds, '🛝', 'Детская площадка');
  add(c.promenade, '🌊', 'Прогулочная полоса с парапетом у воды');
  add(c.paved, '🧱', 'Брусчатка во весь участок');
  add(c.beds, '🌷', 'Клумбы');
  add(c.trees, '🌳', 'Деревья');
  add(c.benches, '🪑', 'Скамейки');
  add(c.lamps, '💡', 'Фонари');
  return out;
}

/** Строки «чем это игроку»: значок и коротко — то, что и правда есть в механике (townParks.ts, DESIGN.md). */
export function parkUseRows(kind: ParkKind): [string, string, string][] {
  return [
    ['🏘', '🚫', 'Рост города обходит: новые дома и улицы сюда не встают'],
    ['🛣', '✓', kind === 'embankment' ? 'Дорогу можно провести вдоль или насквозь: полотно ляжет поверх, без сноса' : 'Дорогу можно провести насквозь: полотно ляжет поверх, зелень останется вокруг, без сноса'],
    ['👥', '—', 'Жителей и рабочих мест не даёт — для вида города'],
  ];
}

export function parkCardHtml(g: Game, id: number): string {
  const close = `<button class="icon" data-action="close-sel" data-tip="Закрыть">✕</button>`;
  const hit = g.parkById(id);
  if (!hit) return `<section class="detail project-card park-card"><header><h3>Парк</h3>${close}</header><p class="muted">Его больше нет.</p></section>`;
  const { park, town } = hit;
  const info = PARK_INFO[park.kind];
  const head = `<header class="pc-head station-head"><button class="icon pc-show" data-action="park-show" data-id="${park.id}" data-tip="Показать на карте">${info.icon}</button>
    <h3>${esc(info.name)}</h3>${close}</header>`;
  const size = `${Math.round(park.fp.w)} × ${Math.round(park.fp.h)} м`;
  const items = parkItems(parkContents(park))
    .map(([icon, n, tip]) => `<span class="pc-chip park-item" data-tip="${esc(tip)}">${icon}${n ? `<b>${n}</b>` : ''}</span>`)
    .join('');
  const use = parkUseRows(park.kind)
    .map(([icon, mark, tip]) => `<span class="pc-chip park-use" data-tip="${esc(tip)}">${icon}<i>${mark}</i></span>`)
    .join('');
  return `<section class="detail project-card park-card">${head}
    <button class="partner" data-action="focus" data-type="town" data-id="${town.id}">${townIcon(18)}<span>${esc(town.name)}</span><small>${town.population} жит.</small></button>
    <div class="pc-chips"><span class="pc-chip" data-tip="${esc(`Площадь участка · ${size}`)}">📐 <b>${parkAreaText(park)}</b></span></div>
    ${items ? `<div class="pc-chips park-items">${items}</div>` : ''}
    <div class="pc-chips park-uses">${use}</div>${parkMoveHtml(park)}</section>`;
}

/**
 * «Перенести» в карточке парка (Game.movePark): цена — от площади участка (parkMoveCost); в подсказке значками — что
 * едет вместе (деревья, дорожки, фонтан — всё внутри) и куда встанет (вдоль улицы, за тротуаром; не на дорогу, дома и
 * воду). Набережной нет: она у воды по своей природе.
 */
export function parkMoveHtml(park: TownPark): string {
  if (!movablePark(park)) return '';
  const tip = '🌳⛲🪑 всё внутри — вместе с ним · 🛣 встанет вдоль ближайшей улицы, за тротуаром · 🚫 не на дорогу, дома и воду';
  return `<div class="actions"><button class="small" data-action="park-move" data-id="${park.id}" data-tip="${esc(tip)}">🚚 Перенести · ${money(parkMoveCost(park))}</button></div>`;
}
