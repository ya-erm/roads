import { afterEach, describe, expect, it, vi } from 'vitest';
import { RAIL_STATION, STATION, STOP } from '../config';
import { dist, type Vec } from '../core/vec';
import { freshGame, townStreets } from '../game/testkit';
import { Camera } from '../render/camera';
import { DEFAULT_SETTINGS } from '../world/settings';
import { Controller } from './controller';

afterEach(() => vi.unstubAllGlobals());

function scene() {
  const game = freshGame({ ...DEFAULT_SETTINGS, seed: 7, retail: true });
  game.money = 5_000_000;
  const events = { addEventListener() {} };
  vi.stubGlobal('window', events);
  const c = new Controller(events as unknown as HTMLCanvasElement, new Camera(), () => game);
  c.setStationMode('cargo');
  for (const town of game.towns) {
    for (const street of townStreets(game, town.id)) {
      const p = street.lut.pointAt(street.length / 2);
      const t = street.lut.tangentAt(street.length / 2);
      for (const side of [-1, 1]) {
        const hover: Vec = { x: p.x - t.y * side * 40, y: p.y + t.x * side * 40 };
        c.hover = hover;
        const o = c.overlay();
        if (o.station?.ok && o.receiverPreview?.receivers.length) return { game, c, hover, o };
      }
    }
  }
  throw new Error('Нет места для грузовой станции у магазинов');
}

describe('Охват грузовой станции до строительства', () => {
  it('предпросмотр показывает тех же получателей, что и построенная станция', () => {
    const { game, hover, o } = scene();
    expect(o.catchmentR).toBe(200);
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
    b.fp = { ...b.fp, center: { x: at.x + 185, y: at.y } };
    expect(covered()).toBe(true);
    b.fp.center.x = at.x + 200;
    expect(covered()).toBe(true);
    expect(game.stationReceivers(probe, [b.id]).some((x) => x.b.id === b.id)).toBe(false);
    b.fp.center.x = at.x + 201;
    expect(covered()).toBe(false);
    expect(game.catchmentRadius({ ...probe, serves: { pax: true, cargo: false } })).toBe(STATION.catchment);
    expect(game.catchmentRadius({ ...probe, kind: 'stop' })).toBe(STOP.catchment);
    expect(game.catchmentRadius({ ...probe, kind: 'rail' })).toBe(RAIL_STATION.catchment);
  });

  it('автовокзал и запрещённое размещение не обещают подключение магазинов', () => {
    const { c } = scene();
    c.setStationMode('pax');
    expect(c.overlay().receiverPreview).toBeUndefined();
    expect(c.overlay().catchmentR).toBe(170);
    c.setStationMode('cargo');
    c.hover = { x: -1000, y: -1000 };
    expect(c.overlay().station?.ok).toBe(false);
    expect(c.overlay().receiverPreview).toBeUndefined();
  });
});

it('при переносе магазина показывает станции у нового участка и предупреждает об отсутствии охвата', () => {
  const { game, c, hover } = scene();
  const st = game.placeStation(hover, 14, 'road', { pax: false, cargo: true })!;
  const { b, town } = game.stationReceivers(st)[0];
  const origin = b.fp.center;
  let outside: Vec | undefined;
  for (const street of townStreets(game, town.id)) {
    for (const fraction of [0.25, 0.5, 0.75]) {
      const s = street.length * fraction;
      const p = street.lut.pointAt(s);
      const t = street.lut.tangentAt(s);
      for (const side of [-1, 1]) {
        const at = { x: p.x - t.y * side * 30, y: p.y + t.x * side * 30 };
        const plan = game.movePlan(b, at);
        if (plan.ok && plan.fp && dist(plan.fp.center, st.fp.center) > game.catchmentRadius(st)) outside = at;
      }
      if (outside) break;
    }
    if (outside) break;
  }
  expect(outside).toBeDefined();
  c.startMove(b);
  c.hover = outside!;
  const disconnected = c.overlay();
  expect(disconnected.label).toMatchObject({ ok: true, warn: true });
  expect(disconnected.receiverMovePreview?.stations).toEqual([]);
  expect(game.moveBuilding(b, outside!)).toBe(true);
  expect(game.stationReceivers(st).some((x) => x.b.id === b.id)).toBe(false);

  c.hover = origin;
  const connected = c.overlay();
  expect(connected.label?.text).toContain(st.name);
  expect(connected.receiverMovePreview?.stations.map((x) => x.id)).toEqual([st.id]);
  expect(game.moveBuilding(b, origin)).toBe(true);
  expect(connected.receiverMovePreview?.receiver.b.fp).toEqual(b.fp);
  expect(game.stationReceivers(st).some((x) => x.b.id === b.id)).toBe(true);
});
