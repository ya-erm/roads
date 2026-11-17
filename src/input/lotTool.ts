import { money } from '../core/moneyText';
import type { Vec } from '../core/vec';
import type { Game, LotPlan } from '../game/game';
import type { LotOverlay } from '../render/renderer';
import type { LotGate } from '../world/entities';
import { LOT, lotCols, lotDepth, lotLayout, lotLocal, lotRows, type LotRows } from '../world/parkingLots';
import type { Footprint } from '../world/spatial';

/**
 * «🅿️ Площадка» (в «Станции», docs/PARKING.md, этап 3): предпросмотр участка с местами и воротами у курсора, ручки
 * выбранной площадки (углы у дальнего края — размер шагом места и модулем глубины, ручка поворота), клик по краю у
 * улицы — ворота. Решения — Game.lotPlan / lotCheck; тут — только геометрия ручек и что показать.
 */

/** Что знает инструмент: что делает клик, выбрано ли что, переносят ли, тянут ли ручку, размер, Alt. */
export interface LotToolState {
  action: string;
  selection: { type: string; id?: number } | null;
  movingLot: number | null;
  lotDrag: { id: number; kind: 'corner' | 'rotate'; side: -1 | 1 } | null;
  lotCols: number;
  lotRows: LotRows;
  lotAngle: number;
  alt: boolean;
}

/** Ручка поворота — на столько ед. за дальним краем. */
const ROT_OFF = 9;

/** Ручки площадки: углы у дальнего от улицы края (side — какой край по оси участка), поворот — за серединой края. */
export function lotHandles(fp: Footprint): { pos: Vec; kind: 'corner' | 'rotate'; side: -1 | 1 }[] {
  const at = (x: number, y: number): Vec => {
    const c = Math.cos(fp.angle);
    const s = Math.sin(fp.angle);
    return { x: fp.center.x + x * c - y * s, y: fp.center.y + x * s + y * c };
  };
  return [
    { pos: at(-fp.w / 2, fp.h / 2), kind: 'corner', side: -1 },
    { pos: at(fp.w / 2, fp.h / 2), kind: 'corner', side: 1 },
    { pos: at(0, fp.h / 2 + ROT_OFF), kind: 'rotate', side: 1 },
  ];
}

/** Ручка выбранной площадки id у точки p (не дальше r). */
export function lotHandleAt(g: Game, id: number, p: Vec, r: number): { kind: 'corner' | 'rotate'; side: -1 | 1 } | null {
  const ref = g.lotById(id);
  if (!ref) return null;
  for (const h of lotHandles(ref.lot.fp)) if (Math.hypot(h.pos.x - p.x, h.pos.y - p.y) <= r) return { kind: h.kind, side: h.side };
  return null;
}

/** Клик у края площадки id к улице (между краем участка и бордюром, по ширине участка) — по воротам. */
export function lotGateHit(g: Game, id: number, p: Vec): boolean {
  const ref = g.lotById(id);
  if (!ref) return false;
  const q = lotLocal(ref.lot.fp, p);
  const H = ref.lot.fp.h;
  return Math.abs(q.x) <= ref.lot.fp.w / 2 && q.y >= -H / 2 - LOT.setback - 1 && q.y <= -H / 2 + 4;
}

/** План по ручке: размер (угол у дальнего края — край у улицы на месте) или поворот (шагом LOT.turn). */
export function lotDragPlan(g: Game, drag: NonNullable<LotToolState['lotDrag']>, p: Vec): LotPlan | null {
  const ref = g.lotById(drag.id);
  if (!ref) return null;
  const fp = ref.lot.fp;
  if (drag.kind === 'rotate') return g.lotRotatePlan(drag.id, Math.atan2(p.y - fp.center.y, p.x - fp.center.x) - Math.PI / 2);
  const q = lotLocal(fp, p);
  const fixed = -drag.side * (fp.w / 2);
  const cols = lotCols(Math.abs(q.x - fixed) + LOT.stall.w / 2);
  const rows = lotRows(Math.max(lotDepth(1), q.y + fp.h / 2));
  return g.lotResizePlan(drag.id, cols, rows, drag.side);
}

/** Подпись плана у курсора: «🅿️ 12 · $3 400» (перенос, правка — со стрелкой), нельзя — причина. */
export function lotPlanText(plan: LotPlan, what = ''): { text: string; ok: boolean } {
  if (!plan.ok) return { text: `${plan.reason ?? 'Нельзя'}${plan.cost > 0 ? ` · ${money(plan.cost)}` : ''}`, ok: false };
  const via = plan.big ? ' · ⤴ через перекрёсток' : '';
  const raze = plan.demolish.length ? ` · 🏚 ${plan.demolish.length}` : '';
  const price = plan.cost >= 0 ? money(plan.cost) : `+${money(-plan.cost)}`;
  return { text: `🅿️ ${plan.stalls}${what}${via}${raze} · ${price} · Esc — отмена`, ok: true };
}

/** Что показать: предпросмотр (место, ворота, ручки) и подпись; busy — инструмент занят площадкой (прочее не нужно). */
export function lotOverlay(s: LotToolState, g: Game, p: Vec | null): { lot: LotOverlay | null; label: { text: string; ok: boolean } | null; busy: boolean } {
  const show = (plan: LotPlan | null, old?: Footprint): LotOverlay | null =>
    plan && { fp: plan.fp, gates: plan.gates, ok: plan.ok, bad: plan.badGates, stalls: lotLayout(plan).stalls.map((x) => x.rect), old, handles: [] };
  if (s.lotDrag && p) {
    const ref = g.lotById(s.lotDrag.id);
    const plan = lotDragPlan(g, s.lotDrag, p);
    const o = show(plan, ref?.lot.fp);
    if (o && plan) o.handles = lotHandles(plan.fp).map((h) => ({ pos: h.pos, kind: h.kind }));
    return { lot: o, label: plan ? lotPlanText(plan, s.lotDrag.kind === 'rotate' ? ' ↺' : ' ⤡') : null, busy: true };
  }
  if (s.movingLot !== null && p) {
    const ref = g.lotById(s.movingLot);
    const plan = g.lotMovePlan(s.movingLot, p, s.alt, s.lotAngle);
    return { lot: show(plan, ref?.lot.fp), label: plan ? lotPlanText(plan, ' ✥') : null, busy: true };
  }
  if (s.action === 'lot' && p) {
    const plan = g.lotPlan(p, { cols: s.lotCols, rows: s.lotRows, free: s.alt, angle: s.lotAngle });
    const o = show(plan);
    if (o) o.handles = lotHandles(plan.fp).map((h) => ({ pos: h.pos, kind: h.kind }));
    return { lot: o, label: lotPlanText(plan), busy: true };
  }
  // Выбрана площадка — её ручки и ворота (клик по краю у улицы — ворота).
  if (s.selection?.type === 'lot' && s.selection.id !== undefined) {
    const ref = g.lotById(s.selection.id);
    if (!ref) return { lot: null, label: null, busy: false };
    const o: LotOverlay = { fp: ref.lot.fp, gates: ref.lot.gates, ok: true, stalls: [], handles: lotHandles(ref.lot.fp).map((h) => ({ pos: h.pos, kind: h.kind })), selected: true };
    const gateTip = p && lotGateHit(g, ref.lot.id, p) ? gateHint(ref.lot.gates, lotLocal(ref.lot.fp, p).x) : null;
    return { lot: o, label: gateTip ? { text: gateTip, ok: true } : null, busy: false };
  }
  return { lot: null, label: null, busy: false };
}

/** Подсказка у края площадки: что сделает клик по воротам (или мимо них — новые ворота). */
function gateHint(gates: readonly LotGate[], x: number): string {
  const g = gates.find((q) => Math.abs(q.x - x) < LOT.gateW / 2 + 0.5);
  if (!g) return `＋ ворота ⬌ · ${money(LOT.gateCost)}`;
  const next = g.mode === 'both' ? '⇥ въезд' : g.mode === 'in' ? '↤ выезд' : gates.length > 1 ? '✕ убрать' : '⬌';
  return `Ворота ${g.mode === 'both' ? '⬌' : g.mode === 'in' ? '⇥' : '↤'} → ${next}`;
}
