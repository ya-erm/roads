import { describe, expect, it } from 'vitest';
import { ECONOMY } from '../config';
import { straightCubic } from '../core/bezier';
import type { Vec } from '../core/vec';
import { projectMoneyWarning } from '../input/labels';
import type { BuildBase } from '../world/entities';
import type { WorldSettings } from '../world/settings';
import { advise } from './advisor';
import { Game } from './game';
import type { RoadPlan } from './roadbuild';
import { addNode, addSeg, buildProject, emptyProject, projectPlan } from './roadProject';
import { anchorOf, fieldSpot, road, runSeconds, STREET, withoutCitizens } from './testkit';

/**
 * «Со строительством» новая дорога — проект: платится по готовым метрам, поэтому «Не хватает денег» её не блокирует —
 * проект закладывается и стоит без денег. Сразу платится только снос домов и правки готовых дорог — на них деньги
 * по-прежнему проверяются. «Мгновенно» — как всегда: дороже денег — отказ.
 */

const WORLD: WorldSettings = { seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' };

const game = (construction?: 'build') => withoutCitizens(new Game({ ...WORLD, ...(construction ? { construction } : {}) }));

/** Свободный бюджет (до кредитного предела) — ровно budget: денег на счёте — budget + кредитный предел. */
function setBudget(g: Game, budget: number): void {
  g.money = ECONOMY.creditLimit + budget;
  expect(g.budget).toBe(budget);
}

const nodeAt = (g: Game, p: Vec) => [...g.roads.net.nodes.values()].find((n) => Math.hypot(n.pos.x - p.x, n.pos.y - p.y) < 1)?.id ?? null;

/** Дорога проектом, как рисует игрок инструментом «Дорога». */
const projectRoad = (g: Game, a: Vec, b: Vec): RoadPlan =>
  g.roadBuilder.road(anchorOf(g, nodeAt(g, a) ?? { free: a }), anchorOf(g, nodeAt(g, b) ?? { free: b }), STREET, { project: true });

/**
 * Поле с подъездом: готовая улица 90 м с запада к точке начала проекта, на её западном конце — ворота своей базы с
 * одной бригадой (других бригад нет). Ответ — начало проекта.
 */
function siteWithCrew(g: Game, len: number): Vec {
  const at = fieldSpot(g, len + 90);
  const gate = { x: at.x, y: at.y };
  const start = { x: at.x + 90, y: at.y };
  expect(road(g, { free: gate }, { free: start })).toBe(true);
  const crews = g.construction.crews;
  crews.brigades.clear();
  const base: BuildBase = { type: 'base', id: 990_000, fp: { center: { x: gate.x, y: gate.y - 30 }, w: 36, h: 24, angle: 0 }, nodeId: nodeAt(g, gate)! };
  crews.bases.set(base.id, base);
  crews.hire(base.id);
  return start;
}

/** Дорога через дом: первый дом, через который проходит дорога 400 м и который план сносит (денег вдоволь). */
function throughHouse(g: Game, project: boolean): { a: Vec; b: Vec; plan: RoadPlan } {
  for (const h of g.towns.flatMap((t) => t.buildings)) {
    if (h.kind === 'landmark') continue;
    const a = { x: h.fp.center.x - 200, y: h.fp.center.y };
    const b = { x: h.fp.center.x + 200, y: h.fp.center.y };
    const plan = project ? projectRoad(g, a, b) : g.roadBuilder.road(anchorOf(g, { free: a }), anchorOf(g, { free: b }), STREET);
    if (plan.ok && plan.demolish.length && (!project || plan.project)) return { a, b, plan };
  }
  throw new Error('нет дома под дорогой');
}

describe('«Со строительством»: проект дороже денег', () => {
  it('закладывается и в долгу до кредитного предела, стоит без денег — советник «Стройка стоит: не хватает денег»', () => {
    const g = game('build');
    const start = siteWithCrew(g, 600);
    const end = { x: start.x + 600, y: start.y };
    // Свободных денег меньше цены проекта и даже ниже нуля: платить сразу нечего — отказа нет.
    for (const budget of [5_000, 0, -5_000]) {
      setBudget(g, budget);
      const plan = projectRoad(g, start, end);
      expect(plan.ok, `бюджет ${budget}: ${plan.reason}`).toBe(true);
      expect(plan.cost).toBeLessThanOrEqual(0);
      expect(plan.project!.cost).toBeGreaterThan(budget);
      // Подпись — цена и жёлтая оговорка, а не красный отказ.
      expect(projectMoneyWarning(plan, g.budget)).toContain('стройка пойдёт по мере денег');
    }
    const money = g.money;
    expect(g.roadBuilder.apply(projectRoad(g, start, end))).toBe(true);
    expect(g.money).toBe(money);
    const info = g.construction.list()[0];
    expect(info).toBeDefined();
    // Бригада доезжает — денег нет, стройка стоит.
    runSeconds(g, 60);
    const now = g.construction.list()[0];
    expect(now.project.stalled).toBeDefined();
    expect(now.done).toBeLessThan(0.01);
    expect(advise(g).some((x) => x.kind === 'buildMoney' && x.title === 'Стройка стоит: не хватает денег')).toBe(true);
  });

  it('инструмент «Проект»: «Построить» не блокируется деньгами — проект закладывается', () => {
    const g = game('build');
    const a = fieldSpot(g, 700);
    const b = { x: a.x + 700, y: a.y };
    const p = emptyProject();
    const na = addNode(p, a);
    const nb = addNode(p, b);
    addSeg(p, na.id, nb.id, straightCubic(a, b), { cls: 'street', lanesF: 1, lanesB: 1 });
    setBudget(g, -1_000);
    const plan = projectPlan(g, 'road', p);
    expect(plan.ok, plan.reason).toBe(true);
    expect(plan.road?.project?.cost).toBeGreaterThan(0);
    expect(buildProject(g, 'road', p)).toBeNull();
    expect(g.construction.projects.size).toBe(1);
  });

  it('снос домов платится сразу: дороже свободных денег — «Не хватает денег»', () => {
    const g = game('build');
    const { a, b, plan } = throughHouse(g, true);
    // Сразу — только снос (и правки задетых улиц); сама дорога — проект, в cost её нет.
    expect(plan.cost).toBeGreaterThan(0);
    setBudget(g, plan.cost - 1);
    expect(projectRoad(g, a, b).reason).toBe('Не хватает денег');
    setBudget(g, -1_000);
    expect(projectRoad(g, a, b).reason).toBe('Не хватает денег');
    // На снос хватает, на весь проект — нет: закладывается.
    setBudget(g, plan.cost);
    const enough = projectRoad(g, a, b);
    expect(enough.ok, enough.reason).toBe(true);
    expect(enough.project!.cost + enough.cost).toBeGreaterThan(g.budget);
  });
});

describe('«Мгновенно»: дороже денег — отказ, как раньше', () => {
  it('дорога дороже свободных денег и в долгу — «Не хватает денег»', () => {
    const g = game();
    const a = fieldSpot(g, 600);
    const b = { x: a.x + 600, y: a.y };
    const plan = g.roadBuilder.road(anchorOf(g, { free: a }), anchorOf(g, { free: b }), STREET, { project: true });
    expect(plan.ok).toBe(true);
    expect(plan.project).toBeUndefined();
    for (const budget of [plan.cost - 1, 0, -5_000]) {
      setBudget(g, budget);
      const again = g.roadBuilder.road(anchorOf(g, { free: a }), anchorOf(g, { free: b }), STREET, { project: true });
      expect(again.reason, `бюджет ${budget}`).toBe('Не хватает денег');
    }
  });

  it('дорога через дом дороже денег — отказ', () => {
    const g = game();
    const { a, b, plan } = throughHouse(g, false);
    setBudget(g, plan.cost - 1);
    expect(g.roadBuilder.road(anchorOf(g, { free: a }), anchorOf(g, { free: b }), STREET).reason).toBe('Не хватает денег');
  });
});
