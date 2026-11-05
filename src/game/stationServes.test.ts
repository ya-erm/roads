import { describe, expect, it } from 'vitest';
import { dist } from '../core/vec';
import type { Industry, Station, StationServes } from '../world/entities';
import { Game } from './game';
import { stationAtIndustry, townStreets } from './testkit';

const PAX: StationServes = { pax: true, cargo: false };

/** Станция вплотную к предприятию с выбранным «с чем работает» — как в инструменте «Станция». */
function dockAt(game: Game, ind: Industry, serves: StationServes): Station | null {
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const reach = Math.hypot(ind.fp.w, ind.fp.h) / 2 + 20;
    const p = { x: ind.fp.center.x + Math.cos(a) * reach, y: ind.fp.center.y + Math.sin(a) * reach };
    const st = game.placeStation(p, 14, 'road', serves);
    if (st) return st;
  }
  return null;
}

/** Сырьевое предприятие вдали от городов — рядом с его станцией никто не живёт. */
function remoteMine(game: Game): Industry {
  const far = game.industries.filter(
    (i) => i.info.accepts.length === 0 && game.towns.every((t) => dist(t.center, i.fp.center) > (t.extent ?? t.radius) + 500),
  );
  expect(far.length).toBeGreaterThan(0);
  return far[0];
}

describe('Станция у предприятия', () => {
  it('выбран автовокзал, а станция у предприятия без жителей — ставится грузовой, с заметкой и записью в журнале', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const mine = remoteMine(game);
    const st = dockAt(game, mine, PAX)!;
    expect(st).toBeTruthy();
    expect(st.serves).toEqual({ pax: false, cargo: true });
    expect(st.industryIds).toContain(mine.id);
    const entry = game.journal.entries.find((e) => e.k === 'station' && e.id === st.id)!;
    expect(entry.serves).toBe('груз');
    expect(entry.auto).toBe('груз');
    expect(game.notices.some((n) => n.text.includes('работает с грузом'))).toBe(true);
  });

  it('подпись инструмента знает заранее, какой станция получится', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const mine = remoteMine(game);
    const reach = Math.hypot(mine.fp.w, mine.fp.h) / 2 + 20;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      const p = { x: mine.fp.center.x + Math.cos(a) * reach, y: mine.fp.center.y + Math.sin(a) * reach };
      const plan = game.stationPlan(p, 14, 'road');
      if (!plan.ok || !plan.fp) continue;
      expect(game.stationServesFor(plan.fp, 'road', plan.industryId, PAX)).toEqual({ pax: false, cargo: true });
      // Грузовую и смешанную не трогаем, остановка — всегда пассажирская.
      expect(game.stationServesFor(plan.fp, 'road', plan.industryId, { pax: true, cargo: true })).toEqual({ pax: true, cargo: true });
      expect(game.stationServesFor(plan.fp, 'stop', plan.industryId, PAX)).toEqual(PAX);
      return;
    }
    throw new Error('не нашлось места для станции у рудника');
  });

  it('автовокзал на улице города остаётся пассажирским', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    let st: Station | null = null;
    for (const seg of townStreets(game, town.id)) {
      const p = seg.lut.pointAt(seg.length / 2);
      const t = seg.lut.tangentAt(seg.length / 2);
      st = game.placeStation({ x: p.x - t.y * 40, y: p.y + t.x * 40 }, 14, 'road', PAX);
      if (st) break;
    }
    expect(st).toBeTruthy();
    expect(st!.catchPop).toBeGreaterThan(0);
    expect(st!.serves).toEqual(PAX);
    expect(game.journal.entries.find((e) => e.k === 'station' && e.id === st!.id)?.auto).toBeUndefined();
  });

  it('грузовой маршрут через станцию без груза — остановка помечена, включили груз — пометка ушла', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const farm = game.industries.find((i) => i.info.kind === 'farm')!;
    const plant = game.industries
      .filter((i) => i.info.accepts.includes(farm.info.produces))
      .sort((a, b) => dist(a.fp.center, farm.fp.center) - dist(b.fp.center, farm.fp.center))[0];
    const sA = stationAtIndustry(game, farm, plant.fp.center)!;
    const sB = stationAtIndustry(game, plant, farm.fp.center)!;
    const line = game.createLine([sA.id, sB.id])!;
    expect(game.lineKind(line)).toBe('freight');
    expect(game.stopMissing(line, 0)).toBeNull();
    // Как с рудником в партии: станция погрузки переключена на пассажиров, грузовики ждут груз, которого не будет.
    game.setStationServes(sA.id, PAX);
    game.buyVehicle(line.id, 'truck');
    expect(game.stopMissing(line, 0)).toBe('cargo');
    expect(game.stopMissing(line, 1)).toBeNull();
    game.setStationServes(sA.id, { pax: true, cargo: true });
    expect(game.stopMissing(line, 0)).toBeNull();
  });
});
