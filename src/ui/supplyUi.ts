/**
 * Снабжение города в его карточке — с переносом излишков (world/townSupply.ts): полоска месяца, где пришедшее
 * из прошлого месяца — штриховкой в начале, и подпись со значками переноса: «↪ 7» со штриховкой — столько
 * засчитано из прошлого месяца, «+5 ↪» — столько сверх нормы уйдёт в следующий. Блок «Что нужно городу»
 * сворачивается до одной строки: значки грузов в кольцах заполнения и «✓ 2 из 5», подробности — в подсказках.
 */
import { CARGO, type CargoType } from '../world/cargo';
import { supplyCarry } from '../world/townSupply';
import { chevronSvg } from './icons';
import { cargoIcon } from './cargoIcons';

const pct = (v: number, need: number) => Math.max(0, Math.min(100, (v / Math.max(1, need)) * 100));

/** Полоска месяца: перенесённое из прошлого — штриховкой, привезённое в этом — сплошной, до нормы. */
export function supplyBarHtml(now: number, carried: number, need: number, color: string): string {
  const carry = pct(Math.min(carried, now), need);
  const fresh = Math.max(0, pct(now, need) - carry);
  const hatch = carry > 0 ? `<div class="carry" style="width:${carry.toFixed(1)}%;--c:${color}"></div>` : '';
  return `<div class="bar supply-bar">${hatch}<div style="width:${fresh.toFixed(1)}%;background:${color}"></div></div>`;
}

/** Подпись под полоской: этот месяц (с переносом из прошлого и в следующий) и прошлый. */
export function supplyLineHtml(now: number, carried: number, last: number, need: number, color: string): string {
  const n = (v: number) => Math.round(v);
  const into =
    carried > 0
      ? `<span class="carry-chip" data-tip="Излишек прошлого месяца: ${n(carried)} сверх нормы засчитано в этот месяц"><i style="--c:${color}"></i>↪ ${n(carried)}</span> `
      : '';
  const out = supplyCarry(now, need);
  const next = out > 0 ? ` <span class="carry-chip" data-tip="Сверх нормы: ${n(out)} перейдёт в следующий месяц (не больше нормы)">+${n(out)} ↪</span>` : '';
  return `${into}в этом месяце ${n(now)} из ${need}${now >= need ? ' ✓' : ''}${next} · в прошлом ${n(last)}${last >= need ? ' ✓' : ''}`;
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
  parts.push(`в прошлом ${r(n.last)}${n.last >= need ? ' ✓' : ''}`);
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
export function needsFoldHtml(needs: readonly TownNeed[], need: number): string {
  if (!needs.length) return '';
  const ok = needs.filter((n) => n.now >= need).length;
  const okLast = needs.filter((n) => n.last >= need).length;
  const cls = ok === needs.length ? ' all' : ok ? '' : ' none';
  const tip = `Закрыто в этом месяце: ${ok} из ${needs.length} · в прошлом: ${okLast} из ${needs.length}`;
  return `<span class="need-dots">${needs.map((n) => needDotHtml(n, need)).join('')}</span><span class="need-count${cls}" data-tip="${tip}">✓ ${ok} из ${needs.length}</span>`;
}

/** Подсказка у «?» после заголовка блока. */
export const NEEDS_HINT = 'Каждая закрытая потребность ускоряет рост города. Привозите груз на станцию в черте города.';

/**
 * Заголовок «Что нужно городу»: сворачивает блок, как «Куда везти». После названия — «?» с подсказкой о росте
 * (клик по нему блок не сворачивает), у свёрнутого — вся сводка одной строкой (needsFoldHtml).
 */
export function needsHeadHtml(needs: readonly TownNeed[], need: number, folded: boolean): string {
  return `<button class="fold-head needs-head" data-action="toggle-needs" data-tip="${folded ? 'Развернуть' : 'Свернуть'}"><h4>Что нужно городу</h4><span class="help-q" data-action="hint" data-tip="${NEEDS_HINT}">?</span>${
    folded ? needsFoldHtml(needs, need) : ''
  }<span class="caret ${folded ? 'closed' : ''}">${chevronSvg(10)}</span></button>`;
}
