import { describe, expect, it } from 'vitest';
import { buildParkingScene, type ParkingAction } from './parking';
import { dist, dot } from '../core/vec';
import { runPose } from '../game/lotMoves';
import { homeExit } from '../game/homeExit';
import { CAR_SIZE } from '../world/houseAccess';
import { lotLayout } from '../world/parkingLots';

describe('Тестовая страница парковок', () => {
  it('одиннадцать участков: машины паркуются, возвращаются и выбирают направление с учётом встречной полосы', () => {
    const scene = buildParkingScene();
    expect(scene.errors).toEqual([]);
    expect(scene.cases).toHaveLength(11);
    expect(scene.game.roads.net.problems()).toEqual([]);
    const seen = new Map(scene.cases.map((c) => [c, new Set<string>()]));
    const forms = scene.cases.map((c) => c.destination.form);
    const previous = new WeakMap<object, ReturnType<typeof runPose>>();
    const homePlans = scene.cases.map((c) => homeExit(c.car.place!.spot, CAR_SIZE.l, CAR_SIZE.w)).filter((p) => p !== null);
    const lengths = homePlans.map((p) => p.length);
    scene.game.speed = 1;
    for (let t = 0; t < 400; t += 0.1) {
      scene.game.update(0.1);
      scene.tick();
      for (const c of scene.cases) {
        for (const m of scene.game.garages.moves) {
          if (m.town !== c.town) continue;
          const pose = runPose(m.run);
          const prev = previous.get(m);
          if (prev) {
            expect(dist(prev.c, pose.c), `${c.title}: телепортация на манёвре`).toBeLessThan(1.3);
            expect(dot(prev.h, pose.h), `${c.title}: скачок курса`).toBeGreaterThan(0.95);
          }
          previous.set(m, pose);
          if (m.kind === 'out') {
            if (m.phase === 'road' || m.phase === 'wait' || m.sim) expect(m.blink, `${c.title}: поворотник при выезде`).toBeTruthy();
            if (m.phase === 'yard' && !m.sim && m.run.i < m.run.legs.length - 1) expect(m.blink, 'при развороте во дворе поворотник выключен').toBeUndefined();
            if (m.via?.cross) expect(m.forward, 'через встречку нельзя сдавать задом').toBe(true);
            if (c.target === 'lot' && m.home.key !== c.car.place!.spot.key) expect(m.forward, `${c.title}: выезд с площадки передом`).toBe(true);
          }
          seen.get(c)!.add(`${m.home.key === c.car.place!.spot.key ? 'home' : 'destination'}:${m.kind}`);
          if (m.kind === 'in' && m.blink === -1) seen.get(c)!.add('left:in');
          if (m.kind === 'out' && m.via?.cross) seen.get(c)!.add('left:out');
        }
      }
    }
    expect(scene.errors).toEqual([]);
    for (const c of scene.cases) {
      expect(c.arrivals, `${c.title}: заезды (${c.phase})`).toBeGreaterThanOrEqual(2);
      expect(c.returns, `${c.title}: возвращения (${c.phase})`).toBeGreaterThanOrEqual(2);
      // Возвращение завершается видимым манёвром, а не исчезновением машины у узла дороги.
      expect(seen.get(c), c.title).toContain('home:out');
      expect(seen.get(c), c.title).toContain('home:in');
      if (c.target !== 'curb') {
        expect(seen.get(c), c.title).toContain('destination:in');
        expect(seen.get(c), c.title).toContain('destination:out');
      }
    }
    expect(scene.cases.map((c) => c.destination.form)).toEqual(forms);
    expect(homePlans.map((p) => p.length), 'повторные выезды не дописывают повороты в сохранённые планы').toEqual(lengths);
    const across = scene.cases.find((c) => c.direction === 'across')!;
    const reverse = scene.cases.find((c) => c.direction === 'reverse')!;
    const detour = scene.cases.find((c) => c.direction === 'detour')!;
    expect(seen.get(across), 'въезд через встречную полосу').toContain('left:in');
    expect(seen.get(reverse), 'выезд в противоположном направлении').toContain('left:out');
    expect(seen.get(detour), 'на проспекте въезд налево запрещён').not.toContain('left:in');
    expect(seen.get(detour), 'на проспекте выезд налево запрещён').not.toContain('left:out');
  }, 60_000);

  it('кнопки готовят конкретный заезд или выезд и не запускают остальные машины', () => {
    for (const index of [0, 2, 7]) for (const action of ['home-out', 'home-in', 'parking-out', 'parking-in'] as ParkingAction[]) {
      const scene = buildParkingScene();
      scene.startAction(index, action);
      expect(scene.errors).toEqual([]);
      const c = scene.cases[index];
      const before = c.arrivals + c.returns;
      for (let i = 0; i < 30 * 180; i++) {
        scene.game.update(1 / 30);
        scene.tick();
      }
      expect(scene.cases.filter((_, k) => k !== index).every((c) => c.arrivals === 0 && c.returns === 0)).toBe(true);
      expect(c.arrivals + c.returns, `${c.title}: ${action}`).toBeGreaterThan(before);
      expect(c.phase, `${c.title}: ${action}`).toBe(action === 'home-out' || action === 'parking-in' ? 'parked' : 'home');
    }
  }, 60_000);

  it('добавленные машины занимают реальные места и едут по обеим полосам у парковки', () => {
    const scene = buildParkingScene();
    const c = scene.cases[6];
    const free = scene.game.lots.free(c.lot!);
    scene.spawn(6, 'parked');
    scene.spawn(6, 'parked');
    expect(scene.game.lots.free(c.lot!)).toBe(free - 2);
    expect(c.obstacles).toHaveLength(2);
    scene.startAction(6, 'parking-in');
    scene.spawn(6, 'road');
    scene.spawn(6, 'oncoming');
    const cars = [...scene.game.traffic.vehicles.values()].filter((v) => !scene.game.carHomes.carOfSim(v.id));
    expect(cars).toHaveLength(2);
    const before = cars.map((v) => ({ ...v.pos }));
    for (let i = 0; i < 30 * 15; i++) { scene.game.update(1 / 30); scene.tick(); }
    expect(c.arrivals).toBeGreaterThan(0);
    for (let i = 0; i < cars.length; i++) expect(dist(cars[i].pos, before[i])).toBeGreaterThan(5);
    expect(scene.errors).toEqual([]);
  });

  it('клик выбирает конкретное место и конкретную полосу; стоящая машина не уезжает', () => {
    const scene = buildParkingScene();
    const { game } = scene;
    const c = scene.cases[6];
    const stall = lotLayout(c.lot!).stalls[3];
    scene.spawn(6, 'parked', stall.pos);
    expect(game.lots.occupied(c.lot!.id, 3)).toBe(true);
    expect(c.obstacles[0].pos).toEqual(stall.nose);
    expect(() => scene.spawn(6, 'parked', stall.pos)).toThrow(/занято/);
    expect(c.obstacles).toHaveLength(1);
    const slot = game.garages.slotOf(c.car.place!.spot)!;
    const p = game.roads.graph.lanePose(slot.lane, slot.mid + 25);
    scene.spawn(6, 'stopped', p.pos);
    const sim = [...game.traffic.vehicles.values()][0];
    expect(sim.lane).toBe(slot.lane.id);
    expect(dist({ x: sim.pos.x - sim.dir.x * CAR_SIZE.l / 2, y: sim.pos.y - sim.dir.y * CAR_SIZE.l / 2 }, p.pos)).toBeLessThan(0.5);
    const before = { ...sim.pos };
    game.speed = 1;
    for (let i = 0; i < 300; i++) game.update(1 / 30);
    expect(sim.pos).toEqual(before);
    expect(sim.v).toBe(0);
  });
});
