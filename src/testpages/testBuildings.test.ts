import { describe, expect, it } from 'vitest';
import { dist, sub } from '../core/vec';
import { Game } from '../game/game';
import { road, withoutCitizens } from '../game/testkit';
import { carSpot } from '../game/garages';
import { BUILDING_SIZE, buildingCorners, resizeBuildingFootprint } from '../world/buildingResize';
import { CAR_SIZE, cottagePlan, dachaPlan, drivewayOf, lotFrame } from '../world/houseAccess';
import { FORM_NAMES, formOf } from '../world/townForms';
import { defaultTestBuildingOptions, matchesTestBuilding, nextTestBuilding, planTestBuilding, placeTestBuilding, TEST_BUILDING_FORMS } from './testBuildings';

function scene(): Game {
  const game = withoutCitizens(new Game({ seed: 1, size: 'small', towns: 0, industries: 'few', money: 1e9, water: 'dry', relief: 'plains', parking: true }));
  game.terrain.clearWater();
  for (const i of game.industries) game.index.remove(i);
  game.industries = [];
  expect(road(game, { free: { x: 1000, y: 1400 } }, { free: { x: 2300, y: 1400 } })).toBe(true);
  return game;
}

describe('Тестовый инструмент зданий', { timeout: 60_000 }, () => {
  it('в каталоге все типы игры; каждый устанавливается настоящим зданием со своим типом и фасадом к улице', () => {
    expect(TEST_BUILDING_FORMS).toEqual(Object.keys(FORM_NAMES));
    const game = scene();
    for (const form of TEST_BUILDING_FORMS) {
      const blueprint = nextTestBuilding(game, defaultTestBuildingOptions(form))!;
      expect(blueprint, form).toBeTruthy();
      const plan = planTestBuilding(game, blueprint, { x: 1600, y: 1500 });
      expect(plan.ok, `${form}: ${plan.label}`).toBe(true);
      expect(plan.building!.face).toBe(-1);
      expect(plan.building!.anchor).not.toBe(0);
      const building = placeTestBuilding(game, plan)!;
      expect(building).toBeTruthy();
      expect(formOf(building)).toBe(form);
      expect(game.buildingById(building.id)).toBe(building);
      expect(game.index.items.has(building)).toBe(true);
      expect(game.towns[0].buildings).toContain(building);
      expect(planTestBuilding(game, nextTestBuilding(game, defaultTestBuildingOptions(form))!, { x: 1600, y: 1500 }).ok).toBe(false);
      game.index.remove(building);
      game.towns[0].buildings = [];
    }
  });

  it('выбирает гараж, площадку или отсутствие парковки и обе стороны дома из обычных игровых планировок', () => {
    const game = scene();
    for (const parking of ['garage', 'pad', 'none'] as const) for (const side of ['left', 'right'] as const) {
      const options = { ...defaultTestBuildingOptions('cottage'), parking, side };
      const b = nextTestBuilding(game, options)!;
      expect(matchesTestBuilding(b, options)).toBe(true);
      const plan = cottagePlan(b);
      expect(plan.left).toBe(side === 'left');
      expect(plan.garage ? 'garage' : plan.pad ? 'pad' : 'none').toBe(parking);
      const placed = placeTestBuilding(game, planTestBuilding(game, b, { x: 1600, y: 1500 }))!;
      if (parking !== 'none') {
        const driveway = drivewayOf(placed)!;
        expect(driveway).toBeTruthy();
        expect(game.garages.slotOf(carSpot(placed.id, placed, driveway, !driveway.garage, '#fff', CAR_SIZE.l))).toBeTruthy();
      }
      game.index.remove(placed);
      game.towns[0].buildings = [];
    }
    const dacha = nextTestBuilding(game, { ...defaultTestBuildingOptions('dacha'), parking: 'pad', side: 'right' })!;
    expect(dachaPlan(dacha).pad).not.toBeNull();
    expect(dachaPlan(dacha).left).toBe(false);
  });

  it('превью не добавляет строения и запрещает поле вдали от улиц', () => {
    const game = scene();
    const blueprint = nextTestBuilding(game, defaultTestBuildingOptions('market'))!;
    const before = game.index.items.size;
    for (let i = 0; i < 10; i++) planTestBuilding(game, blueprint, { x: 1600 + i, y: 1500 });
    expect(game.index.items.size).toBe(before);
    expect(game.towns).toHaveLength(0);
    expect(planTestBuilding(game, blueprint, { x: 3000, y: 3000 }).ok).toBe(false);
  });

  it('задаёт два и три реальных места у дома, включая одно- и двухместный гараж', () => {
    const game = scene();
    for (const homeSpaces of [2, 3] as const) for (const garageSpaces of [1, 2] as const) {
      const options = { ...defaultTestBuildingOptions('cottage'), width: 96, depth: 80, homeSpaces, garageSpaces, parking: 'garage' as const };
      const b = nextTestBuilding(game, options)!;
      expect(b).toBeTruthy();
      expect(b.homeSpaces).toBe(homeSpaces);
      expect(b.garageSpaces).toBe(garageSpaces);
      expect(matchesTestBuilding(b, options)).toBe(true);
      const plan = cottagePlan(b);
      expect(plan.spaces).toHaveLength(homeSpaces);
      expect(plan.spaces.filter((s) => s.garage)).toHaveLength(garageSpaces);
      expect(new Set(plan.spaces.map((s) => s.x)).size).toBe(homeSpaces);
      const placed = placeTestBuilding(game, planTestBuilding(game, b, { x: 1600, y: 1500 }))!;
      expect(placed).toBeTruthy();
      expect(cottagePlan(placed).spaces).toHaveLength(homeSpaces);
      game.index.remove(placed);
      game.towns[0].buildings = [];
    }
    for (const form of ['cottage', 'dacha'] as const) for (const homeSpaces of [2, 3] as const) {
      const options = { ...defaultTestBuildingOptions(form), width: 96, depth: 80, homeSpaces, parking: 'pad' as const };
      const b = nextTestBuilding(game, options)!;
      expect(matchesTestBuilding(b, options)).toBe(true);
      const plan = form === 'cottage' ? cottagePlan(b) : dachaPlan(b);
      expect(plan.spaces).toHaveLength(homeSpaces);
      expect(plan.spaces.every((s) => !s.garage)).toBe(true);
    }
    const cramped = { ...defaultTestBuildingOptions('cottage'), width: 28, depth: 28, homeSpaces: 3 as const, garageSpaces: 2 as const, parking: 'garage' as const };
    expect(nextTestBuilding(game, cramped)).toBeNull();
  });

  it('дальние углы меняют ширину и глубину шагом 2 м, оставляя фасад и противоположную границу на месте', () => {
    for (const face of [-1, 1] as const) {
      const b = { fp: { center: { x: 100, y: 200 }, w: 43.5, h: 50, angle: Math.PI / 3 }, face };
      const at = lotFrame(b);
      for (const corner of buildingCorners(b)) {
        const fp = resizeBuildingFootprint(b, corner, sub(at(corner.side * 7.2, 11.2), b.fp.center));
        const sized = lotFrame({ fp, face });
        expect(fp.w).toBe(b.fp.w + BUILDING_SIZE.step * 4);
        expect(fp.h).toBe(b.fp.h + (corner.edge === 'back' ? BUILDING_SIZE.step * 6 : 0));
        expect(dist(sized(-corner.side * fp.w / 2, -fp.h / 2), at(-corner.side * b.fp.w / 2, -b.fp.h / 2))).toBeLessThan(1e-8);
      }
    }
  });

  it('изменение магазина сохраняется и отменяется, а свободный участок не перестраивает соседей', () => {
    const game = scene();
    const make = (x: number) => placeTestBuilding(game, planTestBuilding(game, nextTestBuilding(game, defaultTestBuildingOptions('shop'))!, { x, y: 1500 }))!;
    const shop = make(1600);
    const neighbor = make(1700);
    expect(shop).toBeTruthy();
    expect(neighbor).toBeTruthy();
    const initial = shop.fp;
    const neighborFp = neighbor.fp;
    const corner = buildingCorners(shop).find((c) => c.side === 1 && c.edge === 'back')!;
    const blocked = game.buildingResizePlan(shop, corner, { x: 60, y: 4 });
    expect(blocked.reason).toBeTruthy();
    expect(game.editBuildingSize(shop.id, initial, corner, { x: 60, y: 4 })).toBe(blocked.reason);
    expect(shop.fp).toBe(initial);
    expect(game.canUndo).toBe(false);
    const price = game.money;
    const delta = { x: 13, y: 17 };
    const { fp, reason } = game.buildingResizePlan(shop, corner, delta);
    expect(reason).toBeUndefined();
    expect(game.editBuildingSize(shop.id, initial, corner, delta)).toBeNull();
    expect(shop.fp).toEqual(fp);
    expect(game.buildingById(neighbor.id)?.fp).toBe(neighborFp);
    expect(game.money).toBe(price);
    expect(game.structureAt({ x: initial.center.x, y: initial.center.y + initial.h / 2 + 8 })).toBe(shop);
    const loaded = new Game(game.settings, game.toSave());
    expect(loaded.buildingById(shop.id)?.fp).toEqual(fp);
    expect(game.undo()).toBe('размер участка');
    expect(game.buildingById(shop.id)?.fp).toEqual(initial);
    expect(game.redo()).toBe('размер участка');
    expect(game.buildingById(shop.id)?.fp).toEqual(fp);
  });
});
