import { describe, expect, it } from 'vitest';
import { buildRoad, laneStep, laneTipAt } from './edit';
import { LaneRenderer } from './draw';
import { LaneNet, twoWay } from './model';
import { slideSeam } from './slide';

const AVENUE = { cls: 'avenue' as const, lanes: twoWay(2, 2) };

/** Холст, который запоминает только точки контуров: что и где нарисовано. */
function recorder(): { ctx: CanvasRenderingContext2D; pts: string[] } {
  const pts: string[] = [];
  const at = (x: number, y: number) => pts.push(`${x.toFixed(3)},${y.toFixed(3)}`);
  const noop = () => {};
  const ctx = {
    moveTo: at,
    lineTo: at,
    arc: (x: number, y: number) => at(x, y),
    beginPath: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    save: noop,
    restore: noop,
    setLineDash: noop,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, pts };
}

const drawn = (r: LaneRenderer, net: LaneNet): string[] => {
  const { ctx, pts } = recorder();
  r.draw(ctx, net, 2);
  return pts;
};

/** Проспект и съезд с него: стык с «ёлочкой» у x = 400, тупик съезда в поле. */
function exitRoad(): { net: LaneNet; end: number; seam: number } {
  const net = new LaneNet();
  buildRoad(net, { kind: 'free', pos: { x: 0, y: 0 } }, { kind: 'free', pos: { x: 800, y: 0 } }, AVENUE);
  laneStep(net, laneTipAt(net, { x: 400, y: 17.5 }, 14), { x: 560, y: 160 }, 'avenue', 14);
  const end = [...net.nodes.values()].find((n) => net.isDeadEnd(n) && n.pos.y > 100)!.id;
  const seam = [...net.nodes.values()].find((n) => n.kind === 'seam' && !net.isDeadEnd(n) && net.ends(n).some((e) => e.port))!.id;
  return { net, end, seam };
}

describe('Отрисовка дорог: кэш после правок', () => {
  it('копии сети с разными правками того же полотна — у него разные ревизии', () => {
    const { net, end } = exitRoad();
    const a = net.clone();
    const b = net.clone();
    a.moveNode(end, { x: 520, y: 220 });
    b.moveNode(end, { x: 700, y: 90 });
    const ramp = net.node(end).corridors[0];
    expect(a.corridor(ramp).rev).not.toBe(b.corridor(ramp).rev);
    expect(a.corridor(ramp).rev).not.toBe(net.corridor(ramp).rev);
  });

  it('«ёлочка» у стыка — по новой форме съезда сразу: тянули тупик, примыкание, отменили (Ctrl+Z)', () => {
    const { net, end, seam } = exitRoad();
    const shared = new LaneRenderer();
    drawn(shared, net);
    // Предпросмотр: каждый кадр — новая копия сети с переносом тупика съезда в другое место.
    const frames = [
      { x: 520, y: 220 },
      { x: 640, y: 200 },
      { x: 700, y: 90 },
    ].map((p) => {
      const n = net.clone();
      n.moveNode(end, p);
      return n;
    });
    for (const f of frames) expect(drawn(shared, f)).toEqual(drawn(new LaneRenderer(), f));
    // Отпустили — последняя копия стала сетью; ещё раз потянули примыкание вдоль дороги.
    const built = frames[frames.length - 1];
    const slid = built.clone();
    expect(slideSeam(slid, seam, { x: 330, y: 10 })).toBe(true);
    expect(drawn(shared, slid)).toEqual(drawn(new LaneRenderer(), slid));
    // Ctrl+Z — копия снимка до правок (как в игре) и сеть из сохранения: те же полотна, прежняя форма.
    const undone = net.clone();
    expect(drawn(shared, undone)).toEqual(drawn(new LaneRenderer(), undone));
    const loaded = LaneNet.fromJSON(JSON.parse(JSON.stringify(slid.toJSON())));
    expect(drawn(shared, loaded)).toEqual(drawn(new LaneRenderer(), loaded));
  });
});
