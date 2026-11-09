import { describe, expect, it } from 'vitest';
import { add, scale, Vec } from '../core/vec';
import { Game } from './game';
import type { RoadPlan } from './roadbuild';
import { anchorOf, clearStrip, freshGame, road, roadPlan, runSeconds, STREET, townStreets, withoutCitizens } from './testkit';

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

/** Что построено: полотна дорог, пути, станции, дома по городам. */
function built(game: Game) {
  return {
    corridors: [...game.roads.net.corridors.keys()].sort((a, b) => a - b),
    rails: game.net.segments.size,
    stations: [...game.stations.keys()].sort((a, b) => a - b),
    houses: game.towns.map((t) => t.buildings.map((b) => b.id).sort((a, b) => a - b)),
  };
}

const kinds = (game: Game, k: string) => game.journal.entries.filter((e) => e.k === k);

/** Свободное место под прямую длиной len: ни дорог, ни путей, ни домов рядом. */
function field(game: Game, len = 600): Vec {
  for (let y = 400; y < game.terrain.height - 400; y += 120) {
    for (let x = 300; x < game.terrain.width - len - 300; x += 160) {
      if (!clearStrip(game, { x, y }, { x: x + len, y }, 200)) continue;
      if (roadPlan(game, { free: { x, y } }, { free: { x: x + len, y } }).ok && !game.roads.net.corridorsNear({ x: x + len / 2, y }, len).length) return { x, y };
    }
  }
  throw new Error('Нет места');
}

describe('Повтор отменённой стройки (Ctrl+Y)', () => {
  it('дорога со сносом домов: повтор строит её снова, сносит те же дома и списывает те же деньги — один раз', () => {
    const game = freshGame(7);
    runSeconds(game, 10);
    const plan = throughTown(game);
    expect(plan).not.toBeNull();
    const before = built(game);
    game.checkpoint('дорога');
    expect(game.roadBuilder.apply(plan!)).toBe(true);
    game.commit();
    const after = built(game);
    const moneyAfter = game.money;
    const ledgerAfter = game.ledger.build;
    const expensesAfter = game.expensesMonth;
    expect(game.canRedo).toBe(false);

    expect(game.undo()).toBe('дорога');
    expect(built(game)).toEqual(before);
    expect(game.money).toBeGreaterThan(moneyAfter);
    expect(game.canRedo).toBe(true);

    expect(game.redo()).toBe('дорога');
    expect(built(game)).toEqual(after);
    expect(game.money).toBe(moneyAfter);
    expect(game.ledger.build).toBe(ledgerAfter);
    expect(game.expensesMonth).toBe(expensesAfter);
    expect(game.canRedo).toBe(false);
    expect(game.redo()).toBeNull();
    // Журнал: одна стройка, одна отмена, один повтор (а не вторая стройка) — деньги по нему те же.
    expect(kinds(game, 'build')).toHaveLength(1);
    expect(kinds(game, 'undo')).toHaveLength(1);
    expect(kinds(game, 'redo')).toHaveLength(1);
    expect(kinds(game, 'redo')[0]).toMatchObject({ what: 'дорога', $: kinds(game, 'build')[0].$ });
    expect(game.roads.net.problems()).toEqual([]);
    for (const t of game.towns) for (const b of t.buildings) expect(game.roads.net.nodes.has(b.anchor)).toBe(true);

    // Повторённое снова отменяется — и снова повторяется: туда-обратно сколько угодно.
    expect(game.undo()).toBe('дорога');
    expect(built(game)).toEqual(before);
    expect(game.redo()).toBe('дорога');
    expect(built(game)).toEqual(after);
    expect(game.money).toBe(moneyAfter);

    // Жизнь продолжается: машины ездят по восстановленной сети.
    runSeconds(game, 20);
    expect(game.citizenCars + game.serviceCars).toBe(game.traffic.vehicles.size);
  });

  it('несколько отмен подряд повторяются в обратном порядке', () => {
    const game = withoutCitizens(freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' }));
    const o = field(game, 900);
    const states = [built(game)];
    const money = [game.money];
    for (let i = 0; i < 3; i++) {
      game.checkpoint(`дорога ${i}`);
      expect(road(game, { free: add(o, { x: i * 300, y: 0 }) }, { free: add(o, { x: i * 300 + 300, y: 0 }) })).toBe(true);
      game.commit();
      states.push(built(game));
      money.push(game.money);
    }
    expect(game.undo()).toBe('дорога 2');
    expect(game.undo()).toBe('дорога 1');
    expect(game.undo()).toBe('дорога 0');
    expect(built(game)).toEqual(states[0]);
    expect(game.money).toBe(money[0]);
    expect(game.redo()).toBe('дорога 0');
    expect(built(game)).toEqual(states[1]);
    expect(game.money).toBe(money[1]);
    expect(game.redo()).toBe('дорога 1');
    expect(game.redo()).toBe('дорога 2');
    expect(built(game)).toEqual(states[3]);
    expect(game.money).toBe(money[3]);
    expect(game.redo()).toBeNull();
  });

  it('новое действие после отмены забывает повтор; пустое действие (клик без стройки) — нет', () => {
    const game = withoutCitizens(freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' }));
    const o = field(game, 900);
    game.checkpoint('первая');
    expect(road(game, { free: o }, { free: add(o, { x: 300, y: 0 }) })).toBe(true);
    game.commit();
    game.undo();
    expect(game.canRedo).toBe(true);
    // Ничего не построили — повтор на месте.
    game.checkpoint('снос');
    game.commit();
    expect(game.canRedo).toBe(true);
    // Построили другое — повторять первую уже нельзя.
    game.checkpoint('вторая');
    expect(road(game, { free: add(o, { x: 600, y: 0 }) }, { free: add(o, { x: 900, y: 0 }) })).toBe(true);
    game.commit();
    expect(game.canRedo).toBe(false);
    expect(game.redo()).toBeNull();
    expect(game.undo()).toBe('вторая');
  });

  it('откат неудавшегося действия (undo(false)) повторить нельзя', () => {
    const game = withoutCitizens(freshGame({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' }));
    const o = field(game);
    game.checkpoint('путь');
    expect(road(game, { free: o }, { free: add(o, { x: 300, y: 0 }) })).toBe(true);
    game.commit();
    expect(game.undo(false)).toBe('путь');
    expect(game.canRedo).toBe(false);
  });

  it('станция: повтор ставит её снова, отмена — снова убирает', () => {
    const game = freshGame(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    let done = false;
    for (const seg of townStreets(game, town.id)) {
      const p = seg.lut.pointAt(seg.length / 2);
      const t = seg.lut.tangentAt(seg.length / 2);
      game.checkpoint('станция');
      const st = game.placeStation({ x: p.x - t.y * 40, y: p.y + t.x * 40 }, 14);
      game.commit();
      if (!st) continue;
      const after = built(game);
      game.undo();
      expect(game.stations.size).toBe(0);
      expect(game.redo()).toBe('станция');
      expect(built(game)).toEqual(after);
      const back = game.stations.get(st.id)!;
      expect(back.nodeId).toBe(st.nodeId);
      expect(game.roads.net.nodes.has(back.nodeId)).toBe(true);
      expect(game.index.near(back.fp.center, 5).some((s) => s === back)).toBe(true);
      game.undo();
      expect(game.stations.size).toBe(0);
      expect(game.roads.net.nodes.has(st.nodeId)).toBe(false);
      done = true;
      break;
    }
    expect(done).toBe(true);
  });

  it('снос рамкой: повтор сносит те же дороги и дома', () => {
    const game = freshGame(7);
    const town = [...game.towns].sort((a, b) => b.population - a.population)[0];
    const a = { x: town.center.x - 120, y: town.center.y - 120 };
    const b = { x: town.center.x + 120, y: town.center.y + 120 };
    const before = built(game);
    expect(game.bulldozeArea(a, b)).toBe(true);
    const after = built(game);
    const money = game.money;
    expect(after.houses).not.toEqual(before.houses);
    game.undo();
    expect(built(game)).toEqual(before);
    expect(game.redo()).toBe('снос области');
    expect(built(game)).toEqual(after);
    expect(game.money).toBe(money);
    // Снесённых домов нет и в пространственном индексе.
    const gone = before.houses.flat().filter((id) => !after.houses.flat().includes(id));
    expect(gone.length).toBeGreaterThan(0);
    const near = game.index.near(town.center, 200).filter((s) => s.type === 'building').map((s) => s.id);
    for (const id of gone) expect(near).not.toContain(id);
  });

  it('режим «Со строительством»: повтор возвращает заложенный проект, и его снова можно отменить', () => {
    const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', construction: 'build' }));
    const o = field(game);
    const before = built(game);
    game.checkpoint('дорога');
    const plan = game.roadBuilder.road(anchorOf(game, { free: o }), anchorOf(game, { free: add(o, { x: 400, y: 0 }) }), STREET, { project: true });
    expect(plan.ok && game.roadBuilder.apply(plan)).toBe(true);
    game.commit();
    expect(game.construction.projects.size).toBe(1);
    const id = [...game.construction.projects.keys()][0];
    const after = built(game);
    game.undo();
    expect(game.construction.projects.size).toBe(0);
    expect(built(game)).toEqual(before);
    expect(game.redo()).toBe('дорога');
    expect(built(game)).toEqual(after);
    expect([...game.construction.projects.keys()]).toEqual([id]);
    // Проект ещё не начат — отмена убирает его целиком, как в первый раз.
    expect(game.undo()).toBe('дорога');
    expect(game.construction.projects.size).toBe(0);
    expect(built(game)).toEqual(before);
  });

  it('рельеф: повтор наносит те же мазки кисти и снова берёт за них деньги', () => {
    const game = withoutCitizens(new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry', relief: 'hills' }));
    expect(game.terrain.hasRelief).toBe(true);
    const o = field(game);
    const h0 = game.terrain.heightAt(o);
    game.checkpoint('рельеф');
    let ok = false;
    for (let i = 0; i < 4; i++) ok = game.terraform(o, 'raise', 60) || ok;
    game.commit();
    expect(ok).toBe(true);
    const h1 = game.terrain.heightAt(o);
    const edits = game.terrain.edits.length;
    const money = game.money;
    expect(h1).toBeGreaterThan(h0);
    game.undo();
    expect(game.terrain.heightAt(o)).toBeCloseTo(h0, 6);
    expect(game.redo()).toBe('рельеф');
    expect(game.terrain.edits.length).toBe(edits);
    expect(game.terrain.heightAt(o)).toBeCloseTo(h1, 6);
    expect(game.money).toBe(money);
    game.undo();
    expect(game.terrain.heightAt(o)).toBeCloseTo(h0, 6);
  });
});
