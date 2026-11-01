export type CargoType =
  | 'passengers'
  | 'grain'
  | 'logs'
  | 'coal'
  | 'ore'
  | 'oil'
  | 'stone'
  | 'food'
  | 'planks'
  | 'steel'
  | 'fuel'
  | 'construction'
  | 'goods';

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
  food: { name: 'Продукты', color: '#e5534b', rate: 28 },
  planks: { name: 'Доски', color: '#c99a5b', rate: 24 },
  steel: { name: 'Металл', color: '#5f7a8f', rate: 26 },
  fuel: { name: 'Топливо', color: '#e07b39', rate: 28 },
  construction: { name: 'Стройматериалы', color: '#b5543c', rate: 26 },
  goods: { name: 'Товары', color: '#2fb8b3', rate: 34 },
};

export const FREIGHT: CargoType[] = [
  'grain',
  'logs',
  'coal',
  'ore',
  'oil',
  'stone',
  'food',
  'planks',
  'steel',
  'fuel',
  'construction',
  'goods',
];

/** Что вообще могут требовать города. У каждого города свой набор. */
export const TOWN_CARGO: CargoType[] = ['food', 'goods', 'fuel', 'construction'];

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
  | 'factory';

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

export const INDUSTRY_TYPES: Record<IndustryKind, IndustryType> = {
  farm: { kind: 'farm', name: 'Ферма', short: 'Ферма', produces: 'grain', accepts: [], color: '#e6cf7a', roof: '#b5543c', w: 110, h: 80, rate: 44, count: 4 },
  forest: { kind: 'forest', name: 'Лесозаготовка', short: 'Лесозаготовка', produces: 'logs', accepts: [], color: '#a7b98a', roof: '#6b4f33', w: 100, h: 90, rate: 44, count: 4 },
  coalmine: { kind: 'coalmine', name: 'Угольная шахта', short: 'Шахта', produces: 'coal', accepts: [], color: '#b9b4ad', roof: '#3d4148', w: 90, h: 80, rate: 44, count: 3 },
  ironmine: { kind: 'ironmine', name: 'Железный рудник', short: 'Рудник', produces: 'ore', accepts: [], color: '#c9ab96', roof: '#7d4a33', w: 90, h: 80, rate: 44, count: 3 },
  oilwell: { kind: 'oilwell', name: 'Нефтяная скважина', short: 'Скважина', produces: 'oil', accepts: [], color: '#d4cfc4', roof: '#4a3b6b', w: 80, h: 80, rate: 44, count: 3 },
  quarry: { kind: 'quarry', name: 'Карьер', short: 'Карьер', produces: 'stone', accepts: [], color: '#cfcac0', roof: '#6f757c', w: 100, h: 90, rate: 44, count: 3 },
  foodplant: { kind: 'foodplant', name: 'Пищевой комбинат', short: 'Пищекомбинат', produces: 'food', accepts: ['grain'], color: '#e4ded2', roof: '#b04a42', w: 100, h: 70, rate: 0, count: 2 },
  sawmill: { kind: 'sawmill', name: 'Лесопилка', short: 'Лесопилка', produces: 'planks', accepts: ['logs'], color: '#e4ded2', roof: '#8a6a43', w: 100, h: 70, rate: 0, count: 2 },
  steelmill: { kind: 'steelmill', name: 'Металлургический завод', short: 'Завод металла', produces: 'steel', accepts: ['coal', 'ore'], color: '#d6d4d0', roof: '#4f6273', w: 120, h: 80, rate: 0, count: 2 },
  refinery: { kind: 'refinery', name: 'Нефтеперерабатывающий завод', short: 'НПЗ', produces: 'fuel', accepts: ['oil'], color: '#dcd8cf', roof: '#c4662f', w: 110, h: 80, rate: 0, count: 2 },
  buildmat: { kind: 'buildmat', name: 'Завод стройматериалов', short: 'Стройзавод', produces: 'construction', accepts: ['stone'], color: '#e0dbd2', roof: '#9a4a36', w: 100, h: 70, rate: 0, count: 2 },
  factory: { kind: 'factory', name: 'Завод товаров', short: 'Завод товаров', produces: 'goods', accepts: ['planks', 'steel'], color: '#dfe3e6', roof: '#23898a', w: 120, h: 80, rate: 0, count: 2 },
};

export const INDUSTRY_LIST = Object.values(INDUSTRY_TYPES);

/** Кто производит груз. */
export const producersOf = (c: CargoType) => INDUSTRY_LIST.filter((t) => t.produces === c);

/** Какие предприятия принимают груз. */
export const consumersOf = (c: CargoType) => INDUSTRY_LIST.filter((t) => t.accepts.includes(c));
