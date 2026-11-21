import { CARGO, type CargoType } from '../world/cargo';
import type { CompoundSection } from '../world/industryCompound';
import type { Art } from './industryArt';

const BULK = new Set<CargoType>(['coal', 'ore', 'copperore', 'sand', 'clay', 'stone', 'gold', 'gems']);
const SILOS = new Set<CargoType>(['grain', 'sunflower']);

/** Отдельное здание, выработка или складской двор. Размер задаёт план участка. */
export function paintIndustrySection(
  a: Art, section: CompoundSection, w: number, h: number, cargo: CargoType, roof: string, seed: number,
): void {
  const [l, t, r, b] = section.bounds;
  const x = l * w;
  const y = t * h;
  const W = (r - l) * w;
  const H = (b - t) * h;
  const cx = x + W / 2;
  const cy = y + H / 2;
  const tone = CARGO[section.cargo ?? cargo].color;
  switch (section.kind) {
    case 'field':
      a.patch(x + 1, y + 1, W - 2, H - 2, '#ceb46c', 1.5);
      a.rows(x + 1, y + 1, W - 2, H - 2, 3.6, '#b09755');
      return;
    case 'paddock':
      a.patch(x + 1, y + 1, W - 2, H - 2, '#a5ba76', 2, '#889961');
      a.herd(x + 1, y + 1, W - 2, H - 12, 8, seed, cargo === 'wool');
      a.gable(x + 4, y + H - 11, Math.min(16, W / 3), 7, 4, roof);
      return;
    case 'pond':
      a.patch(x + 2, y + 2, W - 4, H - 4, '#b0a591', 4);
      a.patch(x + 6, y + 5, W - 12, H - 10, '#789f9c', 4, '#9bb6ab');
      a.rows(x + 8, y + 7, W - 16, H - 14, 9, '#9ab6ad');
      a.pipe(x + 4, cy, x + 11, cy);
      return;
    case 'pit':
      for (let k = 0; k < 4; k++) {
        const s = 1 - k * 0.20;
        a.stain(cx, cy + k * 1.25, W * 0.46 * s, H * 0.43 * s, ['#c8ad8c', '#b69b7a', '#a58b6c', '#94775d'][k], seed, 0.085);
      }
      a.excavator(cx - 2, cy + 2, cx + 4, cy + 6);
      a.heap(x + W * 0.83, y + H * 0.26, Math.min(W, H) * 0.12, tone, seed + 3);
      return;
    case 'well':
      a.patch(x + 2, y + 2, W - 4, H - 4, '#c4bba9', 2);
      a.pumpjack(cx - 8, cy, seed, roof);
      a.tank(cx + 11, cy, Math.min(W, H) * 0.14, 7, '#cbd1d6', tone);
      return;
    case 'utilities':
      a.patch(x + 2, y + 2, W - 4, H - 4, '#b7bbaf', 2);
      a.box(x + 5, y + 5, W * 0.34, H - 10, 6, '#7d8a83', 1.8);
      a.tank(cx + W * 0.22, cy - H * 0.19, Math.min(W, H) * 0.14, 9, '#d8dcdf', '#849699');
      a.tank(cx + W * 0.22, cy + H * 0.19, Math.min(W, H) * 0.14, 9, '#d8dcdf', '#849699');
      a.pipe(cx - 2, cy, cx + W * 0.22, cy);
      return;
    case 'service':
    case 'workshop': {
      const service = section.kind === 'service';
      a.patch(x + 1, y + 1, W - 2, H - 2, '#c7c0ad', 2);
      a.gable(x + 4, y + 3, W - 8, H * (service ? 0.45 : 0.53), service ? 5 : 8, service ? '#7a806f' : roof, true);
      a.patch(x + 4, y + H * 0.60, W - 8, H * 0.34, '#b4b6b1');
      a.rows(x + 5, y + H * 0.64, W - 10, H * 0.24, 6, '#e4e1d5', true, 0.6);
      if (!service) a.box(x + W * 0.14, y + H * 0.68, 6, 4, 2.5, '#a3a6a8');
      return;
    }
    case 'warehouse':
    case 'receiving':
      cargoYard(a, section.cargo ?? cargo, x, y, W, H, roof, seed);
  }
}

function cargoYard(a: Art, cargo: CargoType, x: number, y: number, w: number, h: number, roof: string, seed: number): void {
  const tone = CARGO[cargo].color;
  a.patch(x + 1, y + 1, w - 2, h - 2, '#bfc0b7', 2);
  if (BULK.has(cargo)) {
    a.box(x + 3, y + 3, w - 6, 2.4, 2.5, '#8a8c85');
    for (let k = 0; k < 3; k++) a.heap(x + w * (0.23 + k * 0.27), y + h * 0.41, Math.min(w * 0.135, h * 0.22), tone, seed + k);
  } else if (CARGO[cargo].tank || SILOS.has(cargo)) {
    for (let k = 0; k < 3; k++) a.tank(x + w * (0.21 + k * 0.29), y + h * 0.40, Math.min(w * 0.12, h * 0.22), SILOS.has(cargo) ? 14 : 9, '#d8dce0', tone);
    a.pipe(x + w * 0.17, y + h * 0.65, x + w * 0.82, y + h * 0.65);
  } else if (cargo === 'logs' || cargo === 'planks') {
    const logs = Math.min(5, Math.max(1, Math.floor((h - 4) / 3)));
    for (let k = 0; k < 2; k++) a.logs(x + w * (0.1 + k * 0.46), y + (h - logs * 3) / 2, w * 0.33, logs, seed + k);
  } else {
    a.gable(x + 4, y + 3, w - 8, h * 0.42, 7, cargo === 'food' || cargo === 'fish' ? '#d2dce0' : roof, true);
    a.box(x + 5, y + h * 0.51, w - 10, 2, 2, '#9ea5a9');
    for (let k = 0; k < Math.floor((w - 8) / 7); k++) a.box(x + 5 + k * 7, y + h * 0.66, 5.8, h * 0.25, 3, k % 2 ? tone : '#c8a56b', 1.1);
  }
}
