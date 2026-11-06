import { describe, expect, it } from 'vitest';
import {
  cellWidth,
  counterSlots,
  countInt,
  countShort,
  digitWidth,
  HUD_BADGE,
  HUD_DANGER,
  HUD_GAP,
  HUD_ICON,
  HUD_INK,
  HUD_PAD,
  hudLayout,
  moneyColor,
  moneyShort,
  splitDate,
  tabText,
  widestValues,
} from './timelapseHud';

/** Шрифт с пропорциональными цифрами: «1» узкая, остальные разной ширины. */
const W: Record<string, number> = { '0': 7, '1': 4, '2': 7, '3': 7, '4': 8, '5': 7, '6': 7, '7': 6, '8': 7, '9': 7, ' ': 3, ' ': 3, ',': 3, '.': 3, $: 7, '−': 8 };
const measure = (s: string) => [...s].reduce((a, ch) => a + (W[ch] ?? 9), 0);
const digit = digitWidth(measure);
const tab = (s: string) => tabText(s, measure, digit).width;
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** Все значения, что покажет проигрыватель: кадры и плавный переход между соседними. */
function shown(values: number[], steps = 200): number[] {
  const out = [...values];
  for (let i = 1; i < values.length; i++) for (let s = 1; s < steps; s++) out.push(lerp(values[i - 1], values[i], s / steps));
  return out;
}

describe('Плашка таймлапса: форматы', () => {
  it('деньги — знаков после запятой всегда поровну', () => {
    expect(moneyShort(9870)).toBe('$9 870');
    expect(moneyShort(-226_000)).toBe('−$226 тыс.');
    expect(moneyShort(1_870_000)).toBe('$1,87 млн');
    expect(moneyShort(1_800_000)).toBe('$1,80 млн');
    expect(moneyShort(15_000_000)).toBe('$15,0 млн');
    expect(moneyShort(150_000_000)).toBe('$150 млн');
  });

  it('деньги в минусе — красным, как баланс в интерфейсе (--danger)', () => {
    expect(HUD_DANGER).toBe('#e8483f');
    expect(moneyColor(-226_000)).toBe(HUD_DANGER);
    expect(moneyColor(-9_800)).toBe(HUD_DANGER);
    expect(moneyColor(0)).toBe(HUD_INK);
    expect(moneyColor(1_870_000)).toBe(HUD_INK);
    expect(moneyColor(-5, 'red')).toBe('red');
    // Красное — ровно то, что написано с минусом, в том числе «−$0» при долях доллара.
    for (const n of [-1e8, -12_345, -0.3, 0, 0.3, 9_999, 1e8]) expect(moneyColor(n) === HUD_DANGER).toBe(moneyShort(n).startsWith('−'));
  });

  it('жители и целые', () => {
    expect(countShort(9870)).toBe('9 870');
    expect(countShort(43_800)).toBe('43,8 тыс.');
    expect(countShort(50_000)).toBe('50,0 тыс.');
    expect(countShort(120_400)).toBe('120 тыс.');
    expect(countShort(1_250_000)).toBe('1,25 млн');
    expect(countInt(41.6)).toBe('42');
  });

  it('дата делится на месяц и год', () => {
    expect(splitDate('Мар 2003')).toEqual(['Мар', '2003']);
    expect(splitDate('Мар')).toEqual(['Мар', '']);
  });
});

describe('Плашка таймлапса: табличные цифры', () => {
  it('у чисел с одним числом цифр — одна ширина', () => {
    expect(digit).toBe(8);
    expect(tab('11')).toBe(tab('48'));
    expect(tab('$1,11 млн')).toBe(tab('$9,48 млн'));
    expect(tab('Мар 2011')).toBe(tab('Мар 2000'));
  });

  it('цифра — по центру своей ячейки, остальное — следом', () => {
    expect(tabText('$1 тыс.', measure, digit).parts).toEqual([
      { text: '$', x: 0 },
      { text: '1', x: 7 + (8 - 4) / 2 },
      { text: ' тыс.', x: 7 + 8 },
    ]);
  });
});

describe('Плашка таймлапса: ширина ячеек', () => {
  it('места перед сменой разряда — только внутри диапазона', () => {
    const v = widestValues(500, 12_000);
    expect(v).toContain(1000);
    expect(v).toContain(10_000);
    expect(v.some((x) => x > 9999.99 && x < 10_000)).toBe(true);
    expect(v.every((x) => x >= 500 && x <= 12_000)).toBe(true);
    expect(widestValues(-300, 50)).toContain(0);
  });

  it('ячейка вмещает любое число партии, в том числе между кадрами', () => {
    const series: [number[], (n: number) => string][] = [
      [[500_000, 120_000, -226_000, 69_000, 1_870_000, 7_860_000, 15_000_000, 9_400, 140_000_000], moneyShort],
      [[0, 3, 10, 9, 23, 28, 104], countInt],
      [[1200, 9_980, 43_800, 99_960, 120_000, 999_700, 1_200_000], countShort],
    ];
    for (const [values, format] of series) {
      const w = cellWidth(values, format, tab);
      const widest = Math.max(...shown(values).map((v) => tab(format(v))));
      expect(widest).toBeLessThanOrEqual(w);
      // Не с запасом «на всякий случай»: ровно под самую длинную строку партии.
      expect(w).toBeLessThanOrEqual(Math.max(...values.map((v) => tab(format(v)))) + 2 * digit);
    }
  });

  it('ячейка денег — под самую длинную строку, не под последнюю', () => {
    // −$226 тыс. длиннее, чем $15,0 млн в конце партии.
    const w = cellWidth([-226_000, 15_000_000], moneyShort, tab);
    expect(w).toBeGreaterThanOrEqual(tab('−$226 тыс.'));
    expect(w).toBeGreaterThan(tab('$15,0 млн'));
  });
});

describe('Плашка таймлапса: раскладка на всю партию', () => {
  const dates = ['Янв 1960', 'Май 1960', 'Июн 1960', 'Сен 1961', 'Дек 1963'];
  const columns = [
    { values: [500_000, -226_000, 15_000_000], format: moneyShort },
    { values: [0, 28], format: countInt },
    { values: [0, 217], format: countInt },
    { values: [30_000, 69_400], format: countShort },
  ];

  it('год всегда на одном месте — за самым длинным месяцем', () => {
    const L = hudLayout({ dates, columns, phase: false }, measure, measure);
    for (const d of dates) {
      const [month, year] = splitDate(d);
      expect(measure(month) + measure(' ')).toBeLessThanOrEqual(L.yearX);
      expect(L.yearX + tabText(year, measure, L.dateDigit).width).toBeLessThanOrEqual(L.dateW);
    }
  });

  it('ширина плашки — под ячейки всех счётчиков и дату со значком этапа', () => {
    const L = hudLayout({ dates, columns, phase: true }, measure, measure);
    const row = L.cells.reduce((a, c) => a + HUD_ICON + c, 0) + HUD_GAP * 3;
    expect(L.boxW).toBe(Math.max(row, L.dateW + HUD_BADGE) + HUD_PAD * 2);
    expect(L.cells).toHaveLength(4);
    expect(L.cells[0]).toBeGreaterThanOrEqual(tab('−$226 тыс.'));
    expect(L.cells[2]).toBe(3 * digit);
  });

  it('не зависит от порядка кадров — считается один раз на партию', () => {
    const a = hudLayout({ dates, columns, phase: false }, measure, measure);
    const b = hudLayout({ dates: [...dates].reverse(), columns: columns.map((c) => ({ ...c, values: [...c.values].reverse() })), phase: false }, measure, measure);
    expect(b).toEqual(a);
  });

  it('число — вплотную к значку, запас ячейки — справа до следующего значка', () => {
    const L = hudLayout({ dates, columns, phase: false }, measure, measure);
    const slots = counterSlots(L.cells);
    expect(slots).toHaveLength(4);
    expect(slots[0].icon).toBe(0);
    slots.forEach((s, n) => {
      // Текст начинается сразу за значком, как бы коротко ни было число.
      expect(s.text).toBe(s.icon + HUD_ICON);
      // Следующий значок — после самой длинной строки этого счётчика: ничего не наезжает и не сдвигается.
      if (n + 1 < slots.length) expect(slots[n + 1].icon).toBe(s.text + L.cells[n] + HUD_GAP);
    });
    // Последняя ячейка кончается у правого поля плашки (или раньше, если дата шире).
    const last = slots[3].text + L.cells[3];
    expect(last + HUD_PAD * 2).toBeLessThanOrEqual(L.boxW);
  });
});
