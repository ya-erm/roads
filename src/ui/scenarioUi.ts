/**
 * Разметка режима «Сценарий»: панель сценария (этапы, задания, события и контракты), брифинг перед стартом,
 * итоговый экран и часть экрана новой игры. Здесь только чтение состояния — клики по data-action
 * обрабатывает Hud. Объясняем картинками: значки заданий и грузов, полоски, медали; текст — подписи и title.
 */
import { ECONOMY } from '../config';
import type { Game } from '../game/game';
import { isIndustry, resolve } from '../scenario/analysis';
import { ARCHETYPE_LIST, ARCHETYPES, CHALLENGE_BONUS, DIFFICULTY, EVENT_INFO, MEDALS, PHASES, REPUTATION } from '../scenario/content';
import { isActive } from '../scenario/events';
import type { Scenario } from '../scenario/manager';
import { failText, fraction, isMonthly, monthValue, progressText, rewardText } from '../scenario/objectives';
import type { ScenarioRecord } from '../scenario/records';
import type { Difficulty, EventRecord, Objective, Ref, ScenarioSettings, ScoreLine } from '../scenario/types';
import { cargoIcon, townIcon } from './cargoIcons';
import { chevronSvg, ledgerIcon, playSvg } from './icons';
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
  objectiveIcon,
  replaySvg,
  reputationSvg,
  sandboxSvg,
  scenarioModeSvg,
  stopwatchSvg,
} from './scenarioIcons';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;
const num = (n: number) => Math.round(n).toLocaleString('ru-RU');
const LETTERS = 'ABC';

/** Крупные суммы коротко: «$1 млн», «$250 тыс.». */
export function shortMoney(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)} тыс.`;
  return money(n);
}

/** Остаток времени: «3,5 мес.»; от 10 месяцев — целыми. */
export function leftText(m: number): string {
  const v = m >= 10 ? Math.round(m) : Math.max(0.1, Math.floor(m * 10) / 10);
  return `${v.toLocaleString('ru-RU')} мес.`;
}

/** Последствие события растёт или падает: «+20%» — вверх, «-30%» — вниз. */
const trend = (text: string) => (/\+\d/.test(text) ? 'up' : /[-−]\d/.test(text) ? 'down' : '');

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
}

/**
 * Задание: значок по типу, заголовок (★ — главная цель, свиток — контракт, ❗ — критическое),
 * полоска выполнения, прогресс, остаток срока (красным — меньше 2 месяцев), награда.
 * У месячных — как прошёл последний месяц.
 */
export function objectiveHtml(g: Game, sc: Scenario, o: Objective, view: ObjectiveView = {}): string {
  const active = o.status === 'active';
  const left = active ? sc.monthsLeft(o) : null;
  const months = sc.state.stats.months;
  const now = active && isMonthly(o.params) ? monthValue(o.params, g, months[months.length - 1]) : null;
  const role = o.role === 'main' ? '<span class="sc-role" title="Главная цель этапа">★</span>' : o.role === 'contract' ? contractSvg(16) : '';
  const crit = o.critical ? `<span class="sc-crit" title="Критическое задание. Если не успеть: ${esc(failText(o))}">❗</span>` : '';
  const state =
    o.status === 'done'
      ? '<span class="sc-state done" title="Выполнено">✓</span>'
      : o.status === 'failed'
        ? '<span class="sc-state failed" title="Не выполнено">✗</span>'
        : '';
  const time =
    left !== null
      ? `<span class="sc-left ${left < 2 ? 'urgent' : ''}" title="Осталось до срока">⏳ ${leftText(left)}</span>`
      : active
        ? '<span class="sc-left" title="Без срока">⏳ ∞</span>'
        : '';
  const tip = `${o.why}${active && !o.critical ? `\nЕсли не успеть: ${failText(o)}` : ''}`;
  const action = view.panel ? ` data-action="sc-why" data-id="${o.id}"` : '';
  return `<div class="sc-obj ${o.role} ${o.status} ${o.critical ? 'critical' : ''}"${action} title="${esc(tip)}">
    <span class="sc-obj-ic">${objectiveIcon(o, 26)}</span>
    <div class="sc-obj-body">
      <div class="sc-obj-title">${role}<span class="sc-obj-name">${esc(o.title)}</span>${crit}${state}</div>
      <div class="bar sc-bar"><div style="width:${(fraction(o) * 100).toFixed(1)}%"></div></div>
      <div class="sc-meta"><b>${progressText(o)}</b>${time}<span class="sc-reward" title="Награда">🎁 ${esc(rewardText(o))}</span></div>
      ${now ? `<small class="sc-now">${esc(now)}</small>` : ''}
      ${view.why ? `<p class="sc-why">${esc(o.why)}</p>` : ''}
      ${placeChips(g, o.related, !!view.panel)}
    </div></div>`;
}

/** Этапы A → B → C: пройденные с галочкой, текущий выделен. */
function stepsHtml(sc: Scenario): string {
  const s = sc.state;
  const steps = PHASES.map((p, i) => {
    const done = i < s.phase || s.status === 'won';
    const now = i === s.phase && s.status !== 'won';
    const cls = done ? 'done' : now ? (s.status === 'lost' ? 'lost' : 'now') : '';
    const months = Math.round(p.months * sc.difficulty.time);
    return `<div class="sc-step ${cls}" title="Этап ${LETTERS[i]} «${p.name}», около ${months} мес. ${p.hint}">
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

/** Условия контракта и решение: награда, срок после принятия, цена провала, сколько осталось думать. */
function offerHtml(sc: Scenario, o: Objective): string {
  const left = sc.monthsLeft(o);
  const worse = o.fail.effects?.length || o.fail.follow?.length ? ', а экономика региона пойдёт по худшему пути' : '';
  return `<div class="sc-offer">
    <div class="sc-terms">
      <span title="Награда">🎁 ${esc(rewardText(o))}</span>
      ${o.months !== undefined ? `<span title="Срок на выполнение — с момента, как примете">⏳ ${o.months} мес.</span>` : ''}
      <span class="sc-fail" title="Если принять и не успеть">⚠ ${esc(failText(o))}</span>
    </div>
    <div class="sc-offer-actions">
      <button class="small primary" data-action="sc-accept" data-id="${o.id}" title="Срок пойдёт с этой минуты">✓ Принять</button>
      <button class="small" data-action="sc-decline" data-id="${o.id}" title="Отказ: репутация ${REPUTATION.declined}${worse}">✕ Отказаться</button>
      ${left !== null ? `<span class="sc-left ${left < 1 ? 'urgent' : ''}" title="Предложение действует ещё">⌛ ${leftText(left)}</span>` : ''}
    </div></div>`;
}

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

const agoText = (sc: Scenario, e: EventRecord) => (sc.month - e.month <= 0 ? 'сейчас' : `${sc.month - e.month} мес. назад`);

/** Прошедшее событие — приглушённой строкой: значок, заголовок, когда; причина и последствия — в подсказке. */
function pastEventHtml(sc: Scenario, e: EventRecord): string {
  const contract = e.contract ? sc.objective(e.contract) : undefined;
  const tip = [e.cause, ...e.effects, ...(contract ? [`${contract.title}: ${CONTRACT_STATE[contract.status]}`] : [])].join('\n');
  return `<div class="sc-past" title="${esc(tip)}"><span class="sc-ev-ic">${EVENT_INFO[e.type].icon}</span><span>${esc(e.title)}</span>${
    contract ? `<span class="sc-state ${contract.status}">${contract.status === 'done' ? '✓' : contract.status === 'failed' ? '✗' : '–'}</span>` : ''
  }<small>${agoText(sc, e)}</small></div>`;
}

/** Событие: значок и заголовок, причина, последствия (▲/▼), связанные места; контракт — с решением. */
function eventHtml(g: Game, sc: Scenario, e: EventRecord): string {
  const info = EVENT_INFO[e.type];
  const when = agoText(sc, e);
  const contract = e.contract ? sc.objective(e.contract) : undefined;
  const effects = e.effects.map((t) => `<li class="${trend(t)}">${esc(t)}</li>`).join('');
  const offer =
    contract?.status === 'offered'
      ? `<div class="sc-offer-title">${objectiveIcon(contract, 20)}<span>${esc(contract.title)}</span></div>${offerHtml(sc, contract)}`
      : contract
        ? `<div class="sc-offer-state ${contract.status}" title="${esc(contract.title)}">${contractSvg(14)}<span>${CONTRACT_STATE[contract.status]}</span></div>`
        : '';
  return `<div class="sc-card event ${e.importance} ${contract?.status === 'offered' ? 'offer' : ''}">
    <div class="sc-card-head"><span class="sc-ev-ic" title="${info.name}">${info.icon}</span><b>${esc(e.title)}</b><small>${when}</small></div>
    <p class="sc-cause">${esc(e.cause)}</p>
    ${effects ? `<ul class="sc-effects">${effects}</ul>` : ''}
    ${placeChips(g, e.related)}
    ${offer}</div>`;
}

/** Итог в панели после конца сценария: медаль, очки и кнопка к итоговому экрану. */
function finishedHtml(sc: Scenario): string {
  const score = sc.state.score;
  if (!score) return '';
  return `<section class="sc-sec sc-final">${medalSvg(score.medal, 34)}
    <div><b>${num(score.total)}</b> очков<small>${sc.state.status === 'won' ? 'Сценарий пройден' : 'Сценарий провален'} · дальше — песочница</small></div>
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
  const left = sc.monthsLeft(main);
  return `<div class="sc-compact" title="${esc(main.title)} · ${progressText(main)}">${letter}${objectiveIcon(main, 18)}
    <div class="bar sc-bar"><div style="width:${(fraction(main) * 100).toFixed(1)}%"></div></div>
    ${left !== null ? `<span class="sc-left ${left < 2 ? 'urgent' : ''}">⏳ ${leftText(left)}</span>` : ''}</div>`;
}

export interface PanelView {
  collapsed: boolean;
  /** Задания, у которых раскрыто «почему». */
  open: ReadonlySet<string>;
  /** «Следующий этап» нажат один раз — ждём подтверждения. */
  confirmAdvance: boolean;
}

/**
 * Панель сценария: заголовок (регион, контракты на решение, сложность), этапы и репутация,
 * задания этапа и принятые контракты, кнопка перехода к этапу, предложения и события.
 */
export function scenarioPanelHtml(g: Game, view: PanelView): string {
  const sc = g.scenario!;
  const s = sc.state;
  const offers = sc.offers;
  const badge = offers.length ? `<span class="sc-badge" title="Контракты ждут решения: ${offers.length}">${contractSvg(14)}${offers.length}</span>` : '';
  const diff = `<span class="sc-diff" title="Сложность: ${sc.difficulty.name}${s.settings.challenge ? ' · испытание без паузы' : ''}">${difficultySvg(s.settings.difficulty, 18)}${
    s.settings.challenge ? stopwatchSvg(16) : ''
  }</span>`;
  const head = `<header class="sc-head">
    <button class="lines-toggle" data-action="sc-toggle" title="${view.collapsed ? 'Развернуть' : 'Свернуть'} · сценарий «${esc(s.brief.region)}»">
      <span class="caret ${view.collapsed ? 'closed' : ''}">${chevronSvg()}</span>${flagSvg(18)}<h3>${esc(s.brief.region)}</h3></button>${badge}${diff}</header>`;
  if (s.status !== 'running') return head + finishedHtml(sc);
  if (view.collapsed) return head + compactHtml(sc);

  const now = sc.month;
  // Задания этапа (и уже закрытые — с галочкой или крестиком), принятые контракты и только что закрытые.
  const rank = { main: 0, goal: 1, contract: 2 };
  const list = s.objectives
    .filter(
      (o) =>
        (o.phase === s.phase && o.status !== 'offered' && o.status !== 'declined') ||
        (o.role === 'contract' && (o.status === 'active' || ((o.status === 'done' || o.status === 'failed') && (o.closedAt ?? -9) >= now - 1))),
    )
    .sort((a, b) => rank[a.role] - rank[b.role]);
  const objectives = list.map((o) => objectiveHtml(g, sc, o, { panel: true, why: view.open.has(o.id) })).join('');
  const open = s.objectives.filter((o) => o.phase === s.phase && o.status === 'active').length;
  const last = s.phase >= PHASES.length - 1;
  const advance = sc.canAdvance
    ? `<button class="sc-advance ${view.confirmAdvance ? 'confirm' : ''}" data-action="sc-advance"
        title="Главная цель выполнена. Незакрытые цели этапа (${open}) засчитаются как невыполненные">${
          view.confirmAdvance ? `Точно? Не выполнено целей: ${open}` : last ? 'Завершить сценарий ✓' : `Следующий этап ${LETTERS[s.phase + 1]} →`
        }</button>`
    : '';
  // События: активные (пока открыт их контракт или недавние) — карточками, новые сверху; несколько прошедших — строками.
  const active = s.events.filter((e) => isActive(sc, e, now));
  const events = active.slice(-5).reverse();
  const past = s.events
    .filter((e) => !isActive(sc, e, now))
    .slice(-3)
    .reverse();
  const attached = new Set(events.map((e) => e.contract));
  const loose = offers.filter((o) => !attached.has(o.id));
  const eventsHtml = events.map((e) => eventHtml(g, sc, e)).join('') + past.map((e) => pastEventHtml(sc, e)).join('');
  return `${head}
    <section class="sc-sec">${stepsHtml(sc)}${reputationHtml(sc)}</section>
    <section class="sc-sec"><h4 title="${esc(sc.phaseInfo.hint)}">Этап ${LETTERS[s.phase]} · ${sc.phaseInfo.name}</h4>
      ${objectives || '<p class="muted">Заданий нет.</p>'}${advance}</section>
    ${loose.length ? `<section class="sc-sec"><h4>Предложения</h4>${loose.map((o) => offerCardHtml(g, sc, o)).join('')}</section>` : ''}
    ${eventsHtml ? `<section class="sc-sec"><h4>События</h4>${eventsHtml}</section>` : ''}`;
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
  const goals = s.objectives
    .filter((o) => o.phase === 0 && o.status === 'active')
    .map((o) => objectiveHtml(g, sc, o, { why: true }))
    .join('');
  const contracts = s.objectives
    .filter((o) => o.role === 'contract' && (o.status === 'offered' || o.status === 'active'))
    .map((o) => (o.status === 'offered' ? offerCardHtml(g, sc, o, false) : objectiveHtml(g, sc, o, { why: true })))
    .join('');
  const interest = `${Math.round(ECONOMY.loanRate * 100)}% в месяц`;
  return `<div class="brief-head">${archetypeSvg(s.archetype, 104, 72)}<div class="brief-title">
      <div class="brief-kicker">${flagSvg(16)}Сценарий · ${difficultySvg(s.settings.difficulty, 16)}${sc.difficulty.name}${
        s.settings.challenge ? ` · ${stopwatchSvg(16)}без паузы` : ''
      }</div>
      <h2>${esc(b.region)}</h2><p class="sub">${esc(b.text)}</p></div></div>
    <div class="brief-tiles">
      ${tile(ledgerIcon('sales', 26), money(b.capital), 'капитал', 'Деньги компании на старте')}
      ${tile(ledgerIcon('interest', 26), b.loan ? money(b.loan) : 'нет', 'кредит', b.loan ? `Компания начинает с долгом: проценты ${interest}` : 'Стартового кредита нет')}
      ${tile(limitSvg(26), shortMoney(b.loanMax), 'предел кредита', `Взять в долг можно не больше ${money(b.loanMax)} (в «Финансах»)`)}
      ${tile(calendarSvg(26), `≈ ${b.months}`, 'месяцев', 'Ожидаемая продолжительность сценария')}
    </div>
    ${facts ? `<ul class="brief-facts">${facts}</ul>` : ''}
    ${stepsHtml(sc)}
    <h4>Цели этапа A · ${PHASES[0].name}</h4><div class="brief-goals">${goals || '<p class="muted">Заданий нет.</p>'}</div>
    ${contracts ? `<h4>${contractSvg(16)} Стартовый контракт</h4>${contracts}` : ''}
    ${sc.offers.length ? '<p class="muted small-note">Решить можно и позже — в панели сценария слева.</p>' : ''}
    <p class="tip">💡 ${esc(PHASES[0].hint)}</p>
    <div class="actions"><button class="primary with-ic" data-action="begin">${playSvg(18)}Начать</button></div>`;
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
  ].filter((x) => x.list.length);
  const row = (o: Objective) => `<div class="sc-res-obj ${o.status}" title="${esc(o.why)}">
      <span class="sc-state ${o.status}">${o.status === 'done' ? '✓' : '✗'}</span>${objectiveIcon(o, 18)}<span class="sc-obj-name">${esc(o.title)}</span>${
        o.role === 'main' ? '<span class="sc-role" title="Главная цель этапа">★</span>' : ''
      }</div>`;
  const done = s.objectives.filter((o) => o.status === 'done').length;
  const failed = s.objectives.filter((o) => o.status === 'failed').length;
  const list = groups.map((x) => `<div class="sc-res-group"><small>${x.title}</small>${x.list.map(row).join('')}</div>`).join('');
  const diff = sc.difficulty.name.toLowerCase();
  return `<div class="sc-res-head">${medalSvg(score.medal, 76)}<div class="sc-res-title">
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
      <button class="menu-item" data-action="sc-continue">${playSvg(22)}<span class="menu-text"><b>Продолжить в песочнице</b><small>Та же карта и сеть, без заданий и сроков</small></span></button>
      <button class="menu-item" data-action="sc-replay">${replaySvg(22)}<span class="menu-text"><b>Переиграть этот сценарий</b><small>Тот же регион и задания — с самого начала</small></span></button>
      <button class="menu-item" data-action="sc-new">${diceMapSvg(30, 22)}<span class="menu-text"><b>Новый сценарий</b><small>Другой регион · ${diff}${s.settings.challenge ? ', без паузы' : ''}</small></span><span class="menu-go">›</span></button>
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
  const regions = [
    `<button class="card region ${sc.pick ? '' : 'active'}" data-action="ng-pick" data-id="seed" title="Регион выберется по seed — тот же seed даст тот же регион">${diceMapSvg()}<span class="name">По seed</span></button>`,
    ...ARCHETYPE_LIST.map(
      (a) => `<button class="card region ${sc.pick === a.id ? 'active' : ''}" data-action="ng-pick" data-id="${a.id}" title="${esc(a.pitch)}">${archetypeSvg(a.id)}<span class="name">${esc(a.name)}</span></button>`,
    ),
  ].join('');
  const pitch = sc.pick ? ARCHETYPES[sc.pick].pitch : 'Один из пяти регионов — по seed.';
  return `<div class="ng-row"><span class="ng-label">Сложность</span><div class="cards">${diffs}</div></div>
    <div class="ng-row"><span class="ng-label"></span>${challenge}</div>
    <div class="ng-row top"><span class="ng-label">Регион</span><div class="ng-region"><div class="cards ng-regions">${regions}</div><p class="muted">${esc(pitch)}</p></div></div>`;
}

/** Личный рекорд для выбранных seed, сложности, испытания и региона; нет — пусто. */
export function recordRowHtml(record: ScenarioRecord | null): string {
  if (!record) return '';
  return `<div class="ng-row"><span class="ng-label"></span><div class="ng-record" title="Лучший результат при этих seed, сложности, испытании и регионе">${medalSvg(
    record.medal,
    20,
  )}<span>Рекорд на этой карте: <b>${num(record.total)}</b></span></div></div>`;
}
