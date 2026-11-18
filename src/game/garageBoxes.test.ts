import { afterEach, describe, expect, it, vi } from 'vitest';
import { add, dist, scale } from '../core/vec';
import { boxesOverlap } from '../lanes/curb';
import { buildParkingScene } from '../testpages/parking';
import { CAR_SIZE, lotFrame } from '../world/houseAccess';
import { garagesPlan } from '../world/yardLots';
import type { Town } from '../world/entities';
import { Hud } from '../ui/hud';
import { Game } from './game';
import { garageBoxes } from './garageBoxes';
import { legPose, path } from './lotMoves';

const fixture = () => {
  const scene = buildParkingScene(true);
  const c = scene.cases[0];
  const building = c.destination;
  building.form = 'garages';
  c.town.buildings = [...c.town.buildings];
  scene.game.layoutRev++;
  return { ...scene, c, building, boxes: garageBoxes(building) };
};

const advance = (game: ReturnType<typeof fixture>['game'], seconds: number) => {
  game.speed = 1;
  for (let i = 0; i < seconds * 30; i++) game.update(1 / 30);
};

describe('Конкретные боксы гаражного кооператива', { timeout: 60_000 }, () => {
  afterEach(() => vi.restoreAllMocks());

  it('карточка показывает боксы и занятость вместо этажей, рабочих мест и маршрутов', () => {
    const { game, building, boxes } = fixture();
    const hud = Object.assign(Object.create(Hud.prototype), {
      game: () => game,
      controller: { selection: { type: 'building', id: building.id }, pendingOf: () => null },
    }) as { selectionHtml(): string; linesListHtml(): string };
    expect(game.parkedCars.garageOccupancy(building)).toEqual({ total: boxes.length, used: 0 });
    const html = hud.selectionHtml();
    expect(html).toContain(`${boxes.length} боксов · занято 0 из ${boxes.length}`);
    expect(html).not.toContain('эт.');
    expect(html).not.toContain('рабочих мест');
    expect(hud.linesListHtml()).toBe('');
    expect(game.buildingLines(building.id)).toEqual([]);
    expect(game.lots.yardCap(building)).toBe(0);
    expect(game.lots.yardSpot(building)).toBeNull();
  });

  it.each([false, true])('гаражи не выбираются целью обычной поездки (межгород: %s)', (intercity) => {
    const { game, c, building, cases } = fixture();
    const other = cases[1].town;
    const office = cases[1].destination;
    c.town.buildings = [c.car.home, building, ...(intercity ? [] : [office])];
    other.buildings = [{ ...office, id: -123, form: 'garages' }, office];
    game.towns = intercity ? [c.town, other] : [c.town];
    vi.spyOn(game.rng, 'chance').mockReturnValue(intercity);
    vi.spyOn(game.rng, 'pick').mockImplementation((items) => items[0]);
    const route = vi.spyOn(game.roads, 'route').mockReturnValue(null);
    const spawn = (Game.prototype as unknown as { spawnCitizenTrip(town: Town): void }).spawnCitizenTrip;
    spawn.call(game, c.town);
    expect(route).toHaveBeenCalledWith(c.car.home.anchor, office.anchor);
    expect(route).not.toHaveBeenCalledWith(c.car.home.anchor, building.anchor);
  });

  it('домашняя машина занимает бокс, а после выезда освобождает его', () => {
    const { game, c, building, boxes } = fixture();
    const box = boxes[0];
    const car = game.carHomes.fleet(c.town).cars.find((car) => car.key === c.car.key)!;
    car.place = { at: building, kind: 'box', box, spot: box.spot, look: null, near: [] };
    expect(game.parkedCars.garageOccupancy(building)).toEqual({ total: boxes.length, used: 1 });
    game.carHomes.manualMoving(car.key, true);
    expect(game.parkedCars.garageOccupancy(building).used).toBe(0);
  });

  it('боксы шире кузова, пути проходят по проезду и не пересекают соседние гаражи', () => {
    const { building, boxes } = fixture();
    const plan = garagesPlan(building);
    expect(plan.bw).toBeGreaterThan(6);
    expect(boxes.length).toBeGreaterThan(8);
    expect(new Set(boxes.map((b) => b.spot.key)).size).toBe(boxes.length);
    const at = lotFrame(building);
    const origin = at(0, 0);
    const dir = { x: at(0, 1).x - origin.x, y: at(0, 1).y - origin.y };
    const solids = plan.rows.flatMap((row) => row.xs.map((x) => ({ c: at(x + plan.bw / 2, row.y + plan.bd / 2), d: dir, hl: plan.bd / 2, hw: plan.bw / 2 })));
    for (const box of boxes) for (const leg of [path(box.via, 4.5, false, 5), ...box.exit]) for (let s = 0; s <= leg.len; s += 0.2) {
      const pose = legPose(leg, s);
      const body = { c: pose.c, d: pose.h, hl: CAR_SIZE.l / 2, hw: CAR_SIZE.w / 2 };
      for (const [i, solid] of solids.entries()) if (i !== box.index) expect(boxesOverlap(body, solid), `box ${box.index}, obstacle ${i}, distance ${s}`).toBe(false);
    }
  });

  it('машина жителя едет в выбранный бокс, остаётся внутри, выбирается по боксу и возвращается домой', () => {
    const { game, c, building, boxes } = fixture();
    const chosen = boxes[boxes.length - 2];
    const id = `car:${c.car.key}`;
    expect(game.parkedCars.send(id, chosen.center)).toBeNull();
    advance(game, 120);
    expect(game.parkedCars.garageOccupancy(building).used).toBe(1);
    expect(game.carHomes.awayOf(c.town, c.car.key)?.garage).toEqual({ building: building.id, box: chosen.index });
    const loaded = new Game(structuredClone(game.settings), structuredClone(game.toSave()));
    expect(loaded.parkedCars.garageOccupancy(loaded.buildingById(building.id)!).used).toBe(1);
    expect(game.parkedCars.get(id)?.parked).toBe(true);
    expect(game.parkedCars.at(chosen.center)).toBe(id);
    expect(game.garageLooks([-Infinity, -Infinity, Infinity, Infinity], true).find((x) => x.parkedCar === id)?.hidden).toBe(true);
    expect(game.parkedCars.send(id)).toBeNull();
    advance(game, 130);
    expect(game.carHomes.isHome(c.town, c.car.key)).toBe(true);
    expect(game.parkedCars.garageOccupancy(building).used).toBe(0);
  });

  it('бокс можно выбрать при размещении и забронировать до приезда другой машины', () => {
    const { game, building, boxes } = fixture();
    const spec = { kind: 'car' as const, length: CAR_SIZE.l, width: CAR_SIZE.w, maxSpeed: 60, accel: 10, color: '#00f' };
    const a = game.parkedCars.spawn(spec, boxes[0].center);
    const b = game.parkedCars.spawn(spec, boxes[1].center);
    if (typeof a === 'string' || typeof b === 'string') throw new Error('spawn');
    expect(game.parkedCars.garageOccupancy(building).used).toBe(2);
    expect(game.parkedCars.send(a.parked!, boxes[4].center)).toBeNull();
    expect(game.parkedCars.send(b.parked!, boxes[4].center)).toMatch(/уже едет/);
    advance(game, 180);
    const parked = game.parkedCars.get(a.parked!)!;
    expect(parked.parked).toBe(true);
    expect(dist(add(parked.look.pos, scale(parked.look.dir, -CAR_SIZE.l / 2)), boxes[4].center)).toBeLessThan(0.1);
    expect(game.parkedCars.garageOccupancy(building).used).toBe(2);
  });
});
