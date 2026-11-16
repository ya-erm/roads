import { hash } from '../core/math';
import { Art, disc, shade } from './industryArt';

/**
 * Мелочи городского благоустройства — общие для дворов (houseArt.ts) и парков (parkArt.ts): дорожки, клумбы, фонтан,
 * памятник, обелиск, скамейки, фонари, детская площадка, спортивная коробка, мусорная площадка. Рисуются в осях
 * сцены (Art) в её проходах: земля (0) → общая тень (1) → то, что над землёй (2). Деталь — по зуму: lod 0 — почти
 * ничего, lod 1 — пятна, lod 2 (a.d) — края, разметка, скамейки; fine — фонари, струи, качели, контейнеры.
 * Без ctx.filter и размытия — всё уходит в плитки кэша карты.
 */

export const GRAVEL = 'rgba(214,200,168,0.95)';
export const GRAVEL_EDGE = 'rgba(160,146,116,0.55)';
export const PAVING = 'rgba(196,186,170,0.92)';
export const STONE = '#cfc6b2';
export const WATER = '#7fb6d9';
export const BRONZE = '#5f5a4c';
export const WOOD = '#9b7b55';
const FLOWERS = ['#e0525e', '#f2c14e', '#b768c9', '#f08a3c', '#f6f1e6', '#e86fa8', '#5b8fd6'];
const BOX_COLORS = ['#7fae6a', '#c9764f', '#5f8fbf', '#7aa3a0'];

/** Ломаная из точек (x, y по очереди) — дорожка, вдоль которой сажают и ставят скамейки. */
export type Path = number[];

/** Квадратичная кривая от (x0, y0) через изгиб (cx, cy) к (x1, y1) — ломаной через шаг ~2 м. */
export function curve(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): Path {
  const L = Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy);
  const n = Math.max(4, Math.ceil(L / 2));
  const out: Path = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1);
  }
  return out;
}

/** Замкнутый овал (rx, ry) с волной wob — круговая дорожка парка. */
export function loop(x: number, y: number, rx: number, ry: number, wob: number, seed: number): Path {
  const n = Math.max(16, Math.ceil((Math.PI * (rx + ry)) / 2.2));
  const out: Path = [];
  const ph = hash(seed, 1) * Math.PI * 2;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + wob * Math.sin(a * 2 + ph);
    out.push(x + Math.cos(a) * rx * k, y + Math.sin(a) * ry * k);
  }
  return out;
}

/** Расстояние от точки до ломаной. */
export function pathDist(p: Path, x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i];
    const ay = p[i + 1];
    const bx = p[i + 2] - ax;
    const by = p[i + 3] - ay;
    const l2 = bx * bx + by * by;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - bx * t, y - ay - by * t));
  }
  return best;
}

function trace(c: CanvasRenderingContext2D, p: Path): void {
  c.moveTo(p[0], p[1]);
  for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
}

/** Дорожки (проход земли): ближе — с тёмной кромкой; издали (lod 0) — только у широких. */
export function paths(a: Art, list: readonly Path[], w: number, color = GRAVEL, edge = GRAVEL_EDGE): void {
  if (a.pass !== 0 || (!a.lod && w < 3)) return;
  const c = a.c;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (a.d) {
    c.strokeStyle = edge;
    c.lineWidth = w + 0.7;
    c.beginPath();
    for (const p of list) trace(c, p);
    c.stroke();
  }
  c.strokeStyle = color;
  c.lineWidth = w;
  c.beginPath();
  for (const p of list) trace(c, p);
  c.stroke();
  c.lineCap = 'butt';
  c.lineJoin = 'miter';
}

/** Точка и направление на ломаной через долю t длины (0…1). */
export function along(p: Path, t: number): { x: number; y: number; ux: number; uy: number } {
  let total = 0;
  for (let i = 0; i + 3 < p.length; i += 2) total += Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
  let want = total * t;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const dx = p[i + 2] - p[i];
    const dy = p[i + 3] - p[i + 1];
    const l = Math.hypot(dx, dy);
    if (want <= l || i + 4 >= p.length - 1) {
      const k = l > 0 ? Math.min(1, want / l) : 0;
      return { x: p[i] + dx * k, y: p[i + 1] + dy * k, ux: l > 0 ? dx / l : 1, uy: l > 0 ? dy / l : 0 };
    }
    want -= l;
  }
  return { x: p[0], y: p[1], ux: 1, uy: 0 };
}

/** Скамейка со спинкой вдоль (ux, uy); спинка — со стороны side (±1 по нормали). Только вблизи. */
export function bench(a: Art, x: number, y: number, ux: number, uy: number, side = 1): void {
  if (a.pass !== 2 || !a.d) return;
  const c = a.c;
  const nx = -uy * side;
  const ny = ux * side;
  c.lineCap = 'butt';
  c.strokeStyle = WOOD;
  c.lineWidth = 0.5;
  c.beginPath();
  c.moveTo(x - ux * 0.95, y - uy * 0.95);
  c.lineTo(x + ux * 0.95, y + uy * 0.95);
  c.stroke();
  c.strokeStyle = '#5e4630';
  c.lineWidth = 0.22;
  c.beginPath();
  c.moveTo(x - ux * 0.95 + nx * 0.36, y - uy * 0.95 + ny * 0.36);
  c.lineTo(x + ux * 0.95 + nx * 0.36, y + uy * 0.95 + ny * 0.36);
  c.stroke();
}

/**
 * Фонари пока выключены: освещение вернётся вместе с ночным режимом (тогда — и свет от них). Места под фонари в
 * раскладке парков, площадей и улиц остаются.
 */
export const LAMPS_ON = false;

/** Фонарь: столб с тенью и светлым плафоном — только совсем вблизи (fine). */
export function lamp(a: Art, x: number, y: number, fine: boolean): void {
  if (!fine || !LAMPS_ON) return;
  if (a.pass === 1) return a.capsule(x, y, 0.13, 4.5);
  if (a.pass !== 2) return;
  const c = a.c;
  c.fillStyle = 'rgba(255,238,170,0.28)';
  disc(c, x, y, 0.95);
  c.fillStyle = '#454a50';
  disc(c, x, y, 0.32);
  c.fillStyle = '#fff4c8';
  disc(c, x, y, 0.19);
}

function oval(c: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0): void {
  c.beginPath();
  c.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2);
  c.fill();
}

/** Клумба: зелёная кайма, цветы двух цветов, вблизи — россыпь третьего. seed — какие цвета. */
export function flowerbed(a: Art, x: number, y: number, rx: number, ry: number, seed: number, fine: boolean, rot = 0): void {
  if (a.pass !== 0 || !a.lod) return;
  const c = a.c;
  const k = Math.floor(hash(seed, 1) * FLOWERS.length);
  const c1 = FLOWERS[k];
  const c2 = FLOWERS[(k + 2 + Math.floor(hash(seed, 2) * 3)) % FLOWERS.length];
  if (a.d) {
    c.fillStyle = '#c9c1ae';
    oval(c, x, y, rx + 0.35, ry + 0.35, rot);
  }
  c.fillStyle = '#5e8f45';
  oval(c, x, y, rx, ry, rot);
  c.fillStyle = c1;
  oval(c, x, y, rx * 0.74, ry * 0.74, rot);
  if (!a.d) return;
  c.fillStyle = c2;
  oval(c, x, y, rx * 0.4, ry * 0.4, rot);
  if (!fine) return;
  c.fillStyle = FLOWERS[(k + 4) % FLOWERS.length];
  const n = Math.max(6, Math.round((rx + ry) * 2.2));
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const ex = Math.cos(t) * rx * 0.58;
    const ey = Math.sin(t) * ry * 0.58;
    disc(c, x + ex * Math.cos(rot) - ey * Math.sin(rot), y + ex * Math.sin(rot) + ey * Math.cos(rot), 0.22);
  }
}

/**
 * Фонтан: каменный бортик, чаша с водой, в середине — вторая чаша; вблизи — круги на воде, совсем вблизи — струи.
 * Издали — синее пятно. Анимация (если есть) — поверх, в renderer.drawMotion; здесь — неподвижное.
 */
export function fountain(a: Art, x: number, y: number, r: number, fine: boolean): void {
  const c = a.c;
  if (a.pass === 1) {
    if (a.d) a.capsule(x, y, r * 0.3, 1.4);
    return;
  }
  if (a.pass === 0) {
    c.fillStyle = STONE;
    disc(c, x, y, r);
    c.fillStyle = WATER;
    disc(c, x, y, r * 0.84);
    if (!a.d) return;
    c.fillStyle = '#9acbe6';
    disc(c, x - r * 0.12, y - r * 0.12, r * 0.6);
    c.strokeStyle = 'rgba(255,255,255,0.55)';
    c.lineWidth = 0.18;
    c.beginPath();
    c.arc(x, y, r * 0.66, 0, Math.PI * 2);
    c.stroke();
    return;
  }
  if (a.pass !== 2 || !a.lod) return;
  c.fillStyle = STONE;
  disc(c, x, y, r * 0.3);
  c.fillStyle = WATER;
  disc(c, x, y, r * 0.22);
  if (!fine) return;
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = 0.16;
  c.beginPath();
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    c.moveTo(x + Math.cos(t) * r * 0.32, y + Math.sin(t) * r * 0.32);
    c.lineTo(x + Math.cos(t) * r * 0.55, y + Math.sin(t) * r * 0.55);
  }
  c.stroke();
  c.fillStyle = '#ffffff';
  disc(c, x, y, r * 0.09);
}

/** Памятник: гранитный постамент со ступенью и бронзовая фигура; тень — длинная. s — сторона постамента. */
export function statue(a: Art, x: number, y: number, s: number): void {
  if (a.pass === 1) {
    if (!a.lod) return;
    a.rectShadow(x - s / 2, y - s / 2, s, s, 2.4);
    a.capsule(x, y, s * 0.2, 6);
    return;
  }
  if (a.pass !== 2) return;
  const c = a.c;
  if (a.d) {
    c.fillStyle = '#b9b6ad';
    c.fillRect(x - s / 2 - 0.5, y - s / 2 - 0.5, s + 1, s + 1);
  }
  c.fillStyle = '#8f8d87';
  c.fillRect(x - s / 2, y - s / 2, s, s);
  if (a.d) {
    c.fillStyle = '#a9a7a0';
    c.fillRect(x - s / 2 + 0.3, y - s / 2 + 0.3, s - 0.6, s - 0.6);
  }
  c.fillStyle = BRONZE;
  disc(c, x, y, s * 0.26);
  if (a.d) {
    c.fillStyle = shade(BRONZE, 0.35);
    disc(c, x + a.lx * s * 0.08, y + a.ly * s * 0.08, s * 0.12);
  }
}

/**
 * Обелиск (стела): четырёхгранная игла на ступенчатом основании — грани к свету светлее, тень длинная; вблизи —
 * звезда на вершине и вечный огонь перед ним (flame), венки по бокам.
 */
export function obelisk(a: Art, x: number, y: number, s: number, z: number, flame: boolean, fine: boolean): void {
  const c = a.c;
  if (a.pass === 0) {
    if (!a.lod) return;
    c.fillStyle = '#bdb6a6';
    c.fillRect(x - s * 1.6, y - s * 1.6, s * 3.2, s * 3.2);
    if (a.d) {
      c.fillStyle = '#cfc8b8';
      c.fillRect(x - s * 1.15, y - s * 1.15, s * 2.3, s * 2.3);
    }
    return;
  }
  if (a.pass === 1) {
    if (a.lod) a.rectShadow(x - s / 2, y - s / 2, s, s, z);
    return;
  }
  if (a.pass !== 2) return;
  const h = s / 2;
  const face = (nx: number, ny: number) => shade('#e4ddd0', Math.round((nx * a.lx + ny * a.ly) * 4) / 4 * 0.18 - 0.04);
  const tri = (pts: number[], color: string) => {
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(pts[0], pts[1]);
    c.lineTo(pts[2], pts[3]);
    c.lineTo(x, y);
    c.closePath();
    c.fill();
  };
  tri([x - h, y - h, x + h, y - h], face(0, -1));
  tri([x + h, y - h, x + h, y + h], face(1, 0));
  tri([x + h, y + h, x - h, y + h], face(0, 1));
  tri([x - h, y + h, x - h, y - h], face(-1, 0));
  if (!a.d) return;
  if (fine) {
    c.fillStyle = '#d64541';
    disc(c, x, y, 0.28);
  }
  if (!flame) return;
  // Вечный огонь — звезда на плите перед обелиском (со стороны −y).
  const fy = y - s * 1.35;
  c.fillStyle = '#6d6a63';
  disc(c, x, fy, 0.75);
  if (fine) {
    c.fillStyle = '#f2a33a';
    disc(c, x, fy, 0.38);
    c.fillStyle = '#ffd66b';
    disc(c, x, fy, 0.18);
    // Венки по бокам плиты.
    c.strokeStyle = '#3f7a3a';
    c.lineWidth = 0.3;
    for (const sx of [-1, 1]) {
      c.beginPath();
      c.arc(x + sx * s * 0.95, fy + 0.3, 0.45, 0, Math.PI * 2);
      c.stroke();
    }
  }
}

/**
 * Детская площадка в квадрате s×s (x, y — левый верхний угол): мягкое покрытие и песок; вблизи — песочница с
 * бортиком, горка, качели и карусель; раскладка — по seed.
 */
export function playground(a: Art, x: number, y: number, s: number, seed: number, fine: boolean): void {
  if (!a.lod) return;
  const c = a.c;
  const flip = hash(seed, 1) < 0.5;
  const px = (u: number) => (flip ? x + s - u * s : x + u * s);
  const py = (v: number) => y + v * s;
  const box = (u: number, v: number, w: number, h: number) => [Math.min(px(u), px(u + w)), py(v), w * s, h * s] as const;
  if (a.pass === 0) {
    c.fillStyle = 'rgba(206,104,84,0.5)';
    c.beginPath();
    c.roundRect(x, y, s, s, Math.min(1.2, s * 0.12));
    c.fill();
    if (!a.d) return;
    // Песочница: деревянный бортик, песок.
    const [sx, sy, sw, sh] = box(0.08, 0.1, 0.34, 0.34);
    c.fillStyle = WOOD;
    c.fillRect(sx, sy, sw, sh);
    c.fillStyle = '#ecd9a0';
    c.fillRect(sx + 0.3, sy + 0.3, sw - 0.6, sh - 0.6);
    // Резиновое покрытие под качелями.
    const [qx, qy, qw, qh] = box(0.52, 0.08, 0.4, 0.38);
    c.fillStyle = 'rgba(88,140,190,0.55)';
    c.fillRect(qx, qy, qw, qh);
    return;
  }
  if (a.pass === 1) {
    if (!a.d) return;
    const [hx, hy, hw, hh] = box(0.12, 0.58, 0.18, 0.32);
    a.rectShadow(hx, hy, hw, hh * 0.35, 2.2);
    return;
  }
  if (a.pass !== 2 || !a.d) return;
  // Горка: площадка с крышей-домиком и скат.
  const [hx, hy, hw, hh] = box(0.12, 0.58, 0.18, 0.32);
  c.fillStyle = '#e04f3c';
  c.fillRect(hx, hy, hw, hh * 0.35);
  c.fillStyle = '#f2c14e';
  c.fillRect(hx + hw * 0.2, hy + hh * 0.35, hw * 0.6, hh * 0.65);
  if (!fine) return;
  // Качели: перекладина и два сиденья.
  const [qx, qy, qw, qh] = box(0.52, 0.08, 0.4, 0.38);
  c.strokeStyle = '#4c5966';
  c.lineWidth = 0.22;
  c.beginPath();
  c.moveTo(qx + 0.3, qy + qh * 0.5);
  c.lineTo(qx + qw - 0.3, qy + qh * 0.5);
  c.stroke();
  c.fillStyle = '#3f74b5';
  c.fillRect(qx + qw * 0.25 - 0.35, qy + qh * 0.5 + 0.4, 0.7, 0.35);
  c.fillRect(qx + qw * 0.75 - 0.35, qy + qh * 0.5 + 0.4, 0.7, 0.35);
  // Карусель.
  const cx = px(0.7);
  const cy = py(0.74);
  c.fillStyle = '#d9a13a';
  disc(c, cx, cy, s * 0.11);
  c.strokeStyle = '#8a5a20';
  c.lineWidth = 0.18;
  c.beginPath();
  c.moveTo(cx - s * 0.11, cy);
  c.lineTo(cx + s * 0.11, cy);
  c.moveTo(cx, cy - s * 0.11);
  c.lineTo(cx, cy + s * 0.11);
  c.stroke();
}

/** Спортивная коробка: покрытие, борта, разметка; вблизи — ворота. Длинная сторона — вдоль x. */
export function sportsBox(a: Art, x: number, y: number, w: number, h: number, seed: number, fine: boolean): void {
  if (!a.lod) return;
  const c = a.c;
  if (a.pass === 0) {
    c.fillStyle = BOX_COLORS[Math.floor(hash(seed, 3) * BOX_COLORS.length)];
    c.fillRect(x, y, w, h);
    if (!a.d) return;
    c.strokeStyle = 'rgba(255,255,255,0.8)';
    c.lineWidth = 0.15;
    c.beginPath();
    c.moveTo(x + w / 2, y + 0.6);
    c.lineTo(x + w / 2, y + h - 0.6);
    c.stroke();
    c.beginPath();
    c.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.16, 0, Math.PI * 2);
    c.stroke();
    return;
  }
  if (a.pass !== 2) return;
  // Борта — светлые доски по периметру (над землёй: поверх теней соседних деревьев).
  c.strokeStyle = '#eef0ee';
  c.lineWidth = 0.35;
  c.strokeRect(x, y, w, h);
  if (!fine) return;
  c.strokeStyle = '#d9d9d6';
  c.lineWidth = 0.2;
  for (const gx of [x + 0.5, x + w - 1.3]) c.strokeRect(gx, y + h / 2 - 1.5, 0.8, 3);
}

/** Мусорная площадка: бетонный пятачок с оградой с трёх сторон; вблизи — контейнеры (бумага, пластик, общий). */
export function trashPad(a: Art, x: number, y: number, w: number, h: number): void {
  if (!a.lod) return;
  const c = a.c;
  if (a.pass === 0) {
    c.fillStyle = '#bdb9b0';
    c.fillRect(x, y, w, h);
    return;
  }
  if (a.pass === 1) {
    if (a.d) a.rectShadow(x, y, w, 0.25, 1.6);
    return;
  }
  if (a.pass !== 2 || !a.d) return;
  c.strokeStyle = '#8b8f94';
  c.lineWidth = 0.25;
  c.beginPath();
  c.moveTo(x, y + h);
  c.lineTo(x, y);
  c.lineTo(x + w, y);
  c.lineTo(x + w, y + h);
  c.stroke();
  const colors = ['#3f7a4f', '#3f74b5', '#8a8f96'];
  const n = Math.max(2, Math.min(4, Math.floor((w - 0.4) / 1.4)));
  for (let i = 0; i < n; i++) {
    c.fillStyle = colors[i % colors.length];
    c.fillRect(x + 0.35 + i * 1.4, y + 0.4, 1.1, 1.2);
  }
}
