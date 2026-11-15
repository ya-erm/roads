import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { dist, type Vec } from '../core/vec';
import { LaneRenderer } from '../lanes/draw';
import { nodeCuts } from '../lanes/geometry';
import { nodeStage } from '../render/constructionArt';
import type { WorldSettings } from '../world/settings';
import { type CrewLane, crewSpacing, holdJumps, LANE_SPEED, laneArcs, stageSlots } from './crewLane';
import { Game } from './game';
import { anchorOf, HIGHWAY, openSpot, road, runSeconds, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 50_000_000, water: 'dry', construction: 'build' };

/**
 * Стройка через перекрёсток с готовой дорогой (как на записи игрока 0.2.139): проект W → S — две части, W–J и J–S, а в
 * узел J посередине упирается готовая дорога с востока. Три бригады строят W–J, доходят до J и переходят на J–S.
 */
describe('Стройка через перекрёсток с готовой дорогой', () => {
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });

  function scene() {
    const game = withoutCitizens(new Game(WORLD));
    const at = openSpot(game, [
      [{ x: -250, y: 0 }, { x: 1200, y: 0 }, 150],
      [{ x: 0, y: 0 }, { x: 800, y: 400 }, 150],
    ]);
    expect(road(game, { free: { x: at.x - 250, y: at.y } }, { free: at }, HIGHWAY)).toBe(true);
    expect(game.buildBase({ x: at.x - 200, y: at.y - 40 })).toBeNull();
    const crews = game.construction.crews;
    const base = [...crews.bases.values()][0];
    crews.hire(base.id);
    crews.hire(base.id);
    const id = game.construction.peekId();
    const plan = game.roadBuilder.road(anchorOf(game, at), anchorOf(game, { free: { x: at.x + 800, y: at.y + 400 } }), HIGHWAY, { project: true });
    expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
    // Готовая дорога с востока — в середину проекта: он делится на W–J и J–S.
    expect(road(game, { free: { x: at.x + 1100, y: at.y + 150 } }, { x: at.x + 400, y: at.y + 200 }, HIGHWAY)).toBe(true);
    const net = game.roads.net;
    const pieces = [...net.corridors.values()].filter((c) => c.build?.project === id);
    expect(pieces.length).toBe(2);
    const J = [pieces[0].a, pieces[0].b].find((n) => n === pieces[1].a || n === pieces[1].b)!;
    expect(net.node(J).corridors.some((k) => !net.corridor(k).build)).toBe(true);
    const first = pieces.find((c) => c.a !== J && c.b !== J) ?? pieces.find((c) => dist(net.node(c.a === J ? c.b : c.a).pos, at) < 5)!;
    const second = pieces.find((c) => c !== first)!;
    return { game, id, J, first: first.id, second: second.id };
  }

  /** Нос машины стоит на площадке узла J: ближе к нему, чем обрез своего полотна у J. */
  function onPad(game: Game, J: number, p: Vec): boolean {
    const net = game.roads.net;
    const n = net.node(J);
    const ends = net.ends(n);
    const cuts = nodeCuts(net, n, ends);
    return ends.some((e, i) => {
      const hit = e.corridor.lut.closest(p);
      const fromJ = e.end === 'a' ? hit.s : e.corridor.length - hit.s;
      return hit.d < 8 && fromJ < cuts[i] - 1;
    });
  }

  it('площадка перекрёстка не мигает чертежом, техника не ждёт посреди перекрёстка и нигде не перескакивает', () => {
    const { game, id, J, first, second } = scene();
    const crews = game.construction.crews;
    const lanes = new LaneRenderer((c) => !!c.build);
    const net = () => game.roads.net;
    let stage = -1;
    let dropped = '';
    let firstDone = -1;
    let standing = 0;
    let maxStep = 0;
    let where = '';
    const prev = new Map<string, Vec>();
    for (let t = 0; t < 400; t += 0.1) {
      runSeconds(game, 0.1);
      // Площадка J — этапом, дошедшим до неё: однажды готовая, она не становится снова чертежом.
      if (net().node(J).corridors.some((k) => net().corridor(k).build)) {
        const k = nodeStage(net(), lanes, J);
        if (k < stage && !dropped) dropped = `${stage} → ${k} в ${t.toFixed(1)} с`;
        stage = Math.max(stage, k);
      }
      if (firstDone < 0 && !net().corridor(first).build) firstDone = t;
      for (const b of crews.brigades.values()) {
        for (const m of crews.carsAt(b)) {
          const key = `${b.id}.${m.car}`;
          const was = prev.get(key);
          const step = was ? dist(was, m.pos) : 0;
          if (step > maxStep) where = `машина ${key} в ${t.toFixed(1)} с`;
          maxStep = Math.max(maxStep, step);
          prev.set(key, { ...m.pos });
          // Первая часть готова, по J ездят: стоять посреди перекрёстка технике незачем.
          if (firstDone >= 0 && m.s !== undefined && step < 0.05 && onPad(game, J, m.pos)) standing += 0.1;
        }
      }
      if (!game.construction.projects.has(id)) break;
    }
    expect(firstDone).toBeGreaterThan(0);
    expect(net().corridor(second).build).toBeUndefined();
    expect(dropped).toBe('');
    expect(stage).toBe(2);
    // Стоят на площадке J (ждут начала своего этапа на J–S) — не дольше доли секунды; раньше — ~10 с.
    expect(standing).toBeLessThan(1);
    // За 0,1 с — не дальше 3 м: ни скачка.
    expect(maxStep, where).toBeLessThan(3);
  });
});

describe('Места техники у перекрёстка в начале участка (stageSlots: start, extStart)', () => {
  const sp0 = crewSpacing(0);
  const sp1 = crewSpacing(1);

  it('не начатые ждут за площадкой: колонной от её края, а не от начала участка', () => {
    expect(stageSlots([0, 0, 0], 300, { ahead: true })).toEqual([sp0 + sp1, sp1, 0]);
    expect(stageSlots([0, 0, 0], 300, { ahead: true, start: 30 })).toEqual([30 + sp0 + sp1, 30 + sp1, 30]);
    // Край этапа ушёл за место ожидания — машина у края.
    expect(stageSlots([120, 60, 0], 300, { ahead: true, start: 30 })).toEqual([120, 60, 30]);
  });

  it('кончивший этап на этом участке — сразу к своему месту ожидания за площадкой следующего; места совпадают с ним', () => {
    const L = 200;
    const es = 25;
    const ext = 400;
    // Отсыпка кончена, покрытие и разметка ещё идут: грейдер уже ждёт на следующем участке.
    const y = stageSlots([L, 150, 100], L, { ahead: true, ext, extAhead: true, extStart: es });
    expect(y[0]).toBeCloseTo(L + es + sp0 + sp1);
    expect(y[1]).toBe(150);
    // Всё кончено — места те же, что у не начатого следующего участка (от его начала, L по полосе).
    const done = stageSlots([L, L, L], L, { ahead: true, ext, extAhead: true, extStart: es });
    const next = stageSlots([0, 0, 0], ext, { ahead: true, start: es }).map((u) => L + u);
    done.forEach((u, k) => expect(u).toBeCloseTo(next[k]));
    // Без перекрёстка — как раньше: кончивший уступает догоняющему.
    expect(stageSlots([L, 150, 100], L, { ahead: true, ext, extAhead: true })[0]).toBe(L);
  });
});

describe('Место машины ушло вперёд скачком (holdJumps)', () => {
  it('машина едет к новому месту своим ходом, а не перескакивает; остальные — как шли', () => {
    const lane: CrewLane = { path: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], legs: [{ corridor: 1, fromB: false, at: 0 }], from: [100, 70, 50], t0: 0 };
    let target = [100, 70, 50];
    let was = { time: 10, s: laneArcs(lane, target, 10) };
    expect(was.s).toEqual(target);
    // Место головной — на 60 м вперёд разом.
    target = [160, 70.3, 50];
    const dt = 1 / 30;
    let t = 10;
    let worst = 0;
    for (let i = 0; i < 120; i++) {
      t += dt;
      const s = holdJumps(lane, target, was, t);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, s[k] - was.s[k]);
      was = { time: t, s };
    }
    expect(worst).toBeLessThanOrEqual(LANE_SPEED * dt + 1e-6);
    expect(was.s).toEqual(target);
  });
});
