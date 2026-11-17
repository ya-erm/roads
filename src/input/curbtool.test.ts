import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { Game } from '../game/game';
import { freshGame, road } from '../game/testkit';
import { twoWay } from '../lanes/model';
import { RoadTools } from './roadtools';

const STREET = { cls: 'street' as const, lanesF: 1, lanesB: 1 };
const WORLD = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' } as const;

/** Прямая дорога профиля profile в чистом поле длиной 500 вдоль x: начало. */
function fieldRoad(game: Game, profile: { cls: 'street' | 'avenue' | 'highway'; lanes: ReturnType<typeof twoWay> }): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - 900; x += 160) {
      if (road(game, { free: { x, y } }, { free: { x: x + 500, y } }, profile)) return { x, y };
    }
  }
  throw new Error('нет места');
}

/** Протяжка мышью: нажали в первой точке, провели через остальные, отпустили в последней. */
function drag(tools: RoadTools, pts: Vec[]): string | null {
  tools.laneDown(pts[0], 14);
  for (const p of pts.slice(1)) tools.laneMove(p, 14);
  return tools.laneUp(pts[pts.length - 1], 14, STREET, true);
}

/** Клик (без протяжки). */
function click(tools: RoadTools, p: Vec): string | null {
  tools.laneDown(p, 14);
  return tools.laneUp(p, 14, STREET, false);
}

const along = (game: Game, y: number) => [...game.roads.net.corridors.values()].filter((c) => [c.a, c.b].every((id) => Math.abs(game.roads.net.node(id).pos.y - y) < 1));

describe('«Полоса» с 🅿️', () => {
  it('тянут вдоль края — стоянка с ходом соседней полосы, 0,8 цены полосы; зелёный предпросмотр без домов', () => {
    const game = freshGame(WORLD);
    const at = fieldRoad(game, { cls: 'street', lanes: twoWay(1, 1) });
    const tools = new RoadTools(() => game);
    tools.park = true;
    const pts = [{ x: at.x + 80, y: at.y + 10.5 }, { x: at.x + 250, y: at.y + 10.5 }, { x: at.x + 420, y: at.y + 10.5 }];
    // Предпросмотр: план без сноса и без ужатия участков (поле).
    tools.laneDown(pts[0], 14);
    for (const p of pts.slice(1)) tools.laneMove(p, 14);
    const park = tools.lanePlan(STREET)!;
    expect(park.plan.ok).toBe(true);
    expect(park.plan.demolish).toHaveLength(0);
    expect(park.plan.squeeze ?? []).toHaveLength(0);
    tools.park = false;
    const lane = tools.lanePlan(STREET)!;
    expect(park.plan.cost / lane.plan.cost).toBeCloseTo(0.8, 1);
    tools.park = true;
    expect(tools.laneUp(pts[2], 14, STREET, true)).toBeNull();
    const [c] = along(game, at.y);
    const l = c.lanes.find((x) => x.park)!;
    expect(l).toMatchObject({ offset: 10.5, flow: 1 });
    // По стоянке не едут: в графе в ту сторону — одна полоса.
    expect(game.roads.graph.corridorLinks(c.id).filter((k) => k.flow === 1).every((k) => k.lanes.length === 1)).toBe(true);
    expect(game.curb.stalls().filter((s) => s.corridor === c.id).length).toBeGreaterThan(10);
  });

  it('клик по крайней полосе 2+2 — 🅿️ под парковку, ещё клик — ↺ вернуть движению; на 1+1 и магистрали — отказ', () => {
    const game = freshGame(WORLD);
    const av = fieldRoad(game, { cls: 'avenue', lanes: twoWay(2, 2) });
    const tools = new RoadTools(() => game);
    tools.park = true;
    const p = { x: av.x + 250, y: av.y + 10.5 };
    expect(tools.parkTogglePlan(p)?.to).toBe('park');
    expect(click(tools, p)).toBeNull();
    const c = along(game, av.y)[0];
    expect(c.lanes.find((l) => Math.abs(l.offset - 10.5) < 0.01)?.park).toBe(true);
    expect(game.roads.graph.corridorLinks(c.id).filter((k) => k.flow === 1).some((k) => k.lanes.length === 1)).toBe(true);
    expect(tools.parkTogglePlan(p)?.to).toBe('drive');
    expect(click(tools, p)).toBeNull();
    expect(along(game, av.y)[0].lanes.some((l) => l.park)).toBe(false);
    // 1+1: последняя полоса в эту сторону.
    const st = fieldRoad(game, { cls: 'street', lanes: twoWay(1, 1) });
    expect(click(tools, { x: st.x + 250, y: st.y + 3.5 })).toMatch(/1\+1/);
    // Магистраль: ни забрать полосу, ни протянуть стоянку.
    const hw = fieldRoad(game, { cls: 'highway', lanes: twoWay(2, 2) });
    expect(click(tools, { x: hw.x + 250, y: hw.y + 10.5 })).toMatch(/магистрал/);
    expect(drag(tools, [{ x: hw.x + 80, y: hw.y + 17.5 }, { x: hw.x + 250, y: hw.y + 17.5 }, { x: hw.x + 420, y: hw.y + 17.5 }])).toMatch(/магистрал/);
    expect(along(game, hw.y)[0].lanes.some((l) => l.park)).toBe(false);
    // Ctrl+Z — как у полосы: снимок до правки (контроллер снимает его при нажатии).
    game.checkpoint('полоса');
    expect(click(tools, p)).toBeNull();
    expect(along(game, av.y)[0].lanes.some((l) => l.park)).toBe(true);
    game.undo();
    expect(along(game, av.y)[0].lanes.some((l) => l.park)).toBe(false);
  });
});
