/**
 * Интерфейс режима «Строит игрок» (docs/INDUSTRIES.md): панель инструмента «Предприятие», подписи у курсора,
 * строки в карточках предприятия и города, строка «Предприятия» в окне новой игры. Объясняет значками:
 * 👷 рабочие, 🚌 подвоз, ☁ вред, 🏙 место в черте города, ⛏️ месторождение, 🏚 заброшенное, 🏗 стройка.
 */
import { ENTERPRISE } from '../config';
import type { Game } from '../game/game';
import type { IndustryPlan } from '../game/enterprises';
import { money } from '../input/labels';
import { CARGO, type CargoType, INDUSTRY_TYPES, type IndustryKind, type IndustryType } from '../world/cargo';
import { buildCost, freeDeposits, harmClass, harmTo, isRaw, townFor, townSlots, workersNeeded } from '../world/enterprise';
import type { Industry, Town } from '../world/entities';
import { INDUSTRY_MODES, type IndustryMode } from '../world/settings';
import { cargoIcon, townIcon } from './cargoIcons';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Расстояние на карте — в километрах (единица карты — 0,6 м). */
const km = (d: number) => `${(Math.max(0, d) * 0.0006).toFixed(1)} км`;

/** Значок инструмента «Предприятие»: цех с пилообразной крышей и трубой. */
export const INDUSTRY_TOOL_SVG =
  '<svg viewBox="0 0 24 24"><path d="M3 21V12l5 3v-3l5 3v-3l5 3V4h3v17z" /><path d="M6 18h2M11 18h2M16 18h2" /></svg>';

/** Класс вредности значками: ☁ ☁☁ ☁☁☁ (0 — пусто). */
export const harmIcons = (cls: number): string => '☁'.repeat(cls);

/** Размер месторождения точками: ●○○ малое, ●●○ среднее, ●●● богатое. */
export const sizeDots = (size: number): string => '●'.repeat(size + 1) + '○'.repeat(2 - size);
export const SIZE_NAMES = ['малое', 'среднее', 'богатое'];

/** Строка «Предприятия» в окне новой игры: «Строит игрок» / «Готовые». */
export function industryModeRowHtml(mode: IndustryMode | undefined): string {
  const cur = mode ?? 'ready';
  const chip = (v: IndustryMode, ic: string) =>
    `<button class="ng-chip ${v === cur ? 'active' : ''}" data-action="ng-set" data-key="industryMode" data-v="${v}" data-tip="${esc(INDUSTRY_MODES[v].hint)}">${ic} ${INDUSTRY_MODES[v].name}</button>`;
  return `<div class="ng-row"><span class="ng-label">Предприятия</span><div class="ng-options">${chip('player', '🏗')}${chip('ready', '🏭')}</div></div>`;
}

/** Рецепт значками: сырьё → продукция (у добычи — только продукция). */
export function recipeHtml(info: Pick<IndustryType, 'accepts' | 'produces'>, big = 22, small = 16): string {
  const inputs = info.accepts.map((c) => cargoIcon(c, small, false)).join('');
  return info.accepts.length ? `${inputs}<span class="ent-arrow">→</span>${cargoIcon(info.produces, big, false)}` : cargoIcon(info.produces, big, false);
}

/**
 * Панель инструмента «Предприятие»: карточки видов двумя группами — «⛏️ Добыча» и «🏭 Переработка». На карточке —
 * рецепт, цена, 👷 рабочих, ☁ вред, у добычи — ⛏️ свободных месторождений, у завода — значок города, если его
 * продукция нужна городам. Карточки — в две строки с прокруткой вбок; правила — подсказкой у заголовков групп.
 */
export function industryOptionsHtml(g: Game, current: IndustryKind | null): string {
  const kinds = g.enterprises.kinds();
  const wanted = new Set(g.towns.flatMap((t) => t.demands));
  const card = (k: IndustryType) => {
    const cls = harmClass(k.kind);
    const free = isRaw(k) ? freeDeposits(g.enterprises.deposits, k.kind).length : 0;
    const badges = [
      `<span class="ent-b" data-tip="Рабочих в месяц">👷${workersNeeded(k)}</span>`,
      cls ? `<span class="ent-b harm" data-tip="Вредность ${cls} из 3: город ближе ${km(cls * ENTERPRISE.harm.reach)} растёт медленнее">${harmIcons(cls)}</span>` : '',
      isRaw(k) ? `<span class="ent-b ${free ? '' : 'none'}" data-tip="Свободных месторождений">⛏️${free}</span>` : '',
      !isRaw(k) && wanted.has(k.produces) ? `<span class="ent-b town" data-tip="Продукция нужна городам">${townIcon(13, false)}</span>` : '',
    ].join('');
    const tip = `${k.name}: ${isRaw(k) ? 'только на месторождении' : 'на ровном месте'} · ${money(buildCost(k))}`;
    return `<button class="card ent-card ${current === k.kind ? 'active' : ''}" data-action="ind-kind" data-id="${k.kind}" data-tip="${esc(tip)}">
      <span class="ent-recipe">${recipeHtml(k)}</span><span class="name">${esc(k.short)}</span><span class="ent-badges">${badges}</span><span class="ent-price">${money(buildCost(k))}</span></button>`;
  };
  // Правила — подсказкой у заголовка группы: отдельный блок «Как ставить» занимал полпанели.
  const group = (title: string, tip: string, list: IndustryType[]) =>
    list.length
      ? `<div class="ent-group"><div class="opt-title" data-tip="${esc(tip)}">${title}</div><div class="cards ent-cards">${list.map(card).join('')}</div></div>`
      : '';
  const rawTip = 'Добыча встаёт только на свободное месторождение своего сырья: значки ⛏️ на карте';
  const plantTip = `Рабочие сами доходят из городов ближе ${km(ENTERPRISE.commute.near)}, дальше — везите автобусом (без билета). Вредное тормозит рост города рядом. В черте города — по местам (с ${ENTERPRISE.slots.firstPop} жителей)`;
  // Карточки — в две строки; не влезают — прокрутка вбок (колесо мыши тоже листает вбок — Hud, data-hscroll).
  return `<div class="ent-scroll" data-hscroll>${group('⛏️ Добыча', rawTip, kinds.filter(isRaw))}${group(
    '🏭 Переработка <span class="muted">· R — повернуть</span>',
    plantTip,
    kinds.filter((k) => !isRaw(k)),
  )}</div>`;
}

/** Подпись у курсора: что встанет, цена, рабочие, вред городам, место в черте — или почему нельзя. */
export function industryPlanText(g: Game, plan: IndustryPlan): { text: string; ok: boolean; warn?: boolean } {
  const info = INDUSTRY_TYPES[plan.kind];
  if (!plan.ok) return { text: `⛔ ${plan.reason ?? 'Нельзя'}`, ok: false };
  const parts = [`${plan.timed ? '🏗 ' : ''}${info.short}`, money(plan.cost)];
  if (plan.deposit) parts.push(`⛏️ ${sizeDots(plan.deposit.size)}`);
  const s = plan.staff;
  if (s) parts.push(s.local >= 0.999 ? '👷 100%' : `👷 ${pct(s.local)} · 🚌 ${Math.ceil(s.bus)}/мес`);
  if (plan.harm.length) parts.push(`☁ ${plan.harm.map((h) => `${h.town.name} −${pct(h.cut)}`).join(', ')}`);
  if (plan.town && plan.slots) parts.push(`🏙 место ${plan.slots.used + 1} из ${plan.slots.total}`);
  if (plan.demolish.length) parts.push(`снос ${plan.demolish.length} зд.`);
  // Не хватает рабочих или город пострадает — можно, но с оговоркой (жёлтым).
  const warn = (s ? s.local < 0.5 : false) || plan.harm.some((h) => h.cut >= 0.2);
  void g;
  return { text: parts.join(' · '), ok: true, warn };
}

/** Подпись сноса предприятия: возврат или почему нельзя. */
export function industryRemoveText(ind: Industry, plan: { ok: boolean; reason?: string; refund: number }): string {
  if (!plan.ok) return `⛔ ${plan.reason ?? 'Нельзя'}`;
  return `${ind.build ? 'Отменить стройку' : 'Снести'} ${ind.name}${plan.refund ? ` · +${money(plan.refund)}` : ''}`;
}

/** Полоска 0…1 с подписью. */
function bar(share: number, cls = ''): string {
  return `<span class="ent-bar ${cls}"><i style="width:${Math.round(Math.max(0, Math.min(1, share)) * 100)}%"></i></span>`;
}

/**
 * Строки карточки предприятия (режим «Строит игрок»): заброшено (восстановить), стройка, рабочие (откуда, сколько
 * везти автобусом), месторождение, вред городам, место в черте города.
 */
export function industryRowsHtml(g: Game, ind: Industry): string {
  const e = g.enterprises;
  if (!e.on) return '';
  const rows: string[] = [];
  if (ind.ruin) {
    const plan = e.restorePlan(ind);
    rows.push(`<div class="ent-row ruin"><span class="ent-ic">🏚</span><div><b>Заброшено</b><small>Не работает. Восстановить — вдвое дешевле, чем строить</small></div>
      <button class="small ${plan.ok ? 'primary' : 'off'}" data-action="ind-restore" data-id="${ind.id}" data-tip="${esc(plan.ok ? 'Восстановить предприятие' : (plan.reason ?? ''))}">🔧 ${money(plan.cost)}</button></div>`);
  }
  if (ind.build) {
    const stall = e.stalls.get(ind.id);
    const state =
      stall === 'base'
        ? `<span class="bad" data-tip="Стройка стоит: поставьте строительную базу ближе ${km(6000)}">⛔ нет базы</span>`
        : stall === 'money'
          ? '<span class="bad" data-tip="Стройка стоит: не хватает денег">💸</span>'
          : `<span class="muted">⏳ ${Math.ceil((1 - ind.build.done) * ind.build.time)} с</span>`;
    rows.push(`<div class="ent-row"><span class="ent-ic">🏗</span>${bar(ind.build.done)}<b>${Math.floor(ind.build.done * 100)}%</b>${state}</div>`);
  }
  // Рабочие — у работающего (стройка и заброшенное рабочих не берут).
  if (!ind.ruin && !ind.build) {
    const s = e.staffing(ind);
    const share = e.staff(ind);
    if (s) {
      const from = s.from.map((f) => `${esc(g.towns.find((t) => t.id === f.town)?.name ?? '')} ${Math.round(f.n)}`).join(', ');
      const crew = Math.round(ind.crew ?? 0);
      const detail = [from && `🚶 ${from}`, crew ? `🚌 ${crew}` : ''].filter(Boolean).join(' · ');
      const tip = `Рабочих нужно ${s.need} в месяц: сами приходят из городов ближе ${km(ENTERPRISE.commute.near)}, дальше — меньше. Производство — по рабочим`;
      rows.push(`<div class="ent-row" data-tip="${esc(tip)}"><span class="ent-ic">👷</span>${bar(share, share < 0.5 ? 'bad' : share < 0.999 ? 'warn' : '')}<b>${pct(share)}</b><small>${detail || '—'}</small></div>`);
      const missing = Math.max(0, s.bus - (ind.crew ?? 0));
      if (missing > 0.5 && !ind.build)
        rows.push(`<div class="ent-row hint"><span class="ent-ic">🚌</span><small>Не хватает ${Math.ceil(missing)} в месяц — пассажирский маршрут из города на станцию у предприятия; проезд рабочих не оплачивается</small></div>`);
    }
  }
  const dep = e.depositOf(ind);
  if (dep) rows.push(`<div class="ent-row" data-tip="Размер месторождения: добыча ×${ENTERPRISE.deposits.sizes[dep.size].k}"><span class="ent-ic">⛏️</span><b class="dots">${sizeDots(dep.size)}</b><small>${SIZE_NAMES[dep.size]} · добыча ×${ENTERPRISE.deposits.sizes[dep.size].k}</small></div>`);
  const cls = harmClass(ind.info.kind);
  if (cls) {
    const hit = g.towns.flatMap((t) => {
      const cut = harmTo(t, ind.info.kind, ind.fp);
      return cut > 0 ? [`${esc(t.name)} −${pct(cut)}`] : [];
    });
    // Заброшенное и стройка не вредят — вред будет, когда заработает.
    const when = ind.ruin || ind.build ? 'когда заработает — ' : '';
    rows.push(
      `<div class="ent-row" data-tip="Вредность ${cls} из 3: города ближе ${km(cls * ENTERPRISE.harm.reach)} растут медленнее"><span class="ent-ic harm">${harmIcons(cls)}</span><small>${
        hit.length ? `${when}рост: ${hit.join(', ')}` : 'города далеко — не мешает'
      }</small></div>`,
    );
  }
  const town = townFor(g.towns, ind.fp);
  if (town) rows.push(`<div class="ent-row"><span class="ent-ic">🏙</span><small>в черте города ${esc(town.name)}${ind.builtBy === 'town' ? ' · построил город' : ''}</small></div>`);
  return rows.length ? `<div class="ent-rows">${rows.join('')}</div>` : '';
}

/** Каким видом завода сделать груз c (первый, что можно построить; на одно сырьё — раньше). */
export function plantFor(g: Game, c: CargoType): IndustryType | null {
  const list = g.enterprises.kinds().filter((k) => !isRaw(k) && k.produces === c);
  return list.sort((a, b) => a.accepts.length - b.accepts.length)[0] ?? null;
}

/**
 * Строки карточки города (режим «Строит игрок»): места в черте (занятые — значком продукции, свободные — ＋ с
 * таймером постройки самим городом), рабочие и множитель роста, вред, «🏗» — построить завод для потребности,
 * которую на карте никто не делает.
 */
export function townRowsHtml(g: Game, t: Town): string {
  const e = g.enterprises;
  if (!e.on) return '';
  const info = e.townInfo(t);
  const rows: string[] = [];
  const total = townSlots(t);
  const used = info.inside
    .map((i) => `<span class="ent-slot used" data-tip="${esc(i.name)}">${cargoIcon(i.info.produces, 18, false)}</span>`)
    .join('');
  const left = Math.max(0, ENTERPRISE.slots.idleMonths - (t.slotIdle ?? 0));
  const free = Array.from({ length: Math.max(0, total - info.inside.length) }, () => `<span class="ent-slot free" data-tip="Свободно: можно поставить завод, а пустует — через ${left} мин город построит сам">＋</span>`).join('');
  rows.push(
    `<div class="ent-row" data-tip="Мест под предприятия в черте города: по населению, первое — с ${ENTERPRISE.slots.firstPop} жителей"><span class="ent-ic">🏙</span>${
      total ? `${used}${free}` : `<small>мест нет — с ${ENTERPRISE.slots.firstPop} жителей</small>`
    }</div>`,
  );
  const jobs = info.pool > 0 ? Math.min(1, info.employed / info.pool) : 0;
  rows.push(
    `<div class="ent-row" data-tip="Рабочих в месяц: заняты на предприятиях из тех, что город может отдать. Занятость ускоряет рост"><span class="ent-ic">👷</span>${bar(jobs)}<b>${Math.round(info.employed)}/${Math.round(info.pool)}</b><small>рост ×${info.growth.toFixed(2)}</small></div>`,
  );
  if (info.harm.length)
    rows.push(
      `<div class="ent-row bad" data-tip="Вредные предприятия рядом тормозят рост города"><span class="ent-ic harm">☁</span><b>−${pct(Math.min(1, info.harmTotal))}</b><small>${info.harm
        .slice(0, 2)
        .map((h) => esc(h.ind.info.short))
        .join(', ')}</small></div>`,
    );
  // Потребность, которую на карте никто не делает, — «🏗» выбирает инструмент с этим заводом.
  const live = g.industries.filter((i) => !i.ruin);
  const build = t.demands
    .filter((c) => !live.some((i) => i.info.produces === c))
    .flatMap((c) => {
      const k = plantFor(g, c);
      return k ? [`<button class="ent-build" data-action="ind-build-for" data-id="${k.kind}" data-tip="${esc(`Никто не делает «${CARGO[c].name}» — построить ${k.name.toLowerCase()}`)}">🏗${cargoIcon(c, 16, false)}</button>`] : [];
    })
    .join('');
  if (build) rows.push(`<div class="ent-row"><span class="ent-ic">🏗</span><small>построить:</small>${build}</div>`);
  return `<div class="ent-rows">${rows.join('')}</div>`;
}
