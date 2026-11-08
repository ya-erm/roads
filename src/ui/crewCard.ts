/**
 * Карточка строительной бригады (режим «Со строительством») в правой панели — открывается кликом по любой машине её
 * колонны на карте (в потоке, вдоль стройки) или по строке бригады в карточках базы и проекта. Наглядно, значками:
 * - что делает сейчас (строит «…», едет по дороге, вдоль стройки, на базе) и чья (база — клик к ней);
 * - назначение: «📌 «Проект»» — игрок закрепил её там, «🤖 авто» — её распределяет автоматика;
 * - «◎ Следовать» (за головной машиной), «🎯 На стройку…» (выбрать проект кликом по карте, Esc — отмена), «↺ Авто»;
 * - стройки списком: расстояние, готовность, бригад x из N; нельзя — значок причины (клик скажет её словами).
 * Подсказки — data-tip (не системные).
 */
import { projectName } from '../game/construction';
import type { Game } from '../game/game';
import { KMH_PER_UNIT } from '../world/roadTypes';
import { buildSvg } from './constructionUi';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} км` : `${Math.round(m)} м`);

/** Значок состояния бригады (как в карточках базы и проекта). */
const MARK = { working: '🏗', going: '➜', back: '↩', idle: '🏚' } as const;

export interface CrewCardView {
  /** Камера следует за бригадой. */
  following: boolean;
  /** Сейчас выбираем ей стройку кликом по карте. */
  picking: boolean;
}

/** Номер бригады на её базе (с 1) — как в карточке базы. */
export function crewNumber(game: Game, id: number): number {
  const crews = game.construction.crews;
  const b = crews.brigades.get(id);
  return b ? crews.of(b.base).indexOf(b) + 1 : 0;
}

/** Карточка бригады id. Бригады нет (распустили, снесли базу без других) — короткая записка. */
export function crewCardHtml(game: Game, id: number, view: CrewCardView): string {
  const close = `<button class="icon" data-action="close-sel" data-tip="Закрыть">✕</button>`;
  const crews = game.construction.crews;
  const b = crews.brigades.get(id);
  if (!b) return `<section class="detail project-card crew-card"><header><h3>🚚 Бригада</h3>${close}</header><p class="muted">Бригады больше нет: распущена.</p></section>`;
  const where = game.brigadeWhere(id);
  const head = `<header class="pc-head station-head"><button class="icon pc-show" data-action="crew-show" data-id="${id}" data-tip="Показать бригаду на карте">🚚</button>
    <h3 class="station-title">Бригада ${crewNumber(game, id)}</h3>${close}</header>`;
  const info = b.project !== undefined ? game.construction.info(b.project) : null;
  const lead = crews.lead(b);
  const sim = lead !== undefined ? game.traffic.vehicles.get(lead) : undefined;
  const chips = [
    `<span class="pc-chip cc-doing" data-tip="Что делает бригада сейчас">${MARK[b.state]} ${esc(where?.text ?? '')}</span>`,
    `<span class="pc-chip cc-base" data-action="base-show" data-id="${b.base}" data-tip="База бригады — нажмите, чтобы открыть">🏚 ${esc(game.baseName(b.base))}</span>`,
    sim ? `<span class="pc-chip" data-tip="Скорость головной машины колонны">🚀 <b>${Math.round(sim.v * KMH_PER_UNIT)}</b> км/ч</span>` : '',
    b.pinned && info
      ? `<span class="pc-chip cc-pin" data-tip="Назначена вами: автоматика не перебросит её, пока проект не закончится, не встанет на паузу или вы не нажмёте «↺ Авто»">📌 «${esc(projectName(info.project))}»</span>`
      : `<span class="pc-chip cc-auto" data-tip="Куда ехать, решает автоматика: где рук меньше, приоритетный проект первым">🤖 авто</span>`,
  ].join('');
  const follow = `<button class="small ${view.following ? 'primary' : ''}" data-action="toggle-follow" data-tip="Камера — за головной машиной колонны">${view.following ? '◉ Камера следует' : '◎ Следовать'} <kbd>F</kbd></button>`;
  const send = `<button class="small ${view.picking ? 'primary' : ''}" data-action="crew-send" data-id="${id}" data-tip="${
    view.picking ? 'Выбираете стройку — нажмите ещё раз или Esc, чтобы отменить' : 'Отправить бригаду на стройку: кликните по плашке «🏗» или полотну проекта на карте'
  }">🎯 На стройку…</button>`;
  const auto = b.pinned
    ? `<button class="small" data-action="crew-auto" data-id="${id}" data-tip="Снять закрепление: дальше бригаду распределяет автоматика">↺ Авто</button>`
    : '';
  const hint = view.picking
    ? `<div class="pc-why cc-picking"><span class="pc-why-ic">🎯</span><span>Кликните по стройке на карте — плашке «🏗» или полотну проекта · <kbd>Esc</kbd> — отмена</span></div>`
    : '';
  return `<section class="detail project-card crew-card">${head}
    <div class="pc-chips">${chips}</div>
    <div class="actions pc-actions">${follow}${send}${auto}</div>${hint}
    ${targetsHtml(game, id)}</section>`;
}

/**
 * Стройки, куда можно отправить бригаду, — по расстоянию от неё: название и готовность, расстояние, бригад x из N.
 * Где она сейчас — «📍»; нельзя — значок причины (⏸ пауза, ⛔ нет подъезда или не доехать, 🚚 места нет); вне радиуса
 * базы бригады — «⚠» (можно, но строить будет медленно).
 */
function targetsHtml(game: Game, id: number): string {
  const crews = game.construction.crews;
  const b = crews.brigades.get(id)!;
  const from = game.brigadeWhere(id)?.pos ?? { x: 0, y: 0 };
  const list = game.construction
    .list()
    .map((info) => {
      const at = info.front ?? info.at;
      return { info, d: Math.hypot(at.x - from.x, at.y - from.y) };
    })
    .sort((x, y) => x.d - y.d || x.info.project.id - y.info.project.id);
  const title = `<div class="pc-title">${buildSvg(20, 15)} Стройки${list.length ? ` <b>${list.length}</b>` : ''}</div>`;
  if (!list.length) return `<div class="pc-block">${title}<p class="muted">Строек нет — отправить некуда.</p></div>`;
  // Мест нет — кого заменит: дальнюю бригаду, назначенную автоматикой.
  const replaced = (pid: number) => {
    if (crews.assigned(pid).length < crews.cap(pid)) return '';
    const out = crews.displaced(b, pid);
    return out ? ` вместо бригады ${crews.of(out.base).indexOf(out) + 1} базы «${game.baseName(out.base)}» (она дальше)` : '';
  };
  const rows = list
    .map(({ info, d }) => {
      const p = info.project;
      const here = b.project === p.id && (b.state === 'going' || b.state === 'working');
      const problem = game.brigadeCanGo(id, p.id);
      const n = crews.assigned(p.id).length;
      const cap = crews.cap(p.id);
      // Вне радиуса базы бригады: туда — только вручную, и строить она будет медленно (возит издалека).
      const far = !here && !problem && game.construction.outOfRadius(p.id, b);
      const icon = here
        ? b.pinned
          ? '📌'
          : '📍'
        : !problem
          ? `${far ? '⚠ ' : ''}📏 ${km(d)}`
          : p.paused
            ? '⏸'
            : n >= cap
              ? '🈵'
              : '⛔';
      const tip = here
        ? b.pinned
          ? `Бригада здесь и закреплена`
          : `Бригада здесь — нажмите, чтобы закрепить её на «${projectName(p)}»`
        : problem
          ? `Нельзя: ${problem}`
          : `«${projectName(p)}»: ${km(d)} отсюда — нажмите, бригада поедет туда по дорогам и закрепится${replaced(p.id)}${
              far ? '. ⚠ вне радиуса базы — строить будет медленно' : ''
            }`;
      return `<button class="pc-crew cc-target ${problem ? 'cc-off' : ''} ${here ? 'cc-here' : ''}" data-action="crew-to" data-id="${id}" data-p="${p.id}" data-tip="${esc(tip)}">
        <span class="bc-near-ic">${buildSvg(22, 16)}</span>
        <span class="pc-crew-name">${esc(projectName(p))} <span class="muted">· ${Math.min(99, Math.floor(info.done * 100))}%</span></span>
        <span class="pc-crew-state">${icon}</span>
        <span class="cc-slots ${n >= cap ? 'full' : ''}" data-tip="${esc(`Бригад на проекте: ${n} из ${cap}`)}">🚚 ${n}/${cap}</span></button>`;
    })
    .join('');
  return `<div class="pc-block">${title}<div class="pc-crews">${rows}</div></div>`;
}
