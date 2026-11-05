import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import { buildJunctionsScene } from './junctions';

/** Сколько подъездов у каждого перекрёстка сцены (у смещённого — у ближнего из двух Т-образных). */
const ARMS: Record<string, number> = {
  'Крест 2+2 × 2+2': 4,
  'Косой X 2+2 × 2+2, 32°': 4,
  'Косой X, углы скруглены': 4,
  'Широкий 3+3 × 2+2': 4,
  'Маленький 1+1 × 1+1': 4,
  'Проспект 2+2 × улица 1+1': 4,
  'Т-образный 2+2': 3,
  'Y-образный, 40°': 3,
  Пятилучевой: 5,
  Шестилучевой: 6,
  'Магистраль 2+2 × 1+1': 4,
  'Односторонняя 2→ × 2+2': 4,
  'Две односторонние 2→': 4,
  Смещённый: 3,
  'Излом ветки': 4,
  'Правый поворот и съезд': 4,
  'Т с изогнутой веткой': 3,
  'Косой Т, два потока в две полосы': 3,
};

const deg = (rad: number) => (rad * 180) / Math.PI;

describe('Тестовая страница /test/junctions', { timeout: 60_000 }, () => {
  const scene = buildJunctionsScene();
  const { game } = scene;
  const net = game.roads.net;
  const junction = (name: string) => {
    const j = scene.junctions.find((x) => x.name === name)!;
    return net.node(j.node!);
  };

  it('сцена строится целиком: все перекрёстки на месте, у каждого подпись и нужное число подъездов', () => {
    expect(scene.errors).toEqual([]);
    expect(game.terrain.rivers).toHaveLength(0);
    expect(game.industries).toHaveLength(0);
    expect(net.problems()).toEqual([]);
    expect(Object.fromEntries(scene.junctions.map((j) => [j.name, j.arms]))).toEqual(ARMS);
    for (const j of scene.junctions) {
      expect(net.node(j.node!).kind, j.name).toBe('junction');
      // Подпись — «город» с именем перекрёстка рядом с ним.
      const town = game.towns.find((t) => t.name === j.name);
      expect(town && dist(town.center, j.center), j.name).toBeLessThan(1);
      // Только подпись: без числа жителей.
      expect(town?.labelOnly, j.name).toBe(true);
    }
    // Перекрёстки не слиплись: от каждого до соседнего — с запасом.
    const nodes = scene.junctions.map((j) => net.node(j.node!).pos);
    for (const [i, a] of nodes.entries()) for (const b of nodes.slice(i + 1)) expect(dist(a, b)).toBeGreaterThan(300);
    // Кадр — вся сцена.
    for (const p of nodes) {
      expect(p.x).toBeGreaterThan(scene.view.x0);
      expect(p.x).toBeLessThan(scene.view.x1);
      expect(p.y).toBeGreaterThan(scene.view.y0);
      expect(p.y).toBeLessThan(scene.view.y1);
    }
  });

  it('косой X — под 32°, со скруглёнными острыми углами; у смещённого — два Т рядом', () => {
    for (const name of ['Косой X 2+2 × 2+2, 32°', 'Косой X, углы скруглены']) {
      const angles = net.ends(junction(name)).map((e) => deg(Math.atan2(e.away.y, e.away.x)));
      const sorted = angles.sort((a, b) => a - b);
      const gaps = sorted.map((a, i) => (i ? a - sorted[i - 1] : a + 360 - sorted[sorted.length - 1]));
      expect(Math.min(...gaps), name).toBeCloseTo(32, 0);
    }
    expect(junction('Косой X 2+2 × 2+2, 32°').corners).toBeUndefined();
    const radii = Object.values(junction('Косой X, углы скруглены').corners ?? {});
    expect(radii).toHaveLength(2);
    for (const r of radii) expect(r).toBeGreaterThan(10);
    const offset = scene.junctions.find((j) => j.name === 'Смещённый')!;
    const tees = net.nodesNear(offset.center, 40).filter((n) => n.kind === 'junction');
    expect(tees.map((n) => net.ends(n).length)).toEqual([3, 3]);
  });

  it('у «Правый поворот и съезд» — полоса правого поворота перед перекрёстком и однополосный съезд в обход', () => {
    const j = scene.junctions.find((x) => x.name === 'Правый поворот и съезд')!;
    const n = net.node(j.node!);
    // С запада подъезжают по трём полосам (две проспекта и полоса поворота), уезжают по двум.
    const west = net.ends(n).find((e) => e.away.x < -0.9)!;
    const toward = west.corridor.lanes.filter((l) => (l.flow === 1) === (west.end === 'b'));
    expect(toward).toHaveLength(3);
    const ramps = [...net.corridors.values()].filter((c) => c.lanes.length === 1 && dist(c.curve.p0, j.center) < 200 && dist(c.curve.p3, j.center) < 200);
    expect(ramps.length).toBeGreaterThan(0);
  });

  it('автобусы ходят через перекрёстки: каждый маршрут обходит все остановки', () => {
    expect(Object.keys(scene.lines).sort()).toEqual(['cross', 'skew', 'wide']);
    const visited = new Map<number, Set<number>>();
    game.speed = 1;
    for (let t = 0; t < 150; t += 0.1) {
      game.update(0.1);
      for (const v of game.fleet.values()) {
        if (v.state !== 'loading') continue;
        const line = game.lines.get(v.lineId)!;
        const seen = visited.get(line.id) ?? new Set<number>();
        seen.add(line.stops[v.stop]);
        visited.set(line.id, seen);
      }
    }
    for (const id of Object.values(scene.lines)) {
      const line = game.lines.get(id)!;
      expect(line.problem, line.name).toBeNull();
      expect(visited.get(id)?.size, line.name).toBe(line.stops.length);
    }
  });
});
