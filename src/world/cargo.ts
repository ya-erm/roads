import { MONTH_SCALE } from '../config';

export type CargoType =
  | 'passengers'
  | 'grain'
  | 'logs'
  | 'coal'
  | 'ore'
  | 'oil'
  | 'stone'
  | 'livestock'
  | 'sand'
  | 'food'
  | 'planks'
  | 'steel'
  | 'glass'
  | 'fuel'
  | 'construction'
  | 'goods'
  | 'furniture'
  // Грузы биомов: сырьё и продукция цепочек, которых нет в средней полосе (кроме льна и глины).
  | 'flax'
  | 'clay'
  | 'fish'
  | 'gold'
  | 'wool'
  | 'sunflower'
  | 'gems'
  | 'copperore'
  | 'cotton'
  | 'gas'
  | 'paper'
  | 'textiles'
  | 'jewelry'
  | 'copper';

export interface CargoInfo {
  name: string;
  color: string;
  /** Доход за единицу груза на 100 ед. расстояния. */
  rate: number;
}

export const CARGO: Record<CargoType, CargoInfo> = {
  passengers: { name: 'Пассажиры', color: '#4a8fe7', rate: 14 },
  grain: { name: 'Зерно', color: '#d9a92b', rate: 18 },
  logs: { name: 'Брёвна', color: '#8d6a43', rate: 18 },
  coal: { name: 'Уголь', color: '#3d4148', rate: 18 },
  ore: { name: 'Железная руда', color: '#a0603c', rate: 18 },
  oil: { name: 'Нефть', color: '#6a4f9e', rate: 20 },
  stone: { name: 'Камень', color: '#8f969e', rate: 16 },
  livestock: { name: 'Скот', color: '#7c9a3d', rate: 20 },
  sand: { name: 'Песок', color: '#d9b77a', rate: 16 },
  food: { name: 'Продукты', color: '#e5534b', rate: 28 },
  planks: { name: 'Доски', color: '#c99a5b', rate: 24 },
  steel: { name: 'Металл', color: '#5f7a8f', rate: 26 },
  glass: { name: 'Стекло', color: '#5fb0d3', rate: 26 },
  fuel: { name: 'Топливо', color: '#e07b39', rate: 28 },
  construction: { name: 'Стройматериалы', color: '#b5543c', rate: 26 },
  goods: { name: 'Товары', color: '#2fb8b3', rate: 34 },
  furniture: { name: 'Мебель', color: '#c0607e', rate: 32 },
  flax: { name: 'Лён', color: '#6f8cc7', rate: 18 },
  clay: { name: 'Глина', color: '#c4784e', rate: 16 },
  fish: { name: 'Рыба', color: '#3d8fbf', rate: 20 },
  gold: { name: 'Золото', color: '#b8860b', rate: 24 },
  wool: { name: 'Шерсть', color: '#a5805c', rate: 18 },
  sunflower: { name: 'Подсолнечник', color: '#6b5a1e', rate: 18 },
  gems: { name: 'Самоцветы', color: '#7b4fbf', rate: 24 },
  copperore: { name: 'Медная руда', color: '#2a7d78', rate: 18 },
  cotton: { name: 'Хлопок', color: '#6aa596', rate: 18 },
  gas: { name: 'Газ', color: '#3b6fd1', rate: 20 },
  paper: { name: 'Бумага', color: '#a39e74', rate: 28 },
  textiles: { name: 'Ткани', color: '#8e44ad', rate: 30 },
  jewelry: { name: 'Украшения', color: '#ad1457', rate: 38 },
  copper: { name: 'Медь', color: '#d9824a', rate: 26 },
};

export const FREIGHT: CargoType[] = [
  'grain',
  'logs',
  'coal',
  'ore',
  'oil',
  'stone',
  'livestock',
  'sand',
  'food',
  'planks',
  'steel',
  'glass',
  'fuel',
  'construction',
  'goods',
  'furniture',
  // Грузы биомов — в конце: у старых миров их нет, и порядок прежних грузов не меняется.
  'flax',
  'clay',
  'fish',
  'gold',
  'wool',
  'sunflower',
  'gems',
  'copperore',
  'cotton',
  'gas',
  'paper',
  'textiles',
  'jewelry',
  'copper',
];

/** Основные потребности средней полосы: их раздают всем городам (2–3 на город). В других биомах — свой набор. */
export const BASE_TOWN_CARGO: CargoType[] = ['food', 'goods', 'fuel', 'construction'];
/** Продукция новых цепочек: её дополнительно просят города покрупнее (средняя полоса старых миров). */
export const EXTRA_TOWN_CARGO: CargoType[] = ['glass', 'furniture'];
/** Что вообще могут требовать города (во всех биомах). У каждого города свой набор. */
export const TOWN_CARGO: CargoType[] = [...BASE_TOWN_CARGO, ...EXTRA_TOWN_CARGO, 'textiles', 'paper', 'jewelry'];

export type IndustryKind =
  | 'farm'
  | 'forest'
  | 'coalmine'
  | 'ironmine'
  | 'oilwell'
  | 'quarry'
  | 'foodplant'
  | 'sawmill'
  | 'steelmill'
  | 'refinery'
  | 'buildmat'
  | 'factory'
  | 'ranch'
  | 'sandpit'
  | 'meatplant'
  | 'glassworks'
  | 'furniture'
  | 'cement'
  // Предприятия биомов (src/world/biomes.ts): какие из них стоят на карте, решает биом.
  | 'flaxfarm'
  | 'claypit'
  | 'fishery'
  | 'goldmine'
  | 'sheepfarm'
  | 'sunflower'
  | 'gemmine'
  | 'coppermine'
  | 'cottonfarm'
  | 'gasfield'
  | 'linenmill'
  | 'brickworks'
  | 'cannery'
  | 'papermill'
  | 'jeweler'
  | 'woolmill'
  | 'oilmill'
  | 'gemcutter'
  | 'smelter'
  | 'electro'
  | 'cottonmill'
  | 'gasplant';

export interface IndustryType {
  kind: IndustryKind;
  name: string;
  /** Короткое имя — для названий линий. */
  short: string;
  produces: CargoType;
  /** Сырьё. Если видов несколько, нужны все сразу. */
  accepts: CargoType[];
  color: string;
  roof: string;
  w: number;
  h: number;
  /** Сколько единиц в месяц добывает (для сырьевых). */
  rate: number;
  /** Сколько штук на карте. */
  count: number;
}

/** Сколько добывает сырьевое предприятие первого уровня за месяц (было 44 — склады забивались слишком быстро). */
export const RAW_RATE = 36 * MONTH_SCALE;

export const INDUSTRY_TYPES: Record<IndustryKind, IndustryType> = {
  farm: { kind: 'farm', name: 'Ферма', short: 'Ферма', produces: 'grain', accepts: [], color: '#e6cf7a', roof: '#b5543c', w: 110, h: 80, rate: RAW_RATE, count: 4 },
  forest: { kind: 'forest', name: 'Лесозаготовка', short: 'Лесозаготовка', produces: 'logs', accepts: [], color: '#a7b98a', roof: '#6b4f33', w: 100, h: 90, rate: RAW_RATE, count: 4 },
  coalmine: { kind: 'coalmine', name: 'Угольная шахта', short: 'Шахта', produces: 'coal', accepts: [], color: '#b9b4ad', roof: '#3d4148', w: 90, h: 80, rate: RAW_RATE, count: 3 },
  ironmine: { kind: 'ironmine', name: 'Железный рудник', short: 'Рудник', produces: 'ore', accepts: [], color: '#c9ab96', roof: '#7d4a33', w: 90, h: 80, rate: RAW_RATE, count: 3 },
  oilwell: { kind: 'oilwell', name: 'Нефтяная скважина', short: 'Скважина', produces: 'oil', accepts: [], color: '#d4cfc4', roof: '#4a3b6b', w: 80, h: 80, rate: RAW_RATE, count: 3 },
  quarry: { kind: 'quarry', name: 'Карьер', short: 'Карьер', produces: 'stone', accepts: [], color: '#cfcac0', roof: '#6f757c', w: 100, h: 90, rate: RAW_RATE, count: 3 },
  foodplant: { kind: 'foodplant', name: 'Пищевой комбинат', short: 'Пищекомбинат', produces: 'food', accepts: ['grain'], color: '#e4ded2', roof: '#b04a42', w: 100, h: 70, rate: 0, count: 2 },
  sawmill: { kind: 'sawmill', name: 'Лесопилка', short: 'Лесопилка', produces: 'planks', accepts: ['logs'], color: '#e4ded2', roof: '#8a6a43', w: 100, h: 70, rate: 0, count: 2 },
  steelmill: { kind: 'steelmill', name: 'Металлургический завод', short: 'Завод металла', produces: 'steel', accepts: ['coal', 'ore'], color: '#d6d4d0', roof: '#4f6273', w: 120, h: 80, rate: 0, count: 2 },
  refinery: { kind: 'refinery', name: 'Нефтеперерабатывающий завод', short: 'НПЗ', produces: 'fuel', accepts: ['oil'], color: '#dcd8cf', roof: '#c4662f', w: 110, h: 80, rate: 0, count: 2 },
  buildmat: { kind: 'buildmat', name: 'Завод стройматериалов', short: 'Стройзавод', produces: 'construction', accepts: ['stone'], color: '#e0dbd2', roof: '#9a4a36', w: 100, h: 70, rate: 0, count: 2 },
  factory: { kind: 'factory', name: 'Завод товаров', short: 'Завод товаров', produces: 'goods', accepts: ['planks', 'steel'], color: '#dfe3e6', roof: '#23898a', w: 120, h: 80, rate: 0, count: 2 },
  // Цепочки второй волны — в конце списка: мир по старому seed сохраняет прежние предприятия, новые добавляются к ним.
  // Сырьё у них общее со старыми заводами: зерно, уголь, доски и камень теперь нужны двум видам предприятий.
  // Стекло берёт мебельная фабрика и просят города; мебель — только города.
  ranch: { kind: 'ranch', name: 'Животноводческая ферма', short: 'Животноводы', produces: 'livestock', accepts: [], color: '#b9cc8a', roof: '#8a5a3c', w: 110, h: 80, rate: RAW_RATE, count: 3 },
  sandpit: { kind: 'sandpit', name: 'Песчаный карьер', short: 'Песчаный карьер', produces: 'sand', accepts: [], color: '#e3d3ae', roof: '#9a7b4f', w: 100, h: 80, rate: RAW_RATE, count: 2 },
  meatplant: { kind: 'meatplant', name: 'Мясокомбинат', short: 'Мясокомбинат', produces: 'food', accepts: ['livestock', 'grain'], color: '#e4ded2', roof: '#8f4b5a', w: 110, h: 70, rate: 0, count: 1 },
  glassworks: { kind: 'glassworks', name: 'Стекольный завод', short: 'Стекольный', produces: 'glass', accepts: ['sand', 'coal'], color: '#dcdfe0', roof: '#3f7f9c', w: 120, h: 80, rate: 0, count: 1 },
  furniture: { kind: 'furniture', name: 'Мебельная фабрика', short: 'Мебельная', produces: 'furniture', accepts: ['planks', 'glass'], color: '#e6ddcf', roof: '#7a5236', w: 100, h: 70, rate: 0, count: 1 },
  cement: { kind: 'cement', name: 'Цементный завод', short: 'Цементный', produces: 'construction', accepts: ['stone', 'sand'], color: '#dad8d3', roof: '#7d8188', w: 120, h: 80, rate: 0, count: 1 },
  // Предприятия биомов — ещё дальше в конце: старые миры их не получают, прежние предприятия на своих местах.
  // count — сколько их в биоме с множителем 1; сам множитель (или его отсутствие) — в BIOMES.
  flaxfarm: { kind: 'flaxfarm', name: 'Льноводческое хозяйство', short: 'Льноводы', produces: 'flax', accepts: [], color: '#c9d3a6', roof: '#7d5a44', w: 110, h: 80, rate: RAW_RATE, count: 3 },
  claypit: { kind: 'claypit', name: 'Глиняный карьер', short: 'Глиняный карьер', produces: 'clay', accepts: [], color: '#d9bfa6', roof: '#8a5a44', w: 100, h: 80, rate: RAW_RATE, count: 2 },
  fishery: { kind: 'fishery', name: 'Рыболовецкая артель', short: 'Рыбаки', produces: 'fish', accepts: [], color: '#d3d7d2', roof: '#2f6f94', w: 90, h: 80, rate: RAW_RATE, count: 4 },
  goldmine: { kind: 'goldmine', name: 'Золотой прииск', short: 'Прииск', produces: 'gold', accepts: [], color: '#cfc4a8', roof: '#7a6230', w: 100, h: 80, rate: RAW_RATE, count: 2 },
  sheepfarm: { kind: 'sheepfarm', name: 'Овцеводческая ферма', short: 'Овцеферма', produces: 'wool', accepts: [], color: '#d2cf98', roof: '#8a6a4a', w: 110, h: 80, rate: RAW_RATE, count: 3 },
  sunflower: { kind: 'sunflower', name: 'Подсолнечные поля', short: 'Подсолнечник', produces: 'sunflower', accepts: [], color: '#d8cf86', roof: '#6b5a1e', w: 110, h: 80, rate: RAW_RATE, count: 3 },
  gemmine: { kind: 'gemmine', name: 'Самоцветные копи', short: 'Копи', produces: 'gems', accepts: [], color: '#c9c3bd', roof: '#5e4a7a', w: 90, h: 80, rate: RAW_RATE, count: 2 },
  coppermine: { kind: 'coppermine', name: 'Медный рудник', short: 'Медный рудник', produces: 'copperore', accepts: [], color: '#bfc4b4', roof: '#2a6560', w: 100, h: 90, rate: RAW_RATE, count: 3 },
  cottonfarm: { kind: 'cottonfarm', name: 'Хлопковая плантация', short: 'Хлопок', produces: 'cotton', accepts: [], color: '#cfd2a2', roof: '#4f7f72', w: 110, h: 80, rate: RAW_RATE, count: 3 },
  gasfield: { kind: 'gasfield', name: 'Газовый промысел', short: 'Газпромысел', produces: 'gas', accepts: [], color: '#d4d2cc', roof: '#2f58a8', w: 90, h: 80, rate: RAW_RATE, count: 2 },
  linenmill: { kind: 'linenmill', name: 'Льнокомбинат', short: 'Льнокомбинат', produces: 'textiles', accepts: ['flax'], color: '#e2ded6', roof: '#5a6f9e', w: 110, h: 70, rate: 0, count: 1 },
  brickworks: { kind: 'brickworks', name: 'Кирпичный завод', short: 'Кирпичный', produces: 'construction', accepts: ['clay'], color: '#e0d6cc', roof: '#a4513a', w: 110, h: 75, rate: 0, count: 1 },
  cannery: { kind: 'cannery', name: 'Рыбоконсервный завод', short: 'Рыбозавод', produces: 'food', accepts: ['fish'], color: '#e0e2e0', roof: '#2f6f94', w: 100, h: 70, rate: 0, count: 2 },
  papermill: { kind: 'papermill', name: 'Целлюлозно-бумажный комбинат', short: 'ЦБК', produces: 'paper', accepts: ['logs'], color: '#dedbd2', roof: '#6d7a5a', w: 120, h: 80, rate: 0, count: 2 },
  jeweler: { kind: 'jeweler', name: 'Ювелирный завод', short: 'Ювелирный', produces: 'jewelry', accepts: ['gold'], color: '#e6e0d6', roof: '#8a1c4a', w: 90, h: 70, rate: 0, count: 1 },
  woolmill: { kind: 'woolmill', name: 'Суконная фабрика', short: 'Суконная', produces: 'textiles', accepts: ['wool'], color: '#e4ddd2', roof: '#7a4a8c', w: 110, h: 70, rate: 0, count: 1 },
  oilmill: { kind: 'oilmill', name: 'Маслозавод', short: 'Маслозавод', produces: 'food', accepts: ['sunflower'], color: '#e4dfd0', roof: '#c49a1c', w: 100, h: 70, rate: 0, count: 1 },
  gemcutter: { kind: 'gemcutter', name: 'Гранильная фабрика', short: 'Гранильная', produces: 'jewelry', accepts: ['gems'], color: '#e2dee6', roof: '#5e4a7a', w: 90, h: 70, rate: 0, count: 1 },
  smelter: { kind: 'smelter', name: 'Медеплавильный завод', short: 'Медеплавильный', produces: 'copper', accepts: ['copperore', 'coal'], color: '#d8d4cc', roof: '#a85a2c', w: 120, h: 80, rate: 0, count: 1 },
  electro: { kind: 'electro', name: 'Электротехнический завод', short: 'Электрозавод', produces: 'goods', accepts: ['copper', 'steel'], color: '#dfe3e6', roof: '#3a6f8a', w: 120, h: 80, rate: 0, count: 1 },
  cottonmill: { kind: 'cottonmill', name: 'Хлопкопрядильная фабрика', short: 'Прядильная', produces: 'textiles', accepts: ['cotton'], color: '#e4e0d6', roof: '#4f7f72', w: 110, h: 70, rate: 0, count: 1 },
  gasplant: { kind: 'gasplant', name: 'Газоперерабатывающий завод', short: 'ГПЗ', produces: 'fuel', accepts: ['gas'], color: '#dcdad4', roof: '#2f58a8', w: 110, h: 80, rate: 0, count: 1 },
};

export const INDUSTRY_LIST = Object.values(INDUSTRY_TYPES);

/** Кто производит груз. */
export const producersOf = (c: CargoType) => INDUSTRY_LIST.filter((t) => t.produces === c);

/** Какие предприятия принимают груз. */
export const consumersOf = (c: CargoType) => INDUSTRY_LIST.filter((t) => t.accepts.includes(c));
