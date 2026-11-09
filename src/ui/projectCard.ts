/**
 * Карточка проекта стройки (режим «Со строительством») в правой панели — открывается кликом по плашке «🏗 45%» на
 * карте или по значку проекта на плашке слева внизу. Наглядно, значками и полосками:
 * - что строим: название (клик или ✎ — переименовать), длина, мосты, тоннели, насыпи и выемки;
 * - готовность: полоска и три этапа (🟫 отсыпка, ⬛ покрытие, ⬜ разметка);
 * - сколько ещё строить при нынешних бригадах и с ещё одной;
 * - деньги: потрачено / в резерве / осталось — полоской, хватает ли сейчас; «🔒 Зарезервировать» и «Снять резерв»;
 * - бригады на проекте (клик — показать на карте); нет никого — почему и кнопка, которая поможет (вне радиуса всех
 *   баз — «нет базы рядом» и «＋ База»);
 * - «⬆ Приоритет», «⏸ Пауза» / «▶ Дальше», «✕ Отмена».
 * Подсказки — data-tip (не системные).
 */
import { CONSTRUCTION } from '../config';
import { durationText } from '../core/timeText';
import { type ProjectInfo, projectName } from '../game/construction';
import type { Brigade } from '../game/crews';
import type { Game } from '../game/game';
import { basePrices, basePriceText, buildSvg, km, railTrainStatus } from './constructionUi';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number) => `$${Math.round(n).toLocaleString('ru-RU')}`;
const meters = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} км` : `${Math.round(m)} м`);
const pct = (f: number) => Math.max(0, Math.min(100, Math.floor(f * 100)));

/** Этапы участка: значок-плитка, название, цвет полоски (как на карте: отсыпка, покрытие, разметка). */
const STAGES = [
  { name: 'Отсыпка', tip: 'Земляные работы: грунт и щебень', color: '#c4a57c' },
  { name: 'Покрытие', tip: 'Асфальт: дорога без разметки', color: '#5c636d' },
  { name: 'Разметка', tip: 'Разметка и знаки: участок готов и открыт', color: '#e9ecef' },
] as const;

/** Этапы ж/д пути (как на карте): балласт, шпалы, рельсы — после рельсов участок открыт для поездов. */
const RAIL_STAGES = [
  { name: 'Балласт', tip: 'Отсыпка балласта: щебёночная призма под путь', color: '#b9b1a6' },
  { name: 'Шпалы', tip: 'Укладка шпал', color: '#7a5a3c' },
  { name: 'Рельсы', tip: 'Рельсы: участок готов, поезда по нему ходят', color: '#4f5965' },
] as const;

/** Что делает бригада — значок и коротко. */
const CREW_STATE: Record<Brigade['state'], { mark: string; text: string }> = {
  working: { mark: '🏗', text: 'строит' },
  going: { mark: '➜', text: 'едет' },
  back: { mark: '↩', text: 'едет на базу' },
  idle: { mark: '', text: 'на базе' },
};

/** Что бригада делает сейчас — коротко: едет по дороге, вдоль стройки к краю работ, ждёт выезда, строит. */
export function crewDoing(b: Brigade): string {
  if (b.state === 'going') return b.convoy ? 'едет по дороге' : b.eta !== undefined ? 'едет вдоль стройки' : 'ждёт выезда';
  return CREW_STATE[b.state].text;
}

/** Карточка проекта id; renaming — вместо названия поле ввода. Проекта нет (достроен, отменён) — короткая записка. */
export function projectCardHtml(game: Game, id: number, renaming = false): string {
  const info = game.construction.info(id);
  const close = `<button class="icon" data-action="close-sel" data-tip="Закрыть">✕</button>`;
  if (!info) return `<section class="detail project-card"><header><h3>Стройка</h3>${close}</header><p class="muted">✅ Проекта больше нет: достроен или отменён.</p></section>`;
  const p = info.project;
  const prio = p.priority ? `<span class="pc-prio" data-tip="Приоритетный проект: бригады едут сначала сюда">⬆</span>` : '';
  // Название — переименовать: клик по нему или по ✎ открывает поле; пустое — снова автоматическое.
  const name = projectName(p);
  // У другой стройки такое же название — серым место (ближайший город, Game.projectPlace): «Улица 1+1 · Заречье».
  const place = game.projectPlace(p.id);
  const where = place ? ` <span class="muted" data-tip="Такое же название — и у другой стройки: место по ближайшему городу (в одном городе — с номером)">· ${esc(place)}</span>` : '';
  const title = renaming
    ? `<input class="line-name station-name" data-project-name="${p.id}" value="${esc(name)}" maxlength="40" placeholder="${esc(p.label)}" />`
    : `<h3 class="station-title" data-action="project-rename" data-id="${p.id}" data-tip="${esc(p.name ? `Нажмите, чтобы переименовать (без названия — «${p.label}»)` : 'Нажмите, чтобы переименовать')}">${esc(name)}${where}</h3>
       <button class="icon pencil" data-action="project-rename" data-id="${p.id}" data-tip="Переименовать">✎</button>`;
  const head = `<header class="pc-head station-head"><button class="icon pc-show" data-action="build-show" data-id="${p.id}" data-tip="Показать на карте">${buildSvg(30, 22)}</button>
    ${title}${prio}${close}</header>`;
  return `<section class="detail project-card">${head}
    ${whatHtml(game, info)}
    ${closureHtml(game, info)}
    ${progressHtml(info)}
    ${timeHtml(game, info)}
    ${moneyHtml(game, info)}
    ${crewsHtml(game, info)}
    ${actionsHtml(info)}</section>`;
}

/** Что строим: длина и сооружения — значками-чипами. */
function whatHtml(game: Game, info: ProjectInfo): string {
  const parts = game.construction.parts(info.project.id);
  const chips = [`<span class="pc-chip" data-tip="Длина проекта целиком">📏 <b>${meters(info.length)}</b></span>`];
  if (parts.bridge >= 1) chips.push(`<span class="pc-chip" data-tip="Мост или эстакада: метр строится в 2,5–3 раза дольше">🌉 <b>${meters(parts.bridge)}</b></span>`);
  if (parts.water >= 1) chips.push(`<span class="pc-chip" data-tip="Мост над водой: метр строится втрое дольше">🌊 <b>${meters(parts.water)}</b></span>`);
  if (parts.tunnel >= 1) chips.push(`<span class="pc-chip" data-tip="Тоннель: метр строится вчетверо дольше">🚇 <b>${meters(parts.tunnel)}</b></span>`);
  if (parts.fill >= 0.7) chips.push(`<span class="pc-chip" data-tip="Насыпь: дорога выше земли — дороже">⛰ <b>до ${parts.fill.toFixed(1).replace('.', ',')} м</b></span>`);
  if (parts.cut >= 0.7) chips.push(`<span class="pc-chip" data-tip="Выемка: дорога ниже земли — дороже">⛏ <b>до ${parts.cut.toFixed(1).replace('.', ',')} м</b></span>`);
  return `<div class="pc-chips">${chips.join('')}</div>`;
}

/**
 * Схема перекрытия — кусок дороги в две полосы сверху: part — одна полоса закрыта (красно-белая штриховка, конусы),
 * по другой едут; full — закрыты обе (шлагбаум), стрелка объезда дугой; open — работы не начаты, едут по обеим.
 */
export function closureSvg(kind: 'part' | 'full' | 'open', w = 46, h = 26): string {
  const hatch = (y: number) =>
    `<rect x="4" y="${y}" width="38" height="7" fill="url(#cz-h)"/><rect x="4" y="${y}" width="38" height="7" fill="none" stroke="#c0392b" stroke-width="0.8"/>`;
  const car = (y: number, dir: 1 | -1) => `<path d="M${dir > 0 ? 18 : 28} ${y + 3.5} l${dir * 8} 0 m${-dir * 3} -2.5 l${dir * 3} 2.5 l${-dir * 3} 2.5" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  const road = `<rect x="2" y="9" width="42" height="16" rx="1.5" fill="#5c636d"/><line x1="4" y1="17" x2="42" y2="17" stroke="#e9ecef" stroke-width="0.9" stroke-dasharray="3 2.5"/>`;
  const body =
    kind === 'open'
      ? `${car(9.5, 1)}${car(17.5, -1)}`
      : kind === 'part'
        ? `${hatch(17.5)}<circle cx="9" cy="17" r="1.4" fill="#f08a3c"/><circle cx="23" cy="17" r="1.4" fill="#f08a3c"/><circle cx="37" cy="17" r="1.4" fill="#f08a3c"/>${car(9.5, 1)}`
        : `${hatch(9.5)}${hatch(17.5)}<path d="M5 8 Q23 -3 41 8" stroke="#2f80ed" stroke-width="1.6" fill="none" stroke-dasharray="2.5 1.8"/><path d="M38 4.5 l3 3.5 l-4.2 0.8" stroke="#2f80ed" stroke-width="1.6" fill="none" stroke-linecap="round"/>`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 46 26" aria-hidden="true"><defs><pattern id="cz-h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#fff"/><rect width="2.5" height="5" fill="#e8483f"/></pattern></defs>${road}${body}</svg>`;
}

/**
 * Перестройка готовой дороги (rebuild.ts): что сейчас с движением — схемой и коротко (работы не начаты — ездят по
 * прежней; идут — перекрыта по полосам «открыто 1 из 2 · 30 км/ч» или целиком — объезд; перенос — перекрыта сразу) и
 * выбор перекрытия: ◐ по полосам (часть открыта, стройка ×1,5 дольше) или ⛔ целиком (объезд, быстрее). Не перестройка
 * — ничего.
 */
function closureHtml(game: Game, info: ProjectInfo): string {
  const r = game.construction.rebuildOf(info.project.id);
  if (!r) return '';
  const K = CONSTRUCTION.rebuild;
  const id = info.project.id;
  const allMoved = r.moved === r.count;
  const part = r.part > 0;
  const zone = `${K.zone} км/ч`;
  const status = allMoved
    ? { kind: 'full' as const, text: '⛔ перенос: перекрыта до конца работ', tip: 'Дорогу кладут на новом месте — прежней там уже нет: машины объезжают, пока не достроят' }
    : !r.closed
      ? { kind: 'open' as const, text: '🟢 открыта — перекроют, когда начнут', tip: 'Бригада ещё не начала: ездят по прежней дороге, как раньше' }
      : part && r.open
        ? { kind: 'part' as const, text: `◐ открыто ${r.open[0]} из ${r.open[1]} · ${zone}`, tip: `Работы идут половинами: по прежней дороге открыто ${r.open[0]} из ${r.open[1]} полос, скорость — ${zone}; на дороге в одну полосу в каждую сторону — движение в одну сторону, обратно — объезд` }
        : { kind: 'full' as const, text: '⛔ перекрыта — объезд', tip: 'Дорога закрыта целиком: машины объезжают, пока не достроят' };
  const pick = allMoved
    ? ''
    : `<div class="pc-closure-pick">
      <button class="small pc-closure-opt${part ? ' primary' : ''}" data-action="project-closure" data-id="${id}" data-on="1" data-tip="${esc(`По полосам: открыта половина прежних полос (на 1+1 — одна, в одну сторону), ${zone}; стройка в ${String(K.partial).replace('.', ',')} раза дольше`)}">${closureSvg('part', 38, 22)}<span>◐</span></button>
      <button class="small pc-closure-opt${part ? '' : ' primary'}" data-action="project-closure" data-id="${id}" data-on="0" data-tip="Целиком: дорога закрыта, машины объезжают; стройка быстрее">${closureSvg('full', 38, 22)}<span>⛔</span></button></div>`;
  const what = `<span class="pc-chip" data-tip="${esc(`Перестройка готовой дороги: ${meters(r.length)}${r.moved ? `, перенесено полотен — ${r.moved}` : ''}`)}">🚧 <b>${meters(r.length)}</b></span>`;
  return `<div class="pc-block pc-closure"><div class="pc-row">${what}<span class="pc-closure-now" data-tip="${esc(status.tip)}">${closureSvg(status.kind)}<b>${esc(status.text)}</b></span></div>${pick}</div>`;
}

/** Готовность: общая полоска с процентом и три этапа. */
function progressHtml(info: ProjectInfo): string {
  const all = Math.min(99, pct(info.done));
  const stages = (info.project.rail ? RAIL_STAGES : STAGES).map((s, i) => {
    const v = pct(info.stages[i]);
    return `<div class="pc-stage" data-tip="${esc(`${s.name}: ${v}% — ${s.tip}`)}"><i class="pc-tile" style="background:${s.color}"></i>
      <span class="pc-mini"><i style="width:${v}%;background:${s.color}"></i></span><b>${v}%</b></div>`;
  }).join('');
  return `<div class="pc-block"><div class="pc-bar" data-tip="Готово ${all}% — участки от узла до узла открываются сразу"><i style="width:${all}%"></i><b>${all}%</b></div>
    <div class="pc-stages">${stages}</div></div>`;
}

/** Сколько ещё: при нынешних бригадах и с ещё одной. */
function timeHtml(game: Game, info: ProjectInfo): string {
  const p = info.project;
  const rail = railTrainStatus(game, p.id);
  if (rail) {
    // Ж/д: строит строительный поезд — сколько ещё, или почему стоит (нет вокзала, нет пути к стройке).
    if (!p.paused && !info.access && info.waits)
      return `<div class="pc-row"><span class="pc-time" data-tip="Начало — у соседнего строящегося пути: начнётся, когда тот дорастёт сюда">⏳ <b>после соседнего</b></span></div>`;
    if (!p.paused && rail.bad) return `<div class="pc-row"><span class="pc-time pc-bad" data-tip="${esc(rail.tip)}">⛔ <b>стоит: ${rail.text}</b></span></div>`;
    const now = p.paused
      ? `<span class="pc-time" data-tip="На паузе: стройка стоит">⏸ <b>стоит</b></span>`
      : `<span class="pc-time" data-tip="${esc(rail.working ? 'Сколько ещё строить на скорости ×1' : 'Сколько займёт, когда строительный поезд встанет у края работ')}">🚂 ⏳ <b>${durationText(info.seconds)}</b></span>`;
    return `<div class="pc-row">${now}</div>`;
  }
  const crew = game.construction.crews.working(p.id).length;
  const trucks = (n: number) => '🚚'.repeat(Math.max(1, Math.min(3, n)));
  if (!p.paused && !info.access && info.waits && game.construction.crews.bases.size)
    return `<div class="pc-row"><span class="pc-time" data-tip="Подъезд — через соседний строящийся проект: начнётся, когда тот дорастёт сюда">⏳ <b>после соседнего</b></span></div>`;
  if (!p.paused && !info.access && game.construction.crews.bases.size)
    return `<div class="pc-row"><span class="pc-time pc-bad" data-tip="Бригадам не доехать по дорогам ни с одной базы — стройка ждёт подъезда">⛔ <b>стоит: нет подъезда</b></span></div>`;
  if (info.noBase && game.construction.crews.bases.size)
    return `<div class="pc-row"><span class="pc-time pc-bad" data-tip="${esc(`Стройка дальше ${km(CONSTRUCTION.serviceRadius)} от всех баз: бригады сами сюда не поедут`)}">⛔ <b>стоит: нет базы рядом</b></span></div>`;
  const now = p.paused
    ? `<span class="pc-time" data-tip="На паузе: стройка стоит">⏸ <b>стоит</b></span>`
    : `<span class="pc-time" data-tip="${esc(crew ? `Сколько ещё строить на скорости ×1: бригад на месте — ${crew}` : 'Сколько займёт с одной бригадой с ближайшей базы, когда она приедет')}">${trucks(crew)} ⏳ <b>${durationText(info.seconds)}</b></span>`;
  const plus =
    info.secondsPlus !== null && !p.paused
      ? `<span class="pc-arrow">→</span><span class="pc-time plus" data-tip="${esc(`С ещё одной бригадой (её вклад меньше: бригады мешают друг другу) — на ${durationText(info.seconds - info.secondsPlus)} быстрее`)}">＋🚚 ⏳ <b>${durationText(info.secondsPlus)}</b></span>`
      : !p.paused && crew >= game.construction.crews.cap(p.id)
        ? `<span class="muted" data-tip="Больше ${game.construction.crews.cap(p.id)} бригад на этот проект не встанет${game.construction.crews.cap(p.id) < CONSTRUCTION.brigade.perProject ? ' — полотно в одну полосу' : ''}">максимум бригад</span>`
        : '';
  return `<div class="pc-row">${now}${plus}</div>`;
}

/** Деньги: полоска «потрачено / в резерве / ещё нужно», хватает ли, резерв. */
function moneyHtml(game: Game, info: ProjectInfo): string {
  const p = info.project;
  const reserve = Math.min(p.reserve ?? 0, info.left);
  const total = p.spent + info.left;
  const k = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const free = Math.max(0, Math.floor(game.budget));
  const need = info.left - (p.reserve ?? 0);
  const enough = need <= free;
  const bar = `<div class="pc-money" data-tip="${esc(`Всего ${money(total)}: потрачено ${money(p.spent)}${reserve ? `, в резерве ${money(reserve)}` : ''}, ещё нужно ${money(info.left - reserve)}`)}">
    <i class="spent" style="width:${k(p.spent)}%"></i><i class="res" style="width:${k(reserve)}%"></i></div>`;
  const legend = `<div class="pc-legend">
    <span data-tip="Уже заплачено за готовые метры"><i class="dot spent"></i>${money(p.spent)}</span>
    ${reserve ? `<span data-tip="Отложено на этот проект: другие траты эти деньги не возьмут"><i class="dot res"></i>🔒 ${money(reserve)}</span>` : ''}
    ${info.left - reserve > 0 ? `<span data-tip="${reserve ? 'Ещё нужно сверх резерва' : 'Сколько ещё стоит достроить'}"><i class="dot left"></i>${money(info.left - reserve)}</span>` : ''}
    <span class="pc-total" data-tip="Стоимость проекта целиком">Σ <b>${money(total)}</b></span></div>`;
  const status =
    need <= 0
      ? `<span class="pc-ok" data-tip="Всё, что нужно, отложено: стройка не встанет без денег">🔒 ✓ резерв покрывает всё</span>`
      : enough
        ? `<span class="pc-ok" data-tip="${esc(`Свободно ${money(free)} — хватает на остаток, если не потратить на другое`)}">✓ денег хватает</span>`
        : `<span class="pc-bad" data-tip="${esc(`Свободно ${money(free)}, а нужно ещё ${money(need)}: стройка встанет, когда деньги кончатся`)}">💸 не хватает ${money(need - free)}</span>`;
  const canReserve = need > 0 && free > 0;
  const reserveBtn =
    need > 0
      ? `<button class="small" data-action="project-reserve" data-id="${p.id}" data-on="1" ${canReserve ? '' : 'disabled'} data-tip="${esc(
          canReserve
            ? `Отложить ${money(Math.min(need, free))} на этот проект: другие траты (покупки, стройки, авто-парк) их не возьмут, а стройка не встанет без денег`
            : 'Свободных денег нет — отложить нечего',
        )}">🔒 ${p.reserve ? 'Доложить' : 'Зарезервировать'} ${money(Math.min(need, Math.max(free, 0)) || need)}</button>`
      : '';
  const unreserve = p.reserve
    ? `<button class="small" data-action="project-reserve" data-id="${p.id}" data-on="0" data-tip="Снять резерв: деньги снова свободны для любых трат">🔓 Снять резерв</button>`
    : '';
  return `<div class="pc-block"><div class="pc-title">💰 Деньги ${status}</div>${bar}${legend}<div class="pc-actions">${reserveBtn}${unreserve}</div></div>`;
}

/** Бригады на проекте: самосвал, номер и база, что делает; клик — к ней на карте. Нет никого — почему и как помочь. */
function crewsHtml(game: Game, info: ProjectInfo): string {
  const p = info.project;
  const rail = railTrainStatus(game, p.id);
  if (rail) {
    // Ж/д: вместо бригад — строительный поезд: что делает, откуда; стоит — почему и что сделать.
    const fix = rail.bad
      ? `<div class="pc-why"><span class="pc-why-ic">⛔</span><span>${esc(rail.tip)}</span><button class="small" data-action="tool" data-id="station" data-tip="Инструмент «Станция»: вокзал — на готовом пути">＋ Вокзал</button></div>`
      : '';
    // Поезд уже на путях — чип кнопкой: к поезду на карте и его карточка (закрытие вернёт сюда). Ещё нет — подпись.
    const w = game.construction.trains?.of(p.id);
    const chip =
      w && w.train !== undefined
        ? `<button class="pc-time pc-link" data-action="worktrain-show" data-id="${w.id}" data-tip="${esc(`${rail.tip} — показать поезд на карте и открыть его`)}">🚂 <b>${esc(rail.text)}</b> ›</button>`
        : `<span class="pc-time${rail.bad ? ' pc-bad' : ''}" data-tip="${esc(rail.tip)}">🚂 <b>${esc(rail.text)}</b></span>`;
    return `<div class="pc-block"><div class="pc-title">🚂 Строительный поезд</div>
      <div class="pc-row">${chip}</div>${fix}</div>`;
  }
  const crews = game.construction.crews;
  const list = crews.assigned(p.id);
  const at = info.front ?? info.at;
  const rows = list
    .map((b) => {
      const n = crews.of(b.base).indexOf(b) + 1;
      const st = CREW_STATE[b.state];
      const power = Math.round(crews.power(b, at) * 100);
      const where = game.brigadeWhere(b.id);
      const pin = b.pinned ? `<span data-tip="Назначена вами: автоматика её отсюда не перебросит">📌</span> ` : '';
      return `<button class="pc-crew ${b.state}" data-action="crew-show" data-id="${b.id}" data-tip="${esc(`Бригада ${n} базы «${game.baseName(b.base)}»: ${where?.text ?? st.text} — открыть бригаду и показать на карте`)}">
        <span class="bb-crew ${b.state}">🚚${st.mark ? `<i>${st.mark}</i>` : ''}</span>
        <span class="pc-crew-name"><b>№${n}</b> · ${pin}${esc(game.baseName(b.base))}</span>
        <span class="pc-crew-state">${st.mark} ${crewDoing(b)}</span>
        <span class="pc-mini" data-tip="${esc(`Сила бригады ${power}%: чем дальше база от стройки, тем медленнее`)}"><i style="width:${power}%"></i></span></button>`;
    })
    .join('');
  // Сколько встанет: на узком проекте (полотно в одну полосу) — меньше (crews.cap).
  const cap = crews.cap(info.project.id);
  const title = `<div class="pc-title">🚚 Бригады <b>${list.length}</b><span class="muted"> из ${cap}</span></div>`;
  if (rows) return `<div class="pc-block">${title}<div class="pc-crews">${rows}</div>${list.length < cap ? helpHtml(game, info, true) : ''}</div>`;
  return `<div class="pc-block">${title}${helpHtml(game, info, false)}</div>`;
}

/** Почему бригад нет (или мало) и кнопка, которая поможет: поставить базу, нанять, приоритет, снять с паузы. */
function helpHtml(game: Game, info: ProjectInfo, some: boolean): string {
  const p = info.project;
  const crews = game.construction.crews;
  const at = info.front ?? info.at;
  const near = crews.nearestBase(at);
  const hire = (why: string) => {
    if (!near) return '';
    const full = crews.of(near.base.id).length >= CONSTRUCTION.base.maxBrigades;
    return full
      ? `<span class="muted" data-tip="На базе не больше ${CONSTRUCTION.base.maxBrigades} бригад — поставьте ещё базу («＋ База» внизу слева)">база заполнена</span>`
      : `<button class="small" data-action="base-hire" data-id="${near.base.id}" data-tip="${esc(`${why} Нанять бригаду на базе «${game.baseName(near.base.id)}» (ближайшей): ${money(CONSTRUCTION.brigade.cost)}`)}">＋ 🚚 ${money(CONSTRUCTION.brigade.cost)}</button>`;
  };
  const why = (icon: string, text: string, buttons: string) => `<div class="pc-why"><span class="pc-why-ic">${icon}</span><span>${text}</span>${buttons}</div>`;
  // «＋ База · бесплатно» / «＋ База · $40 000» — сколько встанет база, видно сразу на кнопке.
  const price = basePrices(game);
  const addBase = (tip: string) => `<button class="small" data-action="base-place" data-tip="${esc(tip)}">＋ База · ${basePriceText(price.now)}</button>`;
  if (p.paused) return some ? '' : why('⏸', 'На паузе — бригады ушли на другие проекты', `<button class="small" data-action="build-pause" data-id="${p.id}" data-tip="Строить дальше">▶ Дальше</button>`);
  if (!crews.bases.size)
    return why(
      '🏚',
      'Нет строительной базы',
      addBase(`Поставьте базу у дороги, ближе к стройке${game.firstBase ? ` — первая бесплатно, следующие — по ${money(price.next)}` : ''}`),
    );
  if (!info.access && info.waits) return why('⏳', 'После соседнего: подъезд — через соседний строящийся проект, начнётся, когда тот дорастёт сюда', '');
  if (!info.access)
    return why(
      '⛔',
      'Нет подъезда: ни один конец проекта не связан готовой дорогой с базой, а по полю бригады не ездят. Постройте дорогу к началу проекта или поставьте базу у дороги рядом с ним',
      addBase('Поставьте базу у дороги, связанной с проектом: бригада доедет по ней'),
    );
  if (!info.near)
    return why(
      '⛔',
      `Нет базы рядом: стройка дальше ${km(CONSTRUCTION.serviceRadius)} от всех баз — бригады сами сюда не поедут. Поставьте базу поближе или отправьте бригаду вручную («🎯 На стройку…» в её карточке) — строить она будет медленно`,
      addBase(`Поставьте базу у дороги ближе ${km(CONSTRUCTION.serviceRadius)} к стройке: её бригады поедут сюда сами`),
    );
  if (!crews.brigades.size) return why('🚫', 'Нет ни одной бригады', hire('Строить некому.'));
  const busy = [...crews.brigades.values()].every((b) => b.project !== undefined && b.project !== p.id && (b.state === 'going' || b.state === 'working'));
  if (some) return why('➕', 'Ещё бригада — быстрее', hire('Свободная бригада поедет туда, где рук меньше, — приоритетный проект первым.'));
  if (busy)
    return why('⏳', `Все бригады заняты на других проектах${p.priority ? '' : ' — «⬆ Приоритет» заберёт одну сюда'}`, hire('Или наймите ещё.'));
  return why('➜', 'Бригада скоро выедет', '');
}

/** Приоритет, пауза, отмена. */
function actionsHtml(info: ProjectInfo): string {
  const p = info.project;
  const prio = p.priority
    ? `<button class="small primary" data-action="project-priority" data-id="${p.id}" data-on="0" data-tip="Приоритетный проект: бригады едут сначала сюда. Нажмите — снова обычный">⬆ Приоритет ✓</button>`
    : `<button class="small" data-action="project-priority" data-id="${p.id}" data-on="1" data-tip="Сделать приоритетным: свободные бригады — сначала сюда, а не хватит — бригада перейдёт сюда с обычного проекта">⬆ Приоритет</button>`;
  const pause = p.paused
    ? `<button class="small" data-action="build-pause" data-id="${p.id}" data-tip="Строить дальше">▶ Дальше</button>`
    : `<button class="small" data-action="build-pause" data-id="${p.id}" data-tip="Пауза: проект стоит и не тратит денег">⏸ Пауза</button>`;
  const cancel = `<button class="small" data-action="build-cancel" data-id="${p.id}" data-tip="Отмена: недостроенное убрать, деньги за него — назад, резерв — снова свободен; готовые участки остаются (Ctrl+Z вернёт)">✕ Отмена</button>`;
  // Ж/д проект строит свой поезд, бригады к нему не едут — приоритет ни к чему.
  return `<div class="actions pc-actions">${p.rail ? '' : prio}${pause}${cancel}</div>`;
}
