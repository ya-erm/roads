import type { Vec } from '../core/vec';
import type { TownBuilding } from './entities';

/**
 * Поворот при переносе ратуши (храма) и парков, скверов, площадей (Game.movePlan, Game.parkMovePlan): turn — угол
 * относительно улицы, у которой они встают. 0 — как без поворота: длинной стороной вдоль улицы, лицом (у ратуши —
 * фасадом) к ней. Шаг — 15°, как у площадки-стоянки и ж/д станции (R / Shift+R, ручка ↺); углы, кратные 90°, —
 * снова вдоль или поперёк улицы. Запоминается в ратуше и парке (TownBuilding.turn, TownPark.turn): следующий
 * перенос начинается с него; в старых сохранениях его нет — 0.
 */

/**
 * Здание, которое при переносе можно повернуть: ратуша и храм (площадь вокруг — со всех сторон). Дома — нет: заезд,
 * гараж и места машин во дворе (houseAccess) — от улицы, поперёк неё.
 */
export const turnableBuilding = (b: Pick<TownBuilding, 'kind'>): boolean => b.kind === 'landmark';

/** Шаг поворота: 15°. */
export const TURN_STEP = Math.PI / 12;

/** Ручка поворота — на столько м за дальним от улицы краем (как у площадки-стоянки, input/lotTool). */
export const TURN_HANDLE_OFF = 9;

/** Угол в (−π, π]. */
export function wrapTurn(a: number): number {
  let x = a % (Math.PI * 2);
  if (x <= -Math.PI) x += Math.PI * 2;
  if (x > Math.PI) x -= Math.PI * 2;
  // −0 и шум округления — ровно 0: «без поворота» и в сохранении, и в подписи.
  return Math.abs(x) < 1e-9 ? 0 : x;
}

/** Ближайший угол шага TURN_STEP. */
export const snapTurn = (a: number): number => wrapTurn(Math.round(a / TURN_STEP) * TURN_STEP);

/** Поворот в подписи: «↻ 45°» (по часовой на экране — ось y карты вниз), «↺ 30°»; без поворота — пусто. */
export function turnText(turn: number): string {
  const deg = Math.round((wrapTurn(turn) * 180) / Math.PI);
  if (!deg) return '';
  return deg > 0 ? `↻ ${deg}°` : `↺ ${-deg}°`;
}

/** Поворот в подписи переноса: «· ↻ 45° · R ↻» (без поворота — только «· R ↻»); нечего вертеть (turns) — пусто. */
export function turnLabel(turn: number, turns: boolean): string {
  if (!turns) return '';
  const t = turnText(turn);
  return `${t ? ` · ${t}` : ''} · R ↻`;
}

/**
 * Угол рисунка без поворота у улицы: n — нормаль от улицы к участку. Ось y рисунка — от улицы, так что лицо (−y: у
 * ратуши — фасад с фонтаном, houseArt.hall) смотрит на улицу.
 */
export const streetBase = (n: Vec): number => wrapTurn(Math.atan2(-n.x, n.y));

/**
 * Насколько участок w×h, повёрнутый на turn от улицы, выдаётся к ней от середины: ближний к улице угол (или край)
 * должен остаться за тротуаром — середина отступает на столько от края асфальта (плюс сам отступ).
 */
export function turnReach(w: number, h: number, turn: number): number {
  return Math.abs((w / 2) * Math.sin(turn)) + Math.abs((h / 2) * Math.cos(turn));
}

/** Точка ручки поворота: за серединой края side (+1 — +y рисунка, от улицы) на reach + TURN_HANDLE_OFF от середины. */
export function turnHandlePos(center: Vec, angle: number, reach: number, side: 1 | -1 = 1): Vec {
  const r = side * (reach + TURN_HANDLE_OFF);
  return { x: center.x - r * Math.sin(angle), y: center.y + r * Math.cos(angle) };
}

/**
 * Ручку тянут: курсор p вокруг середины pivot — угол рисунка (ручка — на стороне side), от него — поворот от улицы
 * base, шагом TURN_STEP.
 */
export function turnFromHandle(pivot: Vec, p: Vec, base: number, side: 1 | -1 = 1): number {
  const angle = Math.atan2(p.y - pivot.y, p.x - pivot.x) - (side * Math.PI) / 2;
  return snapTurn(angle - base);
}
