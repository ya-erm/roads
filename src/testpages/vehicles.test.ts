import { describe, expect, it } from 'vitest';
import { hitchOf, jointOf, trailDir } from '../sim/body';
import { MODELS } from '../game/transport';
import { buildVehiclesScene } from './vehicles';

/** Угол между курсами первой и второй части кузова, градусы. */
function bend(v: { pos: { x: number; y: number }; dir: { x: number; y: number }; trail?: { x: number; y: number }; length: number; body?: Parameters<typeof hitchOf>[0] }): number {
  const h = hitchOf(v.body)!;
  const td = trailDir(jointOf(v.pos, v.dir, v.length, h), v.trail, v.dir);
  return (Math.acos(Math.max(-1, Math.min(1, v.dir.x * td.x + v.dir.y * td.y))) * 180) / Math.PI;
}

describe('Тестовая страница /test/vehicles', { timeout: 90_000 }, () => {
  it('все модели на сетке улиц обходят свои станции, а тягачи и сочленённый гнутся на поворотах', () => {
    const scene = buildVehiclesScene();
    expect(scene.errors).toEqual([]);
    const { game } = scene;
    expect(Object.keys(scene.lines).sort()).toEqual(['bus', 'bus2', 'bus3', 'truck', 'truck2', 'truck3']);
    expect(game.roads.net.problems()).toEqual([]);
    // На каждой линии — своя модель.
    for (const [key, id] of Object.entries(scene.lines)) {
      for (const vid of game.lines.get(id)!.vehicles) expect(game.fleet.get(vid)!.model).toBe(key);
    }
    // Витрина и повороты: машины без линий — на проспекте шесть пустых рядом и девять грузовиков с грузом,
    // на углах — двенадцать.
    const shown = [...game.traffic.vehicles.values()].filter((s) => !game.isFleet(s));
    expect(shown).toHaveLength(27);
    const showroom = shown.filter((s) => s.pos.y > 1500 && s.pos.y < 1620);
    const empty = showroom.filter((s) => !s.load);
    expect(empty.map((s) => s.body).sort()).toEqual(['articBus', 'cityBus', 'longSemi', 'microbus', 'semi', 'van']);
    for (const s of empty) expect(s.pos.x).toBeCloseTo(empty[0].pos.x, 0);
    // С грузом — по три разных на каждый грузовик, впереди пустого в его полосе.
    const loaded = showroom.filter((s) => s.load);
    expect(loaded).toHaveLength(9);
    for (const body of ['van', 'semi', 'longSemi'] as const) {
      const mine = loaded.filter((s) => s.body === body);
      expect(new Set(mine.map((s) => s.load)).size, body).toBe(3);
      for (const s of mine) expect(s.pos.x, body).toBeGreaterThan(empty[0].pos.x);
      // Самый передний — с наливным грузом: автоцистерна, остальные — с кузовом.
      const front = mine.reduce((a, b) => (b.pos.x > a.pos.x ? b : a));
      expect(mine.filter((s) => s.tank), body).toEqual([front]);
    }
    expect(empty.some((s) => s.tank)).toBe(false);
    // Застыли изогнутыми: у машин из двух частей вторая часть ещё в повороте.
    for (const s of shown.filter((s) => !showroom.includes(s) && hitchOf(s.body))) expect(bend(s), s.body).toBeGreaterThan(15);
    const still = shown.map((s) => ({ s, x: s.pos.x, y: s.pos.y }));
    const visited = new Map<number, Set<number>>();
    const maxBend = new Map<string, number>();
    /** Наименьший зазор между передним углом полуприцепа и задней стенкой кабины (меньше нуля — задели). */
    const worstGap = new Map<string, number>();
    game.speed = 1;
    // Круг Фуры через четыре автостанции — около четырёх минут.
    for (let t = 0; t < 300; t += 0.1) {
      game.update(0.1);
      for (const v of game.fleet.values()) {
        const line = game.lines.get(v.lineId)!;
        if (v.state === 'loading') {
          const seen = visited.get(line.id) ?? new Set<number>();
          seen.add(line.stops[v.stop]);
          visited.set(line.id, seen);
        }
        const sim = game.fleetSim(v);
        if (!sim || !hitchOf(sim.body)) continue;
        expect(sim.trail, v.model).toBeTruthy();
        // Ось второй части всегда на своём месте за шарниром.
        const joint = jointOf(sim.pos, sim.dir, sim.length, hitchOf(sim.body)!);
        expect(Math.hypot(joint.x - sim.trail!.x, joint.y - sim.trail!.y)).toBeCloseTo(sim.length * hitchOf(sim.body)!.tail, 1);
        maxBend.set(v.model, Math.max(maxBend.get(v.model) ?? 0, bend(sim)));
        // Полуприцеп на повороте не задевает кабину: его передние углы — позади её задней стенки.
        const h = hitchOf(sim.body)!;
        if (h.cab !== undefined) {
          const td = trailDir(joint, sim.trail, sim.dir);
          const a = (h.joint - h.back) * sim.length;
          for (const side of [-1, 1]) {
            const corner = { x: joint.x + td.x * a - td.y * side * (sim.width / 2), y: joint.y + td.y * a + td.x * side * (sim.width / 2) };
            const ahead = (corner.x - sim.pos.x) * sim.dir.x + (corner.y - sim.pos.y) * sim.dir.y;
            worstGap.set(v.model, Math.min(worstGap.get(v.model) ?? Infinity, -h.cab * sim.length - ahead));
          }
        }
      }
    }
    // Выставленные машины так и стоят.
    for (const { s, x, y } of still) {
      expect(game.traffic.vehicles.get(s.id), s.body).toBe(s);
      expect(Math.hypot(s.pos.x - x, s.pos.y - y), s.body).toBeLessThan(0.01);
    }
    for (const id of Object.values(scene.lines)) {
      const line = game.lines.get(id)!;
      expect(line.problem, line.name).toBeNull();
      expect(visited.get(id)?.size, line.name).toBe(line.stops.length);
    }
    // На поворотах вторая часть заметно отстаёт по курсу, но не складывается.
    for (const model of ['truck2', 'truck3', 'bus3'] as const) {
      expect(MODELS[model].mode === 'road' && hitchOf(MODELS[model].spec.body), model).toBeTruthy();
      expect(maxBend.get(model), model).toBeGreaterThan(20);
      expect(maxBend.get(model), model).toBeLessThan(60);
    }
    for (const model of ['truck2', 'truck3']) expect(worstGap.get(model), model).toBeGreaterThan(0);
  });
});
