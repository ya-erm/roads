import { describe, expect, it } from 'vitest';
import { add, dist, dot, rightNormal, scale, sub } from '../core/vec';
import { boxesOverlap, type Box } from '../lanes/curb';
import { lotFrame } from '../world/houseAccess';
import { dockSolidsOf } from '../world/shopLots';
import { formOf } from '../world/townForms';
import { DEFAULT_SETTINGS } from '../world/settings';
import { freshGame } from './testkit';
import { bezier, legPose } from './lotMoves';
import { hitchOf, vehicleBoxes } from '../sim/body';

describe('Габариты грузовика во дворе получателя', () => {
  it('короткий грузовик, полуприцеп и фура не задевают корпуса/колонки и не выходят боком за участок', () => {
    const game = freshGame({ ...DEFAULT_SETTINGS, seed: 7, retail: true });
    const bad: string[] = [];
    const testedForms = new Map<string, number>();
    let tested = 0;
    for (const town of game.towns) for (const b of town.buildings) {
      const form = formOf(b);
      if (!['fuel', 'depot', 'warehouse', 'shop', 'store', 'market', 'office'].includes(form)) continue;
      for (const length of [12, 15, 21]) {
        const width = length === 21 ? 4.7 : 4.6;
        const geo = game.docks.geoOf(b, length, width);
        if (!geo?.in || !geo.out) continue;
        tested++;
        testedForms.set(form, (testedForms.get(form) ?? 0) + 1);
        const rects = dockSolidsOf(b, true);
        const at = lotFrame(b);
        const origin = at(0, 0);
        const x = sub(at(1, 0), origin);
        const y = sub(at(0, 1), origin);
        const obstacles: Box[] = rects.map((r) => ({ c: at(r.x + r.w / 2, r.y + r.h / 2), d: x, hl: r.w / 2, hw: r.h / 2 }));
        for (const [kind, legs] of [['in', geo.entry ?? geo.inLegs], ['out', geo.departure ?? geo.outLegs]] as const) {
          let error: string | undefined;
          for (const leg of legs) for (let s = 0; s <= leg.len; s += 0.25) {
            const p = legPose(leg, s);
            const body = length > 18 ? 'longSemi' : length > 12 ? 'semi' : 'van';
            const nose = add(p.c, scale(p.h, length / 2));
            const hitch = hitchOf(body);
            const trail = hitch && p.th ? sub(sub(nose, scale(p.h, hitch.joint * length)), scale(p.th, hitch.tail * length)) : undefined;
            for (const box of vehicleBoxes(nose, p.h, length, width, body, trail)) {
            if (obstacles.some((o) => boxesOverlap(box, o))) error ??= 'корпус/колонка';
            for (const a of [-1, 1]) for (const z of [-1, 1]) {
              const q = { x: box.c.x + a * box.d.x * box.hl - z * box.d.y * box.hw, y: box.c.y + a * box.d.y * box.hl + z * box.d.x * box.hw };
              const rel = sub(q, origin);
              if ((dot(rel, y) > -b.fp.h / 2 && Math.abs(dot(rel, x)) > b.fp.w / 2 + 0.15) || dot(rel, y) > b.fp.h / 2 + 0.15) error ??= 'край участка';
            }
            }
          }
          if (error) bad.push(`${form}#${b.id} ${b.fp.w.toFixed(1)}x${b.fp.h.toFixed(1)} L${length} ${kind}: ${error}`);
        }
        if (geo.entry) continue; // Полные плановые дуги уже проверены вместе с настоящим положением прицепа.
        const kIn = 0.55 * Math.max(2, Math.abs(dot(sub(geo.curbSide, geo.in.pos), rightNormal(geo.in.f))));
        const roadIn = bezier(geo.in.pos, add(geo.in.pos, scale(geo.in.f, kIn)), sub(geo.curbSide, scale(geo.d.dir, kIn)), geo.curbSide, false, 5.5);
        const start = geo.exitSide ?? geo.curbSide;
        const direction = (geo.exitD ?? geo.d).dir;
        const kOut = 0.55 * Math.max(2, Math.abs(dot(sub(start, geo.out.pos), rightNormal(geo.out.f))));
        const roadOut = bezier(start, sub(start, scale(direction, kOut)), geo.yard.kind === 'back' ? add(geo.out.pos, scale(geo.out.f, kOut)) : sub(geo.out.pos, scale(geo.out.f, kOut)), geo.out.pos, geo.yard.kind === 'back', 5);
        for (const [kind, leg] of [['roadIn', roadIn], ['roadOut', roadOut]] as const) {
          for (let s = 0; s <= leg.len; s += 0.25) {
            const p = legPose(leg, s);
            const box = { c: p.c, d: p.h, hl: length / 2, hw: width / 2 };
            if (obstacles.some((o) => boxesOverlap(box, o))) { bad.push(`${form}#${b.id} L${length} ${kind}: припаркованная машина/корпус`); break; }
          }
          expect(dist(legPose(leg, 0).c, leg.pts[0])).toBeLessThan(0.01);
        }
      }
    }
    expect(tested).toBeGreaterThan(20);
    for (const form of ['fuel', 'depot', 'warehouse', 'shop', 'store', 'market', 'office']) expect(testedForms.get(form), form).toBeGreaterThan(0);
    expect(bad.slice(0, 20), `${bad.length} небезопасных путей`).toEqual([]);
  }, 60_000);
});
