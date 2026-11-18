import { add, dist, dot, scale, sub, type Vec } from '../core/vec';
import { boxesOverlap, type Box } from '../lanes/curb';
import type { ParkingLot } from '../world/entities';
import { lotFrame } from '../world/houseAccess';
import { LOT, lotLayout, lotLocal, lotRoute } from '../world/parkingLots';
import { bezier, legPose, path, straight, type Leg } from './lotMoves';
import { clearYardLeg, planYardExit } from './yardExit';

export interface LotExitPlan {
  legs: Leg[];
  /** Свободные места, которые заметает манёвр: до выезда их нельзя отдавать подъезжающим. */
  swept: number[];
}

const TURN = 4.5;
const BACK = 2.5;
const FORWARD = 6;
const ROOM = 0.15;

/**
 * Выезд маленькой площадки: задним ходом с места, смена хода внутри участка, передом к бордюру. Кандидаты —
 * поворот задним ходом в проезд или прямой откат в свободное место напротив с последующим S-образным выездом.
 * Проверяется весь кузов, включая углы: границы площадки, горловина ворот и стоящие машины. Нет места — null.
 */
export function planLotExit(lot: ParkingLot, gx: number, stall: number, curbSide: Vec, occupied: (k: number) => boolean, length: number, width: number): LotExitPlan | null {
  const layout = lotLayout(lot);
  const st = layout.stalls[stall];
  if (!st) return null;
  const at = lotFrame({ fp: lot.fp });
  const start = sub(st.nose, scale(st.dir, length / 2));
  const local = lotLocal(lot.fp, start);
  const dir = { x: Math.cos(lot.fp.angle), y: Math.sin(lot.fp.angle) };
  const out = sub(at(0, -1), at(0, 0));
  const aisle = layout.aisles[Math.floor(st.row / 2)];
  const ay = aisle.y + aisle.h / 2;
  const obstacles = layout.stalls.flatMap((s, k) => k !== stall && occupied(k) ? [{ c: sub(s.nose, scale(s.dir, length / 2)), d: s.dir, hl: length / 2 + ROOM, hw: width / 2 + ROOM }] : []);
  let best: LotExitPlan | null = null;
  let cost = Infinity;
  const consider = (legs: Leg[]) => {
    const score = legs.reduce((sum, l) => sum + l.len * (l.back ? 1.4 : 1), 0);
    if (score >= cost) return;
    const poses: Box[] = [];
    let last: ReturnType<typeof legPose> | undefined;
    for (const leg of legs) {
      const begin = legPose(leg, 0);
      if (last && (dist(last.c, begin.c) > 0.02 || dot(last.h, begin.h) < 0.995)) return;
      if (!clearYardLeg(leg, length, width, (b) => inside(lot, gx, b) && !obstacles.some((o) => boxesOverlap(b, o)))) return;
      for (let i = 0, n = Math.max(1, Math.ceil(leg.len / 0.3)); i <= n; i++) {
        const p = legPose(leg, leg.len * i / n);
        const box = { c: p.c, d: p.h, hl: length / 2 + ROOM, hw: width / 2 + ROOM };
        if (!inside(lot, gx, box) || obstacles.some((b) => boxesOverlap(box, b))) return;
        poses.push(box);
      }
      last = legPose(leg, leg.len);
    }
    if (!last || dist(last.c, curbSide) > 0.02 || dot(last.h, out) < 0.995) return;
    const swept = layout.stalls.flatMap((s, k) => {
      if (k === stall) return [];
      const middle = at(s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2);
      const box = { c: middle, d: dir, hl: s.rect.w / 2, hw: s.rect.h / 2 };
      return poses.some((p) => boxesOverlap(p, box)) ? [k] : [];
    });
    best = { legs, swept };
    cost = score;
  };
  // От места отъезжает в сторону, противоположную будущему движению по проезду: после смены хода нос — к воротам.
  for (const sign of [1, -1]) {
    for (const r of [TURN, 6, 8, 10]) {
      const x = local.x - sign * r;
      const head = scale(dir, sign);
      const end = at(x, ay);
      const k = Math.abs(ay - local.y) * 0.55;
      const back = bezier(start, sub(start, scale(st.dir, k)), add(end, scale(head, r * 0.55)), end, true, BACK);
      // Оставшаяся часть проезда — как у въезда, но без захода в место.
      const route = lotRoute(lot, gx, stall, length).slice(0, -1).reverse();
      route[0] = end;
      // Первой точкой lotRoute перед местом была его ось, заменённая на точку разворота.
      const first = route.find((p) => dist(p, end) > 0.05) ?? curbSide;
      if (dot(sub(first, end), head) <= 0) continue;
      consider([back, path([...route, curbSide], TURN, false, FORWARD)]);
    }
  }
  // У края участка для поворота задним ходом может не хватить ширины. Пустое место напротив даёт место для отката.
  for (const d of [6, 9, 12, 15, 18, 22]) {
    const end = sub(start, scale(st.dir, d));
    const run = dist(end, curbSide);
    for (const k of [0.35, 0.5, 0.65]) {
      consider([
        straight(start, end, true, BACK),
        bezier(end, add(end, scale(st.dir, run * k)), sub(curbSide, scale(out, run * k)), curbSide, false, FORWARD),
      ]);
    }
  }
  if (!best) {
    const clear = (b: Box) => inside(lot, gx, b) && !obstacles.some((o) => boxesOverlap(b, o));
    const legs = planYardExit({ c: start, h: st.dir }, { c: curbSide, h: out }, length, width, clear);
    if (legs && legs.every((l) => clearYardLeg(l, length, width, clear))) consider(legs);
  }
  return best;
}

/** Кузов целиком внутри участка; за его передним краем — только в горловине выбранных ворот. */
function inside(lot: ParkingLot, gx: number, b: Box): boolean {
  for (const a of [-1, 1]) for (const s of [-1, 1]) {
    const p = lotLocal(lot.fp, { x: b.c.x + a * b.d.x * b.hl - s * b.d.y * b.hw, y: b.c.y + a * b.d.y * b.hl + s * b.d.x * b.hw });
    if (Math.abs(p.x) > lot.fp.w / 2 || p.y > lot.fp.h / 2) return false;
    if (p.y < -lot.fp.h / 2 && (Math.abs(p.x - gx) > LOT.gateW / 2 || p.y < -lot.fp.h / 2 - LOT.setback)) return false;
  }
  return true;
}
