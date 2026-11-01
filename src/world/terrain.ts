import { makeWave, Rng } from '../core/rng';
import { closestOnSegment, dist, Vec } from '../core/vec';
import { areaFactor, DEFAULT_SETTINGS, MAP_SIZES, WATER, WorldSettings } from './settings';

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

export class Terrain {
  readonly width: number;
  readonly height: number;
  readonly rivers: River[] = [];
  readonly lakes: Lake[] = [];
  readonly trees: Tree[] = [];

  constructor(rng: Rng, settings: WorldSettings = DEFAULT_SETTINGS) {
    this.width = MAP_SIZES[settings.size].w;
    this.height = MAP_SIZES[settings.size].h;
    const water = WATER[settings.water];
    const area = areaFactor(settings);
    // Главная река пересекает карту, остальные — притоки: впадают в уже готовые реки
    // и никогда не пересекают их.
    const rivers = rng.int(water.rivers[0], water.rivers[1] + 1);
    const tributaries = (settings.terrainVersion ?? 1) >= 2;
    for (let i = 0; i < rivers; i++) {
      const width = i === 0 ? rng.range(80, 110) : i === 1 ? rng.range(50, 70) : rng.range(40, 55);
      const river = i === 0 || !tributaries ? this.makeRiver(rng, rng.chance(0.5), width) : this.makeTributary(rng, width);
      if (river) this.rivers.push(river);
    }

    const lakeCount = Math.round(rng.int(water.lakes[0], water.lakes[1] + 1) * Math.max(0.6, area));
    for (let i = 0; i < lakeCount; i++) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const center = { x: rng.range(300, this.width - 300), y: rng.range(300, this.height - 300) };
        const radius = rng.range(80, 150);
        if (!this.isWater(center, radius + 200)) {
          this.lakes.push({ center, radius });
          break;
        }
      }
    }

    // Леса — пятнами вокруг случайных центров.
    const forests = Math.round(rng.int(34, 48) * area);
    for (let f = 0; f < forests; f++) {
      this.addForest({ x: rng.range(0, this.width), y: rng.range(0, this.height) }, rng.range(120, 340), rng);
    }
    for (let i = 0; i < 2600 * area; i++) {
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
    if (this.riverDistance(p) < margin) return true;
    for (const lake of this.lakes) {
      if (dist(p, lake.center) < lake.radius + margin) return true;
    }
    return false;
  }

  inBounds(p: Vec, margin = 0): boolean {
    return p.x >= margin && p.y >= margin && p.x <= this.width - margin && p.y <= this.height - margin;
  }
}
