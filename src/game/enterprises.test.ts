import { describe, expect, it } from 'vitest';
import { ENTERPRISE, MONTH_LENGTH } from '../config';
import { add, dist, type Vec } from '../core/vec';
import { INDUSTRY_TYPES, type IndustryKind } from '../world/cargo';
import { buildCost, harmClass, inTown, isRaw, townEdge, townFor, townIndustries, townSlots, workersNeeded } from '../world/enterprise';
import type { Industry, Station, Town } from '../world/entities';
import { NEW_GAME_SETTINGS, type WorldSettings } from '../world/settings';
import { footprintRadius } from '../world/spatial';
import { Game } from './game';
import { connectNodes, runMonths, runSeconds, STREET, stationAtIndustry, stationExit, townStreets, withoutCitizens } from './testkit';

const WORLD: WorldSettings = { ...NEW_GAME_SETTINGS, seed: 7, size: 'small', towns: 5, money: 5_000_000, biome: 'temperate', relief: 'plains' };

const player = (extra: Partial<WorldSettings> = {}) => withoutCitizens(new Game({ ...WORLD, ...extra }));
/** Просторная карта с редкими городами: есть места, куда рабочие сами не дойдут. */
const SPARSE: Partial<WorldSettings> = { size: 'medium', towns: 4 };

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
    const b = player();
    expect(b.enterprises.deposits).toEqual(a.enterprises.deposits);
    expect(b.industries.map((i) => [i.info.kind, i.fp.center])).toEqual(a.industries.map((i) => [i.info.kind, i.fp.center]));
    const ruin = a.industries.find((i) => i.ruin);
    const save = JSON.parse(JSON.stringify(a.toSave()));
    const c = new Game(save.settings, save);
    expect(c.enterprises.on).toBe(true);
    expect(c.enterprises.deposits).toEqual(a.enterprises.deposits);
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

  it('автобус из города на станцию у далёкого завода возит рабочих без билета — завод начинает работать', () => {
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
    for (const end of ends.slice(0, 6)) {
      const street = net.corridor(end.corridors[0]);
      const mid = street.lut.pointAt(street.length / 2);
      const t = street.lut.tangentAt(street.length / 2);
      const placed = [-1, 1].map((side) => g.placeStation({ x: mid.x - t.y * side * 40, y: mid.y + t.x * side * 40 }, 14, 'road', { pax: true, cargo: false })).find(Boolean);
      if (!placed) continue;
      // Узел на месте тупика (улицу станция могла разрезать — берём ближайший к его месту).
      const tip = net.nodesNear(end.pos, 2)[0] ?? end;
      if (connectNodes(g, tip, stationExit(g, dock.nodeId), STREET)) {
        st = placed;
        break;
      }
    }
    expect(st).not.toBeNull();
    const line = g.createLine([st!.id, dock.id])!;
    for (let i = 0; i < 3; i++) g.buyVehicle(line.id, 'bus');
    const money = g.money;
    // Завод далеко (дальше дальней поездки на работу): первый автобус доезжает за пару месяцев.
    for (let m = 0; m < 10 && (ind.crew ?? 0) <= 1; m++) runMonths(g, 0.5);
    expect(ind.crew ?? 0).toBeGreaterThan(1);
    expect(g.enterprises.staff(ind)).toBeGreaterThan(0.05);
    // Рабочие проезд не оплачивают: у линии в один конец выручки нет, только содержание.
    expect(line.revenueLast + line.revenueMonth).toBe(0);
    expect(g.money).toBeLessThan(money);
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
});

describe('места в черте города', () => {
  it('пустует 12 мин — город строит сам невредный завод в черте', () => {
    const g = player({ size: 'medium', towns: 8 });
    const t = g.towns.find((x) => townSlots(x) > townIndustries(x, g.towns, g.industries).length)!;
    const before = townIndustries(t, g.towns, g.industries).length;
    runMonths(g, ENTERPRISE.slots.idleMonths - 1);
    expect(townIndustries(t, g.towns, g.industries).length).toBe(before);
    runMonths(g, 1);
    const after = townIndustries(t, g.towns, g.industries);
    expect(after.length).toBe(before + 1);
    const fresh = after.find((i) => i.builtBy === 'town')!;
    expect(harmClass(fresh.info.kind)).toBe(0);
    expect(inTown(t, fresh.fp)).toBe(true);
    expect(footprintRadius(fresh.fp)).toBeGreaterThan(0);
  });
});

/** Для отладки: что за предприятия. */
export const describeIndustries = (g: Game) => g.industries.map((i: Industry) => `${i.info.kind}${i.ruin ? '(R)' : ''}`).join(',');
