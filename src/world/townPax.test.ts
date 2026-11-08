import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH, TOWN_TRAFFIC } from '../config';
import { addTownPax, closeTownPax, PAX_NOWHERE, PAX_PER_THOUSAND, paxSplit, townPaxWant } from './townPax';

describe('Пассажиры города по месяцам', () => {
  it('хотят ездить — сколько дал бы город, живи все у остановок; в другие города — доля поездок жителей', () => {
    const want = townPaxWant(2000);
    const total = 2 * PAX_PER_THOUSAND * MONTH_LENGTH;
    expect(want.city + want.intercity).toBe(Math.round(total));
    expect(want.intercity).toBe(Math.round(total * TOWN_TRAFFIC.intercityShare));
    // Вдвое больше жителей — вдвое больше желающих; сценарный множитель — так же, как у появления пассажиров.
    expect(townPaxWant(4000).city + townPaxWant(4000).intercity).toBe(2 * (want.city + want.intercity));
    expect(townPaxWant(2000, 1.5).intercity).toBe(Math.round(total * 1.5 * TOWN_TRAFFIC.intercityShare));
    expect(townPaxWant(0)).toEqual({ city: 0, intercity: 0 });
  });

  it('довезённые копятся по городу назначения, свой город — поездки по городу', () => {
    const town: { paxMonth?: Record<number, number>; paxLast?: Record<number, number> } = {};
    addTownPax(town, 1, 10);
    addTownPax(town, 2, 4);
    addTownPax(town, 1, 3);
    addTownPax(town, PAX_NOWHERE, 2);
    addTownPax(town, 3, 0);
    expect(town.paxMonth).toEqual({ 1: 13, 2: 4, [PAX_NOWHERE]: 2 });
    expect(paxSplit(1, town.paxMonth)).toEqual({ city: 13, intercity: 6 });
    expect(paxSplit(1, undefined)).toEqual({ city: 0, intercity: 0 });
  });

  it('конец месяца: этот месяц уходит в прошлый, пустой месяц прошлый очищает', () => {
    const town: { paxMonth?: Record<number, number>; paxLast?: Record<number, number> } = {};
    addTownPax(town, 2, 5);
    closeTownPax(town);
    expect(town.paxLast).toEqual({ 2: 5 });
    expect(town.paxMonth).toBeUndefined();
    closeTownPax(town);
    expect(town.paxLast).toBeUndefined();
    // Ключи после сохранения — строками (JSON): счёт тот же.
    expect(paxSplit(1, JSON.parse(JSON.stringify({ 1: 3, 2: 4 })))).toEqual({ city: 3, intercity: 4 });
  });
});
