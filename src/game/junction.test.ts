import { describe, expect, it } from 'vitest';
import { Game } from './game';

/** Обычный перекрёсток на четыре дороги без светофора и кольца. */
function crossroads(game: Game) {
  const net = game.roads.net;
  return [...net.nodes.values()].find(
    (n) => n.kind === 'junction' && (n.roundabout ?? null) === null && (n.control ?? 'none') === 'none' && net.ends(n).length === 4,
  )!;
}

/** Сколько манёвров в графе игры ведут через узел с полотна from на полотно out. */
function movesCount(game: Game, node: number, from: number, out: number): number {
  const g = game.roads.graph;
  return [...g.moves.values()].filter(
    (m) => m.node === node && g.links.get(m.inLink)?.corridor === from && g.links.get(m.outLink)?.corridor === out,
  ).length;
}

describe('Настройка перекрёстка', () => {
  it('запрет поворота убирает манёвр и сохраняется вместе с игрой', () => {
    const game = new Game(7);
    const n = crossroads(game);
    expect(n).toBeDefined();
    const info = game.junctionInfo(n.id)!;
    const t = info.turns[0];
    const left = t.exits.find((e) => e.kind === 'left')!;
    expect(movesCount(game, n.id, t.from, left.out)).toBeGreaterThan(0);
    game.setJunction(n.id, { bans: [`${t.from}>${left.out}`] });
    expect(movesCount(game, n.id, t.from, left.out)).toBe(0);
    expect(game.junctionInfo(n.id)!.turns[0].exits.find((e) => e.out === left.out)!.banned).toBe(true);
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.roads.net.node(n.id).bans).toEqual([`${t.from}>${left.out}`]);
    expect(movesCount(loaded, n.id, t.from, left.out)).toBe(0);
  });

  it('главную дорогу выбирает игрок, а равнозначный перекрёсток — без приоритета', () => {
    const game = new Game(7);
    const n = crossroads(game);
    const info = game.junctionInfo(n.id)!;
    expect(info.pairs.length).toBeGreaterThan(0);
    for (const pair of info.pairs) {
      game.setJunction(n.id, { mainPair: pair.segs });
      expect(game.junctionInfo(n.id)!.mainNow.sort()).toEqual([...pair.segs].sort());
    }
    game.setJunction(n.id, { mainPair: [] });
    expect(game.roads.graph.nodes.get(n.id)!.priorityLanes.size).toBe(0);
  });

  it.todo('светофор по таймеру переключает фазы через заданное время — светофоры в графе полос, этап 4.4');
});
