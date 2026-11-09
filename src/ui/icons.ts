import type { Vec } from '../core/vec';
import type { DrawMode } from '../game/build';
import type { Fragment } from '../lanes/fragment';
import { isDivided, isOneWay, isTrunk, RoadSpec, totalLanes } from '../world/roadTypes';
import type { BiomeId } from '../world/biomes';
import type { Relief, WaterAmount } from '../world/settings';


function arrow(x: number, y: number, dir: 1 | -1, color: string): string {
  const tip = x + 5 * dir;
  return `<path d="M${x - 5 * dir} ${y}H${tip}" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M${tip + 2.5 * dir} ${y}L${tip - 1 * dir} ${y - 3}L${tip - 1 * dir} ${y + 3}Z" fill="${color}"/>`;
}

/** Вид дороги сверху: полосы, разметка и стрелки направления. */
export function roadSvg(spec: RoadSpec, w = 84, h = 40): string {
  if (spec.cls === 'rail') return railSvg(w, h);
  if (spec.cls === 'dirt') return dirtSvg(w, h, totalLanes(spec), isOneWay(spec));
  const back = isOneWay(spec) ? 0 : spec.lanesB;
  const fwd = spec.lanesF;
  const lanes = back + fwd;
  // У автомагистрали между направлениями — разделительная полоса с барьером.
  const median = isDivided(spec) ? 4 : 0;
  const laneH = Math.min(9, (h - 8 - median) / lanes);
  const total = lanes * laneH + median;
  const top = (h - total) / 2;
  const laneY = (i: number) => top + i * laneH + (i >= back && median ? median : 0);
  const parts: string[] = [
    `<rect x="1" y="${top - 1.5}" width="${w - 2}" height="${total + 3}" rx="3" fill="#4b525c"/>`,
    `<rect x="1" y="${top}" width="${w - 2}" height="${total}" fill="#646b76"/>`,
  ];
  for (let i = 1; i < lanes; i++) {
    const y = laneY(i);
    const divider = i === back && back > 0;
    if (divider && median) {
      const my = top + back * laneH;
      parts.push(`<rect x="1" y="${my}" width="${w - 2}" height="${median}" fill="#9aa1aa"/>
        <path d="M1 ${my + median / 2}H${w - 1}" stroke="#e8ebee" stroke-width="1.6"/>`);
    } else if (divider && lanes > 2) {
      parts.push(`<path d="M3 ${y - 0.8}H${w - 3}M3 ${y + 0.8}H${w - 3}" stroke="#f0cd60" stroke-width="0.9"/>`);
    } else {
      parts.push(`<path d="M3 ${y}H${w - 3}" stroke="#f5f3e6" stroke-width="1" stroke-dasharray="4 4"/>`);
    }
  }
  if (isTrunk(spec.cls)) {
    parts.push(`<path d="M3 ${top + 1.2}H${w - 3}M3 ${top + total - 1.2}H${w - 3}" stroke="#f5f3e6" stroke-width="0.8"/>`);
  }
  for (let i = 0; i < lanes; i++) {
    const y = laneY(i) + laneH / 2;
    const dir = i < back ? -1 : 1;
    for (const x of w > 70 ? [w * 0.3, w * 0.72] : [w / 2]) parts.push(arrow(x, y, dir, '#ffffff'));
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${parts.join('')}</svg>`;
}

/** Грунтовая дорога сверху: укатанная земля и две пары колей, без разметки. */
export function dirtSvg(w = 84, h = 40, lanes = 2, oneWay = false): string {
  // Полоса — пара колей; полос больше — дорога шире (не выше картинки); односторонняя — со стрелками.
  const laneH = Math.min(7, (h - 8) / lanes);
  const total = lanes * laneH;
  const top = (h - total) / 2;
  const ruts: string[] = [];
  for (let i = 0; i < lanes; i++) for (const k of [0.32, 0.68]) ruts.push(`M2 ${(top + (i + k) * laneH).toFixed(1)}H${w - 2}`);
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <rect x="1" y="${top}" width="${w - 2}" height="${total}" rx="4" fill="#b8a07a" stroke="#a08762" stroke-width="1.2"/>
    <path d="${ruts.join('')}" stroke="rgba(118,92,60,0.6)" stroke-width="1.1" stroke-linecap="round"/>
    ${oneWay ? Array.from({ length: lanes }, (_, i) => arrow(w / 2, top + (i + 0.5) * laneH, 1, '#fff8ea')).join('') : ''}
  </svg>`;
}

/** Путь сверху: щебень, шпалы и два рельса. */
export function railSvg(w = 84, h = 40): string {
  const top = h / 2 - 8;
  const sleepers: string[] = [];
  for (let x = 5; x < w - 3; x += 6) sleepers.push(`<rect x="${x}" y="${top + 2}" width="2.6" height="12" fill="#7a5a3c"/>`);
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <rect x="1" y="${top}" width="${w - 2}" height="16" rx="3" fill="#b9b1a6"/>${sleepers.join('')}
    <path d="M1 ${top + 5}H${w - 1}M1 ${top + 11}H${w - 1}" stroke="#5c6670" stroke-width="1.8"/>
  </svg>`;
}

/** Перестроить: узкая дорога становится широкой. */
export function upgradeSvg(): string {
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <rect x="3" y="14" width="14" height="8" rx="1.5" fill="#646b76"/>
    <path d="M5 18H15" stroke="#f5f3e6" stroke-width="0.9" stroke-dasharray="2 2"/>
    <rect x="29" y="8" width="16" height="20" rx="1.5" fill="#646b76"/>
    <path d="M31 13H43M31 18H43M31 23H43" stroke="#f5f3e6" stroke-width="0.9" stroke-dasharray="2 2"/>
    <path d="M19 18H26" stroke="#2f80ed" stroke-width="2" stroke-linecap="round"/>
    <path d="M24 14.5L27.5 18L24 21.5" stroke="#2f80ed" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** «Полоса»: дорога, у которой новая полоса прилипает к краю и уходит съездом. */
export function laneSvg(): string {
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <rect x="2" y="9" width="44" height="12" rx="1.5" fill="#646b76"/>
    <path d="M4 15H44" stroke="#f5f3e6" stroke-width="0.9" stroke-dasharray="2.5 2"/>
    <path d="M10 22.5C18 22.5 22 22.5 28 22.5C34 22.5 38 26 44 32" stroke="#27ae60" stroke-width="5.5" fill="none" stroke-linecap="round"/>
    <path d="M13 21V24M19 21V24" stroke="#f5f3e6" stroke-width="0.9"/>
  </svg>`;
}

/** Значки статей финансов: круг цвета статьи с белым символом. */
export function ledgerIcon(kind: string, size = 22): string {
  const glyphs: Record<string, [string, string]> = {
    transport: ['#2e9d57', '<path d="M5 8h8v6H5zM13 10h3l2 2v2h-5z" fill="#fff"/><circle cx="8" cy="15.5" r="1.6" fill="#fff"/><circle cx="15" cy="15.5" r="1.6" fill="#fff"/>'],
    sales: ['#3fae6a', '<circle cx="12" cy="12" r="5" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M12 9v6M10.3 10.5h3M10.3 13.5h3" stroke="#fff" stroke-width="1.3"/>'],
    vehicles: ['#e07b39', '<path d="M7 16l6-6m-1-3a3 3 0 1 0 4 4" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/>'],
    roads: ['#646b76', '<path d="M9 5L7 19M15 5l2 14" stroke="#fff" stroke-width="1.8"/><path d="M12 7v2.5M12 11.5v2.5M12 16v2" stroke="#fff" stroke-width="1.4"/>'],
    build: ['#e9b52f', '<path d="M6 18h12M8 18V8h3v10M8 8l9 0M15 8v4" stroke="#fff" stroke-width="1.8" fill="none"/>'],
    interest: ['#9a6be0', '<path d="M8 16L16 8" stroke="#fff" stroke-width="1.8"/><circle cx="8.5" cy="8.5" r="1.8" fill="#fff"/><circle cx="15.5" cy="15.5" r="1.8" fill="#fff"/>'],
    purchases: ['#4a8fe7','<path d="M5 6h2l2 8h8l2-6H8" stroke="#fff" stroke-width="1.8" fill="none" stroke-linejoin="round"/><circle cx="10" cy="17" r="1.3" fill="#fff"/><circle cx="16" cy="17" r="1.3" fill="#fff"/>'],
    // Сценарий: награды и субсидии — значок-награда, штрафы — восклицательный знак.
    grants: ['#2fb8b3', '<circle cx="12" cy="9.6" r="4.2" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M9.6 13.2L8.2 19l3.8-2 3.8 2-1.4-5.8" fill="#fff"/>'],
    fines: ['#d64541', '<path d="M12 6v7.2" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.4" fill="#fff"/>'],
  };
  const [color, body] = glyphs[kind] ?? ['#9aa3ad', ''];
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"><circle cx="12" cy="12" r="11" fill="${color}"/>${body}</svg>`;
}

/** Двигать конец: тупик дороги перетаскивается к другой дороге. */
export function moveEndSvg(): string {
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <path d="M4 30C12 26 16 20 18 14" stroke="#646b76" stroke-width="6" stroke-linecap="round" fill="none"/>
    <path d="M18 14C22 8 30 6 40 6" stroke="#2f80ed" stroke-width="2" stroke-dasharray="3 3" fill="none"/>
    <circle cx="18" cy="14" r="3.4" fill="#fff" stroke="#9aa3ad" stroke-width="1.6"/>
    <circle cx="40" cy="6" r="3.4" fill="#fff" stroke="#2f80ed" stroke-width="1.8"/>
    <path d="M44 22H34" stroke="#646b76" stroke-width="6" stroke-linecap="round"/>
  </svg>`;
}

/** Двигать примыкание: въезд (был — пунктиром) примыкает дальше по дороге и поворачивает плавнее. */
export function moveJointSvg(): string {
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <rect x="2" y="4" width="44" height="10" rx="1.5" fill="#646b76"/>
    <path d="M3 33C8 27 11 19 13 15" stroke="#2f80ed" stroke-width="2" stroke-dasharray="3 3" fill="none"/>
    <path d="M5 33C21 31 29 16 40 15.5" stroke="#646b76" stroke-width="5.5" stroke-linecap="round" fill="none"/>
    <path d="M17 9H31" stroke="#2f80ed" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M35.5 9L30.5 6V12Z" fill="#2f80ed"/>
    <circle cx="13" cy="15" r="2.6" fill="#fff" stroke="#9aa3ad" stroke-width="1.4"/>
    <circle cx="40" cy="15" r="3.4" fill="#fff" stroke="#2f80ed" stroke-width="1.8"/>
  </svg>`;
}

/** Двигать узел: изгиб перетаскивается, дороги идут следом — и улица выпрямляется. */
export function moveNodeSvg(): string {
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <path d="M4 28L18 8L44 28" stroke="#646b76" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M4 28H44" stroke="#2f80ed" stroke-width="2" stroke-dasharray="3 3" fill="none"/>
    <path d="M19.5 13L22.4 20.6" stroke="#2f80ed" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M23.6 24L24.7 19.5L20 21.3Z" fill="#2f80ed"/>
    <circle cx="18" cy="8" r="3.4" fill="#fff" stroke="#9aa3ad" stroke-width="1.6"/>
    <circle cx="24" cy="28" r="3.4" fill="#fff" stroke="#2f80ed" stroke-width="1.8"/>
  </svg>`;
}

/** Изгиб дороги за середину: прямая (пунктиром) выгибается дугой к точке захвата. */
export function bendSvg(): string {
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <path d="M4 30H44" stroke="#2f80ed" stroke-width="2" stroke-dasharray="3 3" fill="none"/>
    <path d="M4 30Q24 0 44 30" stroke="#646b76" stroke-width="6" stroke-linecap="round" fill="none"/>
    <path d="M24 27L24 19" stroke="#2f80ed" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M24 15L21 20H27Z" fill="#2f80ed"/>
    <circle cx="24" cy="15" r="3.4" fill="#fff" stroke="#2f80ed" stroke-width="1.8"/>
  </svg>`;
}

/** Перо: дорога выходит из узла под углом, который задаёт ручка. */
export function handleSvg(): string {
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <path d="M6 30C18 30 26 8 44 8" stroke="#646b76" stroke-width="6" stroke-linecap="round" fill="none"/>
    <path d="M6 30L22 30" stroke="#2f80ed" stroke-width="1.6" fill="none"/>
    <circle cx="6" cy="30" r="2.6" fill="#2f80ed"/>
    <circle cx="22" cy="30" r="3.6" fill="#2f80ed" stroke="#fff" stroke-width="1.4"/>
  </svg>`;
}

/** Угол перекрёстка: острый угол между дорогами скруглён — ручку на бордюре тянут наружу, дуга шире. */
export function cornerSvg(): string {
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <path d="M2 30H46" stroke="#646b76" stroke-width="6" stroke-linecap="round"/>
    <path d="M2 30L30 4" stroke="#646b76" stroke-width="6" stroke-linecap="round"/>
    <path d="M9.64 27L25.77 12A8.64 8.64 0 0 0 31.64 27Z" fill="#646b76"/>
    <path d="M25.77 12L9.64 27L31.64 27" stroke="#fff" stroke-width="0.9" stroke-dasharray="1.6 1.4" fill="none"/>
    <path d="M25.77 12A8.64 8.64 0 0 0 31.64 27" stroke="#2f80ed" stroke-width="1.8" fill="none"/>
    <path d="M26.3 20.6L32.3 18.25" stroke="#2f80ed" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M36.5 16.6L33.25 20.67L31.35 15.83Z" fill="#2f80ed"/>
    <circle cx="23.6" cy="21.64" r="2.6" fill="#fff" stroke="#2f80ed" stroke-width="1.8"/>
  </svg>`;
}

/** Проект: дорога пунктиром, узлы квадратиками и перо — нарисовано, но не построено. */
export function projectSvg(w = 48, h = 36): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">
    <path d="M6 28C16 28 24 8 42 8" stroke="#2f80ed" stroke-opacity="0.18" stroke-width="9" stroke-linecap="round" fill="none"/>
    <path d="M6 24C15 24 22 4 42 4M6 32C17 32 26 12 42 12" stroke="#2f80ed" stroke-width="1.6" stroke-dasharray="3.5 2.5" fill="none"/>
    <path d="M6 28L18 28" stroke="#2f80ed" stroke-width="1.2" fill="none"/>
    <circle cx="18" cy="28" r="2.8" fill="#fff" stroke="#2f80ed" stroke-width="1.3"/>
    <rect x="2.5" y="24.5" width="7" height="7" fill="#2f80ed" stroke="#fff" stroke-width="1"/>
    <rect x="38.5" y="4.5" width="7" height="7" fill="#fff" stroke="#2f80ed" stroke-width="1.4"/>
  </svg>`;
}

/** Узел на дороге: дорога, посередине — квадратик узла (как у проекта), по бокам — штрихи «здесь делится». */
export function splitNodeSvg(w = 48, h = 36): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">
    <path d="M4 22C14 22 18 14 24 14S36 22 44 22" stroke="#646b76" stroke-width="7" stroke-linecap="round" fill="none"/>
    <path d="M4 22C14 22 18 14 24 14S36 22 44 22" stroke="#e8ebef" stroke-width="1" stroke-dasharray="3 3" fill="none"/>
    <path d="M24 5V9M24 19V23" stroke="#2f80ed" stroke-width="1.6" stroke-linecap="round"/>
    <rect x="20" y="10" width="8" height="8" fill="#fff" stroke="#2f80ed" stroke-width="1.8"/>
  </svg>`;
}

/** Путь в значке: рельсы по краям, щебень и шпалы (пунктиром поперёк). */
function trackPath(d: string): string {
  return `<path d="${d}" stroke="#4f5965" stroke-width="7" stroke-linecap="butt" fill="none"/>
    <path d="${d}" stroke="#b9b1a6" stroke-width="4.6" fill="none"/>
    <path d="${d}" stroke="#7a5a3c" stroke-width="4.6" stroke-dasharray="1.4 2.8" fill="none" opacity="0.75"/>`;
}

/**
 * Ж/д «Двигать» — что можно тянуть: узел (пути следом, направление в узле прежнее), тупик, середину
 * участка (выгнуть) и перо (угол пути в узле). Пунктир — как было.
 */
export function trackMoveSvg(what: 'node' | 'end' | 'bend' | 'handle'): string {
  const was = (d: string) => `<path d="${d}" stroke="#2f80ed" stroke-width="1.6" stroke-dasharray="3 3" fill="none"/>`;
  const dot = (x: number, y: number, active: boolean) =>
    `<circle cx="${x}" cy="${y}" r="3.4" fill="#fff" stroke="${active ? '#2f80ed' : '#9aa3ad'}" stroke-width="${active ? 1.8 : 1.6}"/>`;
  const arrow = (x0: number, y0: number, x1: number, y1: number) => {
    const l = Math.hypot(x1 - x0, y1 - y0) || 1;
    const [ux, uy] = [(x1 - x0) / l, (y1 - y0) / l];
    const tip = `${x1 + ux * 3},${y1 + uy * 3} ${x1 - uy * 2.6},${y1 + ux * 2.6} ${x1 + uy * 2.6},${y1 - ux * 2.6}`;
    return `<path d="M${x0} ${y0}L${x1} ${y1}" stroke="#2f80ed" stroke-width="1.8" stroke-linecap="round"/><polygon points="${tip}" fill="#2f80ed"/>`;
  };
  const body = {
    node: `${was('M3 9H45')}${trackPath('M3 9C15 9 15 27 24 27C33 27 33 9 45 9')}${arrow(24, 12, 24, 20)}${dot(24, 9, false)}${dot(24, 27, true)}`,
    end: `${was('M4 27H30')}${trackPath('M4 27C18 27 28 17 40 9')}${arrow(31, 24, 36, 15)}${dot(30, 27, false)}${dot(40, 9, true)}`,
    bend: `${was('M4 29H44')}${trackPath('M4 29Q24 1 44 29')}${arrow(24, 27, 24, 20)}${dot(24, 15, true)}`,
    handle: `${trackPath('M6 29C18 29 26 8 44 8')}<path d="M6 29L22 29" stroke="#2f80ed" stroke-width="1.6"/>
      <circle cx="6" cy="29" r="2.6" fill="#2f80ed"/><circle cx="22" cy="29" r="3.6" fill="#2f80ed" stroke="#fff" stroke-width="1.4"/>`,
  }[what];
  return `<svg viewBox="0 0 48 36" width="48" height="36">${body}</svg>`;
}

/** Кольцо сверху: размер (0…1) и число полос. */
export function ringSvg(size: number, lanes: number): string {
  const r = 7 + size * 7;
  const w = 2.2 + lanes * 2.4;
  const marks = [];
  for (let i = 1; i < lanes; i++) {
    const rr = r - w / 2 + (i * w) / lanes;
    marks.push(`<circle cx="24" cy="18" r="${rr}" fill="none" stroke="#f5f3e6" stroke-width="0.7" stroke-dasharray="2 2"/>`);
  }
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <path d="M2 18H46M24 1V35" stroke="#646b76" stroke-width="5"/>
    <circle cx="24" cy="18" r="${r}" fill="none" stroke="#646b76" stroke-width="${w}"/>
    ${marks.join('')}
    <circle cx="24" cy="18" r="${Math.max(1.5, r - w / 2 - 0.5)}" fill="#b4cf93"/>
  </svg>`;
}

/** Стрелка: от прямого пути плавно отходит второй. */
export function switchSvg(w = 40, h = 20): string {
  return `<svg viewBox="0 0 40 20" width="${w}" height="${h}">
    <path d="M2 15H38" stroke="#b9b1a6" stroke-width="6"/>
    <path d="M10 15C20 15 24 5 38 5" stroke="#b9b1a6" stroke-width="6" fill="none"/>
    <path d="M2 13.4H38M2 16.6H38" stroke="#4f5965" stroke-width="1"/>
    <path d="M10 13.4C20 13.4 24 3.4 38 3.4M10 16.6C20 16.6 24 6.6 38 6.6" stroke="#4f5965" stroke-width="1" fill="none"/>
  </svg>`;
}

/** Проходная станция схемой: главный путь насквозь, второй отходит и возвращается, платформа между ними. */
export function throughStationSvg(w = 36): string {
  return `<svg viewBox="0 0 36 22" width="${w}" height="${(w * 22) / 36}">
    <path d="M1 15H35" stroke="currentColor" stroke-width="2"/>
    <path d="M4 15C9 15 9 7 14 7H22C27 7 27 15 32 15" stroke="currentColor" stroke-width="2" fill="none"/>
    <rect x="13" y="9.4" width="10" height="3.2" rx="0.8" fill="currentColor" opacity="0.4"/>
    <path d="M31 3.5L35 5.5L31 7.5M5 3.5L1 5.5L5 7.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** Конечная (тупиковая) станция схемой: пути от горловины слева кончаются красными упорами справа. */
export function terminalStationSvg(w = 36): string {
  return `<svg viewBox="0 0 36 22" width="${w}" height="${(w * 22) / 36}">
    <path d="M1 15H29" stroke="currentColor" stroke-width="2"/>
    <path d="M4 15C9 15 9 7 14 7H29" stroke="currentColor" stroke-width="2" fill="none"/>
    <rect x="14" y="9.4" width="12" height="3.2" rx="0.8" fill="currentColor" opacity="0.4"/>
    <path d="M30.5 3.6V10.4M30.5 11.6V18.4" stroke="#d9534f" stroke-width="3" stroke-linecap="round"/>
    <path d="M5 1.5L1 3.5L5 5.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** Пассажирский вагон сбоку: длинный кузов с рядом окон (цвет — currentColor). */
export function passengerCarSvg(w = 22): string {
  const windows = [3.2, 8.2, 13.2, 18.2].map((x) => `<rect x="${x}" y="3.4" width="2.8" height="3" rx="0.6" fill="#fff"/>`).join('');
  return `<svg viewBox="0 0 24 14" width="${w}" height="${(w * 14) / 24}">
    <rect x="1" y="1.2" width="22" height="9" rx="2.2" fill="currentColor"/>${windows}
    <circle cx="6" cy="11.9" r="1.7" fill="currentColor"/><circle cx="18" cy="11.9" r="1.7" fill="currentColor"/>
  </svg>`;
}

/** Грузовой вагон сбоку: открытый полувагон с горкой груза и рёбрами по борту (цвет — currentColor). */
export function freightCarSvg(w = 22): string {
  return `<svg viewBox="0 0 24 14" width="${w}" height="${(w * 14) / 24}">
    <path d="M3.5 5.4C5.5 2.2 9 2.4 12 3.6C15 2.2 18.6 2.4 20.5 5.4Z" fill="currentColor" opacity="0.5"/>
    <path d="M1.2 5H22.8L21.2 10.3H2.8Z" fill="currentColor"/>
    <path d="M8 6.2V9.4M12 6.2V9.4M16 6.2V9.4" stroke="#fff" stroke-width="1" stroke-linecap="round"/>
    <circle cx="6" cy="11.9" r="1.7" fill="currentColor"/><circle cx="18" cy="11.9" r="1.7" fill="currentColor"/>
  </svg>`;
}

/**
 * Длина платформы: под путём — платформа, тем шире, чем она длиннее (max — во всю ширину), на ней — вагоны,
 * сколько встанет (по 20 м), снизу — размерная черта.
 */
export function platformLengthSvg(length: number, max: number): string {
  const w = 8 + 36 * Math.min(1, Math.max(0, length / max));
  const x0 = 24 - w / 2;
  const cars = Math.max(1, Math.min(12, Math.floor((length - 6) / 20)));
  const cw = w / cars;
  const train = Array.from(
    { length: cars },
    (_, i) => `<rect x="${(x0 + i * cw + 0.4).toFixed(1)}" y="7.5" width="${(cw - 0.8).toFixed(1)}" height="5" rx="0.8" fill="${i === 0 ? '#3d4a5a' : '#d9534f'}"/>`,
  ).join('');
  const x1 = x0 + w;
  return `<svg viewBox="0 0 48 36" width="48" height="36">
    <path d="M1 10H47" stroke="#b9b1a6" stroke-width="3.6"/><path d="M1 9H47M1 11H47" stroke="#4f5965" stroke-width="0.6"/>
    ${train}
    <rect x="${x0.toFixed(1)}" y="14" width="${w.toFixed(1)}" height="7" rx="1" fill="#e4dfd4" stroke="#b9b2a6" stroke-width="0.6"/>
    <path d="M${x0.toFixed(1)} 28H${x1.toFixed(1)}M${x0.toFixed(1)} 25V31M${x1.toFixed(1)} 25V31" stroke="#6b7785" stroke-width="1.2"/>
  </svg>`;
}

/** Ж/д станция сверху: n путей с платформами между ними. */
export function platformsSvg(n: number): string {
  const track = (y: number) => `<path d="M2 ${y}H46" stroke="#b9b1a6" stroke-width="3.6"/><path d="M2 ${y - 1}H46M2 ${y + 1}H46" stroke="#4f5965" stroke-width="0.6"/>`;
  // Один путь — платформа сбоку от него (со стороны здания), а не между путями.
  if (n <= 1) return `<svg viewBox="0 0 48 36" width="48" height="36">${track(13)}<rect x="10" y="16.2" width="28" height="9" rx="1" fill="#e4dfd4"/></svg>`;
  const gap = 28 / n;
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const y = 6 + i * gap + gap / 2;
    rows.push(track(y));
    if (i < n - 1) rows.push(`<rect x="10" y="${y + 2.2}" width="28" height="${gap - 4.4}" rx="1" fill="#e4dfd4"/>`);
  }
  return `<svg viewBox="0 0 48 36" width="48" height="36">${rows.join('')}</svg>`;
}

/** Ширина картинки baysSvg для n постов, px: под неё в карточке станции держат место, чтобы «+» не смещалась. */
export function baysSvgWidth(n: number): number {
  return 6 + n * 7;
}

/**
 * Автостанция сверху: навес и n постов погрузки; занятый — цвета машины, что на нём стоит (как на карте).
 * Автовокзал (terminal) — здание с синей кромкой навеса и n мест на асфальте между перронами; на занятом — автобус.
 */
export function baysSvg(n: number, busy: (string | null)[] = [], h = 22, terminal = false): string {
  const bw = 7;
  const w = baysSvgWidth(n);
  if (terminal) {
    const islands = Array.from({ length: n + 1 }, (_, i) => `<rect x="${2.3 + i * bw}" y="7" width="1.6" height="${h - 9.5}" rx="0.8" fill="#d7d9dc"/>`).join('');
    const buses = busy
      .slice(0, n)
      .map((c, i) => (c ? `<rect x="${4.6 + i * bw}" y="7.6" width="${bw - 2.6}" height="${h - 11}" rx="1.2" fill="${c}" stroke="#1e2530" stroke-width="0.5"/>` : ''))
      .join('');
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <rect x="0.7" y="0.7" width="${w - 1.4}" height="${h - 1.4}" rx="2" fill="#646b76" stroke="#4b525c" stroke-width="1.4"/>
    <rect x="1.5" y="1.5" width="${w - 3}" height="4.5" fill="#f2efe8"/><rect x="1.5" y="5" width="${w - 3}" height="1.2" fill="#2f80ed"/>${islands}${buses}</svg>`;
  }
  const slots = Array.from(
    { length: n },
    (_, i) => `<rect x="${3.5 + i * bw}" y="9" width="${bw - 1.5}" height="${h - 12}" rx="1" fill="${busy[i] ?? '#d5d2c8'}"/>`,
  ).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <rect x="0.7" y="0.7" width="${w - 1.4}" height="${h - 1.4}" rx="2" fill="#f3f1ea" stroke="#5c6470" stroke-width="1.4"/>
    <rect x="3" y="3" width="${w - 6}" height="3.5" fill="#5c6470"/>${slots}</svg>`;
}

/** Развязка «ромб»: магистраль, мост поперёк и четыре съезда. */
export function diamondSvg(w = 48, h = 36): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">
    <path d="M2 18H46" stroke="#646b76" stroke-width="7"/>
    <path d="M2 18H46" stroke="#e8ebee" stroke-width="1"/>
    <path d="M10 15C16 13 20 8 24 7M24 7C28 8 32 13 38 15M10 21C16 23 20 28 24 29M24 29C28 28 32 23 38 21" stroke="#7a828e" stroke-width="2.6" fill="none"/>
    <path d="M24 1V35" stroke="#d3d8de" stroke-width="6"/>
    <path d="M24 1V35" stroke="#7a828e" stroke-width="4"/>
  </svg>`;
}

/** Свернуть/развернуть: жирная галочка вниз (свёрнутое повёрнуто стилем). */
export function chevronSvg(size = 12): string {
  return `<svg viewBox="0 0 12 12" width="${size}" height="${size}"><path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Копия: перекрёсток в синей рамке и его повёрнутая копия. */
export function copySvg(w = 48, h = 36): string {
  const cross = `<path d="M-9 0H9M0 -9V9" stroke="#646b76" stroke-width="4"/><rect x="-11" y="-11" width="22" height="22" rx="1.5" fill="rgba(47,128,237,0.12)" stroke="#2f80ed" stroke-width="1.5" stroke-dasharray="3 2"/>`;
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">
    <g transform="translate(14 14)">${cross}</g>
    <g transform="translate(33 22) rotate(30)">${cross}</g>
    <path d="M24 6A12 12 0 0 1 36 10" stroke="#2f80ed" stroke-width="1.6" fill="none"/><path d="M36 10l-4 0.5M36 10l-1-4" stroke="#2f80ed" stroke-width="1.6"/>
  </svg>`;
}

/** Схема куска дорог (свой шаблон, скопированное): оси полотен, магистрали толще; ж/д пути — «шпалами», как на карте. */
export function fragmentSvg(frag: Fragment, w = 64, h = 48): string {
  const pad = 3;
  const k = Math.min((w - pad * 2) / (frag.half.x * 2), (h - pad * 2) / (frag.half.y * 2));
  const at = (p: Vec) => `${(w / 2 + p.x * k).toFixed(1)} ${(h / 2 + p.y * k).toFixed(1)}`;
  const width: Record<string, number> = { motorway: 3.4, highway: 3, avenue: 2.4, street: 1.6, dirt: 1.3 };
  const rails = (frag.rail?.segs ?? [])
    .map(({ curve: { p0, p1, p2, p3 } }) => {
      const d = `M${at(p0)}C${at(p1)} ${at(p2)} ${at(p3)}`;
      return `<path d="${d}" stroke="#5c6670" stroke-width="2.6" fill="none" stroke-linecap="round"/><path d="${d}" stroke="#f4f1ea" stroke-width="1.2" stroke-dasharray="2.2 2.2" fill="none"/>`;
    })
    .join('');
  const paths = [...frag.corridors]
    .sort((a, b) => (width[a.cls] ?? 2) - (width[b.cls] ?? 2))
    .map((c) => {
      const { p0, p1, p2, p3 } = c.curve;
      const color = c.cls === 'motorway' || c.cls === 'highway' ? '#646b76' : c.cls === 'dirt' ? '#a08762' : '#7a828e';
      return `<path d="M${at(p0)}C${at(p1)} ${at(p2)} ${at(p3)}" stroke="${color}" stroke-width="${width[c.cls] ?? 2}" fill="none" stroke-linecap="round"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${rails}${paths}</svg>`;
}

/** Метка «с ж/д путями» на карточке шаблона: отрезок пути со шпалами. */
export function railBadgeSvg(w = 22, h = 14): string {
  const ties = [4, 8, 12, 16].map((x) => `<path d="M${x} 3.5V10.5" stroke="#7a5a3c" stroke-width="1.6"/>`).join('');
  return `<svg viewBox="0 0 20 14" width="${w}" height="${h}"><rect x="0.6" y="0.6" width="18.8" height="12.8" rx="3.5" fill="#fff" stroke="#b9b1a6" stroke-width="1.2"/>${ties}<path d="M2.5 5.2H17.5M2.5 8.8H17.5" stroke="#4f5965" stroke-width="1.3"/></svg>`;
}

/** Скачать файлом: стрелка вниз в лоток. */
export function downloadSvg(size = 16): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><path d="M8 2V10M4.6 6.8L8 10.2L11.4 6.8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11V13.5H13.5V11" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Скачать все шаблоны одним файлом: стопка карточек и стрелка вниз. */
export function downloadAllSvg(size = 18): string {
  return `<svg viewBox="0 0 18 16" width="${size * 1.125}" height="${size}">
    <rect x="1" y="1" width="9" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.55"/>
    <rect x="3.5" y="3.5" width="9" height="7" rx="1.5" fill="#fff" stroke="currentColor" stroke-width="1.3"/>
    <path d="M14 5V12.5M11.6 10.2L14 12.6L16.4 10.2" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M1.5 12.5V15H16.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** Продолжить игру: треугольник «играть». */
export function playSvg(size = 18): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><path d="M5 3.2L12.6 8L5 12.8Z" fill="currentColor"/></svg>`;
}

/** Сохранить: дискета. */
export function saveSvg(size = 22): string {
  return `<svg viewBox="0 0 22 22" width="${size}" height="${size}"><rect x="2.5" y="2.5" width="17" height="17" rx="3" fill="#2f80ed"/><rect x="6" y="2.5" width="9" height="6" rx="1" fill="#dbe8fb"/><rect x="12" y="3.6" width="2" height="3.6" rx="0.6" fill="#2f80ed"/><rect x="5.5" y="11.5" width="11" height="6" rx="1" fill="#fff"/></svg>`;
}

/** Сохранения: стопка карточек партий. */
export function savesSvg(size = 22): string {
  return `<svg viewBox="0 0 22 22" width="${size}" height="${size}"><rect x="6" y="2.5" width="13.5" height="10" rx="2.2" fill="#c9d6e6"/><rect x="4.2" y="5.5" width="13.5" height="10" rx="2.2" fill="#9fb4cc"/><rect x="2.5" y="8.5" width="13.5" height="11" rx="2.2" fill="#fff" stroke="#5f7a8f" stroke-width="1.4"/><path d="M5.5 16L8.5 12.5L10.5 14.5L13 11.5" stroke="#6aa84f" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Новая игра: карта с плюсом. */
export function newGameSvg(size = 22): string {
  return `<svg viewBox="0 0 22 22" width="${size}" height="${size}"><rect x="2.5" y="4" width="14" height="14" rx="2.5" fill="#d6e2bd" stroke="#8aa070" stroke-width="1.2"/><path d="M4.5 13c3-4 6 1 10-3" stroke="#8cc3e6" stroke-width="1.8" fill="none" stroke-linecap="round"/><circle cx="16.5" cy="5.5" r="4.6" fill="#27ae60"/><path d="M16.5 3.3V7.7M14.3 5.5H18.7" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;
}

/** Журнал партии: лист с записями и стрелка вниз — скачать. */
export function journalSvg(size = 22): string {
  return `<svg viewBox="0 0 22 22" width="${size}" height="${size}"><rect x="3" y="2.5" width="12.5" height="16" rx="2.2" fill="#fff" stroke="#5f7a8f" stroke-width="1.4"/><path d="M6 6.5H12.5M6 9.5H12.5M6 12.5H10" stroke="#9fb4cc" stroke-width="1.5" stroke-linecap="round"/><circle cx="16" cy="15.5" r="5" fill="#7a5cc4"/><path d="M16 12.6V18M13.8 15.8L16 18L18.2 15.8" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Открыть из файла: стрелка вверх из лотка. */
export function uploadSvg(size = 16): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}"><path d="M8 10.5V2.5M4.6 5.8L8 2.4L11.4 5.8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 11V13.5H13.5V11" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Снос по одному: дорога и дом, крестик над одним объектом. */
export function bulldozePointSvg(w = 48, h = 36): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">
    <path d="M2 26H46" stroke="#646b76" stroke-width="7"/>
    <rect x="8" y="6" width="11" height="11" rx="1.5" fill="#a65a4a"/>
    <rect x="27" y="5" width="12" height="12" rx="1.5" fill="#7d8fa3"/>
    <path d="M27 5L39 17M39 5L27 17" stroke="#e8483f" stroke-width="2.6"/>
  </svg>`;
}

/** Снос полосы: дорога с пристроенной полосой (с отгоном), полоса — красным с крестиком. */
export function bulldozeLaneSvg(w = 48, h = 36): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">
    <path d="M2 12H46" stroke="#646b76" stroke-width="12"/>
    <path d="M2 12H46" stroke="#e8ebee" stroke-width="1" stroke-dasharray="4 3"/>
    <path d="M8 24L16 19H40V25H8Z" fill="rgba(232,72,63,0.55)"/>
    <path d="M24 19.5L32 28.5M32 19.5L24 28.5" stroke="#e8483f" stroke-width="2.4"/>
  </svg>`;
}

/** Снос рамкой: пунктирный прямоугольник поверх дорог и домов. */
export function bulldozeAreaSvg(w = 48, h = 36): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">
    <path d="M2 26H46" stroke="#646b76" stroke-width="7"/>
    <rect x="8" y="6" width="11" height="11" rx="1.5" fill="#a65a4a"/>
    <rect x="27" y="5" width="12" height="12" rx="1.5" fill="#7d8fa3"/>
    <rect x="4" y="2" width="40" height="30" rx="2" fill="rgba(232,72,63,0.15)" stroke="#e8483f" stroke-width="1.8" stroke-dasharray="4 3"/>
  </svg>`;
}

/** Схема развязки по шаблону: ромб, Т-образная (две петли за магистралью) или клеверный лист. */
export function templateSvg(kind: 'diamond' | 'tee' | 'clover', w = 48, h = 36): string {
  if (kind === 'diamond') return diamondSvg(w, h);
  const ramp = '#7a828e';
  // Петля в четверти: круг у перекрестья, касающийся обеих дорог.
  const loop = (cx: number, cy: number) => `<circle cx="${cx}" cy="${cy}" r="5.5" stroke="${ramp}" stroke-width="2.2" fill="none"/>`;
  const trunk = `<path d="M2 18H46" stroke="#646b76" stroke-width="7"/><path d="M2 18H46" stroke="#e8ebee" stroke-width="1"/>`;
  if (kind === 'tee') {
    return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">${trunk}
      ${loop(17, 9)}${loop(31, 9)}
      <path d="M8 21C16 23 20 28 22 34M38 21C30 23 28 28 26 34" stroke="${ramp}" stroke-width="2.2" fill="none"/>
      <path d="M24 9V35" stroke="#d3d8de" stroke-width="6"/><path d="M24 9V35" stroke="#7a828e" stroke-width="4"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">${trunk}
    ${loop(17, 9)}${loop(31, 9)}${loop(17, 27)}${loop(31, 27)}
    <path d="M3 14C10 13 10 4 19 1M45 22C38 23 38 32 29 35M29 1C38 4 38 13 45 14M19 35C10 32 10 23 3 22" stroke="${ramp}" stroke-width="1.8" fill="none"/>
    <path d="M24 1V35" stroke="#d3d8de" stroke-width="6"/><path d="M24 1V35" stroke="#7a828e" stroke-width="4"/>
  </svg>`;
}

/** Ж/д сигнал: столбик с красным и зелёным огнями у пути. */
export function signalSvg(w = 48, h = 36): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">
    <path d="M2 28H46" stroke="#b9b1a6" stroke-width="6"/>
    <path d="M2 26.4H46M2 29.6H46" stroke="#4f5965" stroke-width="1"/>
    <path d="M30 22V10" stroke="#2a2e33" stroke-width="2"/>
    <rect x="25" y="2" width="10" height="16" rx="3" fill="#2a2e33"/>
    <circle cx="30" cy="6.5" r="2.6" fill="#e8483f"/>
    <circle cx="30" cy="13.5" r="2.6" fill="#3ad16b"/>
    <path d="M8 20H20M16 16.5L20 20L16 23.5" stroke="#2f80ed" stroke-width="1.6" fill="none"/>
  </svg>`;
}

/**
 * Сигнал без встречного (как в Transport Fever): поезда едут мимо только по стрелке; навстречу — знак
 * «въезд запрещён», поезд туда не поедет.
 */
export function oneWaySignalSvg(w = 48, h = 36): string {
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">
    <path d="M2 28H46" stroke="#b9b1a6" stroke-width="6"/>
    <path d="M2 26.4H46M2 29.6H46" stroke="#4f5965" stroke-width="1"/>
    <path d="M22 22V10" stroke="#2a2e33" stroke-width="2"/>
    <rect x="17" y="2" width="10" height="16" rx="3" fill="#2a2e33"/>
    <circle cx="22" cy="6.5" r="2.6" fill="#e8483f"/>
    <circle cx="22" cy="13.5" r="2.6" fill="#3ad16b"/>
    <path d="M3 20H13M10 16.5L13.5 20L10 23.5" stroke="#2f80ed" stroke-width="1.6" fill="none"/>
    <path d="M37 22V15" stroke="#2a2e33" stroke-width="1.6"/>
    <circle cx="37" cy="9" r="7" fill="#d93a32" stroke="#fff" stroke-width="1.2"/>
    <path d="M32.8 9H41.2" stroke="#fff" stroke-width="2.4"/>
  </svg>`;
}

/**
 * Выбор пути ж/д станции: схема из n путей с номерами, выбранный (pick, с 0) — синий и толще;
 * pick = null — «авто»: все пути одинаковые, поезд встанет на свободный.
 */
export function platformPickSvg(n: number, pick: number | null): string {
  const h = 6 + n * 7;
  const rows = Array.from({ length: n }, (_, i) => {
    const y = 6 + i * 7;
    const on = pick === i;
    const color = pick === null ? '#7d8791' : on ? '#2f80ed' : '#c3c9cf';
    return `<text x="1" y="${y + 3}" font-size="7" font-weight="${on ? 700 : 400}" fill="${on ? '#2f80ed' : '#7d8791'}">${i + 1}</text>
      <path d="M9 ${y}H45" stroke="${color}" stroke-width="${on ? 3.2 : 1.8}" ${pick === null ? 'stroke-dasharray="4 2"' : ''}/>`;
  }).join('');
  return `<svg viewBox="0 0 46 ${h}" width="46" height="${h}">${rows}</svg>`;
}

/** Переезд: дорога поперёк пути со шлагбаумом. */
export function crossingSvg(w = 40, h = 20): string {
  return `<svg viewBox="0 0 40 20" width="${w}" height="${h}">
    <rect x="14" y="0" width="12" height="20" fill="#646b76"/>
    <path d="M0 10H40" stroke="#b9b1a6" stroke-width="7"/>
    <rect x="14" y="6.5" width="12" height="7" fill="#646b76"/>
    <path d="M0 8.4H40M0 11.6H40" stroke="#4f5965" stroke-width="1"/>
    <path d="M27 3H38" stroke="#e8483f" stroke-width="2" stroke-dasharray="2 2"/>
    <circle cx="27" cy="3" r="1.8" fill="#e8483f"/>
  </svg>`;
}

/** Вокзал: здание с платформой у двух путей. */
/** n путей рядом (сверху): рельсы со шпалами; dashed — пристроенный путь пунктиром. */
export function tracksSvg(n: number, dashed = false): string {
  const rows = Array.from({ length: n }, (_, i) => {
    const y = 18 + (i - (n - 1) / 2) * 12;
    const ties = Array.from({ length: 9 }, (_, k) => `<path d="M${6 + k * 5} ${y - 4}V${y + 4}" stroke="#7a5a3c" stroke-width="1.6" opacity="0.7"/>`).join('');
    const extra = dashed && i === n - 1 ? 'stroke-dasharray="3 2"' : '';
    return `${ties}<path d="M3 ${y - 2.5}H49M3 ${y + 2.5}H49" stroke="#4f5965" stroke-width="1.4" ${extra}/>`;
  }).join('');
  return `<svg viewBox="0 0 52 36" width="52" height="36">${rows}</svg>`;
}

/**
 * Как ставить автостанцию: end — в конце выезда (улица внизу, от неё вверх — выезд к площадке с постами),
 * side — вдоль дороги (у края улицы — карман со скосами, площадка боком к нему).
 */
export function stationPlaceSvg(mode: 'end' | 'side', size = 30): string {
  const posts = (x0: number, y: number, n: number, w: number) =>
    Array.from({ length: n + 1 }, (_, i) => `<rect x="${x0 + i * w - 0.6}" y="${y}" width="1.2" height="6" fill="#d7d9dc"/>`).join('');
  if (mode === 'end') {
    return `<svg viewBox="0 0 40 36" width="${(size * 40) / 36}" height="${size}">
      <rect x="0" y="27" width="40" height="8" fill="#646b76"/><path d="M0 31H40" stroke="#f5f3e6" stroke-width="0.9" stroke-dasharray="3 2"/>
      <rect x="16.5" y="15" width="7" height="13" fill="#646b76"/><path d="M20 16V27" stroke="#f5f3e6" stroke-width="0.7" stroke-dasharray="2 1.5"/>
      <rect x="8" y="2" width="24" height="14" rx="1" fill="#646b76" stroke="#4b525c" stroke-width="1"/>
      <rect x="8.5" y="2.5" width="23" height="3.5" fill="#f2efe8"/><rect x="8.5" y="5.5" width="23" height="1" fill="#2f80ed"/>${posts(11, 7, 3, 6)}
    </svg>`;
  }
  return `<svg viewBox="0 0 40 36" width="${(size * 40) / 36}" height="${size}">
    <rect x="0" y="27" width="40" height="8" fill="#646b76"/><path d="M0 31H40" stroke="#f5f3e6" stroke-width="0.9" stroke-dasharray="3 2"/>
    <path d="M2 27L8 22H32L38 27Z" fill="#646b76"/><path d="M8 24.5H32" stroke="#f5f3e6" stroke-width="0.7" stroke-dasharray="2 1.5"/>
    <rect x="8" y="5" width="24" height="17" rx="1" fill="#646b76" stroke="#4b525c" stroke-width="1"/>
    <rect x="8.5" y="5.5" width="23" height="4" fill="#f2efe8"/><rect x="8.5" y="9" width="23" height="1" fill="#2f80ed"/>${posts(11, 10.5, 3, 6)}
  </svg>`;
}

/** Длина выезда: станция наверху, улица внизу, между ними — выезд с меткой длины (чем длиннее, тем выше станция). */
export function drivewaySvg(len: number, max: number): string {
  const h = 4 + Math.round((Math.min(len, max) / max) * 14);
  const top = 22 - h;
  return `<svg viewBox="0 0 22 26" width="22" height="26">
    <rect x="0" y="21" width="22" height="5" fill="#646b76"/>
    <rect x="8" y="${top}" width="6" height="${h}" fill="#646b76"/>
    <rect x="3" y="${top - 5}" width="16" height="5" rx="1" fill="#f2efe8" stroke="#4f5965" stroke-width="0.9"/>
    <path d="M19.5 ${top + 0.5}V${21.5}M18 ${top + 0.5}H21M18 21.5H21" stroke="#2f80ed" stroke-width="1"/>
  </svg>`;
}

export function stationSvg(kind: 'road' | 'rail' | 'stop' | 'cargo' | 'pax', size = 40): string {
  if (kind === 'cargo') {
    // Автостанция для грузов: склад с воротами, ящики и грузовик у рампы.
    return `<svg viewBox="0 0 40 40" width="${size}" height="${size}">
      <rect x="2" y="27" width="36" height="11" rx="2" fill="#646b76"/>
      <rect x="5" y="5" width="22" height="16" rx="1.5" fill="#e9e2d2" stroke="#4f5965" stroke-width="1.4"/>
      <path d="M5 9H27" stroke="#8d6a43" stroke-width="2.4"/>
      <rect x="10" y="13" width="7" height="8" fill="#9aa1aa" stroke="#4f5965" stroke-width="1"/>
      <rect x="29" y="14" width="6" height="6" fill="#c99a5b" stroke="#7a5a3c" stroke-width="0.9"/>
      <rect x="31" y="8" width="5" height="5" fill="#d9a92b" stroke="#7a5a3c" stroke-width="0.9"/>
      <rect x="7" y="28.5" width="17" height="7" rx="1.2" fill="#c99a5b"/>
      <rect x="24" y="29.5" width="6" height="5" rx="1.2" fill="#e07b39"/>
    </svg>`;
  }
  if (kind === 'pax') {
    // Автовокзал: здание с навесом над платформами и автобус.
    return `<svg viewBox="0 0 40 40" width="${size}" height="${size}">
      <rect x="2" y="27" width="36" height="11" rx="2" fill="#646b76"/>
      <rect x="6" y="4" width="28" height="12" rx="1.5" fill="#f2efe8" stroke="#4f5965" stroke-width="1.4"/>
      <path d="M6 8H34" stroke="#2f80ed" stroke-width="2.4"/>
      <path d="M9 16V24M20 16V24M31 16V24" stroke="#4f5965" stroke-width="1.3"/>
      <rect x="6" y="22" width="28" height="3" fill="#cfd5dc"/>
      <rect x="7" y="28.5" width="22" height="7" rx="1.6" fill="#4a8fe7"/>
      <path d="M10 30.5H26" stroke="#e8f1fd" stroke-width="1.6" stroke-dasharray="3 1.5"/>
    </svg>`;
  }
  if (kind === 'stop') {
    // Навес у края улицы и знак с буквой «А»; у бордюра — автобус.
    return `<svg viewBox="0 0 40 40" width="${size}" height="${size}">
      <rect x="2" y="24" width="36" height="14" rx="2" fill="#646b76"/>
      <path d="M4 31H36" stroke="#f5f3e6" stroke-width="1" stroke-dasharray="4 3"/>
      <rect x="9" y="25.5" width="20" height="5.5" rx="2" fill="#e07b39"/>
      <rect x="6" y="13" width="18" height="7" rx="1.5" fill="#f2efe8" stroke="#4f5965" stroke-width="1.4"/>
      <path d="M31 21V8" stroke="#4f5965" stroke-width="1.6"/>
      <circle cx="31" cy="7" r="5" fill="#2f80ed"/>
      <text x="31" y="9.6" font-size="7.5" font-weight="700" text-anchor="middle" fill="#fff" font-family="system-ui, sans-serif">А</text>
    </svg>`;
  }
  if (kind === 'rail') {
    return `<svg viewBox="0 0 40 40" width="${size}" height="${size}">
      <rect x="6" y="5" width="28" height="11" rx="1.5" fill="#f2efe8" stroke="#4f5965" stroke-width="1.4"/>
      <path d="M6 9H34" stroke="#4f5965" stroke-width="2.4"/>
      <rect x="4" y="18" width="32" height="4" fill="#d9d4ca"/>
      <path d="M2 26H38M2 30H38M2 34H38M2 38H38" stroke="#5c6670" stroke-width="1.4"/>
      <path d="M6 24V40M12 24V40M18 24V40M24 24V40M30 24V40" stroke="#7a5a3c" stroke-width="1.6" opacity="0.6"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 40 40" width="${size}" height="${size}">
    <rect x="8" y="6" width="24" height="14" rx="1.5" fill="#f2efe8" stroke="#4f5965" stroke-width="1.4"/>
    <path d="M8 11H32" stroke="#4f5965" stroke-width="2.4"/>
    <rect x="2" y="26" width="36" height="12" rx="2" fill="#646b76"/>
    <path d="M4 32H36" stroke="#f5f3e6" stroke-width="1" stroke-dasharray="4 3"/>
    <path d="M20 20V26" stroke="#646b76" stroke-width="4"/>
  </svg>`;
}

/** Цвет светлее (k > 0 — к белому) или темнее (k < 0 — к чёрному); не #rrggbb — как есть. */
export function shadeHex(hex: string, k: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Длина силуэта машины в кнопке покупки, px: как длина самой машины. */
const ROAD_ART_LEN: Record<string, number> = { bus: 42, bus2: 56, bus3: 80, truck: 48, truck2: 60, truck3: 86 };
/** Низ колёс — земля силуэта. */
const GROUND = 23;
const STEEL = '#3a434d';
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Стёкла тёмные, а на тёмном кузове — светлые, чтобы окна было видно. */
export function glassFor(color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return '#2f3d4b';
  const n = parseInt(color.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum < 0.32 ? '#9fb3c6' : '#2f3d4b';
}

/** Колесо сбоку на земле: тёмная арка над ним, шина, диск и ступица. */
function sideWheel(x: number, r = 2.8): string {
  const cy = GROUND - r;
  const a = r + 0.8;
  return `<path d="M${x - a} ${cy}A${a} ${a} 0 0 1 ${x + a} ${cy}Z" fill="#000" fill-opacity="0.3"/>
    <circle cx="${x}" cy="${cy}" r="${r}" fill="#2b323b"/><circle cx="${x}" cy="${cy}" r="${round1(r * 0.48)}" fill="#c3cad2"/><circle cx="${x}" cy="${cy}" r="${round1(r * 0.16)}" fill="#6b7480"/>`;
}

/** Микроавтобус (как «Газель»): высокая крыша, капот, окна салона, сдвижная дверь. */
function microbusArt(L: number, color: string): string {
  const glass = glassFor(color);
  const line = shadeHex(color, -0.3);
  return `<path d="M1 5.2Q1 3 3.2 3H${L - 11}Q${L - 9} 3 ${L - 8} 4.4L${L - 4} 10.2Q${L - 0.6} 11 ${L} 13.4V18.8Q${L} 20 ${L - 1.2} 20H2.2Q1 20 1 18.8Z" fill="${color}"/>
    <path d="M3 5.6h5.4v5H3zM9.6 5.6h9.6v5H9.6zM20.8 5.6h${L - 33.6}v5H20.8z" fill="${glass}"/>
    <path d="M${L - 11.4} 5.6H${L - 8.4}L${L - 5} 10.6H${L - 11.4}Z" fill="${glass}"/>
    <path d="M20 4V18.2M${L - 12.4} 4V18.2" stroke="${line}" stroke-width="0.5"/>
    <path d="M1.4 13.4H${L - 13}" stroke="#fff" stroke-opacity="0.5" stroke-width="0.7"/>
    <rect x="${L - 2.2}" y="17.4" width="2.6" height="2.6" rx="0.6" fill="${STEEL}"/><rect x="0.4" y="17.4" width="2.4" height="2.6" rx="0.6" fill="${STEEL}"/>
    <rect x="${L - 1.6}" y="13.4" width="1.4" height="1.4" rx="0.5" fill="#ffe08a"/><rect x="0.6" y="9" width="0.9" height="2.6" fill="#d93a32"/>
    ${sideWheel(9.5, 3)}${sideWheel(L - 8.5, 3)}`;
}

/**
 * Городской автобус: большие окна, двери до пола, кондиционеры на крыше, колёса в арках.
 * joints — «гармошки» сочленённого: кузов делится на секции.
 */
function cityBusArt(L: number, color: string, opts: { doors: number[]; axles: number[]; ac: [number, number][]; joints?: number[]; tower?: boolean }): string {
  const glass = glassFor(color);
  const roof = shadeHex(color, -0.18);
  const panes: string[] = [];
  for (let x = 9; x < L - 6; x += 7) panes.push(`M${x} 5.6V12.8`);
  const door = (x: number) =>
    `<rect x="${round1(x - 2.1)}" y="5.8" width="4.2" height="13.4" fill="${glass}"/><path d="M${round1(x)} 5.8V19.2" stroke="${color}" stroke-width="0.5"/><path d="M${round1(x - 2.5)} 5.2V19.6M${round1(x + 2.5)} 5.2V19.6" stroke="${color}" stroke-width="0.8"/>`;
  const joint = (x: number) => {
    const ribs: string[] = [];
    for (let i = x - 2.2; i <= x + 2.2; i += 0.9) ribs.push(`M${round1(i)} 5V19.4`);
    return `<rect x="${round1(x - 2.6)}" y="4.6" width="5.2" height="15" fill="#22272d"/><path d="${ribs.join('')}" stroke="#4a525c" stroke-width="0.35"/>`;
  };
  return `${opts.ac.map(([a, b]) => `<rect x="${round1(a)}" y="2.4" width="${round1(b - a)}" height="2" rx="0.8" fill="${roof}"/>`).join('')}
    ${opts.tower ? `<rect x="1" y="2.6" width="4.6" height="2.4" rx="0.7" fill="${color}"/>` : ''}
    <path d="M1 6Q1 4 3 4H${L - 2.5}Q${L + 0.6} 4 ${L + 0.8} 7L${L + 1} 18.6Q${L + 1} 20 ${L - 0.4} 20H2.4Q1 20 1 18.6Z" fill="${color}"/>
    <rect x="3" y="5.8" width="${L - 5}" height="6.8" rx="0.6" fill="${glass}"/>
    <path d="${panes.join('')}" stroke="${color}" stroke-width="0.8"/>
    <path d="M${L - 1.8} 5.2H${L - 0.6}Q${L + 0.6} 5.5 ${L + 0.6} 7.5V15H${L - 1.8}Z" fill="${glass}"/>
    ${opts.doors.map(door).join('')}${(opts.joints ?? []).map(joint).join('')}
    <rect x="${L - 1.6}" y="17.6" width="2.6" height="2.4" rx="0.6" fill="${STEEL}"/><rect x="0.6" y="17.6" width="2.2" height="2.4" rx="0.6" fill="${STEEL}"/>
    <rect x="${L - 0.4}" y="15.6" width="1.3" height="1.4" rx="0.5" fill="#ffe08a"/><rect x="0.5" y="13.4" width="1" height="2.6" fill="#d93a32"/>
    ${opts.axles.map((x) => sideWheel(round1(x), 3)).join('')}`;
}

/** Автобусы: I — микроавтобус, II — городской, сочленённый — две секции с «гармошкой». */
function busArt(L: number, gen: number, color: string): string {
  if (gen === 1) return microbusArt(L, color);
  if (gen === 2) return cityBusArt(L, color, { doors: [L * 0.1, L * 0.52, L - 4], axles: [L * 0.24, L - 12], ac: [[L * 0.3, L * 0.48]] });
  return cityBusArt(L, color, {
    doors: [L * 0.1, L * 0.28, L * 0.69, L - 4],
    axles: [L * 0.19, L * 0.53, L * 0.85],
    ac: [
      [L * 0.14, L * 0.27],
      [L * 0.62, L * 0.76],
    ],
    joints: [L * 0.43],
    tower: true,
  });
}

/** Кабина над передней осью (кабовер), кабина справа: большое окно, дверь, тёмный низ с подножкой. */
function cabArt(x0: number, x1: number, top: number, color: string, spoiler?: number): string {
  const glass = glassFor(color);
  const line = shadeHex(color, -0.3);
  const bottom = 20;
  const deflector =
    spoiler === undefined
      ? ''
      : `<path d="M${x0 + 0.4} ${top + 0.5}V${spoiler + 1.2}Q${x0 + 0.4} ${spoiler} ${x0 + 1.8} ${spoiler}H${x0 + 3.5}Q${x1 - 3.5} ${spoiler} ${x1 - 2.2} ${top + 0.5}Z" fill="${shadeHex(color, -0.12)}"/>`;
  return `${deflector}<path d="M${x0} ${bottom}V${top + 1.5}Q${x0} ${top} ${x0 + 1.5} ${top}H${x1 - 2}Q${x1 - 0.4} ${top} ${x1 - 0.2} ${top + 2}L${x1} ${bottom}Z" fill="${color}"/>
    <path d="M${x1 - 6.4} ${top + 2}H${x1 - 1.6}L${x1 - 0.9} ${top + 6.6}H${x1 - 6.4}Z" fill="${glass}"/>
    <path d="M${x1 - 7.4} ${top + 1.4}V${bottom - 3.4}" stroke="${line}" stroke-width="0.5"/><path d="M${x1 - 6.6} ${top + 8}h1.4" stroke="${line}" stroke-width="0.6"/>
    <rect x="${x0}" y="${bottom - 3.4}" width="${x1 - x0}" height="3.4" fill="${STEEL}"/>
    <rect x="${x1 - 1.4}" y="${bottom - 4.8}" width="1.4" height="1.2" rx="0.4" fill="#ffe08a"/>`;
}

/** Кузов: фургон с рамкой по краю или тентованный — рейка поверху и ремни понизу. */
function cargoBoxArt(x0: number, x1: number, top: number, bottom: number, color: string, curtain: boolean): string {
  const frame = shadeHex(color, -0.25);
  let detail = '';
  if (curtain) {
    const straps: string[] = [];
    for (let x = x0 + 2.5; x < x1 - 1; x += 3.4) straps.push(`M${round1(x)} ${bottom - 1.6}V${bottom}`);
    detail = `<rect x="${x0}" y="${top}" width="${round1(x1 - x0)}" height="1" fill="${frame}"/>
      <path d="M${x0} ${bottom - 1.8}H${x1}" stroke="#fff" stroke-opacity="0.45" stroke-width="0.5"/>
      <path d="${straps.join('')}" stroke="${STEEL}" stroke-width="0.5"/>`;
  }
  return `<rect x="${x0}" y="${top}" width="${round1(x1 - x0)}" height="${bottom - top}" rx="0.6" fill="${color}" stroke="${frame}" stroke-width="0.6"/>${detail}
    <rect x="${x0 - 0.3}" y="${bottom - 1.6}" width="1" height="1.6" fill="#d93a32"/>`;
}

/**
 * Цистерна сбоку: цилиндр с выпуклыми днищами, блик вдоль, обручи, люки с мостиком поверху, лесенка сзади
 * и оранжевая табличка опасного груза.
 */
function tankSideArt(x0: number, x1: number, top: number, bottom: number, color: string): string {
  const h = bottom - top;
  const frame = shadeHex(color, -0.3);
  const rings: string[] = [];
  const n = Math.max(1, Math.round((x1 - x0) / 13));
  for (let k = 1; k <= n; k++) rings.push(`M${round1(x0 + ((x1 - x0) * k) / (n + 1))} ${round1(top + 0.4)}V${round1(bottom - 0.4)}`);
  const hatches: string[] = [];
  for (let k = 0; k < n + 1; k++) hatches.push(`<rect x="${round1(x0 + ((x1 - x0) * (k + 0.5)) / (n + 1) - 1.3)}" y="${round1(top - 1.3)}" width="2.6" height="1.5" rx="0.4" fill="${STEEL}"/>`);
  return `${hatches.join('')}<path d="M${x0 + 3} ${round1(top - 0.5)}H${x1 - 3}" stroke="${STEEL}" stroke-width="0.5"/>
    <rect x="${x0}" y="${top}" width="${round1(x1 - x0)}" height="${round1(h)}" rx="3" ry="${round1(h / 2)}" fill="${color}" stroke="${frame}" stroke-width="0.6"/>
    <path d="M${x0 + 2.5} ${round1(top + h * 0.28)}H${x1 - 2.5}" stroke="#fff" stroke-opacity="0.5" stroke-width="1.1" stroke-linecap="round"/>
    <path d="${rings.join('')}" stroke="${frame}" stroke-width="0.5"/>
    <path d="M${x0 + 1.6} ${round1(top + 1)}V${bottom + 0.6}M${x0 + 2.8} ${round1(top + 1)}V${bottom + 0.6}M${x0 + 1.6} ${round1(top + h * 0.45)}h1.2M${x0 + 1.6} ${round1(top + h * 0.75)}h1.2" stroke="${STEEL}" stroke-width="0.4"/>
    <rect x="${x0 + 4}" y="${round1(top + h * 0.5)}" width="3.4" height="2.4" rx="0.3" fill="#f39c12" stroke="#2b323b" stroke-width="0.35"/>`;
}

/** Рама под кузовом и защитная планка сбоку между колёсами. */
function chassisArt(x0: number, x1: number, y: number, guard?: [number, number]): string {
  return `<rect x="${x0}" y="${y}" width="${round1(x1 - x0)}" height="1.6" fill="${STEEL}"/>${
    guard ? `<path d="M${guard[0]} ${y + 2.4}H${guard[1]}" stroke="#aab3bc" stroke-width="0.7"/>` : ''
  }`;
}

/**
 * Грузовики, кабина справа: I — фургон на двух осях, II — тентованный с тремя задними осями
 * и передней под кабиной, фура — тягач на трёх осях с полуприцепом на трёх. tank — автоцистерна: вместо кузова цистерна.
 */
function truckArt(L: number, gen: number, color: string, tank = false): string {
  if (gen === 1) {
    return `${chassisArt(1.5, 36, 16.4, [15, 28])}<rect x="28" y="16.8" width="5" height="2.8" rx="0.6" fill="${STEEL}"/>
      ${tank ? tankSideArt(1, 33.6, 5, 16.8, color) : cargoBoxArt(1, 33.6, 2, 16.4, color, false)}${cabArt(34.6, L, 6.3, color, tank ? undefined : 3.3)}
      ${sideWheel(11.6, 3.1)}${sideWheel(39.6, 3.1)}`;
  }
  if (gen === 2) {
    return `${chassisArt(1.5, 48.5, 17, [23, 37])}
      ${tank ? tankSideArt(1, 47.8, 4.6, 17.2, color) : cargoBoxArt(1, 47.8, 2, 17, color, true)}${cabArt(48.6, L, 3.6, color)}
      ${[13.2, 19.2, 40.4, 53.8].map((x) => sideWheel(x, 2.7)).join('')}`;
  }
  // Полуприцеп лежит на седле тягача — над его задними осями; посередине — опорные стойки.
  return `${chassisArt(51, 75, 17.6)}<rect x="66" y="17.6" width="5.4" height="2.6" rx="1" fill="#aab3bc"/>
    ${chassisArt(3, 71.5, 16.6)}<path d="M45 18.2V21.6M43.8 21.8H46.2" stroke="${STEEL}" stroke-width="0.8"/>
    ${tank ? tankSideArt(1, 71.5, 4.2, 17, color) : cargoBoxArt(1, 71.5, 2, 16.6, color, true)}${cabArt(72.4, L, 3.8, color)}
    ${[14.3, 20.5, 26.7, 54.5, 61.5, 79.6].map((x) => sideWheel(x, 2.7)).join('')}`;
}

/** Поезд или автомобиль для кнопок покупки; автобус и грузовик — цвета маршрута; tank — грузовик автоцистерной. */
export function modelSvg(id: string, color?: string, w = 46, h = 22, tank = false): string {
  // Новые модели — на вагон длиннее или с полосой «II».
  const gen = /3$/.test(id) ? 3 : /2$/.test(id) ? 2 : 1;
  const len = ROAD_ART_LEN[id];
  if (len) {
    const bus = id.startsWith('bus');
    const art = bus ? busArt(len, gen, color ?? '#3b7dd8') : truckArt(len, gen, color ?? '#e07b39', tank);
    // Чуть крупнее значка: в карточке покупки видно окна, двери и колёса.
    return `<svg class="model-art" viewBox="0 0 ${len + 2} 24" width="${(len + 2) * 1.2}" height="${24 * 1.2}">${art}</svg>`;
  }
  // Остальное — поезда.
  const freight = id.startsWith('freightTrain');
  const cars: string[] = [];
  const n = 2 + gen;
  const cw = (w - 4) / n;
  for (let i = 0; i < n; i++) {
    const fill = i === 0 ? '#3a4651' : freight ? '#a0603c' : '#4a8fe7';
    cars.push(`<rect x="${2 + i * cw + 0.6}" y="7" width="${cw - 1.2}" height="${h - 14}" rx="1.5" fill="${fill}"/>`);
    if (!freight && i > 0) cars.push(`<path d="M${3 + i * cw} ${h / 2 - 1}H${i * cw + cw}" stroke="#fff" stroke-width="1.4" stroke-dasharray="1.6 1.2"/>`);
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="M1 ${h - 5}H${w - 1}" stroke="#5c6670" stroke-width="1.4"/>${cars.join('')}</svg>`;
}

/** Знак ограничения скорости. */
export function speedSign(kmh: number, size = 30): string {
  // Трёхзначные числа чуть уже, чтобы помещались в круг.
  const font = kmh >= 100 ? 10.5 : 12.5;
  return `<svg viewBox="0 0 30 30" width="${size}" height="${size}">
    <circle cx="15" cy="15" r="13" fill="#fff" stroke="#d93a32" stroke-width="3.2"/>
    <text x="15" y="${15 + font * 0.37}" text-anchor="middle" font-size="${font}" font-weight="800" letter-spacing="-0.4" font-family="system-ui, sans-serif" fill="#1f2933">${kmh}</text>
  </svg>`;
}

export function modeSvg(mode: DrawMode): string {
  const road = 'stroke="#646b76" stroke-width="5" stroke-linecap="round" fill="none"';
  const dot = (x: number, y: number) => `<circle cx="${x}" cy="${y}" r="3" fill="#fff" stroke="#2f80ed" stroke-width="1.6"/>`;
  let body: string;
  if (mode === 'straight') {
    body = `<path d="M6 28L42 8" ${road}/>${dot(6, 28)}${dot(42, 8)}`;
  } else if (mode === 'arc') {
    body = `<path d="M4 28H16" stroke="#9aa3ad" stroke-width="5" stroke-linecap="round"/>
      <path d="M16 28C30 28 40 20 42 6" ${road}/>${dot(16, 28)}${dot(42, 6)}
      <path d="M17 33H27" stroke="#2f80ed" stroke-width="1.3" stroke-dasharray="2 2"/>`;
  } else {
    body = `<path d="M6 28Q24 -4 42 26" ${road}/>
      <path d="M6 28L24 6L42 26" stroke="#2f80ed" stroke-width="1" stroke-dasharray="2 2" fill="none"/>
      <rect x="21" y="3" width="6" height="6" fill="#fff" stroke="#2f80ed" stroke-width="1.5"/>${dot(6, 28)}${dot(42, 26)}`;
  }
  return `<svg viewBox="0 0 48 36" width="48" height="36">${body}</svg>`;
}

/** Профиль высоты: как дорога идёт относительно земли. */
export function levelSvg(level: number): string {
  const ground = '#9bbf6f';
  const soil = '#c8a878';
  const road = '#4b525c';
  let body: string;
  if (level < 0) {
    body = `<rect x="0" y="12" width="48" height="24" fill="${soil}"/>
      <rect x="0" y="10" width="48" height="4" fill="${ground}"/>
      <path d="M2 10H8C12 10 13 24 18 24H30C35 24 36 10 40 10H46" stroke="${road}" stroke-width="3.5" fill="none"/>
      <path d="M17 18Q24 12 31 18V26H17Z" fill="#6b5a45"/>
      <path d="M18 24H30" stroke="#f5f3e6" stroke-width="0.8" stroke-dasharray="2 2"/>`;
  } else if (level === 0) {
    body = `<rect x="0" y="22" width="48" height="14" fill="${soil}"/>
      <rect x="0" y="20" width="48" height="4" fill="${ground}"/>
      <path d="M2 19H46" stroke="${road}" stroke-width="3.5"/>
      <path d="M6 19H42" stroke="#f5f3e6" stroke-width="0.8" stroke-dasharray="3 3"/>`;
  } else if (level === 1) {
    body = `<rect x="0" y="24" width="48" height="12" fill="${soil}"/>
      <rect x="0" y="22" width="48" height="4" fill="${ground}"/>
      <path d="M14 23H34V30H14Z" fill="#8cc3e6"/>
      <path d="M2 21C8 21 10 12 16 12H32C38 12 40 21 46 21" stroke="${road}" stroke-width="3.5" fill="none"/>
      <path d="M18 13V24M30 13V24" stroke="#8a9099" stroke-width="2.4"/>`;
  } else {
    body = `<rect x="0" y="27" width="48" height="9" fill="${soil}"/>
      <rect x="0" y="25" width="48" height="4" fill="${ground}"/>
      <path d="M2 24C8 24 10 6 16 6H32C38 6 40 24 46 24" stroke="${road}" stroke-width="3.5" fill="none"/>
      <path d="M17 8V26M24 8V26M31 8V26" stroke="#8a9099" stroke-width="2.4"/>`;
  }
  return `<svg viewBox="0 0 48 36" width="48" height="36"><rect width="48" height="36" fill="#e3edd2"/>${body}</svg>`;
}

/** Значок линии в списках: автобус, грузовик, автоцистерна или поезд сбоку, кузов — цвета линии. */
export function lineKindSvg(kind: 'bus' | 'truck' | 'tanker' | 'train', color: string, w = 20): string {
  const wheel = (x: number, r = 2) => `<circle cx="${x}" cy="12.6" r="${r}" fill="#2b323b" stroke="#fff" stroke-width="0.9"/>`;
  const glass = 'fill="#fff" fill-opacity="0.85"';
  let body: string;
  if (kind === 'bus') {
    body = `<rect x="1" y="2" width="22" height="10.5" rx="2.5" fill="${color}"/>
      <path d="M3.5 4.5h4v3.2h-4zM9 4.5h4v3.2H9zM14.5 4.5h3.5v3.2h-3.5zM19.5 4.5h1.8v5h-1.8z" ${glass}/>
      ${wheel(6)}${wheel(18)}`;
  } else if (kind === 'truck') {
    body = `<rect x="1" y="2" width="14" height="9.5" rx="1.2" fill="${color}"/>
      <path d="M16 5h4.2l2.8 3.4v3.6H16z" fill="${color}"/>
      <path d="M17.2 6.2h2.5l1.7 2.1h-4.2z" ${glass}/>
      <path d="M1 11.5h22" stroke="#2b323b" stroke-width="1"/>
      ${wheel(5)}${wheel(10)}${wheel(19.5)}`;
  } else if (kind === 'tanker') {
    // Цистерна — цилиндр с круглыми днищами и бликом, за ней кабина.
    body = `<rect x="1" y="3.2" width="14.4" height="8" rx="2.6" ry="4" fill="${color}"/>
      <path d="M3.2 5.4h10" stroke="#fff" stroke-opacity="0.6" stroke-width="1" stroke-linecap="round"/>
      <path d="M16 5h4.2l2.8 3.4v3.6H16z" fill="${color}"/>
      <path d="M17.2 6.2h2.5l1.7 2.1h-4.2z" ${glass}/>
      <path d="M1 11.5h22" stroke="#2b323b" stroke-width="1"/>
      ${wheel(5)}${wheel(10)}${wheel(19.5)}`;
  } else {
    body = `<path d="M1 3h16.5c3 0 5.5 2.5 5.5 5.5V12H1z" fill="${color}"/>
      <path d="M3 5h3v3H3zM7.8 5h3v3h-3zM12.6 5h3v3h-3zM18 5.1c1.6.4 2.8 1.5 3.2 2.9H18z" ${glass}/>
      <path d="M0.5 15.3h23" stroke="#9aa3ad" stroke-width="1"/>
      ${wheel(4.5, 1.6)}${wheel(8.5, 1.6)}${wheel(15, 1.6)}${wheel(19, 1.6)}`;
  }
  return `<svg class="line-kind" viewBox="0 0 24 16" width="${w}" height="${(w * 2) / 3}">${body}</svg>`;
}

/** Папка линий: открытая — с откинутой крышкой. */
export function folderSvg(size = 16, open = false): string {
  const lid = open
    ? '<path d="M4.5 10.5h17l-2.6 9H2z" fill="#f6cf6b" stroke="#c99a2e" stroke-width="1.2" stroke-linejoin="round"/>'
    : '<path d="M2 9h20v9.5a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18.5z" fill="#f6cf6b" stroke="#c99a2e" stroke-width="1.2" stroke-linejoin="round"/>';
  return `<svg class="folder-ic" viewBox="0 0 24 24" width="${size}" height="${size}">
    <path d="M2 6.5A1.5 1.5 0 0 1 3.5 5h5l2 2h10A1.5 1.5 0 0 1 22 8.5V18.5a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18.5z" fill="#e9b52f" stroke="#c99a2e" stroke-width="1.2" stroke-linejoin="round"/>
    ${lid}</svg>`;
}

/** Авто-парк: шестерёнка, в ней «+» и «−» — игра сама докупает и продаёт транспорт. */
export function autoSvg(size = 18): string {
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const x = (10 + Math.cos(a) * 7.4).toFixed(2);
    const y = (10 + Math.sin(a) * 7.4).toFixed(2);
    return `<rect x="${Number(x) - 1.7}" y="${Number(y) - 1.7}" width="3.4" height="3.4" rx="0.7" transform="rotate(${i * 45} ${x} ${y})"/>`;
  }).join('');
  return `<svg class="auto-ic" viewBox="0 0 20 20" width="${size}" height="${size}"><g fill="#2f80ed">${teeth}<circle cx="10" cy="10" r="6.6"/></g>
    <path d="M7 8.2h3M8.5 6.7v3M10 12.2h3" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/></svg>`;
}

/**
 * Модернизация в авто-парке: кольцо из двух стрелок (замена) и стрелка вверх (модель новее). Выключена —
 * серая и перечёркнута.
 */
export function renewSvg(on: boolean, size = 18): string {
  const c = on ? '#3fae6a' : '#9aa3ad';
  const arrows = `<path d="M4.6 7.2A6 6 0 0 1 15 6.2" /><path d="M15.4 12.8A6 6 0 0 1 5 13.8" />`;
  const heads = `<path d="M15.8 2.8v3.8H12z" fill="${c}" stroke="none"/><path d="M4.2 17.2v-3.8H8z" fill="${c}" stroke="none"/>`;
  const up = `<path d="M10 13.6V6.6M7.2 9.2 10 6.4l2.8 2.8" stroke-width="1.9"/>`;
  const strike = on ? '' : `<path d="M3 17 17 3" stroke="#e5534b" stroke-width="1.8"/>`;
  return `<svg class="renew-ic" viewBox="0 0 20 20" width="${size}" height="${size}"><g fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${arrows}${heads}${up}${strike}</g></svg>`;
}

const DROP_FILL = '#5aa9e6';
const DROP_STROKE = '#2f7fc4';

/** Контур капли: круглое дно радиуса r с центром (cx, cy), острый кончик сверху. */
function dropPath(cx: number, cy: number, r: number): string {
  const top = cy - 1.9 * r;
  return `M${cx} ${top}Q${cx + r} ${cy - 0.6 * r} ${cx + r} ${cy}A${r} ${r} 0 0 1 ${cx - r} ${cy}Q${cx - r} ${cy - 0.6 * r} ${cx} ${top}Z`;
}

/** Сколько воды на карте: почти пустая капля, одна капля, две капли. */
export function waterSvg(amount: WaterAmount, size = 22): string {
  const drop = (cx: number, cy: number, r: number) =>
    `<path d="${dropPath(cx, cy, r)}" fill="${DROP_FILL}" stroke="${DROP_STROKE}" stroke-width="1.2" stroke-linejoin="round"/>`;
  let body: string;
  if (amount === 'dry') {
    // Пустая капля, вода только на донышке.
    const [cx, cy, r, h] = [12, 14.5, 5.5, 3];
    const w = Math.sqrt(r * r - h * h);
    body = `<path d="${dropPath(cx, cy, r)}" fill="#fff"/>
      <path d="M${cx - w} ${cy + h}A${r} ${r} 0 0 0 ${cx + w} ${cy + h}Z" fill="${DROP_FILL}"/>
      <path d="${dropPath(cx, cy, r)}" fill="none" stroke="${DROP_STROKE}" stroke-width="1.2" stroke-linejoin="round"/>`;
  } else if (amount === 'normal') {
    body = drop(12, 14.5, 5.5);
  } else {
    // Две капли рядом, правая заходит на левую.
    body = `${drop(8.2, 14.3, 5)}${drop(15.8, 14.3, 5)}`;
  }
  return `<svg class="ng-ic" viewBox="0 0 24 24" width="${size}" height="${size}">${body}</svg>`;
}

/** Рельеф местности в профиль: ровное поле, холмы, горы со снежными вершинами. */
export function reliefSvg(relief: Relief, size = 22): string {
  let body: string;
  if (relief === 'plains') {
    body = '<path d="M1.5 20V15Q12 13.6 22.5 15V20Z" fill="#b5cf8e" stroke="#7c9a5c" stroke-width="1.2" stroke-linejoin="round"/>';
  } else if (relief === 'hills') {
    body = '<path d="M1.5 20C3.5 13 8 10 11.5 15.5C14 9 20 8.5 22.5 20Z" fill="#b5cf8e" stroke="#7c9a5c" stroke-width="1.2" stroke-linejoin="round"/>';
  } else {
    body = `<path d="M1.5 20L7 10L10 14L15 4L22.5 20Z" fill="#a39a8f" stroke="#6e655c" stroke-width="1.2" stroke-linejoin="round"/>
      <path class="snow" d="M15 4L17.25 8.8L16.1 8.2L15 9.3L13.8 8.3L12.6 8.8Z" fill="#fff"/>
      <path class="snow" d="M7 10L8.8 12.4L7.8 12L6.9 12.8L5.68 12.4Z" fill="#fff"/>`;
  }
  return `<svg class="ng-ic" viewBox="0 0 24 24" width="${size}" height="${size}">${body}</svg>`;
}

/** Ель силуэтом: вершина в (x, y), высота h. */
const fir = (x: number, y: number, h: number, color: string) =>
  `<path d="M${x} ${y}L${x + h * 0.36} ${y + h * 0.55}H${x + h * 0.2}L${x + h * 0.42} ${y + h}H${x - h * 0.42}L${x - h * 0.2} ${y + h * 0.55}H${x - h * 0.36}Z" fill="${color}"/>`;
/** Лиственное дерево: крона на стволе. */
const leafy = (x: number, y: number, r: number, color: string) =>
  `<path d="M${x} ${y + r}v${r * 0.9}" stroke="#7b5e4c" stroke-width="1.2"/><circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`;

/** Пейзаж биома в профиль (64×44): по нему биом узнаётся раньше, чем прочтёшь название. */
export function biomeSvg(id: BiomeId, w = 64, h = 44): string {
  const sky = '<rect width="64" height="44" fill="#e9f2f6"/>';
  let body: string;
  if (id === 'temperate') {
    body = `<path d="M0 30Q16 18 34 27T64 24V44H0Z" fill="#bcd59a"/><path d="M0 36Q30 30 64 34V44H0Z" fill="#cfe0ae"/>
      <path d="M22 44Q30 37 46 35" stroke="#8cc3e6" stroke-width="3.4" fill="none" stroke-linecap="round"/>
      ${leafy(10, 27, 4, '#7aa55a')}${leafy(17, 30, 3.2, '#8fb46a')}${leafy(52, 25, 3.6, '#6e9a52')}`;
  } else if (id === 'taiga') {
    body = `<path d="M0 28Q20 20 40 26T64 22V44H0Z" fill="#8fb07c"/><path d="M0 36Q32 32 64 35V44H0Z" fill="#a9c49a"/>
      <ellipse cx="38" cy="39" rx="12" ry="3" fill="#8cc3e6"/>
      ${[
        [6, 16, 14],
        [13, 19, 12],
        [20, 15, 15],
        [50, 14, 14],
        [57, 17, 13],
        [27, 21, 10],
      ]
        .map(([x, y, s], k) => fir(x, y, s, k % 2 ? '#46704a' : '#3f6844'))
        .join('')}`;
  } else if (id === 'steppe') {
    body = `<circle cx="50" cy="12" r="5" fill="#f2c94c"/><path d="M0 32Q32 29.5 64 31V44H0Z" fill="#e2d79a"/>
      <path d="M0 38Q32 35 64 37V44H0Z" fill="#d8c983"/>
      <path d="M8 36l1-3M10 36l-.6-3.4M44 34l1-3M46 34l-.6-3.4M30 40l1-3" stroke="#a8a060" stroke-width="0.9" stroke-linecap="round"/>
      ${leafy(20, 27, 2.6, '#9cae6a')}`;
  } else if (id === 'mountains') {
    body = `<path d="M-2 36L14 12L22 22L34 6L48 26L54 18L66 34V44H-2Z" fill="#a39a8f"/>
      <path d="M34 6L38.4 12.4L36 11.4L34 13.4L31.8 11.6L29.6 12.6ZM14 12L17.2 16.8L15.4 16L14 17.4L12.4 16.2L10.8 16.8Z" fill="#fff"/>
      <path d="M0 38Q32 32 64 37V44H0Z" fill="#b7cc9c"/>${fir(8, 30, 9, '#577f50')}${fir(56, 30, 9, '#5f8c55')}${fir(46, 32, 7, '#4d7448')}`;
  } else {
    body = `<circle cx="14" cy="12" r="5" fill="#f2b84c"/><path d="M0 32Q14 24 30 31T64 28V44H0Z" fill="#e8cf96"/>
      <path d="M0 38Q20 32 40 37T64 36V44H0Z" fill="#dcbc7c"/>
      <ellipse cx="46" cy="38.5" rx="7" ry="2" fill="#8cc3e6"/>
      <path d="M50 37V29M50 29l-4 1.6M50 29l4 1.4M50 29l-2.6-3M50 29l2.8-2.8" stroke="#6e9a52" stroke-width="1.3" stroke-linecap="round" fill="none"/>`;
  }
  return `<svg class="map-mini" viewBox="0 0 64 44" width="${w}" height="${h}"><clipPath id="bm-${id}"><rect width="64" height="44" rx="6"/></clipPath><g clip-path="url(#bm-${id})">${sky}${body}</g></svg>`;
}
