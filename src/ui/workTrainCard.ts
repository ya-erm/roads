/**
 * Карточка строительного поезда ж/д проекта (режим «Со строительством», src/game/workTrains.ts) в правой панели —
 * открывается кликом по поезду на карте (в пути или у края работ) или по чипу «🚂 едет» в карточке проекта.
 * Наглядно, значками:
 * - что делает: ⏳ ждёт выезда, ➜ едет к стройке, 🏗 строит, ↩ едет на вокзал; скорость;
 * - откуда → куда полоской: 🚉 вокзал-депо (клик — к нему) и 🏗 проект (клик — к проекту и его карточке), на полоске —
 *   поезд там, докуда доехал; под ней — сколько ещё по путям и примерно сколько ехать;
 * - «◎ Следовать» (камера за головой состава, F).
 * Маршрут по путям до цели и сама цель подсвечены на карте (renderer, drawWorkTrainSelected). Подсказки — data-tip.
 */
import { durationText } from '../core/timeText';
import { projectName } from '../game/construction';
import type { Game } from '../game/game';
import type { WorkTrainDoing } from '../game/workTrains';
import { KMH_PER_UNIT } from '../world/roadTypes';
import { buildSvg, km } from './constructionUi';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Что делает поезд: значок, коротко и подсказка. */
const DOING: Record<WorkTrainDoing, { mark: string; text: string; tip: string }> = {
  wait: { mark: '⏳', text: 'ждёт выезда', tip: 'Ждёт свободную платформу вокзала, чтобы выехать' },
  going: { mark: '➜', text: 'едет к стройке', tip: 'Едет по готовым путям к краю работ' },
  working: { mark: '🏗', text: 'строит', tip: 'Стоит у края готового пути и укладывает путь перед собой: балласт, шпалы, рельсы' },
  back: { mark: '↩', text: 'едет на вокзал', tip: 'Работы нет: едет домой на свой вокзал, там исчезнет' },
};

export interface WorkTrainCardView {
  /** Камера следует за поездом. */
  following: boolean;
}

/** Карточка строительного поезда id. Поезда нет (вернулся на вокзал, путь под ним снесли) — короткая записка. */
export function workTrainCardHtml(game: Game, id: number, view: WorkTrainCardView): string {
  const close = `<button class="icon" data-action="close-sel" data-tip="Закрыть">✕</button>`;
  const trains = game.construction.trains;
  const w = trains?.list.get(id);
  if (!trains || !w)
    return `<section class="detail project-card worktrain-card"><header><h3>🚂 Строительный поезд</h3>${close}</header><p class="muted">🚉 Поезда больше нет: вернулся на вокзал.</p></section>`;
  const doing = trains.doing(w);
  const st = DOING[doing];
  const head = `<header class="pc-head station-head"><button class="icon pc-show" data-action="worktrain-show" data-id="${id}" data-tip="Показать поезд на карте">🚂</button>
    <h3 class="station-title">Строительный поезд</h3>${close}</header>`;
  const sim = trains.simOf(w);
  const chips = [
    `<span class="pc-chip wt-doing ${doing}" data-tip="${esc(st.tip)}">${st.mark} ${st.text}</span>`,
    sim ? `<span class="pc-chip" data-tip="Скорость поезда">🚀 <b>${Math.round(sim.v * KMH_PER_UNIT)}</b> км/ч</span>` : '',
  ].join('');
  const follow = trains.body(w)
    ? `<div class="actions pc-actions"><button class="small ${view.following ? 'primary' : ''}" data-action="toggle-follow" data-tip="Камера — за поездом">${
        view.following ? '◉ Камера следует' : '◎ Следовать'
      } <kbd>F</kbd></button></div>`
    : '';
  return `<section class="detail project-card worktrain-card">${head}
    <div class="pc-chips">${chips}</div>
    ${tripHtml(game, id)}${follow}</section>`;
}

/**
 * Откуда → куда: вокзал-депо и проект по краям полоски, поезд — на ней, там, докуда доехал (домой — справа налево:
 * от проекта к вокзалу). Под полоской — сколько ещё по путям и примерно сколько ехать (на скорости ×1).
 */
function tripHtml(game: Game, id: number): string {
  const trains = game.construction.trains!;
  const w = trains.list.get(id)!;
  const doing = trains.doing(w);
  const st = game.stations.get(w.depot);
  const depot = `<button class="wt-end" data-action="show-station" data-id="${w.depot}" data-tip="${esc(`Вокзал «${st?.name ?? 'вокзал'}»: отсюда поезд вышел и сюда вернётся — показать на карте`)}">🚉 ${esc(st?.name ?? 'вокзал')}</button>`;
  const p = game.construction.projects.get(w.project);
  const project = p
    ? `<button class="wt-end" data-action="build-show" data-id="${p.id}" data-tip="${esc(`Проект «${projectName(p)}»: здесь поезд строит путь — открыть карточку проекта`)}">${buildSvg(18, 14)} ${esc(projectName(p))}</button>`
    : `<span class="wt-end muted" data-tip="Проект закончен или отменён">${buildSvg(18, 14)} ✓</span>`;
  // Доля пути, которую поезд проехал, — от левого края (вокзала): домой — справа налево.
  const run = trains.progress(w);
  const share = doing === 'working' ? 1 : doing === 'wait' ? 0 : doing === 'back' ? 1 - (run ?? 0) : (run ?? 0);
  const pct = Math.round(share * 100);
  const where = doing === 'working' ? 'строит у края работ' : doing === 'wait' ? 'ещё на вокзале' : `проехал ${Math.round((run ?? 0) * 100)}% пути`;
  // Проеханное — цветом: к стройке — от вокзала (слева), домой — от проекта (справа).
  const fill = doing === 'back' ? 100 - pct : pct;
  const track = `<span class="wt-track ${doing === 'back' ? 'back' : ''}" data-tip="${esc(`Поезд ${where}`)}"><i style="width:${fill}%"></i><b style="left:${pct}%">🚂</b></span>`;
  const route = trains.route(w);
  const sim = trains.simOf(w);
  const left = route
    ? `<div class="wt-left"><span class="pc-chip" data-tip="${esc(doing === 'back' ? 'Сколько ещё ехать по путям до вокзала' : 'Сколько ещё ехать по путям до края работ')}">📏 <b>${km(route.left)}</b></span>${
        sim ? `<span class="pc-chip" data-tip="Примерно сколько ещё ехать на скорости ×1 (сигналы и встречные поезда могут задержать)">⏳ ≈ <b>${durationText(route.left / sim.maxSpeed)}</b></span>` : ''
      }</div>`
    : '';
  return `<div class="pc-block"><div class="wt-trip">${depot}${track}${project}</div>${left}</div>`;
}
