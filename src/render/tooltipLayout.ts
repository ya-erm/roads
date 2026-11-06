/**
 * Свои подсказки — у курсора на карте и у элементов панелей ([data-tip]): длинный текст переносится по словам
 * (короткий — одной строкой), а плашка сдвигается внутрь экрана у его краёв.
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

/** Начало отрезка длиной size так, чтобы он целиком лёг в [margin, limit − margin] (не влезает — к началу). */
const inside = (start: number, size: number, limit: number, margin: number) => Math.max(margin, Math.min(start, limit - margin - size));

/**
 * Где плашку w×h рисовать относительно курсора (sx, sy) на экране W×H: справа снизу от него; не помещается справа —
 * слева, снизу — сверху; и в любом случае не дальше margin от краёв.
 */
export function tooltipOffset(sx: number, sy: number, w: number, h: number, W: number, H: number, margin = 8): { x: number; y: number } {
  const x = sx + 16 + w > W - margin ? -16 - w : 16;
  const y = sy + 14 + h > H - margin ? -14 - h : 14;
  return { x: inside(sx + x, w, W, margin) - sx, y: inside(sy + y, h, H, margin) - sy };
}

/** Прямоугольник элемента на экране (как у getBoundingClientRect). */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Где плашку w×h поставить у элемента r на экране W×H (левый верхний угол): над ним по центру (end — по его правому
 * краю); сверху места нет — под ним; у левого и правого края экрана — сдвинута внутрь, не ближе margin.
 */
export function tipPlacement(r: ScreenRect, w: number, h: number, W: number, H: number, end = false, gap = 6, margin = 6): { x: number; y: number } {
  const x = end ? r.right - w : (r.left + r.right) / 2 - w / 2;
  const above = r.top - gap - h;
  const y = above < margin && r.bottom + gap + h <= H - margin ? r.bottom + gap : above;
  return { x: inside(x, w, W, margin), y: inside(y, h, H, margin) };
}
