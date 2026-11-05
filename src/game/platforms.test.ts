import { describe, expect, it } from 'vitest';
import { add, dist, rightNormal, scale, Vec } from '../core/vec';
import type { Station } from '../world/entities';
import { RAIL_SPEC } from '../world/roadTypes';
import { Game } from './game';
import { withoutCitizens } from './testkit';
import type { StopRule } from './transport';

function runSeconds(game: Game, seconds: number, each?: () => void) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) {
    game.update(0.1);
    each?.();
  }
}

/** Длинный путь с вокзалами на три пути у концов — в чистом поле, без машин жителей (сюда они не доезжают). */
function railWorld(): { game: Game; a: Station; b: Station } {
  const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 9_000_000, water: 'dry' }));
  const len = 2400;
  const serves = { pax: true, cargo: true };
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      for (const angle of [0, 0.3, -0.3]) {
        const dir = { x: Math.cos(angle), y: Math.sin(angle) };
        const from = { x, y };
        const at = (k: number, side = 0): Vec => add(add(from, scale(dir, k)), scale(rightNormal(dir), side));
        const req = { start: { kind: 'free' as const, pos: from, level: 0 }, end: { kind: 'free' as const, pos: at(len), level: 0 }, spec: RAIL_SPEC, mode: 'straight' as const };
        if (!game.builder.plan(req).ok) continue;
        game.builder.build(req);
        const pa = game.stationPlan(at(400, 40), 14, 'rail', 0, 3);
        const pb = game.stationPlan(at(len - 400, 40), 14, 'rail', 0, 3);
        if (pa.ok && pb.ok) {
          const a = game.placeStation(at(400, 40), 14, 'rail', serves, 0, 3)!;
          const b = game.placeStation(at(len - 400, 40), 14, 'rail', serves, 0, 3)!;
          return { game, a, b };
        }
        game.builder.bulldoze(at(len / 2), 4);
      }
    }
  }
  throw new Error('Нет места для пути');
}

const GO: StopRule = { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' };

/** Где встают поезда линий: id линии → платформы прибытия по станциям. */
function arrivals(game: Game, seconds: number): Map<number, Map<number, Set<number>>> {
  const res = new Map<number, Map<number, Set<number>>>();
  const last = new Map<number, string>();
  runSeconds(game, seconds, () => {
    for (const v of game.fleet.values()) {
      const t = game.fleetTrain(v);
      if (v.state === 'loading' && last.get(v.id) !== 'loading' && t?.platform !== null && t) {
        const line = game.lines.get(v.lineId)!;
        const byStation = res.get(line.id) ?? new Map<number, Set<number>>();
        res.set(line.id, byStation);
        const st = line.stops[v.stop];
        byStation.set(st, (byStation.get(st) ?? new Set()).add(t.platform!));
      }
      last.set(v.id, v.state);
    }
  });
  return res;
}

describe('Путь ж/д станции для остановки', { timeout: 60_000 }, () => {
  it('у каждого маршрута свой путь: поезда встают на свои платформы, линия на карте ведёт к ним', () => {
    const { game, a, b } = railWorld();
    expect(a.platforms).toHaveLength(3);
    const lines = [1, 2].map((k) => {
      const line = game.createLine([a.id, b.id])!;
      game.setStopRule(line.id, 0, { ...GO, platform: k });
      game.setStopRule(line.id, 1, { ...GO, platform: k });
      return line;
    });
    expect(game.stopPlatform(lines[0], 1)).toBe(b.platforms[1]);
    // На карте путь линии идёт до выбранной платформы.
    const mid = (id: number) => game.net.segment(id).lut.pointAt(game.net.segment(id).length / 2);
    for (const [k, line] of lines.entries()) {
      const pts = game.linePolyline(line, 0)!;
      expect(pts.some((q) => dist(q, mid(b.platforms[k + 1])) < 3)).toBe(true);
      expect(pts.some((q) => dist(q, mid(b.platforms[2 - k])) < 3)).toBe(false);
    }
    for (const line of lines) game.buyVehicle(line.id, 'passengerTrain');
    const got = arrivals(game, 400);
    for (const [k, line] of lines.entries()) {
      for (const st of [a, b]) expect([...(got.get(line.id)?.get(st.id) ?? [])]).toEqual([st.platforms[k + 1]]);
    }
    for (const line of lines) expect(game.lines.get(line.id)!.problem).toBeNull();
    // Выбор пути сохраняется; старое сохранение (без него) — авто.
    const save = JSON.parse(JSON.stringify(game.toSave()));
    const loaded = new Game(game.settings, save);
    expect(loaded.stopRule(loaded.lines.get(lines[1].id)!, 1).platform).toBe(2);
    for (const l of save.lines) for (const r of l.rules ?? []) if (r) delete r.platform;
    const old = new Game(game.settings, save);
    expect(old.stopPlatform(old.lines.get(lines[1].id)!, 1)).toBeNull();
  });

  it('авто: второй поезд встаёт на свободный путь, а не на занятый первым', () => {
    const { game, a, b } = railWorld();
    const line = game.createLine([a.id, b.id])!;
    game.setStopRule(line.id, 0, GO);
    // На b первый поезд стоит до полной загрузки — путь занят надолго.
    game.setStopRule(line.id, 1, { wait: 'full', maxWait: null, load: 'auto', unload: 'auto' });
    game.buyVehicle(line.id, 'freightTrain');
    game.buyVehicle(line.id, 'freightTrain');
    const trains = () => [...game.fleet.values()].map((v) => ({ v, t: game.fleetTrain(v) }));
    let both: number[] | null = null;
    runSeconds(game, 400, () => {
      const at = trains().filter(({ v, t }) => v.stop === 1 && v.state !== 'driving' && t && !t.moving && t.platform !== null);
      if (at.length === 2 && !both) both = at.map(({ t }) => t!.platform!);
    });
    expect(both).not.toBeNull();
    expect(new Set(both!).size).toBe(2);
    for (const p of both!) expect(b.platforms).toContain(p);
  });
});
