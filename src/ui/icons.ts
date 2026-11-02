import type { Vec } from '../core/vec';
import type { DrawMode } from '../game/build';
import type { Fragment } from '../lanes/fragment';
import { isDivided, isOneWay, isTrunk, RoadSpec } from '../world/roadTypes';


function arrow(x: number, y: number, dir: 1 | -1, color: string): string {
  const tip = x + 5 * dir;
  return `<path d="M${x - 5 * dir} ${y}H${tip}" stroke="${color}" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M${tip + 2.5 * dir} ${y}L${tip - 1 * dir} ${y - 3}L${tip - 1 * dir} ${y + 3}Z" fill="${color}"/>`;
}

/** Вид дороги сверху: полосы, разметка и стрелки направления. */
export function roadSvg(spec: RoadSpec, w = 84, h = 40): string {
  if (spec.cls === 'rail') return railSvg(w, h);
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

/** Ж/д станция сверху: n путей с платформами между ними. */
export function platformsSvg(n: number): string {
  const gap = 28 / n;
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const y = 6 + i * gap + gap / 2;
    rows.push(`<path d="M2 ${y}H46" stroke="#b9b1a6" stroke-width="3.6"/><path d="M2 ${y - 1}H46M2 ${y + 1}H46" stroke="#4f5965" stroke-width="0.6"/>`);
    if (i < n - 1) rows.push(`<rect x="10" y="${y + 2.2}" width="28" height="${gap - 4.4}" rx="1" fill="#e4dfd4"/>`);
  }
  return `<svg viewBox="0 0 48 36" width="48" height="36">${rows.join('')}</svg>`;
}

/** Автостанция сверху: навес и n постов погрузки, занятые — оранжевые (как на карте). */
export function baysSvg(n: number, busy = 0, h = 22): string {
  const bw = 7;
  const w = 6 + n * bw;
  const slots = Array.from(
    { length: n },
    (_, i) => `<rect x="${3.5 + i * bw}" y="9" width="${bw - 1.5}" height="${h - 12}" rx="1" fill="${i < busy ? '#e07b39' : '#d5d2c8'}"/>`,
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

/** Копия: перекрёсток в синей рамке и его повёрнутая копия. */
export function copySvg(w = 48, h = 36): string {
  const cross = `<path d="M-9 0H9M0 -9V9" stroke="#646b76" stroke-width="4"/><rect x="-11" y="-11" width="22" height="22" rx="1.5" fill="rgba(47,128,237,0.12)" stroke="#2f80ed" stroke-width="1.5" stroke-dasharray="3 2"/>`;
  return `<svg viewBox="0 0 48 36" width="${w}" height="${h}">
    <g transform="translate(14 14)">${cross}</g>
    <g transform="translate(33 22) rotate(30)">${cross}</g>
    <path d="M24 6A12 12 0 0 1 36 10" stroke="#2f80ed" stroke-width="1.6" fill="none"/><path d="M36 10l-4 0.5M36 10l-1-4" stroke="#2f80ed" stroke-width="1.6"/>
  </svg>`;
}

/** Схема куска дорог (свой шаблон, скопированное): оси полотен, магистрали толще. */
export function fragmentSvg(frag: Fragment, w = 64, h = 48): string {
  const pad = 3;
  const k = Math.min((w - pad * 2) / (frag.half.x * 2), (h - pad * 2) / (frag.half.y * 2));
  const at = (p: Vec) => `${(w / 2 + p.x * k).toFixed(1)} ${(h / 2 + p.y * k).toFixed(1)}`;
  const width: Record<string, number> = { motorway: 3.4, highway: 3, avenue: 2.4, street: 1.6 };
  const paths = [...frag.corridors]
    .sort((a, b) => (width[a.cls] ?? 2) - (width[b.cls] ?? 2))
    .map((c) => {
      const { p0, p1, p2, p3 } = c.curve;
      const color = c.cls === 'motorway' || c.cls === 'highway' ? '#646b76' : '#7a828e';
      return `<path d="M${at(p0)}C${at(p1)} ${at(p2)} ${at(p3)}" stroke="${color}" stroke-width="${width[c.cls] ?? 2}" fill="none" stroke-linecap="round"/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${paths}</svg>`;
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

export function stationSvg(kind: 'road' | 'rail' | 'stop', size = 40): string {
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

/** Поезд или автомобиль для кнопок покупки. */
export function modelSvg(id: string, w = 46, h = 22): string {
  const body = (color: string) => `<rect x="2" y="6" width="${w - 4}" height="${h - 12}" rx="3" fill="${color}"/>`;
  // Новые модели — на вагон длиннее или с полосой «II».
  const gen = /3$/.test(id) ? 3 : /2$/.test(id) ? 2 : 1;
  if (id.startsWith('freightTrain') || id.startsWith('passengerTrain')) {
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
  if (id.startsWith('bus')) {
    const stripe = gen > 1 ? `<path d="M3 ${h - 7}H${w - 3}" stroke="#f0cd60" stroke-width="1.4"/>` : '';
    const joint = gen === 3 ? `<path d="M${w / 2} 6V${h - 6}" stroke="#2a5aa0" stroke-width="1.4"/>` : '';
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body('#3b7dd8')}
      <path d="M6 ${h / 2 - 1}H${w - 10}" stroke="#fff" stroke-width="2" stroke-dasharray="3 2"/>${stripe}${joint}</svg>`;
  }
  if (gen > 1) {
    const cab = 10;
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body('#e07b39')}
      <rect x="4" y="7.5" width="${w - 4 - cab - 3}" height="${h - 15}" fill="#f4efe6"/>${gen === 3 ? `<path d="M${(w - cab) / 2} 7V${h - 7}" stroke="#c9c2b4" stroke-width="1"/>` : ''}</svg>`;
  }
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body('#e07b39')}
    <rect x="4" y="7.5" width="${w - 16}" height="${h - 15}" fill="#f4efe6"/></svg>`;
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

/** Значок линии в списках: автобус, грузовик или поезд сбоку, кузов — цвета линии. */
export function lineKindSvg(kind: 'bus' | 'truck' | 'train', color: string, w = 20): string {
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
