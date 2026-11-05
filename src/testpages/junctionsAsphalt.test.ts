import { describe, expect, it } from 'vitest';
import { add, dist, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import { LaneRenderer } from '../lanes/draw';
import { edgePoint, edgesAt, junctionCuts } from '../lanes/geometry';
import { curbSegments, GUIDE_CURB_GAP, guideLines, insidePoly, isSkewed, junctionMarks, resample, SHARP_TURN, turnPaths } from '../lanes/junctionMarks';
import { localGraph } from '../lanes/preview';
import { LANE_W, ROAD_MARGIN } from '../world/roadTypes';
import { buildJunctionsScene } from './junctions';

/** Расстояние от точки до отрезка. */
function segDist(p: Vec, a: Vec, b: Vec): number {
  const d = sub(b, a);
  const l2 = dot(d, d);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / l2)) : 0;
  return dist(p, add(a, scale(d, t)));
}

describe('Перекрёстки /test/junctions: машины не съезжают с асфальта, разметка — по асфальту', { timeout: 60_000 }, () => {
  const scene = buildJunctionsScene();
  const net = scene.game.roads.net;
  const graph = scene.game.roads.graph;
  const cuts = junctionCuts(net);
  const renderer = new LaneRenderer();

  /** Точка на асфальте перекрёстка id: на его площадке или на подъезде (между обрезами, в пределах кромок). */
  const onAsphalt = (id: number, plate: Vec[], p: Vec) =>
    insidePoly(p, plate) ||
    net.node(id).corridors.some((cid) => {
      const c = net.corridor(cid);
      const hit = c.lut.closest(p);
      const [ca, cb] = cuts.get(cid)!;
      if (hit.s < ca - 0.3 || hit.s > c.length - cb + 0.3) return false;
      const e = edgesAt(c, hit.s);
      const off = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
      return !!e && off >= e[0] - ROAD_MARGIN - 0.05 && off <= e[1] + ROAD_MARGIN + 0.05;
    });

  it('каждая траектория манёвра — с полушириной полосы — на асфальте перекрёстка (и со скруглёнными углами)', () => {
    for (const j of scene.junctions) {
      const plate = renderer.plateOf(net, j.node!)!;
      const off: string[] = [];
      for (const m of graph.moves.values()) {
        if (m.node !== j.node || m.cont) continue;
        const pts = resample(m.points, 40);
        pts.forEach((p, i) => {
          const t = sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)]);
          const n = rightNormal(scale(t, 1 / (Math.hypot(t.x, t.y) || 1)));
          for (const side of [-1, 1]) if (!onAsphalt(j.node!, plate, add(p, scale(n, (side * LANE_W) / 2)))) off.push(`${m.key}@${i}`);
        });
      }
      expect(off, j.name).toEqual([]);
    }
  });

  it('площадка перекрёстка кончается у стоп-линий: не тянется клином по веткам дальше их обрезов (и у изогнутых)', () => {
    for (const j of scene.junctions) {
      const node = net.node(j.node!);
      const plate = renderer.plateOf(net, node.id)!;
      // Вершины контура и середины его сторон.
      const pts = plate.flatMap((p, i) => [p, scale(add(p, plate[(i + 1) % plate.length]), 0.5)]);
      const over: string[] = [];
      for (const e of net.ends(node)) {
        const c = e.corridor;
        const cut = cuts.get(c.id)![e.end === 'a' ? 0 : 1];
        for (const p of pts) {
          const hit = c.lut.closest(p);
          const along = e.end === 'a' ? hit.s : c.length - hit.s;
          if (along <= cut + 1) continue;
          const ed = edgesAt(c, hit.s);
          const off = dot(sub(p, hit.point), rightNormal(c.lut.tangentAt(hit.s)));
          if (ed && off > ed[0] - ROAD_MARGIN + 0.5 && off < ed[1] + ROAD_MARGIN - 0.5) over.push(`${c.id}: ${Math.round(along - cut)} м за обрезом`);
        }
      }
      expect(over, j.name).toEqual([]);
    }
  });

  it('штриховка не ложится под траектории, пунктир — по асфальту и не вдоль бордюра; на Y нет дуги с ветки на ветку', () => {
    let drawn = 0;
    for (const j of scene.junctions) {
      const node = net.node(j.node!);
      const plate = renderer.plateOf(net, node.id)!;
      const m = junctionMarks(net, node, plate, cuts);
      if (!m) continue;
      drawn++;
      const paths = [...graph.moves.values()].filter((x) => x.node === node.id && !x.cont).map((x) => resample(x.points, 60));
      for (const loop of m.islands) {
        for (const p of loop) for (const pts of paths) expect(Math.min(...pts.map((q) => dist(p, q))), j.name).toBeGreaterThan(LANE_W / 2);
      }
      const ends = net.ends(node);
      const curb = curbSegments(
        plate,
        ends.map((e) => {
          const cut = cuts.get(e.corridor.id)![e.end === 'a' ? 0 : 1];
          return [edgePoint(e, cut, -1).p, edgePoint(e, cut, 1).p];
        }),
      );
      for (const g of m.guides) {
        for (const p of g.pts) {
          expect(insidePoly(p, plate), j.name).toBe(true);
          expect(Math.min(...curb.map(([a, b]) => segDist(p, a, b))), j.name).toBeGreaterThan(GUIDE_CURB_GAP - 0.05);
          // И не на штриховке.
          expect(m.islands.some((loop) => insidePoly(p, loop)), j.name).toBe(false);
        }
      }
      if (j.name.startsWith('Y-образный')) {
        // Повороты с ветки на ветку (круче SHARP_TURN) на Y есть, но линий не дают: без них — те же линии.
        const paths = turnPaths(localGraph(net, new Set([node.id]), cuts), node.id);
        const sharp = paths.filter((p) => Math.abs(p.theta) > SHARP_TURN);
        expect(sharp.length, j.name).toBeGreaterThan(0);
        const keep = paths.filter((p) => !sharp.includes(p));
        // Номера пересечений — в новом списке.
        const rest = keep.map((p) => ({ ...p, crosses: p.crosses.map((i) => keep.indexOf(paths[i])).filter((i) => i >= 0) }));
        const lines = (list: typeof paths) => guideLines(list, { skew: isSkewed(net, node) }).map((g) => g.pts);
        expect(lines(paths)).toEqual(lines(rest));
      }
      if (j.name.startsWith('Косой Т')) {
        // С ветки два потока в две полосы главной, поперёк их никто не едет — между ними сплошная.
        expect(m.guides.some((g) => g.solid), j.name).toBe(true);
      }
    }
    // Разметка есть на больших перекрёстках сцены.
    expect(drawn).toBeGreaterThan(5);
  });
});
