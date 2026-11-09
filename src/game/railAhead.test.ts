import { describe, expect, it } from 'vitest';
import { add, scale, Vec } from '../core/vec';
import type { Train } from '../sim/rail';
import type { Station } from '../world/entities';
import { RAIL_SPEC } from '../world/roadTypes';
import { Game } from './game';
import { runSeconds, withoutCitizens } from './testkit';
import type { StopRule } from './transport';

/**
 * Прямой однопутный перегон 2800 м в чистом поле с вокзалами на два пути (сквозной и боковой) у точек along;
 * signals — сигналы в одну сторону у этих точек. Без машин жителей.
 */
function railLine(along: number[], signals: number[] = []): { game: Game; stations: Station[] } {
  const len = 2800;
  const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 3, industries: 'few', money: 9_000_000, water: 'dry' }));
  for (let y = 400; y < game.terrain.height - 400; y += 170) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 230) {
      for (const angle of [0, 0.3, -0.3]) {
        const dir = { x: Math.cos(angle), y: Math.sin(angle) };
        const from = { x, y };
        const at = (k: number, side = 0): Vec => add(add(from, scale(dir, k)), scale({ x: -dir.y, y: dir.x }, side));
        const req = { start: { kind: 'free' as const, pos: from, level: 0 }, end: { kind: 'free' as const, pos: at(len), level: 0 }, spec: RAIL_SPEC, mode: 'straight' as const };
        // В чистом поле: без переездов через стартовые просёлки к предприятиям.
        const road = (k: number) => game.roads.net.corridorsNear(at(k), 150).some((c) => c.lut.closest(at(k)).d < 150);
        if (Array.from({ length: len / 100 + 1 }, (_, i) => i * 100).some(road)) continue;
        if (!game.builder.plan(req).ok) continue;
        game.builder.build(req);
        if (along.every((k) => game.stationPlan(at(k, 40), 14, 'rail').ok)) {
          const stations = along.map((k) => game.placeStation(at(k, 40), 14, 'rail')!);
          for (const k of signals) expect(game.toggleSignal(at(k, -20), 14)).toBe(true);
          return { game, stations };
        }
        game.builder.bulldoze(at(len / 2), 4);
      }
    }
  }
  throw new Error('Нет места для пути');
}

const GO: StopRule = { wait: 'none', maxWait: null, load: 'auto', unload: 'auto' };
const FULL = (maxWait: number | null, platform?: number): StopRule => ({ wait: 'full', maxWait, load: 'auto', unload: 'auto', platform });

/** Отрезки пути, занятые телом поезда: участок → [от, до] в его координатах. */
function body(train: Train): Map<number, [number, number]> {
  const result = new Map<number, [number, number]>();
  const tail = train.head - train.length;
  for (const e of train.path) {
    const a = Math.max(tail, e.start);
    const b = Math.min(train.head, e.start + e.len);
    if (b <= a) continue;
    result.set(e.seg, e.dir === 0 ? [a - e.start, b - e.start] : [e.start + e.len - b, e.start + e.len - a]);
  }
  return result;
}

function overlaps(trains: Train[]): number {
  let n = 0;
  for (let i = 0; i < trains.length; i++) {
    const bi = body(trains[i]);
    for (let j = i + 1; j < trains.length; j++) {
      for (const [seg, [x0, x1]] of body(trains[j])) {
        const o = bi.get(seg);
        if (o && o[0] < x1 && x0 < o[1]) n++;
      }
    }
  }
  return n;
}

interface Ahead {
  train: number;
  platform: number;
  occupant?: Train;
  arrived?: number | null;
}

/**
 * Прогон: отправления по прогнозу (к какой платформе, кто на ней, куда в итоге встал), столкновения тел, застрявшие
 * поезда (давно не вставали на станцию), сколько секунд поезда простояли готовыми к отправлению на станции
 * firstStation и сколько секунд у станции watchJam висело «нет мест».
 */
function watch(game: Game, seconds: number, firstStation: number, watchJam?: Station) {
  const ahead: Ahead[] = [];
  const open = new Map<number, Ahead>();
  const lastArrival = new Map<number, number>();
  const prev = new Map<number, string>();
  let crashes = 0;
  let waitFirst = 0;
  let jam = 0;
  runSeconds(game, seconds, () => {
    const trains = [...game.rail.trains.values()];
    crashes += overlaps(trains);
    for (const t of trains) {
      const o = open.get(t.id);
      if (t.claim !== undefined && !o) {
        const e: Ahead = { train: t.id, platform: t.claim, occupant: trains.find((x) => x.segs.includes(t.claim!)) };
        ahead.push(e);
        open.set(t.id, e);
      }
      if (o && !t.moving) {
        o.arrived = t.platform;
        open.delete(t.id);
      }
    }
    for (const v of game.fleet.values()) {
      const line = game.lines.get(v.lineId)!;
      if (v.state === 'loading' && prev.get(v.id) !== 'loading') lastArrival.set(v.id, game.time);
      if (v.state === 'departing' && v.waited > 0 && line.stops[v.stop] === firstStation) waitFirst += 0.1;
      prev.set(v.id, v.state);
    }
    if (watchJam && game.stationJam(watchJam)) jam += 0.1;
  });
  const stuck = [...game.fleet.values()].filter((v) => game.time - (lastArrival.get(v.id) ?? 0) > 400).length;
  return { ahead, crashes, waitFirst, jam, stuck };
}

/** Туда и обратно A → B → C → B: на B туда — боковой путь со стоянкой до 25 с, обратно — сквозной. */
function outAndBack(trains: number, ahead = true) {
  const { game, stations } = railLine([400, 1400, 2400]);
  const [a, b, c] = stations;
  if (!ahead) game.rail.departAhead = () => 'blocked';
  const line = game.createLine([a.id, b.id, c.id, b.id])!;
  [GO, FULL(25, 1), GO, { ...GO, platform: 0 }].forEach((r, i) => game.setStopRule(line.id, i, r));
  for (let i = 0; i < trains; i++) expect(game.buyVehicle(line.id, 'passengerTrain')).not.toBeNull();
  return { game, a, b, c, line };
}

describe('Отправление к платформе, которая освободится к приезду', { timeout: 60_000 }, () => {
  it('поезд не ждёт на прошлой станции: едет, пока с платформы уходит другой, и встаёт на неё', () => {
    const now = outAndBack(3);
    const res = watch(now.game, 900, now.a.id, now.b);
    expect(res.crashes).toBe(0);
    expect(res.stuck).toBe(0);
    expect(res.ahead.length).toBeGreaterThan(2);
    for (const e of res.ahead) {
      // Заявка — на занятую платформу: на ней стоит или к ней едет другой поезд, и встаёт поезд именно на неё.
      expect(e.platform).toBe(now.b.platforms[1]);
      expect(e.occupant).toBeDefined();
      if (e.arrived !== undefined) expect(e.arrived).toBe(e.platform);
    }
    // Как было: ждали бы на A, пока платформа B не освободится совсем.
    const was = outAndBack(3, false);
    const before = watch(was.game, 900, was.a.id, was.b);
    expect(res.waitFirst).toBeLessThan(before.waitFirst * 0.7);
    // «Нет мест» у B — реже: тот, кто уже едет к освобождающейся платформе, не ждёт.
    expect(res.jam).toBeLessThan(before.jam);
  });

  it('стоит у входа, пока платформа занята, — тогда «нет мест» и считает его ждущим', () => {
    const { game, b, line } = outAndBack(3);
    let waitedAtEntry = 0;
    let counted = 0;
    const approaches = () => (game as unknown as { approaches(): { station: number; blocked: boolean }[] }).approaches();
    runSeconds(game, 900, () => {
      for (const v of game.fleet.values()) {
        const t = game.fleetTrain(v);
        if (!t || !game.rail.waitsPlatform(t)) continue;
        waitedAtEntry++;
        // Стоит перед платформой, на которую заявлен, а она занята другим поездом.
        expect(t.v).toBeLessThan(0.3);
        expect(game.rail.isReserved(t.claim!)).toBe(true);
        expect(line.stops[v.stop]).toBe(b.id);
        if (approaches().some((x) => x.station === b.id && x.blocked)) counted++;
      }
    });
    expect(waitedAtEntry).toBeGreaterThan(0);
    expect(counted).toBe(waitedAtEntry);
  });

  it('стоянка без предела (до полной загрузки) — прогноза нет: поезд ждёт на своей станции, как раньше', () => {
    const { game, stations } = railLine([400, 1400, 2400]);
    const [a, b, c] = stations;
    const line = game.createLine([a.id, b.id, c.id, b.id])!;
    [GO, FULL(null, 1), GO, { ...GO, platform: 0 }].forEach((r, i) => game.setStopRule(line.id, i, r));
    for (let i = 0; i < 2; i++) game.buyVehicle(line.id, 'freightTrain');
    const res = watch(game, 300, a.id);
    expect(res.ahead).toHaveLength(0);
    expect(res.crashes).toBe(0);
  });

  it('однопутка туда-обратно: с платформы уходят навстречу — поезд не выезжает на перегон, взаимной блокировки нет', () => {
    const { game, stations } = railLine([400, 2400]);
    const [a, b] = stations;
    const line = game.createLine([a.id, b.id])!;
    [GO, FULL(20, 1)].forEach((r, i) => game.setStopRule(line.id, i, r));
    // Третий поезд здесь лишний и без прогноза: платформ на линии три — однопутка запирается (так было и раньше).
    for (let i = 0; i < 2; i++) game.buyVehicle(line.id, i % 2 ? 'freightTrain' : 'passengerTrain');
    const res = watch(game, 1200, a.id);
    expect(res.ahead).toHaveLength(0);
    expect(res.crashes).toBe(0);
    expect(res.stuck).toBe(0);
  });

  it('однопутка с сигналами в одну сторону, три поезда: никто не встаёт навсегда', () => {
    for (const maxWait of [10, 30]) {
      const { game, stations } = railLine([400, 1400, 2400], [900, 1150, 1900, 2150]);
      const [a, b, c] = stations;
      const line = game.createLine([a.id, b.id, c.id])!;
      [GO, FULL(maxWait, 1), GO].forEach((r, i) => game.setStopRule(line.id, i, r));
      for (let i = 0; i < 3; i++) game.buyVehicle(line.id, 'passengerTrain');
      const res = watch(game, 1200, a.id);
      expect(res.ahead.length).toBeGreaterThan(0);
      expect(res.crashes).toBe(0);
      expect(res.stuck).toBe(0);
    }
  });

  it('сохранение, пока поезд едет к занятой платформе: заявка и путь ухода стоящего поезда восстанавливаются', () => {
    const { game } = outAndBack(3);
    for (let i = 0; i < 6000 && ![...game.rail.trains.values()].some((t) => t.claim !== undefined); i++) game.update(0.1);
    const t0 = [...game.rail.trains.values()].find((t) => t.claim !== undefined)!;
    const occupant0 = [...game.rail.trains.values()].find((t) => t.exit)!;
    expect(t0).toBeDefined();
    expect(occupant0).toBeDefined();
    const loaded = withoutCitizens(new Game(game.settings, JSON.parse(JSON.stringify(game.toSave()))));
    const t1 = loaded.rail.trains.get(t0.id)!;
    expect(t1.claim).toBe(t0.claim);
    expect(loaded.rail.trains.get(occupant0.id)!.exit?.map((e) => e.seg)).toEqual(occupant0.exit!.map((e) => e.seg));
    expect(loaded.rail.isReserved(t1.claim!)).toBe(true);
    const claimed = t1.claim;
    // Загруженная партия идёт дальше: поезд встаёт на заявленную платформу, никто не застревает.
    const res = watch(loaded, 600, -1);
    expect(res.crashes).toBe(0);
    expect(res.stuck).toBe(0);
    const firstStop = res.ahead.find((e) => e.train === t1.id);
    expect(firstStop?.arrived ?? claimed).toBe(claimed);
  });
});
