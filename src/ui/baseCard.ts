/**
 * Карточка строительной базы (режим «Со строительством») в правой панели — открывается кликом по площадке базы на
 * карте («Выбор») или по строке базы на плашке слева внизу. Наглядно, значками и полосками:
 * - название (клик — переименовать) и сводка: бригад, в деле, содержание в месяц, «📡 радиус 2,5 км» (радиус
 *   обслуживания, CONSTRUCTION.serviceRadius; на карте у выбранной базы — кругом);
 * - бригады: самосвал, номер, что делает (строит «…», едет по дороге, едет вдоль стройки, ждёт выезда, на базе, ждёт
 *   подъезда); клик — показать бригаду на карте, по названию стройки — к стройке; «＋ 🚚» — нанять, «−» — распустить;
 *   пути бригад в дороге у выбранной базы — на карте (Renderer.drawCrewRoute);
 * - ближние стройки: как далеко от базы и вклад бригады отсюда (1 / (1 + d / reach)), можно ли доехать по дорогам;
 *   дальние — «📡 вне радиуса» (бригады базы сами туда не поедут), ближе к другой базе — «🏚 «…»» (её стройка);
 *   клик — к проекту и его карточке;
 * - «↔ Перенести» — площадка за курсором у дороги, как при постановке (Controller.startBaseMove; ещё — «Двигать» по ней);
 * - «🚜 Снести базу» — со второго нажатия («Точно? +$N, бригады → «…»»), как Game.removeBase; ещё — «Сносом» по площадке.
 * Подсказки — data-tip (не системные).
 */
import { CONSTRUCTION } from '../config';
import type { Brigade } from '../game/crews';
import type { Game } from '../game/game';
import { baseRemoveText, baseSvg, buildSvg, km, withProjectLink } from './constructionUi';
import { crewDoing } from './projectCard';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;

/** Сколько ближних строек показывать. */
const NEAR_MAX = 4;

/** Значок состояния бригады (как на самосвале в карточке проекта). */
const MARK: Record<Brigade['state'], string> = { working: '🏗', going: '➜', back: '↩', idle: '' };

/**
 * Что делает бригада базы — коротко, с проектом: «строит «Улица 1+1»», «едет по дороге → «…»», «на базе»; свободна,
 * а у незаконченных проектов нет подъезда — «на базе · ждёт подъезда» (иначе непонятно, почему она стоит).
 */
export function baseCrewText(game: Game, b: Brigade): string {
  const info = b.project !== undefined ? game.construction.info(b.project) : null;
  const label = info ? ` «${game.projectTitle(info.project.id)}»` : '';
  if (b.state === 'working') return `строит${label}`;
  if (b.state === 'going') return `${crewDoing(b)} →${label}`;
  if (b.state === 'back') return 'едет на базу';
  const list = game.construction.list().filter((i) => !i.project.paused);
  if (list.some((i) => !i.access)) return 'на базе · ждёт подъезда';
  // Стройки есть, но все — вне радиуса этой базы: бригада сама к ним не поедет.
  if (list.length && !list.some((i) => game.construction.serves(i.project.id, b.base))) return 'на базе · стройки вне радиуса';
  // В радиусе есть, но все — стройки других баз, они ближе: туда едут их бригады.
  if (list.length && !list.some((i) => game.construction.owner(i.project.id) === b.base)) return 'на базе · стройки у баз ближе';
  return 'на базе';
}

/**
 * Что спросить на кнопке сноса перед вторым нажатием: «Точно? +$20 000, бригады → «Липки»»; других баз нет —
 * «бригады распустят»; первая была бесплатной — «без возврата». Те же числа, что у Game.baseRemovePlan.
 */
export function baseRemoveConfirm(game: Game, id: number): string {
  const plan = game.baseRemovePlan(id);
  if (!plan) return 'Базы нет';
  const parts = [plan.refund ? `+${money(plan.refund)}` : 'без возврата'];
  if (plan.brigades) parts.push(plan.to !== null ? `бригады → «${game.baseName(plan.to)}»` : `бригады распустят (+${money(plan.dismissRefund)})`);
  return `Точно? ${parts.join(', ')}`;
}

/** Кнопка сноса: первое нажатие — вопрос (confirm), второе — снос (hud: «base-remove»). */
function removeButton(game: Game, id: number, confirm: boolean): string {
  const tip = `${baseRemoveText(game, id)}${confirm ? ' — нажмите ещё раз, чтобы снести' : ''}. Ещё можно «Сносом» по площадке`;
  return `<button class="small bc-remove ${confirm ? 'confirm' : ''}" data-action="base-remove" data-id="${id}" data-tip="${esc(tip)}">${
    confirm ? esc(baseRemoveConfirm(game, id)) : '🚜 Снести базу'
  }</button>`;
}

/**
 * Карточка базы id; renaming — вместо названия поле ввода; confirmRemove — кнопка сноса ждёт второго нажатия. Базы нет
 * (снесли) — короткая записка.
 */
export function baseCardHtml(game: Game, id: number, renaming = false, confirmRemove = false): string {
  const close = `<button class="icon" data-action="close-sel" data-tip="Закрыть">✕</button>`;
  const crews = game.construction.crews;
  const base = crews.bases.get(id);
  if (!base) return `<section class="detail project-card base-card"><header><h3>База</h3>${close}</header><p class="muted">Базы больше нет: снесена.</p></section>`;
  const name = game.baseName(id);
  const title = renaming
    ? `<input class="line-name station-name" data-base-name="${id}" value="${esc(name)}" maxlength="40" />`
    : `<h3 class="station-title" data-action="base-rename" data-id="${id}" data-tip="Нажмите, чтобы переименовать">${esc(name)}</h3>
       <button class="icon pencil" data-action="base-rename" data-id="${id}" data-tip="Переименовать">✎</button>`;
  const head = `<header class="pc-head station-head"><button class="icon pc-show" data-action="base-show" data-id="${id}" data-tip="Показать базу на карте">${baseSvg(30, 22)}</button>
    ${title}${close}</header>`;
  return `<section class="detail project-card base-card">${head}
    ${summaryHtml(game, id)}
    ${crewsHtml(game, id)}
    ${nearHtml(game, id)}
    <div class="pc-actions"><button class="small" data-action="base-move" data-id="${id}" data-tip="Перенести базу к другой дороге: за саму базу не платить, только за снос домов на новом месте. Свободные бригады приедут туда сами, работающие доделают своё и вернутся уже туда">↔ Перенести</button>
      ${removeButton(game, id, confirmRemove)}</div></section>`;
}

/** Сводка значками: бригад из предела, в деле, содержание в месяц. */
function summaryHtml(game: Game, id: number): string {
  const list = game.construction.crews.of(id);
  const busy = list.filter((b) => b.state === 'working' || b.state === 'going').length;
  const upkeep = list.length * CONSTRUCTION.brigade.upkeep;
  const max = CONSTRUCTION.base.maxBrigades;
  return `<div class="pc-chips">
    <span class="pc-chip" data-tip="Бригад на базе (не больше ${max})">🚚 <b>${list.length}</b><span class="muted"> из ${max}</span></span>
    <span class="pc-chip" data-tip="В деле: строят или едут на стройку">🏗 <b>${busy}</b><span class="muted"> в деле</span></span>
    <span class="pc-chip" data-tip="Содержание бригад базы в месяц (статья «транспорт»)">💸 <b>${money(upkeep)}</b><span class="muted"> / мес</span></span>
    <span class="pc-chip bc-radius" data-tip="${esc(
      `Радиус обслуживания: бригады базы сами едут только на стройки не дальше ${km(CONSTRUCTION.serviceRadius)} от неё (круг на карте). Дальше — только вручную («🎯 На стройку…» в карточке бригады), и строить там медленно`,
    )}">📡 <span class="muted">радиус</span> <b>${km(CONSTRUCTION.serviceRadius)}</b></span></div>`;
}

/** Бригады базы: самосвал, №, что делает (клик — к ней на карте); нанять и распустить. */
function crewsHtml(game: Game, id: number): string {
  const crews = game.construction.crews;
  const list = crews.of(id);
  const rows = list
    .map((b, i) => {
      const mark = MARK[b.state];
      const text = baseCrewText(game, b);
      const where = game.brigadeWhere(b.id);
      const pin = b.pinned ? `<span data-tip="Назначена вами на этот проект: автоматика её не перебросит">📌</span> ` : '';
      // Название стройки — ссылкой (к ней и её карточка); строка — открыть бригаду. Едет — её путь на карте (у выбранной базы).
      return `<button class="pc-crew ${b.state}" data-action="crew-show" data-id="${b.id}" data-tip="${esc(`Бригада ${i + 1}: ${where?.text ?? text} — открыть бригаду и показать на карте`)}">
        <span class="bb-crew ${b.state}">🚚${mark ? `<i>${mark}</i>` : ''}</span>
        <span class="pc-crew-name"><b>№${i + 1}</b> · ${pin}${withProjectLink(game, text, b.project)}</span></button>`;
    })
    .join('');
  const B = CONSTRUCTION.base;
  const full = list.length >= B.maxBrigades;
  const poor = CONSTRUCTION.brigade.cost > game.budget;
  const upkeep = money(CONSTRUCTION.brigade.upkeep);
  const hire = `<button class="small" data-action="base-hire" data-id="${id}" ${full || poor ? 'disabled' : ''} data-tip="${esc(
    full ? `На базе не больше ${B.maxBrigades} бригад — поставьте ещё базу` : poor ? 'Не хватает денег' : `Нанять бригаду: ${money(CONSTRUCTION.brigade.cost)}, содержание ${upkeep} в месяц`,
  )}">＋ 🚚 ${money(CONSTRUCTION.brigade.cost)}</button>`;
  const fire = `<button class="small" data-action="base-fire" data-id="${id}" ${list.length ? '' : 'disabled'} data-tip="Распустить бригаду (свободную — первой): половина цены — назад">− 🚚</button>`;
  const body = rows ? `<div class="pc-crews">${rows}</div>` : `<div class="pc-why"><span class="pc-why-ic">🚫</span><span>Бригад нет — строить некому</span></div>`;
  return `<div class="pc-block"><div class="pc-title">🚚 Бригады <b>${list.length}</b><span class="muted"> из ${B.maxBrigades}</span></div>${body}
    <div class="pc-actions">${hire}${fire}</div></div>`;
}

/** Стройка p — другой базы, она ближе (Construction.owner): «🏚 «Липки»» — бригады этой базы туда сами не едут. */
function other(game: Game, p: number, id: number): string {
  const owner = game.construction.owner(p);
  if (owner === null || owner === id) return '';
  const name = game.baseName(owner);
  return `<span class="muted" data-tip="${esc(
    `Эту стройку строят бригады базы «${name}» — она ближе. Бригады этой базы сами туда не едут, даже когда те заняты; вручную («🎯 На стройку…») — можно`,
  )}">🏚 ${esc(name)}</span>`;
}

/**
 * Ближние стройки: по расстоянию от базы до края работ (или середины недостроенного); вклад бригады отсюда — полоской
 * (на reach от базы — вдвое медленнее); к проекту не доехать отсюда по дорогам — «⛔».
 */
function nearHtml(game: Game, id: number): string {
  const base = game.construction.crews.bases.get(id)!;
  const near = game.construction
    .list()
    .map((info) => {
      const at = info.front ?? info.at;
      return { info, d: Math.hypot(at.x - base.fp.center.x, at.y - base.fp.center.y) };
    })
    .sort((a, b) => a.d - b.d || a.info.project.id - b.info.project.id);
  const title = `<div class="pc-title">${buildSvg(20, 15)} Стройки рядом${near.length ? ` <b>${near.length}</b>` : ''}</div>`;
  if (!near.length) return `<div class="pc-block">${title}<p class="muted">Строек нет — свободные бригады стоят на базе.</p></div>`;
  const rows = near
    .slice(0, NEAR_MAX)
    .map(({ info, d }) => {
      const p = info.project;
      const power = Math.round((1 / (1 + d / CONSTRUCTION.reach)) * 100);
      // Доехать отсюда — до какого-нибудь фронта проекта (свой участок навстречу другим — тоже).
      const reach = game.construction.siteFrom(p.id, base.nodeId) !== null;
      const state = !info.access && info.waits
        ? `<span class="muted" data-tip="Подъезд — через соседний строящийся проект: начнётся, когда тот дорастёт сюда">⏳ после соседнего</span>`
        : !info.access
        ? `<span class="pc-bad" data-tip="К проекту нет подъезда ни с одной базы: постройте дорогу к его началу или поставьте базу рядом">⛔ нет подъезда</span>`
        : !reach
          ? `<span class="pc-bad" data-tip="Отсюда по дорогам не доехать: бригады этой базы туда не поедут">⛔ не доехать</span>`
          : p.paused
            ? `<span class="muted" data-tip="Проект на паузе">⏸</span>`
            : !game.construction.serves(p.id, id)
              ? `<span class="pc-bad" data-tip="${esc(
                  `Дальше ${km(CONSTRUCTION.serviceRadius)} от базы: её бригады сами туда не поедут — только вручную («🎯 На стройку…»), и строить будут медленно`,
                )}">📡 вне радиуса</span>`
              : other(game, p.id, id);
      return `<button class="pc-crew bc-near" data-action="build-show" data-id="${p.id}" data-tip="${esc(
        `«${game.projectTitle(p.id)}»: ${km(d)} от базы — бригада отсюда строит в силу ${power}% (дальше — медленнее: вклад 1 / (1 + d / ${km(CONSTRUCTION.reach)})). Нажмите — к проекту`,
      )}">
        <span class="bc-near-ic">${buildSvg(22, 16)}</span>
        <span class="pc-crew-name">${esc(game.projectTitle(p.id))} <span class="muted">· ${Math.min(99, Math.floor(info.done * 100))}%</span></span>
        <span class="pc-crew-state">${state || `📏 ${km(d)}`}</span>
        <span class="pc-mini" data-tip="${esc(`Сила бригады отсюда ${power}%`)}"><i style="width:${power}%"></i></span></button>`;
    })
    .join('');
  const more = near.length > NEAR_MAX ? `<p class="muted">ещё ${near.length - NEAR_MAX}</p>` : '';
  return `<div class="pc-block">${title}<div class="pc-crews">${rows}</div>${more}</div>`;
}
