import { describe, expect, it } from 'vitest';
import { add, scale } from '../core/vec';
import { Game } from './game';
import type { RoadPlan } from './roadbuild';
import { roadPlan, townStreets } from './testkit';

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
    expect(game.roads.net.corridors.size).toBeLessThan(corridors);
    expect(town.buildings.length).toBe(houses - c.buildings.filter((x) => x.townId === town.id).length);
    expect(game.undo()).toBe('снос области');
    expect(game.roads.net.corridors.size).toBe(corridors);
    expect(town.buildings.length).toBe(houses);
  });
});

describe('Отмена развязки', () => {
  it.todo('Ctrl+Z отменяет развязку, даже если город успел сам проложить улицу — шаблоны развязок на полосах, этап 4.5');

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
