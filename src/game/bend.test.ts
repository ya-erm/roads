import { describe, expect, it } from 'vitest';
import { RoadSpec } from '../world/roadTypes';
import type { RoadRequest } from './build';
import { Game } from './game';

const AVENUE: RoadSpec = { cls: 'avenue', lanesF: 1, lanesB: 1 };

describe('Изгиб дороги за середину', () => {
  it('прямой участок выгибается дугой через точку, концы и id те же; Ctrl+Z возвращает', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    let built: { endNode: number } | null = null;
    let from = { x: 0, y: 0 };
    for (let y = 400; y < game.terrain.height - 400 && !built; y += 120) {
      for (let x = 300; x < game.terrain.width - 700 && !built; x += 160) {
        from = { x, y };
        const req: RoadRequest = { start: { kind: 'free', pos: from, level: 0 }, end: { kind: 'free', pos: { x: x + 300, y }, level: 0 }, spec: AVENUE, mode: 'straight' };
        const room: RoadRequest = { ...req, start: { kind: 'free', pos: { x: x + 150, y: y - 80 }, level: 0 }, end: { kind: 'free', pos: { x: x + 151, y: y + 80 }, level: 0 } };
        if (game.builder.plan(req).ok && game.builder.plan(room).ok) built = game.builder.build(req);
      }
    }
    expect(built).not.toBeNull();
    const seg = [...game.net.segments.values()].find((s) => s.b === built!.endNode || s.a === built!.endNode)!;
    const [a, b] = [seg.a, seg.b];
    const mid = seg.lut.pointAt(seg.length / 2);
    expect(game.builder.pickBendable(mid, 4)?.id).toBe(seg.id);
    const target = { x: mid.x, y: mid.y - 50 };
    const money = game.money;
    game.checkpoint('изгиб');
    expect(game.builder.bendPlan(seg.id, target).reason).toBeUndefined();
    expect(game.builder.bendSegment(seg.id, target)).toBe(true);
    game.commit();
    const bent = game.net.segment(seg.id);
    expect([bent.a, bent.b]).toEqual([a, b]);
    const top = bent.lut.pointAt(bent.length / 2);
    expect(Math.hypot(top.x - target.x, top.y - target.y)).toBeLessThan(6);
    expect(bent.length).toBeGreaterThan(300);
    expect(game.money).toBeLessThan(money);
    // Слишком круто — нельзя, дорога не меняется.
    expect(game.builder.bendPlan(seg.id, { x: mid.x, y: mid.y - 900 }).ok).toBe(false);
    expect(game.undo()).toBe('изгиб');
    expect(game.net.segment(seg.id).length).toBeCloseTo(300, 0);

    // Перо у начала: дорога выходит из узла под другим углом, конец остаётся прямым.
    const before = game.net.segment(seg.id).curve;
    const pulled = { x: before.p1.x, y: before.p1.y + 40 };
    const curve = game.builder.handleCurve(seg.id, 1, pulled)!;
    expect(game.builder.reshapePlan(seg.id, curve).ok).toBe(true);
    expect(game.builder.reshape(seg.id, curve)).toBe(true);
    const shaped = game.net.segment(seg.id);
    expect(shaped.curve.p1).toEqual(pulled);
    expect(shaped.curve.p2).toEqual(before.p2);
    const t0 = shaped.lut.tangentAt(0);
    expect(t0.y).toBeGreaterThan(0.3);
  });

  it('перо у стыка поворачивает и перо продолжающей дороги — стык гладкий; с Shift — излом', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    let mid: number | null = null;
    for (let y = 400; y < game.terrain.height - 400 && mid === null; y += 120) {
      for (let x = 300; x < game.terrain.width - 900 && mid === null; x += 160) {
        const first: RoadRequest = { start: { kind: 'free', pos: { x, y }, level: 0 }, end: { kind: 'free', pos: { x: x + 300, y }, level: 0 }, spec: AVENUE, mode: 'straight' };
        const whole: RoadRequest = { ...first, end: { kind: 'free', pos: { x: x + 600, y }, level: 0 } };
        const room: RoadRequest = { ...first, start: { kind: 'free', pos: { x: x + 300, y: y - 90 }, level: 0 }, end: { kind: 'free', pos: { x: x + 301, y: y + 90 }, level: 0 } };
        if (!game.builder.plan(whole).ok || !game.builder.plan(room).ok) continue;
        const end = game.builder.build(first)!.endNode;
        const pos = game.net.node(end).pos;
        game.builder.build({ ...first, start: { kind: 'node', nodeId: end, pos, level: 0 }, end: { kind: 'free', pos: { x: x + 600, y }, level: 0 } });
        mid = end;
      }
    }
    expect(mid).not.toBeNull();
    const [left, right] = game.net.node(mid!).segments.map((id) => game.net.segment(id));
    const which = (s: typeof left) => (s.a === mid ? 1 : 2) as 1 | 2;
    expect(game.builder.handlePartner(left.id, which(left))).toEqual({ seg: right.id, which: which(right) });
    const node = game.net.node(mid!).pos;
    const handle = (s: typeof left) => (which(s) === 1 ? game.net.segment(s.id).curve.p1 : game.net.segment(s.id).curve.p2);
    const was = handle(left);
    const target = { x: was.x, y: was.y + 30 };
    const res = game.builder.handlePlan(left.id, which(left), target, true)!;
    expect(res.plan.ok).toBe(true);
    expect(res.curves.map((c) => c.seg).sort()).toEqual([left.id, right.id].sort());
    const lengthBefore = Math.hypot(handle(right).x - node.x, handle(right).y - node.y);
    expect(game.builder.applyHandle(res)).toBe(true);
    // Перья по разные стороны узла на одной прямой, длина пера соседа та же.
    const a = sub(handle(left), node);
    const b = sub(handle(right), node);
    expect(Math.abs(a.x * b.y - a.y * b.x) / Math.hypot(a.x, a.y) / Math.hypot(b.x, b.y)).toBeLessThan(1e-6);
    expect(a.x * b.x + a.y * b.y).toBeLessThan(0);
    expect(Math.hypot(b.x, b.y)).toBeCloseTo(lengthBefore, 6);
    // С Shift двигается только своё перо.
    const fixed = { ...handle(right) };
    const kink = game.builder.handlePlan(left.id, which(left), { x: was.x, y: was.y - 20 }, false)!;
    expect(kink.curves).toHaveLength(1);
    expect(game.builder.applyHandle(kink)).toBe(true);
    expect(handle(right)).toEqual(fixed);
  });
});

const sub = (p: { x: number; y: number }, q: { x: number; y: number }) => ({ x: p.x - q.x, y: p.y - q.y });
