/**
 * Стройка дорог в интерфейсе (режим «Со строительством», src/game/construction.ts): строка «Стройка» в окне
 * «Новая игра» и вкладка «Стройка» левой панели — базы, «＋ База» и плашки проектов: что строится, сколько готово
 * и сколько секунд осталось, «⏸ Пауза» и «✕ Отмена», клик — к проекту. Подсказки — data-tip (не системные).
 */
import { CONSTRUCTION } from '../config';
import { durationText } from '../core/timeText';
import { type ProjectInfo, projectName } from '../game/construction';
import type { Game } from '../game/game';
import type { WorkTrains } from '../game/workTrains';
import { BUILD_MODES, type BuildMode } from '../world/settings';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;
/** Расстояние коротко: «6 км», «2,5 км», «800 м». */
export const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0).replace('.', ',')} км` : `${Math.round(m)} м`);

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
export function projectRowHtml(i: ProjectInfo, crew = 1, based = true, selected = false, own: string | null = null): string {
  const p = i.project;
  const pct = Math.min(99, Math.floor(i.done * 100));
  const state = p.paused ? 'paused' : p.stalled !== undefined ? 'stalled' : '';
  // own — своя подпись состояния (ж/д проект: строительный поезд, railRowHtml), кроме паузы и «нет денег».
  const status = p.paused
    ? `<span class="bp-state" data-tip="Проект на паузе — ничего не строится и не тратится">⏸</span>`
    : p.stalled !== undefined
      ? `<span class="bp-state bad" data-tip="Стройка стоит: не хватает денег. Нужно ещё ${money(i.left)}">💸</span>`
      : own !== null
        ? own
      : !based
        ? `<span class="bp-state" data-tip="Строить некому: поставьте строительную базу («＋ База») — первая бесплатно">🚚 нет базы</span>`
        : !i.access && i.waits
        ? `<span class="bp-state" data-tip="Подъезд — через соседний строящийся проект: начнётся, когда тот дорастёт сюда">⏳ после соседнего</span>`
        : !i.access
        ? `<span class="bp-state bad" data-tip="Нет подъезда: ни один конец проекта не связан готовой дорогой с базой, а по полю бригады не ездят. Постройте дорогу к началу проекта или поставьте базу рядом">⛔ нет подъезда</span>`
        : i.noBase
        ? `<span class="bp-state bad" data-tip="${esc(`Нет базы рядом: стройка дальше ${km(CONSTRUCTION.serviceRadius)} от всех баз — бригады сами сюда не поедут. Поставьте базу ближе («＋ База») или отправьте бригаду вручную («🎯 На стройку…» в её карточке)`)}">⛔ нет базы рядом</span>`
        : !crew
        ? `<span class="bp-state" data-tip="Ждёт бригаду: она в пути или все заняты — тогда наймите ещё на базе">🚚 ждёт</span>`
        : `<span class="bp-left" data-tip="Сколько ещё строить на скорости ×1 (бригад на месте: ${crew})">${'🚚'.repeat(Math.min(3, crew))} ⏳ ${durationText(i.seconds)}</span>`;
  const pause = p.paused
    ? `<button class="small" data-action="build-pause" data-id="${p.id}" data-tip="Строить дальше">▶ Дальше</button>`
    : `<button class="small" data-action="build-pause" data-id="${p.id}" data-tip="Пауза: проект стоит и не тратит денег">⏸ Пауза</button>`;
  const cancel = `<button class="small" data-action="build-cancel" data-id="${p.id}" data-tip="Отмена: недостроенное убрать, деньги за него — назад; готовые участки остаются (Ctrl+Z вернёт)">✕ Отмена</button>`;
  // Перестройка готовой дороги (rebuild.ts): 🚧, а перекрыта — ◐ по полосам или ⛔ целиком.
  const re = i.rebuild;
  const shut = re?.closed ? (re.part > 0 && re.moved < re.count ? '◐' : '⛔') : '';
  const reTip = !re ? '' : shut === '◐' ? 'Перестройка: открыта часть прежних полос, машины едут медленнее' : shut ? 'Перестройка: дорога перекрыта, машины объезжают' : 'Перестройка: пока не начали — ездят по прежней дороге';
  const marks = `${p.priority ? `<span class="bp-mark" data-tip="Приоритетный проект: бригады едут сначала сюда">⬆</span>` : ''}${
    p.reserve ? `<span class="bp-mark" data-tip="${esc(`В резерве ${money(p.reserve)}: стройка не встанет без денег`)}">🔒</span>` : ''
  }${re ? `<span class="bp-mark" data-tip="${esc(reTip)}">🚧${shut}</span>` : ''}`;
  return `<div class="build-plate ${state}${selected ? ' selected' : ''}">
    <button class="icon bp-show" data-action="build-show" data-id="${p.id}" data-tip="Показать на карте и открыть карточку проекта">${buildSvg(26, 20)}</button>
    <span class="bp-name" data-action="build-show" data-id="${p.id}" data-tip="${esc(`${projectName(p)} · ${Math.round(i.length)} м · ещё ${money(i.left)} — открыть карточку`)}">${marks}${esc(projectName(p))}</span>
    ${status}
    <span class="bp-bar" data-tip="Готово ${pct}% — участки от узла до узла открываются сразу"><i style="width:${pct}%"></i><b>${pct}%</b></span>
    ${pause}${cancel}</div>`;
}

/** Строительный поезд ж/д проекта id: что с ним (WorkTrains.status); не ж/д — null. */
export function railTrainStatus(game: Game, id: number): ReturnType<WorkTrains['status']> | null {
  const trains = game.construction.trains;
  if (!trains || !game.construction.projects.get(id)?.rail) return null;
  return trains.status(id, (st) => game.stations.get(st)?.name ?? 'вокзал');
}

/**
 * Строка ж/д проекта: как у дороги (projectRowHtml), но вместо бригад — строительный поезд: «🚂 едет», «🚂 ⏳ 1:20»
 * или почему стоит («⛔ нет пути к стройке», «⛔ нет вокзала»).
 */
export function railRowHtml(i: ProjectInfo, rail: { text: string; tip: string; bad: boolean; working: boolean }, selected = false): string {
  // Своя подпись вместо бригадной: тот же ряд, те же кнопки.
  const status =
    !i.access && i.waits
        ? `<span class="bp-state" data-tip="Начало — у соседнего строящегося пути: начнётся, когда тот дорастёт сюда">⏳ после соседнего</span>`
        : rail.bad
          ? `<span class="bp-state bad" data-tip="${esc(rail.tip)}">⛔ ${esc(rail.text)}</span>`
          : rail.working
            ? `<span class="bp-left" data-tip="${esc(`${rail.tip}. Сколько ещё строить на скорости ×1`)}">🚂 ⏳ ${durationText(i.seconds)}</span>`
            : `<span class="bp-state" data-tip="${esc(rail.tip)}">🚂 ${esc(rail.text)}</span>`;
  return projectRowHtml(i, 1, true, selected, status);
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

/** Что показывает вкладка «Стройка»: ставим ли базу (кнопка «＋ База» нажата) и чьи карточки открыты справа. */
export interface BuildView {
  placing: boolean;
  /** Проект с открытой карточкой. */
  project: number | null;
  /** База с открытой карточкой. */
  base: number | null;
}

export const NO_BUILD_VIEW: BuildView = { placing: false, project: null, base: null };

/**
 * Цена строительной базы: now — той, что ставим сейчас (первая «Со строительством» — бесплатно), next — каждой
 * следующей (цена одна: CONSTRUCTION.base.cost). Снос домов под площадкой — сверху, по месту (Game.basePlan).
 */
export function basePrices(game: Game): { now: number; next: number } {
  const cost = CONSTRUCTION.base.cost;
  return { now: game.firstBase ? 0 : cost, next: cost };
}

/** «бесплатно» или «$40 000». */
export const basePriceText = (n: number) => (n ? money(n) : 'бесплатно');

/**
 * Цена базы значками: «[база] бесплатно» и «[база]+ $40 000» (следующие); первая уже стоит — одна плашка «$40 000».
 * Где ставят базу — в панели инструмента «Станция → База стройки».
 */
export function basePriceHtml(game: Game): string {
  const { now, next } = basePrices(game);
  const chip = (cls: string, tip: string, label: string, sum: number) =>
    `<span class="base-price ${cls}" data-tip="${tip}">${baseSvg(20, 15)}<small>${label}</small><b>${basePriceText(sum)}</b></span>`;
  if (now === next) return chip('', `Каждая новая база — ${money(next)}, с бригадой. Снос домов под площадкой — отдельно`, 'база', next);
  return (
    chip('free', 'Первая база — бесплатно, с бригадой', 'первая', now) +
    chip('next', `Каждая следующая база — ${money(next)}, с бригадой. Снос домов под площадкой — отдельно`, 'следующие', next)
  );
}

/**
 * Подпись у курсора, пока ставим базу: «База стройки · бесплатно · следующие — $40 000 · снос 2 зд. · 📡 2,5 км ·
 * Esc — отмена». plan — Game.basePlan у курсора (cost — с доплатой за снос домов).
 */
export function basePlaceText(game: Game, plan: { cost: number; demolish: number[] }): string {
  const { now, next } = basePrices(game);
  const later = now < next ? ` · следующие — ${money(next)}` : '';
  const raze = plan.demolish.length ? ` · снос ${plan.demolish.length} зд.` : '';
  return `База стройки · ${basePriceText(plan.cost)}${later}${raze} · 📡 ${km(CONSTRUCTION.serviceRadius)} · Esc — отмена`;
}

/** «＋ База»: нажата — ставим базу; баз ещё не было — первая бесплатно, кнопка пульсирует, пока её не поставят. */
function addBaseHtml(game: Game, placing: boolean): string {
  const first = game.firstBase;
  const { now, next } = basePrices(game);
  const tip = placing
    ? 'Кликните у дороги, где поставить базу (Esc — отмена)'
    : first
      ? `Поставьте строительную базу у дороги — первая бесплатно, с бригадой; следующие — по ${money(next)}. Ставьте ближе к будущим стройкам: оттуда бригада строит быстрее`
      : `Новая база у дороги: ${money(next)}. Бригады с ближней базы строят быстрее`;
  return `<button class="small build-add ${placing ? 'active' : ''} ${first ? 'first' : ''}" data-action="base-place" data-tip="${tip}">${baseSvg(20, 15)}＋ База · ${basePriceText(now)}</button>`;
}

/** Бригады всех баз: сколько всего и сколько в деле (на стройке или в пути к ней). */
function crewCounts(game: Game): { all: number; busy: number } {
  const list = [...game.construction.crews.brigades.values()];
  return { all: list.length, busy: list.filter((b) => b.state === 'working' || b.state === 'going').length };
}

/** Число на вкладке «Стройка» — проекты; first — первую базу ещё не ставили (вкладка подсвечена). */
export function buildTabCount(game: Game): { projects: number; bases: number; first: boolean } {
  return { projects: game.construction.list().length, bases: game.construction.crews.bases.size, first: game.firstBase };
}

/**
 * Вкладка «Стройка» левой панели: все базы короткими строками (клик — карточка базы), «＋ База» и все проекты
 * (пауза, отмена, клик — карточка проекта). Пусто — подсказка картинками: база у дороги → дорога → бригады строят.
 * Не «Со строительством» — пусто.
 */
export function buildTabHtml(game: Game, view: BuildView = NO_BUILD_VIEW): string {
  if (!game.buildMode) return '';
  const crews = game.construction.crews;
  const bases = [...crews.bases.keys()];
  const baseRows = bases.map((id) => baseRowHtml(game, id, id === view.base)).join('');
  const list = game.construction.list();
  const rows = list
    .map((i) => {
      // Ж/д проект строит строительный поезд, а не бригады: его строка — по поезду.
      const rail = railTrainStatus(game, i.project.id);
      return rail ? railRowHtml(i, rail, i.project.id === view.project) : projectRowHtml(i, crews.working(i.project.id).length, bases.length > 0, i.project.id === view.project);
    })
    .join('');
  const c = crewCounts(game);
  const baseHead = `<h4 data-tip="Строительные базы: с них бригады едут на стройки по готовым дорогам">${baseSvg(18, 14)} Базы${
    bases.length ? ` <small>${bases.length} · 🚚 ${c.busy} / ${c.all}</small>` : ''
  }</h4>`;
  const hint = !bases.length
    ? `<p class="build-hint">${baseSvg(22, 17)}<span>Поставьте базу у дороги — с неё бригады едут строить. ${
        game.firstBase ? `Первая — бесплатно, следующие — по ${money(CONSTRUCTION.base.cost)}` : `База — ${money(CONSTRUCTION.base.cost)}`
      }</span></p>`
    : '';
  const empty = !list.length
    ? `<p class="build-hint">${buildSvg(22, 17)}<span>Проложите дорогу — она станет проектом, и бригады построят её за время</span></p>`
    : '';
  return `<section class="sc-sec build-sec">${baseHead}<div class="build-head">${baseRows}${hint}${addBaseHtml(game, view.placing)}</div></section>
    <section class="sc-sec build-sec"><h4 data-tip="Проекты стройки: что строится, сколько готово и сколько осталось">${buildSvg(18, 14)} Проекты${
      list.length ? ` <small>${list.length}</small>` : ''
    }</h4>${rows}${empty}</section>`;
}

/**
 * Свёрнутая вкладка «Стройка» — одной строкой: базы, бригады в деле, проекты и общая готовность, «＋ База»
 * (первая бесплатная видна и в свёрнутой панели).
 */
export function buildCompactHtml(game: Game, placing = false): string {
  if (!game.buildMode) return '';
  const list = game.construction.list();
  const c = crewCounts(game);
  const bases = game.construction.crews.bases.size;
  const total = list.reduce((s, i) => s + i.length, 0);
  const done = total ? list.reduce((s, i) => s + i.done * i.length, 0) / total : 0;
  const pct = Math.min(99, Math.floor(done * 100));
  const parts = [
    bases ? `<span class="bc-item" data-tip="Баз: ${bases}">${baseSvg(20, 15)}<b>${bases}</b></span>` : '',
    bases ? `<span class="bc-item" data-tip="Бригады в деле: ${c.busy} из ${c.all}">🚚 <b>${c.busy}</b>/${c.all}</span>` : '',
    list.length
      ? `<span class="bc-item" data-tip="Проектов: ${list.length}, готово ${pct}% (по длине)">${buildSvg(20, 15)}<b>${list.length}</b><span class="bb-bar"><i style="width:${pct}%"></i></span></span>`
      : '',
  ].join('');
  return `<div class="sc-compact build-compact">${parts || '<span class="muted">Строек нет</span>'}${addBaseHtml(game, placing)}</div>`;
}
