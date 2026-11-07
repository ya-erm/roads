/**
 * Карточка проекта стройки (режим «Со строительством») в правой панели — открывается кликом по плашке «🏗 45%» на
 * карте или по значку проекта на плашке слева внизу. Наглядно, значками и полосками:
 * - что строим: название, длина, мосты, тоннели, насыпи и выемки;
 * - готовность: полоска и три этапа (🟫 отсыпка, ⬛ покрытие, ⬜ разметка);
 * - сколько ещё строить при нынешних бригадах и с ещё одной;
 * - деньги: потрачено / в резерве / осталось — полоской, хватает ли сейчас; «🔒 Зарезервировать» и «Снять резерв»;
 * - бригады на проекте (клик — показать на карте); нет никого — почему и кнопка, которая поможет;
 * - «⬆ Приоритет», «⏸ Пауза» / «▶ Дальше», «✕ Отмена».
 * Подсказки — data-tip (не системные).
 */
import { CONSTRUCTION } from '../config';
import { durationText } from '../core/timeText';
import type { ProjectInfo } from '../game/construction';
import type { Brigade } from '../game/crews';
import type { Game } from '../game/game';
import { buildSvg } from './constructionUi';

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

/** Что делает бригада — значок и коротко. */
const CREW_STATE: Record<Brigade['state'], { mark: string; text: string }> = {
  working: { mark: '🏗', text: 'строит' },
  going: { mark: '➜', text: 'едет' },
  back: { mark: '↩', text: 'едет на базу' },
  idle: { mark: '', text: 'на базе' },
};

/** Карточка проекта id; проекта нет (достроен, отменён) — короткая записка. */
export function projectCardHtml(game: Game, id: number): string {
  const info = game.construction.info(id);
  const close = `<button class="icon" data-action="close-sel" data-tip="Закрыть">✕</button>`;
  if (!info) return `<section class="detail project-card"><header><h3>Стройка</h3>${close}</header><p class="muted">✅ Проекта больше нет: достроен или отменён.</p></section>`;
  const p = info.project;
  const prio = p.priority ? `<span class="pc-prio" data-tip="Приоритетный проект: бригады едут сначала сюда">⬆</span>` : '';
  const head = `<header class="pc-head"><button class="icon pc-show" data-action="build-show" data-id="${p.id}" data-tip="Показать на карте">${buildSvg(30, 22)}</button>
    <h3>${esc(p.label)}</h3>${prio}${close}</header>`;
  return `<section class="detail project-card">${head}
    ${whatHtml(game, info)}
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

/** Готовность: общая полоска с процентом и три этапа. */
function progressHtml(info: ProjectInfo): string {
  const all = Math.min(99, pct(info.done));
  const stages = STAGES.map((s, i) => {
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
  const crew = game.construction.crews.working(p.id).length;
  const trucks = (n: number) => '🚚'.repeat(Math.max(1, Math.min(3, n)));
  const now = p.paused
    ? `<span class="pc-time" data-tip="На паузе: стройка стоит">⏸ <b>стоит</b></span>`
    : `<span class="pc-time" data-tip="${esc(crew ? `Сколько ещё строить на скорости ×1: бригад на месте — ${crew}` : 'Сколько займёт с одной бригадой с ближайшей базы, когда она приедет')}">${trucks(crew)} ⏳ <b>${durationText(info.seconds)}</b></span>`;
  const plus =
    info.secondsPlus !== null && !p.paused
      ? `<span class="pc-arrow">→</span><span class="pc-time plus" data-tip="${esc(`С ещё одной бригадой (её вклад меньше: бригады мешают друг другу) — на ${durationText(info.seconds - info.secondsPlus)} быстрее`)}">＋🚚 ⏳ <b>${durationText(info.secondsPlus)}</b></span>`
      : !p.paused && crew >= CONSTRUCTION.brigade.perProject
        ? `<span class="muted" data-tip="Больше ${CONSTRUCTION.brigade.perProject} бригад на один проект не встанет">максимум бригад</span>`
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
  const crews = game.construction.crews;
  const list = crews.assigned(p.id);
  const at = info.front ?? info.at;
  const rows = list
    .map((b) => {
      const n = crews.of(b.base).indexOf(b) + 1;
      const st = CREW_STATE[b.state];
      const power = Math.round(crews.power(b, at) * 100);
      const where = game.brigadeWhere(b.id);
      return `<button class="pc-crew ${b.state}" data-action="crew-show" data-id="${b.id}" data-tip="${esc(`Бригада ${n} базы «${game.baseName(b.base)}»: ${where?.text ?? st.text} — показать на карте`)}">
        <span class="bb-crew ${b.state}">🚚${st.mark ? `<i>${st.mark}</i>` : ''}</span>
        <span class="pc-crew-name"><b>№${n}</b> · ${esc(game.baseName(b.base))}</span>
        <span class="pc-crew-state">${st.mark} ${st.text}</span>
        <span class="pc-mini" data-tip="${esc(`Сила бригады ${power}%: чем дальше база от стройки, тем медленнее`)}"><i style="width:${power}%"></i></span></button>`;
    })
    .join('');
  const title = `<div class="pc-title">🚚 Бригады <b>${list.length}</b><span class="muted"> из ${CONSTRUCTION.brigade.perProject}</span></div>`;
  if (rows) return `<div class="pc-block">${title}<div class="pc-crews">${rows}</div>${list.length < CONSTRUCTION.brigade.perProject ? helpHtml(game, info, true) : ''}</div>`;
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
  if (p.paused) return some ? '' : why('⏸', 'На паузе — бригады ушли на другие проекты', `<button class="small" data-action="build-pause" data-id="${p.id}" data-tip="Строить дальше">▶ Дальше</button>`);
  if (!crews.bases.size)
    return why('🏚', 'Нет строительной базы', `<button class="small" data-action="base-place" data-tip="Поставьте базу у дороги, ближе к стройке${game.firstBase ? ' — первая бесплатно' : ''}">＋ База</button>`);
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
  return `<div class="actions pc-actions">${prio}${pause}${cancel}</div>`;
}
