import { describe, expect, it } from 'vitest';
import { Game } from './game';

/** Обычный перекрёсток на четыре дороги в самом большом городе. */
function crossroads(game: Game) {
  return [...game.net.nodes.values()].find(
    (n) => n.roundabout === null && n.control === 'none' && game.net.roadSegs(n).length === 4 && n.segments.length === 4,
  )!;
}

describe('Настройка перекрёстка', () => {
  it('запрет поворота убирает манёвр и сохраняется вместе с игрой', () => {
    const game = new Game(7);
    const n = crossroads(game);
    expect(n).toBeDefined();
    const info = game.junctionInfo(n.id)!;
    const t = info.turns[0];
    const left = t.exits.find((e) => e.kind === 'left')!;
    const count = () =>
      (game.net.nodeMovements.get(n.id) ?? []).filter((m) => game.net.links.get(m.inLink)?.seg === t.from && game.net.links.get(m.outLink)?.seg === left.out)
        .length;
    expect(count()).toBeGreaterThan(0);
    game.setJunction(n.id, { bans: [`${t.from}>${left.out}`] });
    expect(count()).toBe(0);
    expect(game.junctionInfo(n.id)!.turns[0].exits.find((e) => e.out === left.out)!.banned).toBe(true);
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    const ln = loaded.net.node(n.id);
    expect(ln.bans).toEqual([`${t.from}>${left.out}`]);
    expect(
      (loaded.net.nodeMovements.get(n.id) ?? []).filter(
        (m) => loaded.net.links.get(m.inLink)?.seg === t.from && loaded.net.links.get(m.outLink)?.seg === left.out,
      ).length,
    ).toBe(0);
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
    expect(n.priorityLanes.size).toBe(0);
  });

  it('светофор по таймеру переключает фазы через заданное время', () => {
    const game = new Game(7);
    const n = crossroads(game);
    game.money = 1_000_000;
    expect(game.builder.toggleLights(n.pos, 4)).toBe(true);
    const phases = n.lights!.phases.length;
    game.setJunction(n.id, { adaptive: false, greens: Array.from({ length: phases }, () => 5) });
    const seen = new Set<number>();
    game.speed = 1;
    for (let t = 0; t < 40; t += 0.1) {
      game.update(0.1);
      seen.add(n.lights!.phase);
    }
    // За 40 секунд по таймеру светофор обходит все фазы, даже пустые.
    expect(seen.size).toBe(phases);
  });
});
