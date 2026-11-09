/**
 * Ворота строительной базы — узел дороги. Правка дорог (перенос, слияние стыка) может этот узел убрать: тогда ворота
 * переходят на ближний узел той же дороги, а стройки рядом с базой по-прежнему считаются от неё (раньше — «Нет узла N»
 * в карточке базы, и база не открывалась).
 */
import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import { mergeEdit, splitEdit } from '../lanes/nodeEdit';
import type { WorldSettings } from '../world/settings';
import { Game } from './game';
import { anchorOf, openSpot, road, STREET, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

/** Улица с запада на восток, стык посередине, база у стыка (его ворота — этот стык) и проект улицы на юг от восточного конца. */
function setup() {
  const game = withoutCitizens(new Game({ ...WORLD }));
  const at = openSpot(game, [
    [{ x: 0, y: 0 }, { x: 600, y: 0 }, 150],
    [{ x: 600, y: 0 }, { x: 600, y: 400 }, 120],
  ]);
  expect(road(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
  const net = game.roads.net;
  const mid = { x: at.x + 300, y: at.y };
  const street = net.corridorNear(mid, 10)!;
  const split = game.roadBuilder.plan(splitEdit(street.id, street.lut.closest(mid).s), { only: () => false });
  expect(game.roadBuilder.apply(split)).toBe(true);
  const seam = [...game.roads.net.nodes.values()].find((n) => dist(n.pos, mid) < 1)!;
  expect(seam).toBeTruthy();
  expect(game.buildBase({ x: at.x + 300, y: at.y - 30 })).toBeNull();
  const base = [...game.construction.crews.bases.values()][0];
  expect(base.nodeId).toBe(seam.id);
  const east = [...game.roads.net.nodes.values()].find((n) => dist(n.pos, { x: at.x + 600, y: at.y }) < 1)!;
  const plan = game.roadBuilder.road(anchorOf(game, east.id), anchorOf(game, { free: { x: at.x + 600, y: at.y + 300 } }), STREET, { project: true });
  expect(plan.project).toBeTruthy();
  expect(game.roadBuilder.apply(plan)).toBe(true);
  return { game, base, seam: seam.id, project: plan.project!.id };
}

describe('Ворота строительной базы', () => {
  it('стык-ворота убрали — ворота на ближнем узле той же улицы, стройки считаются от базы', () => {
    const { game, base, seam, project } = setup();
    const merge = game.roadBuilder.plan(mergeEdit(seam), { only: () => false });
    expect(merge.ok).toBe(true);
    expect(game.roadBuilder.apply(merge)).toBe(true);
    expect(game.roads.net.nodes.has(seam)).toBe(false);
    expect(game.roads.net.nodes.has(base.nodeId)).toBe(true);
    expect(game.onRoad(base.nodeId)).toBe(true);
    // Карточка базы (ближние стройки) спрашивает это — раньше падало «Нет узла».
    expect(() => game.construction.siteFrom(project, base.nodeId)).not.toThrow();
    expect(game.construction.siteFrom(project, base.nodeId)).not.toBeNull();
    expect(game.construction.siteOfBase(project, base.id)).not.toBeNull();
  });

  it('сохранение с воротами на пропавшем узле открывается с новыми воротами', () => {
    const { game, base, project } = setup();
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const saved = save.construction.crews.bases.find((b: { id: number }) => b.id === base.id);
    saved.nodeId = 999_999;
    const loaded = withoutCitizens(new Game(save.settings, save));
    const lb = loaded.construction.crews.bases.get(base.id)!;
    expect(loaded.roads.net.nodes.has(lb.nodeId)).toBe(true);
    expect(loaded.onRoad(lb.nodeId)).toBe(true);
    expect(loaded.construction.siteFrom(project, lb.nodeId)).not.toBeNull();
  });

  it('проект без ворот базы в сети — не доехать, а не ошибка', () => {
    const { game, project } = setup();
    expect(game.construction.siteFrom(project, 999_999)).toBeNull();
  });
});
