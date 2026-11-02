import { describe, expect, it } from 'vitest';
import { add, scale, Vec } from '../core/vec';
import { insideRuns } from '../lanes/edit';
import { Game } from './game';
import type { RoadPlan } from './roadbuild';
import { road, roadPlan, townStreets } from './testkit';

function runSeconds(game: Game, seconds: number) {
  game.speed = 1;
  for (let t = 0; t < seconds; t += 0.1) game.update(0.1);
}

/** Прямая дорога через самый большой город — поперёк его улиц, со сносом домов. */
function throughTown(game: Game): RoadPlan | null {
  const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
  for (let a = 0; a < Math.PI; a += 0.2) {
    const dir = { x: Math.cos(a), y: Math.sin(a) };
    const from = add(town.center, scale(dir, -town.radius * 0.8));
    const to = add(town.center, scale(dir, -town.radius * 0.2));
    const plan = roadPlan(game, from, to);
    if (plan.ok && plan.demolish.length) return plan;
  }
  return null;
}

describe('Снос рамкой', () => {
  it('сносит дороги и дома внутри рамки одним шагом, Ctrl+Z возвращает', () => {
    const game = new Game(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const a = { x: town.center.x - 120, y: town.center.y - 120 };
    const b = { x: town.center.x + 120, y: town.center.y + 120 };
    const c = game.areaContents(a, b);
    expect(c.corridors.length).toBeGreaterThan(0);
    expect(c.buildings.length).toBeGreaterThan(0);
    // Ратуша не сносится.
    expect(c.buildings.some((x) => x.kind === 'landmark')).toBe(false);
    const corridors = game.roads.net.corridors.size;
    const houses = town.buildings.length;
    expect(game.bulldozeArea(a, b)).toBe(true);
    // Внутри рамки дорог не осталось (задетые краем — обрезаны по ней).
    const inner = (p: Vec) => p.x > a.x + 3 && p.x < b.x - 3 && p.y > a.y + 3 && p.y < b.y - 3;
    for (const x of game.roads.net.corridors.values()) expect(insideRuns(x, inner)).toEqual([]);
    expect(game.roads.net.problems()).toEqual([]);
    expect(town.buildings.length).toBe(houses - c.buildings.filter((x) => x.townId === town.id).length);
    expect(game.undo()).toBe('снос области');
    expect(game.roads.net.corridors.size).toBe(corridors);
    expect(town.buildings.length).toBe(houses);
  });

  it('длинная дорога, задетая рамкой, режется по её краю: снаружи остаются тупики', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
    let from: Vec | null = null;
    for (let y = 400; y < game.terrain.height - 400 && !from; y += 120) {
      for (let x = 300; x < game.terrain.width - 900 && !from; x += 160) {
        if (road(game, { free: { x, y } }, { free: { x: x + 600, y } })) from = { x, y };
      }
    }
    expect(from).not.toBeNull();
    const f = from!;
    const box = { a: { x: f.x + 200, y: f.y - 50 }, b: { x: f.x + 350, y: f.y + 50 } };
    const c = game.areaContents(box.a, box.b);
    expect(c.corridors).toHaveLength(1);
    expect(c.refund).toBeGreaterThan(0);
    expect(game.bulldozeArea(box.a, box.b)).toBe(true);
    const net = game.roads.net;
    const ends = [...net.nodes.values()].filter((n) => net.isDeadEnd(n) && Math.abs(n.pos.y - f.y) < 1).map((n) => Math.round(n.pos.x - f.x)).sort((x, y) => x - y);
    expect(ends).toEqual([0, 200, 350, 600]);
    expect(net.problems()).toEqual([]);
  });
});

describe('Отмена развязки', () => {
  it('Ctrl+Z отменяет развязку, даже если город успел сам проложить улицу', () => {
    const game = new Game(7);
    const before = game.roads.net.corridors.size;
    let built = false;
    for (let y = 800; y < game.terrain.height - 800 && !built; y += 200) {
      for (let x = 800; x < game.terrain.width - 800 && !built; x += 200) {
        const plan = game.templatePlan({ x, y }, 14, { kind: 'diamond', angle: 0, trunk: { cls: 'motorway', lanesF: 2, lanesB: 2 } });
        if (plan.ok) built = game.buildTemplate(plan, 'развязка «ромб»') === null;
      }
    }
    expect(built).toBe(true);
    const withTemplate = game.roads.net.corridors.size;
    expect(withTemplate).toBeGreaterThan(before);
    // Город растёт сам и прокладывает улицу.
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    town.growthAcc = 400;
    (game as unknown as { growTown(t: unknown): void }).growTown(town);
    expect(game.roads.net.corridors.size).toBeGreaterThan(withTemplate);
    expect(game.undo()).toBe('развязка «ромб»');
    expect(game.roads.net.corridors.size).toBe(before);
    // Ни один дом не остался без своей дороги.
    for (const t of game.towns) for (const b of t.buildings) expect(game.roads.net.nodes.has(b.anchor)).toBe(true);
  });

  it('выключатель в городе запрещает прокладывать улицы', () => {
    const game = new Game(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    town.autoStreets = false;
    const corridors = game.roads.net.corridors.size;
    town.growthAcc = 400;
    (game as unknown as { growTown(t: unknown): void }).growTown(town);
    expect(game.roads.net.corridors.size).toBe(corridors);
  });
});

describe('Отмена строительства', () => {
  it('Ctrl+Z возвращает дорогу, снесённые дома и деньги', () => {
    const game = new Game(7);
    runSeconds(game, 10);
    const plan = throughTown(game);
    expect(plan).not.toBeNull();
    const corridors = game.roads.net.corridors.size;
    const houses = game.towns.reduce((s, t) => s + t.buildings.length, 0);
    const money = game.money;
    game.checkpoint('дорога');
    expect(game.roadBuilder.apply(plan!)).toBe(true);
    game.commit();
    expect(game.money).toBeLessThan(money);
    expect(game.towns.reduce((s, t) => s + t.buildings.length, 0)).toBeLessThan(houses);
    expect(game.undo()).toBe('дорога');
    expect(game.roads.net.corridors.size).toBe(corridors);
    expect(game.towns.reduce((s, t) => s + t.buildings.length, 0)).toBe(houses);
    expect(game.money).toBe(money);
    // Жизнь продолжается: машины ездят по восстановленной сети, у каждого дома есть своя дорога.
    for (const t of game.towns) for (const b of t.buildings) expect(game.roads.net.nodes.has(b.anchor)).toBe(true);
    runSeconds(game, 20);
    expect(game.citizenCars).toBe(game.traffic.vehicles.size);
    expect(game.citizenCars).toBeGreaterThan(0);
  });

  it('пустое действие не занимает место в истории, станция отменяется', () => {
    const game = new Game(7);
    game.checkpoint('снос');
    game.commit();
    expect(game.canUndo).toBe(false);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    let placed = false;
    for (const seg of townStreets(game, town.id)) {
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
        expect(game.roads.net.nodes.has(st.nodeId)).toBe(false);
        break;
      }
    }
    expect(placed).toBe(true);
  });
});
