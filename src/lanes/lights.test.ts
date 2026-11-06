import { describe, expect, it } from 'vitest';
import type { Vehicle } from '../sim/vehicle';
import { GMove, LaneGraph } from './graph';
import {
  addPhase,
  autoGroups,
  editedAfter,
  movePhase,
  phaseRelations,
  phaseToggle,
  phaseTurnStates,
  removePhase,
  resolvePhases,
  signalHeads,
  stepGreen,
  toggleTurn,
  turnAt,
  turnClashes,
  turnKind,
  withLeftArrows,
} from './lights';
import { LaneDemand } from './demand';
import { LaneNet, twoWay } from './model';
import { findLaneRoute } from './routing';
import { LaneTraffic } from './traffic';

const CAR = { kind: 'car' as const, length: 7, width: 4, maxSpeed: 60, accel: 10, color: '#fff' };
const DT = 1 / 30;
type Arm = 'w' | 'e' | 'n' | 's';

/**
 * Перекрёсток улиц 1+1 со светофором в (0, 0): плечи на запад, восток, север и юг по 500 м (y вниз — север сверху).
 * Едущий с запада (на восток) поворачивает налево на север, направо на юг; встречный ему — с востока.
 */
function crossroads(setup?: (net: LaneNet, j: number, arms: Record<Arm, number>) => void) {
  const net = new LaneNet();
  const j = net.addJunction({ x: 0, y: 0 });
  j.control = 'lights';
  const arms = {} as Record<Arm, number>;
  const ends = {} as Record<Arm, number>;
  for (const [k, x, y] of [
    ['w', -500, 0],
    ['e', 500, 0],
    ['n', 0, -500],
    ['s', 0, 500],
  ] as const) {
    const end = net.addSeam({ x, y }, { x: Math.sign(x), y: Math.sign(y) });
    arms[k] = net.addCorridor(j.id, end.id, { cls: 'street', lanes: twoWay(1, 1) }).id;
    ends[k] = end.id;
  }
  setup?.(net, j.id, arms);
  const graph = new LaneGraph(net);
  const traffic = new LaneTraffic(graph, { onArrive: () => {}, onLost: () => {} });
  const L = graph.nodes.get(j.id)!.lights!;
  const route = (from: Arm, to: Arm) => findLaneRoute(graph, graph.outLinks.get(ends[from])!, ends[to])!;
  /** Манёвр в перекрёстке с плеча from на плечо to. */
  const move = (from: Arm, to: Arm): GMove => {
    const r = route(from, to);
    return graph.transitions.get(`${r[0]}>${r[1]}`)![0];
  };
  /** Машина с плеча from к плечу to: выезжает из тупика (или ставится на ahead м до стоп-линии). */
  const go = (from: Arm, to: Arm, ahead?: number, v = 0): Vehicle => {
    const r = route(from, to);
    if (ahead === undefined) return traffic.spawn({ ...CAR, targetNode: ends[to], route: r })!;
    const lane = graph.links.get(r[0])!.lanes[0];
    const pose = graph.lanePose(lane, lane.length - ahead);
    return traffic.place({ ...CAR, targetNode: ends[to] }, pose.pos, pose.dir, v)!;
  };
  /** Держать фазу с манёвром key (жёлтого не будет). */
  const hold = (key: string) => {
    L.phase = L.phases.findIndex((p) => p.moves.has(key));
    L.timer = 1e9;
    L.clearing = false;
  };
  return { net, graph, traffic, L, arms, ends, move, go, hold, j: j.id };
}

/** Повторяемый «случайный» поток. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function run(traffic: LaneTraffic, seconds: number, each?: (t: number) => void): void {
  for (let t = 0; t < seconds; t += DT) {
    traffic.step(DT);
    each?.(t);
  }
}

/** Самая низкая скорость машины от за `from` м до стоп-линии до выезда из перекрёстка. */
function minSpeedThrough(traffic: LaneTraffic, veh: Vehicle, from = 150) {
  let min = Infinity;
  return {
    sample() {
      if (!traffic.vehicles.has(veh.id)) return;
      const near = veh.onMovement !== null || (veh.routeIndex === 0 && traffic.currentLane(veh)!.length - veh.s < from);
      if (near) min = Math.min(min, veh.v);
    },
    get min() {
      return min;
    },
  };
}

describe('Фазы светофора: модель', () => {
  it('«Авто»: встречные подъезды — в одну фазу, остальные по одному', () => {
    const E = { x: 1, y: 0 };
    const W = { x: -1, y: 0 };
    const S = { x: 0, y: 1 };
    expect(autoGroups([E, S, W, { x: 0, y: -1 }])).toEqual([[0, 2], [1, 3]]);
    // Т-образный: прямая — вместе, ветка — одна.
    expect(autoGroups([E, W, S])).toEqual([[0, 1], [2]]);
  });

  it('фазы игрока: повороты, которых нет, — прочь; не попавшие ни в одну — своей фазой «Авто» в конце', () => {
    const approaches = [
      { corridor: 1, dir: { x: 1, y: 0 }, turns: ['1>2', '1>3'] },
      { corridor: 2, dir: { x: -1, y: 0 }, turns: ['2>1', '2>3'] },
      { corridor: 3, dir: { x: 0, y: -1 }, turns: ['3>1', '3>2'] },
    ];
    expect(resolvePhases(undefined, approaches, [12])).toEqual([
      { go: ['1>2', '1>3', '2>1', '2>3'], green: 12 },
      { go: ['3>1', '3>2'], green: 8 },
    ]);
    // 9>1 — полотна 9 больше нет; 3>2 никуда не попал.
    const res = resolvePhases([{ go: ['1>2', '2>1', '9>1'], green: 10 }, { go: [], green: 4 }, { go: ['1>3', '2>3', '3>1'], green: 6 }], approaches);
    expect(res).toEqual([
      { go: ['1>2', '2>1'], green: 10 },
      { go: [], green: 4 },
      { go: ['1>3', '2>3', '3>1'], green: 6 },
      { go: ['3>2'], green: 8, extra: true },
    ]);
  });

  it('правка: поворот в фазе, добавить, убрать, переставить, длительность, стрелки налево', () => {
    let spec = [
      { go: ['a', 'b'], green: 8 },
      { go: ['c'], green: 8 },
    ];
    spec = toggleTurn(spec, 0, 'b');
    expect(spec[0].go).toEqual(['a']);
    spec = toggleTurn(spec, 1, 'b');
    expect(spec[1].go).toEqual(['c', 'b']);
    spec = addPhase(spec, 6);
    expect(spec).toHaveLength(3);
    spec = movePhase(spec, 2, -1);
    expect(spec[1]).toEqual({ go: [], green: 6 });
    expect(movePhase(spec, 0, -1)).toBe(spec);
    spec = removePhase(spec, 1);
    expect(spec.map((p) => p.go)).toEqual([['a'], ['c', 'b']]);
    expect(removePhase([{ go: [], green: 8 }], 0)).toHaveLength(1);
    expect(stepGreen(spec, 0, 100)[0].green).toBe(40);
    expect(stepGreen(spec, 0, -100)[0].green).toBe(4);
    // Перед фазой, где налево уступают встречным, — своя фаза только для левых; второй раз не добавляется.
    const arrows = withLeftArrows(spec, [['a'], []]);
    expect(arrows.map((p) => p.go)).toEqual([['a'], ['a'], ['c', 'b']]);
    // В самой фазе со стрелкой налево никому не уступают — у неё левых «на общий зелёный» нет.
    expect(withLeftArrows(arrows, [[], ['a'], []])).toEqual(arrows);
    // Стрелку дополнили правым поворотом (правка на карте) — она всё равно стрелка: вторую не добавить.
    const withRight = [{ go: ['a', 'r'], green: 6 }, { go: ['a', 'c'], green: 8 }];
    expect(withLeftArrows(withRight, [[], ['a']])).toEqual(withRight);
    // А если там, перед ней, налево тоже уступают — это не стрелка: добавить.
    const twice = [{ go: ['a', 'x'], green: 8 }, { go: ['a', 'c'], green: 8 }];
    expect(withLeftArrows(twice, [['a'], ['a']]).map((p) => p.go)).toEqual([['a'], ['a', 'x'], ['a'], ['a', 'c']]);
  });

  it('кто кому уступает: налево — встречному прямо и направо; поперечные потоки в одной фазе — конфликт', () => {
    const { move } = crossroads();
    const wLeft = move('w', 'n');
    const eStraight = move('e', 'w');
    const eRight = move('e', 'n');
    const wStraight = move('w', 'e');
    const nStraight = move('n', 's');
    expect(turnKind(wLeft.dirIn, wLeft.dirOut)).toBe('left');
    expect(turnKind(eRight.dirIn, eRight.dirOut)).toBe('right');
    const rel = phaseRelations([wLeft, eStraight, eRight, wStraight]);
    expect([...(rel.yields.get(wLeft.key) ?? [])].sort()).toEqual([eRight.key, eStraight.key].sort());
    expect(rel.yields.get(eStraight.key)).toBeUndefined();
    expect(rel.yields.get(wStraight.key)).toBeUndefined();
    expect(rel.clashes).toEqual([]);
    const bad = phaseRelations([wStraight, nStraight]);
    expect(bad.clashes).toEqual([[wStraight.key, nStraight.key]]);
  });

  it('секция со стрелкой — только у поворота со своей фазой; горит, когда поворот зелёный без основной', () => {
    const { L, move } = crossroads((net, j, a) => {
      net.node(j).phases = [
        { go: [`${a.w}>${a.n}`, `${a.e}>${a.s}`], green: 6 },
        { go: [`${a.w}>${a.e}`, `${a.w}>${a.n}`, `${a.w}>${a.s}`, `${a.e}>${a.w}`, `${a.e}>${a.s}`, `${a.e}>${a.n}`], green: 10 },
        { go: [`${a.n}>${a.s}`, `${a.n}>${a.e}`, `${a.n}>${a.w}`, `${a.s}>${a.n}`, `${a.s}>${a.e}`, `${a.s}>${a.w}`], green: 10 },
      ];
    });
    const wLeft = move('w', 'n');
    const head = L.heads.find((h) => h.link === wLeft.inLink)!;
    expect(head.main).toEqual([false, true, false]);
    expect(head.arrows).toHaveLength(1);
    expect(head.arrows[0].kind).toBe('left');
    // Стрелка — в своей фазе; на общий зелёный налево уступают встречным — стрелка не горит.
    expect(head.arrows[0].on).toEqual([true, false, false]);
    // У севера и юга своей поворотной фазы нет — стрелок нет.
    const nHead = L.heads.find((h) => h.link === move('n', 's').inLink)!;
    expect(nHead.arrows).toEqual([]);
    // Без фаз игрока («Авто») стрелок нет ни у кого.
    const auto = crossroads();
    expect(auto.L.heads.every((h) => h.arrows.length === 0)).toBe(true);
    expect(signalHeads([], [])).toEqual([]);
  });
});

describe('Фаза на карте: проезды перекрёстка', () => {
  /** Крест 1+1 со светофором: манёвры, их повороты и ключ поворота с плеча на плечо. */
  function junction() {
    const x = crossroads();
    const moves = x.graph.junctionMoves.get(x.j)!;
    const turnOf = (m: GMove) => x.graph.turnOf(m);
    const t = (from: Arm, to: Arm) => `${x.arms[from]}>${x.arms[to]}`;
    return { ...x, moves, turnOf, t };
  }

  it('кто едет, кто уступает встречным, кому зелёный не дать (пересечёт зелёный) и кому можно', () => {
    const { moves, turnOf, t } = junction();
    // Общий зелёный запада и востока: прямо едут, налево — уступая встречным.
    const states = phaseTurnStates(moves, turnOf, [t('w', 'e'), t('e', 'w'), t('w', 'n'), t('e', 's')]);
    expect(states.get(t('w', 'e'))).toEqual({ look: 'go', with: [] });
    expect(states.get(t('w', 'n'))!.look).toBe('yield');
    expect(states.get(t('e', 's'))!.look).toBe('yield');
    // С севера прямо — поперёк: нельзя, пересечёт оба прямых.
    const ns = states.get(t('n', 's'))!;
    expect(ns.look).toBe('blocked');
    expect(ns.with).toEqual(expect.arrayContaining([t('w', 'e'), t('e', 'w')]));
    // Направо с запада — тот же подъезд, никому не мешает: можно.
    expect(states.get(t('w', 's'))).toEqual({ look: 'free', with: [] });
    // Все 12 поворотов перекрёстка — в ответе.
    expect(states.size).toBe(12);
    // Встречному прямо, пока налево никого, уступать некому: просто едет.
    expect(phaseTurnStates(moves, turnOf, [t('w', 'n'), t('w', 'e')]).get(t('w', 'n'))!.look).toBe('go');
    // Поперечные в одной фазе (старая настройка) — оба конфликт, друг с другом.
    const bad = phaseTurnStates(moves, turnOf, [t('w', 'e'), t('n', 's')]);
    expect(bad.get(t('w', 'e'))).toEqual({ look: 'clash', with: [t('n', 's')] });
    expect(bad.get(t('n', 's'))).toEqual({ look: 'clash', with: [t('w', 'e')] });
    // Пустая фаза: всем можно.
    expect([...phaseTurnStates(moves, turnOf, []).values()].every((s) => s.look === 'free')).toBe(true);
  });

  it('с кем пересечётся поворот, если дать ему зелёный; сам с собой — нет', () => {
    const { moves, turnOf, t } = junction();
    expect(turnClashes(moves, turnOf, [t('w', 'e')], t('n', 's'))).toEqual([t('w', 'e')]);
    expect(turnClashes(moves, turnOf, [t('w', 'e'), t('n', 's')], t('n', 's'))).toEqual([t('w', 'e')]);
    expect(turnClashes(moves, turnOf, [t('w', 'e')], t('e', 'w'))).toEqual([]);
  });

  it('клик по проезду: снять зелёный — всегда, дать — если не пересечёт зелёный фазы', () => {
    const { moves, turnOf, t } = junction();
    const spec = [
      { go: [t('w', 'e')], green: 8 },
      { go: [t('n', 's')], green: 8 },
    ];
    const states = phaseTurnStates(moves, turnOf, spec[0].go);
    const ok = phaseToggle(spec, 0, t('e', 'w'), states);
    expect(ok.clash).toEqual([]);
    expect(ok.spec[0].go).toEqual([t('w', 'e'), t('e', 'w')]);
    expect(ok.spec[1]).toBe(spec[1]);
    // Поперёк — отказ: фазы те же, с кем пересёкся бы — в ответе.
    const no = phaseToggle(spec, 0, t('n', 's'), states);
    expect(no.spec).toBe(spec);
    expect(no.clash).toEqual([t('w', 'e')]);
    // Зелёный был — снимается.
    expect(phaseToggle(spec, 0, t('w', 'e'), states).spec[0].go).toEqual([]);
    // Нет такой фазы — ничего.
    expect(phaseToggle(spec, 5, t('w', 'e'), states)).toEqual({ spec, clash: [] });
  });

  it('проезд под курсором — ближайший путь манёвра; мимо перекрёстка — ничего', () => {
    const { moves, turnOf, t } = junction();
    const paths = moves.map((m) => ({ turn: turnOf(m), points: m.points }));
    const mid = (from: Arm, to: Arm) => {
      const m = moves.find((x) => turnOf(x) === t(from, to))!;
      return LaneGraph.pointOnMove(m, m.length / 2).pos;
    };
    for (const [from, to] of [['w', 'n'], ['w', 'e'], ['w', 's'], ['n', 's'], ['s', 'w']] as [Arm, Arm][]) {
      expect(turnAt(paths, mid(from, to), 3)).toBe(t(from, to));
    }
    // Чуть в стороне от середины правого поворота — всё ещё он.
    const p = mid('e', 'n');
    expect(turnAt(paths, { x: p.x + 0.8, y: p.y - 0.8 }, 3)).toBe(t('e', 'n'));
    expect(turnAt(paths, { x: 200, y: 200 }, 3)).toBeNull();
    expect(turnAt([], { x: 0, y: 0 }, 3)).toBeNull();
  });

  it('правка идёт за своей фазой: переставили — номер следом, убрали её — правка закончена', () => {
    // Переставили правимую фазу 1 раньше — она теперь 0; переставили соседнюю на её место — правимая сдвинулась.
    expect(editedAfter(1, 1, -1, 3)).toBe(0);
    expect(editedAfter(1, 0, 1, 3)).toBe(0);
    expect(editedAfter(2, 0, 1, 3)).toBe(2);
    // За край — не переставить: номер тот же.
    expect(editedAfter(0, 0, -1, 3)).toBe(0);
    // Убрали её — null; раньше неё — номер на один меньше; позже — тот же; последнюю не убрать.
    expect(editedAfter(1, 1, null, 3)).toBeNull();
    expect(editedAfter(2, 0, null, 3)).toBe(1);
    expect(editedAfter(0, 2, null, 3)).toBe(0);
    expect(editedAfter(0, 0, null, 1)).toBe(0);
  });
});

describe('Светофор: кто тормозит на зелёный', { timeout: 30_000 }, () => {
  it('прямо на зелёный не тормозит, пока поперечная дорога стоит на красном', () => {
    const { traffic, go, hold, move, L } = crossroads();
    hold(move('w', 'e').key);
    // Поперечная дорога: по две машины с севера и юга подъезжают и встают на красный.
    const red = [go('n', 's', 60), go('s', 'n', 60), go('n', 'w', 90), go('s', 'e', 90)];
    run(traffic, 10, () => (L.timer = 1e9));
    expect(red.every((v) => v.v < 1 && !v.onMovement)).toBe(true);
    const veh = go('w', 'e', 260, 18);
    const watch = minSpeedThrough(traffic, veh);
    run(traffic, 25, () => watch.sample());
    // Улица 40 км/ч — 18,2 ед./с: так и проезжает, не притормаживая перед стоп-линией.
    expect(watch.min).toBeGreaterThan(17);
    expect(veh.routeIndex > 0 || !traffic.vehicles.has(veh.id)).toBe(true);
    // Стоящие на красном так и стоят.
    expect(red.every((v) => !v.onMovement && v.routeIndex === 0)).toBe(true);
  });

  it('налево на общий зелёный уступает встречному прямо: тот проезжает не тормозя', () => {
    const { traffic, go, hold, move } = crossroads();
    hold(move('w', 'n').key);
    // Поворачивающий уже стоит у стоп-линии, встречный подъезжает — ему до узла меньше 3 с.
    const left = go('w', 'n', 3);
    const oncoming = go('e', 'w', 50, 18);
    const watch = minSpeedThrough(traffic, oncoming);
    let leftEnteredFirst = false;
    run(traffic, 20, () => {
      watch.sample();
      if (left.onMovement && oncoming.routeIndex === 0 && !oncoming.onMovement) leftEnteredFirst = true;
    });
    expect(leftEnteredFirst).toBe(false);
    expect(watch.min).toBeGreaterThan(17);
    // После встречного поворачивает и он.
    expect(left.routeIndex > 0 || !traffic.vehicles.has(left.id)).toBe(true);
  });

  it('по стрелке налево не уступает: встречные на красном, поворот — не останавливаясь', () => {
    const { traffic, go, hold, move } = crossroads((net, j, a) => {
      net.node(j).phases = [
        { go: [`${a.w}>${a.n}`, `${a.e}>${a.s}`], green: 6 },
        { go: [`${a.w}>${a.e}`, `${a.w}>${a.n}`, `${a.w}>${a.s}`, `${a.e}>${a.w}`, `${a.e}>${a.s}`, `${a.e}>${a.n}`], green: 10 },
      ];
    });
    const m = move('w', 'n');
    hold(m.key);
    expect(traffic.graph.nodes.get(m.node!)!.lights!.phases[0].yields.size).toBe(0);
    const oncoming = go('e', 'w', 40, 10);
    const left = go('w', 'n', 200, 18);
    const watch = minSpeedThrough(traffic, left);
    run(traffic, 20, () => watch.sample());
    // Встречный на красном стоит, поворачивающий проезжает со скоростью поворота.
    expect(oncoming.routeIndex).toBe(0);
    expect(oncoming.onMovement).toBeNull();
    expect(left.routeIndex > 0 || !traffic.vehicles.has(left.id)).toBe(true);
    expect(watch.min).toBeGreaterThan(m.speed * 0.9);
  });

  it('на общий зелёный при плотном встречном потоке налево поворачивают в начале жёлтого', () => {
    // По таймеру: «умный» держал бы зелёный, пока на поперечной никого.
    const { traffic, go, move, L } = crossroads((net, j) => (net.node(j).adaptive = false));
    const m = move('w', 'n');
    const phase = L.phases.findIndex((p) => p.moves.has(m.key));
    L.phase = phase;
    L.timer = 10;
    L.clearing = false;
    const left = go('w', 'n', 3);
    // Встречные идут плотно, без окна, весь зелёный.
    for (const ahead of [20, 42, 64, 86]) go('e', 'w', ahead, 18);
    let entered: { clearing: boolean; phase: number } | null = null;
    let t0 = 0;
    run(traffic, 16, (t) => {
      if (t - t0 > 1.2 && !L.clearing && L.phase === phase && L.timer > 1.5) {
        go('e', 'w', 90, 18);
        t0 = t;
      }
      if (left.onMovement && !entered) entered = { clearing: L.clearing, phase: L.phase };
    });
    expect(entered).toEqual({ clearing: true, phase });
  });

  it('плотный поток во все стороны: и с фазами «Авто», и со стрелками налево — все доезжают, пробка не встаёт', () => {
    for (const arrows of [false, true]) {
      let lost = 0;
      const { traffic, graph, L, j } = crossroads((net, id, a) => {
        if (!arrows) return;
        const all = (x: number) => Object.values(a).filter((y) => y !== x).map((y) => `${x}>${y}`);
        net.node(id).phases = [
          { go: [`${a.w}>${a.n}`, `${a.e}>${a.s}`], green: 6 },
          { go: [...all(a.w), ...all(a.e)], green: 10 },
          { go: [`${a.n}>${a.e}`, `${a.s}>${a.w}`], green: 6 },
          { go: [...all(a.n), ...all(a.s)], green: 10 },
        ];
      });
      (traffic as unknown as { events: { onLost: () => void } }).events.onLost = () => lost++;
      expect(L.phases).toHaveLength(arrows ? 4 : 2);
      // Из каждого тупика — машина в среднем раз в 6 с: перекрёсток улиц 1+1 загружен, но не сверх меры.
      const demand = new LaneDemand(traffic, 6, seeded(11));
      let maxStopped = 0;
      let onRed = 0;
      const seen = new Map<number, string | null>();
      for (let t = 0; t < 240; t += DT) {
        demand.update(DT);
        traffic.step(DT);
        const Lnow = graph.nodes.get(j)!.lights!;
        for (const v of traffic.vehicles.values()) {
          maxStopped = Math.max(maxStopped, v.stoppedTime);
          const m = v.onMovement ? graph.moves.get(v.onMovement) : undefined;
          // Въехал в перекрёсток на красный (на жёлтый — можно: успевшие и поворачивающие налево в конце фазы).
          if (m?.node === j && seen.get(v.id) !== v.onMovement && !Lnow.clearing && !Lnow.phases[Lnow.phase].moves.has(m.key)) onRed++;
          seen.set(v.id, v.onMovement);
        }
      }
      expect(lost).toBe(0);
      expect(onRed).toBe(0);
      expect(traffic.arrivals).toBeGreaterThan(70);
      // Очереди рассасываются: дольше полутора минут (несколько циклов) никто не стоит.
      expect(maxStopped).toBeLessThan(90);
    }
  });

  it('загорелся жёлтый: получивший проезд заранее, но далёкий — останавливается', () => {
    const { traffic, go, hold, move, L } = crossroads((net, j) => (net.node(j).adaptive = false));
    const m = move('w', 'e');
    hold(m.key);
    // Проезд просят метров за 90 (за три безопасных дистанции) — и получают сразу: зелёный, уступать некому.
    const veh = go('w', 'e', 95, 18);
    run(traffic, 0.5);
    expect(veh.granted).toBe(m.key);
    // Жёлтый: следующая фаза — поперечная.
    L.timer = 0;
    run(traffic, 3, () => {
      if (!L.clearing) L.timer = 1e9;
    });
    expect(L.phases[L.phase].moves.has(m.key)).toBe(false);
    expect(veh.onMovement).toBeNull();
    expect(veh.routeIndex).toBe(0);
  });
});
