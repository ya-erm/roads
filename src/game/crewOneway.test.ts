import { describe, expect, it } from 'vitest';
import { dist, type Vec } from '../core/vec';
import { oneWay } from '../lanes/model';
import { projectBadges } from '../render/projectBadges';
import { projectCardHtml } from '../ui/projectCard';
import type { WorldSettings } from '../world/settings';
import type { RoadClass } from '../world/roadTypes';
import { advise } from './advisor';
import { Game } from './game';
import { anchorOf, openSpot, road, runSeconds, STREET, withoutCitizens } from './testkit';

/**
 * Подъезд к стройке без учёта направления полос: проект между двумя односторонними съездами (въезд к проекту и выезд
 * от него) начинается с любого конца — смотря какой ближе к базе; к концу у выезда бригада доезжает по правилам до
 * дороги, а последний отрезок съезда проезжает против движения (как будто там регулировщик) — не по полю.
 */
describe('Стройка: подъезд без учёта одностороннего движения', () => {
  const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };
  const RAMP = { cls: 'street' as RoadClass, lanes: oneWay(1, 1) };

  const nodeAt = (game: Game, p: Vec) => [...game.roads.net.nodes.values()].find((n) => dist(n.pos, p) < 1)?.id ?? null;

  /** Проект улицей от a до b (как рисует игрок). */
  const project = (game: Game, a: number | Vec, b: number | Vec) => {
    const end = (x: number | Vec) => anchorOf(game, typeof x === 'number' ? x : { free: x });
    const plan = game.roadBuilder.road(end(a), end(b), STREET, { project: true });
    return plan.ok && game.roadBuilder.apply(plan);
  };

  /** Место в поле: без дорог, домов и воды полоса в len метров вдоль x и ещё одна — в 250 м к югу (там съезды и проект). */
  function field(game: Game, len: number): Vec {
    return openSpot(game, [
      [{ x: 0, y: 0 }, { x: len, y: 0 }, 150],
      [{ x: 0, y: 250 }, { x: len, y: 250 }, 150],
    ]);
  }

  /**
   * Улица вдоль x (готовая), от неё — въезд (односторонний к проекту) у x+300 и выезд (односторонний от проекта) у
   * x+1500; проект — от конца въезда до начала выезда. База — у улицы, у въезда (side: 'in') или у выезда ('out').
   */
  function scene(side: 'in' | 'out') {
    const game = withoutCitizens(new Game(WORLD));
    const at = field(game, 1800);
    expect(road(game, { free: at }, { free: { x: at.x + 1800, y: at.y } })).toBe(true);
    const e1 = { x: at.x + 500, y: at.y + 250 };
    const e2 = { x: at.x + 1300, y: at.y + 250 };
    expect(road(game, { x: at.x + 300, y: at.y }, { free: e1 }, RAMP)).toBe(true);
    expect(road(game, { free: e2 }, { x: at.x + 1500, y: at.y }, RAMP)).toBe(true);
    const inEnd = nodeAt(game, e1)!;
    const outEnd = nodeAt(game, e2)!;
    expect(game.buildBase({ x: at.x + (side === 'in' ? 120 : 1680), y: at.y - 40 })).toBeNull();
    const base = [...game.construction.crews.bases.values()][0];
    // По правилам: к концу въезда доехать можно, от конца выезда — тоже (выехать), а к нему — нет.
    expect(game.roads.route(base.nodeId, inEnd)).not.toBeNull();
    expect(game.roads.route(base.nodeId, outEnd)).toBeNull();
    expect(game.roads.route(outEnd, base.nodeId)).not.toBeNull();
    const id = game.construction.peekId();
    expect(project(game, inEnd, outEnd)).toBe(true);
    return { game, at, id, inEnd, outEnd, base };
  }

  it('оба конца проекта — с подъездом: работы могут начаться с любого, с ближнего к базе', () => {
    for (const side of ['in', 'out'] as const) {
      const { game, id, inEnd, outEnd } = scene(side);
      const c = game.construction;
      expect(c.accessRank(inEnd)).not.toBeNull();
      expect(c.accessRank(outEnd)).not.toBeNull();
      const info = c.info(id)!;
      expect(info.access).toBe(true);
      expect(info.waits).toBe(false);
      expect(c.site(id)!.node).toBe(side === 'in' ? inEnd : outEnd);
      expect(projectBadges(game, 1).find((x) => x.id === id)?.text).not.toContain('нет подъезда');
      expect(advise(game).some((a) => a.kind === 'buildNoAccess')).toBe(false);
      // Бригада доезжает и строит от этого конца.
      const b = [...c.crews.brigades.values()][0];
      for (let t = 0; t < 120 && b.state !== 'working'; t += 0.5) runSeconds(game, 0.5);
      expect(b.state).toBe('working');
      runSeconds(game, 10);
      const now = c.info(id)!;
      expect(now.done).toBeGreaterThan(0);
      const [near, far] = side === 'in' ? [inEnd, outEnd] : [outEnd, inEnd];
      expect(dist(now.front!, game.roads.net.node(near).pos)).toBeLessThan(dist(now.front!, game.roads.net.node(far).pos));
    }
  });

  it('база у выезда: бригада по правилам до улицы, по съезду — против движения, дальше вдоль стройки; строит от выезда', () => {
    const { game, id, inEnd, outEnd, at } = scene('out');
    const crews = game.construction.crews;
    const b = [...crews.brigades.values()][0];
    const outPos = game.roads.net.node(outEnd).pos;
    const inPos = game.roads.net.node(inEnd).pos;
    const j2 = { x: at.x + 1500, y: at.y };
    let drove = false;
    let against: Vec[] | null = null;
    for (let t = 0; t < 120 && b.state !== 'working'; t += 0.1) {
      runSeconds(game, 0.1);
      if (b.convoy && crews.lead(b) !== undefined) drove = true;
      if (b.trip?.to !== undefined) against = b.trip.path;
    }
    expect(b.state).toBe('working');
    // Сперва — в потоке по улице, потом — по съезду против движения: от развилки к концу выезда, вдоль его оси.
    expect(drove).toBe(true);
    expect(against).not.toBeNull();
    expect(dist(against![0], j2)).toBeLessThan(30);
    expect(dist(against![against!.length - 1], outPos)).toBeLessThan(1);
    const ramp = { a: j2, b: outPos };
    for (const p of against!) {
      // Расстояние до отрезка съезда (он прямой): по полю не ехала.
      const d = { x: ramp.b.x - ramp.a.x, y: ramp.b.y - ramp.a.y };
      const k = Math.max(0, Math.min(1, ((p.x - ramp.a.x) * d.x + (p.y - ramp.a.y) * d.y) / (d.x * d.x + d.y * d.y)));
      expect(dist(p, { x: ramp.a.x + d.x * k, y: ramp.a.y + d.y * k })).toBeLessThan(15);
    }
    runSeconds(game, 20);
    const info = game.construction.info(id)!;
    expect(info.done).toBeGreaterThan(0);
    // Край работ — от выезда к въезду.
    expect(dist(info.front!, outPos)).toBeLessThan(dist(info.front!, inPos));
  });

  it('сохранение посреди отрезка против движения: после загрузки — там же, и дальше всё одинаково', () => {
    const { game } = scene('out');
    const crews = game.construction.crews;
    const b = [...crews.brigades.values()][0];
    for (let t = 0; t < 120 && b.trip?.to === undefined; t += 0.1) runSeconds(game, 0.1);
    expect(b.trip?.to).toBeDefined();
    runSeconds(game, 0.5);
    expect(b.trip?.to).toBeDefined();
    expect(game.brigadeWhere(b.id)!.text).toContain('против движения');
    const loaded = withoutCitizens(new Game(WORLD, JSON.parse(JSON.stringify(game.toSave()))));
    const twin = loaded.construction.crews.brigades.get(b.id)!;
    expect(twin.trip?.to).toBe(b.trip!.to);
    expect(loaded.construction.crews.walkAt(twin)).toEqual(crews.walkAt(b));
    for (const g of [game, loaded]) runSeconds(g, 40);
    expect(b.state).toBe('working');
    expect(loaded.construction.crews.toSave()).toEqual(game.construction.crews.toSave());
    expect(loaded.money).toBe(game.money);
    expect(JSON.stringify(loaded.roads.net.toJSON())).toBe(JSON.stringify(game.roads.net.toJSON()));
  });

  it('проект на паузе у выезда — бригада выезжает по правилам и едет домой', () => {
    const { game, id } = scene('out');
    const crews = game.construction.crews;
    const b = [...crews.brigades.values()][0];
    for (let t = 0; t < 120 && b.state !== 'working'; t += 0.1) runSeconds(game, 0.1);
    expect(b.state).toBe('working');
    game.construction.setPaused(id, true);
    let drove = false;
    for (let t = 0; t < 200 && b.state !== 'idle'; t += 0.1) {
      runSeconds(game, 0.1);
      if (crews.lead(b) !== undefined) drove = true;
    }
    expect(b.state).toBe('idle');
    expect(drove).toBe(true);
  });

  it('проект, что ждёт соседний строящийся, — «⏳ после соседнего», а не «нет подъезда»; отдельный в поле — «нет подъезда»', () => {
    const { game, id: first, outEnd, at } = scene('in');
    // Второй и третий проекты — цепочкой в поле (третий — продолжение второго), без готовых дорог рядом.
    const second = game.construction.peekId();
    const start = { x: at.x + 700, y: at.y + 600 };
    const m = { x: at.x + 1300, y: at.y + 600 };
    expect(project(game, start, m)).toBe(true);
    const third = game.construction.peekId();
    expect(project(game, nodeAt(game, m)!, { x: at.x + 1700, y: at.y + 600 })).toBe(true);
    // Второй и третий — в поле, без готовых дорог: подъезда нет ни у одного; соседей с подъездом нет — «нет подъезда».
    for (const id of [second, third]) {
      const info = game.construction.info(id)!;
      expect(info.access).toBe(false);
      expect(info.waits).toBe(false);
      expect(projectBadges(game, 1).find((x) => x.id === id)?.text).toContain('нет подъезда');
    }
    expect(advise(game).find((a) => a.kind === 'buildNoAccess')?.count).toBe(2);
    // Перемычка — проект от конца выезда к стыку второго и третьего: у неё подъезд есть, второй и третий ждут соседа.
    const bridge = game.construction.peekId();
    expect(project(game, outEnd, nodeAt(game, m)!)).toBe(true);
    expect(game.construction.info(bridge)!.access).toBe(true);
    for (const id of [second, third]) {
      const info = game.construction.info(id)!;
      expect(info.access).toBe(false);
      expect(info.waits).toBe(true);
      const text = projectBadges(game, 1).find((x) => x.id === id)?.text;
      expect(text).toContain('⏳ после соседнего');
      expect(text).not.toContain('нет подъезда');
      const card = projectCardHtml(game, id);
      expect(card).toContain('после соседнего');
      expect(card).not.toContain('Нет подъезда');
    }
    expect(advise(game).some((a) => a.kind === 'buildNoAccess')).toBe(false);
    // Соседа поставили на паузу — он не дорастёт: снова «нет подъезда».
    game.construction.setPaused(bridge, true);
    expect(game.construction.info(second)!.waits).toBe(false);
    expect(projectBadges(game, 1).find((x) => x.id === second)?.text).toContain('нет подъезда');
    expect(game.construction.info(first)!.access).toBe(true);
  });
});
