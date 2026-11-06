/**
 * Плашка таймлапса (дата и счётчики на холсте) — раскладка одна на всю партию, чтобы ничего не дёргалось:
 * у даты и каждого счётчика ячейка фиксированной ширины — под самую длинную строку за всю партию, цифры —
 * табличные (каждая в ячейке ширины самой широкой цифры). Чистые функции: текст меряет переданный `measure`.
 */

/** Ширина строки в px (в проигрывателе — ctx.measureText нужным шрифтом). */
export type Measure = (text: string) => number;

/** Поля плашки, px. */
export const HUD_PAD = 12;
/** Значок счётчика с отступом до числа, px. */
export const HUD_ICON = 18;
/** Между счётчиками, px. */
export const HUD_GAP = 14;
/** Значок этапа сценария справа от даты, px. */
export const HUD_BADGE = 30;

const fixed = (x: number, digits: number) => x.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Деньги коротко: «$9 870», «$226 тыс.», «$1,87 млн», «$15,0 млн». Знаков после запятой — всегда поровну, без обрезки нулей. */
export function moneyShort(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? '−' : '';
  if (a >= 1e6) return `${s}$${fixed(a / 1e6, a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)} млн`;
  if (a >= 1e4) return `${s}$${Math.round(a / 1e3).toLocaleString('ru-RU')} тыс.`;
  return `${s}$${Math.round(a).toLocaleString('ru-RU')}`;
}

/** Жители коротко: «9 870», «43,8 тыс.», «120 тыс.», «1,25 млн». */
export function countShort(n: number): string {
  if (n >= 1e6) return `${fixed(n / 1e6, 2)} млн`;
  if (n >= 1e4) return `${fixed(n / 1e3, n >= 1e5 ? 0 : 1)} тыс.`;
  return Math.round(n).toLocaleString('ru-RU');
}

/** Целое: маршруты, транспорт. */
export const countInt = (n: number): string => String(Math.round(n));

const isDigit = (ch: string) => ch >= '0' && ch <= '9';

/** Ширина самой широкой цифры — ячейка табличной цифры. */
export function digitWidth(measure: Measure): number {
  let w = 0;
  for (let d = 0; d <= 9; d++) w = Math.max(w, measure(String(d)));
  return w;
}

/** Текст, разложенный для рисования: x — левый край куска от начала строки. */
export interface TabText {
  parts: { text: string; x: number }[];
  width: number;
}

/** Табличные цифры: каждая цифра — по центру ячейки ширины digit, остальное — кусками как есть. */
export function tabText(text: string, measure: Measure, digit: number): TabText {
  const parts: TabText['parts'] = [];
  let x = 0;
  let run = '';
  const flush = () => {
    if (!run) return;
    parts.push({ text: run, x });
    x += measure(run);
    run = '';
  };
  for (const ch of text) {
    if (!isDigit(ch)) {
      run += ch;
      continue;
    }
    flush();
    parts.push({ text: ch, x: x + (digit - measure(ch)) / 2 });
    x += digit;
  }
  flush();
  return { parts, width: x };
}

/**
 * Значения из [lo, hi], на которых строка счётчика может быть самой длинной: края, ноль и места перед сменой
 * разряда (9 999,9…, 99 999,9…). Внутри разряда строка с табличными цифрами не длиннее, чем у его верхнего края.
 */
export function widestValues(lo: number, hi: number): number[] {
  const out = [lo, hi];
  if (lo <= 0 && hi >= 0) out.push(0);
  for (let k = 0; k <= 15; k++) {
    const p = 10 ** k;
    for (const v of [p, p * (1 - 1e-9), -p, -p * (1 - 1e-9)]) if (v > lo && v < hi) out.push(v);
  }
  return out;
}

/** Ширина ячейки счётчика: самая длинная строка за всю партию — по кадрам и между ними (числа меняются плавно). */
export function cellWidth(values: number[], format: (n: number) => string, width: Measure): number {
  if (!values.length) return width(format(0));
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const seen = new Set<string>();
  let w = 0;
  for (const v of widestValues(lo, hi)) {
    const s = format(v);
    if (seen.has(s)) continue;
    seen.add(s);
    w = Math.max(w, width(s));
  }
  return w;
}

/** «Мар 2003» → месяц и год. */
export function splitDate(date: string): [string, string] {
  const i = date.lastIndexOf(' ');
  return i < 0 ? [date, ''] : [date.slice(0, i), date.slice(i + 1)];
}

export interface HudSeries {
  /** Все даты партии («Мар 2003»). */
  dates: string[];
  /** Счётчики по порядку: значения по кадрам и как их писать. */
  columns: { values: number[]; format: (n: number) => string }[];
  /** Есть ли этапы сценария (место под значок этапа). */
  phase: boolean;
}

export interface HudLayout {
  /** Ширина табличной цифры шрифта даты и шрифта счётчиков. */
  dateDigit: number;
  numDigit: number;
  /** Год — с этого места от начала даты (за самым длинным месяцем), всегда на одном месте. */
  yearX: number;
  /** Ширина даты целиком. */
  dateW: number;
  /** Ширина чисел каждого счётчика (без значка). */
  cells: number[];
  /** Ширина плашки. */
  boxW: number;
}

/** Раскладка плашки на всю партию: dateMeasure — шрифт даты, numMeasure — шрифт счётчиков. */
export function hudLayout(series: HudSeries, dateMeasure: Measure, numMeasure: Measure): HudLayout {
  const dateDigit = digitWidth(dateMeasure);
  const numDigit = digitWidth(numMeasure);
  let monthW = 0;
  let yearW = 0;
  for (const d of new Set(series.dates)) {
    const [month, year] = splitDate(d);
    monthW = Math.max(monthW, dateMeasure(month));
    yearW = Math.max(yearW, tabText(year, dateMeasure, dateDigit).width);
  }
  const yearX = monthW + dateMeasure(' ');
  const dateW = yearX + yearW;
  const cells = series.columns.map((c) => cellWidth(c.values, c.format, (s) => tabText(s, numMeasure, numDigit).width));
  const row = cells.reduce((a, c) => a + HUD_ICON + c, 0) + HUD_GAP * Math.max(0, cells.length - 1);
  const boxW = Math.max(row, dateW + (series.phase ? HUD_BADGE : 0)) + HUD_PAD * 2;
  return { dateDigit, numDigit, yearX, dateW, cells, boxW };
}

/**
 * Где рисовать счётчики (от левого края строки): значок и число вплотную за ним — по левому краю ячейки.
 * Запас ячейки под длинные числа — справа, до следующего значка; значки от числа не зависят и стоят на месте.
 */
export function counterSlots(cells: number[]): { icon: number; text: number }[] {
  let x = 0;
  return cells.map((c) => {
    const slot = { icon: x, text: x + HUD_ICON };
    x += HUD_ICON + c + HUD_GAP;
    return slot;
  });
}
