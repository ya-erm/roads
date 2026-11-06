/** Где стоит кнопка баг-репорта — без DOM, по прямоугольникам миникарты и панели инструментов. */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
}

/** Кнопка — квадрат size; запасное место, если миникарты нет (как у неё в CSS: 14 px от края, ширина 212). */
export const BUG_BUTTON = { size: 44, gap: 8, fallback: { right: 14 + 212 + 8, bottom: 14 } };

/**
 * Слева от миникарты, низом по её низу. В узком окне там уже панель инструментов (она по центру внизу) —
 * тогда кнопка поднимается над ней, оставаясь слева от миникарты. Отступы — от правого и нижнего края окна.
 */
export function bugButtonSpot(
  view: { w: number; h: number },
  minimap: Rect | null,
  toolbar: Rect | null,
  size = BUG_BUTTON.size,
  gap = BUG_BUTTON.gap,
): { right: number; bottom: number } {
  if (!minimap || !minimap.width) return { ...BUG_BUTTON.fallback };
  const right = Math.round(view.w - minimap.left + gap);
  let bottom = Math.round(view.h - minimap.bottom);
  const left = view.w - right - size;
  // Вплотную (несколько пикселей до панели) — ещё помещается; заходит на панель — поднимаемся.
  if (toolbar && toolbar.width && toolbar.right + 2 > left && toolbar.left < left + size) {
    bottom = Math.max(bottom, Math.round(view.h - toolbar.top + gap));
  }
  return { right, bottom };
}
