import { add, rightNormal, scale, type Vec } from '../core/vec';
import { isDirt, isTrunk, PARK_W, ROAD_MARGIN } from '../world/roadTypes';
import { junctionCuts, laneShare } from './geometry';
import { besideOffset, type Corridor, type LaneNet, type LaneSlot, taperLen } from './model';

/**
 * Полосы стоянки вдоль бордюра (LaneSlot.park, docs/PARKING.md, этап 2): размеры мест и где они на полосе. Одна полоса
 * стоянки — слот профиля шириной PARK_W (3,5 ед.), с обочиной ROAD_MARGIN от края движения до бордюра — 5 ед. (≈ 3 м):
 * уже полосы движения. Линии между полосой движения и стоянкой нет; места CURB.stallLen размечены буквой «Т» (игра:
 * места знают заезды и остановки) — поперечная линия от края движения до бордюра, у края движения — засечка вдоль
 * полосы. Машина стоит у бордюра, в полосе CURB.stallDepth. Единица — 0,6 м.
 */
export const CURB = {
  /**
   * Место вдоль бордюра: 9,5 ед. (≈ 5,7 м); машина 7,5 × 3,6 стоит в полосе 4,4 ед. от бордюра (по 0,4 до бордюра и
   * с краю), до края движения остаётся 0,6 — с запасом на манёвр.
   */
  stallLen: 9.5,
  stallDepth: 4.4,
  /** Засечка «Т» у края движения — по стольку ед. вдоль полосы в каждую сторону от границы мест. */
  tee: 1.1,
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

/** Прямоугольник на плоскости: середина, единичный курс, полудлина и полуширина. */
export interface Box {
  c: Vec;
  d: Vec;
  hl: number;
  hw: number;
}

/** Габарит места: CURB.stallLen вдоль полосы и CURB.stallDepth поперёк (там, где стоит машина). */
export const stallBox = (st: CurbStall): Box => ({ c: st.pos, d: st.dir, hl: CURB.stallLen / 2, hw: CURB.stallDepth / 2 });

/** Пересекаются ли прямоугольники (теорема о разделяющей оси; касание — не пересечение). */
export function boxesOverlap(a: Box, b: Box): boolean {
  const corners = (x: Box): Vec[] => {
    const n = rightNormal(x.d);
    return [
      [1, 1],
      [1, -1],
      [-1, -1],
      [-1, 1],
    ].map(([i, j]) => add(x.c, add(scale(x.d, i * x.hl), scale(n, j * x.hw))));
  };
  const ca = corners(a);
  const cb = corners(b);
  for (const axis of [a.d, rightNormal(a.d), b.d, rightNormal(b.d)]) {
    const span = (ps: Vec[]) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of ps) {
        const v = p.x * axis.x + p.y * axis.y;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      return [lo, hi];
    };
    const [a0, a1] = span(ca);
    const [b0, b1] = span(cb);
    if (a1 <= b0 + 1e-6 || b1 <= a0 + 1e-6) return false;
  }
  return true;
}

/** Полоса движения, к которой примыкает полоса стоянки P (с той же стороны, ближе к оси); нет — null. */
export function curbDrive(c: Corridor, P: LaneSlot): LaneSlot | null {
  const out = Math.sign(P.offset) || 1;
  return c.lanes.find((l) => !l.park && Math.abs(besideOffset(l, out, PARK_W) - P.offset) < 0.3 && l.from < P.to && P.from < l.to) ?? null;
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
  // Машина — у бордюра: он на обочину дальше кромки слота.
  const lat = P.offset + side * (PARK_W / 2 + ROAD_MARGIN - CURB.stallDepth / 2);
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

/**
 * Граница мест полосы стоянки P на s оси (рисунок разметки) — буква «Т»: поперечная линия от края движения до бордюра
 * (вся видимая ширина: слот и обочина) и засечка ±CURB.tee вдоль полосы у края движения; у бордюра засечки нет.
 */
export function stallTee(c: Corridor, P: LaneSlot, s: number): [Vec, Vec][] {
  const side = Math.sign(P.offset) || 1;
  const inner = P.offset - side * (PARK_W / 2);
  const curb = P.offset + side * (PARK_W / 2 + ROAD_MARGIN);
  const at = (u: number, off: number) => {
    const { point, tangent } = c.lut.frameAt(u);
    return add(point, scale(rightNormal(tangent), off));
  };
  return [
    [at(s, inner), at(s, curb)],
    [at(s - CURB.tee, inner), at(s + CURB.tee, inner)],
  ];
}

/**
 * Где на полотне c может начаться и кончиться полоса стоянки на полную ширину: у перекрёстка — за его обрезом и отгоном
 * (fitCurbEnds); у стыков и тупиков — без ограничения (±Infinity).
 */
export function curbEndRoom(net: LaneNet, c: Corridor): [number, number] {
  const ends = [net.node(c.a), net.node(c.b)];
  const junctions = ends.filter((n) => n.kind === 'junction');
  if (!junctions.length) return [-Infinity, Infinity];
  const cut = junctionCuts(net, [c], junctions).get(c.id) ?? [0, 0];
  const T = taperLen(c.cls);
  return [ends[0].kind === 'junction' ? cut[0] + T : -Infinity, ends[1].kind === 'junction' ? c.length - cut[1] - T : Infinity];
}

/**
 * Полоса стоянки у перекрёстка — не до его площадки: на полную ширину она начинается за обрезом (как стоп-линия) и
 * отгоном taperLen от него — бордюр идёт плавным клином, как у кармашка остановки, а угол перекрёстка скругляется по
 * полотну без стоянки. Полосы стоянки полотна c, что заходят ближе, укорачиваются (короче места — убираются); у стыков и
 * тупиков — как были. Ответ — поменялись ли полосы.
 */
export function fitCurbEnds(net: LaneNet, c: Corridor): boolean {
  if (!c.lanes.some((l) => l.park)) return false;
  const [lo, hi] = curbEndRoom(net, c);
  if (lo === -Infinity && hi === Infinity) return false;
  let changed = false;
  const lanes: LaneSlot[] = [];
  for (const l of c.lanes) {
    if (!l.park || (l.from >= lo - 0.01 && l.to <= hi + 0.01)) {
      lanes.push(l);
      continue;
    }
    changed = true;
    const fit = { ...l, from: Math.max(l.from, lo), to: Math.min(l.to, hi) };
    if (fit.to - fit.from >= CURB.stallLen) lanes.push(fit);
  }
  if (changed) net.setLanes(c, lanes);
  return changed;
}

/** fitCurbEnds по всем полотнам сети со стоянкой (перекрёсток мог стать шире: новая дорога, скругление угла). */
export function fitCurbNet(net: LaneNet): void {
  for (const c of [...net.corridors.values()]) fitCurbEnds(net, c);
}
