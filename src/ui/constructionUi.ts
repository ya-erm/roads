/**
 * Стройка дорог в интерфейсе (режим «Со строительством», src/game/construction.ts): строка «Стройка» в окне
 * «Новая игра» и плашки проектов слева внизу — что строится, сколько готово и сколько секунд осталось,
 * «⏸ Пауза» и «✕ Отмена», 📍 — к проекту. Подсказки — data-tip (не системные).
 */
import { CONSTRUCTION } from '../config';
import { durationText } from '../core/timeText';
import type { ProjectInfo } from '../game/construction';
import type { Game } from '../game/game';
import { BUILD_MODES, type BuildMode } from '../world/settings';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;

/** Сколько плашек показывать; остальные — строкой «ещё N». */
export const BAR_MAX = 4;

/** Стройка: шлагбаум в полоску на дороге и конус — «дорога строится». */
export function buildSvg(w = 28, h = 21): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}" aria-hidden="true">
    <path d="M2 30H46" stroke="#8a8f97" stroke-width="5" stroke-linecap="round"/>
    <path d="M2 30H22" stroke="#4d535c" stroke-width="5" stroke-linecap="round"/>
    <rect x="7" y="9" width="24" height="7" rx="1.5" fill="#fff" stroke="#d2691e" stroke-width="1.4"/>
    <path d="M12 9l-5 7M19 9l-5 7M26 9l-5 7M31 11l-3.5 5" stroke="#e8743b" stroke-width="2.6"/>
    <path d="M10 16v12M28 16v12" stroke="#5f6670" stroke-width="2"/>
    <path d="M38 12l-5 16h10z" fill="#f08a3c" stroke="#b5561c" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M35.6 20h4.8M34.4 24h7.2" stroke="#fff" stroke-width="1.6"/>
  </svg>`;
}

/** Готово сразу: дорога одним цветом и галочка. */
function instantSvg(w = 28, h = 21): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}" aria-hidden="true">
    <path d="M2 30H46" stroke="#5c636d" stroke-width="5" stroke-linecap="round"/>
    <path d="M6 30H42" stroke="#e8ebef" stroke-width="1" stroke-dasharray="4 4"/>
    <path d="M14 15l6 6 13-13" stroke="#3f9d5a" stroke-width="3.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** Строка «Стройка» окна «Новая игра»: «Мгновенно» / «Со строительством». */
export function buildModeRowHtml(mode: BuildMode | undefined): string {
  const cur = mode ?? 'instant';
  const chip = (v: BuildMode, svg: string) =>
    `<button class="ng-chip ${v === cur ? 'active' : ''}" data-action="ng-set" data-key="construction" data-v="${v}" data-tip="${esc(BUILD_MODES[v].hint)}">${svg}${BUILD_MODES[v].name}</button>`;
  return `<div class="ng-row"><span class="ng-label">Стройка</span><div class="ng-options">${chip('instant', instantSvg())}${chip('build', buildSvg())}</div></div>`;
}

/**
 * Плашка проекта: что (⬆ — приоритетный, 🔒 — с резервом), полоска готовности с процентом, сколько осталось, пауза,
 * отмена, к проекту и его карточке. crew — бригад на месте, based — база уже есть, selected — карточка открыта.
 */
export function projectRowHtml(i: ProjectInfo, crew = 1, based = true, selected = false): string {
  const p = i.project;
  const pct = Math.min(99, Math.floor(i.done * 100));
  const state = p.paused ? 'paused' : p.stalled !== undefined ? 'stalled' : '';
  const status = p.paused
    ? `<span class="bp-state" data-tip="Проект на паузе — ничего не строится и не тратится">⏸</span>`
    : p.stalled !== undefined
      ? `<span class="bp-state bad" data-tip="Стройка стоит: не хватает денег. Нужно ещё ${money(i.left)}">💸</span>`
      : !based
        ? `<span class="bp-state" data-tip="Строить некому: поставьте строительную базу («＋ База») — первая бесплатно">🚚 нет базы</span>`
        : !i.access
        ? `<span class="bp-state bad" data-tip="Нет подъезда: ни один конец проекта не связан готовой дорогой с базой, а по полю бригады не ездят. Постройте дорогу к началу проекта или поставьте базу рядом">⛔ нет подъезда</span>`
        : !crew
        ? `<span class="bp-state" data-tip="Ждёт бригаду: она в пути или все заняты — тогда наймите ещё на базе">🚚 ждёт</span>`
        : `<span class="bp-left" data-tip="Сколько ещё строить на скорости ×1 (бригад на месте: ${crew})">${'🚚'.repeat(Math.min(3, crew))} ⏳ ${durationText(i.seconds)}</span>`;
  const pause = p.paused
    ? `<button class="small" data-action="build-pause" data-id="${p.id}" data-tip="Строить дальше">▶ Дальше</button>`
    : `<button class="small" data-action="build-pause" data-id="${p.id}" data-tip="Пауза: проект стоит и не тратит денег">⏸ Пауза</button>`;
  const cancel = `<button class="small" data-action="build-cancel" data-id="${p.id}" data-tip="Отмена: недостроенное убрать, деньги за него — назад; готовые участки остаются (Ctrl+Z вернёт)">✕ Отмена</button>`;
  const marks = `${p.priority ? `<span class="bp-mark" data-tip="Приоритетный проект: бригады едут сначала сюда">⬆</span>` : ''}${
    p.reserve ? `<span class="bp-mark" data-tip="${esc(`В резерве ${money(p.reserve)}: стройка не встанет без денег`)}">🔒</span>` : ''
  }`;
  return `<div class="build-plate ${state}${selected ? ' selected' : ''}">
    <button class="icon bp-show" data-action="build-show" data-id="${p.id}" data-tip="Показать на карте и открыть карточку проекта">${buildSvg(26, 20)}</button>
    <span class="bp-name" data-action="build-show" data-id="${p.id}" data-tip="${esc(`${p.label} · ${Math.round(i.length)} м · ещё ${money(i.left)} — открыть карточку`)}">${marks}${esc(p.label)}</span>
    ${status}
    <span class="bp-bar" data-tip="Готово ${pct}% — участки от узла до узла открываются сразу"><i style="width:${pct}%"></i><b>${pct}%</b></span>
    ${pause}${cancel}</div>`;
}

/** База стройки: площадка с вагончиком и самосвалом. */
export function baseSvg(w = 26, h = 20): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}" aria-hidden="true">
    <rect x="3" y="6" width="42" height="26" rx="2" fill="#d8d0bf" stroke="#8c8170" stroke-width="1.6" stroke-dasharray="3 2"/>
    <rect x="7" y="10" width="15" height="9" fill="#e8743b" stroke="#9a4a20" stroke-width="1.2"/>
    <circle cx="36" cy="14" r="5" fill="#d9b878"/>
    <rect x="25" y="21" width="15" height="7" rx="1.5" fill="#f2b81d" stroke="#6b5410" stroke-width="1.1"/>
    <rect x="34" y="18" width="6" height="5" rx="1" fill="#f2b81d" stroke="#6b5410" stroke-width="1.1"/>
  </svg>`;
}

/**
 * Что будет при сносе базы — одной строкой (подпись у курсора в «Сносе» по площадке базы): «Снести базу
 * «Сосновка» · +$20 000 · 🚚×2 → «Липки»»; других баз нет — бригады распускаются (с возвратом); первая была бесплатной.
 */
export function baseRemoveText(game: Game, id: number): string {
  const plan = game.baseRemovePlan(id);
  if (!plan) return 'Базы нет';
  const parts = [`Снести базу «${game.baseName(id)}»`, plan.refund ? `+${money(plan.refund)}` : 'первая была бесплатной — денег не вернут'];
  if (plan.brigades)
    parts.push(
      plan.to !== null
        ? `🚚×${plan.brigades} → «${game.baseName(plan.to)}»`
        : `🚚×${plan.brigades} распустить: других баз нет · +${money(plan.dismissRefund)}`,
    );
  return parts.join(' · ');
}

/**
 * Строка базы — коротко: значок, название, сколько бригад и сколько в деле (полоска); клик по строке — к базе на карте
 * и её карточка справа (там бригады, нанять и распустить, переименовать). Снос — инструментом «Снос». selected —
 * карточка этой базы открыта.
 */
export function baseRowHtml(game: Game, id: number, selected = false): string {
  const list = game.construction.crews.of(id);
  const busy = list.filter((b) => b.state === 'working' || b.state === 'going').length;
  const name = game.baseName(id);
  const share = list.length ? Math.round((busy / list.length) * 100) : 0;
  const tip = list.length ? `База «${name}»: бригад ${list.length}, в деле ${busy} — открыть карточку` : `База «${name}»: бригад нет — открыть карточку и нанять`;
  return `<button class="build-base${selected ? ' selected' : ''}" data-action="base-show" data-id="${id}" data-tip="${esc(tip)}">
    <span class="bp-show">${baseSvg()}</span>
    <span class="bb-name">${esc(name)}</span>
    <span class="bb-count">🚚 <b>${list.length}</b></span>
    <span class="bb-busy"><span class="bb-bar"><i style="width:${share}%"></i></span><small>в деле ${busy}</small></span></button>`;
}

/**
 * Плашки стройки: базы (коротко), «＋ База» и проекты. placing — ставим базу (кнопка нажата), selected — проект с
 * открытой карточкой, base — база с открытой карточкой. Не «Со строительством» — пусто.
 */
export function buildBarHtml(game: Game, placing = false, selected: number | null = null, base: number | null = null): string {
  if (!game.buildMode) return '';
  const crews = game.construction.crews;
  const bases = [...crews.bases.keys()];
  const baseRows = bases
    .slice(0, 3)
    .map((id) => baseRowHtml(game, id, id === base))
    .join('');
  // Баз нет — первая бесплатно: кнопка заметнее, пока её не поставят.
  const first = game.firstBase;
  const tip = placing
    ? 'Кликните у дороги, где поставить базу (Esc — отмена)'
    : first
      ? 'Поставьте строительную базу у дороги — первая бесплатно, с бригадой. Ставьте ближе к будущим стройкам: оттуда бригада строит быстрее'
      : `Новая база у дороги: ${money(CONSTRUCTION.base.cost)}. Бригады с ближней базы строят быстрее`;
  const add = `<button class="small build-add ${placing ? 'active' : ''} ${first ? 'first' : ''}" data-action="base-place" data-tip="${tip}">${baseSvg(20, 15)}＋ База${first ? ' · бесплатно' : ''}</button>`;
  const list = game.construction.list();
  const rows = list
    .slice(0, BAR_MAX)
    .map((i) => projectRowHtml(i, crews.working(i.project.id).length, bases.length > 0, i.project.id === selected))
    .join('');
  const more = list.length > BAR_MAX ? `<div class="build-more muted">ещё ${list.length - BAR_MAX}</div>` : '';
  return `<div class="build-head">${baseRows}${add}</div>${rows}${more}`;
}
