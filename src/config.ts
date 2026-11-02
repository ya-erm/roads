export const SIM_DT = 1 / 30;

export const MIN_SEGMENT_LEN = 16;
/** Радиус привязки в пикселях экрана. */
export const SNAP_PIXELS = 14;

export const CAR_WIDTH = 4;

export const IDM = {
  brake: 18,
  minGap: 2,
  headway: 0.9,
};

export const LIGHTS = {
  green: 8,
  clearance: 2,
};

/** Длительность игрового месяца в секундах симуляции. */
export const MONTH_LENGTH = 40;
export const START_YEAR = 1960;

export const COST = {
  trafficLight: 4000,
  roundabout: 12000,
  signal: 3000,
  station: 8000,
  refundRatio: 0.5,
};

export const ECONOMY = {
  startMoney: 600_000,
  /** До какой суммы можно уйти в минус. */
  creditLimit: -200_000,
  /** Ремонт дорог в месяц от их стоимости. */
  roadUpkeepRate: 0.004,
  /** Множитель тарифов: полный рейс должен заметно окупать содержание транспорта. */
  tariff: 2,
  /**
   * Надбавка за скорость доставки: средняя скорость (по прямой от станции до станции,
   * с учётом ожидания) сравнивается с опорной; множитель от 0.8 до 1.5.
   */
  refSpeed: 15,
  speedMin: 0.8,
  speedMax: 1.5,
  /** Кредит: шаг, предел и процент в месяц. */
  loanStep: 100_000,
  loanMax: 1_000_000,
  loanRate: 0.01,
  /** Рост предприятий: шаг уровня, предел и сколько месяцев подряд нужно вывозить продукцию. */
  growthStep: 0.25,
  maxLevel: 4,
  growthMonths: 2,
  /** Через сколько месяцев без обслуживания производство начинает падать. */
  declineMonths: 6,
};

/** Вокзал: две платформы — главный путь и обгонный, стрелки по краям. */
export const RAIL_STATION = {
  platform: 150,
  /** Длина S-образного съезда на второй путь. */
  switchLen: 110,
  /** Расстояние между осями путей. */
  spacing: 20,
  size: { w: 76, h: 22 },
  catchment: 240,
  cost: 40_000,
};

export const STATION = {
  catchment: 170,
  /** Посты погрузки у новой станции; игрок может добавить до maxBays или убрать до minBays. */
  bays: 3,
  minBays: 1,
  maxBays: 8,
  /** Цена каждого добавленного поста. */
  bayCost: 2500,
  /** На столько станция становится длиннее с каждым постом. */
  bayWidth: 9,
  size: { w: 36, h: 22 },
  driveway: 34,
  cargoCap: 400,
};

/** Автобусная остановка: прямо на улице, без заезда, только пассажиры. */
export const STOP = {
  catchment: 110,
  /** Сколько автобусов стоит у остановки одновременно. */
  bays: 2,
  /** Навес у края тротуара. */
  size: { w: 18, h: 6 },
  cost: 1500,
  /** Ближе к перекрёстку или к другой остановке на той же улице — нельзя. */
  gap: 25,
};

export const TOWN_TRAFFIC = {
  /** Поездок в секунду на 1000 жителей. */
  tripsPerThousand: 0.35,
  maxCars: 400,
  intercityShare: 0.25,
};

export const CAR_COLORS = ['#d9d4c7', '#9aa3ad', '#c45a4f', '#5a7fae', '#e2c46b', '#6f8f6a', '#3d4148', '#b98b5e'];
