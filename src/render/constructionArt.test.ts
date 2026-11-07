import { describe, expect, it } from 'vitest';
import type { Vec } from '../core/vec';
import { nextSite, pickSite } from '../game/constructionWork';
import { Game } from '../game/game';
import { anchorOf, STREET, withoutCitizens } from '../game/testkit';
import { type RoadOptions, splitCorridor } from '../lanes/edit';
import { edgesAt } from '../lanes/geometry';
import { type Corridor, oneWay } from '../lanes/model';
import { ROAD_MARGIN } from '../world/roadTypes';
import { buildingCorridors, crewConvoy, crewRows } from './constructionArt';

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

  it('ряды техники бригад — бок о бок в пределах полотна с обочиной: на однополосном два ряда плотно, на 1+1 — три через 5 м', () => {
    const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' }));
    /** Полотно проекта профилем lanes вдоль x в поле, заполняется от конца fromB. */
    const site = (lanes: RoadOptions['lanes'], fromB: boolean): Corridor => {
      for (let y = 400; y < game.terrain.height - 400; y += 120) {
        for (let x = 300; x < game.terrain.width - 700; x += 160) {
          const plan = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + 300, y } }), { cls: 'street', lanes }, { project: true });
          if (!plan.ok || plan.demolish.length || !game.roadBuilder.apply(plan)) continue;
          const c = buildingCorridors(game.roads.net).find((k) => Math.abs(k.lut.pointAt(0).y - y) < 1 && Math.abs(k.lut.pointAt(0).x - x) < 1)!;
          c.build = { project: c.build!.project, done: 100, ...(fromB ? { fromB: true } : {}) };
          return c;
        }
      }
      throw new Error('нет места');
    };
    /** Ряды n бригад — в пределах полотна с обочиной поперёк (вправо по ходу), и их шаг. */
    const check = (c: Corridor, n: number) => {
      const rows = crewRows(c, n);
      expect(rows).toHaveLength(n);
      const e = edgesAt(c, c.length / 2)!;
      const [lo, hi] = c.build!.fromB ? [-e[1] - ROAD_MARGIN, -e[0] + ROAD_MARGIN] : [e[0] - ROAD_MARGIN, e[1] + ROAD_MARGIN];
      for (const r of rows) {
        expect(r - 3).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(r + 3).toBeLessThanOrEqual(hi + 1e-6);
      }
      return n > 1 ? rows[1] - rows[0] : 0;
    };
    expect(crewRows(site(oneWay(1), false), 1)).toEqual([0]);
    for (const fromB of [false, true]) {
      const narrow = site(oneWay(1), fromB);
      // Два ряда на однополосном — плотно, но не друг на друге.
      expect(check(narrow, 2)).toBeGreaterThan(3);
      const wide = site(STREET.lanes, fromB);
      expect(check(wide, 2)).toBeCloseTo(5);
      expect(check(wide, 3)).toBeCloseTo(5);
    }
  });
});
