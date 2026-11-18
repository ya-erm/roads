import { describe, expect, it } from 'vitest';
import { add, dist, dot, scale, sub } from '../core/vec';
import { hitchOf, jointOf, trailDir, vehicleBoxes } from '../sim/body';
import { MODELS } from '../game/transport';
import { boxesOverlap } from '../lanes/curb';
import { lotFrame } from '../world/houseAccess';
import { dockSolidsOf } from '../world/shopLots';
import { buildTruckAccessScene, TRUCK_MODELS } from './truckAccess';
import { Game } from '../game/game';
import { legPose } from '../game/lotMoves';

describe('Тестовая сцена грузовых дворов', { timeout: 60_000 }, () => {
  it('тип подъезда склада меняется в свободном дворе, сохраняет станцию и поддерживает отмену и загрузку', () => {
    const { game, truckCases } = buildTruckAccessScene();
    const c = truckCases[1];
    const old = game.docks.geoOf(c.building, 21, 4.7)!;
    expect(old.yard.kind).toBe('back');
    expect(game.setDockApproach(c.building.id, 'parallel')).toBeNull();
    const geo = game.docks.geoOf(c.building, 21, 4.7)!;
    expect(geo.yard.kind).toBe('through');
    expect(Math.abs(dot(geo.ramp.h, geo.d.dir))).toBeLessThan(0.01);
    expect(game.lines.get(c.line)!.stops).toEqual([c.source.id, c.dock.id]);
    expect(game.dockFor(c.building)?.id).toBe(c.dock.id);
    const restored = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect(restored.buildingById(c.building.id)!.dockApproach).toBe('parallel');
    expect(restored.docks.geoOf(restored.buildingById(c.building.id)!, 21, 4.7)?.yard.kind).toBe('through');
    game.undo();
    expect(game.buildingById(c.building.id)!.dockApproach).toBeUndefined();
    game.redo();
    expect(game.buildingById(c.building.id)!.dockApproach).toBe('parallel');
    const b = game.buildingById(c.building.id)!;
    expect(game.docks.stand(999, b, 21, 4.7)).toBe(true);
    expect(game.setDockApproach(b.id, 'front')).toMatch(/освобождения/);
    expect(b.dockApproach).toBe('parallel');
    game.docks.forget(999);
    expect(game.setDockApproach(b.id, 'front')).toBeNull();
    expect(game.docks.geoOf(b, 21, 4.7)!.yard.kind).toBe('back');
  });

  it('параллельный склад: фура въезжает и выезжает передом через разные съезды, у рампы оба кузова ровные', () => {
    for (const action of ['entry', 'exit'] as const) {
      const scene = buildTruckAccessScene();
      const c = scene.truckCases[1];
      expect(scene.game.setDockApproach(c.building.id, 'parallel')).toBeNull();
      scene.start(1, 'truck3', action);
      let prev: { x: number; y: number } | undefined;
      for (let f = 0; f < 30 * 100; f++) {
        scene.game.update(1 / 30); scene.tick();
        const look = scene.game.fleetLook(c.vehicle!)!;
        if (prev && scene.game.docks.inYard(c.vehicle!.id)) expect(dot(sub(look.pos, prev), look.dir)).toBeGreaterThan(-0.01);
        prev = { ...look.pos };
        if (action === 'entry' ? c.phase === 'unloading' : c.phase === 'done') break;
      }
      expect(c.phase).toBe(action === 'entry' ? 'unloading' : 'done');
      const look = scene.game.fleetLook(c.vehicle!)!;
      const hitch = hitchOf(look.body)!;
      expect(dot(look.dir, trailDir(jointOf(look.pos, look.dir, look.length, hitch), look.trail, look.dir))).toBeGreaterThan(0.9999);
    }
  });

  it('у рынка обратный манёвр в точности повторяет заезд обеими частями сцепки', () => {
    const scene = buildTruckAccessScene();
    const geo = scene.game.docks.geoOf(scene.truckCases[4].building, 21, 4.7)!;
    expect(geo.entry).toBeTruthy();
    for (const [i, entry] of geo.entry!.entries()) {
      const exit = geo.departure![geo.departure!.length - 1 - i];
      expect(exit.back).toBe(true);
      for (let k = 0; k <= 20; k++) {
        const a = legPose(entry, entry.len * k / 20);
        const b = legPose(exit, exit.len * (1 - k / 20));
        expect(dist(a.c, b.c)).toBeLessThan(0.001);
        expect(dot(a.h, b.h)).toBeGreaterThan(0.99999);
        expect(dot(a.th!, b.th!)).toBeGreaterThan(0.99999);
      }
    }
  });
  it('карточки предприятий показывают только маршруты через собственную рампу, в том числе без машин', () => {
    const { game, truckCases } = buildTruckAccessScene();
    for (const c of truckCases) expect(game.buildingLines(c.building.id).map((l) => l.id), c.title).toEqual([c.line]);
    const depot = truckCases[2];
    const shop = truckCases[3];
    const combined = game.createLine([depot.source.id, depot.dock.id, shop.dock.id, depot.dock.id])!;
    expect(game.buildingLines(depot.building.id).map((l) => l.id)).toEqual([depot.line, combined.id]);
    expect(game.buildingLines(shop.building.id).map((l) => l.id)).toEqual([shop.line, combined.id]);
    const unserved = truckCases[0];
    game.lines.delete(unserved.line);
    expect(game.buildingLines(unserved.building.id)).toEqual([]);
    expect(game.buildingLines(-1)).toEqual([]);
  });
  it('строит семь настоящих получателей и показывает причины ограничений моделей', () => {
    const scene = buildTruckAccessScene();
    expect(scene.errors).toEqual([]);
    expect(scene.truckCases).toHaveLength(7);
    expect(scene.game.speed).toBe(0);
    expect(scene.modelProblem(4, 'truck3')).toBeNull();
    expect(scene.modelProblem(3, 'truck3')).toMatch(/места/);
    for (const [i, c] of scene.truckCases.entries()) {
      expect(c.dock.kind).toBe('dock');
      expect(scene.game.lines.get(c.line)?.stops).toEqual([c.source.id, c.dock.id]);
      expect(scene.modelProblem(i, c.model), c.title).toBeNull();
      expect(c.building.fp.w).toBeLessThanOrEqual(70.4);
      expect(c.building.fp.h).toBeLessThanOrEqual(54.4);
      const route = scene.game.docks.route(c.source.nodeId, c.building, 12)!;
      expect(route.reduce((n, id) => n + scene.game.roads.graph.links.get(id)!.length, 0), `${c.title}: источник не требует круга по кварталу`).toBeLessThan(500);
    }
  });

  it('запускает отдельные заезд и выезд сразу у предприятия; сцепка непрерывна на всех фазах', () => {
    const scene = buildTruckAccessScene();
    for (const [i, c] of scene.truckCases.entries()) for (const model of TRUCK_MODELS) {
      if (scene.modelProblem(i, model)) continue;
      const vehicleModel = MODELS[model];
      if (vehicleModel.mode !== 'road') continue;
      for (const action of ['entry', 'exit'] as const) {
        const before = scene.game.time;
        scene.start(i, model, action);
        const v = c.vehicle!;
        const geo = scene.game.docks.geoOf(c.building, vehicleModel.spec.length, vehicleModel.spec.width)!;
        const at = lotFrame(c.building);
        const axis = sub(at(1, 0), at(0, 0));
        const solids = dockSolidsOf(c.building).map((r) => ({ c: at(r.x + r.w / 2, r.y + r.h / 2), d: axis, hl: r.w / 2, hw: r.h / 2 }));
        expect(scene.game.time).toBe(before);
        const look = scene.game.fleetLook(v)!;
        expect(look).toBeTruthy();
        expect(dist(sub(look.pos, scale(look.dir, look.length / 2)), action === 'entry' ? geo.in!.pos : geo.ramp.c)).toBeLessThan(3);
        let lastTrail: { x: number; y: number } | undefined;
        let bent = false;
        for (let f = 0; f < 30 * 100; f++) {
          scene.game.update(1 / 30); scene.tick();
          const look = scene.game.fleetLook(v)!;
          const hitch = hitchOf(look.body);
          if (hitch) {
            expect(look.trail, `${c.title} ${model} ${action} ${c.phase}: сцепка потерялась`).toBeTruthy();
            const joint = jointOf(look.pos, look.dir, look.length, hitch);
            const dir = trailDir(joint, look.trail, look.dir);
            expect(dist(joint, look.trail!)).toBeCloseTo(look.length * hitch.tail, 5);
            expect(dot(dir, look.dir), `${c.title} ${model} ${action} ${c.phase}: прицеп сложился на кабину`).toBeGreaterThan(0);
            const front = (hitch.joint - hitch.back) * look.length;
            const back = -(1 - hitch.joint) * look.length;
            const trailer = { c: add(joint, scale(dir, (front + back) / 2)), d: dir, hl: (front - back) / 2, hw: look.width / 2 };
            if (scene.game.docks.inYard(v.id)) expect(solids.some((solid) => boxesOverlap(trailer, solid)), `${c.title} ${model} ${action} ${c.phase}: прицеп задевает здание`).toBe(false);
            if (lastTrail) expect(dist(lastTrail, look.trail!), `${c.title} ${model} ${action} ${c.phase}: скачок прицепа`).toBeLessThan(1);
            lastTrail = { ...look.trail! };
            bent ||= dot(dir, look.dir) < 0.99;
          }
          if (action === 'entry' ? c.phase === 'unloading' : c.phase === 'done') break;
        }
        expect(c.phase, `${c.title} ${model} ${action}`).toBe(action === 'entry' ? 'unloading' : 'done');
        const parked = scene.game.fleetLook(v)!;
        const hitch = hitchOf(parked.body);
        if (hitch) expect(dot(parked.dir, trailDir(jointOf(parked.pos, parked.dir, parked.length, hitch), parked.trail, parked.dir)), `${c.title} ${model} ${action}: в конце оба кузова выровнены`).toBeGreaterThan(0.9999);
        if (hitchOf(look.body)) expect(bent, `${c.title} ${model} ${action}: прицеп должен следовать за седлом`).toBe(true);
        const pos = { ...scene.game.fleetLook(v)!.pos };
        for (let f = 0; f < 30; f++) { scene.game.update(1 / 30); scene.tick(); }
        expect(dist(scene.game.fleetLook(v)!.pos, pos)).toBeLessThan(0.01);
      }
    }
  });

  it('каждая допустимая модель доезжает к рампе и выезжает, сохраняя непрерывное положение кузова', () => {
    const probe = buildTruckAccessScene();
    for (const [i, pc] of probe.truckCases.entries()) for (const model of TRUCK_MODELS) {
      if (probe.modelProblem(i, model)) continue;
      const scene = buildTruckAccessScene();
      const c = scene.truckCases[i];
      scene.start(i, model);
      const at = lotFrame(c.building);
      const dir = sub(at(1, 0), at(0, 0));
      const solids = dockSolidsOf(c.building).map((r) => ({ c: at(r.x + r.w / 2, r.y + r.h / 2), d: dir, hl: r.w / 2, hw: r.h / 2 }));
      let last: { x: number; y: number } | undefined;
      let entered = false;
      for (let frames = 0; frames < 30 * 300 && c.phase !== 'done'; frames++) {
        scene.game.update(1 / 30); scene.tick();
        const v = c.vehicle!;
        const look = scene.game.fleetLook(v);
        const inYard = scene.game.docks.inYard(v.id);
        if (inYard) entered = true;
        if (look && inYard) {
          const parts = vehicleBoxes(look.pos, look.dir, look.length, look.width, look.body, look.trail);
          expect(parts.some((body) => solids.some((solid) => boxesOverlap(body, solid))), `${pc.title}: ${model}, ${c.phase} — кузов пересёк здание`).toBe(false);
        }
        if (look && (inYard || last)) {
          if (last) expect(dist(look.pos, last), `${pc.title}: ${model}, ${c.phase}`).toBeLessThan(2);
          last = { ...look.pos };
        } else last = undefined;
      }
      expect(entered, `${pc.title}: ${model}, ${c.phase}`).toBe(true);
      expect(c.arrivals, `${pc.title}: ${model}, ${c.phase}`).toBeGreaterThan(0);
      expect(c.exits, `${pc.title}: ${model}, ${c.phase}`).toBeGreaterThan(0);
      expect(c.phase, `${pc.title}: ${model}`).toBe('done');
      expect(c.vehicle?.model).toBe(model);
      expect(MODELS[model].mode).toBe('road');
      const delivered = scene.game.journal.entries.some((e) => e.k === 'stop' && e.st === c.dock.id && Object.entries(e.drop ?? {}).some(([cargo, n]) => cargo === c.cargo && typeof n === 'number' && n > 0));
      expect(delivered || (c.dock.cargo[c.cargo] ?? 0) > 0, `${pc.title}: ${model} — настоящий груз разгружен или принят на склад`).toBe(true);
      expect(scene.truckCases.filter((_, k) => k !== i).every((x) => x.phase === 'ready' && !x.vehicle)).toBe(true);
    }
  });

  it('запуск другого участка не сбрасывает текущий рейс и время сцены', () => {
    const scene = buildTruckAccessScene();
    scene.start(0, 'truck');
    for (let i = 0; i < 30 * 10; i++) { scene.game.update(1 / 30); scene.tick(); }
    const first = scene.truckCases[0].vehicle!;
    const sim = scene.game.fleetSim(first);
    const look = scene.game.fleetLook(first);
    expect(look).toBeTruthy();
    const time = scene.game.time;
    const pos = { ...look!.pos };
    scene.start(1, 'truck3');
    expect(scene.game.time).toBe(time);
    expect(scene.truckCases[0].vehicle).toBe(first);
    expect(scene.game.fleetSim(first)).toBe(sim);
    expect(scene.game.fleetLook(first)?.pos).toEqual(pos);
    expect(scene.truckCases[1].vehicle?.model).toBe('truck3');
    expect(scene.game.fleet.size).toBe(2);
  });
});
