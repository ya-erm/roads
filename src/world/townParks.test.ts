import { describe, expect, it } from 'vitest';
import { Game, type SaveData } from '../game/game';
import { freshGame, runMonths, withoutCitizens } from '../game/testkit';
import { corridorHalf, recountPopulation } from './worldgen';
import { NEW_GAME_SETTINGS } from './settings';
import { footprintCorners, footprintsOverlap, pointInFootprint } from './spatial';
import { nearPark, onPark, parkQuota } from './townParks';
import { townTier } from './townForms';

describe('Парки и скверы городов', { timeout: 60_000 }, () => {
  it('сколько: в селе — сквер с памятником, в городе — парк, площадь и скверы, в большом — больше', () => {
    // Ярус — свой (Town.tier); население — по жильцам домов (село — 300–800).
    expect(parkQuota({ population: 400, style: 'linear', tier: 'village' })).toMatchObject({ park: 0, memorial: 1, plaza: 0, square: 0 });
    expect(parkQuota({ population: 700, style: 'linear', tier: 'village' })).toMatchObject({ park: 0, memorial: 1, plaza: 0, square: 1 });
    expect(parkQuota({ population: 3000, style: 'organic', tier: 'town' })).toMatchObject({ park: 1, memorial: 0, plaza: 1 });
    expect(parkQuota({ population: 9000, style: 'radial', tier: 'city' }).square).toBeGreaterThan(parkQuota({ population: 3000, style: 'organic', tier: 'town' }).square);
    expect(parkQuota({ population: 13000, style: 'radial', tier: 'city' }).park).toBe(2);
  });

  it('мир по seed: зелень — только на пустом месте (не на домах, строениях, дорогах и в воде), жителей столько же', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 1 });
    let parks = 0;
    for (const t of g.towns) {
      const pop = t.population;
      recountPopulation(t);
      expect(t.population).toBe(pop);
      const list = t.parks ?? [];
      parks += list.length;
      const kinds = new Set(list.map((p) => p.kind));
      if (townTier(t) === 'village') expect(kinds.has('memorial'), t.name).toBe(true);
      else expect(kinds.has('park'), t.name).toBe(true);
      for (const p of list) {
        expect(g.index.overlaps(p.fp, 0), `${t.name} ${p.kind}`).toBe(false);
        for (const q of list) if (q !== p) expect(footprintsOverlap(p.fp, q.fp, -1.3), `${t.name} ${p.kind}/${q.kind}`).toBe(false);
        // Дороги: ни одна точка оси полотна не внутри участка (с полушириной).
        for (const c of g.roads.net.corridorsNear(p.fp.center, Math.hypot(p.fp.w, p.fp.h) / 2 + 30)) {
          for (let s = 0; s <= c.length; s += 3) expect(pointInFootprint(c.lut.pointAt(s), p.fp, corridorHalf(c)), `${t.name} ${p.kind} на дороге`).toBe(false);
        }
        for (const q of [p.fp.center, ...footprintCorners(p.fp)]) expect(g.terrain.isWater(q), `${t.name} ${p.kind} в воде`).toBe(false);
      }
    }
    expect(parks).toBeGreaterThan(g.towns.length * 2);
  });

  it('по seed — те же парки: без генератора случайных чисел партии', () => {
    const a = new Game({ ...NEW_GAME_SETTINGS, seed: 3 });
    const b = new Game({ ...NEW_GAME_SETTINGS, seed: 3 });
    expect(b.towns.map((t) => t.parks)).toEqual(a.towns.map((t) => t.parks));
  });

  it('старое сохранение без парков: парки — при загрузке, на пустом месте, жителей столько же', () => {
    const g = freshGame({ ...NEW_GAME_SETTINGS, seed: 2 });
    const save = JSON.parse(JSON.stringify(g.toSave())) as SaveData;
    const pop = save.towns.map((t) => t.population);
    for (const t of save.towns) delete t.parks;
    const loaded = new Game(structuredClone(g.settings), save);
    expect(loaded.towns.map((t) => t.population)).toEqual(pop);
    expect(loaded.towns.every((t) => t.parks && t.parks.length > 0)).toBe(true);
    for (const t of loaded.towns) for (const p of t.parks!) expect(loaded.index.overlaps(p.fp, 0)).toBe(false);
    // Парки сохраняются: следующая загрузка их не переставляет.
    const again = new Game(structuredClone(g.settings), JSON.parse(JSON.stringify(loaded.toSave())) as SaveData);
    expect(again.towns.map((t) => t.parks)).toEqual(loaded.towns.map((t) => t.parks));
  });

  it('город растёт в обход парков: новые дома и улицы на них не встают', () => {
    const g = withoutCitizens(freshGame({ ...NEW_GAME_SETTINGS, seed: 1 }));
    const before = new Set(g.towns.flatMap((t) => t.buildings.map((b) => b.id)));
    runMonths(g, 12);
    let added = 0;
    for (const t of g.towns) {
      for (const b of t.buildings) {
        if (before.has(b.id)) continue;
        added++;
        expect(onPark(t, b.fp, 0), `${t.name}: дом ${b.id} на парке`).toBe(false);
      }
    }
    expect(added).toBeGreaterThan(20);
    // Улицы, проложенные городом за год, — не через парки: ни одна точка оси не внутри участка.
    for (const c of g.roads.net.corridors.values()) {
      for (let s = 0; s <= c.length; s += 3) expect(nearPark(g.towns, c.lut.pointAt(s), -1), `улица ${c.id} через парк`).toBe(false);
    }
  });
});
