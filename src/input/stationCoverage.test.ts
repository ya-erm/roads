import { afterEach, describe, expect, it, vi } from 'vitest';
import { RAIL_STATION, STATION, STOP } from '../config';
import { dist, type Vec } from '../core/vec';
import { Game } from '../game/game';
import { fieldSpot, freshGame, townStreets } from '../game/testkit';
import { Camera } from '../render/camera';
import { DEFAULT_SETTINGS } from '../world/settings';
import { Controller } from './controller';

afterEach(() => vi.unstubAllGlobals());

const SETTINGS = { ...DEFAULT_SETTINGS, seed: 7, retail: true };

function controller(game: Game): Controller {
  const events = { addEventListener() {} };
  vi.stubGlobal('window', events);
  return new Controller(events as unknown as HTMLCanvasElement, new Camera(), () => game);
}

it('активная оптовая база показывает охват получателей при выборе и на новом участке при переносе', () => {
  const game = freshGame(SETTINGS);
  const town = game.towns.find(t => t.receivers?.some(r => r.depot))!;
  const b = game.buildingById(town.receivers!.find(r => r.depot)!.b)!;
  const c = controller(game);
  c.setTool('select');
  c.select({ type: 'building', id: b.id });
  const selected = c.overlay();
  expect(selected.catchmentAt).toEqual(b.fp.center);
  expect(selected.catchmentR).toBe(STATION.cargoCatchment);
  expect(selected.receiverPreview?.receivers.map(x => x.b.id)).toEqual(game.depotReceivers(b.fp).map(x => x.b.id));
  const ordinary = town.buildings.find(h => h.form !== 'depot')!;
  c.select({ type: 'building', id: ordinary.id });
  expect(c.overlay().catchmentAt).toBeNull();
  c.startMove(b);
  const street = townStreets(game, town.id).find(s => s.cls === 'street' || s.cls === 'avenue')!;
  c.hover = street.lut.pointAt(street.length / 2);
  const plan = game.movePlan(b, c.hover);
  expect(plan.fp).toBeTruthy();
  expect(plan.fp!.center).not.toEqual(b.fp.center);
  expect(c.overlay()).toMatchObject({ catchmentAt: plan.fp!.center, catchmentR: STATION.cargoCatchment });
});

function scene(game = freshGame(SETTINGS), townName?: string) {
  game.money = 5_000_000;
  const c = controller(game);
  c.setStationMode('cargo');
  for (const town of game.towns) {
    if (townName && town.name !== townName) continue;
    for (const street of townStreets(game, town.id)) {
      const p = street.lut.pointAt(street.length / 2);
      const t = street.lut.tangentAt(street.length / 2);
      for (const side of [-1, 1]) {
        const hover: Vec = { x: p.x - t.y * side * 40, y: p.y + t.x * side * 40 };
        c.hover = hover;
        const o = c.overlay();
        if (o.station?.ok && o.receiverPreview?.receivers.some((r) => r.town.id === town.id)) return { game, c, hover, o, town };
      }
    }
  }
  throw new Error('Нет места для грузовой станции у магазинов');
}

describe('Охват грузовой станции до строительства', () => {
  it('предпросмотр показывает тех же получателей, что и построенная станция', () => {
    const { game, hover, o } = scene();
    expect(o.catchmentR).toBe(225);
    expect(game.stations.size).toBe(0);
    const ids = o.receiverPreview!.receivers.map(({ b }) => b.id);
    const st = game.placeStation(hover, 14, 'road', { pax: false, cargo: true })!;
    expect(st).toBeTruthy();
    expect(game.stationReceivers(st).map(({ b }) => b.id)).toEqual(ids);
    expect(o.receiverPreview!.at).toEqual(st.fp.center);
    expect(o.receiverPreview!.receivers.every(({ r }) => !r.depot)).toBe(true);
  });

  it('магазин за прежней границей входит в охват; за новой границей и под сносом — нет', () => {
    const { game, o } = scene();
    const { b } = o.receiverPreview!.receivers[0];
    const at = o.station!.fp.center;
    const probe = { kind: 'road' as const, fp: o.station!.fp, serves: { pax: false, cargo: true } };
    const covered = () => game.stationReceivers(probe).some((x) => x.b.id === b.id);
    b.fp = { ...b.fp, center: { x: at.x + 215, y: at.y } };
    expect(covered()).toBe(true);
    b.fp.center.x = at.x + 225;
    expect(covered()).toBe(true);
    expect(game.stationReceivers(probe, [b.id]).some((x) => x.b.id === b.id)).toBe(false);
    b.fp.center.x = at.x + 226;
    expect(covered()).toBe(false);
    expect(game.catchmentRadius({ ...probe, serves: { pax: true, cargo: false } })).toBe(STATION.catchment);
    expect(game.catchmentRadius({ ...probe, kind: 'stop' })).toBe(STOP.catchment);
    expect(game.catchmentRadius({ ...probe, kind: 'rail' })).toBe(RAIL_STATION.catchment);
  });

  it('автовокзал и запрещённое размещение не обещают подключение магазинов', () => {
    const { c } = scene();
    c.setStationMode('pax');
    expect(c.overlay().receiverPreview).toBeUndefined();
    expect(c.overlay().catchmentR).toBe(190);
    c.setStationMode('cargo');
    c.hover = { x: -1000, y: -1000 };
    expect(c.overlay().station?.ok).toBe(false);
    expect(c.overlay().receiverPreview).toBeUndefined();
  });
});

it('пассажирские остановки и вокзалы показывают новый охват до постройки и после загрузки', () => {
  const { game, c, hover, town } = scene();
  c.setStationMode('pax');
  expect(c.overlay().catchmentR).toBe(190);
  const terminal = game.placeStation(hover, 14, 'road', { pax: true, cargo: false })!;
  expect(terminal.serves).toEqual({ pax: true, cargo: false });
  c.setStationMode('stop');
  const stopAt = townStreets(game, town.id).flatMap((street) => {
    const s = street.length / 2;
    const p = street.lut.pointAt(s);
    const t = street.lut.tangentAt(s);
    return [-1, 1].map((side) => ({ x: p.x - t.y * side * 14, y: p.y + t.x * side * 14 }));
  }).find((p) => game.stationPlan(p, 14, 'stop').ok)!;
  c.hover = stopAt;
  expect(c.overlay().catchmentR).toBe(125);
  const stop = game.placeStation(stopAt, 14, 'stop')!;

  c.setStationMode('rail');
  const field = fieldSpot(game, 700);
  const railAt = { x: field.x + 350, y: field.y };
  c.hover = railAt;
  expect(c.overlay().catchmentR).toBe(270);
  const rail = game.placeStation(railAt, 14, 'rail')!;
  expect(rail).toBeTruthy();

  const save = JSON.parse(JSON.stringify(game.toSave()));
  const stale = save.stations.find((s: { id: number }) => s.id === stop.id);
  stale.catchPop = 0;
  stale.townIds = [];
  const restored = new Game(SETTINGS, save);
  const restoredStop = restored.stations.get(stop.id)!;
  expect(restoredStop.catchPop).toBeGreaterThan(0);
  expect(restoredStop.townIds).toContain(town.id);
  const selected = controller(restored);
  for (const [id, r] of [[terminal.id, 190], [stop.id, 125], [rail.id, 270]]) {
    selected.select({ type: 'station', id });
    expect(selected.overlay()).toMatchObject({ catchmentAt: restored.stations.get(id)!.fp.center, catchmentR: r });
  }
}, 30_000);

it('при переносе магазина показывает станции у нового участка и предупреждает об отсутствии охвата', () => {
  const { game, c, hover } = scene(new Game(SETTINGS), 'Каменка');
  const st = game.placeStation(hover, 14, 'road', { pax: false, cargo: true })!;
  const { b } = game.stationReceivers(st).find((r) => r.b.id === 7)!;
  // Свободные места вдоль улиц Каменки, подходящие для рынка: на окраине и у станции.
  const outside = { x: 3939.45, y: 1914.62 };
  const inside = { x: 3658.72, y: 2661.18 };
  c.startMove(b);
  c.hover = outside;
  const disconnected = c.overlay();
  expect(disconnected.label).toMatchObject({ ok: true, warn: true });
  expect(disconnected.receiverMovePreview?.stations).toEqual([]);
  expect(game.moveBuilding(b, outside)).toBe(true);
  expect(dist(b.fp.center, st.fp.center)).toBeGreaterThan(225);
  expect(game.stationReceivers(st).some((x) => x.b.id === b.id)).toBe(false);

  c.hover = inside;
  const connected = c.overlay();
  expect(connected.label?.text).toContain(st.name);
  expect(connected.receiverMovePreview?.stations.map((x) => x.id)).toEqual([st.id]);
  expect(game.moveBuilding(b, inside)).toBe(true);
  expect(dist(b.fp.center, st.fp.center)).toBeLessThanOrEqual(225);
  expect(connected.receiverMovePreview?.receiver.b.fp).toEqual(b.fp);
  expect(game.stationReceivers(st).some((x) => x.b.id === b.id)).toBe(true);
}, 30_000);
