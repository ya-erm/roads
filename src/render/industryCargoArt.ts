import { CARGO, type CargoType, type IndustryKind } from '../world/cargo';

const BULK = new Set<CargoType>(['ore', 'copperore', 'coal', 'stone', 'sand', 'clay', 'gold', 'gems']);

export type CargoShape = 'bulk' | 'silo' | 'tank' | 'logs' | 'planks' | 'livestock' | 'bricks' | 'crates';

/** Стройматериалы могут быть кирпичами или тарой с цементом в зависимости от производителя. */
export function cargoShape(cargo: CargoType, producer: IndustryKind): CargoShape {
  if (BULK.has(cargo)) return 'bulk';
  if (CARGO[cargo].tank) return 'tank';
  if (cargo === 'grain' || cargo === 'sunflower') return 'silo';
  if (cargo === 'logs' || cargo === 'planks' || cargo === 'livestock') return cargo;
  if (cargo === 'construction' && (producer === 'brickworks' || producer === 'buildmat')) return 'bricks';
  return 'crates';
}
