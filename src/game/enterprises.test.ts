import { describe, expect, it } from 'vitest';
import { ECONOMY, ENTERPRISE, MONTH_LENGTH } from '../config';
import { add, dist, type Vec } from '../core/vec';
import { INDUSTRY_TYPES, type IndustryKind } from '../world/cargo';
import { buildCost, harmClass, inTown, isRaw, townEdge, townFor, townIndustries, townSlots, workersNeeded } from '../world/enterprise';
import type { Industry, Station, Town } from '../world/entities';
import { NEW_GAME_SETTINGS, type WorldSettings } from '../world/settings';
import { footprintRadius } from '../world/spatial';
import { Game } from './game';
import { connectNodes, freshGame, runMonths, runSeconds, STREET, stationAtIndustry, stationExit, townStreets, withoutCitizens } from './testkit';

// Средняя карта: пять крупных городов (TOWN_SCALE) на маленькой не оставляют места заводам у их края.
const WORLD: WorldSettings = { ...NEW_GAME_SETTINGS, seed: 7, size: 'medium', towns: 5, money: 5_000_000, biome: 'temperate', relief: 'plains' };

const player = (extra: Partial<WorldSettings> = {}) => withoutCitizens(freshGame({ ...WORLD, ...extra }));
/** Просторная карта с редкими городами: есть места, куда рабочие сами не дойдут. */
const SPARSE: Partial<WorldSettings> = { size: 'large', towns: 4 };

/** Место у города t на зазоре от gap до gap+200 от его черты, где завод kind можно поставить. */
function spotNear(g: Game, kind: IndustryKind, t: Town, gap: number): Vec {
  const info = INDUSTRY_TYPES[kind];
  for (let d = gap; d < gap + 600; d += 40) {
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      const r = townEdge(t) + Math.hypot(info.w, info.h) / 4 + d;
      const p = add(t.center, { x: Math.cos(a) * r, y: Math.sin(a) * r });
      if (g.enterprises.plan(kind, p).ok) return p;
    }
  }
  throw new Error('нет места');
}

/** Место для завода kind чуть дальше far от черты всех городов: рабочие сами не дойдут, а автобусу — недалеко. */
function farSpot(g: Game, kind: IndustryKind): Vec {
  let best: { p: Vec; gap: number } | null = null;
  for (let y = 400; y < g.terrain.height - 400; y += 120) {
    for (let x = 400; x < g.terrain.width - 400; x += 120) {
      const p = { x, y };
      const gap = Math.min(...g.towns.map((t) => dist(t.center, p) - townEdge(t)));
      if (gap < ENTERPRISE.commute.far + 200 || (best && gap >= best.gap)) continue;
      if (g.enterprises.plan(kind, p).ok) best = { p, gap };
    }
  }
  if (!best) throw new Error('нет места вдали от городов');
  return best.p;
}

/** Чистый (невредный) завод на одно сырьё, который можно построить. */
const cleanPlant = (g: Game): IndustryKind => g.enterprises.kinds().find((k) => !isRaw(k) && !harmClass(k.kind) && k.accepts.length === 1)!.kind;

describe('мир «Строит игрок»', () => {
  it('месторождения всех видов добычи, на старте — несколько предприятий; добыча стоит на месторождениях', () => {
    const g = player({ size: 'medium', towns: 10 });
    const raw = g.enterprises.kinds().filter(isRaw);
    expect(raw.length).toBeGreaterThan(5);
    for (const k of raw) expect(g.enterprises.deposits.some((d) => d.kind === k.kind)).toBe(true);
    expect(g.industries.length).toBeGreaterThan(2);
    expect(g.industries.length).toBeLessThanOrEqual(12);
    for (const ind of g.industries.filter((i) => isRaw(i.info))) {
      const d = g.enterprises.deposits.find((x) => x.used === ind.id);
      expect(d, ind.name).toBeTruthy();
      expect(dist(d!.center, ind.fp.center)).toBeLessThan(1);
    }
    // Есть и заброшенные, и заводы в черте городов — невредные, по местам.
    expect(g.industries.some((i) => i.ruin)).toBe(true);
    const inTowns = g.industries.filter((i) => !i.ruin && townFor(g.towns, i.fp));
    expect(inTowns.length).toBeGreaterThan(0);
    for (const ind of inTowns) {
      expect(harmClass(ind.info.kind)).toBe(0);
      const t = townFor(g.towns, ind.fp)!;
      expect(townIndustries(t, g.towns, g.industries).length).toBeLessThanOrEqual(townSlots(t));
    }
  });

  it('по seed мир тот же; сохранение хранит месторождения и состояние предприятий', () => {
    const a = player();
    // Заново по тому же seed — генерация, а не копия свежей партии (player).
    const b = new Game({ ...WORLD });
    expect(b.enterprises.deposits).toEqual(a.enterprises.deposits);
    expect(b.industries.map((i) => [i.info.kind, i.fp.center])).toEqual(a.industries.map((i) => [i.info.kind, i.fp.center]));
    const ruin = a.industries.find((i) => i.ruin);
    const save = JSON.parse(JSON.stringify(a.toSave()));
    const c = new Game(save.settings, save);
    expect(c.enterprises.on).toBe(true);
    expect(c.enterprises.deposits).toEqual(a.enterprises.deposits);
    expect(c.industries.map((i) => i.fp.parts)).toEqual(a.industries.map((i) => i.fp.parts));
    if (ruin) expect(c.industries.find((i) => i.id === ruin.id)?.ruin).toBe(true);
  });

  it('«Готовые» (нет поля) — прежний мир без месторождений, рабочие и вред ни на что не влияют', () => {
    const g = withoutCitizens(new Game({ ...WORLD, industryMode: undefined }));
    expect(g.enterprises.on).toBe(false);
    expect(g.enterprises.deposits).toEqual([]);
    expect(g.industries.length).toBeGreaterThan(15);
    for (const ind of g.industries) expect(g.enterprises.staff(ind)).toBe(1);
    for (const t of g.towns) expect(g.enterprises.growth(t)).toBe(1);
    expect(g.enterprises.plan('sawmill', g.towns[0].center).ok).toBe(false);
  });
});

describe('постройка', () => {
  it('добыча — только на свободном месторождении своего вида: встаёт ровно на него, деньги списаны', () => {
    const g = player();
    const d = g.enterprises.deposits.find((x) => x.used === undefined && !townFor(g.towns, { center: x.center, w: 100, h: 80, angle: 0 }))!;
    const far = add(d.center, { x: 900, y: 0 });
    expect(g.enterprises.plan(d.kind, far).reason).toMatch(/месторожден/);
    const plan = g.enterprises.plan(d.kind, add(d.center, { x: 30, y: -20 }));
    expect(plan.ok).toBe(true);
    expect(plan.fp!.center).toEqual(d.center);
    const money = g.money;
    expect(g.enterprises.build(d.kind, add(d.center, { x: 30, y: -20 }))).toBeNull();
    const ind = g.industries[g.industries.length - 1];
    expect(ind.info.kind).toBe(d.kind);
    expect(ind.builtBy).toBe('player');
    expect(d.used).toBe(ind.id);
    expect(g.money).toBe(money - buildCost(ind.info));
    // Занятое — второй раз не поставить.
    expect(g.enterprises.plan(d.kind, d.center).ok).toBe(false);
  });

  it('завод в черте города — только на свободное место; нет мест — красным с причиной', () => {
    const g = player();
    const kind = cleanPlant(g);
    const t = g.towns.find((x) => townSlots(x) > 0)!;
    // Место у самого края застройки (на кольце черты) — городское.
    const edge = (x: Town) => {
      for (let k = 0; k < 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        const p = add(x.center, { x: Math.cos(a) * (townEdge(x) - 30), y: Math.sin(a) * (townEdge(x) - 30) });
        const plan = g.enterprises.plan(kind, p);
        if (plan.town === x && (plan.ok || plan.reason?.includes('🏙'))) return { p, plan };
      }
      throw new Error('нет места у края');
    };
    // Город сам занимает все свои места — следующее место только с причиной.
    while (townIndustries(t, g.towns, g.industries).length < townSlots(t)) expect(g.enterprises.townBuilds(t)).toBeTruthy();
    const full = edge(t).plan;
    expect(full.ok).toBe(false);
    expect(full.reason).toMatch(/🏙.*нет места/);
    expect(full.slots).toEqual({ used: townSlots(t), total: townSlots(t) });
  });

  it('вредное у города: в предпросмотре — вред городу, после постройки город растёт медленнее', () => {
    const g = player();
    const t = [...g.towns].sort((a, b) => b.population - a.population)[0];
    const kind = g.enterprises.kinds().find((k) => !isRaw(k) && harmClass(k.kind) >= 2)!.kind;
    const p = spotNear(g, kind, t, 60);
    const plan = g.enterprises.plan(kind, p);
    expect(plan.harm.find((h) => h.town === t)?.cut).toBeGreaterThan(0);
    const before = g.enterprises.growth(t);
    expect(g.enterprises.build(kind, p)).toBeNull();
    g.enterprises.changed();
    expect(g.enterprises.growth(t)).toBeLessThan(before);
    expect(g.townReviews(t).some((r) => r.text.includes('Дым'))).toBe(true);
  });

  it('у города рабочие приходят сами, далеко — нет: без рабочих завод не перерабатывает', () => {
    const g = player(SPARSE);
    const kind = cleanPlant(g);
    const t = [...g.towns].sort((a, b) => b.population - a.population)[0];
    expect(g.enterprises.build(kind, spotNear(g, kind, t, 100))).toBeNull();
    const near = g.industries[g.industries.length - 1];
    expect(g.enterprises.build(kind, farSpot(g, kind))).toBeNull();
    const far = g.industries[g.industries.length - 1];
    g.enterprises.changed();
    expect(g.enterprises.staff(near)).toBe(1);
    expect(g.enterprises.staff(far)).toBe(0);
    expect(g.enterprises.busNeed(far)).toBe(workersNeeded(far.info));
    for (const ind of [near, far]) ind.stock[ind.info.accepts[0]] = 100;
    runSeconds(g, 10);
    expect(near.stock[near.info.accepts[0]]).toBeLessThan(100);
    expect(far.stock[far.info.accepts[0]]).toBe(100);
    expect(g.industryRate(far)).toBe(0);
  });

  it('рабочих, довезённых на станцию у далёкого завода, хватает на месяц: обеспеченность растёт, потом убывает', () => {
    const g = player(SPARSE);
    const kind = cleanPlant(g);
    expect(g.enterprises.build(kind, farSpot(g, kind))).toBeNull();
    const ind = g.industries[g.industries.length - 1];
    g.enterprises.changed();
    const need = g.enterprises.busNeed(ind);
    expect(need).toBe(workersNeeded(ind.info));
    const dock = { serves: { pax: true, cargo: true }, catchPop: 0, industryIds: [ind.id] } as unknown as Station;
    expect(g.enterprises.takesWorkers(dock)).toBe(true);
    const before = g.enterprises.staff(ind);
    g.enterprises.addCrew(dock, Math.ceil(need));
    expect(g.enterprises.staff(ind)).toBeGreaterThan(before);
    expect(g.enterprises.staff(ind)).toBeCloseTo(1, 1);
    runSeconds(g, MONTH_LENGTH);
    expect(g.enterprises.staff(ind)).toBeLessThan(0.5);
  });

  it('далёкий завод получает рабочих из города, а маршрут получает плату за подвоз', () => {
    const g = player(SPARSE);
    const kind = cleanPlant(g);
    expect(g.enterprises.build(kind, farSpot(g, kind))).toBeNull();
    const ind = g.industries[g.industries.length - 1];
    g.enterprises.changed();
    const town = [...g.towns].sort((a, b) => dist(a.center, ind.fp.center) - dist(b.center, ind.fp.center))[0];
    // Станция у завода сама берёт пассажиров: ему нужен подвоз рабочих.
    const dock = stationAtIndustry(g, ind, town.center)!;
    expect(dock.serves.pax).toBe(true);
    // Автовокзал на городской улице-тупике, ближайшей к заводу (на окраине со стороны завода): от её конца — дорога к
    // заводу, не сквозь кварталы.
    const net = g.roads.net;
    const ends = [...new Set(townStreets(g, town.id).flatMap((c) => [c.a, c.b]))]
      .map((id) => net.node(id))
      .filter((n) => n.corridors.length === 1)
      .sort((a, b) => dist(a.pos, ind.fp.center) - dist(b.pos, ind.fp.center));
    let st: Station | null = null;
    for (const end of ends.slice(0, 12)) {
      const street = net.corridor(end.corridors[0]);
      const mid = street.lut.pointAt(street.length / 2);
      const t = street.lut.tangentAt(street.length / 2);
      const placed = [-1, 1].map((side) => g.placeStation({ x: mid.x - t.y * side * 40, y: mid.y + t.x * side * 40 }, 14, 'road', { pax: true, cargo: false })).find(Boolean);
      if (!placed) continue;
      // Рабочие едут только со станции, у которой в охвате есть жители (у тупика на окраине их может и не быть).
      if (placed.catchPop <= 0) {
        g.removeStation(placed);
        continue;
      }
      // Узел на месте тупика (улицу станция могла разрезать — берём ближайший к его месту).
      const tip = net.nodesNear(end.pos, 2)[0] ?? end;
      if (connectNodes(g, tip, stationExit(g, dock.nodeId), STREET)) {
        st = placed;
        break;
      }
    }
    expect(st).not.toBeNull();
    const line = g.createLine([st!.id, dock.id])!;
    expect(g.buyVehicle(line.id, 'bus')).not.toBeNull();
    // Завод далеко (дальше дальней поездки на работу): первый автобус доезжает за несколько месяцев (от тупика на
    // окраине крупного города — TOWN_SCALE — путь длиннее).
    for (let m = 0; m < 20 && (ind.crew ?? 0) <= 1; m++) runMonths(g, 0.5);
    expect(ind.crew ?? 0).toBeGreaterThan(1);
    expect(g.enterprises.staff(ind)).toBeGreaterThan(0.05);
    expect(line.revenueLast + line.revenueMonth).toBeGreaterThan(line.costLast + line.costMonth);
  });

  it('снос: возврат половины, месторождение снова свободно; со станцией — нельзя', () => {
    const g = player();
    const d = g.enterprises.deposits.find((x) => x.used === undefined)!;
    g.enterprises.build(d.kind, d.center);
    const ind = g.industries[g.industries.length - 1];
    const money = g.money;
    expect(g.enterprises.removePlan(ind).refund).toBe(buildCost(ind.info) * ENTERPRISE.refund);
    expect(g.enterprises.remove(ind)).toBeNull();
    expect(g.money).toBe(money + buildCost(ind.info) * ENTERPRISE.refund);
    expect(d.used).toBeUndefined();
    expect(g.industries).not.toContain(ind);
  });

  it('заброшенное восстанавливается за полцены и начинает работать', () => {
    const g = player();
    const ruin = g.industries.find((i) => i.ruin)!;
    expect(g.industryRate(ruin)).toBe(0);
    const money = g.money;
    expect(g.enterprises.restore(ruin)).toBeNull();
    expect(ruin.ruin).toBeUndefined();
    expect(g.money).toBe(money - buildCost(ruin.info, true));
  });
});

describe('«Со строительством»', () => {
  it('предприятие — стройплощадка: без базы рядом стоит, с базой — строится по деньгам и достраивается', () => {
    const g = player({ construction: 'build' });
    const d = g.enterprises.deposits.find((x) => x.used === undefined)!;
    expect(g.enterprises.build(d.kind, d.center)).toBeNull();
    const ind = g.industries[g.industries.length - 1];
    expect(ind.build?.done).toBe(0);
    const money = g.money;
    runSeconds(g, 5);
    expect(g.enterprises.stalls.get(ind.id)).toBe('base');
    expect(ind.build!.done).toBe(0);
    // База рядом (как поставил бы игрок).
    const base = { type: 'base' as const, id: g.nextId(), fp: { center: add(ind.fp.center, { x: 300, y: 0 }), w: 36, h: 24, angle: 0 }, nodeId: 0 };
    g.construction.crews.bases.set(base.id, base);
    runSeconds(g, ind.build!.time / 2);
    expect(ind.build!.done).toBeGreaterThan(0.3);
    expect(g.money).toBeLessThan(money);
    expect(g.industryRate(ind)).toBe(0);
    runSeconds(g, ind.build!.time);
    expect(ind.build).toBeUndefined();
    expect(ind.paid).toBe(buildCost(ind.info));
    // Отмена стройки сносом вернула бы всё заплаченное — построенное возвращает половину.
    expect(g.enterprises.removePlan(ind).refund).toBe(buildCost(ind.info) * ENTERPRISE.refund);
  });

  it('стройка площадки не тратит запас на содержание: ждёт (upkeep), без денег вовсе — money', () => {
    const g = player({ construction: 'build' });
    const d = g.enterprises.deposits.find((x) => x.used === undefined)!;
    expect(g.enterprises.build(d.kind, d.center)).toBeNull();
    const ind = g.industries[g.industries.length - 1];
    const base = { type: 'base' as const, id: g.nextId(), fp: { center: add(ind.fp.center, { x: 300, y: 0 }), w: 36, h: 24, angle: 0 }, nodeId: 0 };
    g.construction.crews.bases.set(base.id, base);
    const upkeep = g.upkeepReserve;
    expect(upkeep).toBeGreaterThan(0);
    // Сверх кредитного предела — ровно запас (содержание на полмесяца вперёд): площадка ждёт, со счёта уходит только
    // содержание этих секунд.
    g.money = ECONOMY.creditLimit + upkeep;
    const build0 = g.ledger.build;
    runSeconds(g, 2);
    expect(g.enterprises.stalls.get(ind.id)).toBe('upkeep');
    expect(ind.build!.done).toBe(0);
    expect(g.ledger.build).toBe(build0);
    expect(g.money).toBeLessThan(ECONOMY.creditLimit + upkeep);
    expect(g.money).toBeGreaterThan(ECONOMY.creditLimit + upkeep - (g.upkeepForecast().total * 2.2) / MONTH_LENGTH - 5);
    g.money = ECONOMY.creditLimit;
    runSeconds(g, 1);
    expect(g.enterprises.stalls.get(ind.id)).toBe('money');
    // Деньги пришли — строится.
    g.money = ECONOMY.creditLimit + upkeep + buildCost(ind.info);
    runSeconds(g, 2);
    expect(g.enterprises.stalls.has(ind.id)).toBe(false);
    expect(ind.build!.done).toBeGreaterThan(0);
  });
});

describe('места в черте города', () => {
  it('пустует 12 мин — город решает строить и в следующем месяце строит сам невредный завод в черте', () => {
    const g = player({ size: 'medium', towns: 8 });
    const t = g.towns.find((x) => townSlots(x) > townIndustries(x, g.towns, g.industries).length)!;
    const before = townIndustries(t, g.towns, g.industries).length;
    runMonths(g, ENTERPRISE.slots.idleMonths - 1);
    expect(townIndustries(t, g.towns, g.industries).length).toBe(before);
    expect(t.slotOpenAt).toBeUndefined();
    // Итоги 12-го месяца: решение принято, момент открытия — в следующем месяце.
    runMonths(g, 1);
    expect(townIndustries(t, g.towns, g.industries).length).toBe(before);
    expect(t.slotOpenAt).toBeGreaterThan(g.time);
    expect(t.slotOpenAt).toBeLessThan(g.time + MONTH_LENGTH);
    runMonths(g, 1);
    expect(t.slotOpenAt).toBeUndefined();
    const after = townIndustries(t, g.towns, g.industries);
    expect(after.length).toBe(before + 1);
    const fresh = after.find((i) => i.builtBy === 'town')!;
    expect(harmClass(fresh.info.kind)).toBe(0);
    expect(inTown(t, fresh.fp)).toBe(true);
    expect(footprintRadius(fresh.fp)).toBeGreaterThan(0);
  });

  it('второй завод того же рецепта, что уже стоит в городе со старта, город сам не строит', () => {
    const g = player({ size: 'medium', towns: 8 });
    // Город со стартовым заводом; мест — все четыре, а нужна городам только его продукция.
    const t = g.towns.find((x) => townIndustries(x, g.towns, g.industries).some((i) => !i.builtBy && !i.ruin && !isRaw(i.info)))!;
    expect(t).toBeTruthy();
    const start = townIndustries(t, g.towns, g.industries).find((i) => !i.builtBy && !i.ruin)!;
    t.population = 30_000;
    for (const x of g.towns) x.demands = [start.info.produces];
    // Другие заводы той же продукции город может поставить, но каждый — по одному.
    for (let n = 0; n < 4 && g.enterprises.townPlant(t); n++) g.enterprises.townBuilds(t);
    const kinds = townIndustries(t, g.towns, g.industries).map((i) => i.info.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(g.enterprises.townPlant(t)).toBeNull();
    // Место пустует сколько угодно — город его не занимает: ждёт игрока.
    const before = townIndustries(t, g.towns, g.industries).length;
    expect(before).toBeLessThan(townSlots(t));
    for (let n = 0; n < ENTERPRISE.slots.idleMonths + 2; n++) g.enterprises.monthEnd();
    expect(townIndustries(t, g.towns, g.industries).length).toBe(before);
  });

  it('игрок может поставить второй такой же завод в город сам', () => {
    const g = player({ size: 'medium', towns: 8 });
    const t = [...g.towns].sort((a, b) => b.population - a.population)[0];
    t.population = 30_000;
    const ind = g.enterprises.townBuilds(t)!;
    expect(ind).toBeTruthy();
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      const p = add(t.center, { x: Math.cos(a) * (townEdge(t) - 30), y: Math.sin(a) * (townEdge(t) - 30) });
      const plan = g.enterprises.plan(ind.info.kind, p);
      if (plan.town === t && plan.ok) return;
    }
    throw new Error('второй такой же завод игроку не поставить');
  });
});

describe('заводы городов открываются по ходу месяца', () => {
  /** Партия, где в итогах ближайшего месяца сразу несколько городов решают строить: места есть и пустуют давно. */
  const crowd = () => {
    const g = player({ size: 'medium', towns: 8 });
    for (const t of g.towns) t.slotIdle = ENTERPRISE.slots.idleMonths - 1;
    runMonths(g, 1);
    const due = g.towns.filter((t) => t.slotOpenAt !== undefined);
    return { g, due };
  };
  const byTown = (g: Game) => g.industries.filter((i) => i.builtBy === 'town').length;

  it('в итогах месяца — только решение; заводы открываются по одному, в разные моменты месяца', () => {
    const { g, due } = crowd();
    expect(due.length).toBeGreaterThanOrEqual(4);
    const start = g.time;
    const built0 = byTown(g);
    // Сразу после итогов месяца ни одного: не шквал в начале месяца.
    expect(built0).toBe(0);
    const at: number[] = [];
    let prev = built0;
    runSeconds(g, MONTH_LENGTH - 0.2, () => {
      const now = byTown(g);
      // Не больше одного открытия за такт.
      expect(now - prev).toBeLessThanOrEqual(1);
      if (now > prev) at.push(g.time - start);
      prev = now;
    });
    // Все решённые открылись до конца месяца — за месяц столько же заводов, сколько и прежде разом.
    expect(g.towns.filter((t) => t.slotOpenAt !== undefined)).toEqual([]);
    expect(at.length).toBe(due.length);
    // Растянуты на весь месяц: первое — в первой его половине, последнее — во второй, между соседними — зазор.
    expect(at[0]).toBeLessThan(MONTH_LENGTH / 2);
    expect(at[at.length - 1]).toBeGreaterThan(MONTH_LENGTH / 2);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThan(MONTH_LENGTH / due.length / 4);
    // Уведомления — тоже по одному, со значками рецепта.
    const notes = g.news.entries.filter((e) => e.text.startsWith('🏭 Открытие в городе'));
    expect(notes.length).toBe(due.length);
    for (const e of notes) {
      expect(e.recipe).toBeTruthy();
      expect(e.text.endsWith(e.recipe!.name)).toBe(true);
    }
  });

  it('моменты открытий — по seed партии; переживают сохранение и загрузку', () => {
    const a = crowd();
    const b = crowd();
    expect(b.due.map((t) => [t.id, t.slotOpenAt])).toEqual(a.due.map((t) => [t.id, t.slotOpenAt]));
    const { g, due } = a;
    runSeconds(g, MONTH_LENGTH / 3);
    const left = due.filter((t) => t.slotOpenAt !== undefined);
    expect(left.length).toBeGreaterThan(0);
    const loaded = withoutCitizens(new Game(g.settings, JSON.parse(JSON.stringify(g.toSave()))));
    for (const t of left) expect(loaded.towns.find((x) => x.id === t.id)!.slotOpenAt).toBe(t.slotOpenAt);
    const before = byTown(loaded);
    runSeconds(loaded, MONTH_LENGTH - MONTH_LENGTH / 3 - 0.2);
    expect(byTown(loaded) - before).toBe(left.length);
  });

  it('старое сохранение без моментов: город, что давно ждёт, решает в итогах месяца и открывает в следующем', () => {
    const { g, due } = crowd();
    const save = JSON.parse(JSON.stringify(g.toSave()));
    for (const t of save.towns) delete t.slotOpenAt;
    const old = withoutCitizens(new Game(g.settings, save));
    expect(old.towns.every((t) => t.slotOpenAt === undefined)).toBe(true);
    runMonths(old, 1);
    expect(old.towns.filter((t) => t.slotOpenAt !== undefined).length).toBe(due.length);
    expect(byTown(old)).toBe(0);
    runMonths(old, 1);
    expect(byTown(old)).toBe(due.length);
  });

  it('место заняли до назначенного момента — город не строит второй', () => {
    const { g, due } = crowd();
    const t = due[0];
    // Место заняли (игрок или сам город раньше срока): все места города заняты.
    while (townIndustries(t, g.towns, g.industries).length < townSlots(t)) expect(g.enterprises.townBuilds(t)).toBeTruthy();
    const full = townIndustries(t, g.towns, g.industries).length;
    runSeconds(g, MONTH_LENGTH - 0.2);
    expect(townIndustries(t, g.towns, g.industries).length).toBe(full);
    expect(t.slotOpenAt).toBeUndefined();
    expect(t.slotIdle).toBeUndefined();
  });
});

/** Для отладки: что за предприятия. */
export const describeIndustries = (g: Game) => g.industries.map((i: Industry) => `${i.info.kind}${i.ruin ? '(R)' : ''}`).join(',');
