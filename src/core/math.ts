export const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Детерминированное «случайное» число [0, 1) от зерна и номера: раскладки без генератора случайных чисел. */
export function hash(seed: number, i: number): number {
  let h = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
