import { describe, expect, it } from 'vitest';
import { add, scale, Vec } from '../core/vec';
import { routeFromNode } from '../sim/routing';
import type { RoadSpec } from '../world/roadTypes';
import type { RoadRequest } from './build';
import { Game } from './game';
import type { TemplateKind } from './interchange';

const MOTORWAY: RoadSpec = { cls: 'motorway', lanesF: 2, lanesB: 2 };

function straight(from: Vec, to: Vec, spec: RoadSpec): RoadRequest {
  return { start: { kind: 'free', pos: from, level: 0 }, end: { kind: 'free', pos: to, level: 0 }, spec, mode: 'straight' };
}

/** Прямая автомагистраль в свободном месте, где поместится и развязка. */
function motorway(game: Game, len: number): { from: Vec; dir: Vec } {
  for (let y = 500; y < game.terrain.height - 500; y += 150) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 200) {
      const dir = { x: 1, y: 0 };
      const from = { x, y };
      const req = straight(from, add(from, scale(dir, len)), MOTORWAY);
      if (!game.builder.plan(req).ok) continue;
      game.builder.build(req);
      if (game.diamondPlan(add(from, scale(dir, len / 2)), 14).ok) return { from, dir };
      game.builder.bulldoze(add(from, scale(dir, len / 2)), 4);
    }
  }
  throw new Error('нет места');
}

describe('Шаблоны развязок', () => {
  it('«ромб»: мост над автомагистралью и четыре съезда, проезд в обе стороны', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 5_000_000, water: 'dry' });
    const { from, dir } = motorway(game, 1600);
    const center = add(from, scale(dir, 800));
    const plan = game.diamondPlan(center, 14);
    expect(plan.ok).toBe(true);
    const before = game.net.segments.size;
    expect(game.buildTemplate(plan, 'развязка «ромб»')).toBeNull();
    expect(game.net.segments.size).toBeGreaterThanOrEqual(before + 9);
    // Мост над магистралью на высоте 1.
    const bridge = [...game.net.segments.values()].find((s) => s.spec.cls === 'avenue' && game.net.node(s.a).level === 1 && game.net.node(s.b).level === 1);
    expect(bridge).toBeDefined();
    // С конца поперечной дороги можно доехать до обоих концов магистрали.
    const nodeAt = (p: Vec) => [...game.net.nodes.values()].sort((a, b) => Math.hypot(a.pos.x - p.x, a.pos.y - p.y) - Math.hypot(b.pos.x - p.x, b.pos.y - p.y))[0];
    // Тупики поперечной дороги — по обе стороны магистрали.
    const ends = [...game.net.nodes.values()]
      .filter((n) => n.segments.length === 1 && game.net.segment(n.segments[0]).spec.cls === 'avenue' && Math.hypot(n.pos.x - center.x, n.pos.y - center.y) < 400)
      .map((n) => n.id);
    expect(ends).toHaveLength(2);
    const crossEnd = game.net.node(ends[0]);
    const west = nodeAt(from);
    const east = nodeAt(add(from, scale(dir, 1600)));
    // Никаких проездов со съезда на съезд через барьер.
    for (const n of [...game.net.nodes.values()].filter((x) => game.net.roadSegs(x).some((s) => game.net.segment(s).spec.cls === 'motorway'))) {
      for (const m of game.net.nodeMovements.get(n.id) ?? []) {
        const a = game.net.segment(game.net.links.get(m.inLink)!.seg);
        const b = game.net.segment(game.net.links.get(m.outLink)!.seg);
        expect(a.spec.cls === 'avenue' && b.spec.cls === 'avenue').toBe(false);
      }
    }
    expect(routeFromNode(game.net, crossEnd.id, west.id)).not.toBeNull();
    expect(routeFromNode(game.net, crossEnd.id, east.id)).not.toBeNull();
    // И с магистрали — на поперечную дорогу.
    expect(routeFromNode(game.net, west.id, crossEnd.id)).not.toBeNull();
    // Отмена убирает развязку целиком.
    game.undo();
    expect(game.net.segments.size).toBe(before);
  });

  /** Тупики рядом с центром: концы магистрали и поперечной дороги. */
  function deadEnds(game: Game, center: Vec, radius: number): number[] {
    return [...game.net.nodes.values()]
      .filter((n) => game.net.roadSegs(n).length === 1 && Math.hypot(n.pos.x - center.x, n.pos.y - center.y) < radius)
      .map((n) => n.id);
  }

  /** Отовсюду можно доехать всюду, кроме разворота обратно. */
  function allRoutes(game: Game, ends: number[]): void {
    for (const a of ends) {
      for (const b of ends) {
        if (a === b) continue;
        expect(routeFromNode(game.net, a, b), `${a} → ${b}`).not.toBeNull();
      }
    }
  }

  /** Ищет место: магистраль длиной len, на которой встанет развязка вида kind. */
  function placeOn(game: Game, kind: TemplateKind, len: number): Vec {
    for (let y = 700; y < game.terrain.height - 700; y += 150) {
      for (let x = 300; x < game.terrain.width - len - 300; x += 200) {
        const from = { x, y };
        const req = straight(from, { x: x + len, y }, MOTORWAY);
        if (!game.builder.plan(req).ok) continue;
        game.builder.build(req);
        const center = { x: x + len / 2, y };
        if (game.templatePlan(center, 14, { kind, angle: 0, trunk: MOTORWAY }).ok) return center;
        game.builder.bulldoze(center, 4);
      }
    }
    throw new Error('нет места');
  }

  it('«Т-образная»: ответвление в сторону курсора, проезд во все стороны без перекрёстков в уровне', () => {
    const game = new Game({ seed: 11, size: 'medium', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });
    const center = placeOn(game, 'tee', 1600);
    // Курсор чуть ниже оси — ответвление вниз (+y).
    const plan = game.templatePlan({ x: center.x, y: center.y + 10 }, 14, { kind: 'tee', angle: 0, trunk: MOTORWAY });
    expect(plan.ok).toBe(true);
    expect(game.buildTemplate(plan, 'Т-образная')).toBeNull();
    const ends = deadEnds(game, center, 900);
    // Два конца магистрали и конец ответвления — снизу.
    expect(ends).toHaveLength(3);
    const branch = ends.map((id) => game.net.node(id)).find((n) => game.net.segment(n.segments[0]).spec.cls === 'avenue')!;
    expect(branch.pos.y).toBeGreaterThan(center.y + 200);
    allRoutes(game, ends);
  });

  it('«клеверный лист» на магистрали: 12 направлений', () => {
    const game = new Game({ seed: 11, size: 'medium', towns: 2, industries: 'few', money: 9_000_000, water: 'dry' });
    const center = placeOn(game, 'clover', 1800);
    const plan = game.templatePlan(center, 14, { kind: 'clover', angle: 0, trunk: MOTORWAY });
    const error = game.buildTemplate(plan, 'клеверный лист');
    expect(error).toBeNull();
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
      const trunk = game.net.findSegmentNear(built!, 40, (s) => s.spec.cls === 'motorway');
      expect(trunk, kind).not.toBeNull();
      const ends = deadEnds(game, built!, 1200);
      expect(ends.length, kind).toBe(kind === 'tee' ? 3 : 4);
      allRoutes(game, ends);
    }
  });
});
