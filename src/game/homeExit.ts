import { add, dot, sub, scale, type Vec } from '../core/vec';
import { boxesOverlap, type Box } from '../lanes/curb';
import { cottagePlan, dachaPlan, lotFrame, LOT_SETBACK, type LotRect } from '../world/houseAccess';
import { formOf } from '../world/townForms';
import type { CarSpot } from './garages';
import { straight, type Leg } from './lotMoves';
import { clearYardLeg, planYardExit } from './yardExit';

const plans = new WeakMap<CarSpot, { sig: string; legs: Leg[] | null }>();

/** Гараж разворачивает невидимую машину внутри; открытая площадка — видимым манёвром по свободному двору. */
export function homeExit(home: CarSpot, length: number, width: number, parked: { pos: Vec; dir: Vec }[] = []): Leg[] | null {
  if (home.d.garage && !home.parks && !home.open) return [straight(home.inside, home.curbSide, false, 6)];
  const b = home.b;
  const form = formOf(b);
  if (b.kind !== 'res' || (form !== 'cottage' && form !== 'dacha') || home.open) return null;
  const sig = `${b.fp.center.x}:${b.fp.center.y}:${b.fp.w}:${b.fp.h}:${b.fp.angle}:${b.face}:${b.homeSpaces}:${b.garageSpaces}:${length}:${width}:${parked.map((p) => `${p.pos.x}:${p.pos.y}:${p.dir.x}:${p.dir.y}`).join(';')}`;
  const hit = plans.get(home);
  if (hit?.sig === sig) return hit.legs;
  const at = lotFrame(b);
  const o = at(0, 0);
  const x = sub(at(1, 0), o);
  const y = sub(at(0, 1), o);
  const cottage = form === 'cottage' ? cottagePlan(b) : null;
  const plan = cottage ?? dachaPlan(b);
  const rects: LotRect[] = [plan.house];
  if (cottage?.garage) rects.push(cottage.garage);
  const obstacles = rects.map((r) => ({ c: at(r.x + r.w / 2, r.y + r.h / 2), d: x, hl: r.w / 2 + 0.15, hw: r.h / 2 + 0.15 }));
  obstacles.push(...parked.map((p) => ({ c: add(p.pos, scale(p.dir, -length / 2)), d: p.dir, hl: length / 2 + 0.12, hw: width / 2 + 0.12 })));
  const gx = dot(sub(home.d.curb, o), x);
  const clear = (box: Box): boolean => {
    for (const a of [-1, 1]) for (const s of [-1, 1]) {
      const p = { x: box.c.x + a * box.d.x * box.hl - s * box.d.y * box.hw, y: box.c.y + a * box.d.y * box.hl + s * box.d.x * box.hw };
      const rel = sub(p, o);
      const u = dot(rel, x);
      const v = dot(rel, y);
      if (Math.abs(u) > b.fp.w / 2 || v > b.fp.h / 2) return false;
      if (v < -b.fp.h / 2 && (Math.abs(u - gx) > home.d.width / 2 || v < -b.fp.h / 2 - LOT_SETBACK)) return false;
    }
    return !obstacles.some((r) => boxesOverlap(r, box));
  };
  const aligned = add(home.curbSide, scale(home.d.dir, 5));
  const approach = straight(aligned, home.curbSide, false, 6);
  const turn = clearYardLeg(approach, length, width, clear)
    ? planYardExit({ c: home.spot, h: home.d.dir }, { c: aligned, h: scale(home.d.dir, -1) }, length, width, clear)
    : null;
  const legs = turn ? [...turn, approach] : null;
  plans.set(home, { sig, legs });
  return legs;
}
