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
    case 'livestock':
      // Голова коровы: рога, уши, светлая морда с ноздрями.
      return `<path d="M7.4 7.2C6 6.6 5 5.2 5 3.8M16.6 7.2c1.4-.6 2.4-2 2.4-3.4" stroke="${W}" stroke-width="1.5" fill="none" stroke-linecap="round"/>
        <ellipse cx="5.4" cy="9.4" rx="2.4" ry="1.3" transform="rotate(-20 5.4 9.4)" fill="${W}"/>
        <ellipse cx="18.6" cy="9.4" rx="2.4" ry="1.3" transform="rotate(20 18.6 9.4)" fill="${W}"/>
        <path d="M7.6 8.6c0-1.6 2-2.6 4.4-2.6s4.4 1 4.4 2.6l-.6 6.4H8.2z" fill="${W}"/>
        <rect x="7.4" y="13.6" width="9.2" height="5.6" rx="2.8" fill="${W}" stroke="${accent}" stroke-width="0.9"/>
        <circle cx="10.2" cy="16.4" r="0.9" fill="${accent}"/><circle cx="13.8" cy="16.4" r="0.9" fill="${accent}"/>
        <circle cx="9.8" cy="10.4" r="0.9" fill="${accent}"/><circle cx="14.2" cy="10.4" r="0.9" fill="${accent}"/>`;
    case 'sand':
      return `<path d="M3.4 18.6c2.2-5.6 5.2-9 8.6-9s6.4 3.4 8.6 9z" fill="${W}"/>
        ${[
          [9.4, 14.6],
          [12.6, 12.6],
          [14.8, 16],
          [11.6, 16.8],
          [7.4, 17.2],
          [16.8, 17.6],
        ]
          .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="0.75" fill="${accent}"/>`)
          .join('')}`;
    case 'glass':
      // Лист стекла с бликами.
      return `<path d="M7.6 4.6h10.6l-1.8 14.8H5.8z" fill="${W}"/>
        <path d="M10.4 14.4l4.8-6.6M10.6 17.4l2.6-3.6" stroke="${accent}" stroke-width="1.3" stroke-linecap="round"/>`;
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
    case 'furniture':
      // Кресло: спинка, подлокотники, сиденье и ножки.
      return `<rect x="7.4" y="5" width="9.2" height="8" rx="1.6" fill="${W}"/>
        <rect x="4.4" y="10" width="3.6" height="7" rx="1.4" fill="${W}"/><rect x="16" y="10" width="3.6" height="7" rx="1.4" fill="${W}"/>
        <rect x="7.4" y="12.2" width="9.2" height="4.8" rx="0.8" fill="${W}" stroke="${accent}" stroke-width="0.9"/>
        <path d="M6.2 17v2.4M17.8 17v2.4" stroke="${W}" stroke-width="1.6" stroke-linecap="round"/>`;
    // ---------- Грузы биомов ----------
    case 'flax':
      // Три стебля льна с цветками.
      return `<path d="M12 21V9.6M12 15.4c-1.8-1-3.2-3-3.4-5.4M12 15.4c1.8-1 3.2-3 3.4-5.4" stroke="${W}" stroke-width="1.4" fill="none" stroke-linecap="round"/>
        ${[
          [12, 6.8],
          [8.4, 8.2],
          [15.6, 8.2],
        ]
          .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.5" fill="${W}"/><circle cx="${x}" cy="${y}" r="0.8" fill="${accent}"/>`)
          .join('')}`;
    case 'clay':
      // Глиняный кувшин с поясом.
      return `<path d="M9.2 4.6h5.6v1.6c0 .9-.7 1.3-.7 2.3 2.9 1 4.7 3.5 4.7 6.3 0 2.7-2.1 4.8-4.8 4.8H9.9c-2.7 0-4.8-2.1-4.8-4.8 0-2.8 1.8-5.3 4.7-6.3 0-1-.6-1.4-.6-2.3z" fill="${W}"/>
        <path d="M6 13.2h12" stroke="${accent}" stroke-width="1.2"/>`;
    case 'fish':
      return `<path d="M3.6 12c2.4-3.4 5.6-4.8 8.8-4.8 2.8 0 5 1.4 6.4 3.2l2.2-2.4v8l-2.2-2.4c-1.4 1.8-3.6 3.2-6.4 3.2-3.2 0-6.4-1.4-8.8-4.8z" fill="${W}"/>
        <circle cx="7.6" cy="11.2" r="1.1" fill="${accent}"/><path d="M11.6 9.4c.8 1.6.8 3.6 0 5.2" stroke="${accent}" stroke-width="1" fill="none"/>`;
    case 'gold':
      // Пирамидка слитков.
      return `<path d="M3.8 18.6l1.6-4.4h5.6l1.6 4.4zM11.4 18.6l1.6-4.4h5.6l1.6 4.4zM7.6 13.2l1.6-4.4h5.6l1.6 4.4z" fill="${W}"/>
        <path d="M6.4 15.6h3.2M14 15.6h3.2M10.2 10.2h3.2" stroke="${accent}" stroke-width="0.9" stroke-linecap="round"/>`;
    case 'wool':
      // Клубок с ниткой.
      return `<circle cx="11" cy="11.4" r="6.4" fill="${W}"/>
        <path d="M6.4 9.2c3 .2 6.6 2.4 8.6 6.2M8 6.2c3.6 1.4 6.2 4.8 7 8.8M5 13c2.6-.4 5.8.8 7.6 3.6" stroke="${accent}" stroke-width="1" fill="none"/>
        <path d="M16.2 15.6c1.6 1.2 2.6 2.8 3 4.4" stroke="${W}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
    case 'sunflower':
      // Корзинка подсолнуха: лепестки кругом, семечки в середине.
      return `${Array.from({ length: 10 }, (_, k) => {
        const deg = k * 36;
        return `<ellipse cx="12" cy="5.6" rx="1.7" ry="2.6" transform="rotate(${deg} 12 12)" fill="${W}"/>`;
      }).join('')}<circle cx="12" cy="12" r="4" fill="${W}"/><circle cx="12" cy="12" r="2.9" fill="${accent}"/>`;
    case 'gems':
      // Гранёный камень.
      return `<path d="M7.2 5h9.6l3.6 4.6L12 20 3.6 9.6z" fill="${W}"/>
        <path d="M3.6 9.6h16.8M9.4 5 7.8 9.6 12 20l4.2-10.4L14.6 5" stroke="${accent}" stroke-width="0.9" fill="none"/>`;
    case 'copperore':
      // Камень с зелёными прожилками.
      return `<path d="M4.6 16.8l2.2-7 5.6-3.2 6 3.4.8 6.4-6.8 3.2z" fill="${W}"/>
        <path d="M8 12.4c2 .5 3.6-.8 5.6-.3M9.4 16c1.6-.6 3.4.2 5.2-.6" stroke="${accent}" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;
    case 'cotton':
      // Коробочка хлопка на ветке.
      return `<circle cx="8.8" cy="10" r="3.5" fill="${W}"/><circle cx="15.2" cy="10" r="3.5" fill="${W}"/><circle cx="12" cy="13.6" r="3.7" fill="${W}"/>
        <path d="M12 17v3.6M8.4 19l3.6-1.8 3.6 1.8" stroke="${W}" stroke-width="1.4" stroke-linecap="round" fill="none"/>`;
    case 'gas':
      // Пламя газа.
      return `<path d="M12 3.8c1 3 4.8 4.8 4.8 9.6a4.8 4.8 0 0 1-9.6 0c0-2.4 1.2-3.8 2.2-5 .2 1.6.8 2.6 1.8 3 .2-3 .4-5.4.8-7.6z" fill="${W}"/>
        <path d="M12 19.4a2.2 2.2 0 0 1-2.2-2.2c0-1.4 1.2-2.4 2.2-3.8 1 1.4 2.2 2.4 2.2 3.8a2.2 2.2 0 0 1-2.2 2.2z" fill="${accent}"/>`;
    case 'paper':
      // Рулон бумаги.
      return `<path d="M7.4 6.4h9.8a3.4 5.6 0 0 1 0 11.2H7.4z" fill="${W}"/>
        <ellipse cx="7.4" cy="12" rx="3.4" ry="5.6" fill="${W}" stroke="${accent}" stroke-width="1"/><ellipse cx="7.4" cy="12" rx="1.2" ry="2" fill="${accent}"/>`;
    case 'textiles':
      // Отрез ткани на валу.
      return `<rect x="4" y="4.6" width="16" height="4.2" rx="2.1" fill="${W}"/><path d="M6 8.8h12v10l-3-1.7-3 1.7-3-1.7-3 1.7z" fill="${W}"/>
        <path d="M8.4 11.6h7.2M8.4 14.2h7.2" stroke="${accent}" stroke-width="1.1"/>`;
    case 'jewelry':
      // Кольцо с камнем.
      return `<circle cx="12" cy="14.6" r="5" fill="none" stroke="${W}" stroke-width="2.2"/><path d="M9.2 6.8l1.3-2.2h3l1.3 2.2-2.8 3.2z" fill="${W}"/>`;
    case 'copper':
      // Катушка медного провода.
      return `<circle cx="11" cy="12" r="7" fill="${W}"/><circle cx="11" cy="12" r="4.4" fill="none" stroke="${accent}" stroke-width="1"/>
        <circle cx="11" cy="12" r="1.8" fill="${accent}"/><path d="M17.6 13.6c1.4.4 2.4 1.4 2.8 3" stroke="${W}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`;
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

/** Ушли, не дождавшись автобуса: серый кружок с идущим человеком (game/paxPatience.ts). Подсказка — data-tip снаружи. */
export const WALK_COLOR = '#7b8794';
const WALK_GLYPH = `<circle cx="13.2" cy="5.4" r="2.1" fill="#fff"/>
  <path d="M12.6 8.6l-1.5 5.6M11.1 14.2l-2.8 5M11.1 14.2l2.9 2.3.6 3.2M12.4 9.6l-3.3 2.2M12.4 9.6l1.6 2.6 2.6.8"
    stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;

export function walkIcon(size = 20): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}">
    <circle cx="12" cy="12" r="12" fill="${WALK_COLOR}"/>${WALK_GLYPH}</svg>`;
}

export function townIcon(size = 20, title = true): string {
  return `<svg class="cargo-icon" viewBox="0 0 24 24" width="${size}" height="${size}">${title ? '<title>Город</title>' : ''}
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

export function walkImage(): HTMLImageElement {
  return image('walk', WALK_GLYPH, WALK_COLOR);
}
