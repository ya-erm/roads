import { describe, expect, it } from 'vitest';
import { upkeepRates, upkeepRateText, upkeepTip } from './upkeepText';

/** Числа ru-RU разделены неразрывным пробелом — в ожиданиях пишем обычный. */
const sp = (s: string) => s.replace(/[  ]/g, ' ');

describe('Темп содержания в HUD', () => {
  const f = { vehicles: 6_000, crews: 900, roads: 1_500, interest: 0, total: 8_400 };

  it('подсказка «За месяц»: с начала месяца, содержание — темпом в месяц по статьям значками', () => {
    expect(sp(upkeepTip(f))).toBe('Доходы минус расходы с начала месяца. Содержание списывается каждую секунду: −$8 400 в месяц (🚌 $6 000 · 🚚 $900 · 🛣 $1 500)');
    expect(upkeepRateText({ vehicles: 0, crews: 0, roads: 0, interest: 0, total: 0 })).toBe('Содержания нет');
  });

  it('темп по статьям отчёта: бригады — в «Содержании транспорта»', () => {
    expect(upkeepRates(f)).toEqual({ vehicles: 6_900, roads: 1_500, interest: 0 });
  });
});
