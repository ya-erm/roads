import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import { splitCorridor } from '../lanes/edit';
import { buildingCorridors } from '../render/constructionArt';
import type { WorldSettings } from '../world/settings';
import { Game } from './game';
import { anchorOf, fieldSpot, road, runSeconds, STREET, withoutCitizens } from './testkit';

/**
 * Несколько фронтов у проекта: к обоим концам длинной дороги из нескольких участков есть подъезд от разных баз (как
 * на записи игрока — дорога между двумя городами, база у каждого конца) — бригады строят навстречу друг другу, каждая
 * свой участок; встретились — один доделывает, второй уходит. Деньги и длина — те же, что у одного фронта.
 */
describe('Стройка: несколько фронтов навстречу друг другу', () => {
  const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };
  const LEN = 1200;

  /**
   * Две готовые улицы с севера на юг (между собой не связаны), проект с запада на восток между ними — три участка
   * (стыки посередине). База у западной улицы; both — ещё одна у восточной.
   */
  function scene(both: boolean) {
    const game = withoutCitizens(new Game(WORLD));
    const at = fieldSpot(game, LEN, 260);
    const west = { x: at.x, y: at.y };
    const east = { x: at.x + LEN, y: at.y };
    expect(road(game, { free: { x: west.x, y: at.y - 200 } }, { free: { x: west.x, y: at.y + 200 } })).toBe(true);
    expect(road(game, { free: { x: east.x, y: at.y - 200 } }, { free: { x: east.x, y: at.y + 200 } })).toBe(true);
    expect(game.buildBase({ x: west.x - 40, y: at.y - 150 })).toBeNull();
    if (both) expect(game.buildBase({ x: east.x + 40, y: at.y - 150 }, true)).toBeNull();
    const id = game.construction.peekId();
    const plan = game.roadBuilder.road(anchorOf(game, west), anchorOf(game, east), STREET, { project: true });
    expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
    // Три участка подряд: стыки на трети и двух третях.
    const net = game.roads.net;
    const [c] = buildingCorridors(net).filter((k) => k.build?.project === id);
    const { second } = splitCorridor(net, c, c.length / 3, 'seam');
    splitCorridor(net, second, second.length / 2, 'seam');
    net.touch(c);
    const corridors = game.construction.corridorsOf(id);
    expect(corridors).toHaveLength(3);
    const length = corridors.reduce((s, k) => s + k.length, 0);
    let spent = 0;
    const spend = game.spend.bind(game);
    game.spend = (x: number) => {
      spent += x;
      spend(x);
    };
    return { game, id, west, east, length, cost: game.construction.info(id)!.left, spent: () => spent };
  }

  it('база у другого конца строит свой участок навстречу; фронты встречаются, деньги и длина — как у одного фронта', () => {
    const two = scene(true);
    const crews = two.game.construction.crews;
    let both = false;
    let met = false;
    const ends = new Set<string>();
    for (let t = 0; t < 400 && two.game.construction.projects.has(two.id); t += 0.5) {
      runSeconds(two.game, 0.5);
      const fronts = two.game.construction.fronts(two.id);
      const working = crews.working(two.id);
      // Две бригады работают одновременно — каждая на своём участке, у своего конца.
      if (fronts.length === 2 && working.length === 2 && new Set(working.map((b) => b.front!.corridor)).size === 2) {
        both = true;
        for (const b of working) {
          const c = two.game.roads.net.corridors.get(b.front!.corridor)!;
          const start = two.game.roads.net.node(b.front!.fromB ? c.b : c.a).pos;
          ends.add(dist(start, two.west) < dist(start, two.east) ? 'west' : 'east');
        }
      }
      // Встретились: остался один участок — его строит один фронт.
      if (both && two.game.construction.corridorsOf(two.id).length === 1) {
        met = true;
        expect(two.game.construction.fronts(two.id)).toHaveLength(1);
      }
    }
    expect(both).toBe(true);
    expect([...ends].sort()).toEqual(['east', 'west']);
    expect(met).toBe(true);
    expect(two.game.construction.projects.has(two.id)).toBe(false);

    // Один фронт (база только у западного конца) — та же дорога, те же деньги, но дольше.
    const one = scene(false);
    let tOne = 0;
    for (; tOne < 600 && one.game.construction.projects.has(one.id); tOne += 0.5) runSeconds(one.game, 0.5);
    expect(one.game.construction.projects.has(one.id)).toBe(false);
    expect(two.length).toBeCloseTo(one.length, 6);
    expect(two.spent()).toBe(one.spent());
    expect(two.spent()).toBe(two.cost);
    // Ни один метр не построен дважды: все участки открыты, готовая длина — длина проекта.
    for (const g of [one.game, two.game]) expect(buildingCorridors(g.roads.net)).toHaveLength(0);
  });

  it('фронты — в сохранении: после загрузки бригады строят те же участки, и дальше всё одинаково', () => {
    const { game, id } = scene(true);
    // Машины сходят на стройку по одной; поток не сохраняется — сохраняем, когда обе колонны уже целиком на стройке.
    const crews = game.construction.crews;
    const onSite = () => crews.working(id).length === 2 && crews.working(id).every((b) => !b.convoy);
    for (let t = 0; t < 120 && !onSite(); t += 0.5) runSeconds(game, 0.5);
    expect(onSite()).toBe(true);
    runSeconds(game, 5);
    expect(game.construction.fronts(id)).toHaveLength(2);
    const loaded = withoutCitizens(new Game(WORLD, JSON.parse(JSON.stringify(game.toSave()))));
    expect(loaded.construction.fronts(id).map((c) => c.id)).toEqual(game.construction.fronts(id).map((c) => c.id));
    for (const g of [game, loaded]) runSeconds(g, 30);
    expect(loaded.construction.crews.toSave()).toEqual(game.construction.crews.toSave());
    expect(loaded.money).toBe(game.money);
    expect(JSON.stringify(loaded.roads.net.toJSON())).toBe(JSON.stringify(game.roads.net.toJSON()));
  });

  it('старое сохранение без фронтов: работающая бригада берётся за начатый участок', () => {
    const { game, id } = scene(false);
    for (let t = 0; t < 120 && game.construction.crews.working(id).length < 1; t += 0.5) runSeconds(game, 0.5);
    runSeconds(game, 3);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    for (const b of save.construction.crews.brigades) delete b.front;
    const loaded = withoutCitizens(new Game(WORLD, save));
    const done = loaded.construction.info(id)!.done;
    runSeconds(loaded, 5);
    expect(loaded.construction.info(id)!.done).toBeGreaterThan(done);
    expect([...loaded.construction.crews.brigades.values()][0].front).toBeDefined();
  });
});
