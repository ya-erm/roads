/**
 * Биомы: у каждого свой набор предприятий (и значит цепочек), свои потребности городов и свой вид карты —
 * леса, вода, высота рельефа и цвет земли. Биом хранится в настройках партии; нет поля — старый мир
 * средней полосы ровно таким, каким он был до биомов (без льна и глины).
 */
import { BASE_TOWN_CARGO, CargoType, EXTRA_TOWN_CARGO, FREIGHT, IndustryKind } from './cargo';

export type BiomeId = 'temperate' | 'taiga' | 'steppe' | 'mountains' | 'desert';

type Rgb = [number, number, number];

export interface BiomePalette {
  /** Цвет земли по высоте, м: от низин к вершинам. */
  hypso: [number, Rgb][];
  /** Заливка карты без рельефа и миникарты. */
  grass: string;
  /** Вне карты. */
  outside: string;
  /** Островки разметки на развязках — в тон траве. */
  island: string;
  trees: string[];
  /** Размер деревьев на карте: кусты в пустыне и степи мельче. */
  treeScale: number;
}

export interface BiomeInfo {
  id: BiomeId;
  name: string;
  /** Одной фразой — подсказка на экране новой игры. */
  pitch: string;
  /** Множитель числа предприятий вида (от count). Нет вида — его в биоме нет. */
  industries: Partial<Record<IndustryKind, number>>;
  /** Основные потребности городов (2–3 на город) и продукция, которую просят города покрупнее. */
  towns: CargoType[];
  extra: CargoType[];
  /** Множители: пятна леса, отдельные деревья, озёра, реки, высота рельефа. */
  forests: number;
  trees: number;
  lakes: number;
  rivers: number;
  relief: number;
  /** Эти предприятия ставятся у воды (рыбаки — в любом биоме). */
  nearWater: IndustryKind[];
  palette: BiomePalette;
}

/** Предприятия мира до биомов: у сохранения без поля biome только они. */
export const LEGACY_KINDS: ReadonlySet<IndustryKind> = new Set<IndustryKind>([
  'farm',
  'forest',
  'coalmine',
  'ironmine',
  'oilwell',
  'quarry',
  'foodplant',
  'sawmill',
  'steelmill',
  'refinery',
  'buildmat',
  'factory',
  'ranch',
  'sandpit',
  'meatplant',
  'glassworks',
  'furniture',
  'cement',
]);

const classic: Partial<Record<IndustryKind, number>> = Object.fromEntries([...LEGACY_KINDS].map((k) => [k, 1]));

export const BIOMES: Record<BiomeId, BiomeInfo> = {
  temperate: {
    id: 'temperate',
    name: 'Средняя полоса',
    pitch: 'Луга, смешанный лес и реки. Все классические цепочки, а ещё лён и глина.',
    industries: { ...classic, flaxfarm: 0.7, claypit: 1, linenmill: 1, brickworks: 1 },
    towns: BASE_TOWN_CARGO,
    extra: ['glass', 'furniture', 'textiles'],
    forests: 1,
    trees: 1,
    lakes: 1,
    rivers: 1,
    relief: 1,
    nearWater: [],
    palette: {
      hypso: [
        [-40, [172, 206, 142]],
        [0, [198, 222, 166]],
        [25, [222, 228, 168]],
        [55, [232, 214, 156]],
        [90, [214, 184, 136]],
        [125, [186, 164, 142]],
        [155, [208, 202, 196]],
      ],
      grass: '#d6e2bd',
      outside: '#a9b98c',
      island: '#b4cf93',
      trees: ['#8fb46a', '#7aa55a', '#9cc177', '#6e9a52'],
      treeScale: 1,
    },
  },
  taiga: {
    id: 'taiga',
    name: 'Тайга',
    pitch: 'Тёмный хвойный лес и много озёр. Лес, рыба и золото; полей и песка нет.',
    industries: {
      forest: 2,
      coalmine: 1,
      ironmine: 1,
      oilwell: 1,
      quarry: 1,
      fishery: 1,
      goldmine: 1,
      sawmill: 1.5,
      steelmill: 1,
      refinery: 1,
      buildmat: 1,
      factory: 1,
      cannery: 1,
      papermill: 1,
      jeweler: 1,
    },
    towns: ['food', 'goods', 'fuel', 'construction'],
    extra: ['paper', 'jewelry'],
    forests: 2.5,
    trees: 1.4,
    lakes: 1.7,
    rivers: 1.3,
    relief: 1,
    nearWater: ['goldmine'],
    palette: {
      hypso: [
        [-40, [150, 188, 140]],
        [0, [172, 204, 158]],
        [25, [184, 206, 160]],
        [55, [192, 200, 162]],
        [90, [172, 176, 154]],
        [125, [160, 162, 156]],
        [155, [222, 226, 228]],
      ],
      grass: '#b9d1a6',
      outside: '#8ea67e',
      island: '#a3c08f',
      trees: ['#4f7d4c', '#5c8c56', '#46704a', '#3f6844'],
      treeScale: 1,
    },
  },
  steppe: {
    id: 'steppe',
    name: 'Степь',
    pitch: 'Ровная сухая степь почти без леса. Зерно, скот, овцы и подсолнечник, нефть и газ.',
    industries: {
      farm: 1.5,
      ranch: 1.5,
      oilwell: 1,
      quarry: 1,
      sandpit: 1,
      coalmine: 0.7,
      sheepfarm: 1,
      sunflower: 1,
      gasfield: 1,
      foodplant: 1.5,
      meatplant: 2,
      refinery: 1,
      buildmat: 1,
      cement: 1,
      glassworks: 1,
      woolmill: 2,
      oilmill: 2,
      gasplant: 1,
    },
    towns: ['food', 'fuel', 'construction'],
    extra: ['glass', 'textiles'],
    forests: 0.12,
    trees: 0.35,
    lakes: 0.6,
    rivers: 0.8,
    relief: 0.55,
    nearWater: [],
    palette: {
      hypso: [
        [-40, [196, 208, 150]],
        [0, [224, 222, 160]],
        [25, [232, 220, 152]],
        [55, [232, 206, 142]],
        [90, [214, 184, 132]],
        [125, [194, 168, 140]],
        [155, [210, 204, 196]],
      ],
      grass: '#e2dca0',
      outside: '#c2b97c',
      island: '#d0cc8c',
      trees: ['#9cae6a', '#a8b874', '#8fa262', '#b0b67a'],
      treeScale: 0.8,
    },
  },
  mountains: {
    id: 'mountains',
    name: 'Горы',
    pitch: 'Скалы, снежные вершины и долины. Уголь, руда, медь, самоцветы и золото; нефти и песка нет.',
    industries: {
      coalmine: 1.3,
      ironmine: 1.3,
      quarry: 1.3,
      forest: 1,
      ranch: 1,
      farm: 0.5,
      gemmine: 1,
      coppermine: 1,
      goldmine: 1,
      steelmill: 1.5,
      sawmill: 1,
      factory: 1,
      buildmat: 1,
      foodplant: 0.5,
      meatplant: 1,
      gemcutter: 1,
      jeweler: 1,
      smelter: 2,
      electro: 1,
    },
    towns: ['food', 'goods', 'construction'],
    extra: ['jewelry'],
    forests: 1.1,
    trees: 1,
    lakes: 0.8,
    rivers: 1,
    relief: 1.3,
    nearWater: [],
    palette: {
      // Камень начинается низко — горы видно и на «Холмах»; снег — на вершинах «Гор».
      hypso: [
        [-60, [158, 192, 144]],
        [-10, [176, 202, 158]],
        [15, [190, 198, 162]],
        [40, [184, 178, 160]],
        [75, [168, 162, 152]],
        [120, [160, 156, 152]],
        [160, [214, 214, 214]],
        [195, [244, 245, 246]],
      ],
      grass: '#c4d6b4',
      outside: '#99a88a',
      island: '#adc59a',
      trees: ['#5f8c55', '#6e9a5c', '#577f50', '#4d7448'],
      treeScale: 1,
    },
  },
  desert: {
    id: 'desert',
    name: 'Пустыня',
    pitch: 'Пески, редкие реки и оазисы. Нефть, газ, песок и хлопок у воды; леса и руды нет.',
    industries: {
      oilwell: 2,
      sandpit: 2,
      quarry: 1,
      ranch: 1,
      coalmine: 0.5,
      farm: 0.5,
      cottonfarm: 1,
      gasfield: 1.5,
      refinery: 1.5,
      glassworks: 2,
      cement: 2,
      buildmat: 1,
      foodplant: 0.5,
      meatplant: 1,
      cottonmill: 2,
      gasplant: 2,
    },
    towns: ['food', 'fuel', 'construction'],
    extra: ['glass', 'textiles'],
    forests: 0,
    trees: 0.2,
    lakes: 0.35,
    rivers: 0.7,
    relief: 0.7,
    nearWater: ['farm', 'cottonfarm'],
    palette: {
      hypso: [
        [-40, [190, 204, 150]],
        [-20, [226, 218, 166]],
        [0, [236, 222, 172]],
        [25, [238, 214, 160]],
        [55, [232, 198, 142]],
        [90, [216, 172, 122]],
        [125, [192, 152, 114]],
        [155, [200, 180, 160]],
      ],
      grass: '#ecdcae',
      outside: '#cdb889',
      island: '#dccb96',
      trees: ['#a7a66c', '#b3ae74', '#9a9a64', '#8f9a5e'],
      treeScale: 0.6,
    },
  },
};

export const BIOME_LIST = Object.values(BIOMES);

interface HasBiome {
  biome?: BiomeId;
}

/** Биом партии; у старого сохранения поля нет — средняя полоса. */
export const biomeOf = (s: HasBiome): BiomeInfo => BIOMES[s.biome ?? 'temperate'];

/** Множитель числа предприятий вида в мире: 0 — таких нет. Старый мир — ровно прежний набор. */
export function industryShare(s: HasBiome, kind: IndustryKind): number {
  if (!s.biome) return LEGACY_KINDS.has(kind) ? 1 : 0;
  return BIOMES[s.biome].industries[kind] ?? 0;
}

/** Что просят города: основные потребности и продукция для городов покрупнее. */
export function townCargo(s: HasBiome): { base: CargoType[]; extra: CargoType[] } {
  if (!s.biome) return { base: BASE_TOWN_CARGO, extra: EXTRA_TOWN_CARGO };
  const b = BIOMES[s.biome];
  return { base: b.towns, extra: b.extra };
}

/** Биом «по seed»: тот же seed — тот же биом. Своя смесь seed — не зависит от остальной генерации. */
export function biomeForSeed(seed: number): BiomeId {
  let h = Math.imul(seed ^ 0x5bd1e995, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return BIOME_LIST[(h >>> 0) % BIOME_LIST.length].id;
}

/** Сырьё биома (что добывают) — для подсказок: виды с множителем побольше — первыми. */
export function biomeRaw(id: BiomeId, kinds: { kind: IndustryKind; produces: CargoType; accepts: CargoType[] }[]): CargoType[] {
  const b = BIOMES[id];
  return kinds
    .filter((t) => !t.accepts.length && (b.industries[t.kind] ?? 0) > 0)
    .sort((x, y) => (b.industries[y.kind] ?? 0) - (b.industries[x.kind] ?? 0))
    .map((t) => t.produces)
    .filter((c, i, all) => all.indexOf(c) === i);
}

/** Грузы, которые встречаются на этой карте: их производят, принимают или просят города. По порядку FREIGHT. */
export function cargoOnMap(industries: { info: { produces: CargoType; accepts: CargoType[] } }[], towns: { demands: CargoType[] }[]): CargoType[] {
  const seen = new Set<CargoType>();
  for (const i of industries) {
    seen.add(i.info.produces);
    for (const c of i.info.accepts) seen.add(c);
  }
  for (const t of towns) for (const c of t.demands) seen.add(c);
  return FREIGHT.filter((c) => seen.has(c));
}
