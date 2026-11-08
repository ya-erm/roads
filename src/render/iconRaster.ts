/**
 * Значки (SVG-картинки грузов, src/ui/cargoIcons.ts) на канвасе — готовым растром. SVG-картинка при каждом drawImage
 * заново раскладывается и рисуется браузером (свой Layout и Paint на каждый значок), а значков в кадре десятки:
 * подписи предприятий, плашки станций, мини-карта. Растр же копируется как обычная картинка.
 *
 * Растр — квадрат степени двойки, не меньше нужного размера в пикселях холста (iconBucket): на экране он только
 * уменьшается, и не больше чем вдвое — значок такой же чёткий, а растров на картинку — считаные штуки.
 */

/** Наименьший и наибольший растр значка, px. */
export const ICON_MIN_PX = 16;
export const ICON_MAX_PX = 256;

/** Размер растра для значка в px пикселей холста: степень двойки не меньше px (в пределах ICON_MIN_PX…ICON_MAX_PX). */
export function iconBucket(px: number): number {
  if (!(px > ICON_MIN_PX)) return ICON_MIN_PX;
  if (px >= ICON_MAX_PX) return ICON_MAX_PX;
  return 2 ** Math.ceil(Math.log2(px));
}

/** Холст растра: size × size, с контекстом для рисования. */
export type RasterCanvas = { width: number; height: number; getContext(id: '2d'): { drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number): void } | null };

/** Холст растра по умолчанию — в документе; без документа (тесты в node) — нет. */
function documentCanvas(size: number): RasterCanvas | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

const rasters = new WeakMap<object, Map<number, CanvasImageSource>>();

/**
 * Что рисовать вместо картинки img размером px пикселей холста: её растр нужного размера (один раз на картинку и
 * размер). Картинка ещё не загрузилась или холста нет — сама картинка (её и нарисуют, как раньше).
 */
export function iconRaster(img: HTMLImageElement, px: number, make: (size: number) => RasterCanvas | null = documentCanvas): CanvasImageSource {
  if (!img.complete || !img.naturalWidth) return img;
  const size = iconBucket(px);
  let bySize = rasters.get(img);
  if (!bySize) rasters.set(img, (bySize = new Map()));
  const ready = bySize.get(size);
  if (ready) return ready;
  const c = make(size);
  const g = c?.getContext('2d');
  if (!c || !g) return img;
  g.drawImage(img, 0, 0, size, size);
  const out = c as unknown as CanvasImageSource;
  bySize.set(size, out);
  return out;
}
