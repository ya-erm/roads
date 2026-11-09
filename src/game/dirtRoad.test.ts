import { describe, expect, it } from 'vitest';
import { laneTipAt } from '../lanes/edit';
import { twoWay } from '../lanes/model';
import { DEFAULT_PRESET_ID, ROAD_CLASSES, ROAD_PRESETS, specCost, specKmh } from '../world/roadTypes';
import { Game } from './game';
import { fieldSpot, roadPlan, STREET, withoutCitizens } from './testkit';

const DIRT = { cls: 'dirt' as const, lanes: twoWay(1, 1) };

/** Ровная карта без городов и прямая дорога профиля profile с запада на восток в чистом поле. */
function scene(profile = DIRT, extra: object = {}) {
  const game = withoutCitizens(new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 5_000_000, water: 'dry', ...extra }));
  const a = fieldSpot(game, 600);
  const plan = roadPlan(game, { free: a }, { free: { x: a.x + 600, y: a.y } }, profile);
  return { game, a, plan };
}

describe('Грунтовая в инструменте «Дорога»', { timeout: 60_000 }, () => {
  it('в панели — первой: самая дешёвая и самая медленная; по умолчанию по-прежнему шоссе', () => {
    const dirt = ROAD_PRESETS[0];
    expect(dirt.id).toBe('dirt');
    expect(dirt.spec).toEqual({ cls: 'dirt', lanesF: 1, lanesB: 1 });
    expect(specKmh(dirt.spec)).toBe(ROAD_CLASSES.dirt.limit);
    for (const p of ROAD_PRESETS.slice(1)) {
      expect(specCost(p.spec)).toBeGreaterThan(specCost(dirt.spec));
      expect(specKmh(p.spec)).toBeGreaterThan(specKmh(dirt.spec));
    }
    expect(DEFAULT_PRESET_ID).toBe('road');
  });

  it('строится, как любая дорога, и вдвое с лишним дешевле улицы той же длины', () => {
    const { game, plan } = scene();
    expect(plan.reason).toBeUndefined();
    const street = roadPlan(game, { free: fieldSpot(game, 600) }, { free: { x: fieldSpot(game, 600).x + 600, y: fieldSpot(game, 600).y } }, STREET);
    expect(street.ok).toBe(true);
    expect(plan.cost * 2).toBeLessThan(street.cost);
    expect(game.roadBuilder.apply(plan)).toBe(true);
    expect([...game.roads.net.corridors.values()].every((c) => c.cls === 'dirt')).toBe(true);
    expect(game.roads.net.problems()).toEqual([]);
  });

  it('у грунтовки встают автостанция и остановка; полоса и съезд — тоже грунтовые', () => {
    const { game, a, plan } = scene();
    game.roadBuilder.apply(plan);
    expect(game.placeStation({ x: a.x + 150, y: a.y + 40 }, 30)).not.toBeNull();
    expect(game.placeStation({ x: a.x + 420, y: a.y }, 14, 'stop')).not.toBeNull();
    // «Полоса» по точкам: вдоль края и съездом в сторону.
    const tip = laneTipAt(game.roads.net, { x: a.x + 250, y: a.y - 7 }, 14);
    expect(tip.kind).toBe('edge');
    const step = game.roadBuilder.laneStep(tip, [{ x: a.x + 360, y: a.y - 7 }], 'dirt', 14);
    expect(step.plan.reason).toBeUndefined();
    expect(game.roadBuilder.apply(step.plan)).toBe(true);
    expect(game.roads.net.problems()).toEqual([]);
    expect([...game.roads.net.corridors.values()].filter((c) => c.cls !== 'dirt' && c.cls !== 'highway')).toEqual([]);
  });

  it('перестраивается в любой тип и обратно; две полосы в сторону — тоже можно', () => {
    const { game, plan } = scene();
    game.roadBuilder.apply(plan);
    const id = [...game.roads.net.corridors.keys()][0];
    const up = game.roadBuilder.rebuild(id, { cls: 'avenue', lanes: twoWay(2, 2) });
    expect(up.reason).toBeUndefined();
    expect(up.cost).toBeGreaterThan(0);
    game.roadBuilder.apply(up);
    const back = game.roadBuilder.rebuild(id, { cls: 'dirt', lanes: twoWay(2, 2) });
    expect(back.reason).toBeUndefined();
    game.roadBuilder.apply(back);
    expect(game.roads.net.corridor(id).cls).toBe('dirt');
    expect(game.roads.net.corridor(id).lanes).toHaveLength(4);
  });

  it('«Со строительством» — проектом, и грунтовку строят быстрее улицы', () => {
    const extra = { construction: 'build' };
    const { game, a } = scene(DIRT, extra);
    const end = { x: a.x + 600, y: a.y };
    const dirt = game.roadBuilder.road({ kind: 'free', pos: a }, { kind: 'free', pos: end }, DIRT, { project: true });
    const street = game.roadBuilder.road({ kind: 'free', pos: a }, { kind: 'free', pos: end }, STREET, { project: true });
    expect(dirt.project).toBeDefined();
    expect(dirt.project!.seconds).toBeLessThan(street.project!.seconds);
    expect(dirt.project!.cost).toBeLessThan(street.project!.cost);
    expect(game.roadBuilder.apply(dirt)).toBe(true);
    expect(game.construction.list()).toHaveLength(1);
  });

  it('город застраивает грунтовку внутри себя, а просёлок в поле — нет', () => {
    const game = new Game(1);
    const streetLike = (id: number) => (game as unknown as { streetLike(c: unknown): boolean }).streetLike(game.roads.net.corridor(id));
    const town = [...game.towns].sort((x, y) => y.population - x.population)[0];
    // Просёлки мира к предприятиям уходят из города в поле — вдоль них город не растёт.
    const field = [...game.roads.net.corridors.values()].filter((c) => c.cls === 'dirt');
    expect(field.length).toBeGreaterThan(0);
    for (const c of field) expect(streetLike(c.id)).toBe(false);
    // Улица в центре города, перестроенная игроком в грунтовку, — по-прежнему улица.
    const inner = town.streets
      .map((id) => game.roads.net.corridors.get(id))
      .find((c) => c && c.cls === 'street' && streetLike(c.id) && [c.a, c.b].every((n) => Math.hypot(game.roads.net.node(n).pos.x - town.center.x, game.roads.net.node(n).pos.y - town.center.y) < town.radius * 0.6))!;
    expect(inner).toBeDefined();
    game.money = 5_000_000;
    game.roadBuilder.apply(game.roadBuilder.rebuild(inner.id, DIRT));
    expect(game.roads.net.corridor(inner.id).cls).toBe('dirt');
    expect(streetLike(inner.id)).toBe(true);
  });
});
