import { makeWave, Rng } from '../core/rng';
import { add, closestOnSegment, dist, norm, scale, sub, Vec } from '../core/vec';
import { BiomeId, biomeOf } from './biomes';
import { areaFactor, DEFAULT_SETTINGS, MAP_SIZES, RELIEF, WATER, WorldSettings } from './settings';

/** Хэш целых координат клетки шума в [0, 1) — детерминированно по seed. */
function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2654435761) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

const smoothStep = (t: number) => t * t * (3 - 2 * t);

/** Шаг сетки высот, м. */
export const HEIGHT_CELL = 16;
/** Ширина пологой полосы берега: на ней высота плавно спускается к уровню воды. */
const BANK_BAND = 260;

/** Сглаженный шум по целочисленной сетке (билинейная интерполяция хэшей узлов). */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smoothStep(x - x0);
  const fy = smoothStep(y - y0);
  const h00 = hash2(x0, y0, seed);
  const h10 = hash2(x0 + 1, y0, seed);
  const h01 = hash2(x0, y0 + 1, seed);
  const h11 = hash2(x0 + 1, y0 + 1, seed);
  return h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
}

/** «Нет воды поблизости» в поле расстояний до берега (конечное — чтобы билинейная выборка не давала NaN). */
const FAR = 1e6;
/** Насколько выше уровня русла (доля амплитуды рельефа) река ещё разливается по низкому берегу. */
const FLOOD_RISE = 0.035;
/** Масштаб сглаживания рельефа, по которому разливается вода, м (σ размытия по Гауссу). */
const SOFT_RELIEF = 64;
/** Наименьший радиус изгиба берега, м: круче берег не поворачивает ни в воду, ни на сушу. */
const SHORE_RADIUS = 64;
/** Радиус срезания мысов: меньше SHORE_RADIUS — иначе стирались бы узкие заливы и озёра. */
const OPEN_RADIUS = 40;
/** Финальное размытие берега, м (σ): убирает мелкую волну и изломы, оставшиеся от сетки. */
const SHORE_BLUR = 32;

/** Сплайн Catmull-Rom через точки: каждый кусок делится на parts частей, концы на месте. */
function spline(pts: Vec[], parts: number): Vec[] {
  if (pts.length < 3) return pts;
  const out: Vec[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let q = 0; q < parts; q++) {
      const t = q / parts;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Плавный минимум полей расстояний: объединение двух водоёмов без излома в месте слияния (k — радиус). */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

/**
 * Поле расстояний (в воде < 0) → поле wet для shoreDistance (> 0 — вода), где вода, не связанная с узлами
 * sources (русла, дно озёр), стала сушей.
 */
function dryUnreached(field: Float32Array, sources: number[], nx: number): Float32Array {
  const wet = field.map((v) => -v);
  const reached = new Uint8Array(wet.length);
  const queue = sources.filter((k) => wet[k] > 0);
  for (const k of queue) reached[k] = 1;
  while (queue.length) {
    const k = queue.pop()!;
    const i = k % nx;
    for (const k2 of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k - nx, k + nx]) {
      if (k2 < 0 || k2 >= wet.length || reached[k2] || wet[k2] <= 0) continue;
      reached[k2] = 1;
      queue.push(k2);
    }
  }
  for (let k = 0; k < wet.length; k++) if (wet[k] > 0 && !reached[k]) wet[k] = -1;
  return wet;
}

/** Размытие поля на сетке по Гауссу (σ — в клетках); за краем — значения края. */
export function blur(src: Float32Array, nx: number, ny: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const w: number[] = [];
  let sum = 0;
  for (let q = -r; q <= r; q++) {
    w.push(Math.exp(-(q * q) / (2 * sigma * sigma)));
    sum += w[w.length - 1];
  }
  for (let q = 0; q < w.length; q++) w[q] /= sum;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let v = 0;
      for (let q = -r; q <= r; q++) v += w[q + r] * src[j * nx + Math.max(0, Math.min(nx - 1, i + q))];
      tmp[j * nx + i] = v;
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let v = 0;
      for (let q = -r; q <= r; q++) v += w[q + r] * tmp[Math.max(0, Math.min(ny - 1, j + q)) * nx + i];
      out[j * nx + i] = v;
    }
  }
  return out;
}

/**
 * Расстояние от узлов сетки до берега, м: со знаком, в воде отрицательное. Берег — нулевая изолиния
 * поля wet (> 0 — вода), его точки ищем на рёбрах сетки линейной интерполяцией; дальше расстояние
 * разносим проходами «dead reckoning»: каждый узел помнит ближайшую точку берега.
 */
export function shoreDistance(wet: Float32Array, nx: number, ny: number, cell: number): Float32Array {
  const n = nx * ny;
  // Квадраты расстояний (корень — в конце) и ближайшая точка берега каждого узла.
  const d = new Float32Array(n).fill(FAR * FAR);
  // Порог «берега рядом нет»: FAR² во Float32 округляется, сравниваем с запасом.
  const none = FAR * FAR * 0.5;
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  const seed = (k: number, x: number, y: number) => {
    const i = k % nx;
    const dx = i * cell - x;
    const dy = ((k - i) / nx) * cell - y;
    const v = dx * dx + dy * dy;
    if (v < d[k]) {
      d[k] = v;
      sx[k] = x;
      sy[k] = y;
    }
  };
  const cross = (a: number, b: number) => (Math.abs(a) < FAR && Math.abs(b) < FAR ? a / (a - b) : 0.5);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const a = wet[k];
      if (i < nx - 1 && a > 0 !== wet[k + 1] > 0) {
        const x = (i + cross(a, wet[k + 1])) * cell;
        seed(k, x, j * cell);
        seed(k + 1, x, j * cell);
      }
      if (j < ny - 1 && a > 0 !== wet[k + nx] > 0) {
        const y = (j + cross(a, wet[k + nx])) * cell;
        seed(k, i * cell, y);
        seed(k + nx, i * cell, y);
      }
    }
  }
  const pull = (k: number, k2: number, x: number, y: number) => {
    const qx = sx[k2];
    const qy = sy[k2];
    const v = (x - qx) * (x - qx) + (y - qy) * (y - qy);
    if (v < d[k] && d[k2] < none) {
      d[k] = v;
      sx[k] = qx;
      sy[k] = qy;
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < ny; j++) {
      const y = j * cell;
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const x = i * cell;
        if (i > 0) pull(k, k - 1, x, y);
        if (j > 0) {
          pull(k, k - nx, x, y);
          if (i > 0) pull(k, k - nx - 1, x, y);
          if (i < nx - 1) pull(k, k - nx + 1, x, y);
        }
      }
    }
    for (let j = ny - 1; j >= 0; j--) {
      const y = j * cell;
      for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i;
        const x = i * cell;
        if (i < nx - 1) pull(k, k + 1, x, y);
        if (j < ny - 1) {
          pull(k, k + nx, x, y);
          if (i < nx - 1) pull(k, k + nx + 1, x, y);
          if (i > 0) pull(k, k + nx - 1, x, y);
        }
      }
    }
  }
  for (let k = 0; k < n; k++) {
    const v = d[k] >= none ? FAR : Math.sqrt(d[k]);
    d[k] = wet[k] > 0 ? -v : v;
  }
  return d;
}

/** Сумма шума на нескольких масштабах — холмистая, но гладкая поверхность. Возвращает значение в [0, 1]. */
function fbm(x: number, y: number, seed: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 0.55;
  let freq = 1;
  for (let o = 0; o < 4; o++) {
    sum += valueNoise(x * freq, y * freq, seed + o * 10007) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.15;
  }
  return sum / norm;
}

export interface Lake {
  center: Vec;
  radius: number;
}

export interface Tree {
  pos: Vec;
  size: number;
  shade: number;
  hidden: boolean;
}

export interface River {
  points: Vec[];
  width: number;
}

/** Кисть рельефа: поднять, опустить или выровнять к высоте target; amount — м в центре за мазок. */
export type TerraformMode = 'raise' | 'lower' | 'flatten';
export interface TerraformEdit {
  x: number;
  y: number;
  r: number;
  mode: TerraformMode;
  amount: number;
  target?: number;
  /**
   * Площадка под город (генерация мира): кисть в полную силу до pad·r от центра, дальше плавно сходит на нет,
   * а к воде — ослабевает по полосе берега, чтобы у реки не вырос обрыв. Нет поля — обычная кисть игрока.
   */
  pad?: number;
}

/** Ниже уровня воды на столько землю не копаем — иначе котлован затопило бы. */
const DIG_ABOVE_WATER = 0.5;

export class Terrain {
  readonly width: number;
  readonly height: number;
  readonly rivers: River[] = [];
  readonly lakes: Lake[] = [];
  readonly trees: Tree[] = [];
  /** Рельеф: без него (старое сохранение) высота всюду 0. */
  private readonly relief: { amplitude: number; contour: number } | null;
  /** Своя затравка для шума высот — не трогает последовательность rng, чтобы включение рельефа
   *  не сдвигало остальную генерацию (реки, города, предприятия) у миров без него. */
  private readonly heightSeed: number;
  /** Высота воды (низина, в которую садятся русло и берега): от неё считаются высоты у курсора и изолинии. */
  readonly waterLevel: number;
  /** Шаг изолинии — для подсказки уклона инструментам. */
  readonly contourStep: number;
  /**
   * Сетка высот с шагом HEIGHT_CELL, посчитанная один раз после рек и озёр: высота в точке —
   * билинейно по ней. Без сетки каждая выборка заново мерила бы расстояние до всех рек.
   */
  private grid: Float32Array | null = null;
  private gridW = 0;
  private gridH = 0;
  /** Сетка до правок игрока и расстояние узлов до воды (в воде ≤ 0 — там рельеф не меняют). */
  private base: Float32Array | null = null;
  /**
   * Расстояние узлов до берега со знаком (в воде < 0). С рельефом берега рек и озёр — по рельефу, и
   * вода целиком описывается этим полем: isWater и отрисовка смотрят в него, а не в геометрию рек.
   */
  private waterNear: Float32Array | null = null;
  /** Правки рельефа игроком — по порядку; пишутся в сохранение. */
  readonly edits: TerraformEdit[] = [];
  /** Растёт с каждой правкой: по нему отрисовка и цена дорог понимают, что рельеф изменился. */
  version = 0;
  /** Где рельеф менялся с прошлого takeDirty (для перерисовки тайлов). */
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Биом карты: от него цвет земли и деревьев. */
  readonly biome: BiomeId;
  /** Есть ли рельеф (новый мир с выбранным «равнина / холмы / горы»); без него высота всюду 0. */
  get hasRelief(): boolean {
    return this.relief !== null;
  }
  /** Амплитуда рельефа, м (0 — рельефа нет). */
  get amplitude(): number {
    return this.relief?.amplitude ?? 0;
  }
  /** Сетка высот для отрисовки: узлы (i, j) — точки (i·cell, j·cell). */
  heightGrid(): { data: Float32Array; nx: number; ny: number; cell: number } | null {
    return this.grid && { data: this.grid, nx: this.gridW, ny: this.gridH, cell: HEIGHT_CELL };
  }
  /** Поле расстояний до берега (в воде < 0) — по нему рисуется вода; без рельефа его нет. */
  waterField(): { data: Float32Array; nx: number; ny: number; cell: number } | null {
    return this.waterNear && { data: this.waterNear, nx: this.gridW, ny: this.gridH, cell: HEIGHT_CELL };
  }

  constructor(rng: Rng, settings: WorldSettings = DEFAULT_SETTINGS) {
    this.width = MAP_SIZES[settings.size].w;
    this.height = MAP_SIZES[settings.size].h;
    // Биом добавляет к выбранным воде и рельефу своё: в тайге больше озёр и леса, в степи ровнее и суше,
    // в горах выше. У средней полосы все множители 1 — мир по seed тот же, что и до биомов.
    const biome = biomeOf(settings);
    this.biome = biome.id;
    const relief = settings.relief ? RELIEF[settings.relief] : null;
    this.relief = relief && { amplitude: relief.amplitude * biome.relief, contour: relief.contour };
    this.heightSeed = (settings.seed * 2246822519) | 0;
    // Ровно как в сетке высот (Float32Array): в воде высота над уровнем воды — точно 0.
    this.waterLevel = this.relief ? Math.fround(-this.relief.amplitude * 0.22) : 0;
    this.contourStep = this.relief?.contour ?? 10;
    const water = WATER[settings.water];
    const area = areaFactor(settings);
    // Главная река пересекает карту, остальные — притоки: впадают в уже готовые реки
    // и никогда не пересекают их.
    const rivers = Math.max(1, Math.round(rng.int(water.rivers[0], water.rivers[1] + 1) * biome.rivers));
    const tributaries = (settings.terrainVersion ?? 1) >= 2;
    for (let i = 0; i < rivers; i++) {
      const width = i === 0 ? rng.range(80, 110) : i === 1 ? rng.range(50, 70) : rng.range(40, 55);
      const river = i === 0 || !tributaries ? this.makeRiver(rng, rng.chance(0.5), width) : this.makeTributary(rng, width);
      if (river) {
        this.valleySeek(river.points);
        this.rivers.push(river);
      }
    }

    const lakeCount = Math.round(rng.int(water.lakes[0], water.lakes[1] + 1) * Math.max(0.6, area) * biome.lakes);
    for (let i = 0; i < lakeCount; i++) {
      // С рельефом перебираем несколько подходящих мест и ставим озеро в самой низкой низине.
      const tries = this.relief ? 6 : 1;
      let best: Lake | null = null;
      for (let attempt = 0; attempt < 20 && (!best || attempt < tries * 4); attempt++) {
        const center = { x: rng.range(300, this.width - 300), y: rng.range(300, this.height - 300) };
        const radius = rng.range(80, 150);
        if (this.isWater(center, radius + 200)) continue;
        if (!best || this.rawHeightAt(center) < this.rawHeightAt(best.center)) best = { center, radius };
        if (!this.relief) break;
      }
      // Центр — на дно ближайшей котловины: озеро разольётся по ней до своего уровня (см. lakeWet).
      if (best) this.lakes.push(this.relief ? { center: this.descend(best.center, best.radius * 1.5), radius: best.radius } : best);
    }
    this.buildHeightGrid();

    // Леса — пятнами вокруг случайных центров.
    const forests = Math.round(rng.int(34, 48) * area * biome.forests);
    for (let f = 0; f < forests; f++) {
      this.addForest({ x: rng.range(0, this.width), y: rng.range(0, this.height) }, rng.range(120, 340), rng);
    }
    for (let i = 0; i < 2600 * area * biome.trees; i++) {
      const pos = { x: rng.range(0, this.width), y: rng.range(0, this.height) };
      if (this.isWater(pos, 6)) continue;
      this.trees.push({ pos, size: rng.range(4, 8), shade: rng.next(), hidden: false });
    }
    this.generated = true;
  }

  /** Леса, посаженные после генерации рельефа (у лесозаготовок) — нужны для сохранения. */
  readonly extraForests: { c: Vec; r: number }[] = [];
  private generated = false;

  addForest(c: Vec, r: number, rng: Rng): void {
    if (this.generated) this.extraForests.push({ c, r });
    const count = Math.floor(r * 0.9);
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const d = Math.sqrt(rng.next()) * r;
      const pos = { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
      if (!this.inBounds(pos) || this.isWater(pos, 6)) continue;
      this.trees.push({ pos, size: rng.range(5, 10), shade: rng.next(), hidden: false });
    }
  }

  private makeRiver(rng: Rng, vertical: boolean, width: number): River {
    const wave = makeWave(rng);
    const along = vertical ? this.height : this.width;
    const across = vertical ? this.width : this.height;
    const base = across * rng.range(0.25, 0.75);
    const amp = across * 0.12;
    const points: Vec[] = [];
    // Точки часто (каждые ~40 ед.), чтобы русло было плавным, а не ломаным.
    const steps = Math.ceil(along / 40);
    for (let i = -2; i <= steps + 2; i++) {
      const t = (i / steps) * along;
      const off = base + wave(t / 500) * amp;
      points.push(vertical ? { x: off, y: t } : { x: t, y: off });
    }
    return { points, width };
  }

  /**
   * Приток: от края карты, извиваясь, до точки на одной из готовых рек — там они сливаются.
   * Варианты, задевающие другие реки по пути, отбрасываются.
   */
  private makeTributary(rng: Rng, width: number): River | null {
    for (let attempt = 0; attempt < 40; attempt++) {
      const host = this.rivers[rng.int(0, this.rivers.length)];
      // Сливаются не у самого края карты.
      const inner = host.points.filter((q) => this.inBounds(q, 600));
      if (inner.length < 4) continue;
      const end = inner[rng.int(1, inner.length - 1)];
      const start = this.edgePoint(rng);
      const length = dist(start, end);
      if (length < 1400) continue;
      const dir = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
      const normal = { x: -dir.y, y: dir.x };
      const wave = makeWave(rng);
      const amp = Math.min(length * 0.08, 420);
      const steps = Math.ceil(length / 40);
      const points: Vec[] = [];
      // Отступ за край, чтобы русло уходило за карту, а не обрывалось на границе.
      for (let i = -2; i <= steps; i++) {
        const u = i / steps;
        // Извивы затухают к концам: начало у края и точное впадение в реку.
        const envelope = Math.pow(Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, u)))), 0.7);
        const off = wave(u * length / 500) * amp * envelope;
        points.push({ x: start.x + dir.x * u * length + normal.x * off, y: start.y + dir.y * u * length + normal.y * off });
      }
      if (this.crossesRivers(points, width, end)) continue;
      return { points, width };
    }
    return null;
  }

  /** Случайная точка на краю карты. */
  private edgePoint(rng: Rng): Vec {
    const side = rng.int(0, 4);
    const x = rng.range(this.width * 0.1, this.width * 0.9);
    const y = rng.range(this.height * 0.1, this.height * 0.9);
    if (side === 0) return { x, y: 0 };
    if (side === 1) return { x, y: this.height };
    if (side === 2) return { x: 0, y };
    return { x: this.width, y };
  }

  /** Задевает ли русло другие реки где-то, кроме места впадения mouth. */
  private crossesRivers(points: Vec[], width: number, mouth: Vec): boolean {
    for (const p of points) {
      for (const r of this.rivers) {
        // Около устья реки и должны встретиться.
        if (dist(p, mouth) < r.width / 2 + width + 160) continue;
        for (let i = 0; i < r.points.length - 1; i++) {
          if (closestOnSegment(p, r.points[i], r.points[i + 1]).d < (r.width + width) / 2 + 120) return true;
        }
      }
    }
    return false;
  }

  riverDistance(p: Vec): number {
    let best = Infinity;
    for (const r of this.rivers) {
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i];
        const b = r.points[i + 1];
        // Быстрый отсев далёких кусков.
        if (Math.abs(p.x - a.x) > 400 && Math.abs(p.x - b.x) > 400) continue;
        if (Math.abs(p.y - a.y) > 400 && Math.abs(p.y - b.y) > 400) continue;
        best = Math.min(best, closestOnSegment(p, a, b).d - r.width / 2);
      }
    }
    return best;
  }

  /** Находится ли точка в воде (с запасом margin). */
  isWater(p: Vec, margin = 0): boolean {
    if (this.waterNear) return this.sample(this.waterNear, p) < margin;
    if (this.riverDistance(p) < margin) return true;
    for (const lake of this.lakes) {
      if (dist(p, lake.center) < lake.radius + margin) return true;
    }
    return false;
  }

  inBounds(p: Vec, margin = 0): boolean {
    return p.x >= margin && p.y >= margin && p.x <= this.width - margin && p.y <= this.height - margin;
  }

  /** Высота рельефа (шум по seed) без учёта берегов — для сравнения низин при генерации рек и озёр. */
  private rawHeightAt(p: Vec): number {
    if (!this.relief) return 0;
    const invWave = 1 / 950;
    return (fbm(p.x * invWave, p.y * invWave, this.heightSeed) - 0.5) * 2 * this.relief.amplitude;
  }

  /**
   * Высота рельефа в точке, м: детерминирована по seed, сглаженный шум нескольких масштабов.
   * У воды и в полосе вдоль берега (пологий склон) высота тянется к уровню воды. Без рельефа — всюду 0
   * (старое сохранение).
   */
  heightAt(p: Vec): number {
    return this.grid ? this.sample(this.grid, p) : 0;
  }

  /**
   * Высота над уровнем воды, м (в воде и без рельефа — 0; в сухой низине ниже воды — меньше 0): её показывают
   * подсказки у курсора, и по ней идут изолинии.
   */
  altitudeAt(p: Vec): number {
    return this.grid ? this.heightAt(p) - this.waterLevel : 0;
  }

  /** Значение поля на сетке высот в точке — билинейно; за краем карты — как на краю. */
  private sample(g: Float32Array, p: Vec): number {
    const nx = this.gridW;
    const fx = Math.max(0, Math.min(nx - 1.001, p.x / HEIGHT_CELL));
    const fy = Math.max(0, Math.min(this.gridH - 1.001, p.y / HEIGHT_CELL));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const k = j * nx + i;
    const top = g[k] + (g[k + 1] - g[k]) * tx;
    const bottom = g[k + nx] + (g[k + nx + 1] - g[k + nx]) * tx;
    return top + (bottom - top) * ty;
  }

  /**
   * Сетка высот и вода. Сначала поле «мокроты» wet (> 0 — вода): реки и озёра растекаются по рельефу
   * (см. riverWet, lakeWet); остаётся только вода, связанная с руслом или дном озера. Берег — нулевая
   * изолиния wet, от него — расстояние до воды; по нему высота спускается к уровню воды полосой BANK_BAND.
   */
  private buildHeightGrid(): void {
    if (!this.relief) return;
    const nx = Math.ceil(this.width / HEIGHT_CELL) + 1;
    const ny = Math.ceil(this.height / HEIGHT_CELL) + 1;
    this.gridW = nx;
    this.gridH = ny;
    const raw = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) raw[j * nx + i] = this.rawHeightAt({ x: i * HEIGHT_CELL, y: j * HEIGHT_CELL });
    const wet = new Float32Array(nx * ny).fill(-FAR);
    const channel = new Float32Array(nx * ny).fill(FAR);
    const sources: number[] = [];
    // Воде мелкие бугры рельефа не указ: разлив и озёра — по сглаженному рельефу, иначе берег зубчатый.
    const soft = blur(raw, nx, ny, SOFT_RELIEF / HEIGHT_CELL);
    this.rivers.forEach((r, i) => this.riverWet(r, i, soft, wet, channel, sources));
    for (const l of this.lakes) this.lakeWet(l, soft, wet, sources);
    // Лужи в соседних низинах, не связанные с водой, — суша.
    const rough = shoreDistance(dryUnreached(wet.map((v) => -v), sources, nx), nx, ny, HEIGHT_CELL);
    // Берег плавный: «закрытие» (радиус SHORE_RADIUS) скругляет впадины берега, «открытие» (OPEN_RADIUS) — мысы
    // и концы заливов: ни зубцов, ни острых углов. Русло рек и дно озёр сохраняем как есть (иначе открытие рвёт
    // узкие протоки и стирает узкие озёра) и плавно сливаем с остальной водой; у русла на внутренней стороне
    // изгибов углы — их и места слияния скругляет ещё одно закрытие.
    const offset = (f: Float32Array, by: number) => shoreDistance(f.map((v) => -(v + by)), nx, ny, HEIGHT_CELL);
    const close = (f: Float32Array) => offset(offset(f, -SHORE_RADIUS), SHORE_RADIUS);
    const open = (f: Float32Array) => offset(offset(f, OPEN_RADIUS), -OPEN_RADIUS);
    const opened = open(close(rough));
    const merged = close(opened.map((v, k) => smoothMin(v, channel[k], SHORE_RADIUS * 0.6)));
    // Мелкую волну и изломы от сетки — размытием; узкое русло, если размытие его сузило, — снова целиком, а угол
    // в месте слияния (и у впадения притока) скругляет закрытие.
    let polished = close(offset(blur(merged, nx, ny, SHORE_BLUR / HEIGHT_CELL), 0).map((v, k) => smoothMin(v, channel[k], SHORE_BLUR)));
    // Узкое вытянутое озеро открытие может стереть целиком — тогда оставляем хотя бы его дно.
    const lost = this.lakes.filter((l) => this.sample(polished, l.center) >= 0);
    if (lost.length) {
      polished = close(
        polished.map((v, k) => {
          const p = { x: (k % nx) * HEIGHT_CELL, y: Math.floor(k / nx) * HEIGHT_CELL };
          return lost.reduce((f, l) => smoothMin(f, dist(p, l.center) - l.radius * 0.5, SHORE_BLUR), v);
        }),
      );
    }
    const near = shoreDistance(dryUnreached(polished, sources, nx), nx, ny, HEIGHT_CELL);
    const grid = new Float32Array(nx * ny);
    for (let k = 0; k < grid.length; k++) {
      const t = smoothStep(Math.max(0, Math.min(1, near[k] / BANK_BAND)));
      grid[k] = this.waterLevel + (raw[k] - this.waterLevel) * t;
    }
    this.grid = grid;
    this.base = grid.slice();
    this.waterNear = near;
  }

  /**
   * Река в поле wet. Ширина русла меняется вдоль течения (плавный шум), берега чуть разные, на изгибах
   * русло шире — сильнее у внешнего берега. Вне русла река разливается по низкому берегу: туда, где рельеф
   * поднимается над её уровнем меньше чем на FLOOD_RISE амплитуды, но не дальше spread от русла.
   * В channel — расстояние до берега самого русла (в русле < 0).
   */
  private riverWet(r: River, index: number, raw: Float32Array, wet: Float32Array, channel: Float32Array, sources: number[]): void {
    // Ось русла — сплайном через точки реки, часто: край русла отступает от неё, и на редкой ломаной
    // в каждой вершине был бы заметный излом берега.
    const pts = spline(r.points, 4);
    const n = pts.length;
    if (n < 2) return;
    const nx = this.gridW;
    const ny = this.gridH;
    const seed = this.heightSeed + 7919 * (index + 1);
    const along: number[] = [0];
    for (let i = 1; i < n; i++) along.push(along[i - 1] + dist(pts[i - 1], pts[i]));
    // Кривизна со знаком (> 0 — поворот к «левому» берегу), сглаженная по соседям.
    const turn = pts.map((p, i) => {
      if (i === 0 || i === n - 1) return 0;
      const a = sub(p, pts[i - 1]);
      const b = sub(pts[i + 1], p);
      const len = (Math.hypot(a.x, a.y) + Math.hypot(b.x, b.y)) / 2;
      return len > 0 ? Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) / len : 0;
    });
    const avg = (v: number[], w: number) => v.map((_, i) => {
      let s = 0;
      let c = 0;
      for (let q = Math.max(0, i - w); q <= Math.min(n - 1, i + w); q++, c++) s += v[q];
      return s / c;
    });
    const bend = avg(turn, 12);
    const left: number[] = [];
    const right: number[] = [];
    // Как далеко от русла река может разлиться: где-то почти нисколько, где-то — широкой заводью.
    const spread: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = along[i];
      const half = (r.width / 2) * (1 + 0.32 * (valueNoise(s / 850, 0.5, seed) * 2 - 1));
      const widen = Math.min(0.5, Math.abs(bend[i]) * 120);
      const wobble = (o: number) => 1 + 0.08 * (valueNoise(s / 450, o, seed + 1) * 2 - 1);
      left.push(half * wobble(3.5) * (1 + (bend[i] < 0 ? widen : widen * 0.3)));
      right.push(half * wobble(7.5) * (1 + (bend[i] > 0 ? widen : widen * 0.3)));
      spread.push(Math.min(100, r.width * smoothStep(valueNoise(s / 1300, 11.5, seed + 2))));
    }
    // Уровень реки — сглаженная высота рельефа вдоль русла.
    const level = avg(
      pts.map((p) => this.rawHeightAt(p)),
      24,
    );
    const rise = Math.max(0.3, this.amplitude * FLOOD_RISE);
    const pad = Math.max(...left, ...right) + Math.max(...spread) + 2 * HEIGHT_CELL;
    // Ближайший кусок русла для каждого узла рядом с рекой.
    const best = new Map<number, { d: number; s: number; t: number; side: number }>();
    for (let s = 0; s < n - 1; s++) {
      const a = pts[s];
      const b = pts[s + 1];
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - pad) / HEIGHT_CELL));
      const i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x) + pad) / HEIGHT_CELL));
      const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - pad) / HEIGHT_CELL));
      const j1 = Math.min(ny - 1, Math.ceil((Math.max(a.y, b.y) + pad) / HEIGHT_CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const q = { x: i * HEIGHT_CELL, y: j * HEIGHT_CELL };
          const c = closestOnSegment(q, a, b);
          const k = j * nx + i;
          const prev = best.get(k);
          if (prev && prev.d <= c.d) continue;
          const side = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
          best.set(k, { d: c.d, s, t: c.t, side });
        }
      }
    }
    for (const [k, { d, s, t, side }] of best) {
      const banks = side > 0 ? left : right;
      const half = banks[s] + (banks[s + 1] - banks[s]) * t;
      const h = level[s] + (level[s + 1] - level[s]) * t;
      const reach = spread[s] + (spread[s + 1] - spread[s]) * t;
      const inside = half - d;
      const flood = Math.min(half + reach - d, ((h + rise - raw[k]) / rise) * half);
      const v = Math.max(inside, flood);
      if (v > wet[k]) wet[k] = v;
      if (-inside < channel[k]) channel[k] = -inside;
      if (inside > 0) sources.push(k);
    }
  }

  /**
   * Озеро в поле wet: вода заполняет котловину вокруг дна (center) до уровня, при котором площадь
   * равна площади круга radius, — берег идёт по горизонтали рельефа. Дальше 2.6·radius от дна не растекается.
   */
  private lakeWet(l: Lake, raw: Float32Array, wet: Float32Array, sources: number[]): void {
    const nx = this.gridW;
    const ny = this.gridH;
    const cell = HEIGHT_CELL;
    const ci = Math.max(0, Math.min(nx - 1, Math.round(l.center.x / cell)));
    const cj = Math.max(0, Math.min(ny - 1, Math.round(l.center.y / cell)));
    const bound = l.radius * 2.6;
    const reach = Math.ceil(bound / cell) + 2;
    const i0 = Math.max(0, ci - reach);
    const i1 = Math.min(nx - 1, ci + reach);
    const j0 = Math.max(0, cj - reach);
    const j1 = Math.min(ny - 1, cj + reach);
    const bw = i1 - i0 + 1;
    const local = (k: number) => (Math.floor(k / nx) - j0) * bw + (k % nx) - i0;
    const inside = (k: number) => Math.hypot((k % nx) * cell - l.center.x, Math.floor(k / nx) * cell - l.center.y) < bound;
    const fill = (L: number): Uint8Array => {
      const seen = new Uint8Array(bw * (j1 - j0 + 1));
      const start = cj * nx + ci;
      const queue = [start];
      seen[local(start)] = 1;
      while (queue.length) {
        const k = queue.pop()!;
        const i = k % nx;
        const j = (k - i) / nx;
        for (const [di, dj] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ]) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < i0 || ii > i1 || jj < j0 || jj > j1) continue;
          const k2 = jj * nx + ii;
          if (seen[local(k2)] || raw[k2] >= L || !inside(k2)) continue;
          seen[local(k2)] = 1;
          queue.push(k2);
        }
      }
      return seen;
    };
    const count = (m: Uint8Array) => m.reduce((s, v) => s + v, 0);
    const target = (Math.PI * l.radius * l.radius) / (cell * cell);
    const floor = raw[cj * nx + ci];
    let lo = floor;
    let hi = floor + Math.max(1, this.amplitude);
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      if (count(fill(mid)) < target) lo = mid;
      else hi = mid;
    }
    const L = hi;
    const lake = fill(L);
    // Метры «вглубь» от берега: разницу высот переводим в расстояние по средней крутизне берега.
    const scaleK = l.radius / Math.max(0.3, L - floor);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        let v = Math.min((L - raw[k]) * scaleK, bound - Math.hypot(i * cell - l.center.x, j * cell - l.center.y));
        if (lake[local(k)]) sources.push(k);
        else v = Math.min(v, -1);
        if (v > wet[k]) wet[k] = v;
      }
    }
  }

  /** Спуск по рельефу к ближайшей низине (не дальше maxDist от start). */
  private descend(start: Vec, maxDist: number): Vec {
    let p = start;
    const step = 24;
    for (let it = 0; it < 80; it++) {
      const h = this.rawHeightAt(p);
      let next: Vec | null = null;
      let low = h;
      for (let a = 0; a < 8; a++) {
        const q = { x: p.x + Math.cos((a * Math.PI) / 4) * step, y: p.y + Math.sin((a * Math.PI) / 4) * step };
        const hq = this.rawHeightAt(q);
        if (hq < low && dist(q, start) <= maxDist && this.inBounds(q, 300)) {
          low = hq;
          next = q;
        }
      }
      if (!next) break;
      p = next;
    }
    return p;
  }

  /** Убирает реки и озёра (пустая карта для тестовых сцен). */
  clearWater(): void {
    this.rivers.length = 0;
    this.lakes.length = 0;
    if (this.grid) {
      this.buildHeightGrid();
      for (const e of this.edits) this.brush(e, true);
      this.version++;
      this.markDirty(0, 0, this.width, this.height);
    }
  }

  /**
   * Мазок кисти: изменение высоты в узлах сетки внутри круга, плавно к краю. write — применить,
   * иначе только посчитать. Ответ — объём грунта, м³.
   */
  private brush(e: TerraformEdit, write: boolean): number {
    const g = this.grid;
    const near = this.waterNear;
    if (!g || !near) return 0;
    const nx = this.gridW;
    const i0 = Math.max(0, Math.floor((e.x - e.r) / HEIGHT_CELL));
    const i1 = Math.min(nx - 1, Math.ceil((e.x + e.r) / HEIGHT_CELL));
    const j0 = Math.max(0, Math.floor((e.y - e.r) / HEIGHT_CELL));
    const j1 = Math.min(this.gridH - 1, Math.ceil((e.y + e.r) / HEIGHT_CELL));
    const floor = this.waterLevel + DIG_ABOVE_WATER;
    let volume = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i * HEIGHT_CELL - e.x, j * HEIGHT_CELL - e.y);
        const k = j * nx + i;
        if (d >= e.r || near[k] <= 0) continue;
        const w =
          e.pad === undefined
            ? smoothStep(1 - d / e.r)
            : smoothStep(Math.min(1, (e.r - d) / (e.r * (1 - e.pad)))) * smoothStep(Math.min(1, near[k] / BANK_BAND));
        const h = g[k];
        let next = h;
        if (e.mode === 'raise') next = h + e.amount * w;
        else if (e.mode === 'lower') next = Math.max(Math.min(h, floor), h - e.amount * w);
        else next = h + ((e.target ?? h) - h) * Math.min(1, w * e.amount * 0.5);
        volume += Math.abs(next - h) * HEIGHT_CELL * HEIGHT_CELL;
        if (write) g[k] = next;
      }
    }
    return volume;
  }

  /** Сколько грунта сдвинет мазок, м³ (рельеф не меняется). */
  terraformVolume(e: TerraformEdit): number {
    return this.brush(e, false);
  }

  /** Меняет рельеф мазком кисти и запоминает правку; ответ — объём грунта, м³. */
  terraform(e: TerraformEdit): number {
    if (!this.grid) return 0;
    const v = this.brush(e, true);
    this.edits.push(e);
    this.version++;
    this.markDirty(e.x - e.r, e.y - e.r, e.x + e.r, e.y + e.r);
    return v;
  }

  /** Оставляет только первые n правок (отмена): рельеф пересобирается с исходного. */
  truncateEdits(n: number): void {
    if (!this.grid || !this.base || n >= this.edits.length) return;
    const undone = this.edits.splice(n);
    this.grid.set(this.base);
    for (const e of this.edits) this.brush(e, true);
    for (const e of undone) this.markDirty(e.x - e.r, e.y - e.r, e.x + e.r, e.y + e.r);
    this.version++;
  }

  private markDirty(x0: number, y0: number, x1: number, y1: number): void {
    const d = this.dirty;
    this.dirty = d ? { x0: Math.min(d.x0, x0), y0: Math.min(d.y0, y0), x1: Math.max(d.x1, x1), y1: Math.max(d.y1, y1) } : { x0, y0, x1, y1 };
  }

  /** Где рельеф изменился с прошлого вызова (и сброс) — для перерисовки. */
  takeDirty(): { x0: number; y0: number; x1: number; y1: number } | null {
    const d = this.dirty;
    this.dirty = null;
    return d;
  }

  /** Уклон рельефа вдоль направления dir (единичный вектор) в точке p: положителен — в гору. */
  gradeAlong(p: Vec, dir: Vec): number {
    if (!this.relief) return 0;
    const d = 6;
    return (this.heightAt(add(p, scale(dir, d))) - this.heightAt(p)) / d;
  }

  /** Модуль уклона рельефа (м подъёма на м пути) в точке — конечными разностями. */
  slopeAt(p: Vec): number {
    if (!this.relief) return 0;
    const d = 6;
    const dx = (this.heightAt({ x: p.x + d, y: p.y }) - this.heightAt({ x: p.x - d, y: p.y })) / (2 * d);
    const dy = (this.heightAt({ x: p.x, y: p.y + d }) - this.heightAt({ x: p.x, y: p.y - d })) / (2 * d);
    return Math.hypot(dx, dy);
  }

  /**
   * Сдвигает промежуточные точки русла по нормали в сторону понижения рельефа (к долине), чтобы реки
   * текли по низинам, а не поперёк холмов. Концы (устье, впадение) не трогаем.
   */
  private valleySeek(points: Vec[]): void {
    if (!this.relief || points.length < 3) return;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < points.length - 1; i++) {
        const dir = norm(sub(points[i + 1], points[i - 1]));
        const n = { x: -dir.y, y: dir.x };
        const step = 35;
        const g = (this.rawHeightAt(add(points[i], scale(n, step))) - this.rawHeightAt(add(points[i], scale(n, -step)))) / (2 * step);
        points[i] = add(points[i], scale(n, Math.max(-25, Math.min(25, -g * 600))));
      }
    }
    // Сдвиги соседних точек разные — сглаживаем русло, чтобы повороты были плавными, без изломов.
    for (let pass = 0; pass < 4; pass++) {
      const prev = points.map((p) => ({ ...p }));
      for (let i = 1; i < points.length - 1; i++) {
        points[i] = { x: prev[i].x * 0.5 + (prev[i - 1].x + prev[i + 1].x) * 0.25, y: prev[i].y * 0.5 + (prev[i - 1].y + prev[i + 1].y) * 0.25 };
      }
    }
  }
}
