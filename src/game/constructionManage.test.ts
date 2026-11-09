/**
 * Управление стройкой (режим «Со строительством»): резерв денег на проект, приоритет проекта, снос строительной базы.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSTRUCTION, COST, ECONOMY } from '../config';
import type { Vec } from '../core/vec';
import type { BuildBase } from '../world/entities';
import type { WorldSettings } from '../world/settings';
import { Game } from './game';
import { anchorOf, clearStrip, type End, openSpot, road, runSeconds, STREET, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' };

/** Первая база — у улиц самого большого города, первое место по кругу без сноса домов. */
function firstBase(game: Game): BuildBase {
  const town = [...game.towns].sort((a, b) => b.population - a.population || a.id - b.id)[0];
  for (const k of [1, 0.75, 1.3, 0.5, 1.7]) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const p = { x: town.center.x + Math.cos(a) * town.radius * k, y: town.center.y + Math.sin(a) * town.radius * k };
      const plan = game.basePlan(p);
      if (plan.ok && !plan.demolish.length && game.buildBase(p) === null) return [...game.construction.crews.bases.values()].at(-1)!;
    }
  }
  throw new Error('нет места для базы');
}

function newGame(): Game {
  return withoutCitizens(new Game({ ...WORLD }));
}

function buildGame(): Game {
  const game = newGame();
  firstBase(game);
  return game;
}

/** Узел дороги в точке p (в пределах метра), если есть. */
function nodeAt(game: Game, p: Vec): number | null {
  return [...game.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - p.x, n.pos.y - p.y) < 1)?.id ?? null;
}

/** Дорога проектом; свободная точка, где уже кончается подъезд (gateAt), — этот узел (как в construction.test.ts). */
function project(game: Game, a: End, b: End): boolean {
  const snap = (x: End): End => (typeof x === 'object' && 'free' in x ? (nodeAt(game, x.free) ?? x) : x);
  const plan = game.roadBuilder.road(anchorOf(game, snap(a)), anchorOf(game, snap(b)), STREET, { project: true });
  return plan.ok && game.roadBuilder.apply(plan);
}

/** Подъезд к точке p: короткая готовая улица с запада (или юга, севера), тупиком в p. Ответ — узел другого конца. */
function gateAt(game: Game, p: Vec): number {
  for (const d of [
    { x: -90, y: 0 },
    { x: 0, y: 90 },
    { x: 0, y: -90 },
  ]) {
    const from = { x: p.x + d.x, y: p.y + d.y };
    if (!road(game, { free: from }, { free: p })) continue;
    const gate = nodeAt(game, from);
    if (gate !== null && nodeAt(game, p) !== null) return gate;
  }
  throw new Error('нет места для подъезда');
}

function freeSpot(game: Game, len: number, from = 400): Vec {
  for (let y = from; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 160) {
      // В чистом поле (без дорог, стартовых просёлков, зданий и воды): новая дорога ни с чем не пересекается.
      if (!clearStrip(game, { x, y }, { x: x + len, y }, 150)) continue;
      const plan = game.roadBuilder.road(anchorOf(game, { free: { x, y } }), anchorOf(game, { free: { x: x + len, y } }), STREET);
      if (plan.ok && !plan.demolish.length) return { x, y };
    }
  }
  throw new Error('нет места');
}

/**
 * Своя база в точке pos с n бригадами — бригады прочих баз распущены (как в construction.test.ts); ворота — узел gate
 * или конец подъезда к точке gate (по умолчанию — к pos).
 */
function crewAt(game: Game, pos: Vec, n = 1, gate: number | Vec = pos): BuildBase {
  const crews = game.construction.crews;
  crews.brigades.clear();
  const nodeId = typeof gate === 'number' ? gate : gateAt(game, gate);
  const base: BuildBase = { type: 'base', id: 990_000 + crews.bases.size, fp: { center: { ...pos }, w: 36, h: 24, angle: 0 }, nodeId, paid: CONSTRUCTION.base.cost };
  crews.bases.set(base.id, base);
  for (let i = 0; i < n; i++) crews.hire(base.id);
  return base;
}

function untilWorking(game: Game, limit = 120): void {
  let t = 0;
  const crews = game.construction.crews;
  // Машины сходят на стройку по одной — ждём, пока на своих местах все машины бригады (Crews.placed).
  while (t < limit && ![...crews.brigades.values()].some((b) => crews.placed(b).every(Boolean))) {
    runSeconds(game, 0.1);
    t += 0.1;
  }
}

describe('Стройка: резерв денег на проект', () => {
  const reach = CONSTRUCTION.reach;
  beforeEach(() => {
    CONSTRUCTION.reach = 1e12;
  });
  afterEach(() => {
    CONSTRUCTION.reach = reach;
  });

  /** Партия с проектом на 600 м и бригадой под боком. */
  function withProject(): { game: Game; id: number } {
    const game = buildGame();
    const at = freeSpot(game, 600);
    crewAt(game, at);
    expect(project(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
    return { game, id: game.construction.list()[0].project.id };
  }

  it('резерв откладывает остаток проекта: деньги на счёте, но бюджет прочих трат меньше; снять — снова свободны', () => {
    const { game, id } = withProject();
    const money = game.money;
    const budget = game.budget;
    const left = game.construction.info(id)!.left;
    expect(left).toBeGreaterThan(0);
    expect(game.reserveProject(id, true)).toBeNull();
    expect(game.construction.projects.get(id)!.reserve).toBe(left);
    expect(game.reserved).toBe(left);
    expect(game.money).toBe(money);
    expect(game.budget).toBe(budget - left);
    // Повторно — нечего докладывать.
    expect(game.reserveProject(id, true)).toBeNull();
    expect(game.reserved).toBe(left);
    expect(game.reserveProject(id, false)).toBeNull();
    expect(game.construction.projects.get(id)!.reserve).toBeUndefined();
    expect(game.budget).toBe(budget);
  });

  it('прочие траты резерв не берут: денег — ровно на резерв, бригаду не нанять', () => {
    const { game, id } = withProject();
    game.reserveProject(id, true);
    game.money = ECONOMY.creditLimit + game.reserved + CONSTRUCTION.brigade.cost - 1;
    const base = [...game.construction.crews.bases.keys()][0];
    expect(game.hireBrigade(base)).toBe('Не хватает денег');
    game.money += 1;
    expect(game.hireBrigade(base)).toBeNull();
  });

  it('свободных денег мало — откладывается, сколько есть; потом можно доложить', () => {
    const { game, id } = withProject();
    const left = game.construction.info(id)!.left;
    game.money = ECONOMY.creditLimit + Math.floor(left / 3);
    expect(game.reserveProject(id, true)).toBeNull();
    expect(game.reserved).toBe(Math.floor(left / 3));
    expect(game.budget).toBe(0);
    expect(game.reserveProject(id, true)).toBe('Не хватает денег');
    game.money += left;
    expect(game.reserveProject(id, true)).toBeNull();
    expect(game.reserved).toBe(left);
  });

  it('проект с резервом не встаёт без свободных денег и платит из резерва; без резерва — встаёт', () => {
    const run = (reserve: boolean) => {
      const { game, id } = withProject();
      untilWorking(game);
      if (reserve) game.reserveProject(id, true);
      // Свободных денег — ноль: на счёте ровно резерв (над кредитным пределом).
      game.money = ECONOMY.creditLimit + game.reserved;
      const r0 = game.reserved;
      const m0 = game.money;
      // Отсыпку головная машина начала, ещё пока подъезжали остальные: считаем готовое с этого места.
      const d0 = game.construction.info(id)!.done;
      runSeconds(game, 10);
      const p = game.construction.projects.get(id)!;
      return { game, p, paid: m0 - game.money, used: r0 - game.reserved, done: game.construction.info(id)!.done - d0 };
    };
    const without = run(false);
    expect(without.p.stalled).toBeDefined();
    expect(without.done).toBeLessThan(0.002);
    const withRes = run(true);
    expect(withRes.p.stalled).toBeUndefined();
    expect(withRes.done).toBeGreaterThan(0.1);
    // Заплачено ровно из резерва: бюджет прочих трат так и ноль.
    expect(withRes.paid).toBeGreaterThan(0);
    expect(withRes.used).toBe(withRes.paid);
    expect(withRes.game.budget).toBe(0);
  });

  it('резерв не обходит кредитный предел: деньги ушли в долг (содержание) — стройка встаёт и с резервом', () => {
    const { game, id } = withProject();
    untilWorking(game);
    game.reserveProject(id, true);
    game.money = ECONOMY.creditLimit - 1;
    runSeconds(game, 3);
    expect(game.construction.projects.get(id)!.stalled).toBeDefined();
  });

  it('отмена проекта и его окончание освобождают остаток резерва', () => {
    const a = withProject();
    a.game.reserveProject(a.id, true);
    expect(a.game.reserved).toBeGreaterThan(0);
    a.game.cancelProject(a.id);
    expect(a.game.reserved).toBe(0);
    expect(a.game.budget).toBe(a.game.money - ECONOMY.creditLimit);
    // Ctrl+Z возвращает проект вместе с резервом.
    a.game.undo();
    expect(a.game.construction.projects.get(a.id)?.reserve).toBeGreaterThan(0);

    const b = withProject();
    b.game.reserveProject(b.id, true);
    untilWorking(b.game);
    // Участок готов, когда до конца дошла разметка — на два интервала колонны позади отсыпки.
    runSeconds(b.game, (600 + 2 * CONSTRUCTION.convoyGap) / CONSTRUCTION.speed + 5);
    expect(b.game.construction.projects.size).toBe(0);
    expect(b.game.reserved).toBe(0);
  });

  it('резерв и приоритет — в сохранении; старые сохранения без них открываются', () => {
    const { game, id } = withProject();
    untilWorking(game);
    runSeconds(game, 3);
    game.reserveProject(id, true);
    game.prioritizeProject(id, true);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = withoutCitizens(new Game(save.settings, save));
    const p = loaded.construction.projects.get(id)!;
    expect(p.reserve).toBe(game.construction.projects.get(id)!.reserve);
    expect(p.priority).toBe(true);
    expect(loaded.budget).toBe(game.budget);
    for (const g of [game, loaded]) runSeconds(g, 20);
    expect(loaded.money).toBe(game.money);
    expect(loaded.reserved).toBe(game.reserved);
    // Старое сохранение: полей резерва и приоритета нет.
    for (const q of save.construction.projects) {
      delete q.reserve;
      delete q.priority;
    }
    const old = withoutCitizens(new Game(save.settings, save));
    expect(old.reserved).toBe(0);
    expect(old.construction.projects.get(id)!.priority).toBeUndefined();
  });
});

describe('Стройка: приоритет проекта', () => {
  /**
   * Два проекта, одна бригада; второй проект — дальше от базы. К обоим — подъезд от одних ворот: у первого — сами
   * ворота, у второго — свой подъезд, связанный с воротами готовой дорогой.
   */
  function twoProjects(): { game: Game; near: number; far: number } {
    const game = buildGame();
    // Оба места — в поле, второе в 600 м южнее; дорога от ворот ко второму тоже идёт полем.
    const at = openSpot(game, [
      [{ x: 0, y: 0 }, { x: 500, y: 0 }, 150],
      [{ x: 0, y: 600 }, { x: 500, y: 600 }, 150],
      [{ x: -150, y: 0 }, { x: -150, y: 600 }, 100],
    ]);
    const base = crewAt(game, { x: at.x - 30, y: at.y }, 1, at);
    const at2 = { x: at.x, y: at.y + 600 };
    const gate2 = gateAt(game, at2);
    expect(road(game, base.nodeId, gate2)).toBe(true);
    expect(project(game, { free: at }, { free: { x: at.x + 500, y: at.y } })).toBe(true);
    expect(project(game, { free: at2 }, { free: { x: at2.x + 500, y: at2.y } })).toBe(true);
    const [near, far] = game.construction.list().map((i) => i.project.id);
    return { game, near, far };
  }

  it('бригада работает на ближнем; приоритет дальнему — она переходит туда, ближний ждёт', () => {
    const { game, near, far } = twoProjects();
    untilWorking(game);
    const crew = [...game.construction.crews.brigades.values()][0];
    expect(crew.project).toBe(near);
    game.prioritizeProject(far, true);
    runSeconds(game, 0.2);
    expect(crew.project).toBe(far);
    expect(['going', 'working']).toContain(crew.state);
    const doneNear = game.construction.info(near)!.done;
    let t = 0;
    while (t < 600 && crew.state !== 'working') {
      runSeconds(game, 0.5);
      t += 0.5;
    }
    expect(crew.state).toBe('working');
    runSeconds(game, 5);
    expect(game.construction.info(far)!.done).toBeGreaterThan(0);
    expect(game.construction.info(near)!.done).toBe(doneNear);
  });

  it('свободная бригада едет сначала к приоритетному, даже если он дальше', () => {
    const { game, far } = twoProjects();
    game.prioritizeProject(far, true);
    runSeconds(game, 0.2);
    const crew = [...game.construction.crews.brigades.values()][0];
    expect(crew.project).toBe(far);
  });

  it('снять приоритет — бригада остаётся, пока проект не кончится; одинаковые действия — одинаковый итог', () => {
    const run = () => {
      const { game, near, far } = twoProjects();
      untilWorking(game);
      game.prioritizeProject(far, true);
      runSeconds(game, 30);
      game.prioritizeProject(far, false);
      runSeconds(game, 10);
      const crew = [...game.construction.crews.brigades.values()][0];
      return { project: crew.project === far ? 'far' : crew.project === near ? 'near' : '-', save: JSON.stringify(game.construction.toSave()), money: game.money };
    };
    const a = run();
    expect(a.project).toBe('far');
    expect(run()).toEqual(a);
  });
});

describe('Стройка: снос строительной базы', () => {
  it('единственная база: бригады распускаются с возвратом половины, за бесплатную базу — ничего; следующая — платная', () => {
    const game = buildGame();
    const base = [...game.construction.crews.bases.values()][0];
    expect(base.paid).toBe(0);
    expect(game.firstBase).toBe(false);
    const n = game.construction.crews.of(base.id).length;
    expect(n).toBeGreaterThan(0);
    const money = game.money;
    expect(game.removeBase(base.id)).toBeNull();
    expect(game.construction.crews.bases.size).toBe(0);
    expect(game.construction.crews.brigades.size).toBe(0);
    expect(game.money - money).toBe(n * Math.round(CONSTRUCTION.brigade.cost * COST.refundRatio));
    expect(game.structureAt(base.fp.center)?.type).not.toBe('base');
    // Первая уже была: снова «бесплатно» не будет — и после сохранения тоже.
    expect(game.firstBase).toBe(false);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = withoutCitizens(new Game(save.settings, save));
    expect(loaded.firstBase).toBe(false);
    const m = game.money;
    firstBase(game);
    expect(m - game.money).toBe(CONSTRUCTION.base.cost);
  });

  it('платная база возвращает половину цены; бригады переходят на ближайшую базу, работающая доделывает своё', () => {
    const reach = CONSTRUCTION.reach;
    CONSTRUCTION.reach = 1e12;
    try {
      const game = buildGame();
      const first = [...game.construction.crews.bases.values()][0];
      const at = freeSpot(game, 600);
      // Вторая база (платная) — у стройки, с бригадой; бригада первой базы свободна на ней.
      const second = crewAt(game, at);
      // Первая база — у дороги, связанной со стройкой (ворота — у того же подъезда): её бригады доедут.
      first.nodeId = second.nodeId;
      game.construction.crews.hire(first.id);
      expect(project(game, { free: at }, { free: { x: at.x + 600, y: at.y } })).toBe(true);
      const id = game.construction.list()[0].project.id;
      untilWorking(game);
      const worker = game.construction.crews.working(id)[0];
      expect(worker.base).toBe(second.id);
      const plan = game.baseRemovePlan(second.id)!;
      expect(plan.to).toBe(first.id);
      expect(plan.refund).toBe(Math.round(CONSTRUCTION.base.cost * COST.refundRatio));
      const money = game.money;
      const done = game.construction.info(id)!.done;
      expect(game.removeBase(second.id)).toBeNull();
      expect(game.money - money).toBe(plan.refund);
      expect(game.construction.crews.bases.has(second.id)).toBe(false);
      // Та же бригада, теперь — с первой базы, и строит дальше без перерыва.
      expect(worker.base).toBe(first.id);
      expect(worker.state).toBe('working');
      expect(worker.project).toBe(id);
      runSeconds(game, 3);
      expect(game.construction.info(id)!.done).toBeGreaterThan(done);
      expect(game.construction.crews.brigades.size).toBe(2);
    } finally {
      CONSTRUCTION.reach = reach;
    }
  });

  it('свободная бригада снесённой базы едет на новую и встаёт там; итог одинаков при повторе и после сохранения', () => {
    const run = () => {
      const game = buildGame();
      const first = [...game.construction.crews.bases.values()][0];
      const second = firstBase(game);
      expect(second.paid).toBe(CONSTRUCTION.base.cost);
      const crew = game.construction.crews.of(second.id)[0];
      expect(crew.state).toBe('idle');
      game.removeBase(second.id);
      expect(crew.base).toBe(first.id);
      expect(crew.state).toBe('back');
      const save = JSON.parse(JSON.stringify(game.toSave()));
      const loaded = withoutCitizens(new Game(save.settings, save));
      for (const g of [game, loaded]) runSeconds(g, 120);
      const after = loaded.construction.crews.brigades.get(crew.id)!;
      expect(crew.state).toBe('idle');
      expect(after.state).toBe('idle');
      expect(after.base).toBe(first.id);
      return JSON.stringify(game.construction.crews.toSave());
    };
    expect(run()).toBe(run());
  });

  it('старое сохранение (без firstUsed и цен баз): первая база считается бесплатной, остальные — по цене', () => {
    const game = buildGame();
    firstBase(game);
    const save = JSON.parse(JSON.stringify(game.toSave()));
    delete save.construction.crews.firstUsed;
    for (const b of save.construction.crews.bases) delete b.paid;
    const loaded = withoutCitizens(new Game(save.settings, save));
    const [a, b] = [...loaded.construction.crews.bases.values()];
    expect(a.paid).toBe(0);
    expect(b.paid).toBe(CONSTRUCTION.base.cost);
    expect(loaded.firstBase).toBe(false);
  });
});
