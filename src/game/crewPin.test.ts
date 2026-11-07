import { describe, expect, it } from 'vitest';
import { dist, type Vec } from '../core/vec';
import { crewCardHtml } from '../ui/crewCard';
import type { WorldSettings } from '../world/settings';
import { type Brigade, type CrewHost, Crews, type Site } from './crews';
import { Game } from './game';
import { anchorOf, road, runSeconds, STREET, withoutCitizens } from './testkit';

/**
 * Бригада, назначенная игроком («🎯 На стройку…», Crews.send): едет туда обычным путём и закреплена — автоматика
 * (reinforce, trim) её не перебрасывает, пока проект не кончится, не встанет на паузу или игрок не нажмёт «↺ Авто».
 */
function bench(reach: CrewHost['reach'] = () => true) {
  const sites = new Map<number, Site>();
  const paths = new Map<number, Vec[]>();
  const paused = new Set<number>();
  /** Проекты, что строятся, но без подъезда (site — null). */
  const blocked = new Set<number>();
  const prio = new Set<number>();
  const caps = new Map<number, number>();
  const host = {
    time: 0,
    crewProjects: () => [...sites.keys(), ...blocked].filter((id) => !paused.has(id)).sort((a, b) => a - b),
    priority: (id: number) => prio.has(id),
    cap: (id: number) => caps.get(id) ?? 3,
    site: (id: number) => sites.get(id) ?? null,
    path: (id: number) => paths.get(id) ?? null,
    reach,
    drive: () => 42,
    park: () => {},
    onRoad: (node: number) => node >= 0,
  };
  const crews = new Crews(host);
  crews.bases.set(100, { type: 'base', id: 100, fp: { center: { x: 0, y: 0 }, w: 36, h: 24, angle: 0 }, nodeId: 1, paid: 0 });
  crews.firstUsed = true;
  const b = crews.hire(100)!;
  const until = (t: number) => {
    while (host.time < t - 1e-9) {
      host.time = Math.round((host.time + 0.1) * 10) / 10;
      crews.tick();
    }
  };
  // Проект 7 — к востоку, 8 — к западу: подъезд у узла, край работ — в 300 м вдоль стройки к северу.
  const add = (id: number, node: number, x: number) => {
    sites.set(id, { node, pos: { x, y: -300 } });
    paths.set(id, [{ x, y: 0 }, { x, y: -150 }, { x, y: -300 }]);
  };
  add(7, 571, 600);
  add(8, 572, -600);
  /** Бригада доехала колонной до узла подъезда своего проекта и вдоль стройки до края работ. */
  const toWork = (crew: Brigade) => {
    for (let i = 0; i < 4 && !crew.convoy; i++) crews.tick();
    const s = sites.get(crew.project!)!;
    crews.arrive(crew, { node: s.node, pos: paths.get(crew.project!)![0] });
    until(host.time + 60);
    expect(crew.state).toBe('working');
  };
  return { host, crews, sites, paused, blocked, prio, caps, b, until, toWork };
}

describe('Бригада, назначенная игроком', () => {
  it('закрепление переживает перераспределение: приоритетный проект её не забирает; «↺ Авто» — снова забирает', () => {
    const t = bench();
    expect(t.crews.send(t.b, 7)).toBeNull();
    expect(t.b.pinned).toBe(true);
    t.toWork(t.b);
    t.prio.add(8);
    t.until(t.host.time + 5);
    expect(t.b.project).toBe(7);
    expect(t.b.state).toBe('working');
    // Снято закрепление — приоритетному проекту не хватает рук, бригада уходит к нему.
    t.crews.unpin(t.b);
    t.crews.tick();
    expect(t.b.project).toBe(8);
    expect(t.b.state).toBe('going');
  });

  it('закрепление переживает trim: проект стал уже — уезжает незакреплённая, хоть у неё номер меньше', () => {
    const t = bench();
    t.sites.delete(8);
    const c = t.crews.hire(100)!;
    expect(t.crews.send(c, 7)).toBeNull();
    t.crews.tick();
    expect(t.b.project).toBe(7);
    t.toWork(t.b);
    t.toWork(c);
    t.caps.set(7, 1);
    t.crews.tick();
    // Без закрепления trim отпустил бы бригаду с большим номером — назначенную игроком.
    expect(c.project).toBe(7);
    expect(c.state).toBe('working');
    expect(t.b.project).toBeUndefined();
    expect(t.b.state).toBe('back');
  });

  it('снимается, когда проект на паузе или закончен', () => {
    const t = bench();
    expect(t.crews.send(t.b, 8)).toBeNull();
    t.toWork(t.b);
    t.paused.add(8);
    t.crews.tick();
    expect(t.b.pinned).toBeUndefined();
    expect(t.b.project).not.toBe(8);
    t.paused.delete(8);
    t.until(t.host.time + 80);
    expect(t.crews.send(t.b, 8)).toBeNull();
    expect(t.b.pinned).toBe(true);
    t.sites.delete(8);
    t.crews.tick();
    expect(t.b.pinned).toBeUndefined();
    expect(t.b.project).not.toBe(8);
  });

  it('отказ: места нет (cap), нет подъезда, по дорогам не доехать, на паузе — и бригада никуда не едет', () => {
    const t = bench();
    t.sites.delete(8);
    t.caps.set(7, 1);
    t.crews.tick();
    expect(t.b.project).toBe(7);
    const c = t.crews.hire(100)!;
    expect(t.crews.send(c, 7)).toContain('1 из 1');
    t.blocked.add(9);
    expect(t.crews.send(c, 9)).toContain('нет подъезда');
    t.paused.add(7);
    expect(t.crews.send(c, 7)).toContain('не строится');
    expect(c).toEqual({ id: c.id, base: 100, state: 'idle' });
    const far = bench(() => false);
    expect(far.crews.send(far.b, 7)).toContain('не доехать');
    expect(far.b.pinned).toBeUndefined();
  });

  it('с работы — без перескока: сперва вдоль своей стройки назад к дороге, оттуда колонной по дорогам', () => {
    const t = bench();
    t.toWork(t.b);
    const from = t.b.project!;
    const to = from === 7 ? 8 : 7;
    const front = t.sites.get(from)!.pos;
    expect(t.crews.send(t.b, to)).toBeNull();
    expect(t.b.state).toBe('going');
    expect(t.b.trip?.back).toBe(true);
    expect(dist(t.crews.walkAt(t.b)!.pos, front)).toBeLessThan(1e-6);
    t.until(t.host.time + 60);
    expect(t.b.convoy?.from).toBe(t.sites.get(from)!.node);
    expect(t.b.convoy?.to).toBe(t.sites.get(to)!.node);
  });

  it('сохранение и загрузка: закрепление остаётся; у свободной бригады из сохранения — снимается; старое — без него', () => {
    const t = bench();
    expect(t.crews.send(t.b, 7)).toBeNull();
    t.toWork(t.b);
    const save = JSON.parse(JSON.stringify(t.crews.toSave()));
    expect(save.brigades[0].pinned).toBe(true);
    const other = bench();
    other.crews.load(save);
    expect(other.crews.brigades.get(t.b.id)!.pinned).toBe(true);
    other.crews.load({ ...save, brigades: [{ id: 3, base: 100, state: 'idle', pinned: true }, { id: 4, base: 100, state: 'idle' }] });
    expect(other.crews.brigades.get(3)).toEqual({ id: 3, base: 100, state: 'idle' });
    expect(other.crews.brigades.get(4)!.pinned).toBeUndefined();
  });
});

describe('Бригада, назначенная игроком, — в игре', { timeout: 60_000 }, () => {
  const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 50_000_000, water: 'dry', construction: 'build' };
  const nodeAt = (game: Game, p: Vec) => [...game.roads.net.nodes.values()].find((n) => dist(n.pos, p) < 1)!.id;

  /** Место в поле, далеко от городов: ровная полоса в len метров вдоль x. */
  function field(game: Game, len: number): Vec {
    for (let y = 400; y < game.terrain.height - 400; y += 120) {
      for (let x = 300; x < game.terrain.width - len - 300; x += 160) {
        if (game.towns.some((t) => dist({ x: x + len / 2, y }, t.center) < t.radius + len)) continue;
        const plan = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + len, y } }), STREET);
        if (plan.ok && !plan.demolish.length) return { x, y };
      }
    }
    throw new Error('нет места');
  }

  /** Улица с базой посередине и два проекта от её концов — на восток и на запад. */
  function scene() {
    const game = withoutCitizens(new Game(WORLD));
    const at = field(game, 1500);
    expect(road(game, { free: { x: at.x + 600, y: at.y } }, { free: { x: at.x + 900, y: at.y } })).toBe(true);
    expect(game.buildBase({ x: at.x + 750, y: at.y - 40 })).toBeNull();
    const ids: number[] = [];
    for (const [from, to] of [
      [at.x + 900, at.x + 1500],
      [at.x + 600, at.x],
    ]) {
      ids.push(game.construction.peekId());
      const plan = game.roadBuilder.road(anchorOf(game, nodeAt(game, { x: from, y: at.y })), anchorOf(game, { free: { x: to, y: at.y } }), STREET, { project: true });
      expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
    }
    const b = [...game.construction.crews.brigades.values()][0];
    return { game, ids, b };
  }

  it('отправить на другую стройку: едет без перескока, все три машины колонны видно, закреплена, журнал, карточка', () => {
    const { game, ids, b } = scene();
    const crews = game.construction.crews;
    for (let t = 0; t < 120 && b.state !== 'working'; t += 0.2) runSeconds(game, 0.2);
    expect(b.state).toBe('working');
    const from = b.project!;
    const to = ids.find((id) => id !== from)!;
    expect(game.sendBrigade(b.id, to)).toBeNull();
    expect(b.pinned).toBe(true);
    expect(game.journal.entries.some((e) => e.k === 'brigade-send' && e.b === b.id && e.id === to && e.from === from)).toBe(true);
    // Приоритет прежнего проекта её не вернёт.
    game.prioritizeProject(from, true);
    let pos = game.brigadeWhere(b.id)!.pos;
    let jump = 0;
    let three = false;
    for (let t = 0; t < 240 && b.state !== 'working'; t += 0.2) {
      runSeconds(game, 0.2);
      const now = game.brigadeWhere(b.id)!.pos;
      jump = Math.max(jump, dist(now, pos));
      pos = now;
      if (b.convoy?.cars.every((c) => 'sim' in c)) three ||= game.crewSpots(b.id).length === 3;
    }
    expect(b.state).toBe('working');
    expect(b.project).toBe(to);
    expect(three).toBe(true);
    expect(jump).toBeLessThan(40);
    // Карточка бригады: закрепление, кнопки, стройки строками «x из N».
    const html = crewCardHtml(game, b.id, { following: false, picking: false });
    expect(html).toContain('Бригада 1');
    expect(html).toContain('📌 «');
    expect(html).toContain('data-action="crew-send"');
    expect(html).toContain('data-action="crew-auto"');
    expect(html.match(/data-action="crew-to"/g)).toHaveLength(2);
    expect(html).toContain('🚚 1/3');
    expect(html).toContain('🚚 0/3');
    expect(crewCardHtml(game, b.id, { following: true, picking: true })).toContain('cc-picking');

    // Сохранение: закрепление на месте, дальше обе партии идут одинаково.
    const loaded = withoutCitizens(new Game(WORLD, JSON.parse(JSON.stringify(game.toSave()))));
    expect(loaded.construction.crews.brigades.get(b.id)!.pinned).toBe(true);
    for (const g of [game, loaded]) runSeconds(g, 20);
    expect(loaded.construction.crews.toSave()).toEqual(crews.toSave());
    expect(b.project).toBe(to);

    // «↺ Авто»: закрепление снято, в журнале — запись; приоритетный прежний проект забирает её назад.
    game.autoBrigade(b.id);
    expect(b.pinned).toBeUndefined();
    expect(game.journal.entries.some((e) => e.k === 'brigade-auto' && e.b === b.id)).toBe(true);
    expect(crewCardHtml(game, b.id, { following: false, picking: false })).toContain('🤖 авто');
    runSeconds(game, 1);
    expect(b.project).toBe(from);
  });

  it('отказ понятными словами: на паузе, нет проекта', () => {
    const { game, ids, b } = scene();
    game.construction.setPaused(ids[1], true);
    expect(game.sendBrigade(b.id, ids[1])).toContain('на паузе');
    expect(game.sendBrigade(b.id, 999)).toContain('Проекта больше нет');
    expect(b.pinned).toBeUndefined();
  });
});
