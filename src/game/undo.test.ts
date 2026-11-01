import { describe, expect, it } from 'vitest';
import { add, scale } from '../core/vec';
import type { RoadRequest } from './build';
import { Game } from './game';

const STREET = { cls: 'street' as const, lanesF: 1, lanesB: 1 };

function runSeconds(game: Game, seconds: number) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) game.update(0.1);
}

/** Прямая дорога через самый большой город — поперёк его улиц, со сносом домов. */
function throughTown(game: Game): RoadRequest | null {
  const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
  for (let a = 0; a < Math.PI; a += 0.2) {
    const dir = { x: Math.cos(a), y: Math.sin(a) };
    const from = add(town.center, scale(dir, -town.radius * 0.8));
    const to = add(town.center, scale(dir, -town.radius * 0.2));
    const req: RoadRequest = { start: game.builder.snap(from, 0, 10), end: game.builder.snap(to, 0, 10), spec: STREET, mode: 'straight' };
    const plan = game.builder.plan(req);
    if (plan.ok && plan.demolish.length) return req;
  }
  return null;
}

describe('Перенос конца дороги', () => {
  it('тупик можно продлить вдоль дороги и увести в сторону', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    // Свободное место для дороги.
    let built: { endNode: number } | null = null;
    let from = { x: 0, y: 0 };
    for (let y = 400; y < game.terrain.height - 400 && !built; y += 120) {
      for (let x = 300; x < game.terrain.width - 700 && !built; x += 160) {
        from = { x, y };
        const req: RoadRequest = { start: { kind: 'free', pos: from, level: 0 }, end: { kind: 'free', pos: { x: x + 200, y }, level: 0 }, spec: STREET, mode: 'straight' };
        const far: RoadRequest = { ...req, end: { kind: 'free', pos: { x: x + 400, y: y - 80 }, level: 0 } };
        if (game.builder.plan(req).ok && game.builder.plan(far).ok) built = game.builder.build(req);
      }
    }
    expect(built).not.toBeNull();
    // Продлить прямо и увести в сторону — оба раза получается.
    expect(game.builder.moveEnd(built!.endNode, { kind: 'free', pos: { x: from.x + 300, y: from.y }, level: 0 })).toBe(true);
    const end = [...game.net.nodes.values()].find((n) => Math.hypot(n.pos.x - from.x - 300, n.pos.y - from.y) < 1)!;
    expect(end).toBeDefined();
    expect(game.builder.moveEnd(end.id, { kind: 'free', pos: { x: from.x + 400, y: from.y - 80 }, level: 0 })).toBe(true);
  });
});

describe('Снос рамкой', () => {
  it('сносит дороги и дома внутри рамки одним шагом, Ctrl+Z возвращает', () => {
    const game = new Game(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const a = { x: town.center.x - 120, y: town.center.y - 120 };
    const b = { x: town.center.x + 120, y: town.center.y + 120 };
    const c = game.areaContents(a, b);
    expect(c.segs.length).toBeGreaterThan(0);
    expect(c.buildings.length).toBeGreaterThan(0);
    // Ратуша не сносится.
    expect(c.buildings.some((x) => x.kind === 'landmark')).toBe(false);
    const segs = game.net.segments.size;
    const houses = town.buildings.length;
    expect(game.bulldozeArea(a, b)).toBe(true);
    expect(game.net.segments.size).toBeLessThan(segs);
    expect(town.buildings.length).toBe(houses - c.buildings.filter((x) => x.townId === town.id).length);
    expect(game.undo()).toBe('снос области');
    expect(game.net.segments.size).toBe(segs);
    expect(town.buildings.length).toBe(houses);
  });
});

describe('Отмена развязки', () => {
  it('Ctrl+Z отменяет развязку, даже если город успел сам проложить улицу', () => {
    const game = new Game(7);
    const before = game.net.segments.size;
    let built = false;
    for (let y = 800; y < game.terrain.height - 800 && !built; y += 200) {
      for (let x = 800; x < game.terrain.width - 800 && !built; x += 200) {
        const plan = game.templatePlan({ x, y }, 14, { kind: 'diamond', angle: 0, trunk: { cls: 'motorway', lanesF: 2, lanesB: 2 } });
        if (plan.ok) built = game.buildTemplate(plan, 'развязка «ромб»') === null;
      }
    }
    expect(built).toBe(true);
    const withTemplate = game.net.segments.size;
    expect(withTemplate).toBeGreaterThan(before);
    // Город растёт сам и прокладывает улицу.
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    town.growthAcc = 400;
    (game as unknown as { growTown(t: unknown): void }).growTown(town);
    expect(game.net.segments.size).toBeGreaterThan(withTemplate);
    expect(game.undo()).toBe('развязка «ромб»');
    expect(game.net.segments.size).toBe(before);
    // Ни один дом не остался без своей дороги.
    for (const t of game.towns) for (const b of t.buildings) expect(game.net.nodes.has(b.anchor)).toBe(true);
  });

  it('выключатель в городе запрещает прокладывать улицы', () => {
    const game = new Game(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    town.autoStreets = false;
    const segs = game.net.segments.size;
    town.growthAcc = 400;
    (game as unknown as { growTown(t: unknown): void }).growTown(town);
    expect(game.net.segments.size).toBe(segs);
  });
});

describe('Отмена строительства', () => {
  it('Ctrl+Z возвращает дорогу, снесённые дома и деньги', () => {
    const game = new Game(7);
    runSeconds(game, 10);
    const req = throughTown(game);
    expect(req).not.toBeNull();
    const segs = game.net.segments.size;
    const houses = game.towns.reduce((s, t) => s + t.buildings.length, 0);
    const money = game.money;
    game.checkpoint('дорога');
    expect(game.builder.build(req!)).not.toBeNull();
    game.commit();
    expect(game.money).toBeLessThan(money);
    expect(game.towns.reduce((s, t) => s + t.buildings.length, 0)).toBeLessThan(houses);
    expect(game.undo()).toBe('дорога');
    expect(game.net.segments.size).toBe(segs);
    expect(game.towns.reduce((s, t) => s + t.buildings.length, 0)).toBe(houses);
    expect(game.money).toBe(money);
    // Жизнь продолжается: машины ездят по восстановленной сети.
    runSeconds(game, 20);
    expect(game.citizenCars).toBe([...game.traffic.vehicles.values()].length);
    expect(game.citizenCars).toBeGreaterThan(0);
  });

  it('пустое действие не занимает место в истории, станция отменяется', () => {
    const game = new Game(7);
    game.checkpoint('снос');
    game.commit();
    expect(game.canUndo).toBe(false);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    let placed = false;
    for (const sid of town.streets) {
      const seg = game.net.segments.get(sid);
      if (!seg) continue;
      const p = seg.lut.pointAt(seg.length / 2);
      const t = seg.lut.tangentAt(seg.length / 2);
      game.checkpoint('станция');
      const st = game.placeStation({ x: p.x - t.y * 40, y: p.y + t.x * 40 }, 14);
      game.commit();
      if (st) {
        placed = true;
        expect(game.stations.size).toBe(1);
        game.undo();
        expect(game.stations.size).toBe(0);
        expect(game.net.nodes.has(st.nodeId)).toBe(false);
        break;
      }
    }
    expect(placed).toBe(true);
  });
});
