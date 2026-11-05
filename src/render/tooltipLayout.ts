/**
 * Подсказка у курсора на карте: длинный текст переносится по словам в строки не шире maxWidth (короткий — одной
 * строкой), а сама плашка сдвигается внутрь экрана у правого и нижнего края.
 */

/** Ширина подсказки на карте, px: длиннее — перенос на следующую строку. */
export const TOOLTIP_MAX_PX = 300;

/** Переносит text по словам: строки не шире maxWidth (слово длиннее — отдельной строкой, не режем). */
export function wrapLines(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Где плашку w×h рисовать относительно курсора (sx, sy) на экране W×H: справа снизу от него; не помещается справа —
 * слева, снизу — сверху; и в любом случае не дальше margin от краёв.
 */
export function tooltipOffset(sx: number, sy: number, w: number, h: number, W: number, H: number, margin = 8): { x: number; y: number } {
  let x = sx + 16 + w > W - margin ? -16 - w : 16;
  let y = sy + 14 + h > H - margin ? -14 - h : 14;
  x = Math.max(margin - sx, Math.min(x, W - margin - w - sx));
  y = Math.max(margin - sy, Math.min(y, H - margin - h - sy));
  return { x, y };
}
