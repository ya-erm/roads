import { describe, expect, it } from 'vitest';
import { freshGame } from '../game/testkit';
import type { Town, TownBuilding } from '../world/entities';
import { NEW_GAME_SETTINGS } from '../world/settings';
import { halfAtS } from '../world/worldgen';
import { parkGates } from './parkArt';
import { drawTownWalks, townWalks } from './townWalks';

let nextId = 500;
const house = (x: number, y: number, o: Partial<TownBuilding> = {}): TownBuilding => ({
  type: 'building',
  id: nextId++,
  townId: 1,
  fp: { center: { x, y }, w: 20, h: 18, angle: 0 },
  kind: 'res',
  floors: 2,
  anchor: 0,
  color: '#efe3cf',
  roof: '#b9654d',
  form: 'cottage',
  face: -1,
  ...o,
});
const town = (buildings: TownBuilding[], population = 5000): Town => ({
  id: 1,
  name: 'Тест',
  center: { x: 0, y: 0 },
  radius: 400,
  top: 0,
  style: 'organic',
  population,
  buildings,
  streets: [],
  demands: [],
  supplied: {},
  lastSupplied: {},
  tripAcc: 0,
  growthAcc: 0,
});
/** Улица — по y = −14 (участки стоят в 5 м от её края): до края полотна — расстояние до неё минус 9. */
const curb = (p: { x: number; y: number }) => Math.abs(p.y + 14) - 9;

describe('Дорожки кварталов', () => {
  it('ряд домов: дорожки — по промежуткам между ними от тротуара в глубину, к дому второго ряда — в обход переднего', () => {
    // Дома ряда через 25 м (промежуток 5 м), за вторым — дом второго ряда.
    const row = Array.from({ length: 12 }, (_, i) => house(i * 25, 0));
    const rear = house(25, 23, { fp: { center: { x: 25, y: 23 }, w: 16, h: 16, angle: 0 } });
    const w = townWalks(town([...row, rear]), curb)!;
    expect(w).not.toBeNull();
    expect(w.paved).toBe(true);
    // Промежуточные дорожки — посередине промежутков (x = 12.5 + 25k), от тротуара (y < −9) за заднюю сторону домов.
    const gaps = w.paths.filter((p) => p.length === 4);
    expect(gaps.length).toBeGreaterThan(0);
    for (const p of gaps) {
      expect(((p[0] - 12.5) / 25) % 1).toBeCloseTo(0);
      expect(Math.min(p[1], p[3])).toBeLessThan(-9);
      expect(Math.max(p[1], p[3])).toBeGreaterThan(5);
    }
    // К дому второго ряда: от его крыльца — к промежутку у переднего дома и к тротуару.
    const toRear = w.paths.find((p) => p.length === 8)!;
    expect(toRear).toBeTruthy();
    expect(toRear[1]).toBeCloseTo(23 - 8);
    expect(Math.abs(toRear[4] - 25)).toBeCloseTo(11.6);
    expect(toRear[7]).toBeLessThan(-9);
    // Та же застройка — те же дорожки.
    expect(townWalks(town([...row, rear]), curb)!.sig).toBe(w.sig);
  });

  it('в селе — утоптанные тропинки; издали дорожек не видно', () => {
    const w = townWalks(
      town(
        Array.from({ length: 12 }, (_, i) => house(i * 25, 0)),
        900,
      ),
      curb,
    )!;
    expect(w.paved).toBe(false);
    const calls: Record<string, number> = {};
    const ctx = new Proxy({} as Record<string | symbol, unknown>, {
      get: (t, k) => (k in t ? t[k] : () => (calls[String(k)] = (calls[String(k)] ?? 0) + 1)),
      set: (t, k, v) => ((t[k] = v), true),
    }) as unknown as CanvasRenderingContext2D;
    const all = { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 };
    drawTownWalks(ctx, [w], all, 0.15);
    expect(calls.stroke ?? 0).toBe(0);
    drawTownWalks(ctx, [w], all, 0.8);
    expect(calls.stroke).toBeGreaterThan(0);
  });

  it('мир по seed: у входов в парки — дорожки до тротуара; дорожки не уходят на проезжую часть дальше тротуара', { timeout: 30_000 }, () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
    const net = g.roads.net;
    const edge = (p: { x: number; y: number }) => {
      let best = Infinity;
      for (const c of net.corridorsNear(p, 30)) {
        const hit = c.lut.closest(p);
        best = Math.min(best, hit.d - halfAtS(c, hit.s));
      }
      return best;
    };
    let total = 0;
    let toParks = 0;
    let drives = 0;
    let curbed = 0;
    for (const t of g.towns) {
      const w = townWalks(t, edge);
      if (!w) continue;
      total += w.paths.length;
      // Съезды — от участка до полотна: дальний край (раструб у бордюра) — у края полотна или под ним.
      for (const d of w.drives) {
        drives++;
        const outer = [6, 8].map((i) => edge({ x: d.pts[i], y: d.pts[i + 1] }));
        if (outer.every((e) => e < 1)) curbed++;
      }
      // Дорожки к крыльцам доходят до тротуара.
      for (const f of w.fronts) expect(edge({ x: f.pts[2], y: f.pts[3] })).toBeLessThan(4.5);
      // Концы дорожек у улицы — на тротуаре или на газоне, но не на полотне.
      for (const p of w.paths) for (let i = 0; i < p.length; i += 2) expect(edge({ x: p[i], y: p[i + 1] })).toBeGreaterThan(-0.5);
      // От входа в парк — до тротуара: начало дорожки — у входа, конец — у края полотна.
      const gates = (t.parks ?? []).flatMap(parkGates);
      for (const p of w.paths) {
        if (!gates.some((q) => Math.hypot(q.x - p[0], q.y - p[1]) < 0.01)) continue;
        toParks++;
        expect(edge({ x: p[p.length - 2], y: p[p.length - 1] })).toBeLessThan(3.5);
      }
    }
    expect(total).toBeGreaterThan(200);
    expect(toParks).toBeGreaterThan(5);
    expect(drives).toBeGreaterThan(100);
    expect(curbed / drives).toBeGreaterThan(0.9);
  });
});
