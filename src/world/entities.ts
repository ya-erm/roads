import { MONTH_SCALE } from '../config';
import type { Vec } from '../core/vec';
import type { CargoType, IndustryKind, IndustryType } from './cargo';
import type { Footprint } from './spatial';

export interface TownBuilding {
  type: 'building';
  id: number;
  townId: number;
  fp: Footprint;
  /** Жилой дом, офис/магазин или центральная ратуша. */
  kind: 'res' | 'com' | 'landmark';
  /**
   * Этажи генерации: жилой дом, появившись, приносит городу 14 жителей на этаж, деловой — 4 рабочих места. Сколько
   * этажей у жилого дома на самом деле — по его жильцам (townForms.storeysOf).
   */
  floors: number;
  /**
   * Жильцы жилого дома (townForms.settlePeople): в частном доме 3–6, в многоквартирном — десятки и сотни; всего по
   * городу — столько же, сколько по этажам генерации. Нет — ещё не расселён (старое сохранение до загрузки, тестовая
   * сцена): 14 на этаж.
   */
  people?: number;
  /** Узел улицы, откуда выезжают и куда приезжают машины жителей. */
  anchor: number;
  color: string;
  roof: string;
  /**
   * Тип застройки — как дом выглядит (world/townForms.ts): частный дом с участком, пятиэтажка, школа… Выбирается
   * по месту в городе, когда дом появился; у старых сохранений — при загрузке, по сохранённым данным. Жителей в
   * доме — по типу (people), но жителей города он не меняет.
   */
  form?: HouseForm;
  /**
   * С какой стороны улица — в осях footprint: 1 — со стороны +y, -1 — со стороны −y. К ней — фасад, калитка,
   * витрина; двор — с другой стороны. Нет — как -1.
   */
  face?: 1 | -1;
}

/**
 * Тип застройки (world/townForms.ts). Жилые: частный дом с участком, дача, двух-трёхэтажный многоквартирный дом со
 * двором, дом старого центра вдоль улицы, квартал с двором-колодцем, панельный дом (5–14 эт.), башня-высотка.
 * Общественные и деловые (kind 'com'): магазин, сельский магазин или клуб, офис, рынок, школа, больница, церковь,
 * гаражи, склад. Центр города (kind 'landmark'): ратуша или храм.
 */
export type HouseForm =
  | 'cottage'
  | 'dacha'
  | 'walkup'
  | 'townhouse'
  | 'courtyard'
  | 'slab'
  | 'tower'
  | 'shop'
  | 'store'
  | 'office'
  | 'market'
  | 'school'
  | 'hospital'
  | 'church'
  | 'garages'
  | 'warehouse'
  | 'hall'
  | 'temple';

/**
 * Новый район — прямоугольная сетка улиц (townStreets.ts): повёрнутый прямоугольник в осях u (под углом angle)
 * и v. Вдоль его улиц — панельные дома с дворами (townForms.ts). Нет — у города нового района нет.
 */
export interface TownDistrict {
  x: number;
  y: number;
  angle: number;
  /** Границы по u и по v от точки (x, y), м. */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/**
 * Зелень города (world/townParks.ts): большой парк у центра, сквер на пустом углу квартала, площадь у ратуши, сквер
 * с памятником в селе, бульвар на набережной. Только вид: жителей не прибавляет и не отнимает, место берёт из пустого.
 */
export type ParkKind = 'park' | 'square' | 'plaza' | 'memorial' | 'embankment';

export interface TownPark {
  /** id города × 100 + номер: зерно раскладки дорожек и деревьев (хеш), ключ в кэше карты. Не id сущности. */
  id: number;
  kind: ParkKind;
  /** Участок: x — вдоль ближайшей улицы (у набережной — вдоль берега, вода — со стороны +y). */
  fp: Footprint;
}

export type TownStyle = 'radial' | 'organic' | 'linear';

export interface Town {
  id: number;
  name: string;
  center: Vec;
  /** Радиус плотной застройки. */
  radius: number;
  /** До самого дальнего дома (с запасом): для отрисовки и охвата станций. Нет — как radius. */
  extent?: number;
  /** Верхний край улиц — над ним рисуется подпись. */
  top: number;
  style: TownStyle;
  population: number;
  buildings: TownBuilding[];
  /** Новый район с панельными домами (townForms.ts); нет — у города его нет (и у старых сохранений). */
  district?: TownDistrict;
  /**
   * Парки и скверы (townParks.ts): ставятся на пустом месте после генерации, у старых сохранений — при загрузке.
   * Город растёт в обход них. Нет — ещё не расставлены (старое сохранение до загрузки).
   */
  parks?: TownPark[];
  /** Сегменты улиц, построенные при генерации. */
  streets: number[];
  /** Грузы, которые нужны городу для роста. */
  demands: CargoType[];
  /** Привезено в этом месяце — вместе с излишком прошлого (carried). */
  supplied: Partial<Record<CargoType, number>>;
  lastSupplied: Partial<Record<CargoType, number>>;
  /**
   * Излишки прошлого месяца, с которых начался этот (уже в supplied): привезённое сверх нормы, не больше нормы
   * (world/townSupply.ts). В старых сохранениях нет — переноса не было.
   */
  carried?: Partial<Record<CargoType, number>>;
  /** Снабжение по закрытым месяцам, старые — первыми (не больше TOWN_HISTORY). В старых сохранениях нет. */
  supplyHistory?: TownSupplyMonth[];
  /**
   * Пассажиры из города, довезённые в этом месяце: id города назначения → сколько (свой id — по городу,
   * -1 — станция назначения не в городе). Нет — никого не довезли; в старых сохранениях нет (world/townPax.ts).
   */
  paxMonth?: Record<number, number>;
  /** То же за прошлый месяц. */
  paxLast?: Record<number, number>;
  tripAcc: number;
  /** Накопитель выездов спецмашин и сколько их было (game/services.ts). В старых сохранениях нет — с нуля. */
  serviceAcc?: number;
  serviceCalls?: number;
  growthAcc: number;
  /** Город сам прокладывает новые улицы, когда вдоль старых тесно. По умолчанию да. */
  autoStreets?: boolean;
  /** Только подпись на карте (участок тестовой сцены без жителей): имя без числа жителей. */
  labelOnly?: boolean;
  /**
   * Сколько месяцев подряд в черте города пустует место под предприятие (режим «Строит игрок»): дойдёт до
   * ENTERPRISE.slots.idleMonths — город строит сам. Нет — 0.
   */
  slotIdle?: number;
}

/** Итоги месяца по снабжению города. */
export interface TownSupplyMonth {
  /** «Май 1962» — как у истории линий. */
  label: string;
  /** Сколько привезли за месяц — по каждому грузу, который нужен городу (вместе с излишком прошлого месяца). */
  got: Partial<Record<CargoType, number>>;
  /** Из них — излишек прошлого месяца (Town.carried); нет — не переносили. */
  carried?: Partial<Record<CargoType, number>>;
  /** Норма месяца: столько нужно, чтобы потребность считалась закрытой. */
  need: number;
}

/**
 * Базовая норма: сколько единиц груза в месяц нужно городу до 2000 жителей, чтобы потребность считалась закрытой
 * (15 за минуту). Крупным городам нужно больше — норма растёт с населением (world/townSupply.ts, townNeed).
 */
export const TOWN_NEED = 10 * MONTH_SCALE;
/** Сколько последних месяцев снабжения помнит город. */
export const TOWN_HISTORY = 12;

export interface Industry {
  type: 'industry';
  id: number;
  info: IndustryType;
  name: string;
  fp: Footprint;
  /** Запасы сырья для переработки по видам. */
  stock: Partial<Record<CargoType, number>>;
  /** Готовая продукция, которую ещё не забрали. */
  output: number;
  producedMonth: number;
  producedLast: number;
  prodAcc: number;
  /**
   * Уровень производства (1…4): растёт, если продукцию исправно вывозят,
   * падает, если предприятие долго никто не обслуживает. Нет — 1.
   */
  level?: number;
  /** Сколько месяцев подряд продукцию вывозили (или не обслуживали — со знаком минус). */
  streak?: number;
  /** Предел роста уровня: событие «рост промышленности» поднимает его выше обычного. Нет — ECONOMY.maxLevel. */
  cap?: number;
  /** Секунд за этот месяц продукция копилась у предела станции (транспорт не успевал). */
  piledMonth?: number;
  /** Пристройки рядом (ставит игрок, когда предприятие готово расти дальше): каждая — предел роста +1 (ANNEX). */
  annexes?: Annex[];
  // Предприятия строит игрок (WorldSettings.industryMode 'player', docs/INDUSTRIES.md); в старых партиях полей нет.
  /** Богатство месторождения под добычей: множитель добычи (0.75 / 1 / 1.35). Нет — 1. */
  richness?: number;
  /** Заброшенное: не работает, рабочих не берёт; восстановить — за долю цены (ENTERPRISE.ruinShare). */
  ruin?: true;
  /** Стройка («Со строительством»): доля готового 0…1, цена всей, сколько уже заплачено, секунд на всю. Нет — готово. */
  build?: { done: number; cost: number; paid: number; time: number };
  /** Сколько заплачено за постройку (при сносе — доля назад). Нет — стояло на карте с начала. */
  paid?: number;
  /** Кто построил: игрок или город сам (на пустующем месте в черте). Нет — стояло на карте с начала. */
  builtBy?: 'player' | 'town';
  /** Выпущено всего с постройки — для заданий «построить и выпустить». */
  made?: number;
  /** Привезённые автобусом рабочие: каждый довезённый +1, за месяц убывают (game/enterprise.ts). */
  crew?: number;
}

/**
 * Месторождение (режим «Строит игрок»): участок, где можно поставить добычу своего вида (kind) — она встаёт ровно на
 * центр и поворот участка. size — малое / среднее / богатое (ENTERPRISE.deposits.sizes); used — предприятие на нём.
 */
export interface Deposit {
  id: number;
  kind: IndustryKind;
  center: Vec;
  angle: number;
  size: 0 | 1 | 2;
  used?: number;
}

/** Пристройка предприятия — вспомогательное здание рядом с ним (вид по группе предприятия — render/annexArt). */
export interface Annex {
  type: 'annex';
  id: number;
  industryId: number;
  fp: Footprint;
}

export interface PassengerGroup {
  from: number;
  to: number;
  count: number;
  /** Когда сели (игровое время) — быстрая поездка оплачивается дороже. */
  at?: number;
}

export interface StationServes {
  pax: boolean;
  cargo: boolean;
}

/** Как зовётся станция у дороги по тому, с чем работает: грузы — автостанция, пассажиры — автовокзал. */
export const stationTitle = (s: StationServes) => (s.cargo && s.pax ? 'Автостанция и автовокзал' : s.pax ? 'Автовокзал' : 'Автостанция');

/** Автовокзал — станция у дороги только для пассажиров: вместо боксов-постов у неё перроны, автобусы видны на местах. */
export const isBusTerminal = (st: Pick<Station, 'kind' | 'serves'>) => st.kind === 'road' && st.serves.pax && !st.serves.cargo;

export interface Station {
  type: 'station';
  id: number;
  /** Автостанция у дороги, автобусная остановка прямо на улице или вокзал на путях. */
  kind: 'road' | 'stop' | 'rail';
  name: string;
  fp: Footprint;
  /** Узел подъезда; у вокзала его нет (−1). */
  nodeId: number;
  /** Пути-платформы ж/д станции. */
  platforms: number[];
  /** Конечная (тупиковая) ж/д станция: пути заканчиваются упорами, поезд разворачивается и уходит обратно. */
  terminal?: boolean;
  /**
   * Автостанция или автовокзал вдоль дороги: узел — стык на самой улице (как у остановки), площадка боком к ней,
   * вдоль края улицы — «карман» (полоса); выезда-тупика нет.
   */
  side?: boolean;
  /**
   * Автовокзал у края улицы (STATION.curb): перрон вплотную к бордюру, узел — стык на самой улице у заднего края мест;
   * автобусы встают у перрона друг за другом прямо на улице (в кармашке, если он есть), как у остановки, — не уходят
   * с дороги. Мест — bays; pocket — у мест кармашек (хватило улицы), иначе они в крайней полосе.
   */
  curb?: { pocket: boolean };
  /** Длина выезда, которую выбрал игрок (м от кромки дороги до узла станции); у старых станций её нет. */
  driveway?: number;
  /** С чем работает станция: пассажиры, груз или и то и другое. */
  serves: StationServes;
  /** Грузовой двор предприятия: обслуживает только его, снести нельзя. */
  industryId: number | null;
  cargo: Partial<Record<CargoType, number>>;
  /**
   * Откуда изначально груз, выгруженный сюда на склад (пересадка).
   * Платят при доставке — за расстояние от этой станции.
   */
  cargoOrigin?: Partial<Record<CargoType, number>>;
  /** Ожидающие пассажиры по станции назначения. */
  passengers: Map<number, number>;
  /** Компанейские машины, стоящие на постах погрузки. */
  occupied: number[];
  bays: number;
  /** Пристройки-склады автостанции (нет — 0): каждая — больше места под груз и площадка длиннее (STORAGE). */
  depots?: number;
  /** Склады — отдельные здания рядом (ставит игрок в зоне вокруг станции): каждый — больше места под груз. */
  warehouses?: Warehouse[];
  townIds: number[];
  industryIds: number[];
  accepts: Set<CargoType>;
  /** Жители в зоне охвата — для генерации пассажиров. */
  catchPop: number;
  paxAcc: number;
  /**
   * Ушли, не дождавшись автобуса (пешком или иначе), по станции назначения: за этот месяц и итог прошлого
   * (game/paxPatience.ts). Нет — никто не уходил.
   */
  paxGone?: Record<number, number>;
  paxGoneLast?: Record<number, number>;
}

/** Склад станции — отдельное здание рядом с автостанцией (ставит игрок в зоне вокруг неё): места под груз станции. */
export interface Warehouse {
  type: 'warehouse';
  id: number;
  stationId: number;
  fp: Footprint;
}

/**
 * Строительная база (режим «Со строительством», src/game/crews.ts): площадка у дороги, откуда бригады едут на
 * стройку. nodeId — узел дороги у ворот (оттуда бригады выезжают и туда возвращаются).
 */
export interface BuildBase {
  type: 'base';
  id: number;
  fp: Footprint;
  nodeId: number;
  /** Своё название (игрок переименовал); нет — по ближайшему городу, см. Game.baseName. */
  name?: string;
  /** Сколько заплачено за саму базу (без сноса домов под ней): при сносе возвращается половина. Первая — 0. */
  paid?: number;
}

export type Structure = TownBuilding | Industry | Station | Warehouse | Annex | BuildBase;
