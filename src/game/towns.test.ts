import { describe, expect, it } from 'vitest';
import { straightCubic } from '../core/bezier';
import { add, dist, scale, sub } from '../core/vec';
import type { Corridor } from '../lanes/model';
import type { Town, TownBuilding } from '../world/entities';
import { RAIL_HALF, RAIL_SPEC } from '../world/roadTypes';
import { coreRadius, fillStreet, measureTown, onRail, railNear, WorldContext } from '../world/worldgen';
import { Game } from './game';
import { road } from './testkit';

const grow = (game: Game, town: Town) => (game as unknown as { growTown(t: Town): void }).growTown(town);
const farthest = (town: Town) => Math.max(...town.buildings.map((b) => dist(b.fp.center, town.center)));
/** Улицы, построенные после снимка before, у этого города (ближе к его центру, чем к другим). */
const newStreets = (game: Game, town: Town, before: Set<number>): Corridor[] =>
  [...game.roads.net.corridors.values()].filter((c) => {
    if (before.has(c.id)) return false;
    const mid = c.lut.pointAt(c.length / 2);
    return game.towns.every((t) => dist(mid, t.center) >= dist(mid, town.center));
  });

describe('Рост городов', { timeout: 60_000 }, () => {
  it('радиус — по плотной застройке: длинная улица с редкими домами в поле его не раздувает', () => {
    const house = (x: number, y: number): TownBuilding => ({
      type: 'building',
      id: 0,
      townId: 1,
      fp: { center: { x, y }, w: 16, h: 16, angle: 0 },
      kind: 'res',
      floors: 2,
      anchor: 0,
      color: '',
      roof: '',
    });
    // Плотный круг радиусом 300 и «отросток» — дома в два ряда вдоль линии до 1500 м.
    const buildings: TownBuilding[] = [];
    for (let x = -300; x <= 300; x += 25) for (let y = -300; y <= 300; y += 25) if (Math.hypot(x, y) <= 300) buildings.push(house(x, y));
    for (let x = 320; x <= 1500; x += 12) buildings.push(house(x, 25), house(x, -25));
    const town = { center: { x: 0, y: 0 }, radius: 1530, buildings } as Town;
    expect(coreRadius(town)).toBeGreaterThan(280);
    expect(coreRadius(town)).toBeLessThan(380);
    measureTown(town);
    expect(town.radius).toBeLessThan(420);
    // До самого дальнего дома — для отрисовки и охвата станций.
    expect(town.extent).toBeGreaterThan(1500);
  });

  it('город растёт компактно: дома и новые улицы — у края застройки, без отростков в поле', () => {
    const game = new Game(7);
    const sorted = [...game.towns].sort((a, b) => b.population - a.population);
    const towns = [sorted[0], sorted[sorted.length - 1]];
    const before = new Set(game.roads.net.corridors.keys());
    const start = new Map(towns.map((t) => [t.id, { far: farthest(t), pop: t.population }]));
    for (let m = 0; m < 24; m++) {
      for (const t of towns) {
        // Жителям всего хватает — город растёт так быстро, как может.
        t.growthAcc = Math.max(t.growthAcc, 400);
        grow(game, t);
      }
    }
    for (const t of towns) {
      const s = start.get(t.id)!;
      expect(t.population).toBeGreaterThan(s.pop * 1.2);
      // Дома — не дальше предела по населению (или прежней застройки).
      expect(farthest(t)).toBeLessThanOrEqual(Math.max(s.far + 20, 8 * Math.sqrt(t.population) + 200));
      // Новые улицы есть, и все — у края плотной застройки, а не в поле.
      const added = newStreets(game, t, before);
      expect(added.length).toBeGreaterThan(0);
      for (const c of added) for (const p of [c.curve.p0, c.curve.p3]) expect(dist(p, t.center)).toBeLessThan(t.radius + 200);
      // Круг города покрывает большую часть застройки (город не круглый: вытянут и с лепестками вдоль выездов).
      const inside = t.buildings.filter((b) => dist(b.fp.center, t.center) <= t.radius).length;
      expect(inside / t.buildings.length).toBeGreaterThan(0.75);
    }
  });

  it('старый отросток (из прежних сохранений) остаётся как есть: город его не продлевает, радиус по нему не растёт', () => {
    const game = new Game(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    // Сеть после каждой стройки — новая.
    const net = () => game.roads.net;
    // Отросток, как от прежних правил роста: улица на 900 м от края города в поле, с домами вдоль.
    const before = new Set(net().corridors.keys());
    const edge = net()
      .nodesNear(town.center, town.radius + 200)
      .sort((a, b) => dist(b.pos, town.center) - dist(a.pos, town.center));
    let tip: { x: number; y: number } | null = null;
    for (const n of edge.slice(0, 12)) {
      const dir = scale(sub(n.pos, town.center), 1 / dist(n.pos, town.center));
      const to = add(n.pos, scale(dir, 900));
      if (game.inBounds(to, 150) && road(game, n.id, { free: to })) {
        tip = to;
        break;
      }
    }
    expect(tip).not.toBeNull();
    const ctx = (game as unknown as { worldContext(): WorldContext }).worldContext();
    for (const c of net().corridors.values()) if (!before.has(c.id)) fillStreet(ctx, town, c, 0.9);
    // Как при загрузке сохранения.
    measureTown(town);
    expect(town.radius).toBeLessThan(dist(tip!, town.center) - 400);
    expect(town.extent).toBeGreaterThan(dist(tip!, town.center) - 60);
    // Дома на дальней половине отростка.
    const outside = () => town.buildings.filter((b) => dist(b.fp.center, town.center) > dist(tip!, town.center) - 450).length;
    const housesOut = outside();
    const grown = new Set(net().corridors.keys());
    for (let m = 0; m < 12; m++) {
      town.growthAcc = Math.max(town.growthAcc, 400);
      grow(game, town);
    }
    // Конец отростка — по-прежнему тупик на месте, новых улиц и домов в поле не прибавилось.
    const end = net().nodesNear(tip!, 2)[0];
    expect(end && net().isDeadEnd(end)).toBe(true);
    for (const c of newStreets(game, town, grown)) for (const p of [c.curve.p0, c.curve.p3]) expect(dist(p, town.center)).toBeLessThan(town.radius + 200);
    expect(outside()).toBeLessThanOrEqual(housesOut);
    expect(town.radius).toBeLessThan(dist(tip!, town.center) - 400);
  });

  it('на ж/д путях город не строит ни домов, ни улиц; дома на путях из старых сохранений сносятся', () => {
    const game = new Game(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    // Путь насквозь через город — как в старом сохранении, где дома под ним остались.
    const dir = { x: Math.cos(0.4), y: Math.sin(0.4) };
    const a = game.net.addNode(add(town.center, scale(dir, -1200)));
    const b = game.net.addNode(add(town.center, scale(dir, 1200)));
    game.net.addSegment(a.id, b.id, straightCubic(a.pos, b.pos), RAIL_SPEC);
    game.net.rebuild();
    const onTrack = (t: Town) => t.buildings.filter((h) => h.kind !== 'landmark' && onRail(game.net, h.fp, 0));
    expect(onTrack(town).length).toBeGreaterThan(0);
    const houses = new Set(town.buildings.map((h) => h.id));
    const oldNet = game.roads.net;
    for (let m = 0; m < 24; m++) {
      town.growthAcc = Math.max(town.growthAcc, 400);
      grow(game, town);
    }
    // Новые дома — не на путях.
    const fresh = town.buildings.filter((h) => !houses.has(h.id));
    expect(fresh.length).toBeGreaterThan(0);
    for (const h of fresh) expect(onRail(game.net, h.fp, 0)).toBe(false);
    // Новые улицы путь не пересекают (у путей — только куски старых улиц, разрезанных переулками).
    for (const c of game.roads.net.corridors.values()) {
      if (oldNet.corridors.has(c.id)) continue;
      for (let s = 0; s <= c.length; s += 4) {
        const p = c.lut.pointAt(s);
        if (!railNear(game.net, p, RAIL_HALF + 10)) continue;
        expect(oldNet.corridorsNear(p, 2).some((o) => o.lut.closest(p).d < 1)).toBe(true);
      }
    }
    // При загрузке дома на путях сносятся (ратуша остаётся).
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(save.settings, save);
    for (const t of loaded.towns) for (const h of t.buildings) if (h.kind !== 'landmark') expect(onRail(loaded.net, h.fp, 0)).toBe(false);
    const after = loaded.towns.find((t) => t.id === town.id)!;
    expect(after.buildings.length).toBe(town.buildings.length - onTrack(town).length);
  });
});
