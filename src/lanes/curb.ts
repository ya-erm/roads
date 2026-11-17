import { add, rightNormal, scale, type Vec } from '../core/vec';
import { isDirt, isTrunk, LANE_W } from '../world/roadTypes';
import { laneShare } from './geometry';
import type { Corridor, LaneNet, LaneSlot } from './model';

/**
 * Полосы стоянки вдоль бордюра (LaneSlot.park, docs/PARKING.md, этап 2): размеры мест и где они на полосе. Одна полоса
 * стоянки — обычный слот профиля шириной LANE_W (7 ед.): размеченные места CURB.stallLen на всю ширину полосы, от
 * сплошной по краю движения (её рисует lanes/draw.ts) до бордюра (границы мест — игра). Машина стоит у бордюра, в
 * полосе CURB.stallDepth. Единица — 0,6 м.
 */
export const CURB = {
  /** Место вдоль бордюра: 9,5 ед. (≈ 5,7 м); машина 7,5 × 3 стоит у бордюра в полосе 4,6 ед. — с запасом на манёвр. */
  stallLen: 9.5,
  stallDepth: 4.6,
  /** Мест нет: ближе стольких ед. к узлу (и к стоп-линии — ещё на 3), у светофора — ближе lightRoom. */
  nodeRoom: 15,
  lightRoom: 30,
  /** У остановки — ±stopRoom от её места на оси; у заезда во двор, гараж — его ширина и по drivePad с каждой стороны. */
  stopRoom: 28,
  drivePad: 1,
  /** Скорость на полосе движения рядом с полосой стоянки — ×slow (машины встают и выезжают, двери). */
  slow: 0.85,
  /** Цена полосы стоянки — доля цены полосы того же класса. */
  cost: 0.8,
};

/** Можно ли на полотне такого класса держать полосу стоянки: не на магистрали и не на грунтовке. */
export const curbAllowed = (c: Pick<Corridor, 'cls'>): boolean => !isTrunk(c.cls) && !isDirt(c.cls);

/** Место на полосе стоянки: ключ — полотно, сторона (знак смещения), номер от начала полосы. */
export interface CurbStall {
  key: string;
  corridor: number;
  /** Номер полосы стоянки на полотне (c.lanes). */
  lane: number;
  side: 1 | -1;
  idx: number;
  /** Середина места на оси полотна и её точка, ход соседней полосы движения (машина стоит носом по нему). */
  s: number;
  pos: Vec;
  dir: Vec;
}

export const curbKey = (corridor: number, side: number, idx: number): string => `${corridor}:${side > 0 ? 'R' : 'L'}:${idx}`;

/** Полоса движения, к которой примыкает полоса стоянки P (с той же стороны, ближе к оси); нет — null. */
export function curbDrive(c: Corridor, P: LaneSlot): LaneSlot | null {
  const out = Math.sign(P.offset) || 1;
  return c.lanes.find((l) => !l.park && Math.abs(l.offset - (P.offset - out * LANE_W)) < 0.3 && l.from < P.to && P.from < l.to) ?? null;
}

/**
 * Полоса стоянки справа по ходу соседней полосы движения — только с неё машины встают на места (правостороннее
 * движение). Стоянка слева на односторонней — нет.
 */
export function curbUsable(c: Corridor, P: LaneSlot): boolean {
  const D = curbDrive(c, P);
  return !!D && P.flow === D.flow && P.offset * P.flow > D.offset * D.flow;
}

/**
 * Места полосы стоянки laneIdx полотна c: сетка по CURB.stallLen от начала полосы на полную ширину, без мест у узлов
 * (cut — обрезы у перекрёстков: стоп-линии; lights — у какого конца светофор) и там, где skip (отрезки оси: заезды,
 * остановки). Номер места — по сетке: заезд появился — соседние места те же.
 */
export function curbStalls(net: LaneNet, c: Corridor, laneIdx: number, cut: [number, number], lights: [boolean, boolean], skip: readonly [number, number][]): CurbStall[] {
  const P = c.lanes[laneIdx];
  if (!P?.park || !curbAllowed(c) || !curbUsable(c, P)) return [];
  const room = (k: 0 | 1) => {
    const n = net.nodes.get(k ? c.b : c.a);
    const base = n?.kind === 'junction' ? Math.max(CURB.nodeRoom, cut[k] + 3) : CURB.nodeRoom;
    return lights[k] ? Math.max(base, CURB.lightRoom) : base;
  };
  const lo = Math.max(P.from, room(0));
  const hi = Math.min(P.to, c.length - room(1));
  const start = P.from;
  const side: 1 | -1 = P.offset > 0 ? 1 : -1;
  const lat = P.offset + side * (LANE_W / 2 - CURB.stallDepth / 2);
  const out: CurbStall[] = [];
  const L = CURB.stallLen;
  for (let idx = Math.max(0, Math.ceil((lo - start) / L - 1e-6)); start + (idx + 1) * L <= hi + 1e-6; idx++) {
    const a = start + idx * L;
    const b = a + L;
    if (laneShare(c, P, a) < 0.98 || laneShare(c, P, b) < 0.98) continue;
    if (skip.some(([u, v]) => u < b && v > a)) continue;
    const s = (a + b) / 2;
    const { point, tangent } = c.lut.frameAt(s);
    const dir = scale(tangent, P.flow);
    out.push({ key: curbKey(c.id, side, idx), corridor: c.id, lane: laneIdx, side, idx, s, pos: add(point, scale(rightNormal(tangent), lat)), dir });
  }
  return out;
}

/** Четыре угла места (рисунок разметки): у края движения и у бордюра, по ходу — место на всю ширину полосы. */
export function stallCorners(c: Corridor, st: CurbStall): [Vec, Vec, Vec, Vec] {
  const P = c.lanes[st.lane];
  const a = st.s - CURB.stallLen / 2;
  const b = st.s + CURB.stallLen / 2;
  const outer = P.offset + st.side * (LANE_W / 2);
  const inner = P.offset - st.side * (LANE_W / 2);
  const at = (s: number, off: number) => {
    const { point, tangent } = c.lut.frameAt(s);
    return add(point, scale(rightNormal(tangent), off));
  };
  return [at(a, inner), at(a, outer), at(b, outer), at(b, inner)];
}
