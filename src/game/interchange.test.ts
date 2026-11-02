import { describe, expect, it } from 'vitest';
import { add, scale, Vec } from '../core/vec';
import { profileOf } from '../lanes/model';
import type { RoadSpec } from '../world/roadTypes';
import { Game } from './game';
import type { TemplateKind } from './interchange';
import { roadPlan } from './testkit';

const MOTORWAY: RoadSpec = { cls: 'motorway', lanesF: 2, lanesB: 2 };

/** Строит прямую автомагистраль; false — не встала. */
function lay(game: Game, from: Vec, to: Vec): boolean {
  const plan = roadPlan(game, { free: from }, { free: to }, profileOf(MOTORWAY));
  return plan.ok && game.roadBuilder.apply(plan);
}

/** Прямая автомагистраль в свободном месте, где поместится «ромб». */
function motorway(game: Game, len: number): { from: Vec; dir: Vec } {
  for (let y = 500; y < game.terrain.height - 500; y += 150) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 200) {
      const dir = { x: 1, y: 0 };
      const from = { x, y };
      const before = game.roads.net.clone();
      if (!lay(game, from, add(from, scale(dir, len)))) continue;
      if (game.diamondPlan(add(from, scale(dir, len / 2)), 14).ok) return { from, dir };
      game.roads.replace(before);
      game.networkChanged();
    }
  }
  throw new Error('нет места');
}

/** Тупики рядом с центром: концы магистрали и поперечной дороги. */
function deadEnds(game: Game, center: Vec, radius: number): number[] {
  const net = game.roads.net;
  return [...net.nodes.values()].filter((n) => net.isDeadEnd(n) && Math.hypot(n.pos.x - center.x, n.pos.y - center.y) < radius).map((n) => n.id);
}

/** Отовсюду можно доехать всюду, кроме разворота обратно. */
function allRoutes(game: Game, ends: number[]): void {
  for (const a of ends) {
    for (const b of ends) {
      if (a === b) continue;
      expect(game.roads.route(a, b), `${a} → ${b}`).not.toBeNull();
    }
  }
}

/** На магистрали нет перекрёстков в уровне: съезды и въезды — по полосам через стыки. */
function noTrunkJunctions(game: Game): void {
  const net = game.roads.net;
  for (const n of net.nodes.values()) {
    if (n.kind !== 'junction') continue;
    expect(n.corridors.some((id) => net.corridor(id).cls === 'motorway')).toBe(false);
  }
}

/** Ищет место: магистраль длиной len, на которой встанет развязка вида kind. */
function placeOn(game: Game, kind: TemplateKind, len: number): Vec {
  for (let y = 700; y < game.terrain.height - 700; y += 150) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 200) {
      const before = game.roads.net.clone();
      if (!lay(game, { x, y }, { x: x + len, y })) continue;
      const center = { x: x + len / 2, y };
      if (game.templatePlan(center, 14, { kind, angle: 0, trunk: MOTORWAY }).ok) return center;
      game.roads.replace(before);
      game.networkChanged();
    }
  }
  throw new Error('нет места');
}

// Развязки строятся из десятков кусков на всей сети — дольше стандартного лимита.
describe('Шаблоны развязок', { timeout: 60_000 }, () => {
  it('«ромб»: мост над автомагистралью и четыре съезда по полосам, проезд в обе стороны', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry' });
    const { from, dir } = motorway(game, 1600);
    const center = add(from, scale(dir, 800));
    const plan = game.diamondPlan(center, 14);
    expect(plan.reason ?? 'ok').toBe('ok');
    const before = game.roads.net.corridors.size;
    expect(game.buildTemplate(plan, 'развязка «ромб»')).toBeNull();
    const net = game.roads.net;
    expect(net.problems()).toEqual([]);
    expect(net.corridors.size).toBeGreaterThanOrEqual(before + 9);
    // Мост над магистралью на высоте 1.
    expect([...net.corridors.values()].some((c) => c.cls === 'avenue' && net.node(c.a).level === 1 && net.node(c.b).level === 1)).toBe(true);
    // Съезды — стыками с боковым портом, перекрёстков на магистрали нет.
    noTrunkJunctions(game);
    expect([...net.corridors.values()].filter((c) => c.portA || c.portB).length).toBe(4);
    // Тупики поперечной дороги — по обе стороны магистрали; оттуда — на оба конца магистрали и обратно.
    const ends = deadEnds(game, center, 1000);
    expect(ends).toHaveLength(4);
    allRoutes(game, ends);
    // Отмена убирает развязку целиком.
    game.undo();
    expect(game.roads.net.corridors.size).toBe(before);
  });

  it('«Т-образная»: ответвление в сторону курсора, проезд во все стороны без перекрёстков на магистрали', () => {
    const game = new Game({ seed: 11, size: 'medium', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });
    const center = placeOn(game, 'tee', 1600);
    // Курсор чуть ниже оси — ответвление вниз (+y).
    const plan = game.templatePlan({ x: center.x, y: center.y + 10 }, 14, { kind: 'tee', angle: 0, trunk: MOTORWAY });
    expect(plan.reason ?? 'ok').toBe('ok');
    expect(game.buildTemplate(plan, 'Т-образная')).toBeNull();
    expect(game.roads.net.problems()).toEqual([]);
    noTrunkJunctions(game);
    const ends = deadEnds(game, center, 900);
    // Два конца магистрали и конец ответвления — снизу.
    expect(ends).toHaveLength(3);
    const branch = ends.map((id) => game.roads.net.node(id)).find((n) => game.roads.net.corridor(n.corridors[0]).cls === 'avenue')!;
    expect(branch.pos.y).toBeGreaterThan(center.y + 200);
    allRoutes(game, ends);
  });

  it('«клеверный лист» на магистрали: 12 направлений без перекрёстков', () => {
    const game = new Game({ seed: 11, size: 'medium', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });
    const center = placeOn(game, 'clover', 1800);
    const plan = game.templatePlan(center, 14, { kind: 'clover', angle: 0, trunk: MOTORWAY });
    expect(game.buildTemplate(plan, 'клеверный лист')).toBeNull();
    expect(game.roads.net.problems()).toEqual([]);
    noTrunkJunctions(game);
    const ends = deadEnds(game, center, 1100);
    expect(ends).toHaveLength(4);
    allRoutes(game, ends);
  });

  it('в чистом поле развязка строится вместе с магистралью', () => {
    for (const kind of ['diamond', 'tee', 'clover'] as TemplateKind[]) {
      const game = new Game({ seed: 11, size: 'medium', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });
      let built: Vec | null = null;
      for (let y = 800; y < game.terrain.height - 800 && !built; y += 200) {
        for (let x = 800; x < game.terrain.width - 800 && !built; x += 200) {
          const p = { x, y };
          const plan = game.templatePlan(p, 14, { kind, angle: 0.4, trunk: { cls: 'street', lanesF: 1, lanesB: 1 } });
          if (!plan.ok) continue;
          expect(plan.withTrunk).toBe(true);
          expect(game.buildTemplate(plan, kind), kind).toBeNull();
          built = p;
        }
      }
      expect(built, kind).not.toBeNull();
      // Не «улица», а автомагистраль: выбранный тип не магистраль — берём 2‖2.
      expect(game.roads.net.corridorsNear(built!, 40).some((c) => c.cls === 'motorway'), kind).toBe(true);
      const ends = deadEnds(game, built!, 1200);
      expect(ends.length, kind).toBe(kind === 'tee' ? 3 : 4);
      allRoutes(game, ends);
    }
  });
});
