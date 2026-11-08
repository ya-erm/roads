import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION } from '../config';
import { dist, type Vec } from '../core/vec';
import { projectBadges } from '../render/projectBadges';
import { baseCardHtml } from '../ui/baseCard';
import { projectRowHtml } from '../ui/constructionUi';
import { crewCardHtml } from '../ui/crewCard';
import { projectCardHtml } from '../ui/projectCard';
import type { WorldSettings } from '../world/settings';
import { advise } from './advisor';
import { type Brigade, type CrewHost, Crews, type Site } from './crews';
import { Game } from './game';
import { anchorOf, road, runSeconds, STREET, withoutCitizens } from './testkit';

/**
 * Радиус обслуживания базы (CONSTRUCTION.serviceRadius): автоматика шлёт бригаду только на стройку в радиусе её базы,
 * из нескольких баз — бригаду ближайшей; вручную — без ограничения; вне всех радиусов — «⛔ нет базы рядом».
 */

/** Бригады без игры: базы и проекты — вручную; доехать можно куда угодно, выехать машиной — всегда. */
function bench(cap?: number) {
  const sites = new Map<number, Site>();
  const host: CrewHost & { time: number } = {
    time: 0,
    crewProjects: () => [...sites.keys()],
    ...(cap !== undefined ? { cap: () => cap } : {}),
    site: (id: number) => sites.get(id) ?? null,
    path: (id: number) => {
      const s = sites.get(id);
      return s ? [{ ...(s.gate ?? s.pos) }, { ...s.pos }] : null;
    },
    reach: () => true,
    drive: () => 42,
    park: () => {},
    onRoad: (node: number) => node >= 0,
  };
  const crews = new Crews(host);
  crews.firstUsed = true;
  /** База id в точке at, ворота — узел gate; с n бригадами. */
  const base = (id: number, at: Vec, gate: number, n = 1): Brigade[] => {
    crews.bases.set(id, { type: 'base', id, fp: { center: { ...at }, w: 36, h: 24, angle: 0 }, nodeId: gate, paid: 0 });
    return Array.from({ length: n }, () => crews.hire(id)!);
  };
  return { host, crews, sites, base };
}

describe('Радиус обслуживания базы: автоматика', () => {
  it('бригада не едет на проект вне радиуса — едет на тот, что в радиусе', () => {
    const t = bench();
    const [b] = t.base(100, { x: 0, y: 0 }, 1);
    // Проект 7 — в 8 км (и подъезд там же), проект 8 — в 3 км.
    t.sites.set(7, { node: 70, pos: { x: 8000, y: 0 }, gate: { x: 7900, y: 0 } });
    t.crews.tick();
    expect(b.state).toBe('idle');
    expect(t.crews.serves(100, t.sites.get(7)!)).toBe(false);
    t.sites.set(8, { node: 80, pos: { x: 0, y: 3000 }, gate: { x: 0, y: 2900 } });
    t.crews.tick();
    expect(b.state).toBe('going');
    expect(b.project).toBe(8);
  });

  it('радиус — до края работ или подъезда, что ближе: край ушёл за радиус, а подъезд в нём — едет', () => {
    const t = bench();
    const [b] = t.base(100, { x: 0, y: 0 }, 1);
    t.sites.set(7, { node: 70, pos: { x: CONSTRUCTION.serviceRadius + 900, y: 0 }, gate: { x: CONSTRUCTION.serviceRadius - 100, y: 0 } });
    expect(t.crews.span(100, t.sites.get(7)!)).toBeCloseTo(CONSTRUCTION.serviceRadius - 100, 6);
    t.crews.tick();
    expect(b.project).toBe(7);
  });

  it('две базы в радиусе — едет бригада ближней, хотя дальняя по номеру раньше', () => {
    const t = bench(1);
    const [far] = t.base(100, { x: 0, y: 0 }, 1);
    const [near] = t.base(200, { x: 5000, y: 0 }, 2);
    t.sites.set(9, { node: 90, pos: { x: 5500, y: 0 } });
    expect(t.crews.serves(100, t.sites.get(9)!)).toBe(true);
    for (let i = 0; i < 5; i++) t.crews.tick();
    expect(near.project).toBe(9);
    expect(far.state).toBe('idle');
    expect(far.project).toBeUndefined();
  });

  it('ближней базе не до этого проекта (другой ей ближе по выбору) — дальняя не ждёт вечно: едет в следующий такт', () => {
    const t = bench();
    const [far] = t.base(100, { x: 0, y: 0 }, 1);
    const [near] = t.base(200, { x: 5000, y: 0 }, 2);
    t.sites.set(9, { node: 90, pos: { x: 5500, y: 0 } });
    t.crews.tick();
    // Ближняя уехала — на проекте ещё есть место (до трёх бригад), а дальняя в радиусе: едет помогать.
    expect(near.project).toBe(9);
    t.crews.tick();
    expect(far.project).toBe(9);
  });

  it('приоритетному не хватает рук — к нему переходит только бригада, в радиусе базы которой он есть', () => {
    const t = bench();
    const [b] = t.base(100, { x: 0, y: 0 }, 1);
    t.sites.set(8, { node: 80, pos: { x: 0, y: 1000 } });
    t.crews.tick();
    expect(b.project).toBe(8);
    // Работает на 8-м; приоритетный 7-й — в 9 км: туда она не переходит.
    t.host.priority = (id) => id === 7;
    t.crews.arrive(b, { node: 80, pos: { x: 0, y: 1000 } });
    t.host.time = 100;
    t.crews.tick();
    t.sites.set(7, { node: 70, pos: { x: 9000, y: 0 } });
    t.crews.tick();
    expect(b.project).toBe(8);
  });
});

describe('Радиус обслуживания базы: вручную и старые сохранения', () => {
  it('ручная отправка вне радиуса работает: едет, закреплена, и в радиусе никто не нужен', () => {
    const t = bench();
    const [b] = t.base(100, { x: 0, y: 0 }, 1);
    t.sites.set(7, { node: 70, pos: { x: 9000, y: 0 } });
    t.crews.tick();
    expect(b.state).toBe('idle');
    expect(t.crews.canGo(b, 7)).toBeNull();
    expect(t.crews.send(b, 7)).toBeNull();
    expect(b.pinned).toBe(true);
    t.crews.tick();
    expect(b.state).toBe('going');
    expect(t.crews.lead(b)).toBe(42);
    t.crews.arrive(b, { node: 70, pos: { x: 9000, y: 0 } });
    t.host.time = 10_000;
    t.crews.tick();
    expect(b.state).toBe('working');
    expect(b.project).toBe(7);
    // Вклад — по расстоянию, как раньше: в 9 км от базы — вчетверо медленнее.
    expect(t.crews.power(b, { x: 9000, y: 0 })).toBeCloseTo(1 / (1 + 9000 / CONSTRUCTION.reach), 9);
  });

  it('старое сохранение: бригада уже работает вне радиуса — доделывает фронт, новые туда не едут; фронт кончился — свободна', () => {
    const make = () => {
      const t = bench();
      t.base(100, { x: 0, y: 0 }, 1, 0);
      t.sites.set(7, { node: 70, pos: { x: 9000, y: 0 }, gate: { x: 8900, y: 0 } });
      t.host.time = 50;
      t.crews.load({
        bases: [...t.crews.bases.values()],
        brigades: [
          { id: 1, base: 100, state: 'working', project: 7, at: 70, pos: { x: 9000, y: 0 } },
          { id: 2, base: 100, state: 'idle' },
        ],
        nextBrigade: 3,
        firstUsed: true,
      });
      return t;
    };
    const t = make();
    const old = t.crews.brigades.get(1)!;
    const fresh = t.crews.brigades.get(2)!;
    for (let i = 0; i < 10; i++) t.crews.tick();
    expect(old.state).toBe('working');
    expect(old.project).toBe(7);
    expect(fresh.state).toBe('idle');
    // Детерминизм: та же загрузка и те же такты — то же состояние.
    const twin = make();
    for (let i = 0; i < 10; i++) twin.crews.tick();
    expect(twin.crews.toSave()).toEqual(t.crews.toSave());
    // Фронт кончился, следующий — снова вне радиуса: бригада не едет к нему, а свободна (домой).
    t.crews.relocate(old, 70);
    expect(old.project).toBeUndefined();
    expect(old.state).toBe('back');
  });

  it('назначенная игроком бригада после конца фронта едет к следующему и вне радиуса', () => {
    const t = bench();
    const [b] = t.base(100, { x: 0, y: 0 }, 1);
    t.sites.set(7, { node: 70, pos: { x: 9000, y: 0 } });
    expect(t.crews.send(b, 7)).toBeNull();
    t.crews.tick();
    t.crews.arrive(b, { node: 70, pos: { x: 9000, y: 0 } });
    t.host.time = 10_000;
    t.crews.tick();
    expect(b.state).toBe('working');
    t.crews.relocate(b, 70);
    expect(b.state).toBe('going');
    expect(b.project).toBe(7);
  });
});

describe('Радиус обслуживания базы в игре: «нет базы рядом»', () => {
  const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };
  // Маленькая карта меньше радиуса: в проверке радиус — 600 м.
  const radius = CONSTRUCTION.serviceRadius;
  beforeEach(() => {
    CONSTRUCTION.serviceRadius = 600;
  });
  afterEach(() => {
    CONSTRUCTION.serviceRadius = radius;
  });

  /** Узел дороги в точке p (в пределах метра). */
  const nodeAt = (game: Game, p: Vec) => [...game.roads.net.nodes.values()].find((n) => dist(n.pos, p) < 1)?.id ?? null;

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

  /** Готовая дорога в поле, база у её начала и проект от её дальнего конца: подъезд есть, а база далеко. */
  function farProject(): { game: Game; at: Vec; id: number; b: Brigade } {
    const game = withoutCitizens(new Game(WORLD));
    const at = field(game, 2000);
    expect(road(game, { free: at }, { free: { x: at.x + 1400, y: at.y } })).toBe(true);
    expect(game.buildBase({ x: at.x + 120, y: at.y - 40 })).toBeNull();
    const end = nodeAt(game, { x: at.x + 1400, y: at.y })!;
    const id = game.construction.peekId();
    const plan = game.roadBuilder.road(anchorOf(game, end), anchorOf(game, { free: { x: at.x + 2000, y: at.y } }), STREET, { project: true });
    expect(plan.ok && game.roadBuilder.apply(plan)).toBeTruthy();
    const b = [...game.construction.crews.brigades.values()][0];
    return { game, at, id, b };
  }

  it('стройка вне радиуса: бригада не едет; «нет базы рядом» — плашка, строка, карточка, советник; buildIdle молчит', () => {
    const { game, id, b } = farProject();
    runSeconds(game, CONSTRUCTION.idleWarn + 10);
    expect(b.state).toBe('idle');
    const info = game.construction.info(id)!;
    expect(info.access).toBe(true);
    expect(info.near).toBe(false);
    expect(info.noBase).toBe(true);
    expect(info.done).toBe(0);
    expect(projectBadges(game, 1).find((x) => x.id === id)?.text).toContain('⛔ нет базы рядом');
    expect(projectRowHtml(info, 0, true)).toContain('⛔ нет базы рядом');
    const card = projectCardHtml(game, id);
    expect(card).toContain('Нет базы рядом');
    expect(card).toContain('стоит: нет базы рядом');
    expect(card).toContain('data-action="base-place"');
    const tips = advise(game);
    const tip = tips.find((a) => a.kind === 'buildNoBase');
    expect(tip?.title).toBe('Нет базы рядом со стройкой');
    expect(tip?.fix).toEqual({ kind: 'base' });
    expect(tips.some((a) => a.kind === 'buildIdle' || a.kind === 'buildNoAccess')).toBe(false);
    // Карточка базы: радиус и дальняя стройка помечена; бригада — «стройки вне радиуса».
    const baseHtml = baseCardHtml(game, b.base);
    expect(baseHtml).toContain('📡');
    expect(baseHtml).toContain('вне радиуса');
    expect(baseHtml).toContain('стройки вне радиуса');
    // Карточка бригады: туда можно, но с предупреждением.
    expect(crewCardHtml(game, b.id, { following: false, picking: false })).toContain('⚠ вне радиуса базы — строить будет медленно');
  });

  it('вручную вне радиуса — бригада едет и строит; «нет базы рядом» уходит', () => {
    const { game, id, b } = farProject();
    runSeconds(game, 2);
    expect(game.brigadeCanGo(b.id, id)).toBeNull();
    expect(game.sendBrigade(b.id, id)).toBeNull();
    expect(game.construction.info(id)!.noBase).toBe(false);
    for (let t = 0; t < 120 && !game.construction.info(id)!.done; t += 0.5) runSeconds(game, 0.5);
    expect(game.construction.info(id)!.done).toBeGreaterThan(0);
    expect(b.project).toBe(id);
    expect(advise(game).some((a) => a.kind === 'buildNoBase')).toBe(false);
  });

  it('база рядом со стройкой — её бригада едет сама, а бригада дальней базы остаётся дома', () => {
    const { game, at, id, b } = farProject();
    runSeconds(game, 2);
    expect(game.buildBase({ x: at.x + 1250, y: at.y - 40 })).toBeNull();
    const crews = game.construction.crews;
    const mine = [...crews.brigades.values()].find((x) => x.base !== b.base)!;
    expect(game.construction.info(id)!.near).toBe(true);
    for (let t = 0; t < 120 && !game.construction.info(id)!.done; t += 0.5) runSeconds(game, 0.5);
    expect(game.construction.info(id)!.done).toBeGreaterThan(0);
    expect(mine.project).toBe(id);
    expect(b.project).toBeUndefined();
  });

  it('сохранение посреди стройки вне радиуса — после загрузки всё так же, и дальше одинаково', () => {
    const { game, id, b } = farProject();
    expect(game.sendBrigade(b.id, id)).toBeNull();
    // Вся колонна на стройке, каждая машина на своём месте (поток не сохраняется).
    const crews = game.construction.crews;
    for (let t = 0; t < 120 && (b.convoy || !crews.placed(b).every(Boolean)); t += 0.1) runSeconds(game, 0.1);
    expect(crews.placed(b)).toEqual([true, true, true]);
    // «↺ Авто»: дальше бригадой распоряжается автоматика — свой фронт она доделывает и вне радиуса.
    game.construction.crews.unpin(b);
    const loaded = withoutCitizens(new Game(WORLD, JSON.parse(JSON.stringify(game.toSave()))));
    const twin = loaded.construction.crews.brigades.get(b.id)!;
    expect(twin.state).toBe(b.state);
    expect(twin.project).toBe(id);
    for (const g of [game, loaded]) runSeconds(g, 10);
    expect(b.project).toBe(id);
    expect(twin.project).toBe(id);
    expect(loaded.construction.crews.toSave()).toEqual(game.construction.crews.toSave());
    expect(loaded.construction.info(id)!.done).toBe(game.construction.info(id)!.done);
  });
});
