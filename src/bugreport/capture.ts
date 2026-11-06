/**
 * Снимок экрана игры для баг-репорта: карта (canvas) и панели поверх неё — как видит игрок.
 *
 * Готовой «фотографии вкладки» без разрешения у страницы нет, html2canvas в игре нет и не нужен: панели —
 * обычный DOM, и браузер сам вёрстывает его копию внутри SVG-картинки (foreignObject) со всеми стилями страницы.
 * Холсты внутри панелей (миникарта) копируются картинками, поля ввода — со значениями, прокрученные списки —
 * с той же прокруткой. Не передаётся только размытие под полупрозрачными окнами (backdrop-filter).
 * Если браузер не даёт прочитать такую картинку (так бывает в Safari), снимок — только карта: hud = false.
 */

export interface Shot {
  /** Пиксели снимка: width·scale × height·scale. */
  canvas: HTMLCanvasElement;
  /** Размер окна игры в точках экрана. */
  width: number;
  height: number;
  /** Пикселей на точку (плотность экрана, не больше 2). */
  scale: number;
  /** Панели сняты вместе с картой. */
  hud: boolean;
}

/**
 * Снимает экран: canvas игры и всё, что лежит поверх него в body, кроме того, что skip (кнопка отчёта, подсказка).
 */
export async function captureScreen(gameCanvas: HTMLCanvasElement, skip: (el: Element) => boolean): Promise<Shot> {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const out = document.createElement('canvas');
  out.width = Math.round(width * scale);
  out.height = Math.round(height * scale);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#b8c79a';
  ctx.fillRect(0, 0, out.width, out.height);
  const r = gameCanvas.getBoundingClientRect();
  ctx.drawImage(gameCanvas, r.left * scale, r.top * scale, r.width * scale, r.height * scale);
  let hud = false;
  try {
    const layers = [...document.body.children].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== gameCanvas && !skip(el) && !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName) && shown(el),
    );
    const layer = await domLayer(layers, width, height, scale);
    ctx.drawImage(layer, 0, 0, out.width, out.height);
    hud = true;
  } catch (e) {
    console.warn('Баг-репорт: панели не попали на снимок, только карта', e);
  }
  return { canvas: out, width, height, scale, hud };
}

function shown(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && !el.hidden;
}

/** Все правила стилей страницы одним текстом (свои таблицы стилей — им ничто не мешает их прочитать). */
function pageCss(): string {
  const out: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) out.push(rule.cssText);
    } catch {
      // Чужая таблица стилей без CORS — пропускаем.
    }
  }
  return out.join('\n');
}

/** Копия элемента с тем, чего cloneNode не переносит: холсты, значения полей, прокрутка. */
function liveClone(src: HTMLElement): HTMLElement {
  const copy = src.cloneNode(true) as HTMLElement;
  const from = [src, ...src.querySelectorAll<HTMLElement>('*')];
  const to = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
  for (let i = 0; i < from.length; i++) {
    const s = from[i];
    const c = to[i];
    if (s instanceof HTMLCanvasElement) {
      const img = document.createElement('img');
      for (const a of s.getAttributeNames()) if (a !== 'width' && a !== 'height') img.setAttribute(a, s.getAttribute(a)!);
      const box = s.getBoundingClientRect();
      img.style.width = `${box.width}px`;
      img.style.height = `${box.height}px`;
      try {
        img.src = s.toDataURL();
      } catch {
        // Холст с чужой картинкой не читается — останется пустое место.
      }
      c.replaceWith(img);
      continue;
    }
    if (s instanceof HTMLInputElement) {
      if (s.type === 'checkbox' || s.type === 'radio') c.toggleAttribute('checked', s.checked);
      else c.setAttribute('value', s.value);
    } else if (s instanceof HTMLTextAreaElement) {
      c.textContent = s.value;
    } else if (s instanceof HTMLSelectElement) {
      [...c.querySelectorAll('option')].forEach((o, k) => o.toggleAttribute('selected', k === s.selectedIndex));
    }
    // Прокрученный список: в копии прокрутки нет — сдвигаем содержимое на столько же.
    if (s.scrollTop || s.scrollLeft) {
      for (const child of c.children) if (child instanceof HTMLElement) child.style.translate = `${-s.scrollLeft}px ${-s.scrollTop}px`;
    }
  }
  return copy;
}

/** Слои поверх карты — одной картинкой: SVG с копией DOM внутри foreignObject. */
async function domLayer(layers: HTMLElement[], width: number, height: number, scale: number): Promise<HTMLCanvasElement> {
  const host = document.createElement('div');
  host.setAttribute('style', `position:relative;width:${width}px;height:${height}px;overflow:hidden;`);
  const style = document.createElement('style');
  style.textContent = pageCss();
  host.appendChild(style);
  for (const el of layers) {
    const clone = liveClone(el);
    // В картинке нет окна, к которому прикреплять fixed, — слой встаёт на то же место внутри host.
    if (getComputedStyle(el).position === 'fixed') clone.style.position = 'absolute';
    host.appendChild(clone);
  }
  const xhtml = new XMLSerializer().serializeToString(host);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">` +
    `<foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const layer = document.createElement('canvas');
  layer.width = Math.round(width * scale);
  layer.height = Math.round(height * scale);
  const ctx = layer.getContext('2d')!;
  ctx.drawImage(img, 0, 0, layer.width, layer.height);
  // Браузер, который считает такую картинку «чужой», не даст её прочитать — тогда снимок без панелей.
  ctx.getImageData(0, 0, 1, 1);
  return layer;
}
