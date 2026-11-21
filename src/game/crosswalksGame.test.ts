import { describe, expect, it } from 'vitest';
import { underpassCost, walkCost, walksOn } from '../lanes/crosswalk';
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

  it('замена зебры подземным переходом сохраняет охват, снимает стоп-линию и переживает загрузку и отмену', () => {
    const game = freshGame(7);
    const { n, list } = townJunction(game);
    const { arm, geo } = list.find((x) => x.arm.on)!;
    const id = arm.corridor.id;
    const graphWalk = (g: Game) => g.roads.graph.crosswalks.get(n.id)!.find((w) => w.corridor === id)!;
    const balance = game.money;
    const missing = game.missingCrosswalks(n.pos, 50);
    game.money -= game.budget;
    expect(game.setCrosswalk(n.id, id, 'underground')).toBe('Не хватает денег');
    expect(graphWalk(game).underground).toBeUndefined();
    game.money = balance;
    game.checkpoint('подземный переход');
    expect(game.setCrosswalk(n.id, id, 'underground')).toBeNull();
    game.commit();
    const tunnel = graphWalk(game);
    expect(tunnel.underground).toBe(true);
    expect(tunnel.geo.stripes).toHaveLength(0);
    expect(tunnel.geo.cover).toHaveLength(0);
    expect(tunnel.geo.portals).toHaveLength(2);
    for (const lane of game.roads.graph.links.get(tunnel.inLink!)!.lanes) expect(game.roads.graph.stopBack.has(lane.id)).toBe(false);
    expect(game.missingCrosswalks(n.pos, 50)).toBe(missing);
    const paid = game.money;
    expect(paid).toBe(balance - underpassCost(geo));
    expect(game.setCrosswalk(n.id, id, 'underground')).toBeNull();
    expect(game.money).toBe(paid);
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(graphWalk(loaded).underground).toBe(true);
    game.undo();
    expect(graphWalk(game).geo.stripes.length).toBeGreaterThan(0);
    expect(game.money).toBe(balance);
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

  it('включение запускает прогулки и уступание на зебрах, выключение сразу освобождает переходы', () => {
    const game = freshGame(7);
    game.setPedestrians(true);
    runSeconds(game, 0.2);
    const first = [...game.pedestrians.visible(game.time)];
    expect(first.length).toBeGreaterThan(0);
    let crossed = false;
    runSeconds(game, 25, () => {
      crossed ||= game.pedestrians.walkers.some((w) => !!w.edge.crossing && !w.edge.crossing.underground);
    });
    expect([...game.pedestrians.visible(game.time)][0].pos).not.toEqual(first[0].pos);
    expect(crossed).toBe(true);
    game.setPedestrians(false);
    runSeconds(game, 1);
    expect(game.traffic.walks.size).toBe(0);
    expect(game.crosswalks.crossings.size).toBe(0);
    expect(game.pedestrians.walkers).toHaveLength(0);
    expect([...game.pedestrians.visible(game.time)]).toHaveLength(0);
    for (const n of game.roads.graph.nodes.values()) for (const p of n.lights?.phases ?? []) expect(p.walk).toBeUndefined();
    game.setPedestrians(true);
    runSeconds(game, 0.3);
    expect(game.pedestrians.walkers.length).toBeGreaterThan(0);
  });
});
