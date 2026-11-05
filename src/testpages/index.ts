import type { Game } from '../game/game';
import { buildBusScene } from './bus';
import { buildJunctionsScene } from './junctions';
import { testPageName } from './route';
import { buildVehiclesScene } from './vehicles';

/** Заранее собранная сцена тестовой страницы. */
export interface TestScene {
  game: Game;
  /** Кадр при загрузке — рамка мира со всей сценой. */
  view: { x0: number; y0: number; x1: number; y1: number };
  /** id линий по названиям участков (straight, avenue, bay…) — чтобы быстро выбрать из консоли. */
  lines: Record<string, number>;
  /** Что в сцене не построилось: участок и причина. */
  errors: string[];
}

const PAGES: Record<string, () => TestScene> = { bus: buildBusScene, vehicles: buildVehiclesScene, junctions: buildJunctionsScene };

/** Сцена тестовой страницы по адресу (/test/bus); обычная игра — null. */
export function testScene(pathname: string): TestScene | null {
  const name = testPageName(pathname);
  const build = name ? PAGES[name] : undefined;
  return build ? build() : null;
}
