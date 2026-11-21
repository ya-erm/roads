import type { Game } from '../game/game';
import { buildBusScene } from './bus';
import { buildConstructionScene } from './construction';
import { buildJunctionsScene } from './junctions';
import { buildParkingScene } from './parking';
import { testPageName } from './route';
import { buildVehiclesScene } from './vehicles';
import { buildTruckAccessScene } from './truckAccess';
import { buildIndustryStationScene } from './industryStations';

/** Заранее собранная сцена тестовой страницы. */
export interface TestScene {
  game: Game;
  /** Кадр при загрузке — рамка мира со всей сценой. */
  view: { x0: number; y0: number; x1: number; y1: number };
  maxZoom?: number;
  /** id линий по названиям участков (straight, avenue, bay…) — чтобы быстро выбрать из консоли. */
  lines: Record<string, number>;
  /** Что в сцене не построилось: участок и причина. */
  errors: string[];
  /** Решения сцены после такта игры: например, повторный выезд машин со стоянки. */
  tick?(): void;
}

const PAGES: Record<string, () => TestScene> = {
  bus: buildBusScene,
  vehicles: buildVehiclesScene,
  junctions: buildJunctionsScene,
  construction: buildConstructionScene,
  parking: () => buildParkingScene(true),
  trucks: buildTruckAccessScene,
  'industry-stations': buildIndustryStationScene,
};

/** Сцена тестовой страницы по адресу (/test/bus); обычная игра — null. */
export function testScene(pathname: string): TestScene | null {
  const name = testPageName(pathname);
  const build = name ? PAGES[name] : undefined;
  return build ? build() : null;
}
