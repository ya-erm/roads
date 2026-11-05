import { describe, expect, it } from 'vitest';
import { ECONOMY } from '../config';
import { Game } from '../game/game';
import { roadPlan } from '../game/testkit';
import { failText, money, NO_MONEY, riseLabel, signedMetres, structureHeightText } from './labels';

describe('Подписи стройки', () => {
  it('метры со знаком: выше — плюс, ниже — типографский минус, ноль — ±', () => {
    expect(signedMetres(14)).toBe('+14 м');
    expect(signedMetres(-4)).toBe('−4 м');
    expect(signedMetres(0)).toBe('±0 м');
    // Округляем до метра; «минус ноль» — тоже ноль.
    expect(signedMetres(11.6)).toBe('+12 м');
    expect(signedMetres(-0.3)).toBe('±0 м');
  });

  it('приписка к высоте у курсора — только когда высоту конца задали −/+', () => {
    expect(riseLabel(null)).toBeNull();
    expect(riseLabel(undefined)).toBeNull();
    expect(riseLabel(6)).toBe('+6 м');
    expect(riseLabel(-4)).toBe('−4 м');
    expect(riseLabel(0)).toBe('±0 м');
  });

  it('над мостом — высота и полотна, и земли под ним, без «+N м» (так подписан подъём −/+)', () => {
    expect(structureHeightText(67.4, 55.2)).toBe('высота моста 67 м · земля 55 м');
    expect(structureHeightText(76, 55, 'flyover')).toBe('высота эстакады 76 м · земля 55 м');
    // Ниже уровня воды — типографский минус, как в «высота −12 м».
    expect(structureHeightText(3, -5)).toBe('высота моста 3 м · земля −5 м');
    expect(structureHeightText(8, -0.2)).toBe('высота моста 8 м · земля 0 м');
    expect(structureHeightText(67, 55)).not.toMatch(/\+/);
  });

  it('над тоннелем — так же: высота полотна тоннеля и земли над ним; тоннель ниже воды — с минусом', () => {
    expect(structureHeightText(16.3, 41, 'tunnel')).toBe('высота тоннеля 16 м · земля 41 м');
    expect(structureHeightText(-8, 2, 'tunnel')).toBe('высота тоннеля −8 м · земля 2 м');
    expect(structureHeightText(16, 41, 'tunnel')).not.toMatch(/\+/);
  });

  it('не хватает денег — в подписи полная цена стройки', () => {
    expect(failText(NO_MONEY, 12_345)).toBe(`${NO_MONEY} · ${money(12_345)}`);
  });

  it('другая причина — как есть, без причины — запасная надпись', () => {
    expect(failText('Пересекает здание', 12_345)).toBe('Пересекает здание');
    expect(failText(undefined, 100, 'Нельзя')).toBe('Нельзя');
    expect(failText(undefined, 100, '')).toBe('');
    // Цена неизвестна — только причина.
    expect(failText(NO_MONEY, undefined)).toBe(NO_MONEY);
  });

  it('план дороги без денег: причина та, что ждёт подпись, и цена посчитана', () => {
    const game = new Game({ seed: 3, size: 'small', towns: 1, industries: 'few', money: 0, water: 'dry' });
    game.money = ECONOMY.creditLimit + 10;
    // Ищем сухое место, где дорога упирается только в деньги.
    let plan = null;
    for (let y = 300; y < game.terrain.height - 300 && !plan; y += 97) {
      for (let x = 300; x < game.terrain.width - 600 && !plan; x += 97) {
        const p = roadPlan(game, { free: { x, y } }, { free: { x: x + 300, y } });
        if (p.reason === NO_MONEY) plan = p;
      }
    }
    expect(plan).not.toBeNull();
    expect(plan!.cost).toBeGreaterThan(game.budget);
    expect(failText(plan!.reason, plan!.cost)).toBe(`${NO_MONEY} · ${money(plan!.cost)}`);
  });
});
