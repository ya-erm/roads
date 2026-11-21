import { describe, expect, it } from 'vitest';
import { dist, type Vec } from '../core/vec';
import { freshGame } from '../game/testkit';
import { setCornerRadius } from '../lanes/corners';
import { junctionCorners } from '../lanes/geometry';
import { type LaneNet, twoWay } from '../lanes/model';
import { buildJunctionsScene } from '../testpages/junctions';
import type { ParkKind, TownPark } from '../world/entities';
import { inPolygon, junctionPlate, polyDist } from '../world/lotClear';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { defaultParkObject, parkToWorld } from '../world/parkParts';
import { curbGap } from '../world/worldgen';
import { alleyScope, drawParkArt, drawParkObject, drawStreetGreen, parkFountains, parkGates, parkParts, parkWorldPaths, streetCanopyMask, type StreetGreen, streetGreen } from './parkArt';
import { sidewalkScope } from './sidewalks';
import { LAMPS_ON } from './townDecor';

/** Холст-заглушка: сколько раз позван каждый метод и какие свойства выставлялись. */
function stub() {
  const calls: Record<string, number> = {};
  const set = new Set<string>();
  const props: Record<string | symbol, unknown> = {};
  const ctx = new Proxy(props, {
    get: (t, k) =>
      k in t
        ? t[k]
        : () => {
            calls[String(k)] = (calls[String(k)] ?? 0) + 1;
          },
    set: (t, k, v) => {
      set.add(String(k));
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, set };
}

const SIZES: Record<ParkKind, [number, number]> = { park: [100, 72], square: [26, 20], plaza: [60, 28], memorial: [24, 18], embankment: [34, 13] };
const park = (kind: ParkKind, id = 1203): TownPark => ({ id, kind, fp: { center: { x: 500, y: 400 }, w: SIZES[kind][0], h: SIZES[kind][1], angle: 0.3 } });
const total = (c: Record<string, number>) => Object.values(c).reduce((s, n) => s + n, 0);

describe('Парки и скверы — рисунок', () => {
  it('после правки от текущих объектов и дорожек зависят входы, рябь фонтана и рисунок', () => {
    const original = park('memorial');
    const generated = parkParts(original);
    expect(generated.objects.filter(o => o.kind === 'obelisk')).toHaveLength(1);
    expect(parkParts(structuredClone(original))).toEqual(generated);
    const edited = { ...original, edits: { objects: [defaultParkObject('fountain', { x: 3, y: 2 })], paths: [] } };
    expect(parkWorldPaths(original)[0].points[0]).toEqual(parkToWorld(original, generated.paths[0].points[0]));
    expect(parkGates(original)).not.toHaveLength(0);
    expect(parkGates(edited)).toHaveLength(0);
    expect(parkFountains(edited)).toEqual([{ ...parkToWorld(edited, { x: 3, y: 2 }), r: 3 }]);
    const intact = stub(), empty = stub();
    drawParkArt(intact.ctx, original, 2);
    drawParkArt(empty.ctx, { ...original, edits: { objects: [], paths: [] } }, 2);
    expect(intact.calls.arc).toBeGreaterThan(0);
    expect(empty.calls.arc).toBeUndefined();
    const light = stub();
    drawParkObject(light.ctx, defaultParkObject('lamp', { x: 0, y: 0 }), 2);
    expect(light.calls.arc).toBeGreaterThan(0);
  });

  it('проход вдоль парапета и новые дорожки на площади примыкают к тротуару своими концами', () => {
    const bank = park('embankment');
    expect(parkParts(bank).paths).toHaveLength(1);
    expect(parkGates(bank)).toHaveLength(2);
    const bare = { ...bank, edits: { paths: [] } };
    expect(parkGates(bare)).toHaveLength(0);
    const full = stub(), withoutWalk = stub();
    drawParkArt(full.ctx, bank, 2);
    drawParkArt(withoutWalk.ctx, bare, 2);
    expect(full.calls.fillRect).toBe(withoutWalk.calls.fillRect + 1);
    const plaza = park('plaza');
    plaza.edits = { paths: [{ id: 1, width: 2, points: [{ x: -plaza.fp.w / 2, y: 0 }, { x: 0, y: 0 }] }] };
    expect(parkGates(plaza)).toHaveLength(1);
  });
  it('каждый вид рисуется на любом зуме; ближе — больше деталей; без фильтров и размытия', () => {
    for (const kind of Object.keys(SIZES) as ParkKind[]) {
      const runs = [0.15, 0.4, 0.8, 2].map((z) => {
        const s = stub();
        drawParkArt(s.ctx, park(kind), z);
        return s;
      });
      for (let i = 1; i < runs.length; i++) expect(total(runs[i].calls), `${kind} ${i}`).toBeGreaterThanOrEqual(total(runs[i - 1].calls));
      expect(total(runs[3].calls), kind).toBeGreaterThan(total(runs[0].calls));
      for (const s of runs) {
        expect(s.set.has('filter'), kind).toBe(false);
        expect(s.set.has('shadowBlur'), kind).toBe(false);
        expect(s.calls.save).toBe(s.calls.restore);
      }
    }
  });

  it('раскладка — по id парка: тот же парк рисуется так же, другой — иначе', () => {
    const a = stub();
    drawParkArt(a.ctx, park('park', 1203), 0.8);
    const b = stub();
    drawParkArt(b.ctx, park('park', 1203), 0.8);
    const c = stub();
    drawParkArt(c.ctx, park('park', 1207), 0.8);
    expect(b.calls).toEqual(a.calls);
    expect(c.calls).not.toEqual(a.calls);
  });
});

describe('Аллеи и фонари вдоль улиц', { timeout: 30_000 }, () => {
  it('за краем кроны маскируется только перекрытая часть прохожего, тень не рисуется повторно', () => {
    const outside = streetCanopyMask([{ trees: [19.5, 0, 2.1] }]);
    const { ctx, calls } = stub();
    expect(outside(ctx, { x: 19.5, y: 0 }, 0.6)).toBe(false);
    expect(outside(ctx, { x: 22.3, y: 0 }, 0.6)).toBe(true);
    expect(calls.clip).toBeUndefined();
    expect(outside(ctx, { x: 21.5, y: 0 }, 0.6)).toBe(true);
    expect(calls.clip).toBe(1);
    expect(calls.fill).toBeUndefined();
  });

  it('деревья — вдоль проспектов, у тротуара, не на полотнах; фонари пока выключены', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
    const lines = streetGreen(g.roads.net, g.towns, (p, r) => g.index.at(p, r) !== null);
    const trees = lines.reduce((n, l) => n + l.trees.length / 3, 0);
    const lamps = lines.reduce((n, l) => n + l.lamps.length / 2, 0);
    expect(trees).toBeGreaterThan(50);
    // Освещение вернётся вместе с ночным режимом (LAMPS_ON).
    expect(lamps).toBe(LAMPS_ON ? lamps : 0);
    for (const l of lines) {
      const own = g.roads.net.corridor(l.id);
      if (l.trees.length) expect(own.cls).toBe('avenue');
      for (let i = 0; i < l.trees.length; i += 3) {
        const p = { x: l.trees[i], y: l.trees[i + 1] };
        // Кромка — со своей стороны: полоса стоянки бывает только с одной стороны улицы.
        for (const c of g.roads.net.corridorsNear(p, 40)) expect(curbGap(c, p), `дерево на полотне ${c.id}`).toBeGreaterThan(-0.5);
        expect(g.index.at(p, 0)).toBeNull();
      }
    }
    // Вблизи деревья — с бликами: вызовов больше.
    const far = stub();
    drawStreetGreen(far.ctx, lines, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, 0.4);
    const near = stub();
    drawStreetGreen(near.ctx, lines, { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, 2);
    expect(total(near.calls)).toBeGreaterThan(total(far.calls));
  });

  describe('после правки дорог — не на асфальте (сцена «Перекрёстки», «Излом ветки»)', () => {
    const scene = buildJunctionsScene();
    const { game } = scene;
    const base = game.roads.net;
    const busy = (p: Vec, r: number) => game.index.at(p, r) !== null;
    const hub = scene.junctions.find((j) => j.name === 'Излом ветки')!.node!;
    // Кэш — общий на все правки, как у отрисовки: аллея берётся из него, пока её подпись та же.
    const cache = new Map<number, { sig: string; line: StreetGreen | null }>();
    const before = streetGreen(base, game.towns, busy, cache);
    const near = (lines: StreetGreen[], net: LaneNet) => lines.filter((l) => dist(net.corridor(l.id).lut.pointAt(net.corridor(l.id).length / 2), net.node(hub).pos) < 200);
    const count = (lines: StreetGreen[]) => lines.reduce((n, l) => n + l.trees.length / 3, 0);

    const byId = (lines: StreetGreen[]) => new Map(lines.map((l) => [l.id, l.sig]));

    /**
     * Ни одного дерева на полотне, на площадке перекрёстка и у её бордюра (там тротуар); с кэшем — как без него. На
     * протяжке (как отрисовка): заново — только полотна alleyScope, остальные прежние, — то же, что полный пересчёт.
     */
    const check = (net: LaneNet) => {
      const full = streetGreen(net, game.towns, busy);
      const scope = sidewalkScope(base, net);
      if (scope) {
        const touched = alleyScope(base, net, scope);
        expect(touched.size).toBeLessThan(net.corridors.size / 3);
        const live = [...before.filter((l) => !touched.has(l.id) && net.corridors.has(l.id)), ...streetGreen(net, game.towns, busy, cache, touched)];
        expect(byId(live)).toEqual(byId(full));
      }
      const lines = streetGreen(net, game.towns, busy, cache);
      expect(lines.map((l) => l.sig)).toEqual(full.map((l) => l.sig));
      for (const l of lines) {
        for (let i = 0; i < l.trees.length; i += 3) {
          const p = { x: l.trees[i], y: l.trees[i + 1] };
          for (const c of net.corridorsNear(p, 40)) expect(curbGap(c, p), `дерево полотна ${l.id} на полотне ${c.id}`).toBeGreaterThan(-0.5);
          for (const n of net.nodesNear(p, 200)) {
            const plate = junctionPlate(net, n);
            if (!plate) continue;
            expect(inPolygon(p, plate), `дерево полотна ${l.id} на площадке узла ${n.id}`).toBe(false);
            expect(polyDist(p, plate), `дерево полотна ${l.id} у бордюра узла ${n.id}`).toBeGreaterThan(3);
          }
        }
      }
      return lines;
    };

    it('до правки: деревья по обе стороны всех четырёх веток', () => {
      expect(count(near(check(base), base))).toBeGreaterThan(40);
    });

    it('скруглили угол на 49 м: деревья на дуге убраны, остальные — на месте', () => {
      const next = base.clone();
      const k = junctionCorners(next, next.node(hub)).find((x) => x.out.x > 0 && x.out.y < 0)!;
      setCornerRadius(next, hub, k.key, 49);
      // Полотна у узла — той же формы (rev тот же): прежде аллея бралась из кэша и деревья стояли на углу.
      for (const id of next.node(hub).corridors) expect(next.corridor(id).rev).toBe(base.corridor(id).rev);
      const plate = junctionPlate(next, next.node(hub))!;
      const was = near(before, base).flatMap((l) => l.trees.filter((_, i) => i % 3 === 0).map((x, j) => ({ x, y: l.trees[j * 3 + 1] })));
      expect(was.filter((p) => inPolygon(p, plate)).length).toBeGreaterThan(2);
      const after = near(check(next), next);
      expect(count(after)).toBeLessThan(count(near(before, base)));
      expect(count(after)).toBeGreaterThan(count(near(before, base)) - 15);
    });

    it('сдвинули перекрёсток: аллеи — по новому месту', () => {
      const next = base.clone();
      const n = next.node(hub);
      next.moveNode(hub, { x: n.pos.x + 12, y: n.pos.y - 9 });
      check(next);
    });

    it('повернули ветку у перекрёстка (сдвинули её дальний конец): соседние аллеи — без деревьев на ней', () => {
      const next = base.clone();
      const n = next.node(hub);
      const east = next.ends(n).find((e) => e.away.x > 0.9)!.corridor;
      const far = east.a === hub ? east.b : east.a;
      const p = next.node(far).pos;
      next.moveNode(far, { x: p.x - 30, y: p.y - 70 });
      check(next);
    });

    it('перестроили ветку шире (3+3): деревья соседних веток не на ней', () => {
      const next = base.clone();
      const north = next.ends(next.node(hub)).find((e) => e.away.y < -0.9)!.corridor;
      next.setLanes(north, twoWay(3, 3));
      // Соседняя ветка не менялась, но её аллея у узла — заново (кэш по форме соседей).
      check(next);
    });

    it('скруглённый угол и перенос вместе, затем отмена: снова прежние аллеи', () => {
      const next = base.clone();
      const k = junctionCorners(next, next.node(hub))[0];
      setCornerRadius(next, hub, k.key, 40);
      const n = next.node(hub);
      next.moveNode(hub, { x: n.pos.x - 8, y: n.pos.y + 6 });
      check(next);
      expect(streetGreen(base, game.towns, busy, cache).map((l) => l.sig)).toEqual(before.map((l) => l.sig));
    });
  });
});
