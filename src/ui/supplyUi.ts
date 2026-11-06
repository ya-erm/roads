/**
 * Снабжение города в его карточке — с переносом излишков (world/townSupply.ts): полоска месяца, где пришедшее
 * из прошлого месяца — штриховкой в начале, и подпись со значками переноса: «↪ 7» со штриховкой — столько
 * засчитано из прошлого месяца, «+5 ↪» — столько сверх нормы уйдёт в следующий.
 */
import { supplyCarry } from '../world/townSupply';

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
