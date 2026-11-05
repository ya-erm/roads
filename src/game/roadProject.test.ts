import { describe, expect, it } from 'vitest';
import { arcCubic, bezPoint, straightCubic } from '../core/bezier';
import { add, dist, dot, norm, sub, Vec } from '../core/vec';
import { RAIL_SPEC, type RoadSpec } from '../world/roadTypes';
import { Game } from './game';
import {
  addNode,
  addSeg,
  autoLevelsAlong,
  bendSeg,
  buildProject,
  copyProject,
  draftCurve,
  emptyProject,
  handleOf,
  jointKind,
  mergeNode,
  moveHandle,
  moveNode,
  nodeOf,
  Project,
  projectCurveSigns,
  projectPlan,
  removeNode,
  segCurve,
  segsAt,
  smoothJoint,
  smoothPair,
  splitSeg,
  staleSignCorridors,
} from './roadProject';
import { road } from './testkit';

const STREET_SPEC: RoadSpec = { cls: 'street', lanesF: 1, lanesB: 1 };

function dryGame(): Game {
  return new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 5_000_000, water: 'dry' });
}

/** Цепочка проекта через точки: первый участок прямой, следующие — дугой, продолжая предыдущий. */
function chain(pts: Vec[], spec: RoadSpec = STREET_SPEC, firstDir: Vec | null = null): Project {
  const p = emptyProject();
  let prev = addNode(p, pts[0]);
  let dir: Vec | null = firstDir;
  for (const q of pts.slice(1)) {
    const n = addNode(p, q);
    const curve = draftCurve(prev.pos, q, 'arc', dir, null);
    addSeg(p, prev.id, n.id, curve, spec);
    dir = norm(sub(curve.p3, curve.p2));
    prev = n;
  }
  return p;
}

/** Свободное место, где проект по точкам pts (от origin) строится. */
function freeSpot(game: Game, kind: 'road' | 'rail', pts: Vec[], spec: RoadSpec): { origin: Vec; project: Project } {
  for (let y = 500; y < game.terrain.height - 600; y += 130) {
    for (let x = 400; x < game.terrain.width - 700; x += 170) {
      const project = chain(
        pts.map((q) => add(q, { x, y })),
        spec,
      );
      if (projectPlan(game, kind, project).ok) return { origin: { x, y }, project };
    }
  }
  throw new Error('Нет места для проекта');
}

describe('Проект: правка узлов и перьев', () => {
  it('узел тянет за собой свои перья, форма участка у другого конца прежняя', () => {
    const p = chain([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 350, y: 120 },
    ]);
    const mid = p.nodes[1];
    const [s1, s2] = p.segs;
    const before = { b: handleOf(p, s1, 'b').pos, a: handleOf(p, s2, 'a').pos, far: handleOf(p, s1, 'a').pos };
    moveNode(p, mid.id, { x: 210, y: 30 });
    expect(nodeOf(p, mid.id).pos).toEqual({ x: 210, y: 30 });
    expect(dist(handleOf(p, s1, 'b').pos, add(before.b, { x: 10, y: 30 }))).toBeLessThan(1e-9);
    expect(dist(handleOf(p, s2, 'a').pos, add(before.a, { x: 10, y: 30 }))).toBeLessThan(1e-9);
    expect(handleOf(p, s1, 'a').pos).toEqual(before.far);
  });

  it('в гладком узле перо соседа поворачивается следом, с Shift — излом', () => {
    const p = chain([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 400, y: 0 },
    ]);
    const mid = p.nodes[1].id;
    const [s1, s2] = p.segs;
    expect(smoothPair(p, mid)).not.toBeNull();
    const len2 = dist(handleOf(p, s2, 'a').pos, handleOf(p, s2, 'a').anchor);
    moveHandle(p, s1.id, 'b', { x: 150, y: -40 });
    const d1 = norm(sub(handleOf(p, s1, 'b').pos, { x: 200, y: 0 }));
    const d2 = norm(sub(handleOf(p, s2, 'a').pos, { x: 200, y: 0 }));
    expect(dot(d1, d2)).toBeCloseTo(-1, 6);
    expect(dist(handleOf(p, s2, 'a').pos, { x: 200, y: 0 })).toBeCloseTo(len2, 6);
    // Shift: только своё перо — узел становится изломом, сосед на месте.
    const was = handleOf(p, s2, 'a').pos;
    moveHandle(p, s1.id, 'b', { x: 180, y: 60 }, true);
    expect(handleOf(p, s2, 'a').pos).toEqual(was);
    expect(smoothPair(p, mid)).toBeNull();
    expect(jointKind(p, mid)).toBe('kink');
    // Излом обратно: перо без Shift — сосед снова на одной прямой (любым концом), длина его пера прежняя.
    const len2b = dist(handleOf(p, s2, 'a').pos, { x: 200, y: 0 });
    moveHandle(p, s2.id, 'a', { x: 260, y: 30 });
    expect(jointKind(p, mid)).toBe('smooth');
    const e1 = norm(sub(handleOf(p, s1, 'b').pos, { x: 200, y: 0 }));
    const e2 = norm(sub(handleOf(p, s2, 'a').pos, { x: 200, y: 0 }));
    expect(dot(e1, e2)).toBeCloseTo(-1, 9);
    expect(dist(handleOf(p, s2, 'a').pos, { x: 200, y: 0 })).toBeCloseTo(dist({ x: 260, y: 30 }, { x: 200, y: 0 }), 9);
    expect(len2b).toBeGreaterThan(0);
    // Конец ветки — не стык двух участков.
    expect(jointKind(p, p.nodes[0].id)).toBeNull();
  });

  it('середину участка выгибают через точку, гладкий стык остаётся гладким', () => {
    const p = chain([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 400, y: 0 },
    ]);
    const [s1, s2] = p.segs;
    bendSeg(p, s1.id, { x: 100, y: 50 });
    // В стыке направление пера прежнее: соседний участок продолжает выгнутый без излома.
    expect(smoothPair(p, p.nodes[1].id)).not.toBeNull();
    expect(handleOf(p, s1, 'b').pos.y).toBeCloseTo(0, 9);
    expect(handleOf(p, s1, 'a').pos.y).toBeGreaterThan(10);
    expect(bezPoint(segCurve(p, s2), 0).x).toBe(200);
    // Без соседа участок проходит ровно через точку изгиба.
    const lone = chain([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ]);
    bendSeg(lone, lone.segs[0].id, { x: 100, y: 50 });
    expect(dist(bezPoint(segCurve(lone, lone.segs[0]), 0.5), { x: 100, y: 50 })).toBeLessThan(1e-9);
  });

  it('узел на участке делит его на два той же формы; удаление и слияние узлов', () => {
    const p = chain(
      [
        { x: 0, y: 0 },
        { x: 300, y: 100 },
      ],
      STREET_SPEC,
      { x: 1, y: 0 },
    );
    const whole = segCurve(p, p.segs[0]);
    const n = splitSeg(p, p.segs[0].id, 0.5)!;
    expect(p.segs.length).toBe(2);
    expect(dist(n.pos, bezPoint(whole, 0.5))).toBeLessThan(1e-9);
    expect(dist(bezPoint(segCurve(p, p.segs[0]), 0.5), bezPoint(whole, 0.25))).toBeLessThan(1e-6);
    expect(smoothPair(p, n.id)).not.toBeNull();
    // Удалили узел посередине — оба участка уходят, концы без участков — тоже.
    const q = copyProject(p);
    removeNode(q, n.id);
    expect(q.segs.length).toBe(0);
    expect(q.nodes.length).toBe(0);
    // Конец сливается с другим узлом — замкнули в треугольник.
    const t = chain([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 100, y: 150 },
    ]);
    const last = addNode(t, { x: 4, y: 3 });
    addSeg(t, t.nodes[2].id, last.id, straightCubic(t.nodes[2].pos, last.pos), STREET_SPEC);
    mergeNode(t, last.id, t.nodes[0].id);
    expect(t.nodes.length).toBe(3);
    expect(segsAt(t, t.nodes[0].id).length).toBe(2);
  });

  it('дуга между двумя концами — гладко с обеих сторон; кривая начинается по продолжению', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 200, y: 100 };
    const east = { x: 1, y: 0 };
    // Продолжаем то, что пришло в a, и приходим в b так, чтобы дальше ехать на восток (там уже участок).
    const both = draftCurve(a, b, 'arc', east, null, east);
    expect(dot(norm(sub(both.p1, both.p0)), east)).toBeCloseTo(1, 9);
    expect(dot(norm(sub(both.p3, both.p2)), east)).toBeCloseTo(1, 9);
    // Только конец: дуга, развёрнутая от конца, — приходит по направлению.
    const end = draftCurve(a, b, 'arc', null, null, east);
    expect(dot(norm(sub(end.p3, end.p2)), east)).toBeCloseTo(1, 9);
    // Прийти «задом наперёд» нельзя — там излом, а не петля.
    const back = draftCurve(a, b, 'arc', null, null, { x: -1, y: 0 });
    expect(back).toEqual(straightCubic(a, b));
    // Кривая: перо в начале — по продолжению, той же длины, что к точке изгиба.
    const curve = draftCurve(a, b, 'curve', east, { x: 100, y: -60 }, null);
    expect(dot(norm(sub(curve.p1, curve.p0)), east)).toBeCloseTo(1, 9);
    expect(dist(curve.p0, curve.p1)).toBeCloseTo((dist(a, { x: 100, y: -60 }) * 2) / 3, 9);
    // Прямая остаётся прямой.
    expect(draftCurve(a, b, 'straight', east, null, east)).toEqual(straightCubic(a, b));
  });

  it('два конца, сведённые в один узел, — стык гладкий; разворот не трогаем', () => {
    const p = emptyProject();
    const A = addNode(p, { x: 0, y: 0 });
    const B = addNode(p, { x: 200, y: 0 });
    const C = addNode(p, { x: 200, y: 0 });
    const D = addNode(p, { x: 400, y: 200 });
    const ab = addSeg(p, A.id, B.id, straightCubic(A.pos, B.pos), STREET_SPEC)!;
    addSeg(p, C.id, D.id, straightCubic(C.pos, D.pos), STREET_SPEC);
    mergeNode(p, B.id, C.id);
    expect(smoothPair(p, C.id)).toBeNull();
    expect(smoothJoint(p, C.id, ab.id)).toBe(true);
    expect(smoothPair(p, C.id)).not.toBeNull();
    // Длина пера прежняя — меняется только направление.
    expect(dist(handleOf(p, ab, 'b').pos, nodeOf(p, C.id).pos)).toBeCloseTo(200 / 3, 6);
    // Перья в одну сторону (разворот) — не стык: остаётся как есть.
    const q = emptyProject();
    const m = addNode(q, { x: 0, y: 0 });
    const x = addNode(q, { x: 200, y: 0 });
    const y = addNode(q, { x: 200, y: 40 });
    const s1 = addSeg(q, m.id, x.id, straightCubic(m.pos, x.pos), STREET_SPEC)!;
    addSeg(q, m.id, y.id, straightCubic(m.pos, y.pos), STREET_SPEC);
    expect(smoothJoint(q, m.id, s1.id)).toBe(false);
  });

  it('знаки скорости на поворотах проекта — перед изгибом, медленнее дороги, в обе стороны', () => {
    const highway: RoadSpec = { cls: 'highway', lanesF: 1, lanesB: 1 };
    // Дуга радиусом около 100 м: 90 км/ч на ней не проехать.
    const p = emptyProject();
    const a = addNode(p, { x: 0, y: 0 });
    const b = addNode(p, { x: 100, y: 100 });
    addSeg(p, a.id, b.id, arcCubic(a.pos, { x: 1, y: 0 }, b.pos)!, highway);
    const signs = projectCurveSigns(p);
    expect(signs.length).toBe(2);
    for (const s of signs) {
      expect(s.kmh).toBeLessThan(90);
      expect(s.kmh).toBeGreaterThanOrEqual(50);
    }
    // По ходу — от начала, навстречу — от конца.
    expect(dot(signs[0].dir, { x: 1, y: 0 })).toBeGreaterThan(0.9);
    expect(dot(signs[1].dir, { x: 0, y: -1 })).toBeGreaterThan(0.9);
    // Прямая — без знаков; путь — без знаков.
    expect(projectCurveSigns(chain([{ x: 0, y: 0 }, { x: 300, y: 0 }], highway))).toEqual([]);
    const rail = emptyProject();
    const r0 = addNode(rail, { x: 0, y: 0 });
    const r1 = addNode(rail, { x: 100, y: 100 });
    addSeg(rail, r0.id, r1.id, arcCubic(r0.pos, { x: 1, y: 0 }, r1.pos)!, RAIL_SPEC);
    expect(projectCurveSigns(rail)).toEqual([]);
  });

  it('форма нового участка: дуга продолжает направление, кривая — через точку изгиба', () => {
    const arc = draftCurve({ x: 0, y: 0 }, { x: 100, y: 60 }, 'arc', { x: 1, y: 0 }, null);
    expect(arc).toEqual(arcCubic({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 100, y: 60 }));
    const curve = draftCurve({ x: 0, y: 0 }, { x: 100, y: 0 }, 'curve', null, { x: 50, y: 50 });
    expect(bezPoint(curve, 0.5).y).toBeCloseTo(25, 6);
    expect(draftCurve({ x: 0, y: 0 }, { x: 90, y: 0 }, 'arc', null, null)).toEqual(straightCubic({ x: 0, y: 0 }, { x: 90, y: 0 }));
  });
});

describe('Проект дороги в игре', () => {
  const PTS = [
    { x: 0, y: 0 },
    { x: 220, y: 0 },
    { x: 400, y: 140 },
  ];

  it('проект не тратит денег; «Построить» — дороги по форме проекта, цена как в плане, Ctrl+Z — назад', () => {
    const game = dryGame();
    const { project } = freeSpot(game, 'road', PTS, STREET_SPEC);
    const money = game.money;
    const corridors = game.roads.net.corridors.size;
    const plan = projectPlan(game, 'road', project);
    expect(plan.ok).toBe(true);
    expect(plan.cost).toBeGreaterThan(0);
    expect(plan.bad).toBeNull();
    expect(game.money).toBe(money);
    expect(game.roads.net.corridors.size).toBe(corridors);

    expect(buildProject(game, 'road', project)).toBeNull();
    expect(game.money).toBe(money - plan.cost);
    const net = game.roads.net;
    expect(net.corridors.size).toBe(corridors + 2);
    // Узел посередине — гладкий стык (дуга продолжает прямую), кривые — как в проекте.
    const mid = net.nodesNear(project.nodes[1].pos, 0.5)[0];
    expect(mid.kind).toBe('seam');
    for (const s of project.segs) {
      const want = segCurve(project, s);
      const c = [...net.corridors.values()].find((x) => dist(x.curve.p0, want.p0) < 0.5 && dist(x.curve.p3, want.p3) < 0.5)!;
      expect(c).toBeDefined();
      expect(dist(bezPoint(c.curve, 0.5), bezPoint(want, 0.5))).toBeLessThan(0.5);
    }
    expect(net.problems()).toEqual([]);

    expect(game.undo()).toBe('проект дороги');
    expect(game.money).toBe(money);
    expect(game.roads.net.corridors.size).toBe(corridors);
  });

  it('перенесённый узел и перо меняют дорогу, которая построится', () => {
    const game = dryGame();
    const { project } = freeSpot(game, 'road', PTS, STREET_SPEC);
    const mid = project.nodes[1];
    const to = add(mid.pos, { x: 10, y: -40 });
    moveNode(project, mid.id, to);
    moveHandle(project, project.segs[1].id, 'b', add(nodeOf(project, project.nodes[2].id).pos, { x: -60, y: -10 }), true);
    const plan = projectPlan(game, 'road', project);
    expect(plan.ok).toBe(true);
    const net = plan.road!.net!;
    expect(net.nodesNear(to, 0.5).length).toBe(1);
    const want = segCurve(project, project.segs[1]);
    const c = [...net.corridors.values()].find((x) => dist(x.curve.p3, want.p3) < 0.5)!;
    expect(dist(c.curve.p2, want.p2)).toBeLessThan(0.5);
  });

  it('примкнувший к дороге узел — перекрёсток на ней', () => {
    const game = dryGame();
    const { origin } = freeSpot(
      game,
      'road',
      [
        { x: 0, y: 0 },
        { x: 400, y: 0 },
        { x: 400, y: 300 },
      ],
      STREET_SPEC,
    );
    expect(road(game, { free: origin }, { free: add(origin, { x: 400, y: 0 }) })).toBe(true);
    const p = emptyProject();
    const a = addNode(p, add(origin, { x: 200, y: 0 }), 0, true);
    const b = addNode(p, add(origin, { x: 200, y: 220 }));
    addSeg(p, a.id, b.id, straightCubic(a.pos, b.pos), STREET_SPEC);
    // Дорогу проект только разрезает перекрёстком — её знаки остаются верными (не «старые»).
    expect(staleSignCorridors(game.roads.net, projectPlan(game, 'road', p).road!.net!).size).toBe(0);
    expect(buildProject(game, 'road', p)).toBeNull();
    const j = game.roads.net.nodesNear(a.pos, 1)[0];
    expect(j.kind).toBe('junction');
    expect(j.corridors.length).toBe(3);
  });

  it('участок, на котором не построить, — найден; до него проект виден как есть; денег мало — не беда участка', () => {
    const game = dryGame();
    const { project } = freeSpot(game, 'road', PTS, STREET_SPEC);
    const last = project.segs[1];
    // Перья накрест — петля круче допустимого радиуса.
    moveHandle(project, last.id, 'a', add(nodeOf(project, last.b).pos, { x: 60, y: -150 }), true);
    moveHandle(project, last.id, 'b', add(nodeOf(project, last.a).pos, { x: -60, y: -150 }), true);
    const plan = projectPlan(game, 'road', project);
    expect(plan.ok).toBe(false);
    expect(plan.bad).toBe(last.id);
    expect(plan.road?.ok).toBe(true);
    expect(buildProject(game, 'road', project)).toBe(plan.reason);

    const fine = freeSpot(game, 'road', PTS, STREET_SPEC).project;
    game.money = -1e9;
    const poor = projectPlan(game, 'road', fine);
    expect(poor.ok).toBe(false);
    expect(poor.reason).toBe('Не хватает денег');
    expect(poor.bad).toBeNull();
    expect(buildProject(game, 'road', fine)).toBe('Не хватает денег');
  });
});

describe('Проект пути в игре', () => {
  const PTS = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 600, y: 100 },
  ];

  it('пути проекта кладутся одним шагом, общий узел — один; цена как в плане', () => {
    const game = dryGame();
    const { project } = freeSpot(game, 'rail', PTS, RAIL_SPEC);
    const money = game.money;
    const segs = game.net.segments.size;
    const plan = projectPlan(game, 'rail', project);
    expect(plan.ok).toBe(true);
    expect(plan.rails.size).toBe(2);
    expect(game.net.segments.size).toBe(segs);
    expect(buildProject(game, 'rail', project)).toBeNull();
    expect(game.net.segments.size).toBe(segs + 2);
    expect(game.money).toBe(money - plan.cost);
    const mid = game.net.findNodeNear(project.nodes[1].pos, 0.5)!;
    expect(mid.segments.length).toBe(2);
    expect(game.undo()).toBe('проект пути');
    expect(game.net.segments.size).toBe(segs);
    expect(game.money).toBe(money);
  });

  it('излом пути в узле проекта — нельзя, и не строится ни один участок', () => {
    const game = dryGame();
    const { project } = freeSpot(game, 'rail', PTS, RAIL_SPEC);
    const second = project.segs[1];
    const mid = nodeOf(project, second.a);
    // Второй участок уходит под прямым углом.
    moveNode(project, second.b, add(mid.pos, { x: 0, y: 300 }));
    moveHandle(project, second.id, 'a', add(mid.pos, { x: 0, y: 100 }), true);
    moveHandle(project, second.id, 'b', add(mid.pos, { x: 0, y: 200 }), true);
    const segs = game.net.segments.size;
    const money = game.money;
    const plan = projectPlan(game, 'rail', project);
    expect(plan.ok).toBe(false);
    expect(plan.bad).toBe(second.id);
    expect(buildProject(game, 'rail', project)).toBe(plan.reason);
    expect(game.net.segments.size).toBe(segs);
    expect(game.money).toBe(money);
  });
});

describe('«Авто» на участке проекта', () => {
  const line = straightCubic({ x: 0, y: 0 }, { x: 800, y: 0 });

  it('глубокая лощина посередине — мост с пандусами, на ровном — без смен высоты', () => {
    const valley = (p: Vec) => (p.x > 250 && p.x < 550 ? -40 : 0);
    const res = autoLevelsAlong(line, valley, { level: 0, fixed: true }, { level: 0, fixed: true });
    if ('reason' in res) throw new Error(res.reason);
    expect(res.levels.some((q) => q.level === 1)).toBe(true);
    expect(res.levels.every((q, i) => i === 0 || q.at >= res.levels[i - 1].at)).toBe(true);
    expect(res.start).toBe(0);
    expect(res.end).toBe(0);
    const flat = autoLevelsAlong(line, () => 0, { level: 0, fixed: false }, { level: 0, fixed: false });
    expect('reason' in flat ? null : flat.levels).toEqual([]);
  });

  it('подъём круче допустимого — причина', () => {
    const res = autoLevelsAlong(straightCubic({ x: 0, y: 0 }, { x: 100, y: 0 }), () => 0, { level: 0, fixed: true }, { level: 1, fixed: true });
    expect('reason' in res).toBe(false);
    const steep = autoLevelsAlong(straightCubic({ x: 0, y: 0 }, { x: 100, y: 0 }), (p) => p.x, { level: 0, fixed: true }, { level: 0, fixed: true });
    expect('reason' in steep && steep.reason).toMatch(/Подъём/);
  });
});
