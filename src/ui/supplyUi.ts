/**
 * Снабжение города в его карточке — с переносом излишков (world/townSupply.ts): полоска месяца, где пришедшее
 * из прошлого месяца — штриховкой в начале, и подпись со значками переноса: «↪ 7» со штриховкой — столько
 * засчитано из прошлого месяца, «+5 ↪» — столько сверх нормы уйдёт в следующий. Блок «Что нужно городу»
 * сворачивается до одной строки: значки грузов в кольцах заполнения и «✓ 2 из 5», подробности — в подсказках.
 * Последняя строка блока — пассажиры (game/townPax.ts): сколько хотят ездить по городу и в другие города и сколько
 * довезли линии; на рост они влияют сами (приехавшие), поэтому в «✓ из» не входят.
 */
import { CARGO, type CargoType } from '../world/cargo';
import { supplyCarry } from '../world/townSupply';
import { chevronSvg } from './icons';
import { cargoIcon, TOWN_COLOR, townIcon } from './cargoIcons';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const pct = (v: number, need: number) => Math.max(0, Math.min(100, (v / Math.max(1, need)) * 100));

/** Полоска месяца: перенесённое из прошлого — штриховкой, привезённое в этом — сплошной, до нормы. */
export function supplyBarHtml(now: number, carried: number, need: number, color: string): string {
  const carry = pct(Math.min(carried, now), need);
  const fresh = Math.max(0, pct(now, need) - carry);
  const hatch = carry > 0 ? `<div class="carry" style="width:${carry.toFixed(1)}%;--c:${color}"></div>` : '';
  return `<div class="bar supply-bar">${hatch}<div style="width:${fresh.toFixed(1)}%;background:${color}"></div></div>`;
}

/**
 * Подпись под полоской: этот месяц (с переносом из прошлого и в следующий) и прошлый. Норма растёт с населением:
 * прошлый месяц сверяем с его нормой (lastNeed), если она другая.
 */
export function supplyLineHtml(now: number, carried: number, last: number, need: number, color: string, lastNeed = need): string {
  const n = (v: number) => Math.round(v);
  const into =
    carried > 0
      ? `<span class="carry-chip" data-tip="Излишек прошлого месяца: ${n(carried)} сверх нормы засчитано в этот месяц"><i style="--c:${color}"></i>↪ ${n(carried)}</span> `
      : '';
  const out = supplyCarry(now, need);
  const next = out > 0 ? ` <span class="carry-chip" data-tip="Сверх нормы: ${n(out)} перейдёт в следующий месяц (не больше нормы)">+${n(out)} ↪</span>` : '';
  return `${into}в этом месяце ${n(now)} из ${need}${now >= need ? ' ✓' : ''}${next} · в прошлом ${n(last)}${lastNeed !== need ? ` из ${lastNeed}` : ''}${last >= lastNeed ? ' ✓' : ''}`;
}

/** Потребность города — для блока «Что нужно городу». */
export interface TownNeed {
  cargo: CargoType;
  /** Привезено в этом месяце — вместе с перенесённым из прошлого. */
  now: number;
  /** Из него перенесено из прошлого месяца. */
  carried: number;
  /** Итог прошлого месяца. */
  last: number;
  /** Норма прошлого месяца, если она не та, что сейчас (город вырос). */
  lastNeed?: number;
}

/** Потребность в этом месяце: закрыта, закрыта частично или ничего не привезли. */
export function needLevel(now: number, need: number): 'ok' | 'part' | 'none' {
  return now >= need ? 'ok' : now > 0 ? 'part' : 'none';
}

/** Подсказка значка в свёрнутой строке — то же, что в подписи под полоской развёрнутого блока. */
export function needTip(n: TownNeed, need: number): string {
  const r = Math.round;
  const parts = [`${CARGO[n.cargo].name}: в этом месяце ${r(n.now)} из ${need}${n.now >= need ? ' ✓' : ''}`];
  if (n.carried > 0) parts.push(`${r(n.carried)} — излишек прошлого месяца`);
  const out = supplyCarry(n.now, need);
  if (out > 0) parts.push(`${r(out)} сверх нормы перейдёт в следующий`);
  const lastNeed = n.lastNeed ?? need;
  parts.push(`в прошлом ${r(n.last)}${lastNeed !== need ? ` из ${lastNeed}` : ''}${n.last >= lastNeed ? ' ✓' : ''}`);
  return parts.join(' · ');
}

const RING_R = 10.6;
const RING_LEN = 2 * Math.PI * RING_R;

/**
 * Значок груза в кольце: дуга — сколько привезли в этом месяце из нормы (цветом груза); закрыто — кольцо целиком
 * зелёное и галочка, ничего не привезли — значок бледный.
 */
function needDotHtml(n: TownNeed, need: number): string {
  const level = needLevel(n.now, need);
  const arc = (pct(n.now, need) / 100) * RING_LEN;
  const color = level === 'ok' ? '#2e9d57' : CARGO[n.cargo].color;
  const fill =
    arc > 0
      ? `<circle cx="12" cy="12" r="${RING_R}" stroke="${color}" stroke-dasharray="${arc.toFixed(1)} ${RING_LEN.toFixed(1)}" transform="rotate(-90 12 12)"/>`
      : '';
  return `<span class="need-dot ${level}" data-tip="${needTip(n, need)}"><svg class="ring" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle class="track" cx="12" cy="12" r="${RING_R}"/>${fill}</svg>${cargoIcon(n.cargo, 16, false)}</span>`;
}

/** Свёрнутый блок «Что нужно городу» — одной строкой: значки грузов в кольцах заполнения и «✓ 2 из 5». */
export function needsFoldHtml(needs: readonly TownNeed[], need: number, pax?: PaxNeed): string {
  if (!needs.length) return '';
  const ok = needs.filter((n) => n.now >= need).length;
  const okLast = needs.filter((n) => n.last >= (n.lastNeed ?? need)).length;
  const cls = ok === needs.length ? ' all' : ok ? '' : ' none';
  const tip = `Закрыто в этом месяце: ${ok} из ${needs.length} · в прошлом: ${okLast} из ${needs.length}`;
  // Пассажиры — отдельным значком после счётчика: в «✓ из» они не входят (на рост влияют сами, см. PAX_GROWTH_TIP).
  const paxDot = pax && paxTotal(pax.want) > 0 ? paxDotHtml(pax) : '';
  return `<span class="need-dots">${needs.map((n) => needDotHtml(n, need)).join('')}</span><span class="need-count${cls}" data-tip="${tip}">✓ ${ok} из ${needs.length}</span>${paxDot}`;
}

/** Подсказка у «?» после заголовка блока. */
export const NEEDS_HINT =
  'Каждая закрытая потребность ускоряет рост города. Привозите груз на станцию в черте города. Чем больше жителей, тем больше нужно в месяц. Пассажиры в «✓ из» не входят: город растёт от каждого, кто в него приехал.';

/**
 * Заголовок «Что нужно городу»: сворачивает блок, как «Куда везти». После названия — «?» с подсказкой о росте
 * (клик по нему блок не сворачивает), у свёрнутого — вся сводка одной строкой (needsFoldHtml).
 */
export function needsHeadHtml(needs: readonly TownNeed[], need: number, folded: boolean, pax?: PaxNeed): string {
  return `<button class="fold-head needs-head" data-action="toggle-needs" data-tip="${folded ? 'Развернуть' : 'Свернуть'}"><h4>Что нужно городу</h4><span class="help-q" data-action="hint" data-tip="${NEEDS_HINT}">?</span>${
    folded ? needsFoldHtml(needs, need, pax) : ''
  }<span class="caret ${folded ? 'closed' : ''}">${chevronSvg(10)}</span></button>`;
}

// ---------- Пассажиры ----------

/** Поездки по городу и в другие города (world/townPax.ts). */
export interface PaxPair {
  city: number;
  intercity: number;
}

/** Направление поездок в строке пассажиров. */
export interface PaxNeedDest {
  /** id города; -1 — станции за городом (на них не перейти). */
  town: number;
  name: string;
  /** Довезли туда в этом месяце. */
  now: number;
  /** Ждут на станциях поездки туда. */
  waiting: number;
  /** Ходит ли туда пассажирская линия. */
  linked: boolean;
}

/** Пассажиры города для блока «Что нужно городу» — то, что собирает game/townPax.ts, с готовыми именами и значками. */
export interface PaxNeed {
  want: PaxPair;
  now: PaxPair;
  last: PaxPair;
  /** Доля жителей у остановок с линиями (0…1). */
  covered: number;
  waiting: number;
  /** Значки пассажирских линий города (кнопки, готовым HTML). */
  linesHtml: string;
  dests: PaxNeedDest[];
}

const paxTotal = (p: PaxPair) => p.city + p.intercity;
const PAX_COLOR = CARGO.passengers.color;

/** Подсказка о росте от пассажиров — у значка пассажиров. */
export const PAX_GROWTH_TIP = 'Каждый довезённый пассажир ускоряет рост города, куда он приехал';

/** Значок «в другие города»: кружок цвета города со стрелками туда и обратно. */
export function intercityIcon(size = 16): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="${TOWN_COLOR}"/><path d="M5.5 9.5h11M13.5 6.5l3 3-3 3M18.5 14.5h-11M10.5 11.5l-3 3 3 3" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Подсказка строки «по городу» / «в другие города»: хотят, довезли, прошлый месяц. */
export function paxKindTip(kind: 'city' | 'intercity', p: PaxNeed): string {
  const r = Math.round;
  const what = kind === 'city' ? 'По городу' : 'В другие города';
  const now = p.now[kind];
  const want = p.want[kind];
  return `${what}: хотят ездить ${want} в месяц · довезли ${r(now)}${now >= want ? ' ✓' : ''} · в прошлом ${r(p.last[kind])}`;
}

/** Строка «по городу» / «в другие города»: значок, полоска довезённого из желающих и «12 / 36». */
function paxKindHtml(kind: 'city' | 'intercity', p: PaxNeed): string {
  const now = p.now[kind];
  const want = p.want[kind];
  const icon = kind === 'city' ? townIcon(16, false) : intercityIcon(16);
  const done = now >= want && want > 0;
  return `<div class="pax-kind${done ? ' ok' : ''}" data-tip="${paxKindTip(kind, p)}">${icon}<div class="bar"><div style="width:${pct(now, want).toFixed(1)}%;background:${
    done ? '#2e9d57' : PAX_COLOR
  }"></div></div><span class="pax-n"><b>${Math.round(now)}</b> / ${want}</span></div>`;
}

/** Направление: город (клик — к нему), сколько довезли и сколько ждут; без линии — бледное. */
function paxDestHtml(d: PaxNeedDest): string {
  const tip = d.linked
    ? `${d.name}: довезли ${Math.round(d.now)} в этом месяце${d.waiting ? ` · ждут ${d.waiting}` : ''}`
    : `${d.name}: линии нет — жители ездят туда на машине`;
  const body = `→ ${esc(d.name)}${d.linked ? ` <b>${Math.round(d.now)}</b>` : ''}${d.waiting ? ` <i>⏳${d.waiting}</i>` : ''}`;
  const cls = `pax-dest${d.linked ? '' : ' off'}`;
  return d.town >= 0
    ? `<button class="${cls}" data-action="focus" data-type="town" data-id="${d.town}" data-tip="${esc(tip)}">${body}</button>`
    : `<span class="${cls}" data-tip="${esc(tip)}">${body}</span>`;
}

/** Подпись под строкой пассажиров: охват остановок, сколько ждут и итог прошлого месяца. */
export function paxLineHtml(p: PaxNeed): string {
  const share = Math.round(p.covered * 100);
  const cover = `<span class="carry-chip" data-tip="${
    share ? `У остановок с линиями живёт ${share}% горожан — остальные ездят на машине` : 'Ни одной остановки с линией — все ездят на машине'
  }">🚏 ${share}%</span>`;
  const wait = p.waiting ? ` <span class="carry-chip" data-tip="Ждут автобус или поезд на станциях города">⏳ ${p.waiting}</span>` : '';
  const last = paxTotal(p.last);
  const want = paxTotal(p.want);
  return `${cover}${wait} · в прошлом ${Math.round(last)} из ${want}${last >= want ? ' ✓' : ''}`;
}

/**
 * Строка «Пассажиры» в развёрнутом блоке: значки линий, полоски «по городу» и «в другие города» (довезли из тех,
 * кто хочет ездить), направления и подпись с охватом остановок. Пустая строка, если жителей нет.
 */
export function paxNeedHtml(p: PaxNeed): string {
  if (paxTotal(p.want) <= 0) return '';
  const dests = p.dests.length ? `<div class="pax-dests">${p.dests.map(paxDestHtml).join('')}</div>` : '';
  return `<div class="need pax-need"><span class="pax-ic" data-tip="${PAX_GROWTH_TIP}">${cargoIcon('passengers', 24, false)}</span><div>
    <span class="pax-title"><b>Пассажиры</b>${p.linesHtml ? `<span class="pax-lines">${p.linesHtml}</span>` : ''}</span>
    ${paxKindHtml('city', p)}${paxKindHtml('intercity', p)}${dests}
    <small>${paxLineHtml(p)}</small></div></div>`;
}

/** Значок пассажиров в свёрнутой строке: кольцо — сколько довезли из желающих ездить. */
function paxDotHtml(p: PaxNeed): string {
  const now = paxTotal(p.now);
  const want = paxTotal(p.want);
  const level = needLevel(now, want);
  const arc = (pct(now, want) / 100) * RING_LEN;
  const color = level === 'ok' ? '#2e9d57' : PAX_COLOR;
  const fill =
    arc > 0
      ? `<circle cx="12" cy="12" r="${RING_R}" stroke="${color}" stroke-dasharray="${arc.toFixed(1)} ${RING_LEN.toFixed(1)}" transform="rotate(-90 12 12)"/>`
      : '';
  const tip = `Пассажиры: довезли ${Math.round(now)} из ${want} желающих в этом месяце · ${PAX_GROWTH_TIP.toLowerCase()}`;
  return `<span class="need-dot pax ${level}" data-tip="${tip}"><svg class="ring" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><circle class="track" cx="12" cy="12" r="${RING_R}"/>${fill}</svg>${cargoIcon('passengers', 16, false)}</span>`;
}
