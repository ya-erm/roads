import { expect, it } from 'vitest';
import { add, lerp, norm, scale, sub, type Vec } from '../core/vec';
import { footpathSnap } from '../input/footpathTool';
import { gameSidewalks } from '../render/sidewalks';
import { FOOTPATH, footpathLength, footpathNetwork, nearestFootpath, type Footpath } from './footpaths';
import { Game } from './game';
import { freshGame, openSpot, road } from './testkit';
import { walkingNetwork } from './pedestrians';

const p = (x: number, y: number): Vec => ({ x, y });

it('пристраивает ручную дорожку к середине прохода между домами и соединяет все три направления', () => {
  const game = freshGame(7);
  const walks = gameSidewalks(game);
  const line = walks.yards!.flatMap(yard => yard.paths).find(path => Math.hypot(path[2] - path[0], path[3] - path[1]) > 20)!;
  const a = p(line[0], line[1]), b = p(line[2], line[3]);
  const mid = lerp(a, b, 0.5), heading = norm(sub(b, a));
  const across = p(-heading.y, heading.x);
  const snapped = footpathSnap(game, add(mid, scale(across, 0.05)), 0.2);
  expect(snapped.x).toBeCloseTo(mid.x, 3);
  expect(snapped.y).toBeCloseTo(mid.y, 3);
  const graph = walkingNetwork(walks, [{ id: 1, a: snapped, b: add(mid, scale(across, 4)) }], []);
  const joint = [...graph.values()].flatMap(edge => [edge.a, edge.b]).find(q => Math.hypot(q.x - mid.x, q.y - mid.y) < 0.01);
  expect(joint!.links.length).toBeGreaterThanOrEqual(3);
});

it('пересекающиеся дорожки и примыкание в середину получают общие вершины', () => {
  const paths = [[p(0, 0), p(40, 0)], [p(20, -10), p(20, 10)], [p(30, 0), p(30, 10)]].map(([a, b], id) => ({ id, a, b }));
  const edges = footpathNetwork(paths);
  expect(edges).toHaveLength(6);
  const ends = edges.flatMap(({ a, b }) => [a, b]);
  expect(ends.filter(q => q.x === 20 && q.y === 0)).toHaveLength(4);
  expect(ends.filter(q => q.x === 30 && q.y === 0)).toHaveLength(3);
});

it('полукруг стыкуется с пересекающей его дорожкой в обеих точках; по хорде нельзя выбрать дугу', () => {
  const arc: Footpath = { id: 8, a: p(0, 0), b: p(40, 0), shape: { kind: 'arc', through: p(20, 20) } };
  const cross: Footpath = { id: 9, a: p(-5, 12), b: p(45, 12) };
  expect(footpathLength(arc)).toBeCloseTo(Math.PI * 20, 0);
  expect(nearestFootpath([arc], p(20, 0), 1)).toBeUndefined();
  expect(nearestFootpath([arc], p(20, 20), 1)?.path.id).toBe(8);
  const ends = footpathNetwork([arc, cross]).flatMap(({ a, b }) => [a, b]);
  for (const x of [4, 36]) expect(ends.filter(q => Math.abs(q.x - x) < 0.2 && Math.abs(q.y - 12) < 0.001)).toHaveLength(4);
});

it('городской проход можно перенести и снести без повторной генерации, отмена возвращает прежнюю линию', () => {
  const g = freshGame({ seed: 11, towns: 2, industries: 'few', size: 'small', water: 'dry', money: 500_000 });
  const path = g.editableFootpaths().find(p => p.id < 0 && p.shape?.kind === 'polyline')!;
  expect(path).toBeTruthy();
  const originalLines = () => gameSidewalks(g).yards?.flatMap(yard => yard.pathIds ?? []) ?? [];
  expect(originalLines()).toContain(path.id);
  expect(g.footpathRefund(path)).toBe(0);
  // Торец у крыльца касается стены заднего дома: это штатный вход, его можно оставить на месте.
  expect(g.footpathPlan(path.a, path.b, path.shape, path.id).reason).toBeUndefined();
  const a = openSpot(g, [[p(0, 0), p(80, 0), 60]]);
  const b = add(a, p(40, 0));
  expect(g.moveFootpath(path.id, a, b)).toBeNull();
  expect(originalLines()).not.toContain(path.id);
  expect(g.editableFootpaths().filter(x => x.id === path.id)).toEqual([{ id: path.id, a, b, cityCost: expect.any(Number) }]);
  expect(g.undo()).toBeTruthy();
  expect(originalLines()).toContain(path.id);
  expect(g.footpaths).toEqual([]);
  const before = g.money;
  g.checkpoint('снос дорожки');
  g.removeFootpaths([path]);
  g.commit();
  expect(g.money).toBe(before);
  const save = g.toSave();
  const reload = new Game(save.settings, JSON.parse(JSON.stringify(save)));
  expect(reload.editableFootpaths().some(p => p.id === path.id)).toBe(false);
  expect(gameSidewalks(reload).yards?.some(y => y.pathIds?.includes(path.id))).toBe(false);
  expect(g.undo()).toBeTruthy();
  expect(g.editableFootpaths().find(p => p.id === path.id)).toEqual(path);
});

it('кривую можно поправить за общий конец, загрузить и снести целиком по изгибу', () => {
  const g = freshGame({ seed: 11, towns: 2, industries: 'few', size: 'small', water: 'dry', money: 500_000 });
  const a = openSpot(g, [[p(0, 0), p(100, 0), 85]]);
  const b = add(a, p(60, 0)), end = add(a, p(85, 0));
  const shape = { kind: 'curve' as const, c1: add(a, p(0, 30)), c2: add(b, p(0, 30)) };
  const before = g.money;
  expect(g.buildFootpath(a, b, shape)).toBeNull();
  const curve = g.footpaths[0];
  expect(before - g.money).toBe(Math.round(footpathLength(curve) * FOOTPATH.pricePerMetre));
  expect(g.buildFootpath(b, end)).toBeNull();
  const joint = add(b, p(4, 4));
  expect(g.moveFootpath(curve.id, a, joint, shape, true)).toBeNull();
  expect(g.footpaths[0]).toMatchObject({ id: curve.id, b: joint, shape });
  expect(g.footpaths[1].a).toEqual(joint);
  const save = g.toSave();
  const loaded = new Game(save.settings, JSON.parse(JSON.stringify(save)));
  expect(loaded.footpaths).toEqual(g.footpaths);
  const beyond = { kind: 'arc' as const, through: { x: -10, y: a.y } };
  expect(loaded.moveFootpath(curve.id, a, joint, beyond)).toContain('краем карты');
  expect(loaded.footpaths).toEqual(g.footpaths);
  expect(loaded.bulldozeArea(add(a, p(25, 20)), add(a, p(36, 27)))).toBe(true);
  expect(loaded.footpaths.map(path => path.id)).toEqual([g.footpaths[1].id]);
  loaded.undo();
  expect(loaded.footpaths).toEqual(g.footpaths);
});

it('проверяет цену и дубли, сохраняет пользовательскую сеть, отменяет снос, закрывает путь после появления дороги', () => {
  const g = freshGame({ seed: 11, towns: 2, industries: 'few', size: 'small', water: 'dry', money: 500_000 });
  const a = openSpot(g, [[p(0, 0), p(80, 0), 75]]);
  const b = add(a, p(80, 0));
  const before = g.money;
  expect(g.buildFootpath(a, b)).toBeNull();
  expect(before - g.money).toBe(80 * FOOTPATH.pricePerMetre);
  expect(g.buildFootpath(b, add(a, p(5, 0)))).toContain('уже есть');
  expect(g.footpaths).toHaveLength(1);
  const saved = g.toSave();
  const reload = new Game(saved.settings, JSON.parse(JSON.stringify(saved)));
  expect(reload.footpaths).toEqual(g.footpaths);
  expect(reload.openFootpaths()).toHaveLength(1);
  expect(reload.bulldozeArea(add(a, p(-5, -5)), add(b, p(5, 5)))).toBe(true);
  expect(reload.footpaths).toHaveLength(0);
  reload.undo();
  expect(reload.footpaths).toEqual(g.footpaths);
  const cached = reload.openFootpaths();
  expect(reload.openFootpaths()).toBe(cached);
  expect(road(reload, { free: add(a, p(40, -60)) }, { free: add(a, p(40, 60)) })).toBe(true);
  expect(reload.openFootpaths()).toEqual([]);
  expect(reload.footpathPlan(add(a, p(0, 5)), add(b, p(0, 5))).reason).toMatch(/переход/);
  delete saved.footpaths;
  expect(new Game(saved.settings, saved).footpaths).toEqual([]);
});

it('курсор притягивается к середине городского тротуара и к входу построенного подземного перехода', () => {
  const g = freshGame({ seed: 11, towns: 2, industries: 'few', size: 'small', water: 'dry', money: 500_000 });
  const sidewalks = gameSidewalks(g);
  const coords = sidewalks.lines.find(line => line.key[0] === 'c' && line.paths.some(p => p.length >= 30))!.paths.find(p => p.length >= 30)!;
  const i = Math.floor(coords.length / 4) * 2;
  const a = p(coords[i - 2], coords[i - 1]);
  const b = p(coords[i], coords[i + 1]);
  const mid = lerp(a, b, 0.5);
  const direction = norm(sub(b, a));
  const near = add(mid, { x: -direction.y * 0.2, y: direction.x * 0.2 });
  const snapped = footpathSnap(g, near, 4);
  expect(snapped.x).toBeCloseTo(mid.x, 3);
  expect(snapped.y).toBeCloseTo(mid.y, 3);
  const walk = [...g.roads.graph.crosswalks.values()].flat()[0];
  expect(g.setCrosswalk(walk.node, walk.corridor, 'underground')).toBeNull();
  const tunnel = g.roads.graph.crosswalks.get(walk.node)!.find(w => w.corridor === walk.corridor)!;
  const [portal, other] = tunnel.geo.ends;
  const away = norm(sub(portal, other));
  expect(footpathSnap(g, add(portal, scale(away, 1)), 5)).toEqual(portal);
  expect(g.buildFootpath(portal, add(portal, scale(away, 2.5)))).toBeNull();
  expect(g.openFootpaths()).toHaveLength(1);
});
