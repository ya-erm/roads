/** Детерминированный генератор mulberry32. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Состояние для сохранения игры. */
  get seedState(): number {
    return this.state;
  }

  set seedState(value: number) {
    this.state = value >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  int(min: number, maxExclusive: number): number {
    return Math.floor(this.range(min, maxExclusive));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Гладкий шум по одной оси: сумма синусоид со случайными фазами. */
export function makeWave(rng: Rng, octaves = 3): (x: number) => number {
  const parts = Array.from({ length: octaves }, (_, i) => ({
    freq: (i + 1) * rng.range(0.6, 1.4),
    phase: rng.range(0, Math.PI * 2),
    amp: 1 / (i + 1),
  }));
  const total = parts.reduce((s, p) => s + p.amp, 0);
  return (x: number) => parts.reduce((s, p) => s + Math.sin(x * p.freq + p.phase) * p.amp, 0) / total;
}
