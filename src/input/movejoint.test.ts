import { describe, expect, it } from 'vitest';
import { minRadius } from '../core/bezier';
import { dist, Vec } from '../core/vec';
import { Game } from '../game/game';
import { MoveProject } from '../game/moveProject';
import { road } from '../game/testkit';
import { laneTipAt } from '../lanes/edit';
import { Corridor, oneWay, twoWay } from '../lanes/model';
import { branchSeam } from '../lanes/slide';
import { RoadTools } from './roadtools';

const HIGHWAY = { cls: 'highway' as const, lanes: twoWay(2, 2) };
/** Однополосная к въезду: едут к его началу (от тупика въезда — против хода постройки). */
const FEEDER = { cls: 'highway' as const, lanes: oneWay(1, -1) };

/**
 * Магистраль с запада на восток и въезд на неё с юга (полосой из поля к краю): у края дороги — стык и полоса
 * разгона. feeder — въезд продолжает однополосную дорогу: у его начала стык, а не тупик.
 */
function setup(feeder: boolean): { game: Game; o: Vec; start: number; east: number; ramp: () => Corridor } {
  const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 50_000_000, water: 'dry' });
  const net = () => game.roads.net;
  for (let y = 500; y < game.terrain.height - 500; y += 120) {
    for (let x = 300; x < game.terrain.width - 1100; x += 160) {
      if (!road(game, { free: { x, y } }, { free: { x: x + 900, y } }, HIGHWAY)) continue;
      const tip = laneTipAt(net(), { x: x + 180, y: y + 170 }, 14);
      const step = game.roadBuilder.laneStep(tip, [{ x: x + 330, y: y + 17.5 }], 'highway', 14);
      if (!step.plan.ok || step.step?.what !== 'Въезд') continue;
      game.roadBuilder.apply(step.plan);
      const head = net().nodesNear({ x: x + 180, y: y + 170 }, 2)[0].id;
      const id = net().node(head).corridors[0];
      if (feeder && !road(game, head, { free: { x: x + 120, y: y + 420 } }, FEEDER)) continue;
      const start = feeder ? net().nodesNear({ x: x + 120, y: y + 420 }, 2)[0].id : head;
      const east = net().nodesNear({ x: x + 900, y }, 2)[0].id;
      return { game, o: { x, y }, start, east, ramp: () => net().corridor(id) };
    }
  }
  throw new Error('Нет места');
}

const joints = (game: Game) => [...game.roads.net.nodes.values()].filter((n) => branchSeam(game.roads.net, n));

describe('«Двигать»: примыкание въезда вдоль дороги', () => {
  it('за конец въезда у дороги — тянется вдоль магистрали дальше по ходу: въезд длиннее и плавнее, доехать можно', () => {
    const { game, o, start, east, ramp } = setup(false);
    const [j] = joints(game);
    expect(j.pos.x).toBeCloseTo(o.x + 330, 0);
    const sharp = minRadius(ramp().curve);
    const tools = new RoadTools(() => game);
    // Под курсором конец въезда у края дороги — это примыкание, а не середина въезда.
    const end = { x: o.x + 331, y: o.y + 18 };
    expect(tools.slideAt(end, 3)?.node).toBe(j.id);
    expect(tools.moveDown(end, 3)).toBe(true);
    expect(tools.slide).toBe(j.id);
    const to = { x: o.x + 510, y: o.y + 25 };
    const plan = tools.movePlan(to);
    expect(plan?.ok, plan?.reason).toBe(true);
    expect(tools.hint).toBe('позже на 180 м');
    expect(tools.moveUp(to, true)).toBeNull();
    expect(game.roads.net.problems()).toEqual([]);
    const [moved] = joints(game);
    expect(moved.pos.x).toBeCloseTo(o.x + 510, 0);
    expect(moved.pos.y).toBeCloseTo(o.y, 3);
    expect(minRadius(ramp().curve)).toBeGreaterThan(sharp * 2);
    expect(game.roads.route(start, east)).not.toBeNull();
    // Обратно — тем же инструментом, ближе к началу магистрали.
    expect(tools.moveDown({ x: o.x + 511, y: o.y + 17.5 }, 3)).toBe(true);
    expect(tools.moveUp({ x: o.x + 280, y: o.y + 10 }, true)).toBeNull();
    expect(tools.hint).toBeNull();
    expect(joints(game)[0].pos.x).toBeCloseTo(o.x + 280, 0);
    expect(game.roads.route(start, east)).not.toBeNull();
  });

  it('въезд продолжает другую дорогу: стык у его начала остаётся, двигается только примыкание', () => {
    const { game, o, start, east, ramp } = setup(true);
    const head = game.roads.net.node(ramp().a);
    const dir = { ...head.dir };
    const tools = new RoadTools(() => game);
    expect(tools.moveDown({ x: o.x + 330, y: o.y + 17.5 }, 3)).toBe(true);
    expect(tools.moveUp({ x: o.x + 400, y: o.y + 20 }, true)).toBeNull();
    expect(game.roads.net.problems()).toEqual([]);
    expect(joints(game)[0].pos.x).toBeCloseTo(o.x + 400, 0);
    expect(game.roads.net.node(head.id).dir).toEqual(dir);
    expect(game.roads.route(start, east)).not.toBeNull();
  });

  it('в проекте перемещения: примыкание тянут дважды, дорога пока как была, «Построить» — разом', () => {
    const { game, o, start, east } = setup(false);
    const mp = new MoveProject(() => game);
    const tools = new RoadTools(() => game);
    expect(tools.moveDown({ x: o.x + 330, y: o.y + 17.5 }, 3)).toBe(true);
    expect(mp.add(tools.moveEdit({ x: o.x + 420, y: o.y + 20 })!)).toBeNull();
    tools.moveEnd();
    expect(joints(game)[0].pos.x).toBeCloseTo(o.x + 330, 0);
    // Следующую правку тянут от сети с проектом — примыкание там уже на новом месте.
    tools.base = mp.net();
    expect(tools.moveDown({ x: o.x + 420, y: o.y + 17.5 }, 3)).toBe(true);
    expect(mp.add(tools.moveEdit({ x: o.x + 470, y: o.y + 20 })!)).toBeNull();
    tools.moveEnd();
    tools.base = null;
    expect(mp.plan().ok, mp.plan().reason).toBe(true);
    expect(mp.build()).toBeNull();
    expect(joints(game)[0].pos.x).toBeCloseTo(o.x + 470, 0);
    expect(game.roads.route(start, east)).not.toBeNull();
  });

  it('пологий въезд из поля строится: длинная «ёлочка» у стыка — не «слишком близко», а въезд поперёк соседней дороги — по-прежнему нельзя', () => {
    const game = new Game({ seed: 11, size: 'small', towns: 2, industries: 'few', money: 50_000_000, water: 'dry' });
    let o: Vec | null = null;
    for (let y = 500; y < game.terrain.height - 500 && !o; y += 120) {
      for (let x = 300; x < game.terrain.width - 1100 && !o; x += 160) {
        if (road(game, { free: { x, y } }, { free: { x: x + 900, y } }, HIGHWAY)) o = { x, y };
      }
    }
    const at = o!;
    // Радиус дуги ≈ 660: кромки въезда и магистрали расходятся дольше 45 м.
    const tip = laneTipAt(game.roads.net, { x: at.x + 60, y: at.y + 75 }, 14);
    const step = game.roadBuilder.laneStep(tip, [{ x: at.x + 330, y: at.y + 17.5 }], 'highway', 14);
    expect(step.step?.what).toBe('Въезд');
    expect(step.plan.ok, step.plan.reason).toBe(true);
    // Улица вплотную вдоль магистрали без общего стыка — слишком близко, как и было.
    const along = game.roadBuilder.road({ kind: 'free', pos: { x: at.x + 500, y: at.y + 18 } }, { kind: 'free', pos: { x: at.x + 700, y: at.y + 18 } }, { cls: 'street', lanes: twoWay(1, 1) });
    expect(along.reason).toBe('Слишком близко к другой дороге');
  });

  it('с Alt узел примыкания тянут как обычный узел; метка конца въезда — у края дороги', () => {
    const { game, o, ramp } = setup(true);
    const [j] = joints(game);
    const tools = new RoadTools(() => game);
    expect(tools.moveDown(j.pos, 3, 3, true)).toBe(true);
    expect(tools.slide).toBeNull();
    expect(tools.dragNode).toBe(j.id);
    tools.moveEnd();
    expect(dist(tools.nodeMark(ramp(), j), { x: o.x + 330, y: o.y + 17.5 })).toBeLessThan(0.5);
    // Сама магистраль у примыкания — метка на её оси.
    const main = game.roads.net.corridor(j.corridors.find((id) => id !== ramp().id)!);
    expect(tools.nodeMark(main, j)).toEqual(j.pos);
  });
});
