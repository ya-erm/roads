import type { Vec } from '../core/vec';
import { BIOMES } from '../world/biomes';
import type { Terrain } from '../world/terrain';

/**
 * Рельеф на карте: цвет земли по высоте с мягкой отмывкой склонов — в кэше тайлами (растр,
 * растягивается гладко), изолинии — векторно: считаются один раз по сетке высот (marching squares),
 * сглаживаются и рисуются линиями постоянной толщины в пикселях экрана.
 */

/** Тайл цвета: мировых единиц по стороне и на пиксель кэша. */
const TILE = 1024;
const TILE_RES = 8;
const TILE_PX = TILE / TILE_RES;
/** Изолиния режется на куски не длиннее стольких точек — чтобы рисовать только видимые. */
const CHUNK = 64;
/** Примерное расстояние между точками изолинии после сглаживания, м (шаг сетки / 4). */
const CONTOUR_SPACING = 4;

/**
 * Цвет земли по высоте, м, — по биому (BIOMES[…].palette.hypso): в средней полосе низины зеленее, выше —
 * суше и светлее, горы — каменистые; в тайге темнее, в степи и пустыне — соломенный и песочный.
 */
function hypso(h: number, table: [number, [number, number, number]][]): [number, number, number] {
  if (h <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [h1, c1] = table[i];
    if (h <= h1) {
      const [h0, c0] = table[i - 1];
      const t = (h - h0) / (h1 - h0);
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
    }
  }
  return table[table.length - 1][1];
}

/** Куда падают тени (единичный вектор в мире): вниз-вправо, как у построек, мостов и эстакад. */
const SHADOW_DIR = { x: 0.3 / Math.hypot(0.3, 0.5), y: 0.5 / Math.hypot(0.3, 0.5) };

/**
 * Освещённость склона по градиенту высоты (gx, gy — подъём на метр по x и y) от −1 до 1: свет сверху-слева,
 * склон к свету светлее, склон по направлению тени — темнее (мягко, без резких теней).
 */
export function hillshade(gx: number, gy: number): number {
  return Math.max(-1, Math.min(1, (gx * SHADOW_DIR.x + gy * SHADOW_DIR.y) * 3.1));
}

interface ContourChunk {
  pts: Float32Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  major: boolean;
}

/** Изолинии на всей карте — по тайлам (см. contourTile). */
export function buildContours(terrain: Terrain): ContourChunk[] {
  const g = terrain.heightGrid();
  if (!g) return [];
  const out: ContourChunk[] = [];
  for (let ty = 0; ty * TILE < terrain.height; ty++) for (let tx = 0; tx * TILE < terrain.width; tx++) out.push(...contourTile(terrain, tx, ty));
  return out;
}

/**
 * Изолинии через step в тайле карты: клетки сетки высот тайла (marching squares), сглаженные полилинии,
 * нарезанные на куски. Линия, уходящая в соседний тайл, кончается ровно на общем ребре сетки — там
 * продолжается линия соседа, и сглаживание концы не сдвигает: правка кистью пересобирает только свои тайлы.
 */
export function contourTile(terrain: Terrain, tx: number, ty: number): ContourChunk[] {
  const g = terrain.heightGrid();
  if (!g) return [];
  const { data, nx, ny, cell } = g;
  const per = TILE / cell;
  const ci0 = tx * per;
  const cj0 = ty * per;
  const ci1 = Math.min(nx - 1, ci0 + per);
  const cj1 = Math.min(ny - 1, cj0 + per);
  if (ci0 >= ci1 || cj0 >= cj1) return [];
  const step = terrain.contourStep;
  // Уровни — от уровня воды, как высота в подсказке у курсора: линия «20 м» там, где подсказка покажет 20 м.
  const base = terrain.waterLevel;
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = cj0; j <= cj1; j++) {
    for (let i = ci0; i <= ci1; i++) {
      const v = data[j * nx + i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const chunks: ContourChunk[] = [];
  for (let level = Math.ceil((lo - base) / step); base + level * step <= hi; level++) {
    // Нулевая — сам уровень воды: вдоль берега её заменяет край воды.
    if (level === 0) continue;
    const major = level % 5 === 0;
    for (const line of isolines(data, nx, cell, base + level * step, ci0, cj0, ci1, cj1)) {
      const pts = chaikin(chaikin(line.pts, line.closed), line.closed);
      for (let p0 = 0; p0 < pts.length - 1; p0 += CHUNK - 1) {
        const part = pts.slice(p0, Math.min(pts.length, p0 + CHUNK));
        const flat = new Float32Array(part.length * 2);
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        part.forEach(([x, y], q) => {
          flat[q * 2] = x;
          flat[q * 2 + 1] = y;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        });
        chunks.push({ pts: flat, x0, y0, x1, y1, major });
      }
    }
  }
  return chunks;
}

/**
 * Изолинии поля data (узлы — точки (i·cell, j·cell)) на уровне L в клетках [ci0, ci1) × [cj0, cj1)
 * по marching squares: полилинии без сглаживания; closed — линия замкнута.
 */
export function isolines(data: ArrayLike<number>, nx: number, cell: number, L: number, ci0: number, cj0: number, ci1: number, cj1: number): { pts: [number, number][]; closed: boolean }[] {
  const out: { pts: [number, number][]; closed: boolean }[] = [];
  // Ребро сетки: 2·k — к соседу справа, 2·k+1 — к соседу снизу (k — номер узла).
  const point = (edge: number): [number, number] => {
    const k = edge >> 1;
    const i = k % nx;
    const j = (k - i) / nx;
    const k2 = edge & 1 ? k + nx : k + 1;
    const t = (L - data[k]) / (data[k2] - data[k]);
    return edge & 1 ? [i * cell, (j + t) * cell] : [(i + t) * cell, j * cell];
  };
  const segA: number[] = [];
  const segB: number[] = [];
  const at = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    const s = segA.length;
    segA.push(a);
    segB.push(b);
    for (const e of [a, b]) {
      const list = at.get(e);
      if (list) list.push(s);
      else at.set(e, [s]);
    }
  };
  for (let j = cj0; j < cj1; j++) {
    for (let i = ci0; i < ci1; i++) {
      const k = j * nx + i;
      const a = data[k];
      const b = data[k + 1];
      const c = data[k + nx + 1];
      const d = data[k + nx];
      const idx = (a >= L ? 1 : 0) | (b >= L ? 2 : 0) | (c >= L ? 4 : 0) | (d >= L ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const top = 2 * k;
      const bottom = 2 * (k + nx);
      const left = 2 * k + 1;
      const right = 2 * (k + 1) + 1;
      switch (idx) {
        case 1:
        case 14:
          add(left, top);
          break;
        case 2:
        case 13:
          add(top, right);
          break;
        case 3:
        case 12:
          add(left, right);
          break;
        case 4:
        case 11:
          add(right, bottom);
          break;
        case 6:
        case 9:
          add(top, bottom);
          break;
        case 7:
        case 8:
          add(left, bottom);
          break;
        case 5:
        case 10: {
          // Седловина: по среднему в центре клетки.
          const high = (a + b + c + d) / 4 >= L;
          if ((idx === 5) === high) {
            add(left, bottom);
            add(top, right);
          } else {
            add(left, top);
            add(right, bottom);
          }
          break;
        }
      }
    }
  }
  // Сшиваем отрезки в полилинии по общим рёбрам.
  const used = new Uint8Array(segA.length);
  const next = (edge: number, from: number) => (at.get(edge) ?? []).find((s) => s !== from && !used[s]);
  for (let s0 = 0; s0 < segA.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const ahead = [segA[s0], segB[s0]];
    const behind: number[] = [];
    for (const forward of [true, false]) {
      let s = s0;
      let end = forward ? segB[s0] : segA[s0];
      for (;;) {
        const n = next(end, s);
        if (n === undefined) break;
        used[n] = 1;
        end = segA[n] === end ? segB[n] : segA[n];
        (forward ? ahead : behind).push(end);
        s = n;
      }
    }
    const edges = behind.reverse().concat(ahead);
    const closed = edges.length > 3 && edges[0] === edges[edges.length - 1];
    out.push({ pts: edges.map(point), closed });
  }
  return out;
}

/**
 * Контуры воды по рельефу: изолиния offset поля расстояний до берега (0 — сам берег, > 0 — полоса берега
 * шире воды), сглаженные замкнутые кольца. За краем карты — суша, поэтому кольца замыкаются всегда;
 * острова — кольца внутри колец (заливать с правилом evenodd).
 */
export function waterRings(terrain: Terrain, offset = 0): [number, number][][] {
  const f = terrain.waterField();
  if (!f) return [];
  const { data, nx, ny, cell } = f;
  const px = nx + 2;
  const padded = new Float32Array(px * (ny + 2)).fill(1e6);
  for (let j = 0; j < ny; j++) padded.set(data.subarray(j * nx, (j + 1) * nx), (j + 1) * px + 1);
  return isolines(padded, px, cell, offset, 0, 0, px - 1, ny + 1).map((line) =>
    chaikin(chaikin(line.pts, line.closed), line.closed).map(([x, y]) => [x - cell, y - cell] as [number, number]),
  );
}

const waterPaths = new WeakMap<Float32Array, Map<number, Path2D>>();

/** Вода по рельефу одним путём (кэш на поле воды мира): заливать с 'evenodd'. Без рельефа — null. */
export function waterPath(terrain: Terrain, offset = 0): Path2D | null {
  const f = terrain.waterField();
  if (!f) return null;
  let byOffset = waterPaths.get(f.data);
  if (!byOffset) waterPaths.set(f.data, (byOffset = new Map()));
  let path = byOffset.get(offset);
  if (!path) {
    path = new Path2D();
    for (const ring of waterRings(terrain, offset)) {
      ring.forEach(([x, y], i) => (i ? path!.lineTo(x, y) : path!.moveTo(x, y)));
      path.closePath();
    }
    byOffset.set(offset, path);
  }
  return path;
}

/** Сглаживание Чайкина: концы открытой линии на месте, замкнутая остаётся замкнутой. */
function chaikin(pts: [number, number][], closed: boolean): [number, number][] {
  if (pts.length < 3) return pts;
  const out: [number, number][] = closed ? [] : [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
  }
  if (closed) out.push(out[0]);
  else out.push(pts[pts.length - 1]);
  return out;
}

type View = { x0: number; y0: number; x1: number; y1: number };

export class ReliefRenderer {
  private tiles = new Map<string, HTMLCanvasElement>();
  /** Изолинии по тайлам — те же тайлы, что у цвета. */
  private contours = new Map<string, ContourChunk[]>();
  private of: Terrain | null = null;

  reset(): void {
    this.tiles.clear();
    this.contours.clear();
    this.of = null;
  }

  /**
   * Правки рельефа с прошлого раза (свои тайлы уже сброшены): рамка правок, 'all' — карта другая, null — ничего.
   * Для кэша карты (src/render/tileCache.ts): его плитки с рельефом — тоже заново.
   */
  sync(terrain: Terrain): { x0: number; y0: number; x1: number; y1: number } | 'all' | null {
    return this.bind(terrain);
  }

  private bind(terrain: Terrain): { x0: number; y0: number; x1: number; y1: number } | 'all' | null {
    let fresh = false;
    if (this.of !== terrain) {
      this.reset();
      this.of = terrain;
      terrain.takeDirty();
      fresh = true;
    }
    // Правка рельефа: цвет и изолинии задетых тайлов — заново, прямо во время мазка.
    const d = terrain.takeDirty();
    if (fresh) return 'all';
    if (d) {
      const pad = Math.max(TILE_RES * 2, 16);
      for (let ty = Math.floor((d.y0 - pad) / TILE); ty <= Math.floor((d.y1 + pad) / TILE); ty++) {
        for (let tx = Math.floor((d.x0 - pad) / TILE); tx <= Math.floor((d.x1 + pad) / TILE); tx++) {
          this.tiles.delete(`${tx}:${ty}`);
          this.contours.delete(`${tx}:${ty}`);
        }
      }
      // Вне правки высоты те же — тайл заново даст те же пиксели; отмывка (уклон по соседям) и сглаживание пикселей
      // тайла задевают ещё по паре пикселей тайла вокруг.
      return { x0: d.x0 - pad * 2, y0: d.y0 - pad * 2, x1: d.x1 + pad * 2, y1: d.y1 + pad * 2 };
    }
    return null;
  }

  /** Тайлы карты, видимые в рамке view. */
  private visibleTiles(terrain: Terrain, view: View): [number, number][] {
    const out: [number, number][] = [];
    const x0 = Math.max(0, Math.floor(view.x0 / TILE));
    const x1 = Math.min(Math.ceil(terrain.width / TILE) - 1, Math.floor(view.x1 / TILE));
    const y0 = Math.max(0, Math.floor(view.y0 / TILE));
    const y1 = Math.min(Math.ceil(terrain.height / TILE) - 1, Math.floor(view.y1 / TILE));
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push([tx, ty]);
    return out;
  }

  private renderTile(terrain: Terrain, tx: number, ty: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    // Рамка в пиксель с цветом соседей: при растяжении края тайлов сходятся без шва.
    const size = TILE_PX + 2;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const d = TILE_RES;
    const table = BIOMES[terrain.biome].palette.hypso;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = tx * TILE + (px - 0.5) * TILE_RES;
        const y = ty * TILE + (py - 0.5) * TILE_RES;
        const h = terrain.heightAt({ x, y });
        const gx = (terrain.heightAt({ x: x + d, y }) - terrain.heightAt({ x: x - d, y })) / (2 * d);
        const gy = (terrain.heightAt({ x, y: y + d }) - terrain.heightAt({ x, y: y - d })) / (2 * d);
        const k = 1 + hillshade(gx, gy) * 0.16;
        const [r, g, b] = hypso(h, table);
        const i = (py * size + px) * 4;
        img.data[i] = Math.min(255, r * k);
        img.data[i + 1] = Math.min(255, g * k);
        img.data[i + 2] = Math.min(255, b * k);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** Цвет земли по высоте с отмывкой — вместо ровной заливки травой. */
  drawGround(ctx: CanvasRenderingContext2D, terrain: Terrain, view: View): void {
    if (!terrain.hasRelief) return;
    this.bind(terrain);
    const x0 = Math.max(0, Math.floor(view.x0 / TILE));
    const x1 = Math.min(Math.ceil(terrain.width / TILE) - 1, Math.floor(view.x1 / TILE));
    const y0 = Math.max(0, Math.floor(view.y0 / TILE));
    const y1 = Math.min(Math.ceil(terrain.height / TILE) - 1, Math.floor(view.y1 / TILE));
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, terrain.width, terrain.height);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const key = `${tx}:${ty}`;
        let tile = this.tiles.get(key);
        if (!tile) {
          tile = this.renderTile(terrain, tx, ty);
          this.tiles.set(key, tile);
        }
        // Внахлёст на полпикселя кэша (там у соседей тот же цвет): без щелей между тайлами.
        ctx.drawImage(tile, 0.5, 0.5, TILE_PX + 1, TILE_PX + 1, tx * TILE - TILE_RES / 2, ty * TILE - TILE_RES / 2, TILE + TILE_RES, TILE + TILE_RES);
      }
    }
    ctx.restore();
  }

  /**
   * Изолинии векторно, толщиной в пикселях экрана. При отдалении сначала гаснут обычные, потом каждая
   * 5-я; с инструментом дороги (bright) — заметнее.
   */
  drawContours(ctx: CanvasRenderingContext2D, terrain: Terrain, view: View, zoom: number, bright: boolean): void {
    if (!terrain.hasRelief) return;
    this.bind(terrain);
    const fade = (z0: number, z1: number) => Math.max(0, Math.min(1, (zoom - z0) / (z1 - z0)));
    const boost = bright ? 1.7 : 1;
    const layers = [
      { major: false, alpha: 0.18 * boost * fade(0.3, 0.6), width: 1 },
      { major: true, alpha: 0.26 * boost * fade(0.17, 0.4), width: 1.5 },
    ];
    if (layers.every((l) => l.alpha <= 0)) return;
    const visible: ContourChunk[] = [];
    for (const [tx, ty] of this.visibleTiles(terrain, view)) {
      const key = `${tx}:${ty}`;
      let list = this.contours.get(key);
      if (!list) {
        list = contourTile(terrain, tx, ty);
        this.contours.set(key, list);
      }
      for (const c of list) visible.push(c);
    }
    // Точки сглаженной линии — через ~4 м; издалека берём каждую k-ю, чтобы между ними было ≥ 3 пикселей.
    const stride = Math.max(1, Math.floor(3 / (CONTOUR_SPACING * zoom))) * 2;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const layer of layers) {
      if (layer.alpha <= 0) continue;
      ctx.beginPath();
      for (const c of visible) {
        if (c.major !== layer.major || c.x1 < view.x0 || c.x0 > view.x1 || c.y1 < view.y0 || c.y0 > view.y1) continue;
        const p = c.pts;
        ctx.moveTo(p[0], p[1]);
        for (let q = stride; q < p.length - 2; q += stride) ctx.lineTo(p[q], p[q + 1]);
        ctx.lineTo(p[p.length - 2], p[p.length - 1]);
      }
      ctx.strokeStyle = `rgba(92, 78, 52, ${Math.min(0.6, layer.alpha)})`;
      ctx.lineWidth = layer.width / zoom;
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Высота рельефа у курсора, м над уровнем воды: и до начала дороги, и у её второго конца; уклон самой дороги — в подсказке стройки. */
export function heightLabel(terrain: Terrain, p: Vec): string | null {
  if (!terrain.hasRelief) return null;
  return altitudeText(terrain.altitudeAt(p));
}

/** «высота 25 м», в низине ниже уровня воды — «высота −12 м». */
export function altitudeText(m: number): string {
  const r = Math.round(m);
  return `высота ${r < 0 ? `−${-r}` : r} м`;
}
