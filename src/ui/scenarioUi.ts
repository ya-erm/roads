/**
 * Разметка режима «Сценарий»: левая панель вкладками (сценарий, события и контракты, стройка), брифинг перед стартом,
 * итоговый экран и часть экрана новой игры. Здесь только чтение состояния — клики по data-action
 * обрабатывает Hud. Объясняем картинками: значки заданий и грузов, полоски, медали; текст — подписи и title.
 */
import { ECONOMY, MONTH_LENGTH } from '../config';
import { clockText, durationText, leftText } from '../core/timeText';
import type { Game } from '../game/game';
import { isIndustry, resolve } from '../scenario/analysis';
import { ARCHETYPE_LIST, CHALLENGE_BONUS, DIFFICULTY, EVENT_INFO, LATE, MEDALS, PHASES, REPUTATION } from '../scenario/content';
import { isActive } from '../scenario/events';
import { type Forecast, forecastTip } from '../scenario/forecast';
import { fastBonus, isOverdue, lateMonths, lateReward, type Scenario } from '../scenario/manager';
import {
  closedNeeds,
  failText,
  fraction,
  isMonthly,
  monthGauge,
  monthNow,
  monthValue,
  progressText,
  rewardText,
  type MonthGauge,
} from '../scenario/objectives';
import { CARGO } from '../world/cargo';
import { townNeed } from '../world/townSupply';
import type { ScenarioRecord } from '../scenario/records';
import type { Difficulty, EventRecord, Objective, Ref, ScenarioSettings, ScoreLine } from '../scenario/types';
import { cargoIcon, townIcon } from './cargoIcons';
import { buildCompactHtml, buildSvg, buildTabCount, buildTabHtml, NO_BUILD_VIEW, type BuildView } from './constructionUi';
import { chevronSvg, journalSvg, ledgerIcon, playSvg } from './icons';
import {
  archetypeSvg,
  boltIcon,
  calendarSvg,
  coinIcon,
  contractSvg,
  diceMapSvg,
  difficultySvg,
  distanceSvg,
  factoryIcon,
  flagSvg,
  growthIcon,
  limitSvg,
  MEDAL_NAMES,
  medalSvg,
  newsSvg,
  objectiveIcon,
  replaySvg,
  reputationSvg,
  sandboxSvg,
  scenarioModeSvg,
  stopwatchSvg,
} from './scenarioIcons';
import { randomCardHtml } from './newGame';
import { timelapseItemHtml } from './timelapseButton';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;
const num = (n: number) => Math.round(n).toLocaleString('ru-RU');

/** «запись / записи / записей» — по числу записей журнала. */
function entriesWord(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return 'запись';
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'записи';
  return 'записей';
}
const LETTERS = 'ABC';

/** Крупные суммы коротко: «$1 млн», «$250 тыс.». */
export function shortMoney(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)} тыс.`;
  return money(n);
}

/**
 * Сколько осталось до срока: у задания — спокойно, целыми минутами («5 мин», последнюю минуту — «59 сек»,
 * leftText), у предложения контракта — таймером «3:20» (clockText). Меньше стольких секунд — красным: задание —
 * 4 мин, предложение контракта — 2 мин, плашка предложения вверху — минута.
 */
const URGENT = { goal: 240, offer: 120, banner: 60 };
const urgent = (left: number, limit: number) => (left < limit ? ' urgent' : '');

/** Срок в месяцах (условия контракта, длина этапа) — минутами: «6 мин». */
const monthsSpan = (months: number) => durationText(months * MONTH_LENGTH);

/** Последствие события растёт или падает: «+20%» — вверх, «-30%» — вниз. */
const trend = (text: string) => (/\+\d/.test(text) ? 'up' : /[-−]\d/.test(text) ? 'down' : '');

/** Заголовок события без значка в начале: значок уже показан рядом отдельным элементом (`sc-ev-ic`). */
function eventTitle(e: EventRecord): string {
  const prefix = `${EVENT_INFO[e.type].icon} `;
  return e.title.startsWith(prefix) ? e.title.slice(prefix.length) : e.title;
}

/** Города и предприятия задания или события; links — кнопками «показать на карте», иначе подписью (в окнах). */
function placeChips(g: Game, refs: Ref[], links = true): string {
  const chips = refs
    .map((r) => {
      const place = resolve(g, r);
      if (!place) return '';
      const icon = isIndustry(place) ? cargoIcon(place.info.produces, 16, false) : townIcon(16);
      const attrs = links ? ` data-action="focus" data-type="${r.type}" data-id="${r.id}" title="Показать на карте"` : '';
      const tag = links ? 'button' : 'span';
      return `<${tag} class="ind-chip ${r.type === 'town' ? 'town' : ''}"${attrs}>${icon}${esc(place.name)}</${tag}>`;
    })
    .join('');
  return chips ? `<div class="sc-chips">${chips}</div>` : '';
}

interface ObjectiveView {
  /** Строка в панели: клик раскрывает «почему», города — кнопками. */
  panel?: boolean;
  /** Показать «почему» текстом под полоской. */
  why?: boolean;
  /** Свёрнуто в компактную строку (только в панели): значок, название, полоска, прогресс и срок. */
  folded?: boolean;
  /** Ещё не начато (брифинг): без пустой полоски и «0 / N» — срок, награда, «почему» и места. */
  plan?: boolean;
}

/** Свёрнуто ли задание в панели: как выбрал игрок, а иначе выполненные свёрнуты сами. */
export function isFolded(o: Objective): boolean {
  return o.folded ?? o.status === 'done';
}

/**
 * Свернуть или развернуть задание в панели. Выбор хранится в задании (и в сохранении партии), но только
 * если он не совпадает с обычным: так свёрнутое или развёрнутое до выполнения задание свернётся,
 * когда его выполнят, а развёрнутое после — останется развёрнутым.
 */
export function toggleFold(o: Objective): void {
  const next = !isFolded(o);
  if (next === (o.status === 'done')) delete o.folded;
  else o.folded = next;
}

/** Остаток срока задания — «5 мин», последнюю минуту — «59 сек»: красным — меньше 4 минут, ∞ — без срока; закрытое — пусто. */
function timeHtml(sc: Scenario, o: Objective): string {
  if (o.status === 'done' && o.quick) return '<span class="sc-fast done" data-tip="Выполнено к быстрому сроку: надбавка и очки за быстроту">⚡</span>';
  if (o.status === 'done' && o.late) return `<span class="sc-late done" data-tip="${esc(`Выполнено с опозданием: награда и очки ${LATE_CUT}`)}">⌛</span>`;
  if (o.status !== 'active') return '';
  const left = sc.secondsLeft(o);
  if (isOverdue(o) && left !== null) {
    const tip = `Срок вышел — задание просрочено. Ещё можно выполнить с опозданием: награда и очки ${LATE_CUT}. Не успеете и к этому сроку: ${failText(o)}`;
    return `<span class="sc-late" data-tip="${esc(tip)}">⌛ ${leftText(left)}</span>`;
  }
  const main =
    left !== null
      ? `<span class="sc-left${urgent(left, URGENT.goal)}" data-tip="Осталось до срока">⏳ ${leftText(left)}</span>`
      : '<span class="sc-left" data-tip="Без срока">⏳ ∞</span>';
  return fastHtml(sc, o) + main;
}

/** Быстрый срок, пока он не прошёл: ⚡ и сколько осталось; подсказка — что дают за него. */
function fastHtml(sc: Scenario, o: Objective): string {
  const left = sc.fastLeft(o);
  if (left === null) return '';
  const bonus = fastBonus(o);
  const tip = `Быстрый срок — необязательный. Успеете: ${bonus ? `+$${bonus.toLocaleString('ru-RU')} к награде и ` : ''}очки за быстроту`;
  return `<span class="sc-fast" data-tip="${esc(tip)}">⚡ ${leftText(left)}</span>`;
}

/** На сколько меньше награда за выполненное с опозданием: «−50%». */
const LATE_CUT = `−${Math.round((1 - LATE.reward) * 100)}%`;

/** Чем обернётся невыполненный срок: просрочка (сколько минут и во что обойдётся) или сразу провал. */
function missText(o: Objective): string {
  const late = lateMonths(o);
  return late !== null ? `⌛ ещё ${monthsSpan(late)} можно доделать с опозданием (награда ${LATE_CUT}), потом — ${failText(o)}` : failText(o);
}

/** Награда задания: у просроченного и выполненного с опозданием — урезанная, с меткой «−50%». */
function rewardHtml(o: Objective): string {
  if (!isOverdue(o) && !(o.status === 'done' && o.late)) return `<span class="sc-reward" title="Награда">🎁 ${esc(rewardText(o))}</span>`;
  const tip = `Награда с опозданием: ${LATE_CUT} денег и репутации (было ${rewardText(o)})`;
  return `<span class="sc-reward" data-tip="${esc(tip)}">🎁 <b class="sc-late-cut">${LATE_CUT}</b> ${esc(rewardText({ ...o, reward: lateReward(o) }))}</span>`;
}

/** Размер значка задания в панели — один для свёрнутых и развёрнутых. */
const OBJECTIVE_ICON = 26;

/**
 * Шкала месячного задания (перевозить N в месяц, прибыль, снабжение…) — по показателю идущего месяца:
 * засчитывается календарный месяц, и полоска показывает, сколько уже набрано. У остальных — null.
 */
function gaugeOf(sc: Scenario, o: Objective): MonthGauge | null {
  return o.status === 'active' && isMonthly(o.params) ? monthGauge(o.params, monthNow(sc.game, sc.state, o.params)) : null;
}

const pct = (f: number) => (f * 100).toFixed(1);

/**
 * Шкала задания: заполненная часть — сделано; у накопительных со сроком дальше — полупрозрачная синяя до прогноза
 * к сроку (`Scenario.forecast`), успеваем — синяя до конца и ✓ за шкалой; прогноз — в подсказке.
 */
function barHtml(fill: number, fc: Forecast | null): string {
  const ahead = fc ? Math.max(0, fc.fraction - fill) : 0;
  const bar = `<div class="bar sc-bar"><div style="width:${pct(fill)}%"></div>${ahead > 0 ? `<i class="sc-fc" style="width:${pct(ahead)}%"></i>` : ''}</div>`;
  if (!fc) return bar;
  return `<div class="sc-track" data-tip="${esc(forecastTip(fc))}">${bar}${fc.reach ? '<span class="sc-fc-ok">✓</span>' : ''}</div>`;
}

/** Месяцы подряд у месячного задания — точками: ●●○ — выполнено 2 из 3. Хватает одного месяца — без точек. */
function streakHtml(o: Objective): string {
  if (o.status !== 'active' || !isMonthly(o.params) || o.target <= 1) return '';
  const dots = Array.from({ length: o.target }, (_, i) => `<i class="${i < o.progress ? 'on' : ''}"></i>`).join('');
  return `<span class="sc-streak" data-tip="Месяцев подряд выполнено: ${o.progress} из ${o.target}">${dots}</span>`;
}

/**
 * Прогресс задания под полоской: у месячных — показатель этого месяца («312 / 470 ед.»), второе условие
 * (в развёрнутом виде) и месяцы подряд точками; у остальных — «120 / 300», «×1.5 / ×2».
 */
function progressHtml(o: Objective, gauge: MonthGauge | null, full: boolean): string {
  if (!gauge) return `<b>${progressText(o)}</b>`;
  const extra = full && gauge.extra ? `<span class="sc-cond ${gauge.extra.ok ? 'ok' : 'bad'}">${esc(gauge.extra.text)}</span>` : '';
  const tip = 'Набрано в этом месяце. Засчитывается месяц, к концу которого условие выполнено';
  return `<b data-tip="${tip}">${esc(gauge.text)}</b>${full ? '<span class="sc-month">в этом месяце</span>' : ''}${extra}${streakHtml(o)}`;
}

/**
 * Задание: значок по типу, заголовок (★ — главная цель, свиток — контракт, ❗ — критическое),
 * полоска выполнения, прогресс, остаток срока (красным — меньше 2 месяцев), награда.
 * У месячных — как прошёл последний месяц.
 */
export function objectiveHtml(g: Game, sc: Scenario, o: Objective, view: ObjectiveView = {}): string {
  const active = o.status === 'active';
  const months = sc.state.stats.months;
  const now = active && isMonthly(o.params) ? monthValue(o.params, g, months[months.length - 1]) : null;
  const role =
    o.role === 'main'
      ? '<span class="sc-role" title="Главная цель этапа">★</span>'
      : o.role === 'contract'
        ? contractSvg(16)
        : o.role === 'extra'
          ? '<span class="sc-role extra" data-tip="Дополнительное задание: без срока, на медаль не влияет">✚</span>'
          : '';
  const crit = o.critical ? `<span class="sc-crit" title="Критическое задание. Если не успеть: ${esc(failText(o))}">❗</span>` : '';
  const state =
    o.status === 'done'
      ? '<span class="sc-state done" title="Выполнено">✓</span>'
      : o.status === 'failed'
        ? '<span class="sc-state failed" title="Не выполнено">✗</span>'
        : '';
  const time = timeHtml(sc, o);
  const overdue = isOverdue(o);
  const miss = overdue ? `\nСрок вышел. Не успеете с опозданием: ${failText(o)}` : `\nЕсли не успеть: ${missText(o)}`;
  const tip = `${o.why}${active && !o.critical && o.deadline !== null ? miss : ''}`;
  // У месячных полоска — по показателю этого месяца, а не по числу месяцев подряд (их показывают точки).
  const gauge = view.plan ? null : gaugeOf(sc, o);
  // Накопительные со сроком — с прогнозом к сроку за выполненной частью.
  const bar = barHtml(gauge ? gauge.fraction : fraction(o), view.plan || gauge ? null : sc.forecast(o));
  const cls = `sc-obj ${o.role} ${o.status} ${o.critical ? 'critical' : ''}${overdue ? ' overdue' : ''}`;
  // Свёрнутая — две строки: название в одну строку и полоска с прогрессом и сроком; клик разворачивает.
  // Значок — того же размера, что у развёрнутой: две строки его вмещают.
  if (view.panel && view.folded) {
    return `<div class="${cls} folded" data-action="sc-fold" data-id="${o.id}" title="${esc(`${o.title}\n${tip}`)}">
      <span class="sc-obj-ic">${objectiveIcon(o, OBJECTIVE_ICON)}</span>
      <div class="sc-obj-body">
        <div class="sc-obj-title">${role}<span class="sc-obj-name">${esc(o.title)}</span>${crit}${state}<span class="sc-fold" title="Развернуть"><span class="caret closed">${chevronSvg()}</span></span></div>
        <div class="sc-meta">${bar}${progressHtml(o, gauge, false)}${time}</div>
      </div></div>`;
  }
  const action = view.panel ? ` data-action="sc-why" data-id="${o.id}"` : '';
  const fold = view.panel ? `<button class="sc-fold" data-action="sc-fold" data-id="${o.id}" title="Свернуть"><span class="caret">${chevronSvg()}</span></button>` : '';
  return `<div class="${cls}"${action} title="${esc(tip)}">
    <span class="sc-obj-ic">${objectiveIcon(o, OBJECTIVE_ICON)}</span>
    <div class="sc-obj-body">
      <div class="sc-obj-title">${role}<span class="sc-obj-name">${esc(o.title)}</span>${crit}${state}${fold}</div>
      ${view.plan ? '' : bar}
      <div class="sc-meta">${view.plan ? '' : progressHtml(o, gauge, true)}${time}${rewardHtml(o)}</div>
      ${needsHtml(g, o)}
      ${now ? `<small class="sc-now">${esc(now)}</small>` : ''}
      ${view.why ? `<p class="sc-why">${esc(o.why)}</p>` : ''}
      ${placeChips(g, o.related, !!view.panel)}
    </div></div>`;
}

/**
 * Потребности города у задания «снабжать»: значки грузов, закрытые в этом месяце — яркие, остальные — бледные;
 * в подсказке — сколько уже привезли. Сколько закрыто из нужных — в подписи шкалы (monthGauge).
 */
function needsHtml(g: Game, o: Objective): string {
  const p = o.params;
  if (p.kind !== 'supply' || o.status !== 'active') return '';
  const t = g.towns.find((x) => x.id === p.town);
  if (!t?.demands.length) return '';
  const closed = new Set(closedNeeds(t, 'current'));
  const need = townNeed(t.population);
  const icons = t.demands.map((c) => {
    const got = Math.min(need, Math.round(t.supplied[c] ?? 0));
    return `<span class="sc-need${closed.has(c) ? ' ok' : ''}" data-tip="${esc(`${CARGO[c].name}: ${got} из ${need} в этом месяце`)}">${cargoIcon(c, 18, false)}</span>`;
  });
  // Сколько закрыто из нужных — в подписи шкалы над значками.
  return `<div class="sc-needs">${icons.join('')}</div>`;
}

/** Этапы A → B → C: пройденные с галочкой, текущий выделен. */
function stepsHtml(sc: Scenario): string {
  const s = sc.state;
  const steps = PHASES.map((p, i) => {
    const done = i < s.phase || s.status === 'won';
    const now = i === s.phase && s.status !== 'won';
    const cls = done ? 'done' : now ? (s.status === 'lost' ? 'lost' : 'now') : '';
    // Этап A «Со строительством» — с запасом на стройку дорог: прежний срок у его целей — быстрый (⚡).
    const build = i === 0 ? (s.brief.build ?? 0) : 0;
    const months = Math.round(p.months * sc.difficulty.time) + build;
    const span = build ? `${monthsSpan(months)} (🚧 +${monthsSpan(build)} на стройку, ⚡ — за ${monthsSpan(months - build)})` : monthsSpan(months);
    return `<div class="sc-step ${cls}" data-tip="Этап ${LETTERS[i]} «${p.name}», около ${span}. ${p.hint}">
      <b>${done ? '✓' : s.status === 'lost' && now ? '✗' : LETTERS[i]}</b><small>${p.short}</small></div>`;
  });
  return `<div class="sc-steps">${steps.join('<i class="sc-step-line"></i>')}</div>`;
}

/** Репутация 0–100 маленькой шкалой: от неё зависят награды контрактов. */
function reputationHtml(sc: Scenario): string {
  const r = Math.round(sc.state.reputation);
  const tip = `Репутация ${r} из 100. Выполненные задания поднимают её, сорванные и отказы от контрактов — снижают. От неё зависят награды новых контрактов: сейчас ×${sc.rewardFactor.toFixed(2)}`;
  return `<div class="sc-rep" title="${tip}">${reputationSvg(18)}<span class="sc-rep-scale"><i style="left:${r}%"></i></span><b>${r}</b></div>`;
}

/** Подсказка к «Отказаться»: чем обойдётся отказ. */
function declineTip(o: Objective): string {
  const worse = o.fail.effects?.length || o.fail.follow?.length ? ', а экономика региона пойдёт по худшему пути' : '';
  return `Отказ: репутация ${REPUTATION.declined}${worse}`;
}

/** Быстрый срок в условиях контракта: через сколько минут после принятия и что за него дают. */
function offerFastHtml(o: Objective): string {
  if (o.fastMonths === undefined) return '';
  const bonus = fastBonus(o);
  const tip = `Быстрый срок — необязательный, с момента, как примете. Успеете: ${bonus ? `+$${bonus.toLocaleString('ru-RU')} к награде и ` : ''}очки за быстроту`;
  return `<span class="sc-fast" data-tip="${esc(tip)}">⚡ ${monthsSpan(o.fastMonths)}</span>`;
}

/** Срок контракта после принятия — минутами. */
const termHtml = (o: Objective) =>
  o.months !== undefined ? `<span data-tip="Срок на выполнение — с момента, как примете">⏳ ${monthsSpan(o.months)}</span>` : '';

/** Сколько ещё действует предложение — «м:сс»; меньше limit секунд — красным. */
const offerLeftHtml = (left: number, limit: number) =>
  `<span class="sc-left${urgent(left, limit)}" data-tip="Предложение действует ещё, мин:сек">⌛ ${clockText(left)}</span>`;

/** Условия контракта и решение: награда, срок после принятия, цена провала, сколько осталось думать. */
function offerHtml(sc: Scenario, o: Objective): string {
  const left = sc.secondsLeft(o);
  return `<div class="sc-offer">
    <div class="sc-terms">
      <span title="Награда">🎁 ${esc(rewardText(o))}</span>
      ${termHtml(o)}
      ${offerFastHtml(o)}
      <span class="sc-fail" data-tip="${esc(`Если принять и не успеть: ${missText(o)}`)}">⚠ ${esc(failText(o))}</span>
    </div>
    <div class="sc-offer-actions">
      <button class="small primary" data-action="sc-accept" data-id="${o.id}" title="Срок пойдёт с этой минуты">✓ Принять</button>
      <button class="small" data-action="sc-decline" data-id="${o.id}" title="${declineTip(o)}">✕ Отказаться</button>
      ${left !== null ? offerLeftHtml(left, URGENT.offer) : ''}
    </div></div>`;
}

/** Предложения на решение: самое срочное — первым. */
function offersByUrgency(sc: Scenario): Objective[] {
  return [...sc.offers].sort((a, b) => (sc.secondsLeft(a) ?? 1e9) - (sc.secondsLeft(b) ?? 1e9));
}

/**
 * Значки городов и предприятий кнопками: клик подводит камеру к месту и открывает его панель
 * (действие `focus` — как у плашек мест в панели сценария). Одно и то же место — один раз.
 */
function placeIcons(g: Game, refs: Ref[]): string {
  const seen = new Set<string>();
  return refs
    .map((r) => {
      const key = `${r.type}:${r.id}`;
      const place = seen.has(key) ? undefined : resolve(g, r);
      seen.add(key);
      if (!place) return '';
      const icon = isIndustry(place) ? cargoIcon(place.info.produces, 20, false) : townIcon(20);
      return `<button class="ob-place" data-action="focus" data-type="${r.type}" data-id="${r.id}" title="${esc(place.name)} — показать на карте">${icon}</button>`;
    })
    .join('');
}

/**
 * Плашка предложения вверху экрана — уведомление о предложениях на вкладке «События» левой панели (решают там же):
 * самое срочное предложение, остальные — счётчиком. Значки городов и предприятий — переход к ним на карте;
 * клик по названию или счётчику открывает вкладку «События» и подсвечивает предложение. Меньше минуты на решение — подсвечена.
 */
export function offerBannerHtml(g: Game): string {
  const sc = g.scenario;
  if (!sc?.running) return '';
  const offers = offersByUrgency(sc);
  const o = offers[0];
  if (!o) return '';
  const left = sc.secondsLeft(o) ?? 0;
  const more =
    offers.length > 1
      ? `<button class="small ob-more" data-action="sc-offer-show" data-tip="Все предложения (${offers.length}) — на вкладке «События»">+${offers.length - 1}</button>`
      : '';
  // Мест нет (задание не о городе и не о предприятии) — просто значок задания.
  const places = placeIcons(g, o.related) || `<span class="ob-obj">${objectiveIcon(o, 22)}</span>`;
  return `<div class="offer-banner-in${urgent(left, URGENT.banner)}">
    <span class="ob-ic" title="Контракт ждёт решения">${contractSvg(18)}</span>
    <span class="ob-places">${places}</span>
    <button class="ob-title" data-action="sc-offer-show" data-id="${o.id}" data-tip="${esc(o.title)}. ${esc(o.why)} Принять или отказаться — на вкладке «События»"><span>${esc(o.title)}</span></button>
    <span class="ob-terms"><span title="Награда">🎁 ${esc(rewardText(o))}</span>${termHtml(o)}${offerFastHtml(o)}</span>
    ${offerLeftHtml(left, URGENT.offer)}${more}</div>`;
}

/**
 * Предложения контрактов — первым разделом вкладки «События» (и в свёрнутой панели на любой вкладке): событие и его контракт —
 * одной карточкой. Сверху — что случилось (значок события, заголовок, когда), под ним — задание и решение.
 * Самое срочное — первым; меньше минуты на решение — подсвечено. Клик по заголовку раскрывает подробности:
 * причину, последствия и связанные места. Вверху экрана о самом срочном напоминает плашка (`offerBannerHtml`).
 */
export function offersSectionHtml(g: Game, open: ReadonlySet<string>): string {
  const sc = g.scenario;
  if (!sc?.running) return '';
  const offers = offersByUrgency(sc);
  if (!offers.length) return '';
  const cards = offers.map((o) => {
    const left = sc.secondsLeft(o) ?? 0;
    const shown = open.has(o.id);
    const ev = o.source ? sourceEvent(sc, o.source) : undefined;
    const evLine = ev
      ? `<div class="of-event ${ev.importance}"><span class="sc-ev-ic">${EVENT_INFO[ev.type].icon}</span><span>${esc(eventTitle(ev))}</span><small>${agoText(sc, ev)}</small></div>`
      : '';
    const effects = ev?.effects.map((t) => `<li class="${trend(t)}">${esc(t)}</li>`).join('') ?? '';
    const detail = shown
      ? `<p class="sc-cause">${esc(ev?.cause ?? o.why)}</p>${effects ? `<ul class="sc-effects">${effects}</ul>` : ''}${placeChips(g, ev ? ev.related : o.related)}`
      : '';
    return `<div class="sc-card offer of-card${urgent(left, URGENT.banner)}" data-offer="${o.id}">
      <div class="of-head" data-action="sc-why" data-id="${o.id}" data-tip="${shown ? 'Скрыть подробности' : esc(ev?.cause ?? o.why)}">
        ${evLine}<div class="sc-card-head">${objectiveIcon(o, 24)}<b>${esc(o.title)}</b><span class="caret ${shown ? '' : 'closed'}">${chevronSvg()}</span></div></div>
      ${detail}
      ${offerHtml(sc, o)}</div>`;
  });
  return `<section class="sc-sec sc-offers"><h4>${contractSvg(14)} Предложения <span class="sc-badge">${offers.length}</span></h4>${cards.join('')}</section>`;
}

/** Событие, предложившее контракт. */
const sourceEvent = (sc: Scenario, id: string) => sc.state.events.find((e) => e.id === id);

/** Предложение контракта без события (стартовый контракт): задание, почему, кто связан, условия. */
function offerCardHtml(g: Game, sc: Scenario, o: Objective, links = true): string {
  return `<div class="sc-card offer">
    <div class="sc-card-head">${objectiveIcon(o, 24)}<b>${esc(o.title)}</b></div>
    <p class="sc-cause">${esc(o.why)}</p>
    ${placeChips(g, o.related, links)}
    ${offerHtml(sc, o)}</div>`;
}

const CONTRACT_STATE: Record<Objective['status'], string> = {
  offered: 'ждёт решения',
  active: 'контракт принят',
  done: 'контракт выполнен',
  failed: 'контракт сорван',
  declined: 'от контракта отказались',
};

const agoText = (sc: Scenario, e: EventRecord) => (sc.month - e.month <= 0 ? 'сейчас' : `${monthsSpan(sc.month - e.month)} назад`);

/**
 * Прошедшее событие — приглушённой строкой: значок, заголовок, когда. Клик разворачивает причину,
 * последствия, статус контракта и связанные места (кнопками — показать на карте).
 */
function pastEventHtml(g: Game, sc: Scenario, e: EventRecord, open: boolean): string {
  const contract = e.contract ? sc.objective(e.contract) : undefined;
  const effects = e.effects.map((t) => `<li class="${trend(t)}">${esc(t)}</li>`).join('');
  const head = `<div class="sc-past ${open ? 'open' : ''}" data-action="sc-past" data-id="${e.id}" title="Нажмите, чтобы посмотреть подробности">
    <span class="sc-ev-ic">${EVENT_INFO[e.type].icon}</span><span>${esc(eventTitle(e))}</span>${
      contract ? `<span class="sc-state ${contract.status}">${contract.status === 'done' ? '✓' : contract.status === 'failed' ? '✗' : '–'}</span>` : ''
    }<small>${agoText(sc, e)}</small>${chevronSvg()}</div>`;
  if (!open) return head;
  const state = contract
    ? `<div class="sc-offer-state ${contract.status}" title="${esc(contract.title)}">${contractSvg(14)}<span>${esc(contract.title)}: ${CONTRACT_STATE[contract.status]}</span></div>`
    : '';
  return `${head}<div class="sc-past-detail">
    <p class="sc-cause">${esc(e.cause)}</p>
    ${effects ? `<ul class="sc-effects">${effects}</ul>` : ''}
    ${placeChips(g, e.related)}
    ${state}</div>`;
}

/** Событие: значок и заголовок, причина, последствия (▲/▼), связанные места; контракт — с решением. */
function eventHtml(g: Game, sc: Scenario, e: EventRecord): string {
  const info = EVENT_INFO[e.type];
  const when = agoText(sc, e);
  const contract = e.contract ? sc.objective(e.contract) : undefined;
  const effects = e.effects.map((t) => `<li class="${trend(t)}">${esc(t)}</li>`).join('');
  // Само предложение с кнопками — в панели предложений внизу, здесь только его состояние.
  const offer = contract
    ? `<div class="sc-offer-state ${contract.status}" title="${esc(contract.title)}">${contractSvg(14)}<span>${CONTRACT_STATE[contract.status]}</span></div>`
    : '';
  return `<div class="sc-card event ${e.importance}">
    <div class="sc-card-head"><span class="sc-ev-ic" title="${info.name}">${info.icon}</span><b>${esc(eventTitle(e))}</b><small>${when}</small></div>
    <p class="sc-cause">${esc(e.cause)}</p>
    ${effects ? `<ul class="sc-effects">${effects}</ul>` : ''}
    ${placeChips(g, e.related)}
    ${offer}</div>`;
}

/** Дополнительные задания после победы (без сроков, на оценку не влияют). */
const extrasOf = (sc: Scenario) => sc.state.objectives.filter((o) => o.role === 'extra' && (o.status === 'active' || o.status === 'done'));

/** Дополнительные задания в панели после победы: открытые и выполненные. */
function extrasHtml(g: Game, sc: Scenario, view: PanelView): string {
  const list = extrasOf(sc);
  if (!list.length) return '';
  const done = list.filter((o) => o.status === 'done').length;
  const rows = list.map((o) => objectiveHtml(g, sc, o, { panel: true, why: view.open.has(o.id), folded: isFolded(o) })).join('');
  return `<section class="sc-sec sc-extras"><h4 data-tip="Без сроков и на медаль не влияют — только деньги">✚ Дополнительные задания <small>${done} / ${list.length}</small></h4>${rows}</section>`;
}

/** Итог в панели после конца сценария: медаль, очки и кнопка к итоговому экрану. */
function finishedHtml(sc: Scenario): string {
  const score = sc.state.score;
  if (!score) return '';
  const next = extrasOf(sc).some((o) => o.status === 'active') ? 'дальше — дополнительные задания' : 'дальше — песочница';
  return `<section class="sc-sec sc-final">${medalSvg(score.medal, 34)}
    <div><b>${num(score.total)}</b> очков<small>${sc.state.status === 'won' ? 'Сценарий пройден' : 'Сценарий провален'} · ${next}</small></div>
    <button class="small" data-action="sc-results" title="Итоговый экран: оценка по показателям и задания">Итоги</button></section>`;
}

/** Главная цель текущего этапа (последняя — восстановительная попытка, если была). */
function mainObjective(sc: Scenario): Objective | undefined {
  const s = sc.state;
  return s.objectives.filter((o) => o.phase === s.phase && o.role === 'main' && o.status === 'active').pop();
}

/** Свёрнутая панель: буква этапа и полоска главной цели со сроком. */
function compactHtml(sc: Scenario): string {
  const main = mainObjective(sc);
  const letter = `<b class="sc-letter" title="Этап ${LETTERS[sc.state.phase]}: ${sc.phaseInfo.name}">${LETTERS[sc.state.phase]}</b>`;
  if (!main) return `<div class="sc-compact">${letter}<span class="muted">Главная цель выполнена</span></div>`;
  const left = sc.secondsLeft(main);
  const gauge = gaugeOf(sc, main);
  const progress = gauge ? `${gauge.text} в этом месяце` : progressText(main);
  return `<div class="sc-compact" title="${esc(main.title)} · ${esc(progress)}">${letter}${objectiveIcon(main, 18)}
    ${barHtml(gauge ? gauge.fraction : fraction(main), gauge ? null : sc.forecast(main))}
    ${left !== null ? `<span class="sc-left${urgent(left, URGENT.goal)}">⏳ ${leftText(left)}</span>` : ''}</div>`;
}

/** Вкладки левой панели: сценарий (этапы и задания), события с предложениями контрактов, стройка. */
export type LeftTab = 'scenario' | 'events' | 'build';

/** Какие вкладки есть в этой партии: сценарий и события — со сценарием, стройка — «Со строительством». */
export function leftTabs(g: Game): LeftTab[] {
  const tabs: LeftTab[] = g.scenario ? ['scenario', 'events'] : [];
  if (g.buildMode) tabs.push('build');
  return tabs;
}

/** Выбранная вкладка, если она есть в этой партии, иначе первая; нет ни одной (песочница без стройки) — null. */
export function leftTab(g: Game, want: LeftTab | undefined): LeftTab | null {
  const tabs = leftTabs(g);
  return want && tabs.includes(want) ? want : (tabs[0] ?? null);
}

export interface PanelView {
  collapsed: boolean;
  /** Задания, у которых раскрыто «почему» (по id), и прошедшие события с раскрытыми подробностями (ключ `ev:<id>`). */
  open: ReadonlySet<string>;
  /** «Следующий этап» нажат один раз — ждём подтверждения. */
  confirmAdvance: boolean;
  /** Выбранная вкладка (по умолчанию — первая из есть в партии). */
  tab?: LeftTab;
  /** Вкладка «Стройка»: ставим ли базу и чьи карточки открыты. */
  build?: BuildView;
}

/** Задания этапа и принятые контракты, что ещё в работе, — число на вкладке «Сценарий». */
const openTasks = (sc: Scenario) =>
  sc.state.objectives.filter((o) => o.status === 'active' && (o.phase === sc.state.phase || o.role === 'contract')).length;

/**
 * Вкладки значками с подписью и числом: «Сценарий» — заданий в работе, «События» — предложений на решение
 * (есть — вкладка подсвечена, меньше минуты на решение — красным), «Стройка» — проектов (первую базу ещё не
 * ставили — подсвечена: она бесплатна).
 */
function tabsHtml(g: Game, tab: LeftTab): string {
  const count = (n: number, cls = '') => (n ? `<b class="lp-count ${cls}">${n}</b>` : '');
  const btn = (id: LeftTab, icon: string, name: string, n: string, tip: string, cls = '') =>
    `<button class="lp-tab ${id === tab ? 'active' : ''} ${cls}" data-action="left-tab" data-id="${id}" data-tip="${esc(tip)}">${icon}<span>${name}</span>${n}</button>`;
  const out: string[] = [];
  const sc = g.scenario;
  if (sc) {
    const tasks = sc.state.status === 'running' ? openTasks(sc) : 0;
    out.push(btn('scenario', flagSvg(15), 'Сценарий', count(tasks), tasks ? `Этапы и задания: в работе ${tasks}` : 'Этапы, задания и контракты'));
    const offers = sc.state.status === 'running' ? offersByUrgency(sc) : [];
    const hot = offers.length && (sc.secondsLeft(offers[0]) ?? Infinity) < URGENT.banner ? ' urgent' : '';
    out.push(
      btn(
        'events',
        newsSvg(15),
        'События',
        count(offers.length, `call${hot}`),
        offers.length ? `Контракты ждут решения: ${offers.length} — принять или отказаться` : 'События региона и предложения контрактов',
        // Ждут решения — вкладка подсвечена; меньше минуты — ещё и мигает красным.
        offers.length ? `call${hot ? `${hot} pulse` : ''}` : '',
      ),
    );
  }
  if (g.buildMode) {
    const b = buildTabCount(g);
    const tip = b.first
      ? 'Стройка: поставьте первую базу — бесплатно, с бригадой'
      : `Стройка: баз ${b.bases}, проектов ${b.projects}`;
    out.push(btn('build', buildSvg(18, 14), 'Стройка', count(b.projects), tip, b.first ? 'call pulse' : ''));
  }
  return `<nav class="lp-tabs">${out.join('')}</nav>`;
}

/** Свёрнутая вкладка «События»: последнее событие строкой (предложения на решение показаны под ней всегда). */
function eventsCompactHtml(sc: Scenario): string {
  const e = sc.state.events[sc.state.events.length - 1];
  if (!e) return '<div class="sc-compact"><span class="muted">Событий пока нет</span></div>';
  return `<div class="sc-compact" data-tip="${esc(e.cause)}"><span class="sc-ev-ic">${EVENT_INFO[e.type].icon}</span><span class="sc-compact-text">${esc(eventTitle(e))}</span><small>${agoText(sc, e)}</small></div>`;
}

/**
 * Вкладка «События»: предложения контрактов с «Принять / Отказаться» — первыми (`offersSectionHtml`), под ними
 * активные события карточками (новые сверху) и прошедшие — строками.
 */
function eventsTabHtml(g: Game, sc: Scenario, view: PanelView): string {
  const s = sc.state;
  const now = sc.month;
  // Событие с контрактом на решение — уже в карточке предложения выше.
  const offered = (e: EventRecord) => !!e.contract && sc.objective(e.contract)?.status === 'offered';
  const active = s.events.filter((e) => isActive(sc, e, now) && !offered(e));
  const events = active.slice(-8).reverse();
  const past = s.events
    .filter((e) => !isActive(sc, e, now))
    .slice(-10)
    .reverse();
  const cards = events.map((e) => eventHtml(g, sc, e)).join('');
  const rows = past.map((e) => pastEventHtml(g, sc, e, view.open.has(`ev:${e.id}`))).join('');
  const offers = offersSectionHtml(g, view.open);
  const empty = !offers && !cards && !rows ? '<section class="sc-sec"><p class="muted">Событий пока нет: они случаются раз в несколько месяцев — город растёт, завод закрывается, приходят контракты.</p></section>' : '';
  return `${offers}${cards ? `<section class="sc-sec"><h4>${newsSvg(14)} События</h4>${cards}</section>` : ''}${
    rows ? `<section class="sc-sec"><h4>Прошедшие</h4>${rows}</section>` : ''
  }${empty}`;
}

/**
 * Левая панель под деньгами — вкладками: «Сценарий» (регион, этапы, репутация, задания этапа и принятые
 * контракты, «Следующий этап»), «События» (предложения контрактов с решением, события) и — «Со строительством» —
 * «Стройка» (базы, «＋ База», проекты). В песочнице со стройкой — одна вкладка «Стройка» заголовком. Свёрнутая —
 * заголовок, вкладки, компактная строка вкладки и предложения на решение. Ни сценария, ни стройки — пусто.
 */
export function leftPanelHtml(g: Game, view: PanelView): string {
  const tab = leftTab(g, view.tab);
  if (!tab) return '';
  const sc = g.scenario;
  const build = view.build ?? NO_BUILD_VIEW;
  const fold = `<span class="caret ${view.collapsed ? 'closed' : ''}">${chevronSvg()}</span>`;
  const toggle = view.collapsed ? 'Развернуть' : 'Свернуть';
  if (!sc) {
    const head = `<header class="sc-head"><button class="lines-toggle" data-action="sc-toggle" data-tip="${toggle} · стройка">${fold}${buildSvg(22, 17)}<h3>Стройка</h3></button></header>`;
    return head + (view.collapsed ? buildCompactHtml(g, build.placing) : buildTabHtml(g, build));
  }
  const s = sc.state;
  const diff = `<span class="sc-diff" data-tip="Сложность: ${sc.difficulty.name}${s.settings.challenge ? ' · испытание без паузы' : ''}">${difficultySvg(s.settings.difficulty, 18)}${
    s.settings.challenge ? stopwatchSvg(16) : ''
  }</span>`;
  const head = `<header class="sc-head">
    <button class="lines-toggle" data-action="sc-toggle" data-tip="${toggle} · сценарий «${esc(s.brief.region)}»">${fold}${flagSvg(18)}<h3>${esc(s.brief.region)}</h3></button>${diff}</header>${tabsHtml(g, tab)}`;
  const running = s.status === 'running';
  if (view.collapsed) {
    // Предложения ждут решения — видны в свёрнутой панели на любой вкладке.
    const offers = offersSectionHtml(g, view.open);
    const line =
      tab === 'build' ? buildCompactHtml(g, build.placing) : tab === 'events' ? (offers ? '' : eventsCompactHtml(sc)) : running ? compactHtml(sc) : finishedHtml(sc);
    return head + line + offers;
  }
  if (tab === 'build') return head + buildTabHtml(g, build);
  if (tab === 'events') return head + eventsTabHtml(g, sc, view);
  return head + scenarioTabHtml(g, sc, view);
}

/** Вкладка «Сценарий»: этапы и репутация, задания этапа и принятые контракты, «Следующий этап»; после конца — итог. */
function scenarioTabHtml(g: Game, sc: Scenario, view: PanelView): string {
  const s = sc.state;
  if (s.status !== 'running') return finishedHtml(sc) + extrasHtml(g, sc, view);
  const now = sc.month;
  // Задания этапа (и уже закрытые — с галочкой или крестиком), принятые контракты и только что закрытые.
  const rank: Record<Objective['role'], number> = { main: 0, goal: 1, contract: 2, extra: 3 };
  const list = s.objectives
    .filter(
      (o) =>
        (o.phase === s.phase && o.status !== 'offered' && o.status !== 'declined') ||
        (o.role === 'contract' && (o.status === 'active' || ((o.status === 'done' || o.status === 'failed') && (o.closedAt ?? -9) >= now - 1))),
    )
    .sort((a, b) => rank[a.role] - rank[b.role]);
  // Свёрнутые — компактной строкой (выбор игрока хранится в задании, выполненные свёрнуты сами).
  const objectives = list.map((o) => objectiveHtml(g, sc, o, { panel: true, why: view.open.has(o.id), folded: isFolded(o) })).join('');
  const open = s.objectives.filter((o) => o.phase === s.phase && o.status === 'active').length;
  const last = s.phase >= PHASES.length - 1;
  const advance = sc.canAdvance
    ? `<button class="sc-advance ${view.confirmAdvance ? 'confirm' : ''}" data-action="sc-advance"
        title="Главная цель выполнена. Незакрытые цели этапа (${open}) засчитаются как невыполненные">${
          view.confirmAdvance ? `Точно? Не выполнено целей: ${open}` : last ? 'Завершить сценарий ✓' : `Следующий этап ${LETTERS[s.phase + 1]} →`
        }</button>`
    : '';
  return `<section class="sc-sec">${stepsHtml(sc)}${reputationHtml(sc)}</section>
    <section class="sc-sec"><h4 data-tip="${esc(sc.phaseInfo.hint)}">Этап ${LETTERS[s.phase]} · ${sc.phaseInfo.name}</h4>
      ${objectives || '<p class="muted">Заданий нет.</p>'}${advance}</section>`;
}

// ---------- Брифинг ----------

/** Значки фактов о регионе — по порядку, в котором их пишет генератор: города, предприятия, расстояния, крупнейший город. */
const FACT_ICONS = [() => townIcon(20), () => factoryIcon(20), () => distanceSvg(20), () => growthIcon(20)];

/** Брифинг перед стартом: регион, условия, этапы, цели этапа A, стартовый контракт и подсказка. */
export function briefHtml(g: Game): string {
  const sc = g.scenario!;
  const s = sc.state;
  const b = s.brief;
  const tile = (icon: string, value: string, label: string, title: string) =>
    `<div class="brief-tile" title="${esc(title)}">${icon}<b>${value}</b><small>${label}</small></div>`;
  const facts = b.facts.map((f, i) => `<li>${FACT_ICONS[i]?.() ?? '<i class="dot"></i>'}<span>${esc(f)}</span></li>`).join('');
  // До старта прогресса нет — у целей только срок, награда, «почему» и места.
  const goals = s.objectives
    .filter((o) => o.phase === 0 && o.status === 'active')
    .map((o) => objectiveHtml(g, sc, o, { why: true, plan: true }))
    .join('');
  const contracts = s.objectives
    .filter((o) => o.role === 'contract' && (o.status === 'offered' || o.status === 'active'))
    .map((o) => (o.status === 'offered' ? offerCardHtml(g, sc, o, false) : objectiveHtml(g, sc, o, { why: true, plan: true })))
    .join('');
  const later = sc.offers.length ? ' <small data-tip="Решить можно и позже — на вкладке «События» левой панели">· можно решить позже</small>' : '';
  const interest = `${Math.round(ECONOMY.loanRate * 100)}% в месяц`;
  // Содержимое прокручивается, а подвал с подсказкой и «Начать» всегда виден внизу окна.
  return `<div class="brief-scroll" data-brief-scroll><div class="brief-head">${archetypeSvg(s.archetype, 104, 72)}<div class="brief-title">
      <div class="brief-kicker">${flagSvg(16)}Сценарий · ${difficultySvg(s.settings.difficulty, 16)}${sc.difficulty.name}${
        s.settings.challenge ? ` · ${stopwatchSvg(16)}без паузы` : ''
      }</div>
      <h2>${esc(b.region)}</h2><p class="sub">${esc(b.text)}</p></div></div>
    <div class="brief-tiles">
      ${tile(ledgerIcon('sales', 26), money(b.capital), 'капитал', 'Деньги компании на старте')}
      ${tile(ledgerIcon('interest', 26), b.loan ? money(b.loan) : 'нет', 'кредит', b.loan ? `Компания начинает с долгом: проценты ${interest}` : 'Стартового кредита нет')}
      ${tile(limitSvg(26), shortMoney(b.loanMax), 'предел кредита', `Взять в долг можно не больше ${money(b.loanMax)} (в «Финансах»)`)}
      ${tile(calendarSvg(26), `≈ ${Math.round((b.months * MONTH_LENGTH) / 60)}`, 'мин', 'Ожидаемая продолжительность сценария на скорости 1×')}
    </div>
    ${facts ? `<ul class="brief-facts">${facts}</ul>` : ''}
    ${stepsHtml(sc)}
    <h4>Цели этапа A · ${PHASES[0].name}</h4><div class="brief-goals">${goals || '<p class="muted">Заданий нет.</p>'}</div>
    ${contracts ? `<h4>${contractSvg(16)} Стартовый контракт${later}</h4>${contracts}` : ''}</div>
    <div class="brief-foot"><p class="tip">💡 ${esc(PHASES[0].hint)}</p>
      <button class="primary with-ic" data-action="begin">${playSvg(18)}Начать</button></div>`;
}

// ---------- Итоговый экран ----------

export interface RecordView {
  best: ScenarioRecord | null;
  previous: ScenarioRecord | null;
  isNew: boolean;
}

const PART_ICONS: Record<ScoreLine['id'], () => string> = {
  objectives: () => flagSvg(22),
  contracts: () => contractSvg(22),
  deadlines: () => calendarSvg(22),
  fast: () => stopwatchSvg(22),
  finance: () => coinIcon(22),
  quality: () => boltIcon(22),
  region: () => growthIcon(22),
};

/** Шкала медалей: где итог относительно порогов бронзы, серебра и золота. */
function medalScale(total: number, won: boolean): string {
  const max = Math.max(1000, total);
  const mark = (v: number, medal: 'gold' | 'silver' | 'bronze') =>
    `<i class="sc-tick" style="left:${(v / max) * 100}%" title="${MEDAL_NAMES[medal]} — от ${v} очков${won ? '' : ', если сценарий пройден'}">${medalSvg(medal, 14)}</i>`;
  return `<div class="sc-scale"><div class="sc-scale-bar"><div style="width:${Math.min(100, (total / max) * 100)}%"></div></div>
    ${mark(MEDALS.bronze, 'bronze')}${mark(MEDALS.silver, 'silver')}${mark(MEDALS.gold, 'gold')}</div>`;
}

/** Итоговый экран: медаль, очки и множитель, разбивка по показателям, задания, рекорд и что дальше. */
export function resultsHtml(g: Game, rec: RecordView): string {
  const sc = g.scenario!;
  const s = sc.state;
  const score = s.score!;
  const won = s.status === 'won';
  const raw = score.parts.reduce((sum, p) => sum + p.value, 0);
  // Непройденный сценарий оценивается со скидкой — показываем её отдельным множителем.
  const penalty = !won && raw > 0 ? score.total / (raw * score.multiplier) : 1;
  const multTip = `Сумма показателей ${raw} × сложность «${sc.difficulty.name}» ${sc.difficulty.score}${
    s.settings.challenge ? ` × испытание ${CHALLENGE_BONUS}` : ''
  }${penalty < 0.99 ? ` × ${penalty.toFixed(1)} — сценарий не пройден` : ''}`;
  const mult = `<span class="sc-mult" title="${multTip}">×${score.multiplier.toLocaleString('ru-RU', { maximumFractionDigits: 2 })}${
    penalty < 0.99 ? ` ×${penalty.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}` : ''
  }</span>`;
  const record = rec.isNew
    ? `<div class="sc-record new">🏆 Новый рекорд!${rec.previous ? ` <small>был ${num(rec.previous.total)}</small>` : ''}</div>`
    : rec.best
      ? rec.best.total === score.total
        ? '<div class="sc-record">🏆 Ваш лучший результат на этой карте</div>'
        : `<div class="sc-record">🏆 Рекорд: <b>${num(rec.best.total)}</b>${rec.best.medal ? medalSvg(rec.best.medal, 14) : ''}</div>`
      : '';
  const parts = score.parts
    .map(
      (p) => `<div class="sc-part">${PART_ICONS[p.id]()}<div class="sc-part-body">
        <div class="sc-part-top"><b>${esc(p.name)}</b><span>${p.value} / ${p.max}</span></div>
        <div class="bar sc-bar"><div style="width:${((p.value / Math.max(1, p.max)) * 100).toFixed(1)}%"></div></div>
        <small>${esc(p.note)}</small></div></div>`,
    )
    .join('');
  const closed = (o: Objective) => o.status === 'done' || o.status === 'failed';
  const groups = [
    ...PHASES.map((p, i) => ({ title: `Этап ${LETTERS[i]} · ${p.short}`, list: s.objectives.filter((o) => o.phase === i && closed(o)) })),
    { title: 'Контракты', list: s.objectives.filter((o) => o.role === 'contract' && closed(o)) },
    { title: 'После победы', list: s.objectives.filter((o) => o.role === 'extra' && o.status === 'done') },
  ].filter((x) => x.list.length);
  const extras = s.objectives.filter((o) => o.role === 'extra' && o.status === 'active').length;
  const row = (o: Objective) => `<div class="sc-res-obj ${o.status}" title="${esc(o.why)}">
      <span class="sc-state ${o.status}">${o.status === 'done' ? '✓' : '✗'}</span>${objectiveIcon(o, 18)}<span class="sc-obj-name">${esc(o.title)}</span>${
        o.role === 'main' ? '<span class="sc-role" title="Главная цель этапа">★</span>' : ''
      }${o.status === 'done' && o.late ? `<span class="sc-late done" data-tip="${esc(`Выполнено с опозданием: награда и очки ${LATE_CUT}`)}">⌛</span>` : ''}</div>`;
  const done = s.objectives.filter((o) => o.status === 'done').length;
  const failed = s.objectives.filter((o) => o.status === 'failed').length;
  const list = groups.map((x) => `<div class="sc-res-group"><small>${x.title}</small>${x.list.map(row).join('')}</div>`).join('');
  const diff = sc.difficulty.name.toLowerCase();
  // Крестик закрывает итоги так же, как «Продолжить в песочнице» (и Esc).
  return `<button class="icon modal-close" data-action="sc-continue" title="Закрыть и продолжить в песочнице (Esc)">✕</button>
    <div class="sc-res-head">${medalSvg(score.medal, 76)}<div class="sc-res-title">
      <div class="brief-kicker">${difficultySvg(s.settings.difficulty, 16)}${sc.difficulty.name}${s.settings.challenge ? ` · ${stopwatchSvg(16)}без паузы` : ''} · ${esc(s.brief.region)}</div>
      <h2>${won ? 'Сценарий пройден!' : 'Сценарий провален'}</h2>
      ${!won && s.lostReason ? `<p class="sc-lost">${esc(s.lostReason)}</p>` : ''}
      <div class="sc-total"><b>${num(score.total)}</b><span>очков</span>${mult}</div>
      ${record}</div></div>
    ${medalScale(score.total, won)}
    <h4>Из чего сложилась оценка</h4><div class="sc-parts">${parts}</div>
    <h4>Задания <span class="sc-counts"><span class="sc-state done">✓</span>${done}<span class="sc-state failed">✗</span>${failed}</span></h4>
    <div class="sc-res-list">${list || '<p class="muted">Ни одно задание не закрыто.</p>'}</div>
    <div class="menu-buttons">
      <button class="menu-item" data-action="sc-continue">${playSvg(22)}<span class="menu-text">${
        extras
          ? `<b>Продолжить игру</b><small>Та же карта и сеть · дополнительных заданий: ${extras} — без сроков, за деньги</small>`
          : '<b>Продолжить в песочнице</b><small>Та же карта и сеть, без заданий и сроков</small>'
      }</span></button>
      <button class="menu-item" data-action="sc-replay">${replaySvg(22)}<span class="menu-text"><b>Переиграть этот сценарий</b><small>Тот же регион и задания — с самого начала</small></span></button>
      <button class="menu-item" data-action="sc-new">${diceMapSvg(30, 22)}<span class="menu-text"><b>Новый сценарий</b><small>Другой регион · ${diff}${s.settings.challenge ? ', без паузы' : ''}</small></span><span class="menu-go">›</span></button>
      <button class="menu-item" data-action="export-journal">${journalSvg(22)}<span class="menu-text"><b>Сохранить журнал партии</b><small>Вся партия по шагам: стройка, рейсы, задания, события · ${num(g.journal.entries.length)} ${entriesWord(g.journal.entries.length)}</small></span></button>
      ${timelapseItemHtml(g)}
    </div>`;
}

// ---------- Новая игра ----------

/** Плитки режима: песочница или сценарий. */
export function modeTilesHtml(scenario: boolean): string {
  return `<div class="cards ng-modes">
    <button class="card ${scenario ? '' : 'active'}" data-action="ng-mode" data-id="sandbox" title="Свободная игра: стройте что хотите, без заданий и сроков">
      ${sandboxSvg()}<span class="name">Песочница</span><small>без заданий и сроков</small></button>
    <button class="card ${scenario ? 'active' : ''}" data-action="ng-mode" data-id="scenario" title="Регион со своей историей: три этапа заданий, события экономики, контракты и итоговая оценка с медалью">
      ${scenarioModeSvg()}<span class="name">Сценарий</span><small>этапы, задания, медаль</small></button></div>`;
}

/** Строки «Сложность», «Испытание» и «Регион». */
export function scenarioOptionsHtml(sc: ScenarioSettings): string {
  const strict = (d: Difficulty) => {
    const x = DIFFICULTY[d];
    return [
      `Капитал: ${x.capital >= 2.2 ? 'с большим запасом' : x.capital >= 1.6 ? 'с запасом' : 'впритык'} к стоимости первой линии`,
      `кредит до ${money(x.loanMax)}`,
      `сроки ×${x.time}, требования — ${Math.round(x.demand * 100)}% от возможного`,
      x.critical ? 'главные цели этапов критические: провал — конец сценария' : 'проваленная главная цель даёт ещё одну попытку',
      `очки ×${x.score}`,
    ].join(' · ');
  };
  const diffs = (Object.keys(DIFFICULTY) as Difficulty[])
    .map(
      (d) => `<button class="card ng-diff ${sc.difficulty === d ? 'active' : ''}" data-action="ng-diff" data-id="${d}" title="${strict(d)}">
        ${difficultySvg(d, 28)}<span class="name">${DIFFICULTY[d].name}</span><small>кредит до ${shortMoney(DIFFICULTY[d].loanMax)}</small><small>очки ×${DIFFICULTY[d].score
          .toLocaleString('ru-RU')}</small></button>`,
    )
    .join('');
  const bonus = Math.round((CHALLENGE_BONUS - 1) * 100);
  const challenge = `<button class="switch-row ng-challenge" data-action="ng-challenge" title="Время не останавливается: пауза — только в меню. Оценка ×${CHALLENGE_BONUS}">
    <span class="sw-label">${stopwatchSvg(22)}<span>Испытание: без паузы <small>+${bonus}% к оценке</small></span></span><span class="switch ${sc.challenge ? 'on' : ''}"><i></i></span></button>`;
  // Какой регион выпал по seed, не пишем; описание выбранного — в подсказке карточки, как у биомов.
  const regions = [
    randomCardHtml('ng-pick', !sc.pick, 'Случайный регион: его выберет seed — с тем же seed выпадет тот же'),
    ...ARCHETYPE_LIST.map(
      (a) => `<button class="card region ${sc.pick === a.id ? 'active' : ''}" data-action="ng-pick" data-id="${a.id}" data-tip="${esc(a.pitch)}">${archetypeSvg(a.id)}<span class="name">${esc(a.name)}</span></button>`,
    ),
  ].join('');
  return `<div class="ng-row"><span class="ng-label">Сложность</span><div class="cards">${diffs}</div></div>
    <div class="ng-row"><span class="ng-label"></span>${challenge}</div>
    <div class="ng-row top"><span class="ng-label">Регион</span><div class="ng-region"><div class="cards ng-regions">${regions}</div></div></div>`;
}

/** Личный рекорд для выбранных seed, сложности, испытания и региона; нет — пусто. */
export function recordRowHtml(record: ScenarioRecord | null): string {
  if (!record) return '';
  return `<div class="ng-row"><span class="ng-label"></span><div class="ng-record" title="Лучший результат при этих seed, сложности, испытании и регионе">${medalSvg(
    record.medal,
    20,
  )}<span>Рекорд на этой карте: <b>${num(record.total)}</b></span></div></div>`;
}
