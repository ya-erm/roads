import { describe, expect, it } from 'vitest';
import { add, dist, Vec } from '../core/vec';
import { snapPaste } from '../lanes/fragment';
import { profileOf } from '../lanes/model';
import type { RoadSpec } from '../world/roadTypes';
import { DEFAULT_RING } from './roads';
import { Game } from './game';
import { AVENUE, road, roadPlan } from './testkit';

const MOTORWAY: RoadSpec = { cls: 'motorway', lanesF: 2, lanesB: 2 };

const newGame = () => new Game({ seed: 11, size: 'medium', towns: 2, industries: 'few', money: 50_000_000, water: 'dry' });

/** Первое место сетки, где получилось. */
function somewhere(game: Game, step: number, margin: number, tryAt: (p: Vec) => boolean): Vec {
  for (let y = margin; y < game.terrain.height - margin; y += step) {
    for (let x = margin; x < game.terrain.width - margin; x += step) {
      const p = { x, y };
      const before = game.roads.net.clone();
      if (tryAt(p)) return p;
      game.roads.replace(before);
      game.networkChanged();
    }
  }
  throw new Error('нет места');
}

/** Перекрёсток двух проспектов с плечами по 150 м. */
function crossroads(game: Game): Vec {
  return somewhere(game, 200, 400, (p) => road(game, { free: add(p, { x: -150, y: 0 }) }, { free: add(p, { x: 150, y: 0 }) }, AVENUE) && road(game, add(p, { x: 0, y: -150 }), add(p, { x: 0, y: 150 }), AVENUE));
}

const deadEnds = (game: Game, center: Vec, r: number) => {
  const net = game.roads.net;
  return [...net.nodes.values()].filter((n) => net.isDeadEnd(n) && dist(n.pos, center) < r).map((n) => n.id);
};

function allRoutes(game: Game, ends: number[]): void {
  for (const a of ends) for (const b of ends) if (a !== b) expect(game.roads.route(a, b), `${a} → ${b}`).not.toBeNull();
}

describe('Копирование и вставка', { timeout: 60_000 }, () => {
  it('перекрёсток копируется рамкой и вставляется повёрнутым на 45° в чистом поле', () => {
    const game = newGame();
    const p = crossroads(game);
    const frag = game.copyArea(add(p, { x: -100, y: -100 }), add(p, { x: 100, y: 100 }))!;
    expect(frag).not.toBeNull();
    // Четыре плеча, обрезанные по рамке, и перекрёсток.
    expect(frag.corridors).toHaveLength(4);
    expect(frag.nodes.filter((n) => n.kind === 'junction')).toHaveLength(1);
    for (const c of frag.corridors) expect(c.length).toBeCloseTo(100, 0);
    const at = somewhere(game, 200, 400, (q) => game.pastePlan(frag, q, Math.PI / 4).ok && dist(q, p) > 500);
    const before = game.roads.net.corridors.size;
    expect(game.paste(frag, at, Math.PI / 4)).toBeNull();
    const net = game.roads.net;
    expect(net.problems()).toEqual([]);
    expect(net.corridors.size).toBe(before + 4);
    const j = [...net.nodes.values()].find((n) => n.kind === 'junction' && dist(n.pos, at) < 1)!;
    expect(j.corridors).toHaveLength(4);
    // Плечо повёрнуто: тупики — на диагоналях.
    const ends = deadEnds(game, at, 120);
    expect(ends).toHaveLength(4);
    for (const id of ends) {
      const d = net.node(id).pos;
      expect(Math.abs(Math.abs(d.x - at.x) - Math.abs(d.y - at.y))).toBeLessThan(1);
    }
    allRoutes(game, ends);
    game.undo();
    expect(game.roads.net.corridors.size).toBe(before);
  });

  it('вставка на дорогу заменяет её кусок под рамкой и примыкает к срезам', () => {
    const game = newGame();
    const p = crossroads(game);
    const frag = game.copyArea(add(p, { x: -100, y: -100 }), add(p, { x: 100, y: 100 }))!;
    // Длинный проспект в другом месте; вставка — немного мимо оси и под углом, прилипание выправит.
    const q = somewhere(game, 200, 600, (o) => dist(o, p) > 700 && road(game, { free: add(o, { x: -400, y: 0 }) }, { free: add(o, { x: 400, y: 0 }) }, AVENUE));
    const snap = snapPaste(game.roads.net, frag, add(q, { x: 30, y: 6 }), 0.2, 30);
    expect(snap.snapped).toBe(true);
    expect(Math.abs(Math.sin(snap.angle))).toBeLessThan(1e-6);
    expect(Math.abs(snap.at.y - q.y)).toBeLessThan(0.5);
    const plan = game.pastePlan(frag, snap.at, snap.angle);
    expect(plan.reason ?? 'ok').toBe('ok');
    expect(game.paste(frag, snap.at, snap.angle)).toBeNull();
    const net = game.roads.net;
    expect(net.problems()).toEqual([]);
    // Проспект продолжается через вставленный перекрёсток: концы проспекта и два плеча поперёк.
    const j = [...net.nodes.values()].find((n) => n.kind === 'junction' && dist(n.pos, snap.at) < 1)!;
    expect(j.corridors).toHaveLength(4);
    const ends = deadEnds(game, q, 450);
    expect(ends).toHaveLength(4);
    allRoutes(game, ends);
  });

  it('кольцо копируется целиком и вставляется своим кольцом', () => {
    const game = newGame();
    const p = crossroads(game);
    expect(game.buildRoundabout(p, 14, DEFAULT_RING)).toBe(true);
    const [ring] = [...game.roundaboutCenters.keys()];
    // Рамка задевает только край кольца — всё равно берётся целиком.
    const frag = game.copyArea(add(p, { x: 0, y: -120 }), add(p, { x: 130, y: 120 }))!;
    expect(frag.corridors.filter((c) => c.ring).length).toBeGreaterThanOrEqual(4);
    const at = somewhere(game, 200, 400, (q) => dist(q, p) > 500 && game.paste(frag, q, 1) === null);
    const net = game.roads.net;
    expect(net.problems()).toEqual([]);
    expect(game.roundaboutCenters.size).toBe(2);
    const other = [...game.roundaboutCenters].find(([id]) => id !== ring)!;
    // Центр кольца в куске — на 65 м левее центра рамки; кусок повёрнут на 1 рад.
    expect(dist(other[1], add(at, { x: -65 * Math.cos(1), y: -65 * Math.sin(1) }))).toBeLessThan(2);
    // Плечи на севере и юге (по самому краю рамки) и на востоке.
    const ends = deadEnds(game, at, 300);
    expect(ends).toHaveLength(3);
    allRoutes(game, ends);
  });

  it('скопированный «ромб» встаёт на другую автомагистраль: съезды по полосам, проезд всюду', () => {
    const game = newGame();
    const lay = (a: Vec, b: Vec) => {
      const plan = roadPlan(game, { free: a }, { free: b }, profileOf(MOTORWAY));
      return plan.ok && game.roadBuilder.apply(plan);
    };
    const c1 = somewhere(game, 200, 900, (o) => lay(add(o, { x: -800, y: 0 }), add(o, { x: 800, y: 0 })) && game.buildTemplate(game.diamondPlan(o, 14), 'ромб') === null);
    const frag = game.copyArea(add(c1, { x: -450, y: -300 }), add(c1, { x: 450, y: 300 }))!;
    expect(frag.corridors.filter((c) => c.portA || c.portB)).toHaveLength(4);
    const c2 = somewhere(game, 200, 900, (o) => Math.abs(o.y - c1.y) > 700 && lay(add(o, { x: -800, y: 0 }), add(o, { x: 800, y: 0 })));
    const snap = snapPaste(game.roads.net, frag, add(c2, { x: 0, y: 4 }), Math.PI + 0.1, 30);
    expect(snap.snapped).toBe(true);
    const plan = game.pastePlan(frag, snap.at, snap.angle);
    expect(plan.reason ?? 'ok').toBe('ok');
    expect(game.paste(frag, snap.at, snap.angle)).toBeNull();
    const net = game.roads.net;
    expect(net.problems()).toEqual([]);
    // На магистрали нет перекрёстков в уровне.
    for (const n of net.nodes.values()) {
      if (n.kind === 'junction') expect(n.corridors.some((id) => net.corridor(id).cls === 'motorway')).toBe(false);
    }
    // Концы магистрали (±800) и поперечной дороги развязки; первый «ромб» — дальше 700 по y.
    const ends = deadEnds(game, c2, 1000).filter((id) => Math.abs(net.node(id).pos.y - c2.y) < 400);
    expect(ends).toHaveLength(4);
    allRoutes(game, ends);
  });
});
