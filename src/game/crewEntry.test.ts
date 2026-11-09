import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../config';
import { dot, sub, type Vec } from '../core/vec';
import type { WorldSettings } from '../world/settings';
import { polyLength, turnIn } from './crewLane';
import { Game } from './game';
import { anchorOf, openSpot, road, runSeconds, STREET, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

/** Самый резкий поворот корпуса машины бригады за такт на съезде с дороги на стройку, градусы. */
const MAX_TURN_PER_TICK = 3;

const angle = (a: Vec, b: Vec) => (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;

/** Самый малый радиус ломаной p по трём соседним точкам (описанная окружность), м. */
function minRadius(p: readonly Vec[]): number {
  let best = Infinity;
  for (let i = 1; i + 1 < p.length; i++) {
    const [a, b, c] = [p[i - 1], p[i], p[i + 1]];
    const ab = Math.hypot(b.x - a.x, b.y - a.y);
    const bc = Math.hypot(c.x - b.x, c.y - b.y);
    const ca = Math.hypot(a.x - c.x, a.y - c.y);
    const cross = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (cross < 1e-9 || ab < 0.05 || bc < 0.05) continue;
    best = Math.min(best, (ab * bc * ca) / (2 * cross));
  }
  return best;
}

describe('Съезд бригады с дороги на стройку у перекрёстка — плавно, без разворота на месте', () => {
  // Ось проекта — на юг от центра узла (0, 0); машина едет на восток по своей полосе (в 3,5 м правее оси улицы).
  const body: Vec[] = Array.from({ length: 21 }, (_, i) => ({ x: 0, y: i * 5 }));

  it('машина у самой стоп-линии и в самом узле: дуга от её места (радиус 9 м, если хватает выноса за ось в 3 м), дальше плавно на ось', () => {
    for (const a of [-0.5, 0.6, 3, 6.6, 12]) {
      const p = { x: -a, y: 3.5 };
      const { pts, end } = turnIn(p, { x: 1, y: 0 }, body);
      const path = [p, ...pts];
      expect(end).toBeDefined();
      expect(minRadius(path), `в ${a} м от оси`).toBeGreaterThan(0.98 * Math.min(9, a + 3));
      // С места — прямо по своему курсу, без излома.
      const d0 = sub(path.find((q) => Math.hypot(q.x - p.x, q.y - p.y) > 0.05)!, p);
      expect(angle({ x: 1, y: 0 }, { x: d0.x / Math.hypot(d0.x, d0.y), y: d0.y / Math.hypot(d0.x, d0.y) })).toBeLessThan(2.6);
      // Выносит за ось не дальше 3 м; к 40 м от узла — уже на оси.
      expect(Math.max(...path.map((q) => q.x))).toBeLessThanOrEqual(3 + 1e-6);
      for (const q of path) if (q.y > 40) expect(Math.abs(q.x)).toBeLessThan(0.05);
      // Курс между соседними точками — не круче 2,5°, нигде не назад.
      for (let i = 2; i < path.length; i++) {
        const d1 = sub(path[i - 1], path[i - 2]);
        const d2 = sub(path[i], path[i - 1]);
        const l1 = Math.hypot(d1.x, d1.y);
        const l2 = Math.hypot(d2.x, d2.y);
        if (l1 < 1e-6 || l2 < 1e-6) continue;
        expect(angle({ x: d1.x / l1, y: d1.y / l1 }, { x: d2.x / l2, y: d2.y / l2 })).toBeLessThan(2.6);
      }
      expect(polyLength(path)).toBeGreaterThan(90);
    }
  });

  it('налево так же, как направо: дуга в другую сторону; на широком полотне выносит дальше — радиус больше', () => {
    const p = { x: 6, y: -3.5 };
    const { pts } = turnIn(p, { x: -1, y: 0 }, body);
    const path = [p, ...pts];
    expect(minRadius(path)).toBeGreaterThan(8.9);
    expect(Math.min(...path.map((q) => q.x))).toBeGreaterThanOrEqual(-3 - 1e-6);
    const q = { x: 0.6, y: -3.5 };
    const wide = [q, ...turnIn(q, { x: -1, y: 0 }, body, 5.6).pts];
    expect(minRadius(wide)).toBeGreaterThan(0.98 * 6.2);
    expect(Math.min(...wide.map((v) => v.x))).toBeGreaterThanOrEqual(-5.6 - 1e-6);
    // Выходит на ось плавно: наклон к оси — не круче 15°.
    for (let i = 1; i < wide.length; i++) {
      const v = sub(wide[i], wide[i - 1]);
      if (wide[i].y > 10 && Math.hypot(v.x, v.y) > 0.05) expect(Math.abs(Math.atan2(v.x, v.y)) * (180 / Math.PI)).toBeLessThan(15);
    }
  });

  /**
   * Улица с запада на восток и вторая в 300 м южнее; проект — улица между ними посередине (от Т-перекрёстка, как на
   * снимках игрока). База — у западного конца северной улицы (колонна поворачивает к стройке направо) или у
   * восточного (налево).
   */
  function scene(baseX: number) {
    const game = withoutCitizens(new Game(WORLD));
    const at = openSpot(game, [
      [{ x: 0, y: 0 }, { x: 1000, y: 0 }, 120],
      [{ x: 0, y: 300 }, { x: 1000, y: 300 }, 120],
    ]);
    const south = at.y + 300;
    expect(road(game, { free: at }, { free: { x: at.x + 1000, y: at.y } })).toBe(true);
    expect(road(game, { free: { x: at.x, y: south } }, { free: { x: at.x + 1000, y: south } })).toBe(true);
    expect(game.buildBase({ x: at.x + baseX, y: at.y - 40 })).toBeNull();
    const plan = game.roadBuilder.road(anchorOf(game, { x: at.x + 500, y: at.y }), anchorOf(game, { x: at.x + 500, y: south }), STREET, { project: true });
    expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
    const b = [...game.construction.crews.brigades.values()][0];
    return { game, b };
  }

  it.each([
    ['направо', 120],
    ['налево', 880],
  ])('%s: от подъезда до начала работ курс каждой машины меняется не больше чем на 3° за такт', (_, baseX) => {
    const { game, b } = scene(baseX);
    const crews = game.construction.crews;
    for (let t = 0; t < 120 && !b.lane; t += 0.1) runSeconds(game, 0.1);
    expect(b.lane).toBeDefined();
    expect(b.lane!.slow).toBeGreaterThan(0);
    const prev = new Map<number, Vec>();
    let worst = 0;
    let where = '';
    let turned = 0;
    for (let i = 0; i < 30 * 90 && !crews.placed(b).every(Boolean); i++) {
      const t0 = game.time;
      game.speed = 1;
      game.update(SIM_DT);
      const ticks = Math.max(1, Math.round((game.time - t0) / SIM_DT));
      for (const m of crews.carsAt(b)) {
        if (m.s === undefined) continue;
        const was = prev.get(m.car);
        if (was) {
          const a = angle(was, m.dir) / ticks;
          if (m.car === 0) turned += angle(was, m.dir);
          if (a > worst) where = `машина ${m.car} в ${game.time.toFixed(2)} с, s=${m.s.toFixed(1)}`;
          worst = Math.max(worst, a);
        }
        prev.set(m.car, m.dir);
      }
    }
    expect(crews.placed(b).every(Boolean)).toBe(true);
    // Головная повернула к стройке на 90° (и вернулась на ось после выноса).
    expect(turned).toBeGreaterThan(85);
    expect(worst, where).toBeLessThanOrEqual(MAX_TURN_PER_TICK);
  });
});
