/** У края прокручиваемой панели — полоса EDGE_PX, в ней при перетаскивании панель прокручивается. */
export const EDGE_PX = 56;
/** Быстрее всего, пикселей за кадр: у самого края и за ним. */
export const EDGE_MAX_STEP = 16;

/**
 * Автопрокрутка при перетаскивании: курсор на y у панели от top до bottom (экранные пиксели). У верхнего края —
 * вверх (отрицательный шаг), у нижнего — вниз; чем ближе к краю, тем быстрее, за краем (не дальше полосы) — быстрее
 * всего. Посередине и далеко за краем — 0.
 */
export function edgeScrollStep(y: number, top: number, bottom: number, edge = EDGE_PX, max = EDGE_MAX_STEP): number {
  const room = Math.min(edge, (bottom - top) / 3);
  if (room <= 0 || y < top - edge || y > bottom + edge) return 0;
  const speed = (into: number) => Math.round(max * Math.min(1, Math.max(0, 1 - into / room)));
  if (y < top + room) return -Math.max(1, speed(y - top));
  if (y > bottom - room) return Math.max(1, speed(bottom - y));
  return 0;
}
