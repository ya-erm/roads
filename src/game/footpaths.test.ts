import { expect, it } from 'vitest';
import { add, lerp, norm, scale, sub, type Vec } from '../core/vec';
import { footpathSnap } from '../input/footpathTool';
import { gameSidewalks } from '../render/sidewalks';
import { FOOTPATH, joinFootpath, type Footpath } from './footpaths';
import { Game } from './game';
import { freshGame, openSpot, road } from './testkit';

const p = (x: number, y: number): Vec => ({ x, y });

it('пересекающиеся дорожки и примыкание в середину получают общие вершины', () => {
  let id = 0;
  let paths: Footpath[] = [];
  for (const [a, b] of [[p(0, 0), p(40, 0)], [p(20, -10), p(20, 10)], [p(30, 0), p(30, 10)]]) {
    paths = joinFootpath(paths, a, b, () => ++id);
  }
  expect(new Set(paths.map(path => path.id)).size).toBe(6);
  const ends = paths.flatMap(({ a, b }) => [a, b]);
  expect(ends.filter(q => q.x === 20 && q.y === 0)).toHaveLength(4);
  expect(ends.filter(q => q.x === 30 && q.y === 0)).toHaveLength(3);
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
