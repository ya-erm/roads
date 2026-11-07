import { describe, expect, it } from 'vitest';
import { add, dot, rightNormal, scale, sub, type Vec } from '../core/vec';
import { convoyGap, stageSpans } from '../game/constructionWork';
import type { Corridor } from '../lanes/model';
import { buildConstructionScene } from '../testpages/construction';
import { buildingCorridors, crewConvoy } from './constructionArt';
import { bridgePiers, entryPortal, PIER_LEAD, PIER_STEP, siteKind, slabTo, tunnelSight, undergroundOf, workLights } from './structureArt';

/** Внутри ли выпуклого многоугольника poly точка p. */
function inside(poly: Vec[], p: Vec): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(c) < 1e-9) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

describe('Опоры и настил моста', () => {
  const L = 280;
  const high = () => 8;

  it('не начатый участок — без опор; опоры встают впереди балок: целиком на PIER_LEAD, фундаментом — ещё на столько же', () => {
    expect(bridgePiers(L, high, 0, false)).toEqual([]);
    const beams = 100;
    const piers = bridgePiers(L, high, beams, false);
    expect(piers.length).toBeGreaterThan(0);
    for (const p of piers) {
      expect(p.s).toBeLessThanOrEqual(beams + 2 * PIER_LEAD);
      expect(p.full).toBe(p.s <= beams + PIER_LEAD);
    }
    // Впереди края балок — и опора целиком, и фундамент следующей.
    expect(piers.some((p) => p.full && p.s > beams)).toBe(true);
    expect(piers.some((p) => !p.full)).toBe(true);
    // Шаг опор — PIER_STEP, начиная с половины шага.
    piers.forEach((p, i) => expect(p.s).toBeCloseTo(PIER_STEP / 2 + i * PIER_STEP));
  });

  it('стройка от конца b — опоры от него же; у низкого пандуса опор нет', () => {
    const piers = bridgePiers(L, high, 60, true);
    for (const p of piers) expect(L - p.s).toBeLessThanOrEqual(60 + 2 * PIER_LEAD);
    expect(piers.length).toBeGreaterThan(0);
    // Пандус: высота растёт от 0 до 8 м по длине — у низкого начала опор нет.
    const ramp = (s: number) => (8 * s) / 120;
    const low = bridgePiers(120, ramp, 120, false);
    expect(low.every((p) => ramp(p.s) >= 1.5)).toBe(true);
    expect(low.length).toBeLessThan(Math.ceil(120 / PIER_STEP));
  });

  it('с ходом работ опора не пропадает и из целой не становится фундаментом', () => {
    let prev = new Map<number, boolean>();
    for (let beams = 1; beams <= L; beams += 1) {
      const now = new Map(bridgePiers(L, high, beams, false).map((p) => [p.s, p.full] as const));
      for (const [s, full] of prev) {
        expect(now.has(s)).toBe(true);
        if (full) expect(now.get(s)).toBe(true);
      }
      prev = now;
    }
  });

  it('плита настила идёт за балками без скачков, к концу догоняет их и всегда впереди покрытия', () => {
    for (const len of [30, 120, 280]) {
      let last = 0;
      for (let done = 0; done <= len; done += 0.25) {
        const [beams, pave] = stageSpans(done, len);
        const slab = slabTo(beams, len);
        expect(slab).toBeLessThanOrEqual(beams + 1e-9);
        expect(slab).toBeGreaterThanOrEqual(last - 1e-9);
        expect(slab - last).toBeLessThan(2.5);
        // Покрытие кладут по плите, а не по голым балкам.
        expect(slab).toBeGreaterThanOrEqual(pave - 1e-6);
        last = slab;
      }
      expect(slabTo(len, len)).toBe(len);
      expect(slabTo(len / 2, len)).toBeGreaterThanOrEqual(len / 2 - convoyGap(len) / 2 - 1e-9);
    }
  });
});

describe('Мост и тоннель сцены «Стройка»', () => {
  const sc = buildConstructionScene();
  const net = sc.game.roads.net;
  const ofProject = (key: string) => {
    const id = sc.projects.find((p) => p.key === key)!.project!;
    return buildingCorridors(net)
      .filter((c) => c.build?.project === id)
      .sort((p, q) => Math.min(p.curve.p0.x, p.curve.p3.x) - Math.min(q.curve.p0.x, q.curve.p3.x));
  };

  it('сцена собралась', () => expect(sc.errors).toEqual([]));

  it('вид стройки — по слою участка: пролёт и пандусы моста — мост, спуски и глубина тоннеля — тоннель', () => {
    const level = (c: Corridor) => [net.node(c.a).level, net.node(c.b).level];
    for (const c of ofProject('bridge')) expect(siteKind(net, c)).toBe(Math.max(...level(c)) > 0 ? 'bridge' : 'road');
    for (const c of ofProject('tunnel')) expect(siteKind(net, c)).toBe(Math.min(...level(c)) < 0 ? 'tunnel' : 'road');
    expect(ofProject('bridge').filter((c) => siteKind(net, c) === 'bridge')).toHaveLength(3);
    expect(ofProject('tunnel').filter((c) => siteKind(net, c) === 'tunnel')).toHaveLength(3);
    for (const c of ofProject('street')) expect(siteKind(net, c)).toBe('road');
  });

  /** Спуск в тоннель от портала (участок слоя −1 с концом на земле) и портал на нём. */
  const descent = () => {
    const c = ofProject('tunnel').find((x) => siteKind(net, x) === 'tunnel')!;
    const portal = undergroundOf(net).portals.find((p) => Math.hypot(p.pos.x - c.curve.p0.x, p.pos.y - c.curve.p0.y) < 1)!;
    return { c, portal };
  };

  it('у портала машина обрезается по его линии, глубже — не видна, снаружи — видна целиком', () => {
    const { c, portal } = descent();
    expect(portal).toBeTruthy();
    const at = (along: number, lat = 0) => add(add(portal.pos, scale(portal.dir, along)), scale(rightNormal(portal.dir), lat));
    expect(tunnelSight(net, at(-60), portal.dir, 20)).toBe('show');
    expect(tunnelSight(net, at(c.length / 2 + 20), portal.dir, 20)).toBe('hide');
    // Нос въехал на 5 м: видна только часть кузова перед линией портала.
    const clip = tunnelSight(net, at(5), portal.dir, 20);
    expect(Array.isArray(clip)).toBe(true);
    const poly = clip as Vec[];
    expect(inside(poly, at(-3))).toBe(true);
    expect(inside(poly, at(3))).toBe(false);
    // На обочине у портала (машина ждёт въезда) — тоже по линии портала, а не пропадает.
    const side = tunnelSight(net, at(-1, portal.right + 5), portal.dir, 20);
    expect(Array.isArray(side) && inside(side, at(-3, portal.right + 5))).toBe(true);
  });

  it('колонна въезжает в тоннель без скачков: видна снаружи, у портала — обрезана, глубже — пропадает', () => {
    const { c, portal } = descent();
    const seen: Record<string, number> = {};
    let prev: ('show' | 'hide' | 'clip')[] | null = null;
    for (let done = 0; done <= c.length; done += 0.5) {
      c.build = { ...c.build!, done, fromB: false };
      const now = crewConvoy(net, c).map((m) => {
        const s = tunnelSight(net, m.pos, m.dir, 24);
        const k = Array.isArray(s) ? 'clip' : s;
        seen[k] = (seen[k] ?? 0) + 1;
        // Машина под землёй — правда за линией портала.
        if (k === 'hide') expect(dot(sub(m.pos, portal.pos), portal.dir)).toBeGreaterThan(0);
        return k;
      });
      // Из «видна целиком» в «не видна» — только через обрезку у портала.
      if (prev) now.forEach((k, i) => expect(`${prev![i]}>${k}`).not.toBe('show>hide'));
      prev = now;
    }
    expect(seen.show).toBeGreaterThan(0);
    expect(seen.clip).toBeGreaterThan(0);
    expect(seen.hide).toBeGreaterThan(0);
    c.build = { ...c.build!, done: 0 };
  });

  it('входной портал — позади начала стройки и для глубокого участка тоже; огоньки — у краёв начатых этапов', () => {
    const { portal } = descent();
    const deep = ofProject('tunnel').find((x) => net.node(x.a).level < 0 && net.node(x.b).level < 0)!;
    deep.build = { ...deep.build!, done: deep.length / 2, fromB: false };
    expect(entryPortal(net, deep)).toBe(portal);
    const lights = workLights(deep);
    expect(lights.map((l) => l.stage)).toEqual([0, 1, 2]);
    const [earth] = stageSpans(deep.build.done, deep.length);
    expect(Math.hypot(lights[0].pos.x - deep.lut.pointAt(earth).x, lights[0].pos.y - deep.lut.pointAt(earth).y)).toBeLessThan(0.01);
    deep.build = { ...deep.build, done: 0 };
    expect(workLights(deep)).toEqual([]);
  });
});
