import { describe, expect, it } from 'vitest';
import { MONTH_LENGTH, STOP } from '../config';
import { dist } from '../core/vec';
import type { Station } from '../world/entities';
import { Game } from './game';
import { townStreets } from './testkit';

function runMonths(game: Game, months: number) {
  game.speed = 1;
  for (let t = 0; t < months * MONTH_LENGTH; t += 0.1) game.update(0.1);
}

/** Остановки на улицах крупнейшего города — не ближе minGap друг к другу. */
function placeStops(game: Game, count: number, minGap = 350): Station[] {
  const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
  const placed: Station[] = [];
  for (const seg of townStreets(game, town.id)) {
    if (placed.length >= count) break;
    if (seg.length < 80) continue;
    const p = seg.lut.pointAt(seg.length / 2);
    const t = seg.lut.tangentAt(seg.length / 2);
    const q = { x: p.x - t.y * 14, y: p.y + t.x * 14 };
    if (placed.some((s) => dist(s.fp.center, q) < minGap)) continue;
    const st = game.placeStation(q, 14, 'stop');
    if (st) placed.push(st);
  }
  return placed;
}

describe('Автобусные остановки', { timeout: 60_000 }, () => {
  it('маршрут по остановкам на улицах приносит доход; грузовики к остановкам не ездят', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const corridorsBefore = game.roads.net.corridors.size;
    const stops = placeStops(game, 3);
    expect(stops).toHaveLength(3);
    // Остановка — стык прямо на улице: улица разрезана, заезда нет.
    expect(game.roads.net.corridors.size).toBe(corridorsBefore + 3);
    for (const st of stops) {
      expect(st.kind).toBe('stop');
      expect(st.serves).toEqual({ pax: true, cargo: false });
      expect(game.roads.net.node(st.nodeId).kind).toBe('seam');
      expect(st.name).toMatch(/ост\. \d/);
    }
    const line = game.createLine(stops.map((s) => s.id))!;
    expect(line).not.toBeNull();
    expect(game.buyVehicle(line.id, 'truck')).toBeNull();
    expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    expect(game.buyVehicle(line.id, 'bus')).not.toBeNull();
    runMonths(game, 3);
    expect(line.revenueTotal).toBeGreaterThan(0);
    expect(line.problem).toBeNull();
    // Сохранение — с остановками.
    const loaded = new Game(game.settings, JSON.parse(JSON.stringify(game.toSave())));
    expect([...loaded.stations.values()].filter((s) => s.kind === 'stop')).toHaveLength(3);
    // Снос остановки (без маршрута) улицу не трогает.
    game.deleteLine(line.id);
    const corridors = game.roads.net.corridors.size;
    expect(game.removeStation(stops[0])).toBe(true);
    expect(game.roads.net.corridors.size).toBe(corridors);
  });

  it('остановки и автостанции — в одном маршруте; рядом с остановкой вторую не поставить', () => {
    const game = new Game(7);
    game.money = 5_000_000;
    const [stop] = placeStops(game, 1);
    const near = game.stationPlan({ x: stop.fp.center.x + 10, y: stop.fp.center.y }, 14, 'stop');
    expect(near.ok).toBe(false);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    let station: Station | null = null;
    for (const seg of townStreets(game, town.id)) {
      const p = seg.lut.pointAt(seg.length / 2);
      const t = seg.lut.tangentAt(seg.length / 2);
      if (dist(p, stop.fp.center) < 300) continue;
      station = game.placeStation({ x: p.x - t.y * 40, y: p.y + t.x * 40 }, 14);
      if (station) break;
    }
    expect(station).not.toBeNull();
    expect(game.lineProblem([stop.id, station!.id])).toBeNull();
    expect(game.createLine([stop.id, station!.id])).not.toBeNull();
  });

  it('где остановку не поставить, её силуэт всё равно есть — для красного предпросмотра', () => {
    const game = new Game(7);
    const net = game.roads.net;
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    // У самого перекрёстка — навес у края улицы.
    const seg = townStreets(game, town.id).find((c) => c.length > 80 && net.node(c.a).kind === 'junction')!;
    expect(seg).toBeDefined();
    const q = seg.lut.pointAt(10);
    const t = seg.lut.tangentAt(10);
    const near = game.stationPlan({ x: q.x - t.y * 14, y: q.y + t.x * 14 }, 14, 'stop');
    expect(near.ok).toBe(false);
    expect(near.reason).toBe('Слишком близко к перекрёстку');
    expect(near.fp).toMatchObject({ w: STOP.size.w, h: STOP.size.h });
    expect(dist(near.fp!.center, q)).toBeLessThan(30);
    // Вдали от улиц — под курсором.
    let p: { x: number; y: number } | null = null;
    for (let x = 300; x < game.terrain.width - 300 && !p; x += 97) {
      for (let y = 300; y < game.terrain.height - 300 && !p; y += 83) {
        const c = { x, y };
        if (!net.corridorsNear(c, 200).length && !game.isWater(c, 20) && !game.index.near(c, 120).length) p = c;
      }
    }
    expect(p).not.toBeNull();
    const far = game.stationPlan(p!, 14, 'stop');
    expect(far.ok).toBe(false);
    expect(far.reason).toBe('Поставьте у городской улицы');
    expect(far.fp).toMatchObject({ center: p, w: STOP.size.w, h: STOP.size.h });
    expect(game.placeStation(p!, 14, 'stop')).toBeNull();
  });
});
