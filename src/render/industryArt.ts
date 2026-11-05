import type { CargoType, IndustryKind } from '../world/cargo';
import type { Industry } from '../world/entities';

/**
 * Детальная графика предприятий, вид сверху. Рисуем в локальных координатах footprint:
 * начало — в центре, ось x — вдоль ширины. Сцена каждого вида вызывается три раза
 * одним и тем же кодом: земля → общая тень всех построек одной заливкой → сами постройки.
 * «Случайные» раскладки — хеш от id предприятия, поэтому картинка не дрожит между кадрами.
 */

type Pass = 0 | 1 | 2;
const PASSES: Pass[] = [0, 1, 2];

const SHADOW = 'rgba(30,40,25,0.2)';
/** Сдвиг тени на единицу высоты (в мире): свет сверху-слева, как у городских домов. */
const SUN = { x: 0.3, y: 0.5 };
/** Куда сносит дым (в мире). */
const WIND = { x: 0.85, y: -0.5 };

const METAL = '#9aa3ab';
const YELLOW = '#e9b52f';
const DARK = '#5c5f66';
const BARK = '#8d6a43';

const shades = new Map<string, Map<number, string>>();
/** Светлее (k > 0) или темнее (k < 0) цвет вида #rrggbb. Кэш — без новых строк в каждом кадре. */
function shade(hex: string, k: number): string {
  let byK = shades.get(hex);
  if (!byK) shades.set(hex, (byK = new Map()));
  let v = byK.get(k);
  if (v === undefined) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c: number) => Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k));
    v = `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
    byK.set(k, v);
  }
  return v;
}

/** Детерминированное «случайное» число [0, 1) от зерна и номера. */
function hash(seed: number, i: number): number {
  let h = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function disc(c: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
}

/** Сколько сырья на складе — от 0 до 1 (кучи растут вместе с запасом). */
const fullness = (n: number | undefined) => Math.min(1, (n ?? 0) / 100);

/** Общий буфер точек — без выделения памяти в каждом кадре. */
const P = new Float64Array(32);
const Q = new Float64Array(16);

class Art {
  pass: Pass = 0;
  /** 0 — издалека, только крупные массы; 1 — с тенями; 2 — все мелочи и анимация. */
  readonly lod: number;
  readonly d: boolean;
  /** Сдвиг тени на единицу высоты и её направление — в локальных координатах. */
  readonly sx: number;
  readonly sy: number;
  readonly sa: number;
  /** Единичный вектор к свету (против тени) — для бликов. */
  readonly lx: number;
  readonly ly: number;
  readonly wx: number;
  readonly wy: number;
  readonly seed: number;
  readonly level: number;
  /** Предприятие работает — дымят трубы, горит факел. */
  readonly active: boolean;

  constructor(
    readonly c: CanvasRenderingContext2D,
    ind: Industry,
    zoom: number,
    readonly t: number,
  ) {
    this.lod = zoom > 0.5 ? 2 : zoom > 0.25 ? 1 : 0;
    this.d = this.lod === 2;
    const cos = Math.cos(ind.fp.angle);
    const sin = Math.sin(ind.fp.angle);
    this.sx = SUN.x * cos + SUN.y * sin;
    this.sy = -SUN.x * sin + SUN.y * cos;
    this.sa = Math.atan2(this.sy, this.sx);
    this.lx = -Math.cos(this.sa);
    this.ly = -Math.sin(this.sa);
    const wx = WIND.x * cos + WIND.y * sin;
    const wy = -WIND.x * sin + WIND.y * cos;
    const wl = Math.hypot(wx, wy);
    this.wx = wx / wl;
    this.wy = wy / wl;
    this.seed = ind.id;
    this.level = Math.max(1, Math.floor(ind.level ?? 1));
    this.active = ind.producedMonth > 0 || ind.producedLast > 0;
  }

  r(i: number): number {
    return hash(this.seed, i);
  }

  // ---------- Контуры теней (проход 1): подпути общего пути, обход везде по часовой ----------

  private to(x: number, y: number, line: boolean): void {
    if (line) this.c.lineTo(x, y);
    else this.c.moveTo(x, y);
  }

  /** Тень призмы высотой z над выпуклым многоугольником: сам контур, растянутый по направлению тени. */
  private prism(p: Float64Array, n: number, z: number): void {
    const dx = this.sx * z;
    const dy = this.sy * z;
    let started = false;
    for (let i = 0; i < n; i++) {
      const h = (i + n - 1) % n;
      const j = (i + 1) % n;
      // Грань «смотрит» по тени, если её внешняя нормаль (ey, -ex) направлена туда же.
      const inF = (p[2 * i + 1] - p[2 * h + 1]) * dx - (p[2 * i] - p[2 * h]) * dy > 0;
      const outF = (p[2 * j + 1] - p[2 * i + 1]) * dx - (p[2 * j] - p[2 * i]) * dy > 0;
      const x = p[2 * i];
      const y = p[2 * i + 1];
      if (inF && !outF) {
        this.to(x + dx, y + dy, started);
        this.to(x, y, true);
      } else if (!inF && outF) {
        this.to(x, y, started);
        this.to(x + dx, y + dy, true);
      } else if (inF) this.to(x + dx, y + dy, started);
      else this.to(x, y, started);
      started = true;
    }
    this.c.closePath();
  }

  private rectShadow(x: number, y: number, w: number, h: number, z: number): void {
    Q[0] = x;
    Q[1] = y;
    Q[2] = x + w;
    Q[3] = y;
    Q[4] = x + w;
    Q[5] = y + h;
    Q[6] = x;
    Q[7] = y + h;
    this.prism(Q, 4, z);
  }

  /** Тень цилиндра: круг, протянутый по направлению тени. */
  private capsule(x: number, y: number, r: number, z: number): void {
    const c = this.c;
    const dx = x + this.sx * z;
    const dy = y + this.sy * z;
    const a = this.sa;
    c.moveTo(dx + Math.cos(a - Math.PI / 2) * r, dy + Math.sin(a - Math.PI / 2) * r);
    c.arc(dx, dy, r, a - Math.PI / 2, a + Math.PI / 2);
    c.arc(x, y, r, a + Math.PI / 2, a + Math.PI * 1.5);
    c.closePath();
  }

  /** Неровное пятно (куча, карьер): точки по кругу с «шумом» радиуса, сглаженные через середины. */
  private blob(x: number, y: number, rx: number, ry: number, i: number, jit: number): void {
    const c = this.c;
    const k = 11;
    for (let j = 0; j < k; j++) {
      const a = (j / k) * Math.PI * 2;
      const m = 1 + (this.r(i * 37 + j) - 0.5) * 2 * jit;
      P[2 * j] = x + Math.cos(a) * rx * m;
      P[2 * j + 1] = y + Math.sin(a) * ry * m;
    }
    c.moveTo((P[2 * k - 2] + P[0]) / 2, (P[2 * k - 1] + P[1]) / 2);
    for (let j = 0; j < k; j++) {
      const n = (j + 1) % k;
      c.quadraticCurveTo(P[2 * j], P[2 * j + 1], (P[2 * j] + P[2 * n]) / 2, (P[2 * j + 1] + P[2 * n + 1]) / 2);
    }
    c.closePath();
  }

  // ---------- Земля (проход 0) ----------

  patch(x: number, y: number, w: number, h: number, color: string, r = 0, edge?: string): void {
    if (this.pass !== 0) return;
    const c = this.c;
    c.fillStyle = color;
    c.beginPath();
    if (r) c.roundRect(x, y, w, h, r);
    else c.rect(x, y, w, h);
    c.fill();
    if (edge && this.lod) {
      c.strokeStyle = edge;
      c.lineWidth = 0.8;
      c.stroke();
    }
  }

  /** Ряды посевов, разметка — параллельные линии внутри прямоугольника. */
  rows(x: number, y: number, w: number, h: number, step: number, color: string, vertical = false, lw = 0.7): void {
    if (this.pass !== 0 || !this.d) return;
    const c = this.c;
    c.strokeStyle = color;
    c.lineWidth = lw;
    c.beginPath();
    if (vertical) {
      for (let xx = x + step / 2; xx < x + w; xx += step) {
        c.moveTo(xx, y + 0.8);
        c.lineTo(xx, y + h - 0.8);
      }
    } else {
      for (let yy = y + step / 2; yy < y + h; yy += step) {
        c.moveTo(x + 0.8, yy);
        c.lineTo(x + w - 0.8, yy);
      }
    }
    c.stroke();
  }

  stain(x: number, y: number, rx: number, ry: number, color: string, i: number, jit = 0.2, edge?: string): void {
    if (this.pass !== 0) return;
    const c = this.c;
    c.beginPath();
    this.blob(x, y, rx, ry, i, jit);
    c.fillStyle = color;
    c.fill();
    if (edge && this.d) {
      c.strokeStyle = edge;
      c.lineWidth = 0.7;
      c.stroke();
    }
  }

  track(x0: number, y0: number, x1: number, y1: number): void {
    if (this.pass !== 0 || !this.lod) return;
    const c = this.c;
    const L = Math.hypot(x1 - x0, y1 - y0);
    const ux = (x1 - x0) / L;
    const uy = (y1 - y0) / L;
    if (!this.d) {
      c.strokeStyle = '#8a857d';
      c.lineWidth = 2.4;
      c.beginPath();
      c.moveTo(x0, y0);
      c.lineTo(x1, y1);
      c.stroke();
      return;
    }
    c.strokeStyle = '#8a7a66';
    c.lineWidth = 0.9;
    c.beginPath();
    for (let s = 1.2; s < L; s += 2.6) {
      c.moveTo(x0 + ux * s - uy * 2.1, y0 + uy * s + ux * 2.1);
      c.lineTo(x0 + ux * s + uy * 2.1, y0 + uy * s - ux * 2.1);
    }
    c.stroke();
    c.strokeStyle = '#575a60';
    c.lineWidth = 0.5;
    c.beginPath();
    for (const k of [-1.3, 1.3]) {
      c.moveTo(x0 - uy * k, y0 + ux * k);
      c.lineTo(x1 - uy * k, y1 + ux * k);
    }
    c.stroke();
  }

  /** Трубопровод по земле. */
  pipe(x0: number, y0: number, x1: number, y1: number, color = '#8a8f96', lw = 0.8): void {
    if (this.pass !== 0 || !this.lod) return;
    const c = this.c;
    c.strokeStyle = color;
    c.lineWidth = lw;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
  }

  stump(x: number, y: number): void {
    if (this.pass !== 0 || !this.d) return;
    const c = this.c;
    c.fillStyle = '#c4a271';
    disc(c, x, y, 1.5);
    c.strokeStyle = '#8d6a43';
    c.lineWidth = 0.4;
    c.stroke();
    c.fillStyle = '#a8865a';
    disc(c, x, y, 0.45);
  }

  fence(W: number, H: number, color: string): void {
    if (this.pass !== 0 || !this.d) return;
    const c = this.c;
    c.strokeStyle = color;
    c.lineWidth = 0.5;
    c.setLineDash([1.6, 1.1]);
    c.strokeRect(-W / 2 + 2, -H / 2 + 2, W - 4, H - 4);
    c.setLineDash([]);
  }

  // ---------- Постройки (тень в проходе 1, сами — в проходе 2) ----------

  /** Мелкая деталь прямо на крыше или земле — только вблизи. */
  flat(x: number, y: number, w: number, h: number, color: string): void {
    if (this.pass !== 2 || !this.d) return;
    this.c.fillStyle = color;
    this.c.fillRect(x, y, w, h);
  }

  /** Здание с плоской крышей: x, y — левый верхний угол, z — высота. ribs — шаг профнастила. */
  box(x: number, y: number, w: number, h: number, z: number, roof: string, ribs = 0): void {
    if (this.pass === 1) return this.rectShadow(x, y, w, h, z);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = roof;
    c.fillRect(x, y, w, h);
    if (!this.lod) return;
    if (this.d) {
      if (ribs) {
        c.strokeStyle = shade(roof, -0.1);
        c.lineWidth = 0.35;
        c.beginPath();
        for (let xx = x + ribs; xx < x + w - 0.5; xx += ribs) {
          c.moveTo(xx, y + 0.6);
          c.lineTo(xx, y + h - 0.6);
        }
        c.stroke();
      }
      // Парапет: светлая кромка к свету, тёмная — от него.
      c.fillStyle = shade(roof, 0.22);
      c.fillRect(x, y, w, 0.9);
      c.fillRect(x, y, 0.9, h);
      c.fillStyle = shade(roof, -0.2);
      c.fillRect(x, y + h - 0.9, w, 0.9);
      c.fillRect(x + w - 0.9, y, 0.9, h);
    }
    c.strokeStyle = shade(roof, -0.4);
    c.lineWidth = 0.5;
    c.strokeRect(x, y, w, h);
  }

  /** Двускатная крыша, конёк вдоль длинной стороны. */
  gable(x: number, y: number, w: number, h: number, z: number, roof: string, ribs = false): void {
    if (this.pass === 1) return this.rectShadow(x, y, w, h, z);
    if (this.pass !== 2) return;
    const c = this.c;
    const along = w >= h;
    c.fillStyle = shade(roof, 0.08);
    c.fillRect(x, y, w, h);
    if (!this.lod) return;
    c.fillStyle = shade(roof, -0.14);
    if (along) c.fillRect(x, y + h / 2, w, h / 2);
    else c.fillRect(x + w / 2, y, w / 2, h);
    if (this.d && ribs) {
      c.strokeStyle = shade(roof, -0.22);
      c.lineWidth = 0.3;
      c.beginPath();
      if (along) {
        for (let xx = x + 1.8; xx < x + w - 0.5; xx += 1.8) {
          c.moveTo(xx, y + 0.4);
          c.lineTo(xx, y + h - 0.4);
        }
      } else {
        for (let yy = y + 1.8; yy < y + h - 0.5; yy += 1.8) {
          c.moveTo(x + 0.4, yy);
          c.lineTo(x + w - 0.4, yy);
        }
      }
      c.stroke();
    }
    c.strokeStyle = shade(roof, -0.4);
    c.lineWidth = 0.7;
    c.beginPath();
    if (along) {
      c.moveTo(x + 0.5, y + h / 2);
      c.lineTo(x + w - 0.5, y + h / 2);
    } else {
      c.moveTo(x + w / 2, y + 0.5);
      c.lineTo(x + w / 2, y + h - 0.5);
    }
    c.stroke();
    c.lineWidth = 0.5;
    c.strokeRect(x, y, w, h);
  }

  /** Шед — пилообразная крыша цеха с полосами окон. */
  shed(x: number, y: number, w: number, h: number, z: number, roof: string, glass: string, n: number): void {
    if (this.pass === 1) return this.rectShadow(x, y, w, h, z);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = roof;
    c.fillRect(x, y, w, h);
    if (this.lod) {
      const tw = w / n;
      for (let k = 0; k < n; k++) {
        const tx = x + k * tw;
        c.fillStyle = shade(roof, 0.12);
        c.fillRect(tx, y, tw * 0.3, h);
        c.fillStyle = glass;
        c.fillRect(tx + tw * 0.7, y, tw * 0.3, h);
      }
      if (this.d) {
        c.strokeStyle = shade(roof, -0.3);
        c.lineWidth = 0.5;
        c.beginPath();
        for (let k = 0; k < n; k++) {
          c.moveTo(x + (k + 0.7) * tw, y);
          c.lineTo(x + (k + 0.7) * tw, y + h);
        }
        c.stroke();
      }
    }
    c.strokeStyle = shade(roof, -0.4);
    c.lineWidth = 0.6;
    c.strokeRect(x, y, w, h);
  }

  /** Круглая ёмкость: резервуар, силос, колонна. cap — цвет кольца на крыше. */
  tank(x: number, y: number, r: number, z: number, body: string, cap?: string): void {
    if (this.pass === 1) return this.capsule(x, y, r, z);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = body;
    disc(c, x, y, r);
    if (!this.lod) return;
    c.strokeStyle = shade(body, -0.32);
    c.lineWidth = 0.6;
    c.stroke();
    if (!this.d) return;
    c.fillStyle = shade(body, 0.35);
    disc(c, x + this.lx * r * 0.28, y + this.ly * r * 0.28, r * 0.55);
    if (cap) {
      c.strokeStyle = cap;
      c.lineWidth = r * 0.16;
      c.beginPath();
      c.arc(x, y, r * 0.78, 0, Math.PI * 2);
      c.stroke();
    }
    c.fillStyle = shade(body, -0.25);
    disc(c, x, y, Math.max(0.5, r * 0.13));
  }

  /** Труба: тень длинная, сверху видно жерло. band — цветное кольцо у верха. */
  chimney(x: number, y: number, r: number, z: number, color: string, band?: string): void {
    if (this.pass === 1) return this.capsule(x, y, r, z);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = color;
    disc(c, x, y, r);
    if (!this.lod) return;
    c.strokeStyle = shade(color, -0.35);
    c.lineWidth = 0.5;
    c.stroke();
    if (band && this.d) {
      c.strokeStyle = band;
      c.lineWidth = r * 0.2;
      c.beginPath();
      c.arc(x, y, r * 0.66, 0, Math.PI * 2);
      c.stroke();
    }
    c.fillStyle = '#2b2d31';
    disc(c, x, y, r * 0.45);
  }

  tree(x: number, y: number, r: number, color: string): void {
    const c = this.c;
    if (this.pass === 1) {
      const tx = x + this.sx * r * 0.9;
      const ty = y + this.sy * r * 0.9;
      c.moveTo(tx + r, ty);
      c.arc(tx, ty, r, 0, Math.PI * 2);
      return;
    }
    if (this.pass !== 2) return;
    c.fillStyle = color;
    disc(c, x, y, r);
    if (!this.d) return;
    c.fillStyle = shade(color, 0.16);
    disc(c, x + this.lx * r * 0.3, y + this.ly * r * 0.3, r * 0.55);
  }

  /** Куча сыпучего: конус — светлый склон к солнцу. */
  heap(x: number, y: number, r: number, color: string, i: number): void {
    const c = this.c;
    if (this.pass === 1) return this.blob(x + this.sx * r * 0.7, y + this.sy * r * 0.7, r, r * 0.9, i, 0.14);
    if (this.pass !== 2) return;
    c.fillStyle = shade(color, -0.12);
    c.beginPath();
    this.blob(x, y, r, r * 0.9, i, 0.14);
    c.fill();
    if (!this.lod) return;
    c.fillStyle = color;
    c.beginPath();
    this.blob(x + this.lx * r * 0.12, y + this.ly * r * 0.12, r * 0.72, r * 0.64, i, 0.14);
    c.fill();
    if (!this.d) return;
    c.fillStyle = shade(color, 0.2);
    c.beginPath();
    this.blob(x + this.lx * r * 0.26, y + this.ly * r * 0.26, r * 0.36, r * 0.32, i, 0.14);
    c.fill();
    // Промоины от вершины — чтобы куча читалась конусом.
    const px = x + this.lx * r * 0.2;
    const py = y + this.ly * r * 0.2;
    c.strokeStyle = 'rgba(0,0,0,0.13)';
    c.lineWidth = 0.4;
    c.beginPath();
    for (let j = 0; j < 6; j++) {
      const a = (j / 6) * Math.PI * 2 + this.r(i * 5 + 3) * 2;
      c.moveTo(px + Math.cos(a) * r * 0.32, py + Math.sin(a) * r * 0.28);
      c.lineTo(x + Math.cos(a) * r * 0.74, y + Math.sin(a) * r * 0.66);
    }
    c.stroke();
  }

  /** Штабель брёвен вдоль x: n штук, сверху вниз. Справа — светлые торцы. */
  logs(x: number, y: number, len: number, n: number, i: number): void {
    const th = 3;
    if (this.pass === 1) return this.rectShadow(x, y, len, n * th, 3);
    if (this.pass !== 2) return;
    const c = this.c;
    if (!this.lod) {
      c.fillStyle = BARK;
      c.fillRect(x, y, len, n * th);
      return;
    }
    for (let k = 0; k < n; k++) {
      const dx = (this.r(i * 13 + k) - 0.5) * 2.4;
      const yy = y + k * th;
      c.fillStyle = k % 2 ? BARK : '#7b5b38';
      c.beginPath();
      c.roundRect(x + dx, yy + 0.2, len, th - 0.4, 1.2);
      c.fill();
      if (this.d) {
        c.fillStyle = '#dcbf8e';
        disc(c, x + dx + len - 1.3, yy + th / 2, 1.25);
        c.fillStyle = '#b08f5e';
        disc(c, x + dx + len - 1.3, yy + th / 2, 0.4);
      }
    }
  }

  /** Пакет досок, металла и т. п.: полосы вдоль x, поперёк — прокладки. */
  stack(x: number, y: number, w: number, h: number, z: number, color: string, line: string, tie?: string): void {
    if (this.pass === 1) return this.rectShadow(x, y, w, h, z);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = color;
    c.fillRect(x, y, w, h);
    if (!this.lod) return;
    if (this.d) {
      c.strokeStyle = line;
      c.lineWidth = 0.3;
      c.beginPath();
      for (let yy = y + 1.5; yy < y + h - 0.4; yy += 1.5) {
        c.moveTo(x + 0.3, yy);
        c.lineTo(x + w - 0.3, yy);
      }
      c.stroke();
      if (tie) {
        c.fillStyle = tie;
        c.fillRect(x + w * 0.22, y, 0.9, h);
        c.fillRect(x + w * 0.72, y, 0.9, h);
      }
    }
    c.strokeStyle = shade(color, -0.35);
    c.lineWidth = 0.5;
    c.strokeRect(x, y, w, h);
  }

  /** Небольшая машина или техника — по центру x, y. */
  vehicle(x: number, y: number, w: number, h: number, color: string): void {
    if (this.pass === 1) return this.rectShadow(x - w / 2, y - h / 2, w, h, 2);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = color;
    c.fillRect(x - w / 2, y - h / 2, w, h);
    if (!this.lod) return;
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 0.4;
    c.strokeRect(x - w / 2, y - h / 2, w, h);
  }

  /** Грузовик 11×4.4: кабина — к +x (или к +y, если стоит вертикально). */
  truck(x: number, y: number, vertical: boolean, cab: string, body: string): void {
    if (!this.d) return;
    const w = vertical ? 4.4 : 11;
    const h = vertical ? 11 : 4.4;
    const x0 = x - w / 2;
    const y0 = y - h / 2;
    if (this.pass === 1) return this.rectShadow(x0, y0, w, h, 2.5);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = body;
    c.fillRect(x0, y0, w, h);
    c.fillStyle = cab;
    if (vertical) c.fillRect(x0, y0 + h - 3, w, 3);
    else c.fillRect(x0 + w - 3, y0, 3, h);
    c.fillStyle = 'rgba(200,230,255,0.85)';
    if (vertical) c.fillRect(x0 + 0.6, y0 + h - 1.3, w - 1.2, 0.7);
    else c.fillRect(x0 + w - 1.3, y0 + 0.6, 0.7, h - 1.2);
    c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.lineWidth = 0.4;
    c.strokeRect(x0, y0, w, h);
  }

  /** Вагонетка 6×4 с грузом. */
  cart(x: number, y: number, load: string): void {
    if (this.pass === 1) return this.rectShadow(x - 3, y - 2, 6, 4, 2);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = DARK;
    c.fillRect(x - 3, y - 2, 6, 4);
    if (!this.lod) return;
    c.fillStyle = load;
    c.fillRect(x - 2.2, y - 1.3, 4.4, 2.6);
  }

  /** Корова на выгуле: туловище, голова и пятно. Только вблизи — издалека стадо не разглядеть. */
  animal(x: number, y: number, angle: number, i: number, sheep = false): void {
    if (this.pass !== 2 || !this.d) return;
    const c = this.c;
    if (sheep) {
      // Овца: круглое белое руно и тёмная голова.
      c.save();
      c.translate(x, y);
      c.rotate(angle);
      c.fillStyle = 'rgba(30,40,25,0.22)';
      c.beginPath();
      c.ellipse(this.sx * 0.6, this.sy * 0.6, 1.6, 1.2, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = this.r(i * 11 + 7) < 0.15 ? '#d9cfbd' : '#f6f3ea';
      c.beginPath();
      c.ellipse(0, 0, 1.6, 1.2, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#3d3a36';
      c.beginPath();
      c.ellipse(1.8, 0, 0.6, 0.45, 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
      return;
    }
    const brown = this.r(i * 11 + 7) < 0.4;
    const body = brown ? '#8a5a3c' : '#f2efe8';
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    c.fillStyle = 'rgba(30,40,25,0.22)';
    c.beginPath();
    c.ellipse(this.sx * 0.8, this.sy * 0.8, 2.2, 1.1, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = body;
    c.beginPath();
    c.ellipse(0, 0, 2.2, 1.1, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = brown ? '#5e3c27' : '#3d3a36';
    c.beginPath();
    c.ellipse(2.4, 0, 0.8, 0.6, 0, 0, Math.PI * 2);
    c.fill();
    if (!brown) {
      c.beginPath();
      c.ellipse(-0.6 + this.r(i * 11 + 8) * 1.2, -0.2, 0.7, 0.5, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  /** Конвейер-эстакада: z0 и z1 — высота концов (тень отходит от ленты). */
  belt(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    if (!this.lod) return;
    const c = this.c;
    const L = Math.hypot(x1 - x0, y1 - y0);
    const nx = (-(y1 - y0) / L) * 1.2;
    const ny = ((x1 - x0) / L) * 1.2;
    if (this.pass === 1) {
      const ax = this.sx * z0;
      const ay = this.sy * z0;
      const bx = this.sx * z1;
      const by = this.sy * z1;
      c.moveTo(x0 - nx + ax, y0 - ny + ay);
      c.lineTo(x1 - nx + bx, y1 - ny + by);
      c.lineTo(x1 + nx + bx, y1 + ny + by);
      c.lineTo(x0 + nx + ax, y0 + ny + ay);
      c.closePath();
      return;
    }
    if (this.pass !== 2) return;
    c.fillStyle = '#6d7076';
    c.beginPath();
    c.moveTo(x0 - nx, y0 - ny);
    c.lineTo(x1 - nx, y1 - ny);
    c.lineTo(x1 + nx, y1 + ny);
    c.lineTo(x0 + nx, y0 + ny);
    c.closePath();
    c.fill();
    if (!this.d) return;
    c.strokeStyle = '#b4b8bd';
    c.lineWidth = 0.5;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
    c.strokeStyle = '#4f5258';
    c.lineWidth = 0.35;
    c.beginPath();
    const ux = (x1 - x0) / L;
    const uy = (y1 - y0) / L;
    for (let s = 2; s < L - 1; s += 3) {
      c.moveTo(x0 + ux * s - nx, y0 + uy * s - ny);
      c.lineTo(x0 + ux * s + nx, y0 + uy * s + ny);
    }
    c.stroke();
  }

  /** Копёр шахты: решётчатая башня с двумя шкивами, подкосы — к подъёмной машине справа. */
  headframe(x: number, y: number, toX: number): void {
    const s = 6;
    if (this.pass === 1) return this.rectShadow(x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6, 20);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = 'rgba(60,64,70,0.3)';
    c.fillRect(x - s, y - s, s * 2, s * 2);
    c.strokeStyle = '#3f434a';
    c.lineWidth = 1.3;
    c.strokeRect(x - s, y - s, s * 2, s * 2);
    if (!this.lod) return;
    c.lineWidth = 0.6;
    c.beginPath();
    c.moveTo(x - s, y - s);
    c.lineTo(x + s, y + s);
    c.moveTo(x + s, y - s);
    c.lineTo(x - s, y + s);
    // Подкосы.
    c.moveTo(x + s, y - s);
    c.lineTo(toX, y - s - 3);
    c.moveTo(x + s, y + s);
    c.lineTo(toX, y + s - 3);
    c.stroke();
    for (const k of [-2.7, 2.7]) {
      c.fillStyle = 'rgba(220,222,225,0.55)';
      c.strokeStyle = '#2b2e33';
      c.lineWidth = 0.9;
      c.beginPath();
      c.arc(x, y + k, 3.2, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      if (this.d) {
        c.lineWidth = 0.3;
        c.beginPath();
        for (let j = 0; j < 3; j++) {
          const a = (j / 3) * Math.PI;
          c.moveTo(x + Math.cos(a) * 3.2, y + k + Math.sin(a) * 3.2);
          c.lineTo(x - Math.cos(a) * 3.2, y + k - Math.sin(a) * 3.2);
        }
        // Канаты к барабанам подъёмной машины.
        c.moveTo(x + 3.2, y + k);
        c.lineTo(toX, y + k - 4);
        c.stroke();
      }
    }
  }

  /** Станок-качалка (в 1.3 раза крупнее чертежа), устье скважины — справа. Вблизи крутятся противовесы. */
  pumpjack(x: number, y: number, i: number, color: string): void {
    if (this.pass === 0) return;
    const c = this.c;
    // Путь тени тоже берёт текущее преобразование, поэтому масштабируем обе стадии одинаково.
    c.save();
    c.translate(x, y);
    c.scale(1.3, 1.3);
    if (this.pass === 1) {
      this.rectShadow(-10, -2.6, 17, 5.2, 1);
      this.rectShadow(-6, -1, 16.5, 2, 5);
      c.restore();
      return;
    }
    c.fillStyle = '#a3a8ad';
    c.fillRect(-10, -2.6, 17, 5.2);
    if (this.lod) {
      c.fillStyle = '#6d7076';
      c.fillRect(-10, -1.6, 3, 3.2);
      const sw = this.d ? Math.cos(this.t * 2.4 + this.r(i) * 6.283) * 2.2 : 0;
      c.fillStyle = '#45484e';
      c.fillRect(-7.3 + sw, -3.6, 2.6, 1.7);
      c.fillRect(-7.3 + sw, 1.9, 2.6, 1.7);
      c.fillStyle = DARK;
      c.fillRect(0.4, -2.4, 2.4, 4.8);
    }
    c.fillStyle = color;
    c.fillRect(-6, -1, 15, 2);
    c.fillStyle = YELLOW;
    c.beginPath();
    c.roundRect(8, -1.9, 2.6, 3.8, 1);
    c.fill();
    if (this.lod) {
      c.fillStyle = DARK;
      disc(c, 12, 0, 1.3);
    }
    c.restore();
  }

  /** Экскаватор: кузов и стрела. */
  excavator(x: number, y: number, ax: number, ay: number): void {
    if (!this.d) return;
    this.vehicle(x, y, 5, 4.2, YELLOW);
    if (this.pass !== 2) return;
    const c = this.c;
    c.strokeStyle = '#c4921f';
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(ax, ay);
    c.stroke();
    c.fillStyle = '#6d7076';
    disc(c, ax, ay, 1.2);
    c.fillStyle = '#3d4148';
    c.fillRect(x - 1, y - 1.2, 2, 2.4);
  }

  /** Кран-деррик: мачта и длинная стрела. */
  crane(x: number, y: number, ax: number, ay: number): void {
    if (!this.lod) return;
    if (this.pass === 1) return this.capsule(x, y, 1.4, 16);
    if (this.pass !== 2) return;
    const c = this.c;
    c.strokeStyle = YELLOW;
    c.lineWidth = 1.3;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(ax, ay);
    c.stroke();
    c.fillStyle = '#c4921f';
    disc(c, x, y, 2.2);
    c.fillStyle = DARK;
    disc(c, ax, ay, 0.8);
  }

  /** Вращающаяся печь — длинный лежачий цилиндр с бандажами. */
  kiln(x: number, y: number, w: number, h: number): void {
    if (this.pass === 1) return this.rectShadow(x, y, w, h, 5);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = '#8f8a84';
    c.beginPath();
    c.roundRect(x, y, w, h, h / 2);
    c.fill();
    if (!this.lod) return;
    c.fillStyle = '#b5b0aa';
    c.fillRect(x + 2, y + 1, w - 4, 1.3);
    if (!this.d) return;
    c.strokeStyle = '#5f5b56';
    c.lineWidth = 0.9;
    c.beginPath();
    for (let xx = x + 6; xx < x + w - 3; xx += 8) {
      c.moveTo(xx, y);
      c.lineTo(xx, y + h);
    }
    c.stroke();
  }

  /** Эстакада с трубами вдоль x. */
  rack(x: number, y: number, w: number): void {
    if (this.pass === 1) return this.rectShadow(x, y, w, 5, 3);
    if (this.pass !== 2) return;
    const c = this.c;
    c.fillStyle = '#b4b9be';
    c.fillRect(x, y, w, 5);
    if (!this.lod) return;
    const colors = ['#6d7076', '#c4662f', '#8f969e'];
    c.lineWidth = 0.9;
    for (let k = 0; k < 3; k++) {
      c.strokeStyle = colors[k];
      c.beginPath();
      c.moveTo(x, y + 1.2 + k * 1.3);
      c.lineTo(x + w, y + 1.2 + k * 1.3);
      c.stroke();
    }
  }

  /** Дым из трубы: клубы растут и тают по ветру. Только у работающего предприятия и вблизи. */
  smoke(x: number, y: number, i: number, rgb = '236,236,236', s = 1): void {
    if (this.pass !== 2 || !this.d || !this.active) return;
    const c = this.c;
    for (let k = 0; k < 4; k++) {
      const ph = (this.t * 0.18 + k / 4 + this.r(i * 7 + 99)) % 1;
      const dist = ph * 26 * s;
      const wob = Math.sin(ph * 6 + k) * 2 * s;
      c.fillStyle = `rgba(${rgb},${(0.55 * (1 - ph)).toFixed(2)})`;
      disc(c, x + this.wx * dist - this.wy * wob, y + this.wy * dist + this.wx * wob, (1.6 + ph * 5) * s);
    }
  }

  /** Раскалённое: чугун в домне, факел. Мерцает, только когда завод работает. */
  glow(x: number, y: number, r: number): void {
    if (this.pass !== 2 || !this.lod || !this.active) return;
    const c = this.c;
    const f = this.d ? 0.85 + 0.15 * Math.sin(this.t * 11 + x) * Math.sin(this.t * 7.3) : 1;
    c.fillStyle = 'rgba(255,140,40,0.35)';
    disc(c, x, y, r * 1.7 * f);
    c.fillStyle = '#ffb347';
    disc(c, x, y, r * f);
    c.fillStyle = '#fff1b8';
    disc(c, x, y, r * 0.45 * f);
  }
}

// ---------- Сцены по видам предприятий ----------

type Scene = (a: Art, ind: Industry) => void;

/** Ферма: поля с рядами посевов, двор с красным амбаром, силосы и рулоны сена. */
function farm(a: Art, ind: Industry): void {
  const crops = [
    ['#e2c35c', '#c8a742'],
    ['#a9c66d', '#8bad53'],
    ['#b98e5e', '#9c7449'],
    ['#ead57f', '#d0b75d'],
  ];
  // Поля разные: пшеница всегда, остальные два — разные культуры.
  const k2 = Math.floor(a.r(1) * 3);
  const f2 = crops[1 + k2];
  const f3 = crops[1 + ((k2 + 1 + Math.floor(a.r(2) * 2)) % 3)];
  a.patch(-52, -37, 45, 34, crops[0][0], 1);
  a.rows(-52, -37, 45, 34, 2.6, crops[0][1]);
  a.patch(-52, 0, 45, 37, f2[0], 1);
  a.rows(-52, 0, 45, 37, 2.8, f2[1], true);
  a.patch(-4, -37, 17, 74, f3[0], 1);
  a.rows(-4, -37, 17, 74, 2.6, f3[1]);
  a.patch(16, -38, 37, 76, '#d8caa2', 3);
  a.fence(110, 80, '#8c6f4e');

  const lv = a.level;
  a.gable(18, -35, 24, 20, 8, ind.info.roof);
  a.flat(28.5, -26, 3, 2, '#f1e9dc');
  for (let k = 0; k < (lv >= 3 ? 3 : 2); k++) a.tank(48, -31 + k * 12, 5, 16, '#d5dadd', METAL);
  a.box(18, -10, 15, 11, 4, METAL, 1.6);
  a.gable(22, 9, 16, 12, 6, '#7b5e4c');
  for (let k = 0; k < Math.min(6, 2 + lv); k++) a.tank(41 + (k % 2) * 6.5, 3 + Math.floor(k / 2) * 6.5, 2.3, 2, '#e3c662', '#c8a742');
  a.tree(45, 31, 5.5, '#6e9a52');
  a.tree(20, 31, 4.5, '#7aa55a');
  if (a.d) {
    const ty = -30 + a.r(3) * 58;
    a.vehicle(4.5, ty, 3.2, 4.6, '#3f8f4a');
    a.flat(3.6, ty - 0.6, 1.8, 1.6, '#2c6b37');
  }
}

/** Лесозаготовка: опушка леса, поляна с пнями, штабели брёвен, навес и лесовоз. */
function forest(a: Art, ind: Industry): void {
  a.patch(-15, -19, 62, 61, '#cdbd94', 8);
  for (let k = 0; k < 10; k++) a.stump(-11 + a.r(200 + k) * 55, -15 + a.r(300 + k) * 53);

  // Опушка — того же размера и тона, что и лес вокруг, чуть гуще.
  const trees = ['#8fb46a', '#7aa55a', '#6e9a52', '#5e8a46'];
  let idx = 0;
  for (let gx = -44; gx <= 45; gx += 11) {
    for (let gy = -39; gy <= 40; gy += 11) {
      if (gx > -17 && gy > -21) continue;
      idx++;
      if (a.r(idx) < 0.1) continue;
      const r = 5.5 + a.r(idx + 500) * 3;
      const x = Math.max(-50 + r * 0.6, Math.min(50 - r * 0.6, gx + (a.r(idx + 1000) - 0.5) * 5));
      const y = Math.max(-45 + r * 0.6, Math.min(gy > -21 ? 45 - r * 0.6 : -17 - r, gy + (a.r(idx + 1500) - 0.5) * 4));
      a.tree(x, y, r, trees[Math.floor(a.r(idx + 2000) * trees.length)]);
    }
  }
  const slots = [
    [-9, -12],
    [17, -12],
    [-9, 6],
    [17, 6],
  ];
  for (let k = 0; k < Math.min(4, 1 + a.level); k++) a.logs(slots[k][0], slots[k][1], 22, 5, k);
  a.gable(20, 24, 24, 16, 6, ind.info.roof, true);
  a.truck(-6, 33, false, '#c4662f', BARK);
}

/** Угольная шахта: копёр со шкивами, подъёмная машина, конвейер на чёрный террикон, вагонетки. */
function coalmine(a: Art, ind: Industry): void {
  const coal = '#3a3d43';
  const lv = a.level;
  a.stain(22, 7, 23, 19, 'rgba(45,47,52,0.12)', 1);
  a.track(-44, 31, 44, 31);
  a.fence(90, 80, '#8a8f96');

  a.box(-40, -31, 24, 22, 6, '#7d8088', 1.6);
  a.box(-12, -35, 18, 14, 7, ind.info.roof);
  a.flat(-8, -31, 4, 3, '#6d7076');
  a.flat(-1, -31, 4, 3, '#6d7076');
  a.box(-41, 0, 14, 13, 4, '#8a5a44');
  a.belt(-16, -15, 6, 16, 0, 11);
  a.heap(24, 6, 17, coal, 1);
  if (lv >= 2) a.heap(-2, 18, 9, coal, 2);
  if (lv >= 4) a.heap(33, -27, 7, coal, 3);
  a.headframe(-28, -20, -12);
  for (let k = 0; k < Math.min(6, 2 + lv); k++) a.cart(-36 + k * 8, 31, '#2b2d31');
}

/** Железный рудник: рыжий карьер уступами со спуском, экскаватор, дробилка и кучи руды. */
function ironmine(a: Art, ind: Industry): void {
  const ore = '#a0603c';
  const pit = ['#b98a6c', '#a87858', '#946648', '#7d5539'];
  for (let k = 0; k < 4; k++) {
    const m = 1 - k * 0.22;
    a.stain(-14 + k * 1.6, 2 + k * 1.4, 28 * m, 33 * m, pit[k], 7, 0.07, shade(pit[k], 0.28));
  }
  if (a.pass === 0 && a.d) {
    // Спуск в карьер — спираль по уступам.
    const c = a.c;
    c.strokeStyle = 'rgba(226,200,172,0.85)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(19, 28);
    for (let s = 0; s <= 20; s++) {
      const th = 0.6 + (s / 20) * 5;
      const m = 0.95 - (s / 20) * 0.62;
      c.lineTo(-14 + s * 0.24 + Math.cos(th) * 28 * m, 2 + s * 0.21 + Math.sin(th) * 33 * m);
    }
    c.stroke();
  }
  a.stain(-10, 6, 4, 3, '#86a3ad', 9, 0.2);
  a.track(16, 37, 44, 37);
  a.fence(90, 80, '#8a8f96');

  const lv = a.level;
  a.box(20, -35, 20, 16, 8, ind.info.roof, 1.8);
  a.belt(4, -12, 0, 22, -24, 8);
  a.belt(32, -19, 6, 31, -4, 4);
  a.heap(31, 2, 10, ore, 1);
  if (lv >= 2) a.heap(30, 22, 8, ore, 2);
  for (let k = 0; k < Math.min(3, lv); k++) a.cart(22 + k * 7, 37, ore);
  a.excavator(-12, -1, -18, -5);
  a.truck(13, 27, false, YELLOW, '#8a5236');
}

/** Карьер: серая чаша уступами, пандус, кран, штабеля блоков и щебень. */
function quarry(a: Art, ind: Industry): void {
  const steps = ['#bcb7af', '#aaa59e', '#98938c', '#86817b'];
  for (let k = 0; k < 4; k++) {
    const x0 = -46 + k * 5.8;
    const y0 = -40 + k * 5.8;
    const w = 62 - k * 10;
    const h = 78 - k * 10;
    a.patch(x0, y0, w, h, steps[k], 6 - k);
    if (a.pass === 0 && a.d) {
      // Уступ в тени у ближней к солнцу стенки, светлый край — у дальней.
      const c = a.c;
      c.lineWidth = 1.6;
      c.strokeStyle = 'rgba(40,40,40,0.13)';
      c.beginPath();
      c.moveTo(x0 + 1, y0 + h - 4);
      c.lineTo(x0 + 1, y0 + 1);
      c.lineTo(x0 + w - 4, y0 + 1);
      c.stroke();
      c.lineWidth = 0.8;
      c.strokeStyle = 'rgba(255,255,255,0.3)';
      c.beginPath();
      c.moveTo(x0 + w - 0.5, y0 + 4);
      c.lineTo(x0 + w - 0.5, y0 + h - 0.5);
      c.lineTo(x0 + 4, y0 + h - 0.5);
      c.stroke();
    }
  }
  // Распилы на дне.
  a.rows(-28.6, -22.6, 32, 48, 8, 'rgba(60,60,60,0.16)', false, 0.5);
  a.rows(-28.6, -22.6, 32, 48, 8, 'rgba(60,60,60,0.16)', true, 0.5);
  if (a.pass === 0 && a.d) {
    const c = a.c;
    c.strokeStyle = '#d8d3c9';
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(-14, 26);
    c.lineTo(18, 37);
    c.stroke();
  }
  a.fence(100, 90, '#8a8f96');

  const lv = a.level;
  for (let k = 0; k < Math.min(12, 3 + 2 * lv); k++) a.box(22 + (k % 3) * 8, -40 + Math.floor(k / 3) * 7, 6, 5, 3.5, '#e0dcd3');
  a.heap(34, 6, 9, '#b3aea6', 1);
  a.heap(26, 24, 6.5, '#a9a49c', 2);
  if (lv >= 3) a.heap(41, 23, 5, '#bcb7af', 3);
  a.box(31, 31, 15, 11, 4, ind.info.roof, 1.6);
  a.crane(20, -6, -8, -17);
  a.excavator(-20, 4, -14, 10);
  a.truck(5, 31, false, YELLOW, '#c9c4bb');
}

/** Нефтяная скважина: качалки, трубы к коллектору, резервуары в обваловании. */
function oilwell(a: Art, ind: Industry): void {
  const lv = a.level;
  const n = Math.min(4, 2 + lv);
  const ys = [-28, -10, 8, 26];
  const xs = [-16, -24, -16, -24];
  a.patch(10, -37, 29, 69, '#c8c1b2', 4, '#b0a897');
  for (let k = 0; k < n; k++) {
    a.stain(xs[k] + 15.6, ys[k] + 1, 4.5, 3.5, 'rgba(40,30,50,0.18)', 10 + k);
    a.pipe(xs[k] + 17, ys[k], 5, ys[k]);
  }
  a.pipe(5, ys[0], 5, ys[n - 1]);
  a.pipe(5, -24, 15, -24);
  a.pipe(5, -2, 15, -2);
  a.fence(80, 80, '#8a8f96');

  a.tank(24, -24, 9.5, 9, '#ece8df', ind.info.roof);
  a.tank(24, -2, 9.5, 9, '#ece8df', ind.info.roof);
  if (lv >= 3) a.tank(24, 20, 7.5, 8, '#ece8df', ind.info.roof);
  for (let k = 0; k < n; k++) a.pumpjack(xs[k], ys[k], k, ind.info.roof);
  a.box(-3, 29, 11, 9, 4, ind.info.roof);
  // Пока качалок мало — на свободном месте стоит автоцистерна.
  if (n < 4) a.truck(-24, 31, false, '#c4662f', '#d9dde0');
}

/** Пищевой комбинат: красный корпус, ряд зерновых силосов с галереей, холодильник, рефрижераторы. */
function foodplant(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(-48, 12, 96, 21, '#cdc8bf', 2);
  a.rows(-48, 12, 96, 21, 10, 'rgba(255,255,255,0.55)', true, 0.5);
  a.fence(100, 70, '#8a8f96');

  a.box(-46, -31, 50, 39, 7, roof);
  for (let k = 0; k < 3; k++) a.flat(-42, -26 + k * 11, 42, 2.2, 'rgba(255,255,255,0.22)');
  if (a.d) for (let k = 0; k < 3; k++) a.box(-24 + k * 8, -18, 4, 3, 1.5, '#c9cdd1');
  for (let k = 0; k < 4; k++) a.flat(-42 + k * 10, 6.6, 6, 1.4, '#55595f');
  a.chimney(-36, -24, 2.2, 14, '#d9d4ca');
  a.box(10, -13, 36, 21, 6, '#d5dde2', 2);
  for (let k = 0; k < 4; k++) a.flat(13 + k * 8.5, -11.5, 4, 2.4, '#9aa3ab');
  const silos = lv >= 3 ? 4 : 3;
  const step = silos === 4 ? 10.5 : 11.8;
  for (let k = 0; k < silos; k++) a.tank(12.5 + k * step, -24, silos === 4 ? 4.9 : 5.6, 18, '#ebe7df', '#b8b2a6');
  a.belt(6, -24, 19, 15 + (silos - 1) * step, -24, 19);
  for (let k = 0; k < Math.min(4, 1 + lv); k++) a.truck(-39 + k * 10, 18.5, true, roof, '#f4f1ea');
  // Готовая продукция на поддонах у холодильника.
  const crates = ['#e5534b', '#f2c94c', '#e07b39'];
  for (let k = 0; k < Math.min(8, 3 + lv); k++) {
    a.stack(14 + (k % 4) * 8, 15 + Math.floor(k / 4) * 8, 6, 6, 2.5, crates[Math.floor(a.r(80 + k) * 3)], 'rgba(0,0,0,0.15)');
  }
  a.smoke(-36, -24, 1, '248,248,248');
}

/** Лесопилка: цех с навесом подачи, брёвна (по запасу), пакеты досок, куча опилок. */
function sawmill(a: Art, ind: Industry): void {
  const lv = a.level;
  a.patch(-5, -34, 54, 68, '#d8c8a2', 4);
  a.stain(34, 20, 14, 12, 'rgba(214,190,130,0.55)', 3);
  a.fence(100, 70, '#8a8f96');

  a.gable(-46, -31, 38, 26, 7, ind.info.roof, true);
  a.box(-8, -26, 10, 16, 5, '#a88a63', 1.6);
  const slots = [
    [6, -31],
    [27, -31],
    [6, -14],
    [27, -14],
  ];
  const piles = Math.min(4, 2 + Math.floor((ind.stock.logs ?? 0) / 60));
  for (let k = 0; k < piles; k++) a.logs(slots[k][0], slots[k][1], 19, 5, k);
  a.belt(-10, -5, 5, 28, 15, 9);
  for (let k = 0; k < Math.min(6, 2 + lv); k++) a.stack(-46 + (k % 3) * 13, 2 + Math.floor(k / 3) * 15, 11, 12, 3, '#d8b377', '#b8925a', BARK);
  a.heap(34, 20, 9.5, '#e6d29f', 1);
  if (a.d) a.vehicle(10, 23, 3, 4.4, YELLOW);
}

/** Металлургический завод: домна с воздухонагревателями, кучи угля и руды, трубы, прокатный цех. */
function steelmill(a: Art, ind: Industry): void {
  const lv = a.level;
  a.stain(20, -27, 20, 11, 'rgba(50,50,55,0.08)', 2);
  a.stain(-34, -16, 14, 13, 'rgba(60,50,45,0.08)', 3);
  // Путь чугуновозов: от домны к конвертерному цеху.
  a.track(-40, -1, 58, -1);
  a.fence(120, 80, '#8a8f96');

  a.box(-56, 6, 70, 30, 9, ind.info.roof);
  for (let k = 0; k < 3; k++) a.flat(-52, 11 + k * 8, 62, 2, 'rgba(220,235,245,0.45)');
  for (let k = 0; k < 3; k++) a.tank(-51, -30 + k * 11, 4.5, 22, '#9aa0a6');
  a.flat(-47, -18, 5, 2, '#6d7076');
  a.tank(-34, -17, 9, 26, '#5f6268', '#3d4148');
  a.glow(-34, -17, 3);
  a.heap(10, -27, 7 + 3 * fullness(ind.stock.coal), '#3d4148', 1);
  a.heap(29, -27, 7 + 3 * fullness(ind.stock.ore), '#a0603c', 2);
  a.belt(3, -24, 0, -26, -19, 24);
  // Конвертерный цех.
  a.box(42, -37, 15, 39, 12, '#6d7f8f', 2);
  const stacks = lv >= 3 ? 3 : 2;
  for (let k = 0; k < stacks; k++) a.chimney(10 + k * 11, -9, 3, 34, '#8f969e', '#c0392b');
  // Чугуновоз: раскалённый ковш, пока завод работает.
  a.cart(-14, -1, a.active ? '#f08a2c' : '#4f5258');
  a.cart(-6, -1, a.active ? '#f08a2c' : '#4f5258');
  for (let k = 0; k < Math.min(6, 1 + lv); k++) a.stack(20 + (k % 2) * 19, 9 + Math.floor(k / 2) * 9, 16, 6, 2.5, '#7f95a6', '#5f7a8f');
  a.glow(-25, -1, 1.6);
  for (let k = 0; k < stacks; k++) a.smoke(10 + k * 11, -9, k, '120,122,128', 1.1);
}

/** НПЗ: ректификационные колонны, эстакада труб, печь, газгольдеры-шары, парк резервуаров, факел. */
function refinery(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  const tanks = Math.min(8, 3 + lv);
  const rows = Math.ceil(tanks / 2);
  // Обвалование — по числу рядов резервуаров, ниже — налив в автоцистерны.
  a.patch(16, -37, 37, rows * 18 + 2, '#cec8bb', 3, '#b7b0a2');
  a.pipe(-38, -26, -38, -3, '#8f969e', 1);
  a.pipe(-27, -19, -27, -3, '#8f969e', 1);
  a.pipe(12, 0, 18, 0, '#8f969e', 1);
  a.fence(110, 80, '#8a8f96');

  a.rack(-50, -3, 62);
  a.tank(-38, -26, 4, 30, '#c9ccd0', '#8f969e');
  a.tank(-28, -31, 3.2, 26, '#c9ccd0', '#8f969e');
  a.tank(-27, -19, 3.6, 28, '#c9ccd0', '#8f969e');
  a.box(-50, 9, 16, 15, 6, roof);
  a.chimney(-46, 16, 1.8, 22, '#8f969e');
  a.chimney(-38, 16, 1.8, 22, '#8f969e');
  a.box(-28, 14, 22, 18, 4, METAL, 1.6);
  a.tank(-6, -26, 5.5, 11, '#e9ecef');
  a.tank(6, -26, 5.5, 11, '#e9ecef');
  const slots = [
    [26, -27],
    [44, -27],
    [26, -9],
    [44, -9],
    [26, 9],
    [44, 9],
    [26, 27],
    [44, 27],
  ];
  for (let k = 0; k < tanks; k++) a.tank(slots[k][0], slots[k][1], 7.5, 8, '#ece9e2', roof);
  if (rows < 4) {
    a.box(22, 26, 28, 3, 4, METAL);
    a.truck(29, 32.5, false, roof, '#d9dde0');
    a.truck(43, 32.5, false, roof, '#d9dde0');
  }
  a.chimney(4, 22, 1.4, 36, '#8f969e', '#c0392b');
  a.glow(4, 22, 2.4);
  a.smoke(-46, 16, 1, '140,140,146', 0.8);
  a.smoke(-38, 16, 2, '140,140,146', 0.8);
}

/** Завод стройматериалов: цех, вращающаяся печь с башней, цементные силосы, поддоны кирпича, щебень. */
function buildmat(a: Art, ind: Industry): void {
  const lv = a.level;
  a.stain(-28, 23, 15, 9, 'rgba(120,115,105,0.14)', 2);
  a.fence(100, 70, '#8a8f96');

  a.box(-46, -31, 38, 26, 7, ind.info.roof);
  for (let k = 0; k < 2; k++) a.flat(-42, -25 + k * 12, 30, 2, 'rgba(255,255,255,0.2)');
  a.kiln(-44, 6, 52, 6);
  a.box(10, -2, 11, 18, 18, '#a9adb1');
  for (let k = 0; k < (lv >= 3 ? 3 : 2); k++) a.tank(2 + k * 12, -25, 5.5, 18, '#d9d6cf', '#b5b0a6');
  a.chimney(16, -8, 2.2, 28, '#b9b4ad', '#9a4a36');
  for (let k = 0; k < Math.min(15, 5 + 2 * lv); k++) a.stack(28 + (k % 3) * 6.5, -14 + Math.floor(k / 3) * 6.5, 5, 5, 2.5, '#c4664a', '#a24e36');
  if (a.d) a.vehicle(22, 22, 3, 4.4, YELLOW);
  a.heap(-28, 23, 6 + 3 * fullness(ind.stock.stone), '#a9a49c', 1);
  a.belt(-31, 18, 3, -31, -5, 7);
  a.truck(0, 26, false, ind.info.roof, '#d9d6cf');
  a.smoke(16, -8, 1, '178,172,164');
}

/** Завод товаров: цех с шедовой крышей, кирпичная труба, склад с рампами, контейнеры, фуры. */
function factory(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(12, -6, 46, 44, '#d0d5d9', 2);
  a.rows(12, 22, 46, 16, 9, 'rgba(255,255,255,0.6)', true, 0.5);
  a.fence(120, 80, '#8a8f96');

  // Стоянка у проходной.
  a.patch(-27, 25, 36, 12, '#d0d5d9', 2);
  a.rows(-27, 25, 36, 12, 4.5, 'rgba(255,255,255,0.6)', true, 0.4);
  a.shed(-56, -34, 64, 44, 8, roof, '#bfe3e4', 8);
  a.box(-56, 16, 26, 20, 5, '#7a8791');
  if (a.d) for (let k = 0; k < 2; k++) a.box(-50 + k * 9, 22, 4, 3, 1.5, '#c9cdd1');
  const cars = ['#e5534b', '#4a8fe7', '#f2c94c', '#f4f1ea', '#5c6470'];
  if (a.d) {
    for (let k = 0; k < 7; k++) {
      if (a.r(60 + k) < 0.3) continue;
      a.vehicle(-22.5 + k * 4.5, 31, 2.6, 4.6, cars[Math.floor(a.r(70 + k) * cars.length)]);
    }
  }
  a.box(14, -34, 42, 22, 6, '#b9c2c9', 2);
  for (let k = 0; k < 4; k++) a.flat(18 + k * 10, -13.4, 6, 1.4, '#55595f');
  a.chimney(-18, 18.5, 3, 36, '#b5543c', '#e8e2d6');
  const boxes = ['#2fb8b3', '#e07b39', '#4a8fe7', '#e5534b', '#23898a'];
  for (let k = 0; k < Math.min(8, 2 + 2 * lv); k++) {
    const color = boxes[Math.floor(a.r(40 + k) * boxes.length)];
    a.stack(16 + (k % 3) * 13, -4 + Math.floor(k / 3) * 7, 11, 4.6, 3, color, shade(color, -0.2));
  }
  for (let k = 0; k < Math.min(4, 1 + lv); k++) a.truck(19 + k * 10, 30, true, roof, '#f4f1ea');
  a.smoke(-18, 18.5, 1, '150,150,156', 1.1);
}

/** Стадо на выгуле: n коров в прямоугольнике, места и повороты — от id предприятия. */
function herd(a: Art, x: number, y: number, w: number, h: number, n: number, i: number, sheep = false): void {
  for (let k = 0; k < n; k++) {
    a.animal(x + 3 + a.r(i + k) * (w - 6), y + 2.5 + a.r(i + 50 + k) * (h - 5), (a.r(i + 100 + k) - 0.5) * 2.4, i + k, sheep);
  }
}

/** Животноводческая ферма: выгоны с изгородью и стадом, длинные коровники, силосы, рулоны сена, скотовоз. */
function ranch(a: Art, ind: Industry): void {
  const lv = a.level;
  a.patch(-52, -37, 58, 74, '#a3bf72', 2);
  for (let k = 0; k < 5; k++) a.stain(-44 + a.r(10 + k) * 44, -30 + a.r(20 + k) * 60, 6, 5, 'rgba(120,150,80,0.35)', 20 + k);
  a.stain(-30, 10, 3.5, 2.5, '#86a3ad', 30, 0.15);
  if (a.pass === 0 && a.lod) {
    // Изгородь выгонов.
    const c = a.c;
    c.strokeStyle = '#8c6f4e';
    c.lineWidth = 0.7;
    c.beginPath();
    c.rect(-50, -35, 54, 70);
    c.moveTo(-23, -35);
    c.lineTo(-23, 35);
    c.moveTo(-50, 2);
    c.lineTo(-23, 2);
    c.stroke();
  }
  a.patch(10, -38, 43, 76, '#d4c6a0', 3);
  a.fence(110, 80, '#8c6f4e');

  const roof = ind.info.roof;
  a.gable(12, -35, 40, 11, 6, roof);
  a.gable(12, -21, 40, 11, 6, roof);
  if (lv >= 3) a.gable(12, -7, 26, 10, 5, roof);
  for (let k = 0; k < 2; k++) a.tank(44, -3 + k * 12, 4.5, 15, '#d5dadd', METAL);
  for (let k = 0; k < Math.min(8, 3 + lv); k++) a.tank(16 + (k % 4) * 6, 9 + Math.floor(k / 4) * 6, 2.3, 2, '#e3c662', '#c8a742');
  herd(a, -50, -35, 27, 37, Math.min(9, 3 + 2 * lv), 200);
  herd(a, -50, 2, 27, 33, Math.min(6, 2 + lv), 300);
  herd(a, -23, -35, 27, 70, Math.min(10, 4 + 2 * lv), 400);
  a.tree(-2, 30, 4.5, '#6e9a52');
  a.truck(32, 31, false, '#c4662f', '#b7a07a');
}

/** Песчаный карьер: светлая чаша с затопленным дном, земснаряд с пульповодом, сортировка и кучи песка. */
function sandpit(a: Art, ind: Industry): void {
  const sand = '#d9b77a';
  const pit = ['#e4d2a4', '#d8c08c', '#cbae76', '#bc9d64'];
  for (let k = 0; k < 4; k++) {
    const m = 1 - k * 0.2;
    a.stain(-16 + k * 1.2, 2 + k, 30 * m, 33 * m, pit[k], 5, 0.08, shade(pit[k], 0.3));
  }
  a.stain(-13, 6, 14, 13, '#7fa9b8', 8, 0.18, '#a9c7d1');
  a.pipe(-10, 4, 20, -14, '#5c5f66', 1);
  a.fence(100, 80, '#8a8f96');

  const lv = a.level;
  a.box(-14, 1, 7, 5, 2, '#e9b52f');
  a.box(16, -34, 20, 16, 8, ind.info.roof, 1.8);
  a.belt(30, -18, 7, 32, -2, 3);
  a.heap(32, 4, 9 + Math.min(3, lv), sand, 1);
  if (lv >= 2) a.heap(33, 23, 8, sand, 2);
  if (lv >= 3) a.heap(44, -12, 5, shade(sand, -0.08), 3);
  a.excavator(-30, -22, -34, -14);
  if (a.d) a.vehicle(16, 14, 3.2, 4.6, YELLOW);
  a.truck(8, 31, false, YELLOW, '#cbae76');
}

/** Мясокомбинат: загоны для скота, корпус с холодильником, кормовые силосы, рампа с рефрижераторами. */
function meatplant(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(-52, -32, 26, 38, '#b8a684', 2);
  a.rows(-52, -32, 26, 38, 6.5, 'rgba(110,85,60,0.55)', true, 0.5);
  a.patch(-24, 10, 76, 22, '#cdc8bf', 2);
  a.rows(-24, 10, 76, 22, 10, 'rgba(255,255,255,0.55)', true, 0.5);
  a.fence(110, 70, '#8a8f96');

  herd(a, -52, -32, 26, 38, Math.round(2 + 6 * fullness(ind.stock.livestock)), 500);
  a.box(-22, -31, 42, 34, 7, roof);
  for (let k = 0; k < 3; k++) a.flat(-18, -26 + k * 10, 34, 2, 'rgba(255,255,255,0.2)');
  a.chimney(-14, -2, 2, 16, '#d9d4ca');
  a.box(24, -31, 28, 22, 6, '#d5dde2', 2);
  for (let k = 0; k < 3; k++) a.flat(27 + k * 8.5, -29.5, 4, 2.4, '#9aa3ab');
  // Кормовые силосы: полнее склад зерна — больше силосов.
  const silos = 1 + Math.min(2, Math.floor(fullness(ind.stock.grain) * 3));
  for (let k = 0; k < silos; k++) a.tank(28 + k * 10, 0, 4.2, 14, '#ebe7df', '#b8b2a6');
  a.box(-50, 10, 22, 22, 4, '#a88a63', 1.6);
  for (let k = 0; k < Math.min(5, 1 + lv); k++) a.truck(-18 + k * 9, 22, true, roof, '#f4f1ea');
  a.smoke(-14, -2, 1, '248,248,248');
}

/** Стекольный завод: составной цех, стекловаренная печь с высокой трубой, линия отжига, пирамиды стекла. */
function glassworks(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(-2, 2, 58, 36, '#cfd3d6', 2);
  a.stain(-44, 14, 15, 12, 'rgba(120,110,95,0.12)', 2);
  a.fence(120, 80, '#8a8f96');

  // Склад сырья: песок и уголь, кучи растут с запасом.
  a.heap(-50, 10, 5 + 3 * fullness(ind.stock.sand), '#d9b77a', 1);
  a.heap(-38, 22, 5 + 3 * fullness(ind.stock.coal), '#3d4148', 2);
  a.belt(-46, 4, 2, -46, -14, 10);
  a.box(-56, -34, 20, 20, 11, '#a9adb1', 1.6);
  a.box(-32, -32, 46, 24, 9, roof);
  for (let k = 0; k < 3; k++) a.flat(-28, -28 + k * 7, 38, 1.8, 'rgba(220,240,250,0.45)');
  a.glow(-8, -8, 1.8);
  // Линия отжига — длинная печь от варочного цеха.
  a.box(14, -24, 42, 8, 4, '#c9cdd1', 1.4);
  a.box(14, -36, 22, 10, 6, '#8f9aa3');
  a.chimney(-22, 0, 2.6, 40, '#b9b4ad', '#c0392b');
  for (let k = 0; k < Math.min(10, 3 + 2 * lv); k++) {
    a.stack(2 + (k % 5) * 10.5, 6 + Math.floor(k / 5) * 10, 8, 6, 3, '#a9d8ea', 'rgba(255,255,255,0.75)', '#6d7076');
  }
  for (let k = 0; k < Math.min(3, lv); k++) a.truck(10 + k * 14, 32, false, roof, '#d9e6ec');
  a.smoke(-22, 0, 1, '170,170,176', 1.1);
}

/** Мебельная фабрика: цех с шедовой крышей, пакеты досок и ящики стекла по запасу, склад и фургоны. */
function furniture(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(4, -32, 44, 30, '#d8c8a2', 3);
  a.patch(-48, 8, 96, 26, '#cdc8bf', 2);
  a.stain(-40, 24, 8, 6, 'rgba(214,190,130,0.5)', 3);
  a.fence(100, 70, '#8a8f96');

  a.shed(-46, -31, 46, 34, 7, roof, '#ecdcb6', 6);
  const planks = Math.min(4, 1 + Math.floor((ind.stock.planks ?? 0) / 40));
  for (let k = 0; k < planks; k++) a.stack(6 + (k % 2) * 20, -30 + Math.floor(k / 2) * 13, 17, 10, 3, '#d8b377', '#b8925a', BARK);
  const glass = Math.min(3, 1 + Math.floor((ind.stock.glass ?? 0) / 50));
  for (let k = 0; k < glass; k++) a.stack(6 + k * 13, -4, 10, 5, 3, '#a9d8ea', 'rgba(255,255,255,0.75)', '#8a6a43');
  a.box(10, 8, 36, 16, 6, '#b9a58c', 2);
  for (let k = 0; k < 4; k++) a.flat(13 + k * 8.5, 23.4, 5, 1.4, '#55595f');
  for (let k = 0; k < Math.min(6, 1 + lv); k++) a.stack(-44 + (k % 3) * 8, 10 + Math.floor(k / 3) * 6, 6.5, 5, 2.5, '#e2cfaa', 'rgba(0,0,0,0.12)');
  a.chimney(-38, 26, 1.8, 18, '#b9b4ad');
  for (let k = 0; k < Math.min(3, lv); k++) a.truck(-12 + k * 12, 30, false, roof, '#f4f1ea');
  a.smoke(-38, 26, 1, '236,232,224');
}

/** Цементный завод: кучи камня и песка, сырьевая мельница, башня подогрева и вращающаяся печь, силосы цемента. */
function cement(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.stain(0, 0, 54, 34, 'rgba(200,198,190,0.35)', 1, 0.1);
  a.patch(24, 14, 32, 22, '#cdc8bf', 2);
  a.fence(120, 80, '#8a8f96');

  a.heap(-48, -24, 6 + 3 * fullness(ind.stock.stone), '#a9a49c', 1);
  a.heap(-48, -4, 6 + 3 * fullness(ind.stock.sand), '#d9b77a', 2);
  a.belt(-40, -14, 2, -26, -22, 9);
  a.box(-30, -34, 18, 20, 9, roof, 1.6);
  // Башня циклонного подогрева, от неё — длинная печь к холодильнику клинкера.
  a.box(-8, -34, 14, 14, 26, '#a9adb1');
  a.kiln(-2, -16, 48, 7);
  a.box(44, -20, 12, 14, 5, '#8f969e', 1.6);
  a.chimney(-24, 2, 2.6, 34, '#b9b4ad', '#9a4a36');
  const silos = lv >= 3 ? 4 : 3;
  for (let k = 0; k < silos; k++) a.tank(-40 + k * 13, 22, 5.8, 24, '#e2dfd8', '#b5b0a6');
  a.box(10, 0, 12, 12, 7, '#b4b9be');
  for (let k = 0; k < Math.min(3, lv); k++) a.truck(40, 18 + k * 7, false, '#c4662f', '#d9dde0');
  a.smoke(-24, 2, 1, '178,172,164');
}

// ---------- Предприятия биомов ----------

/** Точки по полю (цветки, коробочки хлопка) рядами со сдвигом — только вблизи, на земле. */
function dots(a: Art, x: number, y: number, w: number, h: number, step: number, r: number, color: string, i: number): void {
  if (a.pass !== 0 || !a.d) return;
  const c = a.c;
  c.fillStyle = color;
  c.beginPath();
  let k = 0;
  for (let yy = y + step / 2; yy < y + h - r; yy += step) {
    for (let xx = x + step / 2; xx < x + w - r; xx += step) {
      k++;
      const px = xx + (a.r(i * 997 + k) - 0.5) * step * 0.45;
      const py = yy + (a.r(i * 991 + k) - 0.5) * step * 0.45;
      c.moveTo(px + r, py);
      c.arc(px, py, r, 0, Math.PI * 2);
    }
  }
  c.fill();
}

interface Crop {
  /** Цветущее (растущее) поле и его ряды. */
  field: [string, string];
  /** Поле под уборку. */
  ripe: [string, string];
  /** Цветки или коробочки по растущему полю. */
  dot?: [string, number];
  /** Тюки и рулоны урожая во дворе. */
  bale: string;
  /** Арык вдоль полей (хлопок в пустыне). */
  canal?: boolean;
}

/** Поля одной культуры (лён, подсолнечник, хлопок): посевы, двор с амбаром, тюки урожая и трактор. */
function cropFarm(a: Art, ind: Industry, crop: Crop): void {
  const lv = a.level;
  a.patch(-52, -37, 45, 34, crop.field[0], 1);
  a.rows(-52, -37, 45, 34, 2.8, crop.field[1]);
  a.patch(-52, 0, 45, 37, crop.ripe[0], 1);
  a.rows(-52, 0, 45, 37, 2.8, crop.ripe[1], true);
  a.patch(-4, -37, 17, 74, crop.field[0], 1);
  a.rows(-4, -37, 17, 74, 2.8, crop.field[1]);
  if (crop.dot) {
    dots(a, -52, -37, 45, 34, 3.4, crop.dot[1], crop.dot[0], 1);
    dots(a, -4, -37, 17, 74, 3.4, crop.dot[1], crop.dot[0], 2);
  }
  if (crop.canal) {
    a.patch(-52, -2.6, 65, 2.2, '#86b3cf');
    a.patch(-7.4, -37, 2.2, 74, '#86b3cf');
  }
  a.patch(16, -38, 37, 76, '#d8caa2', 3);
  a.fence(110, 80, '#8c6f4e');

  a.gable(18, -35, 26, 18, 7, ind.info.roof);
  a.box(46, -35, 7, 14, 5, METAL, 1.6);
  for (let k = 0; k < Math.min(9, 3 + 2 * lv); k++) {
    a.stack(19 + (k % 3) * 9, -12 + Math.floor(k / 3) * 7, 7, 5.5, 2.5, crop.bale, shade(crop.bale, -0.22));
  }
  a.gable(22, 13, 18, 12, 6, '#7b5e4c');
  a.tree(46, 30, 5, '#6e9a52');
  a.tree(46, 12, 4, '#7aa55a');
  if (a.d) {
    const ty = -30 + a.r(3) * 58;
    a.vehicle(4.5, ty, 3.2, 4.6, '#3f8f4a');
    a.flat(3.6, ty - 0.6, 1.8, 1.6, '#2c6b37');
  }
}

/** Льноводческое хозяйство: голубое цветущее поле, соломенное — под уборку, тресты в снопах. */
function flaxfarm(a: Art, ind: Industry): void {
  cropFarm(a, ind, { field: ['#93a9d9', '#7c93c6'], ripe: ['#cbbf86', '#b0a46c'], dot: ['#c9d6f2', 0.7], bale: '#d9c98e' });
}

/** Подсолнечные поля: жёлтые корзинки по зелени, поле под уборку, силосы семечек. */
function sunflower(a: Art, ind: Industry): void {
  cropFarm(a, ind, { field: ['#8fae55', '#7a9845'], ripe: ['#b9a556', '#9c8a42'], dot: ['#f2c21b', 1.15], bale: '#c8b26a' });
  for (let k = 0; k < 2; k++) a.tank(49.5, 4 + k * 11, 3.4, 14, '#d5dadd', METAL);
}

/** Хлопковая плантация у воды: белые коробочки по зелени, арыки, белые модули хлопка. */
function cottonfarm(a: Art, ind: Industry): void {
  cropFarm(a, ind, { field: ['#8fae6a', '#7a9858'], ripe: ['#bdb48a', '#a39a70'], dot: ['#f7f6f0', 0.9], bale: '#f1efe6', canal: true });
}

/** Овцеводческая ферма: выгоны с отарами, кошары, стригальный пункт и тюки шерсти. */
function sheepfarm(a: Art, ind: Industry): void {
  const lv = a.level;
  a.patch(-52, -37, 58, 74, '#b4c27a', 2);
  for (let k = 0; k < 5; k++) a.stain(-44 + a.r(10 + k) * 44, -30 + a.r(20 + k) * 60, 6, 5, 'rgba(150,160,90,0.35)', 20 + k);
  a.stain(-14, 22, 3.5, 2.5, '#86a3ad', 30, 0.15);
  if (a.pass === 0 && a.lod) {
    const c = a.c;
    c.strokeStyle = '#8c6f4e';
    c.lineWidth = 0.7;
    c.beginPath();
    c.rect(-50, -35, 54, 70);
    c.moveTo(-23, -35);
    c.lineTo(-23, 2);
    c.moveTo(-50, 2);
    c.lineTo(4, 2);
    c.stroke();
  }
  a.patch(10, -38, 43, 76, '#d4c6a0', 3);
  a.fence(110, 80, '#8c6f4e');

  const roof = ind.info.roof;
  a.gable(12, -35, 40, 12, 5, roof);
  a.gable(12, -20, 28, 10, 5, roof);
  a.box(42, -20, 10, 10, 4, '#b9a58c', 1.4);
  for (let k = 0; k < Math.min(8, 2 + 2 * lv); k++) a.stack(14 + (k % 4) * 9, 0 + Math.floor(k / 4) * 8, 7, 6, 3, '#efe9da', '#c9c0aa');
  herd(a, -50, -35, 27, 37, Math.min(12, 5 + 2 * lv), 200, true);
  herd(a, -23, -35, 27, 37, Math.min(10, 4 + 2 * lv), 300, true);
  herd(a, -50, 2, 54, 33, Math.min(14, 6 + 2 * lv), 400, true);
  a.tree(4, 30, 4.5, '#6e9a52');
  a.truck(32, 31, false, '#c4662f', '#efe9da');
}

/** Лодка у причала: корпус носом вверх, рубка. */
function boat(a: Art, x: number, y: number, len: number, hull: string): void {
  if (a.pass !== 2) return;
  const c = a.c;
  const w = len * 0.34;
  c.fillStyle = hull;
  c.beginPath();
  c.moveTo(x, y - len / 2);
  c.quadraticCurveTo(x + w, y - len * 0.2, x + w * 0.8, y + len / 2);
  c.lineTo(x - w * 0.8, y + len / 2);
  c.quadraticCurveTo(x - w, y - len * 0.2, x, y - len / 2);
  c.fill();
  if (!a.lod) return;
  c.strokeStyle = shade(hull, -0.35);
  c.lineWidth = 0.5;
  c.stroke();
  c.fillStyle = '#f2efe8';
  c.fillRect(x - w * 0.45, y + len * 0.02, w * 0.9, len * 0.24);
}

/** Рыболовецкая артель: свой затон с причалами и лодками, засолочный цех, холодильник, сети на вешалах. */
function fishery(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(-45, 14, 90, 26, '#8cc3e6', 3);
  a.rows(-45, 17, 90, 22, 5, 'rgba(255,255,255,0.35)', false, 0.5);
  a.patch(-45, 11, 90, 4, '#d9cfb4');
  a.fence(90, 80, '#8a8f96');

  a.box(-8, 10, 7, 26, 1.2, '#9c7b55', 1.5);
  a.box(20, 10, 6, 20, 1.2, '#9c7b55', 1.5);
  const hulls = ['#c0392b', '#2f6f94', '#e9b52f', '#f2efe8'];
  // Лодки у причалов: больше уровень — больше лодок.
  const berths: [number, number][] = [
    [-14, 24],
    [31, 22],
    [5, 27],
    [-26, 30],
    [38, 32],
  ];
  for (let k = 0; k < Math.min(berths.length, 1 + lv); k++) boat(a, berths[k][0], berths[k][1], 9, hulls[k % hulls.length]);
  a.gable(-41, -36, 30, 16, 6, roof);
  a.gable(-41, -16, 20, 13, 5, '#7b6a58');
  a.box(-4, -36, 24, 16, 6, '#d5dde2', 2);
  for (let k = 0; k < 3; k++) a.flat(-1 + k * 7.5, -34.5, 4, 2.4, '#9aa3ab');
  // Вешала с сетями.
  if (a.pass === 2 && a.d) {
    const c = a.c;
    c.strokeStyle = '#6d5a44';
    c.lineWidth = 0.6;
    c.beginPath();
    for (let k = 0; k < 3; k++) {
      c.moveTo(24, -34 + k * 6);
      c.lineTo(42, -34 + k * 6);
    }
    c.stroke();
    c.strokeStyle = 'rgba(70,90,110,0.55)';
    c.lineWidth = 1.6;
    c.beginPath();
    for (let k = 0; k < 3; k++) {
      c.moveTo(25, -33 + k * 6);
      c.lineTo(41, -33 + k * 6);
    }
    c.stroke();
  }
  for (let k = 0; k < Math.min(6, 2 + lv); k++) a.stack(-16 + (k % 3) * 6.5, -14 + Math.floor(k / 3) * 6, 5, 4.6, 2, '#e9ecef', '#3d8fbf');
  a.truck(8, -10, false, roof, '#e9ecef');
  a.chimney(-34, -22, 1.6, 12, '#d9d4ca');
  a.smoke(-34, -22, 1, '236,236,236', 0.7);
}

/** Глиняный карьер: рыжая выемка с лужей на дне, экскаватор, бурты глины, навес и самосвал. */
function claypit(a: Art, ind: Industry): void {
  const clay = '#b8693f';
  const pit = ['#d3a07a', '#c38963', '#b0744f', '#9c6140'];
  for (let k = 0; k < 4; k++) {
    const m = 1 - k * 0.2;
    a.stain(-16 + k * 1.2, 2 + k, 30 * m, 33 * m, pit[k], 6, 0.09, shade(pit[k], 0.25));
  }
  a.stain(-12, 8, 9, 7, '#9db5a6', 12, 0.2, '#b9cbbf');
  a.fence(100, 80, '#8a8f96');

  const lv = a.level;
  a.box(16, -34, 20, 15, 6, ind.info.roof, 1.8);
  a.gable(38, -34, 10, 22, 4, '#8a6a4a', true);
  a.belt(10, -10, 2, 24, -18, 6);
  a.heap(32, 4, 9 + Math.min(3, lv), clay, 1);
  if (lv >= 2) a.heap(32, 23, 7.5, clay, 2);
  if (lv >= 3) a.heap(44, 12, 5, shade(clay, 0.08), 3);
  a.excavator(-30, -20, -36, -12);
  if (a.d) a.vehicle(14, 12, 3.2, 4.6, YELLOW);
  a.truck(8, 31, false, YELLOW, clay);
}

/** Золотой прииск: вскрытая долина, гряды отвалов, пруд с драгой, промывочный цех и инкассаторская машина. */
function goldmine(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(-48, -38, 62, 76, '#c9bb98', 4);
  for (let k = 0; k < 6; k++) a.stain(-42 + k * 9.5, -24 + (k % 2) * 5, 4.5, 12, '#b6a88b', 30 + k, 0.15, '#9d9076');
  a.stain(-16, 18, 20, 13, '#7fa9b8', 40, 0.12, '#a9c7d1');
  a.fence(100, 80, '#8a8f96');

  // Драга на пруду и её отвальный конвейер.
  a.box(-24, 13, 13, 10, 5, roof, 1.4);
  a.belt(-11, 18, 4, 4, 22, 7);
  a.heap(8, 24, 6, '#a39a86', 1);
  a.box(18, -34, 20, 16, 8, '#8f969e', 1.6);
  a.belt(28, -18, 4, 30, -2, 3);
  a.heap(31, 4, 5 + Math.min(3, lv), '#b0a78f', 2);
  a.gable(20, 12, 24, 12, 5, roof);
  for (let k = 0; k < Math.min(3, lv); k++) a.stack(40, -34 + k * 7, 6, 5, 2.5, '#d9b33a', '#a8862a');
  a.excavator(-34, -14, -40, -8);
  a.truck(36, 31, false, '#5c6470', '#8a8f96');
}

/** Самоцветные копи: скальный выход со штольней, рельсы с вагонетками, сортировка и отвалы с цветными камнями. */
function gemmine(a: Art, ind: Industry): void {
  const lv = a.level;
  a.stain(-18, -8, 26, 27, '#b7b0a6', 50, 0.16, '#9d968c');
  a.stain(-20, -12, 17, 17, '#a49d93', 51, 0.2);
  a.stain(-24, -16, 9, 8, '#958e84', 52, 0.25);
  a.track(-20, 22, 42, 22);
  a.fence(90, 80, '#8a8f96');

  // Портал штольни.
  a.box(-24, 8, 10, 6, 3, '#4a4642');
  a.flat(-22, 10, 6, 2.5, '#1f1d1b');
  for (let k = 0; k < Math.min(4, 1 + lv); k++) a.cart(-8 + k * 8, 22, k % 2 ? '#7b4fbf' : '#a9a49c');
  a.box(10, -34, 24, 16, 7, ind.info.roof, 1.6);
  a.gable(12, -14, 22, 12, 5, '#7d7468');
  a.heap(36, -2, 7, '#a9a49c', 1);
  if (lv >= 2) a.heap(26, 4, 5, '#b3aea6', 2);
  if (a.pass === 2 && a.d) {
    const gems = ['#7b4fbf', '#2e9e6e', '#ad1457', '#3d8fbf'];
    for (let k = 0; k < 8; k++) a.flat(31 + a.r(600 + k) * 10, -7 + a.r(700 + k) * 9, 1.1, 1.1, gems[k % gems.length]);
  }
  a.truck(30, 30, false, '#5c6470', '#a9a49c');
}

/** Медный рудник: серо-зелёный карьер уступами с бирюзовой водой, дробилка, бурты руды, самосвалы. */
function coppermine(a: Art, ind: Industry): void {
  const ore = '#2a7d78';
  const pit = ['#a9b2a0', '#98a290', '#879180', '#748070'];
  for (let k = 0; k < 4; k++) {
    const m = 1 - k * 0.22;
    a.stain(-16 + k * 1.6, 4 + k * 1.4, 30 * m, 37 * m, pit[k], 8, 0.07, shade(pit[k], 0.28));
  }
  a.stain(-12, 9, 5, 3.6, '#5fae9e', 9, 0.2);
  a.track(16, 41, 46, 41);
  a.fence(100, 90, '#8a8f96');

  const lv = a.level;
  a.box(20, -40, 22, 16, 8, ind.info.roof, 1.8);
  a.belt(4, -14, 0, 24, -24, 8);
  a.belt(34, -24, 6, 33, -6, 4);
  a.heap(33, 4, 10, ore, 1);
  if (lv >= 2) a.heap(32, 24, 8, ore, 2);
  for (let k = 0; k < Math.min(3, lv); k++) a.cart(24 + k * 7, 41, ore);
  a.excavator(-14, 2, -20, -2);
  if (a.d) a.vehicle(-2, -24, 4, 5.6, YELLOW);
  a.truck(14, 30, false, YELLOW, '#5f7a6a');
}

/** Газовый промысел: устья скважин («ёлки»), шлейфы к установке подготовки, шаровые ёмкости и факел. */
function gasfield(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  const wells: [number, number][] = [
    [-32, -28],
    [-34, -4],
    [-30, 20],
    [-12, 28],
  ];
  const n = Math.min(4, 2 + lv);
  for (let k = 0; k < n; k++) {
    const [x, y] = wells[k];
    a.patch(x - 4.5, y - 4.5, 9, 9, '#c8c1b2', 1.5, '#b0a897');
    a.pipe(x + 4, y, -2, y);
  }
  a.pipe(-2, wells[0][1], -2, wells[n - 1][1]);
  a.pipe(-2, -6, 8, -6);
  a.patch(10, -37, 30, 54, '#cec8bb', 3, '#b7b0a2');
  a.fence(90, 80, '#8a8f96');

  for (let k = 0; k < n; k++) {
    const [x, y] = wells[k];
    a.box(x - 1.6, y - 1.6, 3.2, 3.2, 4, '#c0392b');
    a.flat(x - 2.8, y - 0.5, 5.6, 1, '#e9b52f');
  }
  a.box(12, -34, 14, 12, 7, METAL, 1.6);
  a.tank(32, -27, 5, 10, '#ece8df', roof);
  a.tank(18, -10, 6.5, 13, '#f0eee8', roof);
  a.tank(33, -10, 6.5, 13, '#f0eee8', roof);
  if (lv >= 3) a.tank(25, 7, 6, 12, '#f0eee8', roof);
  a.chimney(30, 30, 1.3, 30, '#8f969e', '#c0392b');
  a.glow(30, 30, 2.2);
  a.truck(10, 30, false, roof, '#e9ecef');
}

/**
 * Текстильная фабрика (льнокомбинат, суконная, хлопкопрядильная): краснокирпичный корпус с шедовой крышей,
 * котельная с трубой, тюки сырья по запасу, рулоны тканей и фургоны.
 */
function textileMill(a: Art, ind: Industry, raw: CargoType, bale: string, cloth: string[]): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(-52, 12, 66, 21, '#cdc8bf', 2);
  a.rows(-52, 12, 66, 21, 10, 'rgba(255,255,255,0.55)', true, 0.5);
  a.patch(18, -32, 34, 64, '#d8d0c0', 3);
  a.fence(110, 70, '#8a8f96');

  a.shed(-52, -32, 56, 38, 8, roof, '#e8eef2', 7);
  a.box(6, -32, 12, 14, 9, '#b5543c', 1.4);
  a.chimney(12, -12, 2.4, 32, '#a24e36', '#e8e2d6');
  const bales = Math.min(6, 1 + Math.floor((ind.stock[raw] ?? 0) / 40));
  for (let k = 0; k < bales; k++) a.stack(21 + (k % 3) * 10, -30 + Math.floor(k / 3) * 9, 8, 7, 3, bale, shade(bale, -0.22));
  for (let k = 0; k < Math.min(8, 2 + 2 * lv); k++) {
    const color = cloth[k % cloth.length];
    a.stack(21 + (k % 4) * 7.5, -6 + Math.floor(k / 4) * 8, 6, 6, 2.5, color, shade(color, -0.22));
  }
  for (let k = 0; k < Math.min(4, 1 + lv); k++) a.truck(-46 + k * 10, 18.5, true, roof, '#f4f1ea');
  a.box(22, 14, 26, 14, 5, '#b9a58c', 2);
  a.smoke(12, -12, 1, '170,166,160', 1);
}

function linenmill(a: Art, ind: Industry): void {
  textileMill(a, ind, 'flax', '#d9c98e', ['#f1ede0', '#c9d6f2', '#e7dcc4']);
}

function woolmill(a: Art, ind: Industry): void {
  textileMill(a, ind, 'wool', '#efe9da', ['#7a4a8c', '#a5805c', '#5f6f8f', '#b5543c']);
}

function cottonmill(a: Art, ind: Industry): void {
  textileMill(a, ind, 'cotton', '#f1efe6', ['#f6f4ee', '#8e44ad', '#4a8fe7', '#e5534b']);
}

/** Кирпичный завод: бурт глины, кольцевая печь с топочными люками, высокая труба, сушильные навесы, поддоны кирпича. */
function brickworks(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.stain(-42, 22, 13, 11, 'rgba(184,105,63,0.35)', 2);
  a.patch(12, -4, 42, 38, '#cdc8bf', 2);
  a.fence(110, 75, '#8a8f96');

  a.heap(-42, 22, 6 + 3 * fullness(ind.stock.clay), '#b8693f', 1);
  a.belt(-36, 16, 2, -30, -8, 8);
  a.box(-32, -34, 54, 22, 6, roof, 2);
  for (let k = 0; k < 8; k++) a.flat(-28 + k * 6.2, -24, 2, 2, '#4a3a30');
  a.chimney(30, -26, 3.2, 42, '#a4513a', '#e8e2d6');
  a.gable(-32, -8, 40, 9, 4, '#8a6a4a', true);
  a.gable(-32, 4, 40, 9, 4, '#8a6a4a', true);
  for (let k = 0; k < Math.min(15, 5 + 2 * lv); k++) a.stack(16 + (k % 5) * 7.5, -1 + Math.floor(k / 5) * 7, 5.5, 5, 3, '#c4664a', '#a24e36');
  a.truck(4, 28, false, roof, '#c4664a');
  a.smoke(30, -26, 1, '170,160,150', 1.2);
}

/** Рыбоконсервный завод: цех, холодильник, баки рассола, ящики рыбы по запасу, поддоны банок, рефрижераторы. */
function cannery(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(-48, 12, 96, 21, '#cdc8bf', 2);
  a.rows(-48, 12, 96, 21, 10, 'rgba(255,255,255,0.55)', true, 0.5);
  a.fence(100, 70, '#8a8f96');

  a.box(-46, -31, 44, 36, 7, roof);
  for (let k = 0; k < 3; k++) a.flat(-42, -26 + k * 11, 36, 2.2, 'rgba(255,255,255,0.22)');
  a.chimney(-38, -24, 2.1, 16, '#d9d4ca');
  a.box(2, -31, 28, 18, 6, '#d5dde2', 2);
  for (let k = 0; k < 3; k++) a.flat(5 + k * 8.5, -29.5, 4, 2.4, '#9aa3ab');
  a.tank(40, -25, 4.6, 14, '#ebe7df', '#b8b2a6');
  a.tank(40, -12, 4.6, 14, '#ebe7df', '#b8b2a6');
  const crates = 1 + Math.min(5, Math.floor(fullness(ind.stock.fish) * 6));
  for (let k = 0; k < crates; k++) a.stack(4 + (k % 3) * 7, -9 + Math.floor(k / 3) * 7, 5.5, 5, 2, '#e9ecef', '#3d8fbf');
  for (let k = 0; k < Math.min(6, 2 + lv); k++) a.stack(26 + (k % 3) * 7, 0 + Math.floor(k / 3) * 6, 5.5, 5, 2.5, '#c9ced3', '#e5534b');
  for (let k = 0; k < Math.min(4, 1 + lv); k++) a.truck(-39 + k * 10, 18.5, true, roof, '#f4f1ea');
  a.smoke(-38, -24, 1, '248,248,248');
}

/** ЦБК: лесная биржа с брёвнами, щепа, варочные котлы, длинный корпус бумагоделательной машины, рулоны бумаги. */
function papermill(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(-58, -38, 32, 52, '#d8c8a2', 3);
  a.patch(12, 8, 46, 28, '#cdc8bf', 2);
  a.stain(-42, 26, 12, 9, 'rgba(226,204,148,0.6)', 3);
  a.fence(120, 80, '#8a8f96');

  const piles = Math.min(4, 1 + Math.floor((ind.stock.logs ?? 0) / 60));
  for (let k = 0; k < piles; k++) a.logs(-55, -34 + k * 12, 25, 5, k);
  a.heap(-42, 26, 7.5, '#e2cc94', 1);
  a.belt(-34, 20, 3, -18, -4, 16);
  a.tank(-18, -28, 5, 32, '#c9ccd0', '#8f969e');
  a.tank(-6, -28, 5, 32, '#c9ccd0', '#8f969e');
  a.box(-22, -16, 70, 18, 9, roof, 2);
  for (let k = 0; k < 4; k++) a.flat(-18 + k * 16, -12, 10, 2, 'rgba(255,255,255,0.22)');
  a.box(8, -38, 28, 18, 7, '#b9c2c9', 2);
  a.chimney(44, -30, 3, 46, '#b9b4ad', '#c0392b');
  for (let k = 0; k < Math.min(8, 2 + 2 * lv); k++) a.tank(17 + (k % 4) * 8, 15 + Math.floor(k / 4) * 9, 3.4, 5, '#f4f1ea', '#d9d4ca');
  a.truck(50, 20, true, roof, '#f4f1ea');
  a.smoke(44, -30, 1, '236,236,236', 1.4);
}

/** Мастерская (ювелирный завод, гранильная фабрика): особняк цеха, сад с прудом, проходная, инкассаторский фургон. */
function workshop(a: Art, ind: Industry, stones: boolean): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(-42, 10, 48, 22, '#cdc8bf', 2);
  a.patch(10, -32, 32, 64, '#b8cf96', 4);
  a.fence(90, 70, '#8a8f96');

  a.gable(-40, -31, 44, 24, 8, roof);
  a.box(-40, -5, 18, 12, 5, '#d9d4ca', 1.4);
  if (lv >= 2) a.box(-20, -5, 18, 12, 4, '#cfc8bc', 1.4);
  a.tank(28, 0, 4, 0.4, '#8cc3e6');
  a.tree(18, -24, 5, '#6e9a52');
  a.tree(34, -16, 4.5, '#7aa55a');
  a.tree(20, 22, 5, '#6e9a52');
  a.tree(36, 24, 4, '#8fb46a');
  if (stones) {
    a.heap(-8, 20, 5 + 2 * fullness(ind.stock.gems), '#a9a49c', 1);
    if (a.pass === 2 && a.d) {
      const gems = ['#7b4fbf', '#2e9e6e', '#ad1457'];
      for (let k = 0; k < 6; k++) a.flat(-12 + a.r(800 + k) * 8, 17 + a.r(900 + k) * 6, 1, 1, gems[k % 3]);
    }
  } else {
    for (let k = 0; k < 1 + Math.min(3, Math.floor(fullness(ind.stock.gold) * 4)); k++) a.stack(-10 + k * 5, 18, 4, 3, 1.6, '#d9b33a', '#a8862a');
  }
  a.box(0, 26, 6, 6, 3, '#9aa3ab');
  a.truck(-30, 22, false, '#5c6470', '#8a8f96');
}

function jeweler(a: Art, ind: Industry): void {
  workshop(a, ind, false);
}

function gemcutter(a: Art, ind: Industry): void {
  workshop(a, ind, true);
}

/** Маслозавод: силосы семечек, прессовый цех, золотистые баки масла, лузга, автоцистерны. */
function oilmill(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(-48, 12, 96, 21, '#cdc8bf', 2);
  a.rows(-48, 12, 96, 21, 10, 'rgba(255,255,255,0.55)', true, 0.5);
  a.fence(100, 70, '#8a8f96');

  const silos = 2 + Math.min(2, Math.floor(fullness(ind.stock.sunflower) * 3));
  for (let k = 0; k < silos; k++) a.tank(-41 + k * 11, -24, 5, 20, '#ebe7df', '#b8b2a6');
  a.belt(-46, -24, 20, -46 + silos * 11, -24, 20);
  a.box(-46, -14, 46, 22, 7, roof, 2);
  a.chimney(-8, -8, 2, 18, '#d9d4ca');
  for (let k = 0; k < Math.min(4, 1 + lv); k++) a.tank(14 + (k % 2) * 14, -22 + Math.floor(k / 2) * 15, 6, 10, '#f2d36b', '#c49a1c');
  a.heap(42, 2, 5.5, '#6b5a1e', 1);
  for (let k = 0; k < Math.min(4, 1 + lv); k++) a.truck(-39 + k * 10, 18.5, true, roof, '#efe2b0');
  a.smoke(-8, -8, 1, '240,236,220');
}

/** Медеплавильный завод: отражательная печь, кучи медной руды и угля, конвертерный цех, трубы, медные слитки. */
function smelter(a: Art, ind: Industry): void {
  const lv = a.level;
  a.stain(20, -27, 20, 11, 'rgba(42,125,120,0.1)', 2);
  a.track(-40, -1, 58, -1);
  a.fence(120, 80, '#8a8f96');

  a.box(-56, 6, 66, 30, 9, ind.info.roof);
  for (let k = 0; k < 3; k++) a.flat(-52, 11 + k * 8, 58, 2, 'rgba(240,220,200,0.35)');
  a.box(-52, -32, 34, 18, 8, '#6d7076', 1.6);
  a.glow(-34, -23, 2.6);
  a.heap(10, -27, 7 + 3 * fullness(ind.stock.copperore), '#2a7d78', 1);
  a.heap(29, -27, 7 + 3 * fullness(ind.stock.coal), '#3d4148', 2);
  a.belt(3, -24, 0, -18, -24, 14);
  a.box(42, -37, 15, 39, 12, '#8a6a5a', 2);
  const stacks = lv >= 3 ? 3 : 2;
  for (let k = 0; k < stacks; k++) a.chimney(12 + k * 11, -9, 3, 38, '#8f969e', '#d9824a');
  a.cart(-14, -1, a.active ? '#f08a2c' : '#4f5258');
  for (let k = 0; k < Math.min(6, 1 + lv); k++) a.stack(20 + (k % 2) * 19, 9 + Math.floor(k / 2) * 9, 16, 6, 2.5, '#d9824a', '#a85a2c');
  for (let k = 0; k < stacks; k++) a.smoke(12 + k * 11, -9, k, '176,168,140', 1.1);
}

/** Электротехнический завод: сборочный цех с шедовой крышей, испытательная станция с трансформаторами, катушки кабеля. */
function electro(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(12, -6, 46, 44, '#d0d5d9', 2);
  a.fence(120, 80, '#8a8f96');

  a.shed(-56, -34, 64, 44, 8, roof, '#cfe3ef', 8);
  for (let k = 0; k < 3; k++) {
    a.box(-54 + k * 11, 18, 8, 8, 5, '#7a8791', 1.2);
    a.flat(-53 + k * 11, 27, 6, 1.2, '#55595f');
  }
  a.box(-20, 16, 24, 18, 6, '#b9c2c9', 2);
  a.box(14, -34, 42, 22, 6, '#b9c2c9', 2);
  for (let k = 0; k < 4; k++) a.flat(18 + k * 10, -13.4, 6, 1.4, '#55595f');
  for (let k = 0; k < Math.min(9, 3 + 2 * lv); k++) a.tank(19 + (k % 3) * 12, 0 + Math.floor(k / 3) * 10, 4.2, 3, '#d9824a', '#8a5a3c');
  for (let k = 0; k < Math.min(3, lv); k++) a.truck(52, 2 + k * 11, false, roof, '#f4f1ea');
}

/** ГПЗ: колонны осушки, эстакада, компрессорный цех, шаровые газгольдеры, факел и газовозы. */
function gasplant(a: Art, ind: Industry): void {
  const lv = a.level;
  const roof = ind.info.roof;
  a.patch(14, -37, 40, 72, '#cec8bb', 3, '#b7b0a2');
  a.pipe(-38, -26, -38, -3, '#8f969e', 1);
  a.pipe(-26, -22, -26, -3, '#8f969e', 1);
  a.pipe(12, 0, 18, 0, '#8f969e', 1);
  a.fence(110, 80, '#8a8f96');

  a.rack(-50, -3, 62);
  a.tank(-38, -26, 4, 30, '#c9ccd0', '#8f969e');
  a.tank(-26, -22, 3.6, 26, '#c9ccd0', '#8f969e');
  a.tank(-12, -26, 3.2, 22, '#c9ccd0', '#8f969e');
  a.box(-50, 9, 22, 16, 6, roof, 1.6);
  a.box(-24, 14, 20, 16, 4, METAL, 1.6);
  const spheres = Math.min(6, 2 + 2 * Math.min(2, lv - 1));
  for (let k = 0; k < spheres; k++) a.tank(25 + (k % 2) * 18, -25 + Math.floor(k / 2) * 19, 7.6, 14, '#f0eee8', roof);
  a.chimney(4, 24, 1.4, 36, '#8f969e', '#c0392b');
  a.glow(4, 24, 2.4);
  a.truck(-6, 33, false, roof, '#e9ecef');
}

const SCENES: Record<IndustryKind, Scene> = {
  farm,
  forest,
  coalmine,
  ironmine,
  oilwell,
  quarry,
  foodplant,
  sawmill,
  steelmill,
  refinery,
  buildmat,
  factory,
  ranch,
  sandpit,
  meatplant,
  glassworks,
  furniture,
  cement,
  flaxfarm,
  claypit,
  fishery,
  goldmine,
  sheepfarm,
  sunflower,
  gemmine,
  coppermine,
  cottonfarm,
  gasfield,
  linenmill,
  brickworks,
  cannery,
  papermill,
  jeweler,
  woolmill,
  oilmill,
  gemcutter,
  smelter,
  electro,
  cottonmill,
  gasplant,
};

/** Цвет участка под постройками; по умолчанию — цвет вида предприятия. */
const GROUND: Partial<Record<IndustryKind, string>> = {
  farm: '#bccb8f',
  flaxfarm: '#bccb8f',
  sunflower: '#bccb8f',
  cottonfarm: '#c7c89a',
  sheepfarm: '#c3c98f',
};

/** Предприятие целиком: участок, тени, постройки. zoom решает, сколько мелочей рисовать. */
export function drawIndustryArt(ctx: CanvasRenderingContext2D, ind: Industry, zoom: number, time: number): void {
  const fp = ind.fp;
  const info = ind.info;
  const W = info.w;
  const H = info.h;
  const a = new Art(ctx, ind, zoom, time);
  const scene = SCENES[info.kind];
  ctx.save();
  ctx.translate(fp.center.x, fp.center.y);
  ctx.rotate(fp.angle);
  // Сцены нарисованы под размер вида; footprint из старого сохранения тоже впишется.
  ctx.scale(fp.w / W, fp.h / H);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pass of PASSES) {
    if (pass === 1 && !a.lod) continue;
    a.pass = pass;
    if (pass === 0) {
      ctx.fillStyle = GROUND[info.kind] ?? info.color;
      ctx.beginPath();
      ctx.roundRect(-W / 2, -H / 2, W, H, 3);
      ctx.fill();
      scene(a, ind);
      ctx.strokeStyle = 'rgba(60,50,40,0.45)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(-W / 2, -H / 2, W, H, 3);
      ctx.stroke();
    } else if (pass === 1) {
      ctx.beginPath();
      scene(a, ind);
      ctx.fillStyle = SHADOW;
      ctx.fill();
    } else scene(a, ind);
  }
  ctx.restore();
}
