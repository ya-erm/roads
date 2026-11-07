import { describe, expect, it } from 'vitest';
import { runSeconds } from '../game/testkit';
import { buildConstructionScene } from './construction';

describe('Тестовая страница /test/construction', { timeout: 60_000 }, () => {
  it('сцена строится целиком: все проекты заложены, у каждого — своя база с бригадой, мост и тоннель — сооружения', () => {
    const scene = buildConstructionScene();
    expect(scene.errors).toEqual([]);
    const { game } = scene;
    expect(game.buildMode).toBe(true);
    expect(scene.projects.map((p) => p.key)).toEqual(['street', 'avenue', 'motorway', 'hill', 'junctions', 'tunnel', 'bridge']);
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

  it('бригады сами доезжают до своих проектов; через 60 с часть проектов готова и открыта, к 5 минутам — все', () => {
    const scene = buildConstructionScene();
    const { game } = scene;
    const crews = game.construction.crews;
    const street = scene.projects.find((p) => p.key === 'street')!;
    const streetIds = [...game.roads.net.corridors.values()].filter((c) => c.build?.project === street.project).map((c) => c.id);
    // Пока строится — по нему не ездят.
    for (const id of streetIds) expect(game.roads.graph.corridorLinks(id)).toHaveLength(0);
    runSeconds(game, 20);
    // Каждая бригада — на своём проекте (своей базы).
    for (const p of scene.projects) expect(crews.working(p.project!).map((b) => b.base), p.name).toEqual([p.base]);
    runSeconds(game, 40);
    const done = scene.projects.filter((p) => !game.construction.projects.has(p.project!));
    expect(done.map((p) => p.key)).toEqual(expect.arrayContaining(['street', 'hill']));
    expect(done.length).toBeLessThan(scene.projects.length);
    // Готовое — открыто для движения.
    for (const id of streetIds) {
      expect(game.roads.net.corridors.get(id)?.build).toBeUndefined();
      expect(game.roads.graph.corridorLinks(id).length).toBeGreaterThan(0);
    }
    runSeconds(game, 240);
    expect(game.construction.projects.size).toBe(0);
    expect([...game.roads.net.corridors.values()].filter((c) => c.build)).toEqual([]);
    expect(game.roads.net.problems()).toEqual([]);
  });
});
