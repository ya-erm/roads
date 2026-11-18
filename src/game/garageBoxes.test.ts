import { describe, expect, it } from 'vitest';
import { add, dist, scale } from '../core/vec';
import { boxesOverlap } from '../lanes/curb';
import { buildParkingScene } from '../testpages/parking';
import { CAR_SIZE, lotFrame } from '../world/houseAccess';
import { garagesPlan } from '../world/yardLots';
import { garageBoxes } from './garageBoxes';
import { legPose, path } from './lotMoves';

const fixture = () => {
  const scene = buildParkingScene(true);
  const c = scene.cases[0];
  const building = c.destination;
  building.form = 'garages';
  scene.game.layoutRev++;
  return { ...scene, c, building, boxes: garageBoxes(building) };
};

const advance = (game: ReturnType<typeof fixture>['game'], seconds: number) => {
  game.speed = 1;
  for (let i = 0; i < seconds * 30; i++) game.update(1 / 30);
};

describe('Конкретные боксы гаражного кооператива', { timeout: 60_000 }, () => {
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
    expect(game.carHomes.awayOf(c.town, c.car.key)?.garage).toEqual({ building: building.id, box: chosen.index });
    expect(game.parkedCars.get(id)?.parked).toBe(true);
    expect(game.parkedCars.at(chosen.center)).toBe(id);
    expect(game.garageLooks([-Infinity, -Infinity, Infinity, Infinity], true).find((x) => x.parkedCar === id)?.hidden).toBe(true);
    expect(game.parkedCars.send(id)).toBeNull();
    advance(game, 130);
    expect(game.carHomes.isHome(c.town, c.car.key)).toBe(true);
  });

  it('бокс можно выбрать при размещении и забронировать до приезда другой машины', () => {
    const { game, boxes } = fixture();
    const spec = { kind: 'car' as const, length: CAR_SIZE.l, width: CAR_SIZE.w, maxSpeed: 60, accel: 10, color: '#00f' };
    const a = game.parkedCars.spawn(spec, boxes[0].center);
    const b = game.parkedCars.spawn(spec, boxes[1].center);
    if (typeof a === 'string' || typeof b === 'string') throw new Error('spawn');
    expect(game.parkedCars.send(a.parked!, boxes[4].center)).toBeNull();
    expect(game.parkedCars.send(b.parked!, boxes[4].center)).toMatch(/уже едет/);
    advance(game, 180);
    const parked = game.parkedCars.get(a.parked!)!;
    expect(parked.parked).toBe(true);
    expect(dist(add(parked.look.pos, scale(parked.look.dir, -CAR_SIZE.l / 2)), boxes[4].center)).toBeLessThan(0.1);
  });
});
