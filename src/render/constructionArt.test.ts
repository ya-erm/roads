import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { nextSite, pickSite } from '../game/constructionWork';
import { Game } from '../game/game';
import { anchorOf, STREET, withoutCitizens } from '../game/testkit';
import { splitCorridor } from '../lanes/edit';
import type { Corridor } from '../lanes/model';
import { buildingCorridors, crewConvoy } from './constructionArt';

/** Прямой проект улицы вдоль x длиной len в чистом поле, разрезанный стыком посередине: два участка подряд. */
function straightProject(len: number): { game: Game; y: number } {
  const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' }));
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 160) {
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + len, y } }), STREET, { project: true });
      if (!plan.ok || plan.demolish.length || !game.roadBuilder.apply(plan)) continue;
      const net = game.roads.net;
      const cs = buildingCorridors(net);
      if (cs.length !== 1 || cs.some((c) => net.node(c.a).level !== 0 || net.node(c.b).level !== 0)) continue;
      splitCorridor(net, cs[0], cs[0].length / 2, 'seam');
      return { game, y };
    }
  }
  throw new Error('нет места');
}

describe('Колонна техники стройки', () => {
  it('следующий участок, прямо продолжающий этот, колонна проходит по оси: без съезда на обочину и без скачков', () => {
    const { game, y } = straightProject(600);
    const net = game.roads.net;
    const list = () => [...buildingCorridors(net)].sort((p, q) => p.id - q.id);
    const first = pickSite(list(), () => false)!.c;
    const next = nextSite(net, first, buildingCorridors(net))!;
    expect(next.c).not.toBe(first);
    const track: { pos: Vec; site: Corridor; done: number }[][] = [];
    const run = (c: Corridor, fromB: boolean) => {
      for (let done = 0; ; done = Math.min(c.length, done + 0.1)) {
        c.build = { project: c.build!.project, done, ...(fromB ? { fromB: true } : {}) };
        track.push(crewConvoy(net, c).map((m) => ({ pos: m.pos, site: c, done })));
        if (done >= c.length) break;
      }
    };
    run(first, false);
    // Первый участок готов — открыт; второй заполняется от общего стыка.
    delete first.build;
    net.touch(first);
    expect(pickSite(list(), (n) => n === first.a || n === first.b)).toEqual(next);
    run(next.c, next.fromB);
    // Ни одна машина нигде не прыгает: за шаг 0,1 м работы край этапа уходит не дальше 0,7 м (разметка одна).
    for (let i = 1; i < track.length; i++) {
      for (let k = 0; k < 3; k++) {
        const [p, q] = [track[i - 1][k].pos, track[i][k].pos];
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeLessThan(1);
      }
    }
    // На стыке участков (конец первого, начало второго) вся колонна — на оси дороги, не на обочине.
    const join = track.filter((t) => (t[0].site === first && t[0].done > first.length - 1) || (t[0].site === next.c && t[0].done < 1));
    expect(join.length).toBeGreaterThan(2);
    for (const t of join) for (const m of t) expect(Math.abs(m.pos.y - y)).toBeLessThan(0.5);
    // Проект кончился — дальше идти некуда: грейдер в конце уходит на обочину, как раньше.
    const last = track[track.length - 1];
    expect(Math.abs(last[0].pos.y - y)).toBeGreaterThan(3);
  });
});
