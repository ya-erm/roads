import { describe, expect, it } from 'vitest';
import { Game } from '../game/game';
import { withoutCitizens } from '../game/testkit';
import { fits, prepareSettings, scenarioTowns } from '../scenario/generator';
import { ARCHETYPE_LIST } from '../scenario/content';
import type { ArchetypeId } from '../scenario/types';
import { stepTowns, withSeed, withSize } from '../ui/newGame';
import { DEFAULT_SETTINGS, type MapSize, NEW_GAME_SETTINGS, TOWN_RANGE, townCount, townLimits, type WorldSettings } from './settings';

const SIZES: MapSize[] = ['small', 'medium', 'large'];

const scenario = (size: MapSize, seed: number, pick: ArchetypeId): WorldSettings => ({
  ...NEW_GAME_SETTINGS,
  size,
  seed,
  relief: 'hills',
  scenario: { difficulty: 'normal', challenge: false, pick },
});

describe('Число городов по размеру карты (TOWN_RANGE)', () => {
  it('новая партия: сколько бы ни просили, генератор ставит в пределах размера; старая — как в настройках', () => {
    for (const size of SIZES) {
      const r = TOWN_RANGE[size];
      expect(r.min).toBeLessThanOrEqual(r.base);
      expect(r.base).toBeLessThanOrEqual(r.max);
      expect(townCount({ ...NEW_GAME_SETTINGS, size, towns: 20 })).toBe(r.max);
      expect(townCount({ ...NEW_GAME_SETTINGS, size, towns: 1 })).toBe(r.min);
      expect(townLimits({ size, mapScale: NEW_GAME_SETTINGS.mapScale })).toEqual(r);
      // Старое сохранение и мир по seed без масштаба — прежние 10 (или сколько в настройках).
      expect(townCount({ ...DEFAULT_SETTINGS, size })).toBe(DEFAULT_SETTINGS.towns);
      expect(townCount({ ...DEFAULT_SETTINGS, size, towns: 17 })).toBe(17);
      expect(townLimits({ size })).toEqual({ min: 4, max: 20 });
    }
    expect(TOWN_RANGE.small).toMatchObject({ min: 4, max: 6 });
    expect(TOWN_RANGE.medium).toMatchObject({ min: 6, max: 9 });
    expect(TOWN_RANGE.large).toMatchObject({ min: 9, max: 13 });
    expect(TOWN_RANGE.medium.base).toBe(NEW_GAME_SETTINGS.towns);
  });

  it('сценарий: каждый архетип просит не больше, чем помещается на карту; «Разрозненные» на маленькой — 6, а не 9', () => {
    for (const size of SIZES) {
      for (const a of ARCHETYPE_LIST) {
        const n = prepareSettings(scenario(size, 1, a.id)).towns;
        expect(n, `${size} ${a.id}`).toBeGreaterThanOrEqual(TOWN_RANGE[size].min);
        expect(n, `${size} ${a.id}`).toBeLessThanOrEqual(TOWN_RANGE[size].max);
      }
    }
    expect(prepareSettings(scenario('small', 1, 'scattered')).towns).toBe(6);
    // Старая партия (без масштаба) — прежнее число: 7 × 1,3.
    expect(scenarioTowns({ size: 'small' }, 1.3)).toBe(9);
  });

  it('«Разрозненные» подходят маленькой карте с 6 городами далеко друг от друга, а не только с 7+ (их там не бывает)', () => {
    const r = { population: 9000, towns: 6, bigTowns: 1, spacing: 2700, compactChains: 0, hubIndustries: 0, closeBigPairs: 0 };
    const small = { size: 'small' as const, mapScale: NEW_GAME_SETTINGS.mapScale };
    expect(fits('scattered', r, small)).toBe(true);
    expect(fits('scattered', { ...r, spacing: 2300 }, small)).toBe(false);
    expect(fits('scattered', { ...r, towns: 4 }, small)).toBe(false);
    // Старая карта — прежнее правило: от 7 городов дальше 2 км.
    expect(fits('scattered', r, { size: 'small' })).toBe(false);
    expect(fits('scattered', { ...r, towns: 7, spacing: 2100 }, { size: 'small' })).toBe(true);
  });

  it('окно «Новая игра»: размер карты и «−/+» держат число городов в пределах', () => {
    const d = withSeed({ ...NEW_GAME_SETTINGS }, 5);
    expect(d.towns).toBe(TOWN_RANGE.medium.base);
    // Обычное число — обычное и у другого размера.
    expect(withSize(d, 'small').towns).toBe(TOWN_RANGE.small.base);
    expect(withSize(d, 'large').towns).toBe(TOWN_RANGE.large.base);
    // Выбранное игроком — ближайшее допустимое.
    const many = stepTowns(d, 1);
    expect(many.towns).toBe(9);
    expect(stepTowns(many, 1).towns).toBe(9);
    expect(withSize(many, 'small').towns).toBe(TOWN_RANGE.small.max);
    expect(stepTowns(withSize(d, 'small'), -5).towns).toBe(TOWN_RANGE.small.min);
    // После старой партии на 14 городов — не больше, чем помещается.
    expect(withSeed({ ...DEFAULT_SETTINGS, towns: 14 }, 7).towns).toBe(TOWN_RANGE.medium.max);
  });

  // Мир по seed: песочница с наибольшим запросом и два крайних архетипа — самый густой и самый редкий. Маленькая
  // карта — на двух seed, средняя и большая (генерация в разы дольше) — на одном, у каждой свой: seed всё равно разные.
  const SEEDS: Record<MapSize, number[]> = { small: [3, 11], medium: [11], large: [3] };
  for (const size of SIZES) {
    it(`мир «${size}»: городов ${TOWN_RANGE[size].min}–${TOWN_RANGE[size].max} на разных seed, в песочнице и сценариях`, () => {
      const counts: string[] = [];
      for (const seed of SEEDS[size]) {
        const worlds: [string, WorldSettings][] = [
          ['песочница 20', { ...NEW_GAME_SETTINGS, size, seed, towns: 20, relief: 'hills' }],
          ['разрозненные', scenario(size, seed, 'scattered')],
          ['агломерация', scenario(size, seed, 'agglomeration')],
        ];
        for (const [name, s] of worlds) {
          const n = withoutCitizens(new Game(s)).towns.length;
          counts.push(`${name} ${seed}: ${n}`);
          expect(n, counts.join(', ')).toBeGreaterThanOrEqual(TOWN_RANGE[size].min);
          expect(n, counts.join(', ')).toBeLessThanOrEqual(TOWN_RANGE[size].max);
        }
      }
    }, 120_000);
  }
});
