import { describe, expect, it } from 'vitest';
import { add, dist, scale, type Vec } from '../core/vec';
import type { Town, TownBuilding, TownPark } from '../world/entities';
import { lotClearOfRoads, lotOutline } from '../world/lotClear';
import { WALK_EDGE } from '../world/roadTypes';
import { plazaAttached } from '../world/townParks';
import { yardOf } from '../world/townForms';
import { halfAtS } from '../world/worldgen';
import { Game, type SaveData } from './game';
import { fieldSpot, freshGame, HIGHWAY, road, STREET } from './testkit';

/** Ратуша с площадью у неё — в самом крупном таком городе. */
function hallTown(game: Game): { town: Town; hall: TownBuilding; plaza: TownPark } {
  for (const town of [...game.towns].sort((a, b) => b.population - a.population)) {
    const hall = town.buildings.find((b) => b.kind === 'landmark' && yardOf(b) > 0);
    const plaza = town.parks?.find((p) => p.kind === 'plaza');
    if (hall && plaza) return { town, hall, plaza };
  }
  throw new Error('Нет ратуши с площадью');
}

/** Наименьший зазор от контура участка до края асфальта (halfAtS) всех полотен рядом, м. */
function asphaltGap(game: Game, fp: TownBuilding['fp']): number {
  let gap = Infinity;
  for (const q of lotOutline(fp, 1)) {
    for (const c of game.roads.net.corridorsNear(q, 120)) {
      const hit = c.lut.closest(q);
      gap = Math.min(gap, hit.d - halfAtS(c, hit.s));
    }
  }
  return gap;
}

/** Прямая улица 600 м в чистом поле (с запада на восток): точка у её середины с юга, в off м от оси. */
function fieldStreet(game: Game, profile = STREET): { from: Vec; to: Vec; beside: (off: number) => Vec } {
  const at = fieldSpot(game, 600, 260);
  const from = at;
  const to = add(at, { x: 600, y: 0 });
  expect(road(game, { free: from }, { free: to }, profile)).toBe(true);
  return { from, to, beside: (off) => add(at, { x: 300, y: off }) };
}

describe('перенос ратуши', () => {
  it('участок с площадью вокруг ратуши — за тротуаром, площадь у ратуши едет с ней', () => {
    const game = freshGame(42);
    game.money = 10_000_000;
    const { hall, plaza } = hallTown(game);
    expect(plazaAttached(hall.fp, plaza.fp)).toBe(true);
    const street = fieldStreet(game);
    const before = { hall: structuredClone(hall.fp), plaza: structuredClone(plaza.fp), gap: dist(hall.fp.center, plaza.fp.center) };
    const plan = game.movePlan(hall, street.beside(60));
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.plaza?.park).toBe(plaza);
    // Как клик в игре (controller): снимок для Ctrl+Z — перенос — итог.
    game.checkpoint('перенос здания');
    expect(game.moveBuilding(hall, street.beside(60))).toBe(true);
    game.commit();
    // Площадь вокруг ратуши (рисунок houseArt.hall) — не на асфальте и не на тротуаре.
    const yard = yardOf(hall);
    const lot = { ...hall.fp, w: hall.fp.w + yard * 2, h: hall.fp.h + yard * 2 };
    expect(asphaltGap(game, lot)).toBeGreaterThanOrEqual(WALK_EDGE);
    expect(lotClearOfRoads(game.roads.net, lot, WALK_EDGE)).toBe(true);
    // Как дома улиц при застройке: участок в 5 м от края асфальта.
    expect(asphaltGap(game, lot)).toBeCloseTo(5, 0);
    // Площадь — рядом с ратушей, с той же стороны и на том же расстоянии, что была; тот же парк — по id выбирается.
    expect(dist(hall.fp.center, before.hall.center)).toBeGreaterThan(100);
    expect(plazaAttached(hall.fp, plaza.fp)).toBe(true);
    expect(dist(hall.fp.center, plaza.fp.center)).toBeCloseTo(before.gap, 3);
    expect(plaza.fp.w).toBe(before.plaza.w);
    expect(game.parkAt(plaza.fp.center)?.park).toBe(plaza);
    expect(game.parkAt(before.plaza.center)?.park).not.toBe(plaza);
    expect(game.structureAt(hall.fp.center)?.id).toBe(hall.id);
    // Отмена — обе на прежних местах.
    expect(game.undo()).toBeTruthy();
    const back = game.buildingById(hall.id)!;
    expect(back.fp.center).toEqual(before.hall.center);
    expect(game.parkById(plaza.id)!.park.fp.center).toEqual(before.plaza.center);
  });

  it('площадь, оставшаяся на старом месте после прежнего переноса, возвращается к ратуше', () => {
    const game = freshGame(42);
    game.money = 10_000_000;
    const { hall, plaza } = hallTown(game);
    // Как в партии из отчёта: ратушу перенесли без площади (до исправления) — площадь далеко от неё.
    const street = fieldStreet(game);
    const far = street.beside(-400);
    game.index.remove(hall);
    hall.fp = { ...hall.fp, center: far };
    game.index.add(hall);
    expect(plazaAttached(hall.fp, plaza.fp)).toBe(false);
    const was = structuredClone(plaza.fp);
    expect(game.moveBuilding(hall, street.beside(60))).toBe(true);
    expect(plazaAttached(hall.fp, plaza.fp)).toBe(true);
    expect(dist(plaza.fp.center, was.center)).toBeGreaterThan(200);
    expect(lotClearOfRoads(game.roads.net, plaza.fp, WALK_EDGE)).toBe(true);
  });

  it('площадь, которую игрок перенёс отдельно, при переносе ратуши остаётся на месте', () => {
    const game = freshGame(42);
    game.money = 10_000_000;
    const { hall, plaza } = hallTown(game);
    const street = fieldStreet(game);
    expect(game.movePark(plaza.id, street.beside(-60))).toBe(true);
    expect(plaza.moved).toBe(true);
    const at = structuredClone(plaza.fp);
    const plan = game.movePlan(hall, street.beside(50));
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.plaza).toBeUndefined();
    expect(game.buildingMove(hall).plaza).toBeNull();
    expect(game.moveBuilding(hall, street.beside(50))).toBe(true);
    expect(plaza.fp).toEqual(at);
  });

  it('ратушу не втиснуть между двумя близкими улицами: площадь легла бы на дорогу', () => {
    const game = freshGame(42);
    game.money = 10_000_000;
    const { hall } = hallTown(game);
    const street = fieldStreet(game);
    // Вторая улица — в 60 м южнее: ратуша (70 м и площадь по 7 м) между ними не встаёт.
    expect(road(game, { free: add(street.from, { x: 0, y: 60 }) }, { free: add(street.to, { x: 0, y: 60 }) })).toBe(true);
    const plan = game.movePlan(hall, street.beside(20));
    expect(plan.ok).toBe(false);
    expect(game.moveBuilding(hall, street.beside(20))).toBe(false);
  });
});

describe('перенос парка', () => {
  /** Сквер (не площадь у ратуши и не набережная) — у самого крупного города. */
  function square(game: Game): TownPark {
    for (const t of [...game.towns].sort((a, b) => b.population - a.population)) {
      const p = t.parks?.find((k) => k.kind === 'square' || k.kind === 'park');
      if (p) return p;
    }
    throw new Error('Нет сквера');
  }

  it('сквер встаёт вдоль улицы за тротуаром, со всем, что внутри, и так же открывается из сохранения', () => {
    const game = freshGame(42);
    game.money = 10_000_000;
    const park = square(game);
    const street = fieldStreet(game);
    const money = game.money;
    const plan = game.parkMovePlan(park.id, street.beside(40));
    expect(plan.ok, plan.reason).toBe(true);
    expect(game.movePark(park.id, street.beside(40))).toBe(true);
    expect(game.money).toBe(money - plan.cost);
    expect(plan.cost).toBeGreaterThanOrEqual(1000);
    // Вдоль улицы: длинной стороной по ней, ближний край — за тротуаром.
    expect(Math.abs(Math.sin(park.fp.angle))).toBeLessThan(1e-6);
    expect(asphaltGap(game, park.fp)).toBeGreaterThanOrEqual(WALK_EDGE);
    expect(asphaltGap(game, park.fp)).toBeLessThan(WALK_EDGE + 2);
    expect(game.parkAt(park.fp.center)?.park).toBe(park);
    // Сохранение: парк — на новом месте и помечен перенесённым.
    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    const loaded = new Game(save.settings, save);
    const again = loaded.parkById(park.id)!.park;
    expect(again.fp).toEqual(park.fp);
    expect(again.moved).toBe(true);
  });

  it('старое сохранение без отметки переноса открывается с парками на прежних местах', () => {
    const game = freshGame(42);
    const park = square(game);
    const save = JSON.parse(JSON.stringify(game.toSave())) as SaveData;
    for (const t of save.towns) for (const k of t.parks ?? []) delete k.moved;
    const loaded = new Game(save.settings, save);
    expect(loaded.parkById(park.id)!.park.fp).toEqual(park.fp);
    expect(loaded.parkById(park.id)!.park.moved).toBeUndefined();
  });

  it('отказ: на дорогу, в воду, на дома; набережную не перенести', () => {
    const game = freshGame(42);
    game.money = 10_000_000;
    const park = square(game);
    // Шоссе — не улица, вдоль него парк не прилипает: серединой под курсор — прямо на полотно.
    const hw = fieldStreet(game, HIGHWAY);
    expect(game.parkMovePlan(park.id, hw.beside(0))).toMatchObject({ ok: false, reason: 'Мешает дорога' });
    // Вода — середина озера вдали от улиц.
    const lake = waterSpot(game, 12);
    expect(game.parkMovePlan(park.id, lake)).toMatchObject({ ok: false, reason: 'Мешает вода' });
    // Дома: курсор на домах города — поверх них парк не встаёт ни разу.
    const plans = game.towns
      .flatMap((t) => t.buildings)
      .filter((b) => b.kind === 'res')
      .slice(0, 20)
      .map((h) => game.parkMovePlan(park.id, h.fp.center));
    expect(plans.some((r) => r.reason === 'Мешают дома')).toBe(true);
    for (const r of plans) if (r.ok) expect(game.index.overlaps(r.fp!, 0)).toBe(false);
    const embankment = game.towns.flatMap((t) => t.parks ?? []).find((k) => k.kind === 'embankment');
    if (embankment) expect(game.parkMovePlan(embankment.id, hw.beside(60)).ok).toBe(false);
    const was = structuredClone(park.fp);
    expect(game.movePark(park.id, hw.beside(0))).toBe(false);
    expect(park.fp).toEqual(was);
  });
});

/** Точка на воде: круг r вокруг неё весь в воде и улиц рядом нет. */
function waterSpot(game: Game, r: number): Vec {
  const { width, height } = game.terrain;
  for (let y = 200; y < height - 200; y += 40) {
    for (let x = 200; x < width - 200; x += 40) {
      const p = { x, y };
      if (!game.isWater(p, 0)) continue;
      let all = true;
      for (let k = 0; k < 16 && all; k++) all = game.isWater(add(p, scale({ x: Math.cos(k / 2.5), y: Math.sin(k / 2.5) }, r)), 0);
      if (all && !game.roads.net.corridorsNear(p, r + 200).length) return p;
    }
  }
  throw new Error('Нет озера');
}
