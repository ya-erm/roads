/**
 * Карточка предприятия на карте: рецепт значками с названиями и блок «что, откуда, куда» — по каждому сырью склад и
 * кто его везёт по маршрутам (не везёт никто — ⛔), по продукции — кому её везут (game/industryLinks.ts); чего не
 * хватает — строкой-предупреждением. Значки груза — с подсказкой-названием (cargoTip).
 */
import type { Game } from '../game/game';
import { type FlowLink, industryFlow } from '../game/industryLinks';
import { CARGO, type CargoType, type IndustryType } from '../world/cargo';
import type { Industry } from '../world/entities';
import { cargoTip } from './cargoIcons';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const low = (c: CargoType) => CARGO[c].name.toLowerCase();

/** Рецепт словами: «песок + уголь → стекло»; у добычи — только продукция. */
export function recipeText(info: Pick<IndustryType, 'accepts' | 'produces'>): string {
  return info.accepts.length ? `${info.accepts.map(low).join(' + ')} → ${low(info.produces)}` : low(info.produces);
}

/** Рецепт значками, под каждым — название груза: «[песок] + [уголь] → [стекло]». */
export function recipeBoxHtml(info: Pick<IndustryType, 'accepts' | 'produces'>): string {
  const item = (c: CargoType, size: number) => `<span class="rc-item">${cargoTip(c, size)}<small>${esc(CARGO[c].name)}</small></span>`;
  const inputs = info.accepts.map((c) => item(c, 26)).join('<span class="plus">+</span>');
  return `<div class="recipe">${inputs}${info.accepts.length ? '<span class="arrow">→</span>' : ''}${item(info.produces, 30)}</div>`;
}

/** Партнёры ссылками (клик — к нему на карте): первые три, остальные — «+N». */
function linksHtml(list: FlowLink[]): string {
  const shown = list.slice(0, 3).map((l) => `<button class="flow-link" data-action="focus" data-type="${l.ref.type}" data-id="${l.ref.id}">${esc(l.name)}</button>`);
  const more = list.length > 3 ? `<small data-tip="${esc(list.slice(3).map((l) => l.name).join(', '))}">+${list.length - 3}</small>` : '';
  return shown.join('') + more;
}

/**
 * «Сырьё» и «Продукция»: по каждому сырью — склад и откуда везут (⛔ — никто не везёт), по продукции — куда везут.
 * Сверху — чего не хватает: сырьё, которое не подвозят, или которое кончилось на складе.
 */
export function industryFlowHtml(g: Game, ind: Industry): string {
  const flow = industryFlow(ind, {
    lines: g.lines.values(),
    stations: g.stations,
    industries: g.industries,
    towns: g.towns,
    freight: (l) => g.lineTakes(l, 'freight'),
  });
  const rows: string[] = [];
  const noRoute = flow.inputs.filter((i) => !i.from.length).map((i) => i.cargo);
  const empty = flow.inputs.filter((i) => i.from.length && (ind.stock[i.cargo] ?? 0) < 1).map((i) => i.cargo);
  if (noRoute.length)
    rows.push(
      `<div class="ent-row hint bad" data-tip="Сырьё никто не везёт по маршруту: проложите маршрут от предприятия, которое его делает, до станции у этого${
        ind.info.accepts.length > 1 ? '. Без любого из видов сырья завод стоит' : ''
      }"><span class="ent-ic">⛔</span><small>Не подвозят: <b>${noRoute.map(low).join(', ')}</b></small></div>`,
    );
  else if (empty.length)
    rows.push(
      `<div class="ent-row hint" data-tip="Маршрут есть, но на складе пусто: груз ещё в пути или машин не хватает"><span class="ent-ic">⏳</span><small>Ждёт: <b>${empty.map(low).join(', ')}</b></small></div>`,
    );
  for (const i of flow.inputs) {
    const stock = Math.floor(ind.stock[i.cargo] ?? 0);
    const from = i.from.length
      ? `<span class="flow-dir" data-tip="Откуда везут по маршрутам">←</span>${linksHtml(i.from)}`
      : '<small class="bad">⛔ не подвозят</small>';
    rows.push(`<div class="ent-row flow-row">${cargoTip(i.cargo, 18)}<b>${esc(CARGO[i.cargo].name)}</b><span class="flow-stock" data-tip="На складе предприятия">📦 ${stock}</span>${from}</div>`);
  }
  const o = flow.output;
  const to = o.to.length
    ? `<span class="flow-dir" data-tip="Куда везут по маршрутам">→</span>${linksHtml(o.to)}`
    : flow.routed
      ? '<small>→ увозят по маршруту</small>'
      : '<small class="bad" data-tip="Продукцию забирают со станции у предприятия, через которую идёт маршрут">⛔ не вывозят: нет маршрута</small>';
  const out = `<div class="ent-row flow-row">${cargoTip(o.cargo, 18)}<b>${esc(CARGO[o.cargo].name)}</b>${to}</div>`;
  const inputs = flow.inputs.length
    ? `<div class="flow-title" data-tip="На 1 единицу продукции — по 1 единице каждого вида сырья">Сырьё</div>${rows.join('')}`
    : rows.join('');
  return `<div class="ent-rows ind-flow">${inputs}<div class="flow-title">${flow.inputs.length ? 'Продукция' : 'Добывает'}</div>${out}</div>`;
}
