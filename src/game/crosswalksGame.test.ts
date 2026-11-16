import { describe, expect, it } from 'vitest';
import { walkCost, walksOn } from '../lanes/crosswalk';
import { Game } from './game';
import { freshGame, runSeconds } from './testkit';

/** Перекрёсток города, где переход возможен хоть на одном подъезде и город его поставил сам. */
function townJunction(game: Game) {
  for (const n of game.roads.net.nodes.values()) {
    const list = game.crosswalkInfo(n.id);
    if (list.some((x) => x.arm.on && !x.arm.own)) return { n, list };
  }
  throw new Error('нет городского перекрёстка с переходом');
}

describe('Пешеходные переходы в игре', { timeout: 30_000 }, () => {
  it('новая партия: в городах переходы стоят сами, у дорог в поле — нет; стоп-линии перед ними отодвинуты', () => {
    const game = freshGame(7);
    const { n, list } = townJunction(game);
    for (const x of list.filter((x) => x.arm.on)) expect(x.auto).toBe(true);
    const walks = game.roads.graph.crosswalks.get(n.id)!;
    expect(walks.length).toBe(list.filter((x) => x.arm.on).length);
    expect(game.roads.graph.stopBack.size).toBeGreaterThan(0);
    // Подъезд без домов вокруг — без перехода.
    const rural = [...game.roads.net.nodes.values()].flatMap((m) => game.crosswalkInfo(m.id)).filter((x) => !x.arm.ban && !x.auto);
    for (const x of rural) expect(x.arm.on).toBe(false);
  });

  it('стереть — бесплатно, нарисовать — по полосам; Ctrl+Z возвращает; сохранение несёт выбор игрока', () => {
    const game = freshGame(7);
    game.money = 1_000_000;
    const { n, list } = townJunction(game);
    const arm = list.find((x) => x.arm.on)!;
    const id = arm.arm.corridor.id;
    const money = game.money;
    game.checkpoint('пешеходный переход');
    expect(game.setCrosswalk(n.id, id)).toBeNull();
    game.commit();
    expect(game.money).toBe(money);
    expect(game.roads.net.node(n.id).walks?.[String(id)]).toEqual({ on: false, own: true });
    expect(game.roads.graph.crosswalks.get(n.id)?.some((w) => w.corridor === id) ?? false).toBe(false);
    // Нарисовать снова — за разметку.
    game.checkpoint('пешеходный переход');
    expect(game.setCrosswalk(n.id, id)).toBeNull();
    game.commit();
    expect(game.money).toBe(money - walkCost(arm.geo));
    // Ctrl+Z — снова стёрт, деньги назад.
    game.undo();
    expect(game.roads.net.node(n.id).walks?.[String(id)]?.on).toBe(false);
    expect(game.money).toBe(money);
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.roads.net.node(n.id).walks?.[String(id)]).toEqual({ on: false, own: true });
  });

  it('старое сохранение без переходов открывается с переходами «сами»', () => {
    const game = freshGame(7);
    const { n } = townJunction(game);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    for (const node of save.roads.nodes) delete node.walks;
    const loaded = new Game(game.settings, save);
    expect(walksOn(loaded.roads.net, loaded.roads.net.node(n.id)).length).toBe(walksOn(game.roads.net, n).length);
  });

  it('все вкл / все выкл и цена выключения: стёртые переходы у остановки уменьшают её охват', () => {
    const game = freshGame(7);
    game.money = 1_000_000;
    const { n } = townJunction(game);
    expect(game.setCrosswalks(n.id, false)).toBeNull();
    expect(walksOn(game.roads.net, game.roads.net.node(n.id))).toHaveLength(0);
    expect(game.missingCrosswalks(n.pos, 50)).toBeGreaterThan(0);
    expect(game.setCrosswalks(n.id, true)).toBeNull();
    expect(game.missingCrosswalks(n.pos, 50)).toBe(0);
    expect(walksOn(game.roads.net, game.roads.net.node(n.id)).length).toBe(game.crosswalkInfo(n.id).filter((x) => !x.arm.ban).length);
  });

  it('пешеходы ходят, машины не теряются', () => {
    const game = freshGame(7);
    let crossings = 0;
    runSeconds(game, 90, () => {
      for (const c of game.crosswalks.list) if (c.cross && c.cross.t0 === game.time) crossings++;
    });
    expect(game.crosswalks.list.length).toBeGreaterThan(0);
    expect(crossings).toBeGreaterThan(0);
  });
});
