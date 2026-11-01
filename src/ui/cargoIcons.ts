import { CARGO, CargoType } from '../world/cargo';

/** Белая пиктограмма груза в координатах 24×24. accent — цвет деталей. */
function glyph(c: CargoType, accent: string): string {
  const W = '#fff';
  switch (c) {
    case 'passengers':
      return `<circle cx="12" cy="7.6" r="3.2" fill="${W}"/><path d="M6.5 19.5v-3.2a5.5 5.5 0 0 1 11 0v3.2z" fill="${W}"/>`;
    case 'grain':
      return `<path d="M12 20.5V8.5" stroke="${W}" stroke-width="1.6" stroke-linecap="round"/>
        <ellipse cx="12" cy="6.4" rx="1.5" ry="2.5" fill="${W}"/>
        ${[10.6, 14.6]
          .map(
            (y) => `<ellipse cx="9.7" cy="${y}" rx="1.5" ry="2.6" transform="rotate(-38 9.7 ${y})" fill="${W}"/>
              <ellipse cx="14.3" cy="${y}" rx="1.5" ry="2.6" transform="rotate(38 14.3 ${y})" fill="${W}"/>`,
          )
          .join('')}`;
    case 'logs':
      return [
        [8, 15.6],
        [16, 15.6],
        [12, 9],
      ]
        .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3.6" fill="${W}"/><circle cx="${x}" cy="${y}" r="1.6" fill="none" stroke="${accent}" stroke-width="1"/>`)
        .join('');
    case 'coal':
      return `<path d="M3.8 18.5l3.6-6.2 2.6 2.2 3.4-6.2 3.2 4.6 3.6 5.6z" fill="${W}"/>`;
    case 'ore':
      return `<path d="M5 16.5l2-6.5 5.5-3 6 3 .5 6.5-6.5 3z" fill="${W}"/>
        <circle cx="10" cy="12" r="1.4" fill="${accent}"/><circle cx="14.6" cy="14.6" r="1.1" fill="${accent}"/><circle cx="14.2" cy="10" r="0.9" fill="${accent}"/>`;
    case 'oil':
      return `<path d="M12 4.3c2.8 4.2 5.6 7.2 5.6 10.4a5.6 5.6 0 0 1-11.2 0c0-3.2 2.8-6.2 5.6-10.4z" fill="${W}"/>`;
    case 'stone':
      return `<path d="M3.6 18.2l2.4-5.2 4.4-1.2 2.6 3.6-1 2.8z" fill="${W}"/><path d="M11.4 18.2l1.4-6.4 4-2.6 4.2 3 .4 6z" fill="${W}"/>
        <path d="M7.4 10.6l1.6-4 3.6-.8 1.4 2.8-2.4 2.4z" fill="${W}"/>`;
    case 'food':
      return `<path d="M5 12.6a7 4.6 0 0 1 14 0v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 17.6z" fill="${W}"/>
        <path d="M9 10.4l1 2.6M12 9.9l.4 2.9M15 10.4l-1 2.6" stroke="${accent}" stroke-width="1.3" stroke-linecap="round"/>`;
    case 'planks':
      return [5.6, 10.3, 15]
        .map((y, i) => `<rect x="${3.6 + (i % 2) * 1.2}" y="${y}" width="15.6" height="3.4" rx="0.6" fill="${W}"/>`)
        .join('');
    case 'steel':
      return `<path d="M5.8 5.4h12.4v3h-4.6v7.2h4.6v3H5.8v-3h4.6V8.4H5.8z" fill="${W}"/>`;
    case 'fuel':
      return `<path d="M6.8 7.6h7.4l3.4 3.4v8.6H6.8z" fill="${W}"/><path d="M8.4 7.6V5h5" stroke="${W}" stroke-width="1.6" fill="none" stroke-linecap="round"/>
        <path d="M9.4 11.6l4.4 4.6M13.8 11.6l-4.4 4.6" stroke="${accent}" stroke-width="1.4" stroke-linecap="round"/>`;
    case 'construction':
      return [
        [4, 6, 7.6],
        [12.4, 6, 7.6],
        [4, 10.6, 3.4],
        [8.2, 10.6, 7.6],
        [16.6, 10.6, 3.4],
        [4, 15.2, 7.6],
        [12.4, 15.2, 7.6],
      ]
        .map(([x, y, w]) => `<rect x="${x}" y="${y}" width="${w}" height="3.6" rx="0.5" fill="${W}"/>`)
        .join('');
    case 'goods':
      return `<path d="M12 4.4l7.2 3.6v8.2L12 19.8l-7.2-3.6V8z" fill="${W}"/>
        <path d="M5.2 8.2L12 11.6l6.8-3.4M12 11.6v8" stroke="${accent}" stroke-width="1.3" fill="none"/>`;
  }
}

export const TOWN_COLOR = '#55606e';
const TOWN_GLYPH = `<path d="M4.8 12.2L12 6l7.2 6.2V19h-4.6v-4.4h-5.2V19H4.8z" fill="#fff"/>`;

/** Значок груза: цветной кружок с пиктограммой. */
export function cargoIcon(c: CargoType, size = 20, title = true): string {
  const color = CARGO[c].color;
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}">${title ? `<title>${CARGO[c].name}</title>` : ''}
    <circle cx="12" cy="12" r="12" fill="${color}"/>${glyph(c, color)}</svg>`;
}

export function townIcon(size = 20): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}"><title>Город</title>
    <circle cx="12" cy="12" r="12" fill="${TOWN_COLOR}"/>${TOWN_GLYPH}</svg>`;
}

const images = new Map<string, HTMLImageElement>();

function image(key: string, inner: string, color: string): HTMLImageElement {
  let img = images.get(key);
  if (!img) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="64" height="64">
      <circle cx="12" cy="12" r="11.4" fill="${color}" stroke="#fff" stroke-width="1.2"/>${inner}</svg>`;
    img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    images.set(key, img);
  }
  return img;
}

/** Картинка значка для отрисовки на канвасе. */
export function cargoImage(c: CargoType): HTMLImageElement {
  return image(c, glyph(c, CARGO[c].color), CARGO[c].color);
}

export function townImage(): HTMLImageElement {
  return image('town', TOWN_GLYPH, TOWN_COLOR);
}
