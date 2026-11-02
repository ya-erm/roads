import { describe, expect, it } from 'vitest';
import { COST } from '../config';
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

// Симуляция светофора и загрузка игры — дольше стандартного лимита при параллельном прогоне.
describe('Настройка перекрёстка', { timeout: 20_000 }, () => {
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

  it('главная дорога на карте — та, которой уступают машины; вариант под курсором перекрёсток не меняет', () => {
    const game = new Game(7);
    game.money = 1_000_000;
    const n = crossroads(game);
    const sorted = (p: number[] | null) => [...(p ?? [])].sort((a, b) => a - b);
    const mainNow = () => sorted(game.junctionInfo(n.id)!.mainNow);
    // «Авто»: подсвечено то же, что выбрал граф движения.
    const auto = game.junctionMain(n.id);
    expect(sorted(auto)).toEqual(mainNow());
    for (const pair of game.junctionInfo(n.id)!.pairs) {
      // Предпросмотр варианта — без изменений узла и приоритета.
      expect(game.junctionMain(n.id, pair.segs)).toEqual(pair.segs);
      expect(game.roads.net.node(n.id).mainPair ?? null).toBeNull();
      expect(sorted(game.junctionMain(n.id))).toEqual(sorted(auto));
      game.setJunction(n.id, { mainPair: pair.segs });
      expect(sorted(game.junctionMain(n.id))).toEqual(mainNow());
      // Наведённое «Авто» при ручной паре — снова автоматическая пара.
      expect(sorted(game.junctionMain(n.id, null))).toEqual(sorted(auto));
      game.setJunction(n.id, { mainPair: null });
    }
    expect(game.junctionMain(n.id, [])).toBeNull();
    game.setJunction(n.id, { mainPair: [] });
    expect(game.junctionMain(n.id)).toBeNull();
    // Под светофором главной дороги нет.
    game.setJunction(n.id, { mainPair: null });
    expect(game.toggleLights(n.id)).toBe(true);
    expect(game.junctionMain(n.id)).toBeNull();
  });

  it('светофор по таймеру переключает фазы через заданное время, на красный никто не въезжает', () => {
    const game = new Game(7);
    const n = crossroads(game);
    game.money = 1_000_000;
    const money = game.money;
    expect(game.lightsPlan(n.id).ok).toBe(true);
    expect(game.toggleLights(n.id)).toBe(true);
    expect(game.money).toBe(money - COST.trafficLight);
    // Граф пересобирается при росте города — светофор берём каждый раз заново.
    const L = () => game.roads.graph.nodes.get(n.id)!.lights!;
    const phases = L().phases.length;
    expect(phases).toBeGreaterThanOrEqual(2);
    expect(game.junctionInfo(n.id)!.phases).toHaveLength(phases);
    game.setJunction(n.id, { adaptive: false, greens: Array.from({ length: phases }, () => 5) });
    const seen = new Set<number>();
    const prev = new Map<number, string | null>();
    let entered = 0;
    let onRed = 0;
    game.speed = 1;
    for (let t = 0; t < 40; t += 0.1) {
      game.update(0.1);
      const lights = L();
      seen.add(lights.phase);
      for (const v of game.traffic.vehicles.values()) {
        const m = v.onMovement ? game.roads.graph.moves.get(v.onMovement) : undefined;
        if (m?.node === n.id && prev.get(v.id) !== v.onMovement) {
          entered++;
          if (!lights.clearing && !lights.phases[lights.phase].includes(m.inLane)) onRed++;
        }
        prev.set(v.id, v.onMovement);
      }
    }
    // За 40 секунд по таймеру светофор обходит все фазы, даже пустые.
    expect(seen.size).toBe(phases);
    expect(entered).toBeGreaterThan(0);
    expect(onRed).toBe(0);
    // Сохраняется вместе с игрой; снятие возвращает часть денег.
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(loaded.roads.net.node(n.id).control).toBe('lights');
    expect(loaded.roads.graph.nodes.get(n.id)!.lights).not.toBeNull();
    const before = loaded.money;
    expect(loaded.toggleLights(n.id)).toBe(true);
    expect(loaded.money).toBe(before + Math.round(COST.trafficLight * COST.refundRatio));
    expect(loaded.roads.graph.nodes.get(n.id)!.lights).toBeNull();
  });
});
