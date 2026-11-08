import { describe, expect, it } from 'vitest';
import { runSeconds } from '../game/testkit';
import { buildConstructionScene } from './construction';

describe('Тестовая страница /test/construction', { timeout: 60_000 }, () => {
  it('сцена строится целиком: все проекты заложены, у каждого — своя база с бригадой, мост и тоннель — сооружения', () => {
    const scene = buildConstructionScene();
    expect(scene.errors).toEqual([]);
    const { game } = scene;
    expect(game.buildMode).toBe(true);
    expect(scene.projects.map((p) => p.key)).toEqual(['street', 'avenue', 'motorway', 'hill', 'junctions', 'tunnel', 'bridge', 'rail']);
    // Ж/д проект — пути сети путей, а не полотна дорог; между вокзалами — линия с поездом.
    const rail = scene.projects.find((p) => p.key === 'rail')!;
    expect(scene.game.construction.projects.get(rail.project!)?.rail).toBe(true);
    expect(scene.game.construction.segmentsOf(rail.project!).length).toBeGreaterThan(0);
    expect(scene.game.lines.get(scene.lines.rail)?.vehicles).toHaveLength(1);
    const crews = game.construction.crews;
    for (const p of scene.projects) {
      expect(p.project, p.name).not.toBeNull();
      expect(game.construction.projects.has(p.project!), p.name).toBe(true);
      expect(p.base, p.name).not.toBeNull();
      expect(crews.of(p.base!).length, p.name).toBe(1);
      expect(game.baseName(p.base!)).toBe(p.name);
    }
    expect(game.terrain.hasRelief).toBe(true);
    expect(game.terrain.rivers).toHaveLength(1);
    expect(game.industries).toHaveLength(0);
    const net = game.roads.net;
    const of = (key: string) => [...net.corridors.values()].filter((c) => c.build?.project === scene.projects.find((p) => p.key === key)!.project);
    const levels = (key: string) => of(key).flatMap((c) => [net.node(c.a).level, net.node(c.b).level]);
    expect(levels('bridge').some((l) => l > 0)).toBe(true);
    expect(levels('tunnel').some((l) => l < 0)).toBe(true);
    // Готовые поперечные улицы режут проект на три участка.
    expect(of('junctions')).toHaveLength(3);
    // Денег на стройку сцены не ушло: счёт — как в настройках.
    expect(game.money).toBe(game.settings.money);
  });

  it('бригады сами доезжают до своих проектов; через 75 с часть проектов готова и открыта, к 6 минутам — все', () => {
    const scene = buildConstructionScene();
    const { game } = scene;
    const crews = game.construction.crews;
    const street = scene.projects.find((p) => p.key === 'street')!;
    const streetIds = [...game.roads.net.corridors.values()].filter((c) => c.build?.project === street.project).map((c) => c.id);
    // Пока строится — по нему не ездят.
    for (const id of streetIds) expect(game.roads.graph.corridorLinks(id)).toHaveLength(0);
    // Бригада едет колонной из трёх машин (отсыпка, покрытие, разметка): у участка на земле каждая сходит на стройку и
    // берётся за свой этап, как доехала, у моста и тоннеля — когда доехала последняя: по подъезду в 160 м — секунд 20.
    runSeconds(game, 25);
    // Каждая бригада — на своём проекте (своей базы).
    for (const p of scene.projects) expect(crews.working(p.project!).map((b) => b.base), p.name).toEqual([p.base]);
    // Поезд ж/д ряда стоит на своём вокзале: путь ко второму ещё строится.
    const train = [...game.rail.trains.values()][0];
    expect(train.moving).toBe(false);
    runSeconds(game, 50);
    const done = scene.projects.filter((p) => !game.construction.projects.has(p.project!));
    expect(done.map((p) => p.key)).toEqual(expect.arrayContaining(['street', 'hill']));
    expect(done.length).toBeLessThan(scene.projects.length);
    // Готовое — открыто для движения.
    for (const id of streetIds) {
      expect(game.roads.net.corridors.get(id)?.build).toBeUndefined();
      expect(game.roads.graph.corridorLinks(id).length).toBeGreaterThan(0);
    }
    // Мост и тоннель — из коротких участков: на каждом разметка кончает на два интервала колонны позже отсыпки.
    runSeconds(game, 285);
    expect(game.construction.projects.size).toBe(0);
    expect([...game.roads.net.corridors.values()].filter((c) => c.build)).toEqual([]);
    expect([...game.net.segments.values()].filter((s) => s.build)).toEqual([]);
    expect(game.roads.net.problems()).toEqual([]);
  });
});
